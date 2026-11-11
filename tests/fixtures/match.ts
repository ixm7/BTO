/**
 * Sits two robots against each other over a set of boards and reports which
 * played better.
 *
 * Each board is played twice, with the robots swapping directions the second
 * time, exactly as a duplicate pair event does. That cancels out the luck of
 * the deal: a good hand helps whoever holds it, and both robots hold it once.
 * What is left is the difference between the two players.
 */
import { newAuction, applyCall, currentBidder, finalContract, isAuctionOver, type AuctionState, type Call } from '../../src/engine/bidding';
import { dealBoard, dealerForBoard, isVulnerable, vulnerabilityForBoard } from '../../src/engine/deal';
import { applyPlay, isPlayOver, startPlay } from '../../src/engine/play';
import { nsScore } from '../../src/engine/scoring';
import { SEATS, sideOf, type Card, type Seat } from '../../src/engine/cards';

export interface Robot {
  name: string;
  chooseCall(hand: readonly Card[], auction: AuctionState, seat: Seat): Call;
  chooseCard(play: Parameters<typeof applyPlay>[0], seat: Seat): Card;
}

export interface BoardOutcome {
  board: number;
  contract: string;
  declarer: Seat | null;
  nsScore: number;
}

/** Play one board out with a robot in each seat. */
export function playBoard(board: number, seed: string, bots: Record<Seat, Robot>): BoardOutcome {
  const hands = dealBoard(seed, board);
  const dealer = dealerForBoard(board);
  const vul = vulnerabilityForBoard(board);

  let auction: AuctionState = newAuction(dealer);
  let guard = 0;
  while (!isAuctionOver(auction) && guard++ < 400) {
    const seat = currentBidder(auction);
    auction = applyCall(auction, seat, bots[seat].chooseCall(hands[seat], auction, seat));
  }
  const contract = finalContract(auction);
  if (!contract) return { board, contract: 'Passed out', declarer: null, nsScore: 0 };

  let play = startPlay(contract, hands);
  guard = 0;
  while (!isPlayOver(play) && guard++ < 400) {
    const seat = play.turn;
    /* Dummy's cards are chosen by declarer, as at a real table. */
    const chooser = seat === play.dummy ? bots[contract.declarer] : bots[seat];
    play = applyPlay(play, seat, chooser.chooseCard(play, seat));
  }
  return {
    board,
    contract: `${contract.level}${contract.strain}${contract.doubled ? 'x' : ''} by ${contract.declarer}`,
    declarer: contract.declarer,
    nsScore: nsScore(contract, vul, play.declarerTricks),
  };
}

export interface MatchResult {
  boards: number;
  /** Total score to the robot under test, across both seatings of every board. */
  net: number;
  /** Mean IMP swing per board in favour of the robot under test. */
  impsPerBoard: number;
  /** Boards won, tied and lost by the robot under test. */
  won: number;
  tied: number;
  lost: number;
  passedOut: number;
}

/** International Match Point scale, used to size a difference in score. */
const IMP_TABLE = [20, 50, 90, 130, 170, 220, 270, 320, 370, 430, 500, 600, 750, 900, 1100, 1300, 1500, 1750, 2000, 2250, 2500, 3000, 3500, 4000];
export function imps(diff: number): number {
  const a = Math.abs(diff);
  let i = 0;
  while (i < IMP_TABLE.length && a >= (IMP_TABLE[i] as number)) i++;
  return Math.sign(diff) * i;
}

/**
 * `test` and `base` each play both directions on every board. A positive
 * result means `test` scored better than `base` on the same cards.
 */
export function match(test: Robot, base: Robot, boards: number[], seed: string): MatchResult {
  const seatBots = (ns: Robot, ew: Robot): Record<Seat, Robot> =>
    Object.fromEntries(SEATS.map((s) => [s, sideOf(s) === 'NS' ? ns : ew])) as Record<Seat, Robot>;

  let net = 0, totalImps = 0, won = 0, tied = 0, lost = 0, passedOut = 0;
  for (const board of boards) {
    /* Same cards both times; only the seating changes. */
    const asNS = playBoard(board, seed, seatBots(test, base));
    const asEW = playBoard(board, seed, seatBots(base, test));
    if (asNS.declarer === null && asEW.declarer === null) passedOut++;

    /* What the robot under test made holding the North-South cards, against
       what it held the opponents to when it sat the other way. */
    const diff = asNS.nsScore - asEW.nsScore;
    net += diff;
    totalImps += imps(diff);
    if (diff > 0) won++; else if (diff < 0) lost++; else tied++;
  }

  return {
    boards: boards.length, net, won, tied, lost, passedOut,
    impsPerBoard: Math.round((totalImps / boards.length) * 100) / 100,
  };
}

export const boardRange = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i);
export { isVulnerable };
