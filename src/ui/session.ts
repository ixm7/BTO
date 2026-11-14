/**
 * Plays a tournament one table at a time.
 *
 * A player only ever joins the room of the table they are sitting at, so they
 * hold three connections however large the field is. Between rounds they work
 * out their next table for themselves and move to its room. The only traffic
 * that crosses tables is a small record per finished board, carried by one
 * player per table — its host — in a room the hosts share.
 *
 * Everything a new room needs to know about what has already been played is
 * those same records: fed in at the start, they walk the fresh state up to the
 * round about to be played.
 */
import { resultsRoom, seatOf, tableRoom } from '../tournament/plan';
import { TournamentNode, type Me, type RobotBrain } from '../tournament/node';
import { mergeSeating, type BoardResult, type Seating, type TournamentConfig } from '../tournament/state';
import type { Transport } from '../net/transport';

export interface SessionOptions {
  config: TournamentConfig;
  me: Me;
  /** Opens a transport for a named room. */
  connect(room: string): Promise<Transport> | Transport;
  /** Called whenever anything the interface shows may have changed. */
  onChange(): void;
  /** The seat to follow, when standing in for somebody else. */
  actingAs?: string;
  /** How often somebody with no seat looks again. Default 9 seconds. */
  seekIntervalMs?: number;
  botDelayMs?: number;
  /** How the robots at this player's table think, when this device hosts it. */
  robot?: RobotBrain;
  /** The clock the robots wait on; see `NodeOptions.wake`. */
  wake?: (fn: () => void, ms: number) => () => void;
  /**
   * Somewhere to leave what this player has seen of the tournament, so that
   * reloading the page picks it up where it was. Without it a reloaded
   * browser knows nothing, rejoins at the first round and plays its boards
   * over again while the rest of the field has moved on.
   */
  remember?: { load(): SessionMemory | null; save(m: SessionMemory): void };
  /**
   * Set on a session that is not a person but a browser keeping a table of
   * robots going on the field's behalf. It plays its table and reports the
   * boards like any other host; it just has nothing to say about where
   * anybody is sitting.
   */
  unmanned?: boolean;
}

/** What a browser needs to rejoin a tournament where it left off. */
export interface SessionMemory {
  round: number;
  actingAs: string;
  results: BoardResult[];
  seating: Seating;
}

export class TournamentSession {
  /** The node for the round being played, or null while moving between rounds. */
  node: TournamentNode | null = null;
  /** Every board the field has reported, carried from round to round. */
  results: BoardResult[] = [];
  round = 0;
  /** Set when this player has no seat in the draw. */
  notPlaying = false;
  /**
   * The seat this player follows round the movement. Normally their own, but
   * a stand-in follows the seat they took over: the movement is worked out
   * from the entry list, which has never heard of them.
   */
  actingAs: string;
  moving = false;
  lastError: string | null = null;
  /** The table being watched in the hope of taking a robot's seat, if any. */
  watching: number | null = null;

  private link: Transport | null = null;
  private closed = false;
  private hop: ReturnType<typeof setTimeout> | null = null;
  /** Who is not in the seat the entry list gave them, as the field knows it. */
  private seating: Seating = {};
  private sentSeating = '';
  private declared = '';
  /** Set once the person has asked to take a robot's place. */
  private wants = false;
  /** Players this room has been told about, so silence is not mistaken for news. */
  private knownHere = new Set<string>();

  constructor(private o: SessionOptions) { this.actingAs = o.actingAs ?? o.me.playerId; }

  get config(): TournamentConfig { return this.o.config; }

  async start(): Promise<void> {
    const was = this.o.remember?.load();
    if (was && was.results.length > 0) {
      this.results = was.results;
      this.seating = was.seating;
      this.actingAs = was.actingAs;
      await this.joinRound(Math.max(0, Math.min(was.round, this.o.config.rounds - 1)));
      return;
    }
    await this.joinRound(0);
  }

  /** Leave what we know where a reloaded page will find it. */
  private keep(): void {
    this.o.remember?.save({ round: this.round, actingAs: this.actingAs, results: this.results, seating: this.seating });
  }

