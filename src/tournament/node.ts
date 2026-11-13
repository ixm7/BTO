/**
 * One participant in a serverless tournament.
 *
 * Every node keeps the full event log. One node at a time is the coordinator:
 * it is the only one that appends to the log, which gives all peers a single
 * agreed order of events. The coordinator is chosen by a rule every peer can
 * evaluate on its own (director first, then the most capable device, then the
 * lowest peer id), so when it disappears the next one takes over without any
 * vote. The coordinator also plays for robots and for players who have dropped.
 */
import { SEATS, type Card, type Seat } from '../engine/cards';
import { illegalReason, type AuctionState, type Call } from '../engine/bidding';
import { chooseCall, chooseCard } from '../engine/bot';
import { controllerOf, illegalPlayReason, type PlayState } from '../engine/play';
import type { Transport } from '../net/transport';
import {
  ALERT_MAX, buildConfig, claimWaitingOn, findSeat, originalSeatId, ownerOf, reduce, seatingOf, turnAt,
  type BoardResult, type LobbyPlayer, type Seating, type TEvent, type TState, type TableState, type TournamentConfig,
} from './state';

export interface Me {
  playerId: string;
  name: string;
  /** Higher = better host. See deviceScore(). */
  deviceScore: number;
  isDirector: boolean;
  pairCode?: string;
  /** Player description (convention card, style, etc.) shown on click. */
  note?: string;
  /** The skill level they gave in Settings, if any. */
  skill?: string;
}

/**
 * How the robots think. Without one they use the simple built-in player; the
 * app supplies a stronger one that may take a few seconds over a card.
 */
export interface RobotBrain {
  call(hand: readonly Card[], auction: AuctionState, seat: Seat): { call: Call; alert?: string };
  card(play: PlayState, seat: Seat, auction: AuctionState | null): Promise<Card>;
}

export interface NodeOptions {
  /** Delay before a robot acts, so humans can follow the play. */
  botDelayMs?: number;
  robot?: RobotBrain;
  /**
   * Index of the only table this node takes part in. When set, the node plays
   * robots and enforces the inactivity rule there and nowhere else: the other
   * tables are in its state so that boards can be scored against them, but
   * they are being played in rooms this node is not in. Left unset, the node
   * runs the whole field, which is what a single shared room does.
   */
  tableIndex?: number;
  /** How long a human may be disconnected before a robot plays for them. */
  absentGraceMs?: number;
  /**
   * How long a player may leave the table waiting — whether sitting there not
   * acting, or disconnected — before a robot takes their seat for good.
   * Set to 0 to switch the rule off, as the solo demo does: nobody is waiting
   * there, so a player who pauses to think should not lose their seat.
   */
  idleTimeoutMs?: number;
  /** A peer not heard from for this long is treated as gone. */
  peerTimeoutMs?: number;
  tickMs?: number;
  /** Optional persistence of the log, so a page refresh does not lose the tournament. */
  persist?: { load(): TEvent[] | null; save(events: TEvent[]): void };
  now?: () => number;
}

interface PeerInfo {
  peerId: string;
  playerId: string;
  name: string;
  deviceScore: number;
  isDirector: boolean;
  pairCode?: string;
  note?: string;
  skill?: string;
  joinedAt: number;
  seq: number;
  lastSeen: number;
}

type Msg =
  | { k: 'hello'; playerId: string; name: string; deviceScore: number; isDirector: boolean; pairCode?: string; note?: string; skill?: string; joinedAt: number; seq: number }
  | { k: 'intent'; ev: TEvent }
  | { k: 'ev'; seq: number; ev: TEvent }
  | { k: 'syncreq'; have: number }
  | { k: 'sync'; from: number; events: TEvent[] }
  | { k: 'bye' };

export interface StartOptions {
  id: string;
  name: string;
  boardsPerRound: number;
  rounds?: number;
  capacity?: number;
  /** Add robot pairs until there are at least this many tables. */
  minTables?: number;
  seed?: string;
  /** Director's inactivity limit in milliseconds; 0 switches the rule off. */
  idleTimeoutMs?: number;
}

