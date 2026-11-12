/**
 * Tournament state as a pure function of an ordered event log.
 *
 * Every peer holds the same log and runs the same reducer, so every peer can
 * take over as coordinator at any moment. Deals are derived from the seed in
 * the start event, so no cards ever need to be transmitted.
 */
import { SEATS, type Card, type Seat } from '../engine/cards';
import {
  applyCall, currentBidder, finalContract, isAuctionOver, newAuction,
  type AuctionEntry, type AuctionState, type Call, type Contract,
} from '../engine/bidding';
import { dealBoard, dealerForBoard, seededRandom, vulnerabilityForBoard, type Hands, type Vulnerability } from '../engine/deal';
import { applyPlay, controllerOf, isPlayOver, startPlay, type PlayState } from '../engine/play';
import { matchpoints, nsScore, resultToString } from '../engine/scoring';

export interface PlayerRef {
  id: string;
  name: string;
  bot?: boolean;
}

export interface Pair {
  id: number;
  players: [PlayerRef, PlayerRef];
}

export interface TournamentConfig {
  id: string;
  name: string;
  /** Seed for all deals. */
  seed: string;
  tables: number;
  rounds: number;
  boardsPerRound: number;
  /** pairs[2t] sits North-South at table t; pairs[2t+1] starts East-West at table t. */
  pairs: Pair[];
  /**
   * How long a player may keep the table waiting before a robot takes their
   * seat, in milliseconds; 0 switches the rule off. Set by the director and
   * carried in the config so that every peer, whichever becomes coordinator,
   * applies the same limit.
   */
  idleTimeoutMs?: number;
}

export type TEvent =
  | { t: 'start'; config: TournamentConfig }
  | { t: 'call'; table: number; board: number; seat: Seat; call: Call; alert?: string }
  | { t: 'play'; table: number; board: number; seat: Seat; card: Card }
  /** A player who stopped responding, or stood down; a robot takes their seat. */
  | { t: 'retire'; playerId: string }
  /**
   * Somebody is to sit in the seat the entry list gave `forPlayerId`: that
   * player returning to their own seat, or a newcomer taking over from the
   * robot filling it. `player` null hands the seat back to its owner.
   * Takes effect when the next board is dealt, never mid-hand.
   */
  | { t: 'seat'; forPlayerId: string; player: PlayerRef | null }
  | { t: 'seating'; seating: Seating }
  /**
   * A board another table finished. A player only sees the cards played at
   * their own table, but a board cannot be scored until the other tables have
   * played it, so their results are carried in whole rather than replayed.
   */
  | { t: 'result'; result: BoardResult }
  /**
   * Declarer claims, or a defender concedes, part or all of the tricks still
   * to be played. `toDeclarer` is how many of them declarer's side would take,
   * so a claim and a concession are the same thing said from different chairs.
   * Play stops until the other two players in the hand have answered.
   */
  | { t: 'claim'; table: number; board: number; seat: Seat; toDeclarer: number }
  | { t: 'claimAnswer'; table: number; board: number; seat: Seat; accept: boolean }
  /** The claimer takes it back, or the host lets it lapse when nobody answers. */
  | { t: 'claimOff'; table: number; board: number; seat: Seat; why: 'withdrawn' | 'lapsed' };

/** A claim or concession waiting for the other side's answer. */
export interface Claim {
  seat: Seat;
  toDeclarer: number;
  /** Players who have already agreed. */
  agreed: Seat[];
}

/** How the last claim at a table came to nothing, shown until play resumes. */
export interface ClaimEnd { seat: Seat; why: 'refused' | 'withdrawn' | 'lapsed'; by?: Seat }

export interface BoardResult {
  board: number;
  round: number;
  table: number;
  nsPair: number;
  ewPair: number;
  contract: Contract | null;
  declarerTricks: number;
  nsScore: number;
  text: string;
  /**
   * How the contract was reached. The auction is otherwise thrown away when
   * the board ends, and results are the only thing that travels between
   * tables, so keeping it here is what lets anyone look back at the bidding —
   * their own, and every other table's on the same board.
   */
  auction?: AuctionEntry[];
  /** Set when the last tricks were agreed rather than played out. */
  claimed?: boolean;
}

