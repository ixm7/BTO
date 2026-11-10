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
import type { Card, Seat } from '../engine/cards';
import type { Call } from '../engine/bidding';
import { chooseCall, chooseCard } from '../engine/bot';
import { controllerOf } from '../engine/play';
import type { Transport } from '../net/transport';
import {
  buildConfig, findSeat, reduce, turnAt,
  type LobbyPlayer, type TEvent, type TState, type TableState,
} from './state';

export interface Me {
  playerId: string;
  name: string;
  /** Higher = better host. See deviceScore(). */
  deviceScore: number;
  isDirector: boolean;
  pairCode?: string;
  /** Player description (skill level, convention card, etc.) shown on click. */
  note?: string;
}

export interface NodeOptions {
  /** Delay before a robot acts, so humans can follow the play. */
  botDelayMs?: number;
  /** How long a human may be disconnected before a robot plays for them. */
  absentGraceMs?: number;
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
  joinedAt: number;
  seq: number;
  lastSeen: number;
}

type Msg =
  | { k: 'hello'; playerId: string; name: string; deviceScore: number; isDirector: boolean; pairCode?: string; note?: string; joinedAt: number; seq: number }
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
  private closed = false;
  private readonly o: Required<Omit<NodeOptions, 'persist'>> & Pick<NodeOptions, 'persist'>;
  /** Last reason an action of ours was rejected locally (for the UI). */
  lastError: string | null = null;

  constructor(readonly transport: Transport, readonly me: Me, opts: NodeOptions = {}) {
    this.o = {
      botDelayMs: opts.botDelayMs ?? 700,
      absentGraceMs: opts.absentGraceMs ?? 20000,
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
    if (this.me.note) notes.set(this.me.playerId, this.me.note);
    for (const p of this.peerMap.values()) {
      if (p.note) notes.set(p.playerId, p.note);
    }
    return notes;
  }

  mySeat(): { table: TableState; seat: Seat } | null {
    return this.state ? findSeat(this.state, this.me.playerId) : null;
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
    });
    this.append({ t: 'start', config });
  }

  call(call: Call): void {
    const at = this.mySeat();
    if (!at || at.table.boardNo === null) return;
    this.submit({ t: 'call', table: at.table.index, board: at.table.boardNo, seat: at.seat, call });
  }

  /** Play a card from `seat`: my own seat, or dummy's when I am declarer. */
  play(seat: Seat, card: Card): void {
    const at = this.mySeat();
    if (!at || at.table.boardNo === null) return;
    this.submit({ t: 'play', table: at.table.index, board: at.table.boardNo, seat, card });
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
      isDirector: this.me.isDirector, pairCode: this.me.pairCode, note: this.me.note,
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
          pairCode: m.pairCode, note: m.note, joinedAt: m.joinedAt, seq: m.seq, lastSeen: this.o.now(),
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
    this.state = reduce(this.state, ev);
    this.log.push(ev);
    if (this.pending && sameEvent(this.pending, ev)) this.pending = null;
    if (save) this.o.persist?.save(this.log);
  }

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
    if (ev.t === 'start' || !this.state) return;
    const table = this.state.tables[ev.table];
    const playerId = this.playerOf(from);
    if (!table || !playerId) return;
    const controller = ev.t === 'play' && table.play ? controllerOf(table.play, ev.seat) : ev.seat;
    if (table.seats[controller]?.id !== playerId) return; // not that player's seat
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
    for (const table of [...this.state.tables]) {
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
      }
      if (!auto) continue;
      robotsWaiting = true;
      const ev: TEvent = turn.phase === 'auction' && table.auction && table.deal
        ? { t: 'call', table: table.index, board: table.boardNo, seat: turn.seat, call: chooseCall(table.deal[turn.seat], table.auction, turn.seat) }
        : { t: 'play', table: table.index, board: table.boardNo, seat: turn.seat, card: chooseCard(table.play!, turn.seat) };
      this.append(ev);
    }
    if (robotsWaiting) this.scheduleAuto();
  }

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