export class TournamentNode {
  log: TEvent[] = [];
  state: TState | null = null;
  readonly joinedAt: number;
  private peerMap = new Map<string, PeerInfo>();
  private listeners: (() => void)[] = [];
  private wasCoordinator = false;
  private ready = true;
  private syncReplies = new Set<string>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private queued: { ev: TEvent; from: string }[] = [];
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private pending: TEvent | null = null;
  private absentSince = new Map<string, number>();
  /** Per table, which position we are waiting on and since when. */
  private waitingSince = new Map<number, { key: string; at: number }>();
  private closed = false;
  private readonly o: Required<Omit<NodeOptions, 'persist' | 'tableIndex' | 'robot'>> & Pick<NodeOptions, 'persist' | 'tableIndex' | 'robot'>;
  /** Last reason an action of ours was rejected locally (for the UI). */
  lastError: string | null = null;

  constructor(readonly transport: Transport, readonly me: Me, opts: NodeOptions = {}) {
    this.o = {
      botDelayMs: opts.botDelayMs ?? 700,
      robot: opts.robot,
      tableIndex: opts.tableIndex,
      absentGraceMs: opts.absentGraceMs ?? 20000,
      idleTimeoutMs: opts.idleTimeoutMs ?? 60000,
      peerTimeoutMs: opts.peerTimeoutMs ?? 12000,
      tickMs: opts.tickMs ?? 1000,
      now: opts.now ?? (() => Date.now()),
      persist: opts.persist,
    };
    this.joinedAt = this.o.now();
    const saved = this.o.persist?.load();
    if (saved) {
      try { for (const ev of saved) this.applyLocal(ev, false); } catch { this.log = []; this.state = null; }
    }
    transport.onMessage((m, from) => this.onMessage(m as Msg, from));
    transport.onPeerJoin((id) => this.sendHello(id));
    transport.onPeerLeave((id) => {
      if (this.peerMap.delete(id)) this.membershipChanged();
    });
    this.sendHello();
    this.tickTimer = setInterval(() => this.tick(), this.o.tickMs);
    this.membershipChanged();
  }

  /* ------------------------------------------------------------ public API */

  onChange(cb: () => void): void { this.listeners.push(cb); }

  get isCoordinator(): boolean { return this.coordinatorId() === this.transport.selfId; }

  /** Name of the player whose device is currently hosting. */
  get coordinatorName(): string {
    const id = this.coordinatorId();
    return id === this.transport.selfId ? this.me.name : this.peerMap.get(id)?.name ?? '?';
  }

