/** Core card / seat primitives. Everything here is pure and serialisable. */

export const SEATS = ['N', 'E', 'S', 'W'] as const;
export type Seat = (typeof SEATS)[number];
export type Side = 'NS' | 'EW';

/** Suits in ascending bridge order. */
export const SUITS = ['C', 'D', 'H', 'S'] as const;
export type Suit = (typeof SUITS)[number];
/** Strains in ascending bidding order. */
export const STRAINS = ['C', 'D', 'H', 'S', 'N'] as const;
export type Strain = (typeof STRAINS)[number];

/** A card is a number 0..51: suitIndex * 13 + (rank - 2). Rank 14 = Ace. */
export type Card = number;

export const RANK_CHARS = '23456789TJQKA';
export const SUIT_SYMBOLS: Record<Strain, string> = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' };

export const makeCard = (suit: Suit, rank: number): Card => SUITS.indexOf(suit) * 13 + (rank - 2);
export const cardSuit = (c: Card): Suit => SUITS[Math.floor(c / 13)] as Suit;
export const cardRank = (c: Card): number => (c % 13) + 2;
export const rankChar = (c: Card): string => RANK_CHARS.charAt(c % 13);
export const cardName = (c: Card): string => cardSuit(c) + rankChar(c);
export const cardLabel = (c: Card): string => (rankChar(c) === 'T' ? '10' : rankChar(c)) + SUIT_SYMBOLS[cardSuit(c)];

export const seatIndex = (s: Seat): number => SEATS.indexOf(s);
export const nextSeat = (s: Seat): Seat => SEATS[(seatIndex(s) + 1) % 4] as Seat;
export const leftOf = nextSeat;
export const partnerOf = (s: Seat): Seat => SEATS[(seatIndex(s) + 2) % 4] as Seat;
export const sideOf = (s: Seat): Side => (s === 'N' || s === 'S' ? 'NS' : 'EW');
export const otherSide = (s: Side): Side => (s === 'NS' ? 'EW' : 'NS');

export const isCard = (x: unknown): x is Card => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 52;

/** Display order: spades first, then hearts, diamonds, clubs; high to low inside a suit. */
export function sortForDisplay(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => {
    const sa = Math.floor(a / 13);
    const sb = Math.floor(b / 13);
    return sa !== sb ? sb - sa : b - a;
  });
}

/** High-card points: A=4 K=3 Q=2 J=1. */
export function hcp(cards: readonly Card[]): number {
  let total = 0;
  for (const c of cards) {
    const r = cardRank(c);
    if (r >= 11) total += r - 10;
  }
  return total;
}

export function suitLengths(cards: readonly Card[]): Record<Suit, number> {
  const out: Record<Suit, number> = { C: 0, D: 0, H: 0, S: 0 };
  for (const c of cards) out[cardSuit(c)]++;
  return out;
}

/** The cards a player may legally play from `hand` to a trick already holding `trick`. */
export function legalPlays(hand: readonly Card[], trick: readonly { seat: Seat; card: Card }[]): Card[] {
  if (trick.length === 0 || trick.length === 4) return [...hand];
  const led = cardSuit((trick[0] as { card: Card }).card);
  const follow = hand.filter((c) => cardSuit(c) === led);
  return follow.length > 0 ? follow : [...hand];
}
