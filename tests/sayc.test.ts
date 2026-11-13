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
    ['K52.Q842.AK2.932', '1H P', '2C', 'invitational with support: a new suit first, on three cards if need be'],
    ['J52.Q842.7632.93', '1H P', '3H', 'weak jump raise: four trumps, under 6 points'],
    ['J52.Q842.763.932', '1H P', 'Pass', 'four trumps but no shape'],
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

/* ------------------------------------------------------------------ 2/1 */

import { planConfig } from '../src/tournament/plan';
import { reduce } from '../src/tournament/state';
import { issueBody, makeMeta, parseMeta } from '../src/directory/github';

describe('two-over-one', () => {
  const bid21 = (text: string, calls: string, sys: '2/1' | 'sayc' = '2/1'): string => {
    let a: AuctionState = newAuction('N');
    for (const c of calls.split(' ').filter(Boolean)) a = applyCall(a, currentBidder(a), parseCall(c));
    return callToString(chooseSayc(hand(text), a, currentBidder(a), sys).call);
  };
  const whole = (hands: Record<Seat, Card[]>, sys: '2/1' | 'sayc'): AuctionState => {
    let a: AuctionState = newAuction('N');
    for (let i = 0; i < 40 && !isAuctionOver(a); i++) { const s = currentBidder(a); a = applyCall(a, s, chooseSayc(hands[s], a, s, sys).call); }
    return a;
  };
  const text = (a: AuctionState): string => a.calls.map((e) => callToString(e.call)).join(' ');

  it('needs game values for a new suit at the two level; lesser hands go through a forcing no-trump', () => {
    const eleven = 'K5.42.AJ2.Q98432';      // 10 points, six clubs
    expect(bid21(eleven, '1S P', 'sayc')).toBe('2C');
    expect(bid21(eleven, '1S P')).toBe('1N');
    expect(bid21('K5.42.AJ2.KQ9432', '1S P')).toBe('2C');           // 13: game forcing
    expect(readAuction(((): AuctionState => { let a = newAuction('N'); for (const c of ['1S', 'P', '2C']) a = applyCall(a, currentBidder(a), parseCall(c)); return a; })(), '2/1').says[2]).toMatch(/Game forcing/);
  });

  it('opener may not pass the forcing no-trump', () => {
    const flat = 'AQ752.K4.Q62.J93';        // 12, 5-3-3-2: passes 1NT in Standard American
    expect(bid21(flat, '1S P 1N P', 'sayc')).toBe('Pass');
    expect(bid21(flat, '1S P 1N P')).toBe('2C');
    expect(bid21('AQ752.K4.QJ62.93', '1S P 1N P')).toBe('2D');
    expect(bid21('AQ7522.K4.Q62.J9', '1S P 1N P')).toBe('2S');
  });

  it('invitational raises go through the forcing no-trump, with three trumps or four', () => {
    const three = 'K52.Q84.AJ72.J32';       // 11 with three spades
    expect(bid21(three, '1S P', 'sayc')).toBe('2D');               // Standard American: a new suit, then raise
    expect(bid21(three, '1S P')).toBe('1N');
    expect(bid21(three, '1S P 1N P 2C P')).toBe('3S');             // then the invitation
    const four = 'K852.Q8.AJ72.932';        // 10 with four spades
    expect(bid21(four, '1S P')).toBe('1N');
    expect(bid21(four, '1S P 1N P 2C P')).toBe('3S');
  });

  it('is off after an overcall or by a passed hand', () => {
    const cards = 'K5.42.AJ2.Q98432';
    expect(bid21(cards, 'P P 1S P')).toBe(bid21(cards, 'P P 1S P', 'sayc'));
    expect(bid21('K5.42.AJ2.KQ9432', '1S 2H')).toBe(bid21('K5.42.AJ2.KQ9432', '1S 2H', 'sayc'));
  });

  it('never stops short of game once a two-over-one has been bid', () => {
    for (let b = 1; b <= 600; b++) {
      const hands = dealBoard('gf-sweep', b);
      /* North deals; rotate so every deal is tried with North opening if it can. */
      const a = whole(hands, '2/1');
      const told = readAuction(a, '2/1');
      const i = a.calls.findIndex((e, k) => /Game forcing/.test(told.says[k] ?? '') && e.call.type === 'bid');
      if (i < 0) continue;
      const theyBid = a.calls.slice(i).some((e) => e.call.type !== 'pass' && ['N', 'S'].includes(e.seat) !== ['N', 'S'].includes(a.calls[i]!.seat));
      if (theyBid) continue;
      const c = finalContract(a)!;
      const game = c.level >= (c.strain === 'N' ? 3 : c.strain === 'H' || c.strain === 'S' ? 4 : 5);
      expect(game, `board ${b}: ${text(a)}`).toBe(true);
    }
  });

  it('names the robots for their system and carries it with the tournament', () => {
    const roster = [{ id: 'a', name: 'Ann', joinedAt: 1 }, { id: 'b', name: 'Bob', joinedAt: 2 }];
    const cfg = planConfig({ id: 'x', name: 'X', seed: 's', roster, boardsPerRound: 1, rounds: 1, robots: '2/1' });
    expect(cfg.robots).toBe('2/1');
    expect(cfg.pairs.flatMap((p) => p.players).filter((p) => p.bot).every((p) => p.name.startsWith('Robot 2/1 '))).toBe(true);
    const sayc = planConfig({ id: 'x', name: 'X', seed: 's', roster, boardsPerRound: 1, rounds: 1 });
    expect(sayc.robots).toBeUndefined();
    expect(sayc.pairs.flatMap((p) => p.players).filter((p) => p.bot).every((p) => p.name.startsWith('Robot SAYC '))).toBe(true);
    /* A robot that takes over a seat is named for the system too. */
    let s = reduce(null, { t: 'start', config: cfg });
    s = reduce(s, { t: 'retire', playerId: 'a' });
    expect(s.tables.flatMap((t) => Object.values(t.seats)).some((p) => p.name === 'Robot 2/1 for Ann')).toBe(true);

    const meta = makeMeta({ name: 'T', director: 'Ido', start: '2030-01-01T19:30', timeZone: 'UTC', capacity: 16, rounds: 1, boardsPerRound: 2, levels: ['Expert'], robots: '2/1' } as never);
    expect(issueBody(meta)).toContain('| **Robots** | 2/1 |');
    expect(parseMeta(issueBody(meta))!.robots).toBe('2/1');
    expect(parseMeta(issueBody({ ...meta, robots: undefined }))!.robots).toBeUndefined();
  });
});