  /** Everyone currently connected (including me), one entry per player. */
  lobby(): LobbyPlayer[] {
    const out = new Map<string, LobbyPlayer>();
    const add = (p: LobbyPlayer): void => {
      const cur = out.get(p.id);
      if (!cur || p.joinedAt < cur.joinedAt) out.set(p.id, p);
    };
    add({ id: this.me.playerId, name: this.me.name, pairCode: this.me.pairCode, joinedAt: this.joinedAt });
    for (const p of this.peerMap.values()) add({ id: p.playerId, name: p.name, pairCode: p.pairCode, joinedAt: p.joinedAt });
    return [...out.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
  }

  isPresent(playerId: string): boolean {
    if (playerId === this.me.playerId) return true;
    for (const p of this.peerMap.values()) if (p.playerId === playerId) return true;
    return false;
  }

  /** Map of playerId → player note/description for all connected players. */
  playerNotes(): Map<string, string> {
    const notes = new Map<string, string>();
    for (const [id, x] of this.playerInfo()) if (x.note) notes.set(id, x.note);
    return notes;
  }

  /** What each connected player says about themselves: level and description. */
  playerInfo(): Map<string, { note?: string; skill?: string }> {
    const out = new Map<string, { note?: string; skill?: string }>();
    const add = (id: string, note?: string, skill?: string): void => {
      if (note || skill) out.set(id, { ...(note ? { note } : {}), ...(skill ? { skill } : {}) });
    };
    add(this.me.playerId, this.me.note, this.me.skill);
    for (const p of this.peerMap.values()) add(p.playerId, p.note, p.skill);
    return out;
  }

  mySeat(): { table: TableState; seat: Seat } | null {
    return this.state ? findSeat(this.state, this.me.playerId) : null;
  }

  /**
   * The tables this node is responsible for driving. With a table of its own
   * it drives only that one; the rest are in its state to be scored against,
   * but they are played in rooms it is not in, and acting on them would put
   * cards into a log nobody else at that table will ever see.
   */
  private myTables(): TableState[] {
    if (!this.state) return [];
    const only = this.o.tableIndex;
    if (only === undefined) return [...this.state.tables];
    const table = this.state.tables[only];
    return table ? [table] : [];
  }

  /**
   * Begin from a configuration worked out ahead of time rather than from who
   * happens to be in the room. Each table's host does this with the same
   * derived plan, which is how tables that never meet still agree on the
   * seating, the deals and the movement.
   */
  startWithConfig(config: TournamentConfig): void {
    if (!this.isCoordinator) throw new Error('Only the current host can start the tournament');
    if (this.state) throw new Error('Tournament already started');
    this.append({ t: 'start', config });
  }

  /** Start the tournament with whoever is present. Only the coordinator may do this. */
  start(opts: StartOptions): void {
    if (!this.isCoordinator) throw new Error('Only the current host can start the tournament');
    if (this.state) throw new Error('Tournament already started');
    const seedBytes = new Uint32Array(4);
    globalThis.crypto.getRandomValues(seedBytes);
    const config = buildConfig({
      id: opts.id, name: opts.name, seed: opts.seed ?? Array.from(seedBytes, (n) => n.toString(36)).join(''),
      players: this.lobby(), boardsPerRound: opts.boardsPerRound, rounds: opts.rounds, capacity: opts.capacity, minTables: opts.minTables,
      idleTimeoutMs: opts.idleTimeoutMs,
    });
    this.append({ t: 'start', config });
  }

  /**
   * Stand down and let a robot play on. The same thing the clock does to a
   * player who stops responding, asked for rather than imposed.
   */
  withdraw(): void {
    if (!this.state) return;
    this.submit({ t: 'retire', playerId: this.me.playerId });
  }

  /**
   * Ask for a seat from the next board: your own one back, or one a robot is
   * keeping warm. `forPlayerId` is the id the entry list gave that seat.
   */
  takeSeat(forPlayerId: string): void {
    if (!this.state) return;
    const mine = forPlayerId === this.me.playerId;
    this.submit({
      t: 'seat', forPlayerId,
      player: mine ? null : { id: this.me.playerId, name: this.me.name },
    });
  }

  /**
   * Where this table's four players stand: who has stood down, and who is
   * playing their cards. Carried to the next round's room, which has a log of
   * its own and would otherwise seat everyone as the entry list first did.
   */
  seating(): Seating {
    return this.state ? seatingOf(this.state, this.myTables()) : {};
  }

  /** Bring a round's fresh room up to date with who is sitting where. */
  importSeating(seating: Seating): void {
    const state = this.state;
    if (!state || !this.isCoordinator) return;
    /* Only what this room does not already have, so that hosts telling each
       other the same thing does not grow the log for nothing. */
    const news: Seating = {};
    for (const [id, item] of Object.entries(seating)) {
      if (!ownerOf(state.config, id)) continue;
      const retired = state.retired.includes(id);
      const sub = state.substitutes[id]?.id ?? null;
      if (item.retired === retired && (item.sub?.id ?? null) === sub) continue;
      news[id] = item;
    }
    if (Object.keys(news).length === 0) return;
    this.append({ t: 'seating', seating: news });
  }

  /**
   * Say where I stand, for a room that has not heard. A round is played in a
   * fresh room, and the one person certain to be in the new room with this
   * knowledge is the player it is about: somebody standing in for an absent
   * player, or somebody who has stood down and whose robot should play on.
   */
  declareStanding(seating: Seating): void {
    if (!this.state || Object.keys(seating).length === 0) return;
    this.submit({ t: 'seating', seating });
  }

  /** Seats a robot is filling, which somebody could take over. */
  robotSeats(): { forPlayerId: string; table: number; seat: Seat; name: string }[] {
    if (!this.state) return [];
    const out: { forPlayerId: string; table: number; seat: Seat; name: string }[] = [];
    /* Only this node's own table: a seat at a table whose room we are not in
       would be claimed in a log the people playing there never see. */
    for (const t of this.myTables()) {
      if (!t.active) continue;
      for (const s of SEATS) {
        const sitting = t.seats[s];
        if (!sitting.bot) continue;
        const owner = originalSeatId(this.state.config, t, s);
        if (owner) out.push({ forPlayerId: owner, table: t.index, seat: s, name: sitting.name });
      }
    }
    return out;
  }

  /** `alert` explains a non-standard call to the opponents; blank means none. */
  call(call: Call, alert?: string): void {
    const at = this.mySeat();
    if (!at || at.table.boardNo === null) return;
    const note = alert?.trim();
    this.submit({ t: 'call', table: at.table.index, board: at.table.boardNo, seat: at.seat, call, ...(note ? { alert: note } : {}) });
  }

  /** Play a card from `seat`: my own seat, or dummy's when I am declarer. */
  play(seat: Seat, card: Card): void {
    const at = this.mySeat();
    if (!at || at.table.boardNo === null) return;
    this.submit({ t: 'play', table: at.table.index, board: at.table.boardNo, seat, card });
  }

  /**
   * Claim (as declarer) or concede (as a defender) the tricks still to come:
   * `toDeclarer` is how many of them declarer's side is to take.
   */
  claim(toDeclarer: number): void {
    const at = this.mySeat();
    if (!at || at.table.boardNo === null) return;
    this.submit({ t: 'claim', table: at.table.index, board: at.table.boardNo, seat: at.seat, toDeclarer });
  }

  answerClaim(accept: boolean): void {
    const at = this.mySeat();
    if (!at || at.table.boardNo === null) return;
    this.submit({ t: 'claimAnswer', table: at.table.index, board: at.table.boardNo, seat: at.seat, accept });
  }

  withdrawClaim(): void {
    const at = this.mySeat();
    if (!at || at.table.boardNo === null) return;
    this.submit({ t: 'claimOff', table: at.table.index, board: at.table.boardNo, seat: at.seat, why: 'withdrawn' });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.autoTimer) clearTimeout(this.autoTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.transport.send({ k: 'bye' } satisfies Msg);
    this.transport.leave();
  }

  /* ------------------------------------------------------------- election */

  private coordinatorId(): string {
    let best = { id: this.transport.selfId, dir: this.me.isDirector, score: this.me.deviceScore };
    for (const p of this.peerMap.values()) {
      const better =
        p.isDirector !== best.dir ? p.isDirector
        : p.deviceScore !== best.score ? p.deviceScore > best.score
        : p.peerId < best.id;
      if (better) best = { id: p.peerId, dir: p.isDirector, score: p.deviceScore };
    }
    return best.id;
  }

  private membershipChanged(): void {
    const now = this.isCoordinator;
    if (now && !this.wasCoordinator) this.becomeCoordinator();
    if (!now) { this.ready = true; this.queued = []; }
    this.wasCoordinator = now;
    this.emit();
    if (now) this.scheduleAuto();
  }

  /** Before accepting any action, a new coordinator catches up with whoever has the longest log. */
  private becomeCoordinator(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.peerMap.size === 0) { this.ready = true; return; }
    this.ready = false;
    this.syncReplies.clear();
    this.transport.send({ k: 'syncreq', have: this.log.length } satisfies Msg);
    this.syncTimer = setTimeout(() => this.becomeReady(), 700);
  }

