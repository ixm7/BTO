import { cardRank, cardSuit, legalPlays, nextSeat, partnerOf, sideOf, type Card, type Seat } from './cards';
import type { Contract } from './bidding';
import type { Hands } from './deal';

export interface TrickCard {
  seat: Seat;
  card: Card;
}

export interface PlayState {
  contract: Contract;
  dummy: Seat;
  /** Cards still held by each seat. */
  hands: Hands;
  /** Cards on the table for the trick in progress (0-3 cards; a full trick is moved to lastTrick). */
  trick: TrickCard[];
  lastTrick: TrickCard[] | null;
  lastWinner: Seat | null;
  turn: Seat;
  declarerTricks: number;
  defenderTricks: number;
  cardsPlayed: number;
}

export function startPlay(contract: Contract, hands: Hands): PlayState {
  return {
    contract,
    dummy: partnerOf(contract.declarer),
    hands: { N: [...hands.N], E: [...hands.E], S: [...hands.S], W: [...hands.W] },
    trick: [],
    lastTrick: null,
    lastWinner: null,
    turn: nextSeat(contract.declarer),
    declarerTricks: 0,
    defenderTricks: 0,
    cardsPlayed: 0,
  };
}

export const isPlayOver = (p: PlayState): boolean => p.cardsPlayed === 52;
/** Dummy's hand is exposed after the opening lead. */
export const isDummyVisible = (p: PlayState): boolean => p.cardsPlayed >= 1;
/** The seat whose player physically chooses the card (declarer plays dummy's cards). */
export const controllerOf = (p: PlayState, seat: Seat): Seat => (seat === p.dummy ? p.contract.declarer : seat);

export function trickWinner(trick: readonly TrickCard[], trump: string): Seat {
  const first = trick[0] as TrickCard;
  const led = cardSuit(first.card);
  let best = first;
  for (const tc of trick.slice(1)) {
    const s = cardSuit(tc.card);
    const bs = cardSuit(best.card);
    if (s === bs) {
      if (cardRank(tc.card) > cardRank(best.card)) best = tc;
    } else if (s === trump && bs !== trump) {
      best = tc;
    } else if (s === led && bs !== led && bs !== trump) {
      best = tc;
    }
  }
  return best.seat;
}

export function illegalPlayReason(p: PlayState, seat: Seat, card: Card): string | null {
  if (isPlayOver(p)) return 'Play is over';
  if (seat !== p.turn) return 'Not this seat\'s turn to play';
  if (!p.hands[seat].includes(card)) return 'Card not in hand';
  if (!legalPlays(p.hands[seat], p.trick).includes(card)) return 'Must follow suit';
  return null;
}

export function applyPlay(p: PlayState, seat: Seat, card: Card): PlayState {
  const why = illegalPlayReason(p, seat, card);
  if (why) throw new Error(why);
  const hands: Hands = { ...p.hands, [seat]: p.hands[seat].filter((c) => c !== card) };
  const trick = [...p.trick, { seat, card }];
  const next: PlayState = { ...p, hands, trick, cardsPlayed: p.cardsPlayed + 1, turn: nextSeat(seat) };
  if (trick.length === 4) {
    const winner = trickWinner(trick, p.contract.strain);
    next.lastTrick = trick;
    next.lastWinner = winner;
    next.trick = [];
    next.turn = winner;
    if (sideOf(winner) === sideOf(p.contract.declarer)) next.declarerTricks++;
    else next.defenderTricks++;
  }
  return next;
}
