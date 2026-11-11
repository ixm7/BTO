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
import { TournamentNode, type Me } from '../tournament/node';
import type { BoardResult, TournamentConfig } from '../tournament/state';
import type { Transport } from '../net/transport';

export interface SessionOptions {
  config: TournamentConfig;
  me: Me;
  /** Opens a transport for a named room. */
  connect(room: string): Promise<Transport> | Transport;
  /** Called whenever anything the interface shows may have changed. */
  onChange(): void;
  botDelayMs?: number;
}

export class TournamentSession {
  /** The node for the round being played, or null while moving between rounds. */
  node: TournamentNode | null = null;
  /** Every board the field has reported, carried from round to round. */
  results: BoardResult[] = [];
  round = 0;
  /** Set when this player has no seat in the draw. */
  notPlaying = false;
  moving = false;
  lastError: string | null = null;

  private link: Transport | null = null;
  private closed = false;

  constructor(private o: SessionOptions) {}

  get config(): TournamentConfig { return this.o.config; }

  async start(): Promise<void> { await this.joinRound(0); }

  close(): void {
    this.closed = true;
    this.node?.close();
    this.link?.leave();
    this.node = null;
    this.link = null;
  }

  private async joinRound(round: number): Promise<void> {
    if (this.closed) return;
    const at = seatOf(this.o.config, round, this.o.me.playerId);
    if (!at) { this.notPlaying = true; this.o.onChange(); return; }

    this.moving = true;
    this.o.onChange();
    this.node?.close();
    this.link?.leave();
    this.link = null;

    const transport = await this.o.connect(tableRoom(this.o.config.id, round, at.table));
    if (this.closed) { transport.leave(); return; }

    const node = new TournamentNode(transport, this.o.me, {
      botDelayMs: this.o.botDelayMs ?? 900,
      tableIndex: at.table,
      idleTimeoutMs: this.o.config.idleTimeoutMs,
    });
    this.node = node;
    this.round = round;
    this.moving = false;

    /* A board we finish is the rest of the field's only sight of this table. */
    node.onResult((r) => {
      this.remember(r);
      this.link?.send({ r });
    });

    node.onChange(() => { void this.onNodeChange(); });
    void this.onNodeChange();
    this.o.onChange();
  }

  private remember(r: BoardResult): void {
    if (!this.results.some((x) => x.table === r.table && x.board === r.board)) this.results.push(r);
  }

  private async onNodeChange(): Promise<void> {
    const node = this.node;
    if (!node || this.closed) return;
    this.lastError = node.lastError;

    /* The host of a table is the one that sits in the results room. That can
       change hands mid-round, so the link follows the role rather than being
       set up once. */
    if (node.isCoordinator && !this.link) await this.openLink();
    else if (!node.isCoordinator && this.link) { this.link.leave(); this.link = null; }

    if (node.isCoordinator && !node.state) {
      /* First one here: lay out the tournament and catch the room up on every
         board already played, which is what brings it to the right round. */
      try {
        node.startWithConfig(this.o.config);
        for (const r of this.results) node.importResult(r);
      } catch { /* somebody else got there first; their log wins */ }
    }

    for (const r of node.knownResults()) this.remember(r);

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
      const r = (msg as { r?: BoardResult }).r;
      if (!r) return;
      this.remember(r);
      this.node?.importResult(r);
    });
    /* Tell the other hosts what this table has already done, so a host that
       arrives late is not the reason the field cannot move on. */
    for (const r of this.results) link.send({ r });
  }
}