  private becomeReady(): void {
    if (this.ready) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.ready = true;
    const q = this.queued;
    this.queued = [];
    for (const { ev, from } of q) this.handleIntent(ev, from);
    this.scheduleAuto();
  }

  /* ------------------------------------------------------------- messages */

  private sendHello(to?: string): void {
    this.transport.send({
      k: 'hello', playerId: this.me.playerId, name: this.me.name, deviceScore: this.me.deviceScore,
      isDirector: this.me.isDirector, pairCode: this.me.pairCode, note: this.me.note, skill: this.me.skill,
      joinedAt: this.joinedAt, seq: this.log.length,
    } satisfies Msg, to);
  }

  private onMessage(m: Msg, from: string): void {
    if (this.closed || !m || typeof m !== 'object') return;
    const known = this.peerMap.get(from);
    if (known) known.lastSeen = this.o.now();
    switch (m.k) {
      case 'hello': {
        const isNew = !known;
        const changed = isNew || known.isDirector !== m.isDirector || known.deviceScore !== m.deviceScore
          || known.name !== m.name || known.pairCode !== m.pairCode || known.playerId !== m.playerId;
        this.peerMap.set(from, {
          peerId: from, playerId: m.playerId, name: m.name, deviceScore: m.deviceScore, isDirector: m.isDirector,
          pairCode: m.pairCode, note: typeof m.note === 'string' ? m.note.slice(0, 140) : undefined,
          skill: typeof m.skill === 'string' ? m.skill.slice(0, 20) : undefined, joinedAt: m.joinedAt, seq: m.seq, lastSeen: this.o.now(),
        });
        if (isNew) this.sendHello(from);
        if (m.seq > this.log.length) this.transport.send({ k: 'syncreq', have: this.log.length } satisfies Msg, from);
        if (changed) this.membershipChanged();
        break;
      }
      case 'bye':
        if (this.peerMap.delete(from)) this.membershipChanged();
        break;
      case 'syncreq':
        this.transport.send({ k: 'sync', from: m.have, events: this.log.slice(m.have) } satisfies Msg, from);
        break;
      case 'sync': {
        let changed = false;
        m.events.forEach((ev, i) => {
          if (m.from + i === this.log.length) {
            try { this.applyLocal(ev, true); changed = true; } catch { /* diverged; ignore the rest */ }
          }
        });
        if (!this.ready) {
          this.syncReplies.add(from);
          if ([...this.peerMap.keys()].every((id) => this.syncReplies.has(id))) this.becomeReady();
        }
        if (changed) { this.emit(); this.scheduleAuto(); }
        break;
      }
      case 'ev':
        if (m.seq === this.log.length) {
          try { this.applyLocal(m.ev, true); } catch { return; }
          this.emit();
        } else if (m.seq > this.log.length) {
          this.transport.send({ k: 'syncreq', have: this.log.length } satisfies Msg, from);
        }
        break;
      case 'intent':
        if (this.isCoordinator) {
          if (this.ready) this.handleIntent(m.ev, from);
          else this.queued.push({ ev: m.ev, from });
        }
        break;
    }
  }