export interface TableState {
  index: number;
  nsPair: number;
  ewPair: number;
  seats: Record<Seat, PlayerRef>;
  /** Board in progress, or null when this table has finished the round. */
  boardNo: number | null;
  dealer: Seat;
  vul: Vulnerability;
  /** The original 13-card hands of the board in progress. */
  deal: Hands | null;
  auction: AuctionState | null;
  play: PlayState | null;
  lastResult: BoardResult | null;
  /** A claim waiting for an answer, if any. Nobody plays a card meanwhile. */
  claim?: Claim | null;
  /** The last claim that came to nothing, until the next card is played. */
  claimEnd?: ClaimEnd | null;
  /**
   * True while this table is still worth playing. A table that was seated with
   * humans and has since lost every one of them to a robot is switched off:
   * there is no one left for it to play for.
   */
  active: boolean;
  /**
   * Whether a human was seated here when the round began. Tables made up
   * entirely of robots from the start exist to give the humans something to
   * score against, so they are never switched off on their own account.
   */
  hadHuman: boolean;
}

export interface TState {
  config: TournamentConfig;
  round: number;
  tables: TableState[];
  results: BoardResult[];
  finished: boolean;
  /**
   * Set when every table that had humans has been abandoned. The tournament is
   * over, but it did not run to a result, so it is reported as aborted rather
   * than finished.
   */
  aborted: boolean;
  /**
   * Players replaced by a robot after they stopped responding. Kept on the
   * state rather than only on the seat, so they stay retired when the tables
   * are re-seated for the next round.
   */
  retired: string[];
  /**
   * Who is sitting in a seat that its original owner is not filling: a player
   * who came back for their own seat, or one who arrived late and took over
   * from a robot. Keyed by the id the entry list gave that seat, because that
   * is what the movement is worked out from — a stand-in follows the seat,
   * round by round, exactly as its owner would have done.
   */
  substitutes: Record<string, PlayerRef>;
  /**
   * Seat changes asked for but not yet made. A hand in progress is not
   * interrupted: these are applied when the next board is dealt.
   */
  pendingSeats: Record<string, PlayerRef | null>;
}

/** Longest explanation kept for an alerted call. */
export const ALERT_MAX = 120;

export const totalBoards = (c: TournamentConfig): number => c.rounds * c.boardsPerRound;
export const firstBoardOfRound = (c: TournamentConfig, round: number): number => round * c.boardsPerRound + 1;

/**
 * Online Mitchell movement: North-South pairs are stationary, East-West pairs
 * move up one table each round. Because boards are dealt from a seed rather
 * than carried between tables, every table plays the same boards in a round.
 */
export function ewPairAt(c: TournamentConfig, table: number, round: number): number {
  return 2 * ((table + round) % c.tables) + 1;
}

/**
 * Put into effect every seat change that was asked for while the last board
 * was being played. Doing it here is what keeps the promise that a change
 * lands on the next hand and never interrupts one.
 */
/**
 * What has become of one seat's original occupant: whether they have stood
 * down, and who, if anyone, is playing their cards instead.
 *
 * Each round is played in a room of its own, with a log of its own, so the
 * next room would otherwise put everybody back in the seat the entry list
 * gave them. This is the little that has to travel: a table's host states the
 * standing of its own four players, and `round` settles which statement is
 * the newer one when two hosts have seen the same player.
 */
export interface SeatNews { round: number; retired: boolean; sub: PlayerRef | null }
export type Seating = Record<string, SeatNews>;

/** The newer word about each player wins; within a round, the arriving one. */
export function mergeSeating(into: Seating, from: Seating): Seating {
  const out: Seating = { ...into };
  for (const [id, news] of Object.entries(from)) {
    const have = out[id];
    if (!have || news.round >= have.round) out[id] = news;
  }
  return out;
}

