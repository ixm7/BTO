import { describe, expect, it } from 'vitest';
import { applyCall, callToString, currentBidder, finalContract, isAuctionOver, newAuction, type AuctionState } from '../src/engine/bidding';
import { dealBoard, dealerForBoard } from '../src/engine/deal';
import { hcp, partnerOf, sideOf, type Seat } from '../src/engine/cards';
import { chooseSayc } from '../src/engine/sayc';

describe('two club auctions, over many deals', () => {
  it('reach a sensible level', () => {
    const seen: string[] = [];
    let below = 0, slamOff = 0;
    for (let b = 1; b <= 800; b++) {
      const deal = dealBoard(`audit-${b}`, b);
      let a: AuctionState = newAuction(dealerForBoard(b));
      for (let i = 0; i < 40 && !isAuctionOver(a); i++) {
        const seat = currentBidder(a);
        a = applyCall(a, seat, chooseSayc(deal[seat], a, seat).call);
      }
      /* A strong two clubs is the opening call, not any two clubs later on. */
      const first = a.calls.find((e) => e.call.type !== 'pass');
      if (!first || first.call.type !== 'bid' || first.call.level !== 2 || first.call.strain !== 'C') continue;
      const k = finalContract(a);
      if (!k) { seen.push('passed out'); continue; }
      /* Only where the strong hand's side bought it: being outbid is another story. */
      if (sideOf(k.declarer) !== sideOf(first.seat)) { seen.push(`outbid: ${k.level}${k.strain} by ${k.declarer}`); continue; }
      const side = [k.declarer, partnerOf(k.declarer)] as Seat[];
      const points = side.reduce((n, s) => n + hcp(deal[s]), 0);
      const isGame = (k.strain === 'N' && k.level >= 3) || (['H', 'S'].includes(k.strain) && k.level >= 4) || k.level >= 5;
      if (!isGame) below++;
      if (k.level >= 6 && points < 30) slamOff++;
      seen.push(`${k.level}${k.strain}${k.doubled ? 'x' : ''} by ${k.declarer} with ${points}`);
    }
    console.log(`2C auctions: ${seen.length}; short of game: ${below}; thin slams: ${slamOff}`);
    console.log(seen.slice(0, 25).join(' | '));
    expect(seen.length).toBeGreaterThan(5);
    expect(below).toBe(0);
    expect(slamOff).toBe(0);
  });
});