  /* ----------------------------------------------------------- log & acts */

  private applyLocal(ev: TEvent, save: boolean): void {
    const before = this.state?.results.length ?? 0;
    this.state = reduce(this.state, ev);
    this.log.push(ev);
    if (this.pending && sameEvent(this.pending, ev)) this.pending = null;
    if (save) this.o.persist?.save(this.log);
    /* A board our own table has just finished is the rest of the field's only
       sight of us, so hand it straight to whoever is carrying results. */
    const mine = this.o.tableIndex;
    if (mine !== undefined && this.state.results.length > before) {
      for (const r of this.state.results.slice(before)) {
        if (r.table === mine) for (const cb of this.resultCbs) cb(r);
      }
    }
  }

  private resultCbs: ((r: BoardResult) => void)[] = [];

  /** Called with each board this node's own table finishes. */
  onResult(cb: (r: BoardResult) => void): void { this.resultCbs.push(cb); }

  /**
   * Record a board another table played. Only the table's coordinator is in
   * the room where these arrive; putting it in the table's log is what lets
   * the other three players at the table see it too.
   */
  importResult(result: BoardResult): void {
    if (!this.state || !this.isCoordinator) return;
    /* Deduplication is by board, not by table: an earlier round played at this
       same table was played by different people and still has to be taken in.
       Anything this table itself produced is already recorded, so it is caught
       here rather than by refusing our own table's index. */
    if (this.state.results.some((x) => x.table === result.table && x.board === result.board)) return;
    this.append({ t: 'result', result });
  }

