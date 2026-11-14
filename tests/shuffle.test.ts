import { describe, expect, it } from 'vitest';
import { dealBoard } from '../src/engine/deal';
import { SEATS, cardSuit, hcp, type Seat } from '../src/engine/cards';

/* A tournament's seed is a SHA-256 of its issue, start moment and field,
   cut to 24 hex characters. These stand in for a few thousand of them. */
const seeds = Array.from({ length: 4000 }, (_, i) =>
  [...`t${i}`].reduce((a, c) => a + c.charCodeAt(0).toString(16), '').padEnd(24, '0').slice(0, 24));

describe('the deals', () => {
  it('never repeats a board across tournaments, nor within one', () => {
    const seen = new Map<string, string>();
    for (const s of seeds.slice(0, 1500)) {
      for (let b = 1; b <= 8; b++) {
        const key = JSON.stringify(dealBoard(s, b));
        const was = seen.get(key);
        expect(was, `${s} board ${b} repeats ${was}`).toBeUndefined();
        seen.set(key, `${s}#${b}`);
      }
    }
    expect(seen.size).toBe(1500 * 8);
  });

  it('deals every card exactly once, thirteen to a hand', () => {
    for (const s of seeds.slice(0, 200)) {
      const hands = dealBoard(s, 1);
      const all = SEATS.flatMap((x) => hands[x]);
      expect(new Set(all).size).toBe(52);
      for (const seat of SEATS) expect(hands[seat]).toHaveLength(13);
    }
  });

  it('spreads the points as a fair shuffle does', () => {
    const points: number[] = [];
    const bySeat: Record<Seat, number> = { N: 0, E: 0, S: 0, W: 0 };
    const shapes = new Map<string, number>();
    let n = 0;
    for (const s of seeds) {
      for (let b = 1; b <= 4; b++) {
        const hands = dealBoard(s, b);
        for (const seat of SEATS) {
          const hand = hands[seat];
          const p = hcp(hand);
          points.push(p);
          bySeat[seat] += p;
          const shape = ['S', 'H', 'D', 'C'].map((x) => hand.filter((c) => cardSuit(c) === x).length).sort((a, c) => c - a).join('');
          shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
          n++;
        }
      }
    }
    const mean = points.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(points.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const pct = (shape: string) => (100 * (shapes.get(shape) ?? 0)) / n;
    console.log(`hands: ${n}; mean HCP ${mean.toFixed(3)} (theory 10); sd ${sd.toFixed(3)} (theory 4.13)`);
    console.log('by seat:', SEATS.map((x) => `${x} ${(bySeat[x] / (n / 4)).toFixed(3)}`).join('  '));
    console.log('shapes:', ['4432', '5332', '5431', '5422', '4333', '6322', '6421', '7222']
      .map((x) => `${x} ${pct(x).toFixed(2)}%`).join('  '));
    /* The theoretical figures, with room for the noise of a sample this size. */
    expect(mean).toBeGreaterThan(9.85); expect(mean).toBeLessThan(10.15);
    expect(sd).toBeGreaterThan(4.0); expect(sd).toBeLessThan(4.25);
    expect(pct('4432')).toBeGreaterThan(20.5); expect(pct('4432')).toBeLessThan(22.6);
    expect(pct('5332')).toBeGreaterThan(14.5); expect(pct('5332')).toBeLessThan(16.5);
    expect(pct('4333')).toBeGreaterThan(9.5); expect(pct('4333')).toBeLessThan(11.6);
    expect(pct('7222')).toBeLessThan(1.0);
    for (const seat of SEATS) expect(Math.abs(bySeat[seat] / (n / 4) - 10)).toBeLessThan(0.25);
  });

  it('puts no card in the same place twice: every seat holds every card about as often', () => {
    const where: number[][] = Array.from({ length: 52 }, () => [0, 0, 0, 0]);
    for (const s of seeds) {
      const hands = dealBoard(s, 1);
      SEATS.forEach((seat, i) => { for (const c of hands[seat]) (where[c] as number[])[i]++; });
    }
    const want = seeds.length / 4;
    const worst = Math.max(...where.flatMap((row) => row.map((x) => Math.abs(x - want) / want)));
    console.log(`worst card/seat deviation: ${(worst * 100).toFixed(1)}% of expected (${want} each)`);
    expect(worst).toBeLessThan(0.25);
  });
});