describe('SAYC: jump raises are weak', () => {
  const at = (text: string, calls: string): ReturnType<typeof chooseSayc> => {
    let a: AuctionState = newAuction('N');
    for (const c of calls.split(' ').filter(Boolean)) a = applyCall(a, currentBidder(a), parseCall(c));
    return chooseSayc(hand(text), a, currentBidder(a));
  };

  it('alerts the jump raise as weak, and opener does not take it for an invitation', () => {
    const raise = at('J52.Q842.7632.93', '1H P');
    expect(callToString(raise.call)).toBe('3H');
    expect(raise.alert).toBe(true);
    expect(raise.says).toMatch(/Weak jump raise.*fewer than 6/);
    expect(callToString(at('AK3.KJ975.A4.Q72', '1H P 3H P').call)).toBe('Pass');      // 17: would have accepted a limit raise
    expect(callToString(at('AK3.AKJ75.A4.Q72', '1H P 3H P').call)).toBe('4H');        // 21: bids game anyway
  });

  it('the invitational hand bids a new suit, then raises to invite', () => {
    const inv = 'K52.Q842.AK2.932';      // 12 with four hearts
    expect(callToString(at(inv, '1H P').call)).toBe('2C');
    expect(callToString(at(inv, '1H P 2C P 2H P').call)).toBe('3H');
    expect(at(inv, '1H P 2C P 2H P').says).toMatch(/Invites game/);
    /* Opener accepts with a little extra and declines with a bare minimum. */
    expect(callToString(at('AJ3.KJ975.Q4.K72', '1H P 2C P 2H P 3H P').call)).toBe('4H');
    expect(callToString(at('QJ3.KJ975.Q4.K72', '1H P 2C P 2H P 3H P').call)).toBe('Pass');
  });

  it('the same in a minor, and when the opponents have come in', () => {
    expect(callToString(at('52.842.73.QJ9532', '1C P').call)).toBe('3C');
    expect(callToString(at('J52.Q842.7632.93', '1H 1S').call)).toBe('3H');
    expect(at('J52.Q842.7632.93', '1H 1S').says).toMatch(/Weak jump raise/);
  });

  it('two-over-one jump raises are weak too', () => {
    let a: AuctionState = newAuction('N');
    for (const c of ['1H', 'P']) a = applyCall(a, currentBidder(a), parseCall(c));
    const r = chooseSayc(hand('J52.Q842.7632.93'), a, 'S', '2/1');
    expect(callToString(r.call)).toBe('3H');
    expect(r.says).toMatch(/Weak jump raise/);
    expect(r.alert).toBe(true);
    /* Twelve with four trumps and no suit: invitational, so through the forcing no-trump. */
    expect(callToString(chooseSayc(hand('K52.Q842.AK2.932'), a, 'S', '2/1').call)).toBe('1N');
  });
});

