import { describe, expect, it } from 'vitest';
import { suitOrder } from '../src/ui/tableView';
import { STRAINS, type Suit } from '../src/engine/cards';

const isRed = (s: Suit): boolean => s === 'H' || s === 'D';

describe('suitOrder', () => {
  it('defaults to spades, hearts, clubs, diamonds', () => {
    expect(suitOrder()).toEqual(['S', 'H', 'C', 'D']);
    expect(suitOrder('N')).toEqual(['S', 'H', 'C', 'D']);
  });

  it('puts the trump suit first', () => {
    for (const trump of ['C', 'D', 'H', 'S'] as const) {
      expect(suitOrder(trump)[0]).toBe(trump);
    }
  });

  it('never places two suits of the same colour side by side', () => {
    for (const strain of STRAINS) {
      const order = suitOrder(strain);
      for (let i = 1; i < order.length; i++) {
        expect(isRed(order[i])).not.toBe(isRed(order[i - 1]));
      }
    }
  });

  it('always lists all four suits exactly once', () => {
    for (const strain of [undefined, ...STRAINS]) {
      expect([...suitOrder(strain)].sort()).toEqual(['C', 'D', 'H', 'S']);
    }
  });
});