  close(): void {
    this.closed = true;
    this.stopHop();
    this.node?.close();
    this.link?.leave();
    this.node = null;
    this.link = null;
  }

  /**
   * Joins the room of the table this player belongs to. Somebody with no seat
   * in the draw — a latecomer — belongs nowhere, so they watch one table at a
   * time instead, moving on until they find a robot they can take over.
   */
  private async joinRound(round: number): Promise<void> {
    if (this.closed) return;
    this.stopHop();
    const at = seatOf(this.o.config, round, this.actingAs);
    this.notPlaying = !at;
    if (at) this.watching = null;
    else this.watching = this.watching === null
      ? Math.floor(Math.random() * this.o.config.tables)
      : (this.watching + 1) % this.o.config.tables;
    const table = at ? at.table : this.watching!;

    this.declared = '';
    this.knownHere = new Set();
    this.moving = true;
    this.o.onChange();
    this.node?.close();
    this.link?.leave();
    this.link = null;

    const transport = await this.o.connect(tableRoom(this.o.config.id, round, table));
    if (this.closed) { transport.leave(); return; }

    const node = new TournamentNode(transport, {
      ...this.o.me,
      /* A watcher is only passing through, so it should not end up hosting a
         table it may leave again in a moment. */
      ...(at ? {} : { deviceScore: 1, isDirector: false }),
    }, {
      botDelayMs: this.o.botDelayMs ?? 900,
      robot: this.o.robot,
      ...(this.o.wake ? { wake: this.o.wake } : {}),
      tableIndex: table,
      idleTimeoutMs: this.o.config.idleTimeoutMs,
    });
    this.node = node;
    this.round = round;
    this.moving = false;
    this.keep();

    /* A board we finish is the rest of the field's only sight of this table. */
    node.onResult((r) => {
      this.remember(r);
      this.link?.send({ r });
    });

    node.onChange(() => { void this.onNodeChange(); });
    void this.onNodeChange();
    if (!at) this.startHop();
    this.o.onChange();
  }

  /** Ask for a robot's seat at the table being watched, from the next board. */
  claimRobotSeat(): void {
    this.wants = true;
    const free = this.node?.robotSeats() ?? [];
    const pick = free[Math.floor(Math.random() * free.length)];
    if (pick) this.node?.takeSeat(pick.forPlayerId);
  }

  /** Have we asked for a seat here and not yet been given it? */
  private claimPending(): boolean {
    const state = this.node?.state;
    const me = this.o.me.playerId;
    if (!state) return false;
    return Object.values(state.pendingSeats).some((p) => p?.id === me)
      || Object.values(state.substitutes).some((p) => p.id === me);
  }

  /**
   * Keep after a seat while there is no seat of our own. A table with a robot
   * in it is worth staying at — the person may be about to ask for it, and an
   * ask that went astray is worth repeating. A table with nobody to replace
   * is not, so we look at the next one.
   */
  private startHop(): void {
    this.stopHop();
    /* Long enough for the table to have told us who is sitting at it. */
    this.hop = setTimeout(() => {
      this.hop = null;
      if (this.closed || !this.notPlaying) return;
      if (this.claimPending()) { this.startHop(); return; }
      if ((this.node?.robotSeats().length ?? 0) > 0) {
        if (this.wants) this.claimRobotSeat();
        this.startHop();
        return;
      }
      void this.joinRound(this.round);
    }, this.o.seekIntervalMs ?? 9000);
  }

  private stopHop(): void {
    if (this.hop) { clearTimeout(this.hop); this.hop = null; }
  }

  /**
   * Keep up with where this table's players stand, and tell the other hosts.
   * It is only a few words per table, sent when something has changed.
   */
  private noteSeating(): void {
    const node = this.node;
    if (!node?.state) return;
    /* A round's room starts from the entry list, so it says of everybody that
       they are in their own seat. That is not news — it is a room that has
       not been told yet — and taking it for news would wipe out what we are
       carrying. Only a player this room has heard about can be reported as
       being back in their own seat. */
    const reading: Seating = {};
    for (const [id, news] of Object.entries(node.seating())) {
      if (news.retired || news.sub) this.knownHere.add(id);
      if (news.retired || news.sub || this.knownHere.has(id)) reading[id] = news;
    }
    this.seating = mergeSeating(this.seating, reading);
    const packed = JSON.stringify(this.seating);
    if (packed === this.sentSeating || !this.link) return;
    this.sentSeating = packed;
    this.link.send({ s: this.seating });
  }

