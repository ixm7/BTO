/**
 * The double-dummy solver: given all four hands, how many tricks can the side
 * to play still take with each card? This wraps Bo Haglund's DDS, compiled to
 * WebAssembly (the build shipped by @bridge-tools/dd, MIT licence). The
 * compiled module is loaded by whoever calls this — a worker in the browser,
 * `require` in the tests — and handed in, so this file runs anywhere.
 */
import { SEATS, cardRank, cardSuit, makeCard, type Card, type Seat, type Strain, type Suit } from './cards';

/** The part of the compiled module this needs. */
export interface DdsModule {
  _dds_init(): void;
  _dds_solve_board(trump: number, leader: number, s0: number, r0: number, s1: number, r1: number, s2: number, r2: number, deal: number, out: number): number;
  _malloc(n: number): number;
  _free(p: number): void;
  allocateUTF8(s: string): number;
  getValue(p: number, type: string): number;
  setValue(p: number, v: number, type: string): void;
}

export interface Solved { card: Card; tricks: number }

/**
 * Tricks available to the player on turn for each card they could play.
 * `hands` are the cards still held, the current trick's cards already removed;
 * `trick` is what has been played to the trick in progress, in order;
 * `leader` led to it (or is about to).
 */
export type Solve = (hands: Record<Seat, readonly Card[]>, trump: Strain, leader: Seat, trick: readonly Card[]) => Solved[];

const DDS_SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const RANK_CHARS = '23456789TJQKA';

function pbn(hands: Record<Seat, readonly Card[]>): string {
  const one = (h: readonly Card[]): string => DDS_SUITS
    .map((s) => h.filter((c) => cardSuit(c) === s).sort((a, b) => b - a).map((c) => RANK_CHARS.charAt(cardRank(c) - 2)).join(''))
    .join('.');
  return `N:${SEATS.map((s) => one(hands[s])).join(' ')}`;
}

export function makeSolver(m: DdsModule): Solve {
  m._dds_init();
  return (hands, trump, leader, trick) => {
    const deal = m.allocateUTF8(pbn(hands));
    const out = m._malloc(13 * 12);
    for (let i = 0; i < 39; i++) m.setValue(out + i * 4, -1, 'i32');
    const t = (k: number): [number, number] => {
      const c = trick[k];
      return c === undefined ? [0, 0] : [DDS_SUITS.indexOf(cardSuit(c)), cardRank(c)];
    };
    m._dds_solve_board(trump === 'N' ? 4 : DDS_SUITS.indexOf(trump), SEATS.indexOf(leader), ...t(0), ...t(1), ...t(2), deal, out);
    const res: Solved[] = [];
    for (let i = 0; i < 13; i++) {
      const rank = m.getValue(out + i * 12, 'i32');
      const suit = m.getValue(out + i * 12 + 4, 'i32');
      const tricks = m.getValue(out + i * 12 + 8, 'i32');
      if (rank <= 0) break;
      res.push({ card: makeCard(DDS_SUITS[suit] as Suit, rank), tricks });
    }
    m._free(out);
    m._free(deal);
    return res;
  };
}