/** Put everyone in the seat the retirements and stand-ins say they are in. */
function reseat(state: TState): void {
  const gone = new Set(state.retired);
  for (const t of state.tables) {
    const seats = { ...t.seats };
    for (const s of SEATS) {
      const original = originalAt(state.config, t, s);
      if (original) seats[s] = occupant(original, gone, state.substitutes);
    }
    t.seats = seats;
  }
  refreshActivity(state);
}

function applyPendingSeats(state: TState): void {
  const pending = Object.entries(state.pendingSeats);
  if (pending.length === 0) return;

  const subs = { ...state.substitutes };
  let retired = state.retired;
  for (const [id, player] of pending) {
    if (player === null) {
      delete subs[id];
      /* Handing a seat back to its owner also ends their retirement. */
      retired = retired.filter((x) => x !== id);
    } else {
      subs[id] = player;
    }
  }
  state.substitutes = subs;
  state.retired = retired;
  state.pendingSeats = {};
  reseat(state);
}

/** The id the entry list gave a seat, which is what seat changes are keyed by. */
export function originalSeatId(c: TournamentConfig, table: TableState, seat: Seat): string | undefined {
  return originalAt(c, table, seat)?.id;
}

/** The player the entry list put in this seat, before anyone stood in. */
function originalAt(c: TournamentConfig, table: TableState, seat: Seat): PlayerRef | undefined {
  const ns = c.pairs[table.nsPair]?.players;
  const ew = c.pairs[table.ewPair]?.players;
  if (!ns || !ew) return undefined;
  return seat === 'N' ? ns[0] : seat === 'S' ? ns[1] : seat === 'E' ? ew[0] : ew[1];
}

function setBoard(c: TournamentConfig, table: TableState, boardNo: number | null): void {
  table.boardNo = boardNo;
  table.play = null;
  table.claim = null;
  table.claimEnd = null;
  if (boardNo === null) {
    table.deal = null;
    table.auction = null;
    return;
  }
  table.dealer = dealerForBoard(boardNo);
  table.vul = vulnerabilityForBoard(boardNo);
  table.deal = dealBoard(c.seed, boardNo);
  table.auction = newAuction(table.dealer);
}

/**
 * The robot that takes over a seat when its player stops responding. The name
 * is derived from theirs so the other players can see who it stood in for, and
 * the id from theirs so every peer produces exactly the same seat.
 */
/** The entry list's own player for a seat id, if there is one. */
export function ownerOf(c: TournamentConfig, playerId: string): PlayerRef | undefined {
  for (const pair of c.pairs) for (const p of pair.players) if (p.id === playerId) return p;
  return undefined;
}

/** Where the given tables' original occupants now stand, to carry onward. */
export function seatingOf(state: TState, tables: readonly TableState[]): Seating {
  const out: Seating = {};
  for (const t of tables) {
    for (const s of SEATS) {
      const id = originalSeatId(state.config, t, s);
      if (!id) continue;
      out[id] = { round: state.round, retired: state.retired.includes(id), sub: state.substitutes[id] ?? null };
    }
  }
  return out;
}

export function standIn(p: PlayerRef): PlayerRef {
  const who = p.name.trim().slice(0, 24) || p.id;
  return { id: `bot:${p.id}`, name: `Robot for ${who}`, bot: true };
}

/**
 * Who actually sits in a seat: whoever has taken it over, else a robot if its
 * owner has gone, else the owner.
 */
function occupant(ref: PlayerRef, retired: ReadonlySet<string>, subs: Record<string, PlayerRef>): PlayerRef {
  return subs[ref.id] ?? (retired.has(ref.id) ? standIn(ref) : ref);
}

