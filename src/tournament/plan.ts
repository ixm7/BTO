/**
 * Where everybody sits, worked out from the entry list alone.
 *
 * A tournament used to be arranged by whoever happened to be hosting: they
 * looked at who was connected and broadcast the result. That only works when
 * every player is in one room with everybody else, which is the thing that
 * stops a large field from ever connecting.
 *
 * Nothing here needs a room. Given the same entry list, seed and format, every
 * client works out the same tables, the same pairs and the same movement, so a
 * player can go straight to their own table without being told where it is.
 * The tournament page supplies the entry list and the seed; that pinned list
 * is the only thing the field has to agree on.
 */
import { SEATS, type Seat } from '../engine/cards';
import { buildConfig, ewPairAt, firstBoardOfRound, type LobbyPlayer, type RobotSystem, type Scoring, type TournamentConfig } from './state';

export interface PlanInput {
  /** Tournament id, used to name the rooms. */
  id: string;
  name: string;
  seed: string;
  /** The pinned entry list, in the order it was pinned. */
  roster: LobbyPlayer[];
  boardsPerRound: number;
  rounds?: number;
  capacity?: number;
  minTables?: number;
  idleTimeoutMs?: number;
  scoring?: Scoring;
  robots?: RobotSystem;
}

/**
 * Build the configuration from the pinned entry list. This is `buildConfig`,
 * which is already a pure function of the list and the seed; naming it here
 * marks it as something every client runs for itself rather than something one
 * host runs and announces.
 */
export function planConfig(input: PlanInput): TournamentConfig {
  return buildConfig({
    id: input.id, name: input.name, seed: input.seed, players: input.roster,
    boardsPerRound: input.boardsPerRound, rounds: input.rounds,
    capacity: input.capacity, minTables: input.minTables, idleTimeoutMs: input.idleTimeoutMs, scoring: input.scoring, robots: input.robots,
  });
}

export interface SeatAssignment {
  table: number;
  seat: Seat;
  /** Index into `config.pairs` of the pair this player belongs to. */
  pair: number;
  /** The other three players at the table, in seat order. */
  opponents: string[];
}

/** Which pair sits North-South at a table, for every round. */
const nsPairAt = (table: number): number => 2 * table;

/**
 * The four seats of one table in one round, as player ids. North-South is the
 * pair that lives at the table; East-West moves on by one table each round.
 */
export function seatingAt(c: TournamentConfig, table: number, round: number): Record<Seat, string> {
  const ns = c.pairs[nsPairAt(table)]!.players;
  const ew = c.pairs[ewPairAt(c, table, round)]!.players;
  return { N: ns[0]!.id, S: ns[1]!.id, E: ew[0]!.id, W: ew[1]!.id };
}

/**
 * Tables with nobody of their own to play them: both their pairs are robots,
 * so no player's browser is ever in that room. A field short of people has
 * one — somebody has to run it, or its boards are never played and the people
 * who did turn up have nothing to compare their scores against.
 *
 * North-South keeps its table, so following its first player stays there all
 * evening, whoever East-West turns out to be.
 */
export function unmannedTables(c: TournamentConfig): { table: number; follow: string }[] {
  const out: { table: number; follow: string }[] = [];
  for (let table = 0; table < c.tables; table++) {
    const ns = c.pairs[nsPairAt(table)]!.players;
    if (ns.every((p) => p.bot)) out.push({ table, follow: ns[0]!.id });
  }
  return out;
}

/** Where this player sits in a given round, or null if they are not playing. */
export function seatOf(c: TournamentConfig, round: number, playerId: string): SeatAssignment | null {
  for (let table = 0; table < c.tables; table++) {
    const seats = seatingAt(c, table, round);
    for (const seat of SEATS) {
      if (seats[seat] !== playerId) continue;
      const pair = seat === 'N' || seat === 'S' ? nsPairAt(table) : ewPairAt(c, table, round);
      return { table, seat, pair, opponents: SEATS.filter((s) => s !== seat).map((s) => seats[s]) };
    }
  }
  return null;
}

/** The boards a given round plays, in order. */
export function boardsOfRound(c: TournamentConfig, round: number): number[] {
  const first = firstBoardOfRound(c, round);
  return Array.from({ length: c.boardsPerRound }, (_, i) => first + i);
}

/* ------------------------------------------------------------------ rooms */

/**
 * The room one table plays in, for one round. Only its four players join it,
 * so the mesh inside is three connections per player whatever the size of the
 * field. The round is part of the name because the four players change between
 * rounds, and a stale room would otherwise keep old peers connected.
 */
export const tableRoom = (tournamentId: string, round: number, table: number): string =>
  `${tournamentId}#r${round}t${table}`;

/**
 * The room the tables report into. Only one player per table joins it — the
 * table's own coordinator — so it holds about a quarter as many peers as the
 * field, and carries one small result record per board instead of every card.
 */
export const resultsRoom = (tournamentId: string): string => `${tournamentId}#results`;

/**
 * What the field would cost to connect, for a given number of players. Used by
 * the tests to hold the topology to its promise rather than to run anything.
 */
export function meshCost(players: number, tables: number): { perPlayer: number; perTableHost: number; links: number } {
  const perPlayer = 3;
  /* A table's host also sits in the results room with the other hosts. */
  const perTableHost = perPlayer + Math.max(0, tables - 1);
  const links = tables * 6 + (tables * (tables - 1)) / 2;
  return { perPlayer, perTableHost, links };
}
