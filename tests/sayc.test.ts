import { describe, expect, it } from 'vitest';
import { SEATS, hcp, makeCard, nextSeat, partnerOf, type Card, type Seat, type Suit } from '../src/engine/cards';
import { applyCall, callToString, currentBidder, finalContract, isAuctionOver, newAuction, parseCall, type AuctionState } from '../src/engine/bidding';
import { dealBoard, dealerForBoard } from '../src/engine/deal';
import { chooseSayc, readAuction } from '../src/engine/sayc';

/** "AKQ32.K5.Q76.J32" — spades, hearts, diamonds, clubs. */
function hand(text: string): Card[] {
  const suits: Suit[] = ['S', 'H', 'D', 'C'];
  const out: Card[] = [];
  text.split('.').forEach((holding, i) => {
    for (const ch of holding) out.push(makeCard(suits[i] as Suit, '23456789TJQKA'.indexOf(ch) + 2));
  });
  if (out.length !== 13) throw new Error(`${text} has ${out.length} cards`);
  return out;
}

/** The auction so far, North dealing, then what the next hand calls. */
function bid(text: string, calls: string): string {
  let a: AuctionState = newAuction('N');
  for (const c of calls.split(' ').filter(Boolean)) a = applyCall(a, currentBidder(a), parseCall(c));
  return callToString(chooseSayc(hand(text), a, currentBidder(a)).call);
}

describe('SAYC: opening', () => {
  it.each([
    ['AQ5.KJ4.QJ62.K93', '1N', '16, balanced'],
    ['AK5.KQ4.QJ62.K93', '1D', '18, balanced: too strong for 1NT'],
    ['AKJ52.Q4.K62.J93', '1S', 'five-card major'],
    ['AK52.Q4.K62.J932', '1C', 'no five-card major: longer minor'],
    ['AK52.QJ4.K62.J93', '1C', '3-3 in the minors'],
    ['AK5.Q94.K862.J93', '1D', 'four diamonds'],
    ['AKQJ5.AK4.AQ2.93', '2C', '23 points'],
    ['AK5.KQ4.AJ62.KJ3', '2N', '21, balanced'],
    ['KQJ952.84.762.93', '2S', 'weak two'],
    ['52.84.KQJ9762.93', '3D', 'seven-card pre-empt'],
    ['K52.Q84.J762.932', 'Pass', 'six points'],
    ['A52.Q84.K762.Q32', 'Pass', 'eleven, flat'],
  ])('%s opens %s (%s)', (cards, call) => {
    expect(bid(cards, '')).toBe(call);
  });
});

describe('SAYC: answering one no-trump', () => {
  it.each([
    ['KJ52.Q84.762.932', 'Pass'],
    ['KJ52.Q84.A62.932', '2C'],       // Stayman
    ['KJ952.84.762.932', '2H'],       // transfer to spades, however weak
    ['84.KJ952.762.932', '2D'],       // transfer to hearts
    ['K52.Q84.K72.9432', '2N'],       // 8: invites
    ['K52.Q84.AJ2.9432', '3N'],       // 10
    ['K52.AQ4.AJ2.K432', '4N'],       // 17: invites slam
  ])('%s over 1NT bids %s', (cards, call) => {
    expect(bid(cards, '1N P')).toBe(call);
  });

  it('opener answers Stayman and completes transfers', () => {
    expect(bid('AQ5.KJ42.QJ6.K93', '1N P 2C P')).toBe('2H');
    expect(bid('AQ52.KJ4.QJ6.K93', '1N P 2C P')).toBe('2S');
    expect(bid('AQ5.KJ4.QJ62.K93', '1N P 2C P')).toBe('2D');
    expect(bid('AQ5.KJ4.QJ62.K93', '1N P 2D P')).toBe('2H');
    expect(bid('AQ5.KJ4.QJ62.K93', '1N P 2H P')).toBe('2S');
  });
});

describe('SAYC: answering one of a suit', () => {
  it.each([
    ['K52.Q842.762.932', '1H P', 'Pass', 'five points'],
    ['K52.Q842.A62.932', '1H P', '2H', 'simple raise'],
    ['K52.Q842.AK2.932', '1H P', '3H', 'limit raise'],
    ['K52.KQ42.AK2.932', '1H P', '2N', 'Jacoby'],
    ['KQ52.42.A62.9432', '1H P', '1S', 'four spades at the one level'],
    ['K52.42.KJ2.Q9432', '1H P', '1N', 'no fit, no suit at the one level'],
    ['K5.42.AJ2.KQ9432', '1H P', '2C', 'two over one with 13'],
    ['K52.KJ84.762.932', '1C 1S', 'X', 'negative double: four hearts'],
    ['K52.KJ84.762.932', '1C P', '1H', 'the same hand without the overcall'],
  ])('%s after %s bids %s (%s)', (cards, auction, call) => {
    expect(bid(cards, auction)).toBe(call);
  });
});