function seatTables(c: TournamentConfig, round: number, previous?: TableState[], retired: readonly string[] = [], subs: Record<string, PlayerRef> = {}): TableState[] {
  const tables: TableState[] = [];
  const gone = new Set(retired);
  for (let t = 0; t < c.tables; t++) {
    const nsPair = 2 * t;
    const ewPair = ewPairAt(c, t, round);
    const ns = (c.pairs[nsPair] as Pair).players;
    const ew = (c.pairs[ewPair] as Pair).players;
    const seated: Record<Seat, PlayerRef> = { N: ns[0], S: ns[1], E: ew[0], W: ew[1] };
    /* Whether humans were dealt into this table, before any of them were
       replaced: a table that lost its players still counts as having had them. */
    const hadHuman = SEATS.some((s) => !seated[s].bot);
    for (const s of SEATS) seated[s] = occupant(seated[s], gone, subs);
    const table: TableState = {
      index: t, nsPair, ewPair,
      seats: seated,
      boardNo: null, dealer: 'N', vul: 'None', deal: null, auction: null, play: null,
      lastResult: previous?.[t]?.lastResult ?? null,
      active: true, hadHuman,
    };
    setBoard(c, table, firstBoardOfRound(c, round));
    tables.push(table);
  }
  return tables;
}

/**
 * Switch off any table that had humans and has none left, and call the whole
 * tournament off once every such table is dark. Tables of robots alone are
 * ignored here: they were never anybody's game, and they keep playing so the
 * humans elsewhere still have scores to be compared against.
 */
function refreshActivity(state: TState): void {
  for (const t of state.tables) {
    dropClaimForRobots(t);
    if (t.active && t.hadHuman && SEATS.every((s) => t.seats[s].bot)) {
      t.active = false;
      t.boardNo = null;
      t.deal = null;
      t.auction = null;
      t.play = null;
    }
  }
  const staffed = state.tables.filter((t) => t.hadHuman);
  if (staffed.length > 0 && staffed.every((t) => !t.active)) {
    state.aborted = true;
    state.finished = true;
  }
}

export function validateConfig(c: TournamentConfig): void {
  if (c.tables < 1) throw new Error('Need at least one table');
  if (c.pairs.length !== c.tables * 2) throw new Error('Need exactly two pairs per table');
  if (c.rounds < 1 || c.boardsPerRound < 1) throw new Error('Need at least one round and one board');
}

/* ---- Claims and concessions ---- */

/** Tricks not yet won by either side, the one in progress included. */
export const tricksLeft = (p: PlayState): number => 13 - p.declarerTricks - p.defenderTricks;

/** Declarer and the two defenders: everyone with a say in a claim. Dummy has none. */
export const claimParties = (p: PlayState): Seat[] => SEATS.filter((s) => s !== p.dummy);

/** Who still has to agree to the claim on the table. */
export function claimWaitingOn(table: TableState): Seat[] {
  const c = table.claim;
  if (!c || !table.play) return [];
  return claimParties(table.play).filter((s) => s !== c.seat && !c.agreed.includes(s));
}

/**
 * Why `seat` may not claim now, or null if it may. A robot cannot weigh a
 * claim, so one is only possible when declarer and both defenders are people.
 */
export function claimBlocked(table: TableState, seat: Seat): string | null {
  const p = table.play;
  if (!table.active || table.boardNo === null || !p) return 'There is no hand being played';
  if (seat === p.dummy) return 'Dummy cannot claim';
  if (p.cardsPlayed === 0) return 'Wait until the opening lead has been made';
  if (tricksLeft(p) <= 0) return 'There are no tricks left';
  if (table.claim) return 'A claim is already waiting for an answer';
  if (claimParties(p).some((s) => table.seats[s].bot)) return 'Claims are only possible when declarer and both defenders are people — a robot cannot agree to one';
  return null;
}

/** A robot has taken a seat with a say in the claim: nobody is left to answer it. */
function dropClaimForRobots(t: TableState): void {
  const c = t.claim;
  if (!c || !t.play) return;
  if (claimParties(t.play).some((s) => t.seats[s].bot)) {
    t.claim = null;
    t.claimEnd = { seat: c.seat, why: 'lapsed' };
  }
}

