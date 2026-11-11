/**
 * Looking back over boards already played.
 *
 * Everything here is derived, never stored: the four hands come back from the
 * seed and the board number, and the comparison across tables comes from the
 * result records the field reports. So a board can be reviewed by anyone who
 * has the results, whether or not they were at the table that played it.
 */
import { dealBoard, dealerForBoard, vulnerabilityForBoard, type Hands, type Vulnerability } from '../engine/deal';
import { matchpoints } from '../engine/scoring';
import type { Seat } from '../engine/cards';
import type { BoardResult, Pair, TState } from './state';

export interface TravellerRow {
  result: BoardResult;
  /** Matchpoints to North-South, out of `top`. */
  nsMatchpoints: number;
  top: number;
  nsPercent: number;
  /** True for the row the viewer played in, when they played this board. */
  mine: boolean;
}

export interface BoardReview {
  board: number;
  dealer: Seat;
  vul: Vulnerability;
  hands: Hands;
  /** Every table's result on this board, best for North-South first. */
  traveller: TravellerRow[];
  /** The viewer's own row, if they played this board. */
  own: TravellerRow | null;
}

/** Scores across the field on one board, matchpointed against each other. */
export function reviewBoard(state: TState, board: number, myPair: number | null): BoardReview {
  const rows = state.results.filter((r) => r.board === board);
  const { ns, top } = matchpoints(rows.map((r) => r.nsScore));
  /* A board played at only one table has nothing to compare against, so each
     side takes half of a two-point top rather than everything or nothing. */
  const max = top === 0 ? 2 : top;

  const traveller: TravellerRow[] = rows.map((result, i) => ({
    result,
    nsMatchpoints: top === 0 ? 1 : (ns[i] as number),
    top: max,
    nsPercent: max === 0 ? 0 : Math.round(((top === 0 ? 1 : (ns[i] as number)) / max) * 1000) / 10,
    mine: myPair !== null && (result.nsPair === myPair || result.ewPair === myPair),
  }));
  traveller.sort((a, b) => b.result.nsScore - a.result.nsScore);

  return {
    board,
    dealer: dealerForBoard(board),
    vul: vulnerabilityForBoard(board),
    hands: dealBoard(state.config.seed, board),
    traveller,
    own: traveller.find((r) => r.mine) ?? null,
  };
}

export interface ScorecardRow {
  board: number;
  result: BoardResult;
  /** Score from the viewer's own side, split into the two columns a card has. */
  weScore: number | null;
  theyScore: number | null;
  wePercent: number;
  theyPercent: number;
}

/** Which pair this player belongs to, or null if they are not in the draw. */
export function pairOf(state: TState, playerId: string): number | null {
  for (const [i, pair] of state.config.pairs.entries()) {
    if (pair.players.some((p) => p.id === playerId)) return i;
  }
  return null;
}

export const pairAt = (state: TState, index: number): Pair | undefined => state.config.pairs[index];

/**
 * The player's own card: a line per board they played, scored from their side.
 * A positive score goes in "we" and a negative one in "they", the way a
 * scorecard is kept, so the columns can be read down at a glance.
 */
export function scorecard(state: TState, myPair: number | null): ScorecardRow[] {
  if (myPair === null) return [];
  const out: ScorecardRow[] = [];
  const boards = [...new Set(state.results.map((r) => r.board))].sort((a, b) => a - b);
  for (const board of boards) {
    const review = reviewBoard(state, board, myPair);
    const own = review.own;
    if (!own) continue;
    const weAreNS = own.result.nsPair === myPair;
    const ourScore = weAreNS ? own.result.nsScore : -own.result.nsScore;
    const ourMp = weAreNS ? own.nsMatchpoints : own.top - own.nsMatchpoints;
    const pct = own.top === 0 ? 50 : Math.round((ourMp / own.top) * 1000) / 10;
    out.push({
      board,
      result: own.result,
      weScore: ourScore > 0 ? ourScore : null,
      theyScore: ourScore < 0 ? -ourScore : null,
      wePercent: pct,
      theyPercent: Math.round((100 - pct) * 10) / 10,
    });
  }
  return out;
}

/** The player's overall percentage across the boards on their card. */
export function cardTotal(rows: ScorecardRow[]): { we: number; they: number } {
  if (rows.length === 0) return { we: 0, they: 0 };
  const we = rows.reduce((a, r) => a + r.wePercent, 0) / rows.length;
  return { we: Math.round(we * 10) / 10, they: Math.round((100 - we) * 10) / 10 };
}
