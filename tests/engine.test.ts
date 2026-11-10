import { describe, expect, it } from 'vitest';
import { SEATS, cardName, makeCard, type Card, type Seat } from '../src/engine/cards';
import { applyCall, finalContract, illegalReason, isAuctionOver, isPassedOut, legalCalls, newAuction, parseCall, type AuctionState, type Contract } from '../src/engine/bidding';
import { dealBoard, dealerForBoard, vulnerabilityForBoard } from '../src/engine/deal';
import { applyPlay, illegalPlayReason, isPlayOver, startPlay, trickWinner } from '../src/engine/play';
import { declarerScore, matchpoints, nsScore } from '../src/engine/scoring';
import { chooseCall, chooseCard } from '../src/engine/bot';
import { currentBidder } from '../src/engine/bidding';

function auction(dealer: Seat, calls: string): AuctionState {
  let a = newAuction(dealer);
  for (const c of calls.split(/\s+/).filter(Boolean)) a = applyCall(a, currentBidder(a), parseCall(c));
  return a;
}
const k = (level: number, strain: Contract['strain'], doubled: 0 | 1 | 2 = 0): Contract => ({ level, strain, declarer: 'S', doubled });

describe('deal', () => {
  it('deals 52 distinct cards, 13 each, deterministically', () => {
    const h = dealBoard('seed', 7);
    const all = SEATS.flatMap((s) => h[s]);
    expect(new Set(all).size).toBe(52);
    for (const s of SEATS) expect(h[s]).toHaveLength(13);
    expect(dealBoard('seed', 7)).toEqual(h);
    expect(dealBoard('seed', 8)).not.toEqual(h);
    expect(dealBoard('other', 7)).not.toEqual(h);
  });
  it('rotates dealer and vulnerability like real boards', () => {
    expect([1, 2, 3, 4, 5].map(dealerForBoard)).toEqual(['N', 'E', 'S', 'W', 'N']);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 13, 16, 17].map(vulnerabilityForBoard))
      .toEqual(['None', 'NS', 'EW', 'Both', 'NS', 'EW', 'Both', 'None', 'Both', 'EW', 'None']);
  });
});

describe('bidding', () => {
  it('ends after four passes (passed out)', () => {
    const a = auction('N', 'P P P');
    expect(isAuctionOver(a)).toBe(false);
    const b = auction('N', 'P P P P');
    expect(isAuctionOver(b)).toBe(true);
    expect(isPassedOut(b)).toBe(true);
    expect(finalContract(b)).toBeNull();
  });
  it('does not end after only three passes following an opening pass round', () => {
    expect(isAuctionOver(auction('N', 'P P P 1C P P'))).toBe(false);
    expect(isAuctionOver(auction('N', 'P P P 1C P P P'))).toBe(true);
  });
  it('rejects insufficient bids and out-of-turn calls', () => {
    const a = auction('N', '1H');
    expect(illegalReason(a, 'E', parseCall('1D'))).toMatch(/higher/);
    expect(illegalReason(a, 'E', parseCall('1H'))).toMatch(/higher/);
    expect(illegalReason(a, 'E', parseCall('1S'))).toBeNull();
    expect(illegalReason(a, 'S', parseCall('1S'))).toMatch(/turn/);
  });
  it('enforces double and redouble rules', () => {
    expect(illegalReason(newAuction('N'), 'N', parseCall('X'))).not.toBeNull();
    const a = auction('N', '1H');
    expect(illegalReason(a, 'E', parseCall('X'))).toBeNull();
    expect(illegalReason(a, 'E', parseCall('XX'))).not.toBeNull();
    const b = auction('N', '1H P');
    expect(illegalReason(b, 'S', parseCall('X'))).toMatch(/own side/);
    const c = auction('N', '1H X');
    expect(illegalReason(c, 'S', parseCall('XX'))).toBeNull();
    expect(illegalReason(c, 'S', parseCall('X'))).not.toBeNull();
    const d = auction('N', '1H X P');
    expect(illegalReason(d, 'W', parseCall('XX'))).not.toBeNull(); // W's side made the double
    const e = auction('N', '1H X P P');
    expect(illegalReason(e, 'N', parseCall('XX'))).toBeNull();
    const f = auction('N', '1H X XX');
    expect(illegalReason(f, 'W', parseCall('X'))).not.toBeNull();
    expect(illegalReason(f, 'W', parseCall('1S'))).toBeNull();
  });
  it('a new bid clears the double', () => {
    const a = auction('N', '1H X 2H P P P');
    expect(finalContract(a)).toEqual({ level: 2, strain: 'H', declarer: 'N', doubled: 0 });
  });
  it('declarer is the first of the side to name the strain', () => {
    const a = auction('N', '1S P 2H P 3H P 4S P P P');
    expect(finalContract(a)).toMatchObject({ level: 4, strain: 'S', declarer: 'N' });
    const b = auction('N', '1C 1H 1N P 3N P P P');
    expect(finalContract(b)).toMatchObject({ level: 3, strain: 'N', declarer: 'S' });
    const c = auction('E', '1H 1N P 2H P 2N X XX P P P');
    // South bid NT first for NS; hearts were named by East first but NS play NT.
    expect(finalContract(c)).toEqual({ level: 2, strain: 'N', declarer: 'S', doubled: 2 });
  });
  it('lists 35 bids plus pass at the start, and nothing above 7NT', () => {
    expect(legalCalls(newAuction('N'))).toHaveLength(36);
    expect(legalCalls(auction('N', '7N')).map((c) => c.type).sort()).toEqual(['double', 'pass']);
  });
});