function finishBoard(state: TState, table: TableState, contract: Contract | null, declarerTricks: number, claimed = false): void {
  const c = state.config;
  const boardNo = table.boardNo as number;
  const result: BoardResult = {
    board: boardNo, round: state.round, table: table.index,
    nsPair: table.nsPair, ewPair: table.ewPair,
    contract, declarerTricks,
    nsScore: nsScore(contract, table.vul, declarerTricks),
    text: resultToString(contract, declarerTricks),
    /* Taken before setBoard clears it for the next board. */
    ...(table.auction && table.auction.calls.length > 0 ? { auction: [...table.auction.calls] } : {}),
    ...(claimed ? { claimed: true } : {}),
  };
  state.results = [...state.results, result];
  table.lastResult = result;
  const lastOfRound = firstBoardOfRound(c, state.round) + c.boardsPerRound - 1;
  setBoard(c, table, boardNo < lastOfRound ? boardNo + 1 : null);
  applyPendingSeats(state);
  advanceIfRoundOver(state);
}

/**
 * The field moves together: nobody starts the next round until every table has
 * played the round's boards, exactly as a director would call the move.
 */
function advanceIfRoundOver(state: TState): void {
  const c = state.config;
  if (!state.tables.every((t) => t.boardNo === null)) return;
  if (state.round + 1 >= c.rounds) {
    state.finished = true;
    return;
  }
  state.round++;
  state.tables = seatTables(c, state.round, state.tables, state.retired, state.substitutes);
  refreshActivity(state);
}

/**
 * Mark off a board that another table has finished. A player watches only
 * their own table's cards, so a foreign table's progress is known solely from
 * the results it reports; once it has reported the whole round, it is done.
 */
function creditForeignBoard(state: TState, table: TableState): void {
  const c = state.config;
  if (table.boardNo === null) return;
  const first = firstBoardOfRound(c, state.round);
  const last = first + c.boardsPerRound - 1;
  const played = state.results.filter((r) => r.table === table.index && r.board >= first && r.board <= last);
  if (played.length < c.boardsPerRound) return;
  table.lastResult = played[played.length - 1] ?? table.lastResult;
  setBoard(c, table, null);
}