  /** Every board recorded so far, for handing a newly arrived host the backlog. */
  knownResults(): BoardResult[] { return this.state ? [...this.state.results] : []; }

  /** Coordinator only: validate, append and broadcast. Returns false if the event was illegal. */
  private append(ev: TEvent): boolean {
    try { this.applyLocal(ev, true); } catch (e) { this.lastError = (e as Error).message; return false; }
    this.transport.send({ k: 'ev', seq: this.log.length - 1, ev } satisfies Msg);
    this.emit();
    this.scheduleAuto();
    return true;
  }

  private playerOf(peerId: string): string | null {
    if (peerId === this.transport.selfId) return this.me.playerId;
    return this.peerMap.get(peerId)?.playerId ?? null;
  }

  private handleIntent(ev: TEvent, from: string): void {
    /* Results arrive from the tables that played them, over the results room,
       never as an intent from somebody sitting at this table. */
    if (ev.t === 'start' || ev.t === 'result' || !this.state) return;
    if (ev.t === 'retire') {
      /* Standing down is the one retirement a peer may ask for, and only its
         own. The clock's verdict on somebody else is the host's alone;
         accepting that from a peer would let anyone evict anyone. */
      if (this.playerOf(from) === ev.playerId) this.append(ev);
      return;
    }

    /* A request to sit down comes from the player wanting the seat, so unlike
       the rest it is expected from a peer — but only on their own behalf. */
    if (ev.t === 'seating') {
      /* A peer may only speak about itself: that it has stood down, or that
         it is standing in for somebody who is not at the table. Taking over
         an absent player is no more than the clock would do for them in a
         minute, so this only saves the wait; a player who is here keeps
         their seat whatever anybody claims. */
      const asker = this.playerOf(from);
      if (!asker) return;
      const mine: Seating = {};
      for (const [id, news] of Object.entries(ev.seating)) {
        /* Their seat is open if they have stood down, or if they are not
           here — which the clock would see to in a minute anyway. */
        const open = this.state.retired.includes(id) || !this.isPresent(id);
        if (news.sub?.id === asker && open) { mine[id] = news; continue; }
        /* Standing down is a word about yourself only, and it never turns
           out somebody who is already sitting in for you. */
        if (id === asker && news.retired) {
          mine[id] = { ...news, retired: true, sub: this.state.substitutes[id] ?? null };
        }
      }
      this.importSeating(mine);
      return;
    }

    if (ev.t === 'seat') {
      const asker = this.playerOf(from);
      if (!asker) return;
      const forThemselves = ev.player === null ? asker === ev.forPlayerId : asker === ev.player.id;
      if (!forThemselves) return;
      this.append(ev);
      return;
    }

    /* This room is one table's room; a card for any other table is not ours to
       accept, whoever sent it. */
    if (this.o.tableIndex !== undefined && ev.table !== this.o.tableIndex) return;
    const table = this.state.tables[ev.table];
    const playerId = this.playerOf(from);
    if (!table || !playerId) return;
    const controller = ev.t === 'play' && table.play ? controllerOf(table.play, ev.seat) : ev.seat;
    if (table.seats[controller]?.id !== playerId) return; // not that player's seat
    /* Letting a claim lapse is the host's call alone. */
    if (ev.t === 'claimOff' && ev.why !== 'withdrawn') return;
    this.append(ev);
  }