  /**
   * A round's room starts from the entry list and knows nothing of who has
   * stood down since. Of everybody who could put it right, the one certain to
   * be in the room is the player concerned, so they say so themselves.
   */
  private declareStanding(): void {
    const node = this.node;
    const state = node?.state;
    if (!node || !state || this.o.unmanned) return;
    const me = this.o.me.playerId;
    const mine: Seating = {};
    for (const [id, news] of Object.entries(this.seating)) {
      if (news.sub?.id === me) {
        if (state.substitutes[id]?.id !== me) mine[id] = news;
      } else if (id === me && news.retired && !state.retired.includes(me)) {
        /* I stood down in an earlier round and this room has not heard. What
           became of my seat afterwards is not mine to say, so I say only
           that I stood down. */
        mine[id] = { ...news, sub: null };
      }
    }
    /* Saying it once is usually enough, but a seat may only come free when
       its owner stands down a moment later, so each change in the room's own
       standing is worth another word. */
    const packed = JSON.stringify([mine, state.retired, Object.keys(state.substitutes)]);
    if (Object.keys(mine).length === 0 || packed === this.declared) return;
    this.declared = packed;
    node.declareStanding(mine);
  }

  private remember(r: BoardResult): void {
    if (this.results.some((x) => x.table === r.table && x.board === r.board)) return;
    this.results.push(r);
    this.keep();
  }

  private async onNodeChange(): Promise<void> {
    const node = this.node;
    if (!node || this.closed) return;
    this.lastError = node.lastError;

    /* The host of a table is the one that sits in the results room. That can
       change hands mid-round, so the link follows the role rather than being
       set up once. */
    /* Somebody with no seat is only passing through: they neither host a
       table nor speak for one. */
    const hosting = node.isCoordinator && !this.notPlaying;
    if (hosting && !this.link) await this.openLink();
    else if (!hosting && this.link) { this.link.leave(); this.link = null; }

    if (hosting && !node.state) {
      /* First one here: lay out the tournament and catch the room up on every
         board already played, which is what brings it to the right round. */
      try {
        node.startWithConfig(this.o.config);
        /* The results walk this fresh room up to the round about to be
           played; the seating then says who is sitting down to play it. */
        for (const r of this.results) node.importResult(r);
        node.importSeating(this.seating);
      } catch { /* somebody else got there first; their log wins */ }
    }

    for (const r of node.knownResults()) this.remember(r);
    this.noteSeating();
    this.declareStanding();

    /* Taking over a seat changes which table we belong to from the next
       round, so follow it rather than our own name. */
    const taken = Object.entries(node.state?.substitutes ?? {})
      .find(([, who]) => who.id === this.o.me.playerId);
    if (taken && taken[0] !== this.actingAs) {
      this.actingAs = taken[0];
      this.notPlaying = false;
      this.watching = null;
      this.stopHop();
    }

    const state = node.state;
    if (state && !state.finished && state.round > this.round) {
      const next = state.round;
      void this.joinRound(next);
      return;
    }
    this.o.onChange();
  }

  private async openLink(): Promise<void> {
    const link = await this.o.connect(resultsRoom(this.o.config.id));
    if (this.closed || !this.node?.isCoordinator) { link.leave(); return; }
    this.link = link;
    link.onMessage((msg) => {
      const { r, s } = msg as { r?: BoardResult; s?: Seating };
      if (s) {
        this.seating = mergeSeating(this.seating, s);
        /* Mostly about other tables, and then it changes nothing here; but a
           table whose host was not a host last round learns this way who at
           its own table has stood down. */
        this.node?.importSeating(this.seating);
      }
      if (!r) return;
      this.remember(r);
      this.node?.importResult(r);
    });
    /* Tell the other hosts what this table has already done, so a host that
       arrives late is not the reason the field cannot move on. */
    for (const r of this.results) link.send({ r });
    this.sentSeating = JSON.stringify(this.seating);
    link.send({ s: this.seating });
  }
}