describe('scoring', () => {
  const cases: [Contract, boolean, number, number][] = [
    [k(1, 'N'), false, 7, 90], [k(1, 'N'), false, 9, 150], [k(2, 'H'), false, 8, 110], [k(3, 'N'), false, 9, 400],
    [k(3, 'N'), true, 9, 600], [k(3, 'N'), true, 10, 630], [k(4, 'S'), false, 10, 420], [k(4, 'S'), true, 11, 650],
    [k(5, 'C'), false, 11, 400], [k(5, 'D'), true, 11, 600], [k(2, 'C'), false, 10, 130], [k(3, 'D'), false, 9, 110],
    [k(6, 'N'), false, 12, 990], [k(6, 'N'), true, 12, 1440], [k(6, 'S'), true, 13, 1460], [k(7, 'N'), true, 13, 2220],
    [k(7, 'C'), false, 13, 1440], [k(6, 'C'), false, 12, 920],
    [k(2, 'H', 1), false, 8, 470], [k(2, 'H', 1), true, 8, 670], [k(2, 'H', 1), false, 9, 570], [k(2, 'H', 1), true, 10, 1070],
    [k(1, 'N', 1), false, 7, 180], [k(1, 'N', 2), false, 7, 560], [k(1, 'N', 2), true, 8, 1160], [k(2, 'C', 1), false, 8, 180],
    [k(2, 'C', 2), true, 8, 760], [k(4, 'S', 1), true, 10, 790], [k(4, 'H', 2), false, 10, 880], [k(3, 'N', 1), false, 9, 550],
    [k(3, 'N'), false, 8, -50], [k(3, 'N'), true, 6, -300], [k(4, 'S', 1), false, 9, -100], [k(4, 'S', 1), false, 8, -300],
    [k(4, 'S', 1), false, 7, -500], [k(4, 'S', 1), false, 6, -800], [k(4, 'S', 1), false, 5, -1100], [k(4, 'S', 1), true, 9, -200],
    [k(4, 'S', 1), true, 8, -500], [k(4, 'S', 1), true, 7, -800], [k(4, 'S', 1), true, 6, -1100], [k(4, 'S', 2), false, 8, -600],
    [k(4, 'S', 2), true, 7, -1600], [k(7, 'N', 1), false, 0, -3500], [k(7, 'N', 2), true, 0, -7600],
  ];
  it.each(cases)('%o vul=%s tricks=%i scores %i', (c, vul, tricks, want) => {
    expect(declarerScore(c, vul, tricks)).toBe(want);
  });
  it('reports from the North-South point of view using board vulnerability', () => {
    expect(nsScore({ ...k(4, 'S'), declarer: 'E' }, 'EW', 10)).toBe(-620);
    expect(nsScore({ ...k(4, 'S'), declarer: 'E' }, 'NS', 10)).toBe(-420);
    expect(nsScore({ ...k(4, 'S'), declarer: 'N' }, 'NS', 9)).toBe(-100);
    expect(nsScore(null, 'Both', 0)).toBe(0);
  });
  it('matchpoints: 2 per pair beaten, 1 per tie', () => {
    expect(matchpoints([420, 420, 450, -50])).toEqual({ ns: [3, 3, 6, 0], top: 6 });
    expect(matchpoints([100])).toEqual({ ns: [0], top: 0 });
    expect(matchpoints([0, 0])).toEqual({ ns: [1, 1], top: 2 });
  });
});