/** Apply one event. Throws if the event is illegal; never mutates its input. */
export function reduce(prev: TState | null, ev: TEvent): TState {
  if (ev.t === 'start') {
    if (prev) throw new Error('Tournament already started');
    validateConfig(ev.config);
    return { config: ev.config, round: 0, tables: seatTables(ev.config, 0), results: [], finished: false, aborted: false, retired: [], substitutes: {}, pendingSeats: {} };
  }
  if (!prev) throw new Error('Tournament has not started');
  if (prev.finished) throw new Error('Tournament is over');
  const state: TState = { ...prev, tables: prev.tables.map((t) => ({ ...t })) };

  if (ev.t === 'result') {
    const r = ev.result;
    const table = state.tables[r.table];
    if (!table) throw new Error('No such table');
    /* Results arrive from several tables at once and may be repeated as hosts
       change, so a board already recorded is accepted and changes nothing. */
    if (state.results.some((x) => x.table === r.table && x.board === r.board)) return state;
    state.results = [...state.results, r];
    creditForeignBoard(state, table);
    advanceIfRoundOver(state);
    return state;
  }

  if (ev.t === 'seat') {
    const owner = ownerOf(state.config, ev.forPlayerId);
    if (!owner) throw new Error('No such seat');
    if (ev.player === null) {
      /* Only the seat's own owner may ask for it back. */
      state.pendingSeats = { ...state.pendingSeats, [ev.forPlayerId]: null };
      return state;
    }
    /* A seat with somebody in it is not up for grabs. */
    const held = state.substitutes[ev.forPlayerId];
    const retiredOwner = state.retired.includes(ev.forPlayerId);
    const vacant = (retiredOwner || owner.bot) && !held;
    if (!vacant && held?.id !== ev.player.id) throw new Error('Somebody is already in that seat');

    if (state.pendingSeats[ev.forPlayerId] !== undefined) throw new Error('That seat has already been taken');
    /* Nobody may sit in two seats at once. */
    const taker = ev.player;
    const already = Object.values({ ...state.substitutes, ...state.pendingSeats })
      .some((p) => p !== null && p !== undefined && p.id === taker.id);
    const seatedAlready = state.tables.some((t) => SEATS.some((s) => t.seats[s].id === taker.id));
    if (already || seatedAlready) throw new Error('You are already at a table');
    state.pendingSeats = { ...state.pendingSeats, [ev.forPlayerId]: taker };
    return state;
  }

  if (ev.t === 'seating') {
    /* Brought in by a table's host as a round's room opens, so that a player
       who stood down in the last round is not handed their cards again, and a
       stand-in keeps the seat they took on. It states a standing rather than
       asking for a change, so it is applied at once — which is safe only
       because it arrives before the round's first card. */
    const retired = new Set(state.retired);
    const subs = { ...state.substitutes };
    for (const [id, news] of Object.entries(ev.seating)) {
      if (!ownerOf(state.config, id)) continue; // not a seat in this tournament
      if (news.retired) retired.add(id); else retired.delete(id);
      if (news.sub) subs[id] = news.sub; else delete subs[id];
    }
    /* Held in the entry list's order, so every peer's state is the same. */
    const order = state.config.pairs.flatMap((pair) => pair.players.map((p) => p.id));
    state.retired = order.filter((id) => retired.has(id));
    state.substitutes = subs;
    reseat(state);
    return state;
  }

  if (ev.t === 'retire') {
    /* Replaying the same retirement twice must land in the same place, so a
       repeat is accepted and simply changes nothing. */
    if (!state.retired.includes(ev.playerId)) state.retired = [...state.retired, ev.playerId];
    for (const t of state.tables) {
      const seats = { ...t.seats };
      let changed = false;
      for (const s of SEATS) {
        if (seats[s].id === ev.playerId && !seats[s].bot) { seats[s] = standIn(seats[s]); changed = true; }
      }
      if (changed) { t.seats = seats; dropClaimForRobots(t); }
    }
    refreshActivity(state);
    return state;
  }

  const table = state.tables[ev.table];
  if (!table) throw new Error('No such table');
  if (!table.active) throw new Error('That table has been closed');
  if (table.boardNo === null || table.boardNo !== ev.board) throw new Error('That board is not in play at this table');

  if (ev.t === 'call') {
    if (!table.auction || table.play) throw new Error('Auction is over');
    table.auction = applyCall(table.auction, ev.seat, ev.call, ev.alert?.slice(0, ALERT_MAX));
    if (isAuctionOver(table.auction)) {
      const contract = finalContract(table.auction);
      if (!contract) finishBoard(state, table, null, 0);
      else table.play = startPlay(contract, table.deal as Hands);
    }
    return state;
  }

  if (!table.play) throw new Error('Play has not started');

  if (ev.t === 'claim') {
    const why = claimBlocked(table, ev.seat);
    if (why) throw new Error(why);
    const left = tricksLeft(table.play);
    if (!Number.isInteger(ev.toDeclarer) || ev.toDeclarer < 0 || ev.toDeclarer > left) throw new Error(`A claim must be for 0 to ${left} tricks`);
    table.claim = { seat: ev.seat, toDeclarer: ev.toDeclarer, agreed: [] };
    table.claimEnd = null;
    return state;
  }
  if (ev.t === 'claimAnswer') {
    const c = table.claim;
    if (!c) throw new Error('There is no claim to answer');
    if (!claimWaitingOn(table).includes(ev.seat)) throw new Error('That seat has no claim to answer');
    if (!ev.accept) {
      table.claim = null;
      table.claimEnd = { seat: c.seat, why: 'refused', by: ev.seat };
      return state;
    }
    table.claim = { ...c, agreed: [...c.agreed, ev.seat] };
    if (claimWaitingOn(table).length === 0) {
      const p = table.play;
      finishBoard(state, table, p.contract, p.declarerTricks + c.toDeclarer, true);
    }
    return state;
  }
  if (ev.t === 'claimOff') {
    const c = table.claim;
    if (!c) throw new Error('There is no claim to take back');
    if (ev.why === 'withdrawn' && ev.seat !== c.seat) throw new Error('Only the player who claimed can take it back');
    table.claim = null;
    table.claimEnd = { seat: c.seat, why: ev.why };
    return state;
  }

  if (table.claim) throw new Error('Play is paused while a claim is answered');
  table.claimEnd = null;
  table.play = applyPlay(table.play, ev.seat, ev.card);
  if (isPlayOver(table.play)) finishBoard(state, table, table.play.contract, table.play.declarerTricks);
  return state;
}