  private submit(ev: TEvent): void {
    this.lastError = null;
    if (!this.state) return;
    try { reduce(this.state, ev); } catch (e) { this.lastError = (e as Error).message; this.emit(); return; }
    if (this.isCoordinator && this.ready) {
      this.handleIntent(ev, this.transport.selfId);
    } else {
      this.pending = ev;
      this.transport.send({ k: 'intent', ev } satisfies Msg, this.coordinatorId());
    }
  }

  /* --------------------------------------------------------------- timers */

  private tick(): void {
    if (this.closed) return;
    this.ticks++;
    const now = this.o.now();
    let dropped = false;
    for (const [id, p] of this.peerMap) {
      if (now - p.lastSeen > this.o.peerTimeoutMs) { this.peerMap.delete(id); dropped = true; }
    }
    if (dropped) this.membershipChanged();
    if (this.ticks % 3 === 0) this.sendHello();
    if (this.pending && this.state) {
      // Our action has not shown up in the log yet (e.g. the host changed): send it again if still legal.
      try { reduce(this.state, this.pending); this.transport.send({ k: 'intent', ev: this.pending } satisfies Msg, this.coordinatorId()); }
      catch { this.pending = null; }
    }
    this.scheduleAuto();
  }

  private scheduleAuto(): void {
    if (this.closed || this.autoTimer || !this.isCoordinator || !this.ready) return;
    if (!this.state || this.state.finished) return;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      this.runAuto();
    }, this.o.botDelayMs);
  }

  /** Coordinator only: act for robots, and for humans who have been gone longer than the grace period. */
  private runAuto(): void {
    if (this.closed || !this.isCoordinator || !this.ready || !this.state || this.state.finished) return;
    const now = this.o.now();
    let robotsWaiting = false;
    for (const table of this.myTables()) {
      if (table.claim && table.boardNo !== null) {
        if (this.lapseClaim(table, now)) { this.scheduleAuto(); return; }
        robotsWaiting = true; // keep the clock running until it is answered
        continue;
      }
      const turn = turnAt(table);
      if (!turn || table.boardNo === null) continue;
      const player = table.seats[turn.controller];
      let auto = !!player.bot;
      if (!auto) {
        if (this.isPresent(player.id)) {
          this.absentSince.delete(player.id);
        } else {
          const since = this.absentSince.get(player.id) ?? now;
          this.absentSince.set(player.id, since);
          auto = now - since >= this.o.absentGraceMs;
        }
        /* How long this seat has kept the table waiting. The key changes with
           every action at the table, so the clock restarts each turn. The
           director's setting wins, so every peer applies the same limit. */
        const limit = this.state.config.idleTimeoutMs ?? this.o.idleTimeoutMs;
        if (limit > 0) {
          const key = `${table.boardNo}:${turn.phase}:${turn.phase === 'auction' ? table.auction?.calls.length : table.play?.cardsPlayed}:${turn.seat}`;
          const prev = this.waitingSince.get(table.index);
          if (!prev || prev.key !== key) {
            this.waitingSince.set(table.index, { key, at: now });
          } else if (now - prev.at >= limit) {
            /* Retiring reseats this table and may close it, or end the whole
               tournament. The tables we are looping over are now stale, so
               start again from the new state rather than acting on them. */
            this.waitingSince.delete(table.index);
            this.append({ t: 'retire', playerId: player.id });
            this.scheduleAuto();
            return;
          }
        }
      }
      if (!auto) continue;
      robotsWaiting = true;
      const brain = this.o.robot;
      if (turn.phase === 'auction' && table.auction && table.deal) {
        let call = chooseCall(table.deal[turn.seat], table.auction, turn.seat);
        let alert: string | undefined;
        if (brain) {
          try {
            const chosen = brain.call(table.deal[turn.seat], table.auction, turn.seat);
            if (illegalReason(table.auction, turn.seat, chosen.call) === null) { call = chosen.call; alert = chosen.alert?.slice(0, ALERT_MAX); }
          } catch { /* the simple robot's call stands */ }
        }
        this.append({ t: 'call', table: table.index, board: table.boardNo, seat: turn.seat, call, ...(alert ? { alert } : {}) });
        continue;
      }
      const play = table.play!;
      if (!brain) {
        this.append({ t: 'play', table: table.index, board: table.boardNo, seat: turn.seat, card: chooseCard(play, turn.seat) });
        continue;
      }
      /* The strong robot thinks off to one side and answers when it is ready.
         Its answer is used only if the table is still where it was asked. */
      const key = `${table.index}:${table.boardNo}:${play.cardsPlayed}`;
      if (this.thinking.has(key)) continue;
      this.thinking.add(key);
      const at = { table: table.index, board: table.boardNo, seat: turn.seat, cards: play.cardsPlayed };
      const settle = (card: Card | null): void => {
        this.thinking.delete(key);
        if (this.closed || !this.state) return;
        const t = this.state.tables[at.table];
        const now = t ? turnAt(t) : null;
        if (!t || t.boardNo !== at.board || !t.play || t.play.cardsPlayed !== at.cards || !now || now.seat !== at.seat || t.claim) { this.scheduleAuto(); return; }
        const pick = card !== null && illegalPlayReason(t.play, at.seat, card) === null ? card : chooseCard(t.play, at.seat);
        this.append({ t: 'play', table: at.table, board: at.board, seat: at.seat, card: pick });
        this.scheduleAuto();
      };
      brain.card(play, turn.seat, table.auction ?? null).then(settle, () => settle(null));
    }
    if (robotsWaiting) this.scheduleAuto();
  }

  /**
   * A claim nobody answers must not hold the table for ever. It lapses after
   * the director's time limit, or sooner if a player who has to answer it has
   * dropped off. Nobody loses a seat over it: play simply resumes. Returns
   * true if it lapsed.
   */
  private lapseClaim(table: TableState, now: number): boolean {
    const c = table.claim;
    if (!c || table.boardNo === null || !table.play || !this.state) return false;
    /* Its own key, so the turn clock starts afresh once play resumes. */
    const key = `${table.boardNo}:claim:${table.play.cardsPlayed}:${c.seat}:${c.toDeclarer}`;
    const prev = this.waitingSince.get(table.index);
    if (!prev || prev.key !== key) { this.waitingSince.set(table.index, { key, at: now }); return false; }
    const limit = this.state.config.idleTimeoutMs ?? this.o.idleTimeoutMs;
    let gone = false;
    for (const s of [c.seat, ...claimWaitingOn(table)]) {
      const id = table.seats[s].id;
      if (this.isPresent(id)) { this.absentSince.delete(id); continue; }
      const since = this.absentSince.get(id) ?? now;
      this.absentSince.set(id, since);
      if (now - since >= this.o.absentGraceMs) gone = true;
    }
    if (!gone && !(limit > 0 && now - prev.at >= limit)) return false;
    this.waitingSince.delete(table.index);
    return this.append({ t: 'claimOff', table: table.index, board: table.boardNo, seat: c.seat, why: 'lapsed' });
  }

  /** Cards a robot is in the middle of choosing, so it is asked only once. */
  private thinking = new Set<string>();

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

function sameEvent(a: TEvent, b: TEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * How suitable this device is to host: desktops beat tablets beat phones,
 * with small bonuses for more CPU cores and a wired/fast connection.
 */
export function deviceScore(nav: { userAgent?: string; hardwareConcurrency?: number; maxTouchPoints?: number; connection?: { effectiveType?: string; saveData?: boolean } } = globalThis.navigator ?? {}): number {
  const ua = nav.userAgent ?? '';
  const phone = /iPhone|Android.+Mobile|Mobile/i.test(ua);
  const tablet = !phone && (/iPad|Android|Tablet/i.test(ua) || (/Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1));
  let score = phone ? 10 : tablet ? 40 : 70;
  score += Math.min(nav.hardwareConcurrency ?? 2, 16);
  const eff = nav.connection?.effectiveType;
  if (eff === '4g' || eff === undefined) score += 5;
  if (nav.connection?.saveData) score -= 10;
  return score;
}