describe('play', () => {
  it('picks the trick winner with trumps, overruffs and discards', () => {
    const t = (cards: [Seat, string][]) => cards.map(([seat, n]) => ({ seat, card: makeCard(n[0] as 'S', '23456789TJQKA'.indexOf(n[1] as string) + 2) }));
    expect(trickWinner(t([['N', 'HK'], ['E', 'HA'], ['S', 'H2'], ['W', 'H3']]), 'N')).toBe('E');
    expect(trickWinner(t([['N', 'HK'], ['E', 'SA'], ['S', 'H2'], ['W', 'H3']]), 'N')).toBe('N');
    expect(trickWinner(t([['N', 'HK'], ['E', 'S2'], ['S', 'HA'], ['W', 'H3']]), 'S')).toBe('E');
    expect(trickWinner(t([['N', 'HK'], ['E', 'S2'], ['S', 'S9'], ['W', 'SA']]), 'S')).toBe('W');
    expect(trickWinner(t([['N', 'D2'], ['E', 'CA'], ['S', 'HA'], ['W', 'SA']]), 'C')).toBe('E');
    expect(trickWinner(t([['N', 'D2'], ['E', 'CA'], ['S', 'HA'], ['W', 'D3']]), 'S')).toBe('W');
  });
  it('enforces turn order and following suit', () => {
    const hands = dealBoard('x', 1);
    let p = startPlay({ level: 1, strain: 'N', declarer: 'S', doubled: 0 }, hands);
    expect(p.turn).toBe('W');
    expect(p.dummy).toBe('N');
    expect(illegalPlayReason(p, 'N', hands.N[0] as Card)).toMatch(/turn/);
    expect(illegalPlayReason(p, 'W', hands.N[0] as Card)).toMatch(/not in hand/i);
    const lead = hands.W[0] as Card;
    p = applyPlay(p, 'W', lead);
    const offSuit = hands.N.find((c) => Math.floor(c / 13) !== Math.floor(lead / 13));
    const hasSuit = hands.N.some((c) => Math.floor(c / 13) === Math.floor(lead / 13));
    if (offSuit !== undefined && hasSuit) expect(illegalPlayReason(p, 'N', offSuit)).toMatch(/follow/);
  });
  it('robots can bid and play 200 random boards to completion legally', () => {
    let contracts = 0;
    for (let b = 1; b <= 200; b++) {
      const hands = dealBoard('bots', b);
      let a = newAuction(dealerForBoard(b));
      while (!isAuctionOver(a)) {
        const seat = currentBidder(a);
        a = applyCall(a, seat, chooseCall(hands[seat], a, seat));
      }
      const contract = finalContract(a);
      if (!contract) continue;
      contracts++;
      let p = startPlay(contract, hands);
      while (!isPlayOver(p)) p = applyPlay(p, p.turn, chooseCard(p, p.turn));
      expect(p.declarerTricks + p.defenderTricks).toBe(13);
      expect(SEATS.every((s) => p.hands[s].length === 0)).toBe(true);
    }
    expect(contracts).toBeGreaterThan(120);
    expect(cardName(makeCard('S', 14))).toBe('SA');
  });
});