export function replay(events: readonly TEvent[]): TState | null {
  let s: TState | null = null;
  for (const e of events) s = reduce(s, e);
  return s;
}

export interface Turn {
  phase: 'auction' | 'play';
  /** The seat that must act. */
  seat: Seat;
  /** The seat whose player makes the decision (declarer for dummy). */
  controller: Seat;
}

export function turnAt(table: TableState): Turn | null {
  if (!table.active || table.boardNo === null) return null;
  /* Nobody is on turn while a claim waits: the table waits on its answer. */
  if (table.claim) return null;
  if (table.play) return { phase: 'play', seat: table.play.turn, controller: controllerOf(table.play, table.play.turn) };
  if (table.auction) {
    const seat = currentBidder(table.auction);
    return { phase: 'auction', seat, controller: seat };
  }
  return null;
}

/** Where a player is currently sitting, if anywhere. */
export function findSeat(state: TState, playerId: string): { table: TableState; seat: Seat } | null {
  for (const table of state.tables) {
    for (const seat of SEATS) if (table.seats[seat].id === playerId) return { table, seat };
  }
  return null;
}

export interface Standing {
  rank: number;
  pair: Pair;
  direction: 'NS' | 'EW';
  matchpoints: number;
  maxMatchpoints: number;
  percent: number;
  boardsPlayed: number;
}

/** Matchpoint standings over every board that at least one table has finished. */
export function standings(state: TState): Standing[] {
  const acc = state.config.pairs.map(() => ({ mp: 0, max: 0, boards: 0 }));
  const byBoard = new Map<number, BoardResult[]>();
  for (const r of state.results) {
    const list = byBoard.get(r.board) ?? [];
    list.push(r);
    byBoard.set(r.board, list);
  }
  for (const results of byBoard.values()) {
    const { ns, top } = matchpoints(results.map((r) => r.nsScore));
    results.forEach((r, i) => {
      // With a single result there is nothing to compare against: both sides get 50% of a 2-point top.
      const max = top === 0 ? 2 : top;
      const nsMp = top === 0 ? 1 : (ns[i] as number);
      const a = acc[r.nsPair] as { mp: number; max: number; boards: number };
      const b = acc[r.ewPair] as { mp: number; max: number; boards: number };
      a.mp += nsMp; a.max += max; a.boards++;
      b.mp += max - nsMp; b.max += max; b.boards++;
    });
  }
  const rows: Standing[] = state.config.pairs.map((pair, i) => {
    const a = acc[i] as { mp: number; max: number; boards: number };
    return {
      rank: 0, pair, direction: i % 2 === 0 ? 'NS' : 'EW',
      matchpoints: a.mp, maxMatchpoints: a.max,
      percent: a.max === 0 ? 0 : Math.round((a.mp / a.max) * 10000) / 100,
      boardsPlayed: a.boards,
    };
  });
  rows.sort((x, y) => y.percent - x.percent || x.pair.id - y.pair.id);
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && prev.percent === r.percent ? prev.rank : i + 1;
  });
  return rows;
}