describe('a raise is a jump only when the suit could have been bid lower', () => {
  const at = (text: string, calls: string, sys: '2/1' | 'sayc' = 'sayc'): ReturnType<typeof chooseSayc> => {
    let a: AuctionState = newAuction('N');
    for (const c of calls.split(' ').filter(Boolean)) a = applyCall(a, currentBidder(a), parseCall(c));
    return chooseSayc(hand(text), a, currentBidder(a), sys);
  };
  const weak = 'J52.Q842.7632.93';   // 4 points, four hearts
  const fair = 'K52.Q842.K632.93';   // 9 points, four hearts

  it('3♥ over their 2♠ is the cheapest raise, so it is the ordinary one', () => {
    /* Nothing below 3♥ exists, so a weak hand cannot say "weak" there … */
    const r = at(weak, '1H 2S');
    expect(callToString(r.call)).toBe('Pass');
    /* … and the honest raise keeps its own meaning, unalerted. */
    const good = at(fair, '1H 2S');
    expect(callToString(good.call)).toBe('3H');
    expect(good.says).toMatch(/Raise: support for hearts, 6–10 points/);
    expect(good.alert).toBe(false);
    /* Four trumps are worth the three level, which is already taken, so a
       weak hand has nothing to say: it does not leap to four. */
    expect(callToString(at('J52.Q8432.763.92', '1H 2S').call)).toBe('Pass');
  });

  it('3♥ over their 2♦ is a level higher than needed, so it is the weak jump raise', () => {
    const r = at(weak, '1H 2D');
    expect(callToString(r.call)).toBe('3H');
    expect(r.says).toMatch(/Weak jump raise/);
    expect(r.alert).toBe(true);
    /* The sound hand takes the cheapest raise instead. */
    expect(callToString(at(fair, '1H 2D').call)).toBe('2H');
  });

  it('holds for 1♠ overcalls too: the raise follows whatever they bid', () => {
    /* Partner overcalled 1♠ and they bid 3♦: 3♠ is now the cheapest raise. */
    const plain = at('Q842.J52.7632.93', 'P 1H 1S 3D');
    expect(callToString(plain.call)).toBe('Pass');            // 3 points: not enough for a 3♠ raise
    const sound = at('Q842.K52.K63.932', 'P 1H 1S 3D');
    expect(callToString(sound.call)).toBe('3S');
    expect(sound.says).toMatch(/Raise: three or more spades, 6–10 points/);
    expect(sound.alert).toBe(false);
    /* With only 2♦ bid, 3♠ is a genuine jump and shows a weak hand. */
    const jump = at('Q842.J52.7632.93', 'P 1H 1S 2D');
    expect(callToString(jump.call)).toBe('3S');
    expect(jump.says).toMatch(/Weak jump raise/);
    expect(jump.alert).toBe(true);
  });

  it('reads the same way in two-over-one', () => {
    expect(at(fair, '1H 2S', '2/1').alert).toBe(false);
    expect(at(weak, '1H 2D', '2/1').says).toMatch(/Weak jump raise/);
  });
});