describe('SAYC: when they open', () => {
  it.each([
    ['AKJ52.84.762.K32', '1D', '1S', 'overcall'],
    ['AJ52.KQ84.2.K932', '1D', 'X', 'take-out double'],
    ['AQ5.KJ4.KJ62.Q93', '1D', '1N', '16 with a stopper'],
    ['K52.Q84.J762.932', '1D', 'Pass', 'nothing'],
    ['KQJ952.84.762.93', '1D', '2S', 'weak jump overcall'],
    ['J52.Q842.762.932', '1D X P', '1H', 'partner doubled: bid the best suit, however weak'],
    ['K52.KQ842.Q62.93', '1D X P', '2H', 'jump with 9–11'],
  ])('%s after %s bids %s (%s)', (cards, auction, call) => {
    expect(bid(cards, auction)).toBe(call);
  });
});

describe('SAYC: what the calls show', () => {
  const read = (calls: string) => {
    let a: AuctionState = newAuction('N');
    for (const c of calls.split(' ')) a = applyCall(a, currentBidder(a), parseCall(c));
    return readAuction(a);
  };

  it('reads points and lengths from the calls', () => {
    const r = read('1N P 2H P 2S P');
    expect(r.know.N.hcp).toEqual([15, 17]);
    expect(r.know.S.len.S[0]).toBe(5);            // the transfer showed five spades
    expect(r.says[0]).toMatch(/15–17/);
    expect(r.says[2]).toMatch(/Transfer/);
    expect(read('1S').know.N.len.S[0]).toBe(5);
    expect(read('P 1D X').know.S.hcp[0]).toBeGreaterThanOrEqual(12);
    expect(read('2S').know.N.hcp).toEqual([5, 10]);
  });

  it('has no reading of a call the system would never make, and does not fall over', () => {
    const r = read('1N P 5D P');
    expect(r.says[2]).toBe('');
    expect(r.know.S.hcp).toEqual([0, 37]);
  });
});

describe('SAYC: whole auctions', () => {
  const play = (hands: Record<Seat, Card[]>, dealer: Seat) => {
    let a: AuctionState = newAuction(dealer);
    for (let i = 0; i < 40 && !isAuctionOver(a); i++) {
      const seat = currentBidder(a);
      a = applyCall(a, seat, chooseSayc(hands[seat], a, seat).call);
    }
    return a;
  };
  const text = (a: AuctionState): string => a.calls.map((e) => callToString(e.call)).join(' ');

  it('finds three no-trump through Stayman', () => {
    const a = play({ N: hand('AQ5.KJ4.QJ62.K93'), E: hand('J94.T63.T98.JT84'), S: hand('KT82.Q85.A53.Q72'), W: hand('763.A972.K74.A65') }, 'N');
    expect(text(a)).toBe('1N Pass 2C Pass 2D Pass 3N Pass Pass Pass');
  });

  it('bids game in a major with a fit and the points', () => {
    const a = play({ N: hand('AKJ52.K4.Q62.J93'), E: hand('94.T63.T985.KT84'), S: hand('Q873.A85.AK3.Q72'), W: hand('T6.QJ972.J74.A65') }, 'N');
    expect(finalContract(a)).toMatchObject({ level: 4, strain: 'S' });
  });

  it('every auction ends, legally, and never absurdly high on nothing', () => {
    let silly = 0;
    for (let b = 1; b <= 400; b++) {
      const hands = dealBoard('sayc-sweep', b);
      const a = play(hands, dealerForBoard(b));
      expect(isAuctionOver(a), `board ${b}: ${text(a)}`).toBe(true);
      const c = finalContract(a);
      if (!c) continue;
      const points = hcp(hands[c.declarer]) + hcp(hands[partnerOf(c.declarer)]);
      if (c.level >= 5 && points < 20) silly++;
      if (c.level >= 6) expect(points, `board ${b}: ${text(a)}`).toBeGreaterThanOrEqual(26);
    }
    expect(silly).toBeLessThanOrEqual(2);
    void SEATS; void nextSeat;
  });
});