export interface LobbyPlayer extends PlayerRef {
  /** Players who enter the same code are paired together. */
  pairCode?: string;
  joinedAt: number;
}

/**
 * Deterministic Fisher-Yates shuffle. Seeded (from the tournament seed) so that,
 * for a given seed, the pairing is reproducible rather than arbitrary — useful for
 * tests and for anyone double-checking a result — while still spreading partners
 * across the field instead of always pairing strictly in arrival order.
 */
function shuffle<T>(items: readonly T[], seed: string): T[] {
  const rand = seededRandom(`${seed}|pairing`);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

let botCounter = 0;
const BOT_NAMES = ['Robot Ada', 'Robot Blaise', 'Robot Culbertson', 'Robot Dorothy', 'Robot Ely', 'Robot Fritz', 'Robot Goren', 'Robot Helen'];
function makeBot(n: number): PlayerRef {
  return { id: `bot:${n}`, name: BOT_NAMES[n % BOT_NAMES.length] + (n >= BOT_NAMES.length ? ` ${Math.floor(n / BOT_NAMES.length) + 1}` : ''), bot: true };
}

/**
 * Turn a list of present players into pairs and tables. Players sharing a pair
 * code play together, everyone else is paired in arrival order, and robots fill
 * any gap so that every table has four players.
 */
export function buildConfig(opts: {
  id: string; name: string; seed: string; players: LobbyPlayer[];
  boardsPerRound: number; rounds?: number; capacity?: number; minTables?: number;
  idleTimeoutMs?: number;
}): TournamentConfig {
  botCounter = 0;
  let players = [...opts.players].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
  if (opts.capacity && players.length > opts.capacity) players = players.slice(0, opts.capacity);

  const pairsOfPlayers: PlayerRef[][] = [];
  const used = new Set<string>();
  const byCode = new Map<string, LobbyPlayer[]>();
  for (const p of players) {
    const code = p.pairCode?.trim().toLowerCase();
    if (!code) continue;
    const list = byCode.get(code) ?? [];
    list.push(p);
    byCode.set(code, list);
  }
  for (const list of byCode.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      const a = list[i] as LobbyPlayer;
      const b = list[i + 1] as LobbyPlayer;
      pairsOfPlayers.push([a, b]);
      used.add(a.id); used.add(b.id);
    }
  }
  // Players without a shared pair code are paired up at random (not in arrival order), so
  // nobody is stuck playing with whoever happened to join nearest them; one leftover, if the
  // count is odd, is paired with a robot below.
  const rest = shuffle(players.filter((p) => !used.has(p.id)), opts.seed);
  for (let i = 0; i < rest.length; i += 2) {
    pairsOfPlayers.push(rest.slice(i, i + 2));
  }
  const strip = (p: PlayerRef): PlayerRef => (p.bot ? { id: p.id, name: p.name, bot: true } : { id: p.id, name: p.name });
  const full: [PlayerRef, PlayerRef][] = pairsOfPlayers.map((pp) => [
    strip(pp[0] as PlayerRef), pp[1] ? strip(pp[1]) : makeBot(botCounter++),
  ]);
  while (full.length < 2 * Math.max(1, opts.minTables ?? 1) || full.length % 2 !== 0) full.push([makeBot(botCounter++), makeBot(botCounter++)]);

  const tables = full.length / 2;
  const rounds = Math.max(1, opts.rounds ?? Math.min(tables, 4));
  return {
    id: opts.id, name: opts.name, seed: opts.seed, tables, rounds,
    boardsPerRound: Math.max(1, opts.boardsPerRound),
    pairs: full.map((players, id) => ({ id, players })),
    ...(opts.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: Math.max(0, Math.round(opts.idleTimeoutMs)) }),
  };
}
