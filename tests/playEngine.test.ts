import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SEATS, cardSuit, hcp, legalPlays, type Card, type Seat } from '../src/engine/cards';
import { applyCall, currentBidder, finalContract, isAuctionOver, newAuction, type AuctionState } from '../src/engine/bidding';
import { dealBoard, dealerForBoard, seededRandom, vulnerabilityForBoard } from '../src/engine/deal';
import { applyPlay, controllerOf, isDummyVisible, isPlayOver, startPlay, type PlayState } from '../src/engine/play';
import { nsScore } from '../src/engine/scoring';
import * as simple from '../src/engine/bot';
import { makeSolver, type DdsModule, type Solve } from '../src/engine/dds';
import { playHistory, thinkCard } from '../src/engine/playEngine';
import { chooseCall, readAuction, type Shape } from '../src/engine/sayc';
import { imps } from './fixtures/match';

let solve: Solve;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@bridge-tools/dd/wasm/compiled.js');
  const mod = await (require(file) as (o: object) => Promise<DdsModule>)({ locateFile: (f: string) => path.join(path.dirname(file), f), print: () => {}, printErr: () => {} });
  solve = makeSolver(mod);
});

function bidOut(board: number, seed: string): { hands: Record<Seat, Card[]>; a: AuctionState } {
  const hands = dealBoard(seed, board);
  let a = newAuction(dealerForBoard(board));
  while (!isAuctionOver(a)) { const s = currentBidder(a); a = applyCall(a, s, chooseCall(hands[s], a, s)); }
  return { hands, a };
}

describe('the solver', () => {
  it('counts tricks the way the cards say', () => {
    /* Each hand is one whole suit. East leads: in spades North ruffs everything; in no-trump East runs the hearts. */
    const suit = (n: number): Card[] => Array.from({ length: 13 }, (_, i) => n * 13 + i);
    const hands = { N: suit(3), E: suit(2), S: suit(1), W: suit(0) };
    expect(solve(hands, 'S', 'E', []).every((r) => r.tricks === 0)).toBe(true);
    expect(solve(hands, 'N', 'E', []).every((r) => r.tricks === 13)).toBe(true);
  });
});

describe('the robot at the table', () => {
  it('pictures only hands that fit what it can see', () => {
    const { hands, a } = bidOut(3, 'engine');
    const c = finalContract(a)!;
    let p: PlayState = startPlay(c, hands);
    /* Play some tricks with the simple robot to get into the middle of a hand. */
    for (let i = 0; i < 22; i++) p = applyPlay(p, p.turn, simple.chooseCard(p, p.turn));
    const seat = p.turn;
    const viewer = controllerOf(p, seat);
    const history = playHistory(p);
    const pictures: Record<Seat, readonly Card[]>[] = [];
    const spy: Solve = (h, trump, leader, trick) => { pictures.push({ N: [...h.N], E: [...h.E], S: [...h.S], W: [...h.W] }); return solve(h, trump, leader, trick); };
    const t = thinkCard(p, seat, { solve: spy, rng: seededRandom('spy'), maxSamples: 15 });
    expect(legalPlays(p.hands[seat], p.trick)).toContain(t.card);
    if (pictures.length === 0) return; // a forced card needs no thought
    for (const pic of pictures) {
      /* What the robot can see is as it is … */
      expect(pic[viewer]).toEqual(p.hands[viewer]);
      if (isDummyVisible(p)) expect(pic[p.dummy]).toEqual(p.hands[p.dummy]);
      /* … every card is somewhere, once, and each hand is the right size … */
      const all = SEATS.flatMap((s) => pic[s]);
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort((x, y) => x - y)).toEqual(SEATS.flatMap((s) => p.hands[s]).sort((x, y) => x - y));
      for (const s of SEATS) expect(pic[s].length).toBe(p.hands[s].length);
      /* … and nobody holds a suit they have shown out of. */
      for (let i = 0; i + 3 < history.length; i += 4) {
        const led = cardSuit(history[i]!.card);
        for (const tc of history.slice(i, i + 4)) if (cardSuit(tc.card) !== led) expect(pic[tc.seat].some((x) => cardSuit(x) === led)).toBe(false);
      }
    }
  });

  it('believes the bidding when it pictures a hand', () => {
    /* North opened 1NT: every picture West has of North should have 14–18 points. */
    const hands = dealBoard('engine', 3);
    const know = { N: { hcp: [15, 17], len: { C: [2, 5], D: [2, 5], H: [2, 5], S: [2, 5] } } } as unknown as Record<Seat, Shape>;
    const p = startPlay({ level: 1, strain: 'N', declarer: 'N', doubled: 0 }, hands);
    const seen: number[] = [];
    const spy: Solve = (h, trump, leader, trick) => { seen.push(hcp(h.N)); return solve(h, trump, leader, trick); };
    thinkCard(p, 'E', { solve: spy, know, rng: seededRandom('nt'), maxSamples: 8, budgetMs: 20000 });
    expect(seen.length).toBeGreaterThan(0);
    for (const points of seen) { expect(points).toBeGreaterThanOrEqual(14); expect(points).toBeLessThanOrEqual(18); }
  }, 60000);

  it('outplays the simple robot over boards bid the same way', () => {
    const rng = seededRandom('match');
    const strong = (p: PlayState, s: Seat, know: Record<Seat, Shape>): Card => thinkCard(p, s, { solve, know, rng, maxSamples: 8, minSamples: 4, budgetMs: 1500 }).card;
    const weak = (p: PlayState, s: Seat): Card => simple.chooseCard(p, s);
    const playOut = (board: number, nsStrong: boolean): number => {
      const { hands, a } = bidOut(board, 'engine-match');
      const c = finalContract(a);
      if (!c) return 0;
      const know = readAuction(a).know;
      let p = startPlay(c, hands);
      while (!isPlayOver(p)) {
        const s = p.turn;
        const who = controllerOf(p, s);
        const isStrong = (who === 'N' || who === 'S') === nsStrong;
        p = applyPlay(p, s, isStrong ? strong(p, s, know) : weak(p, s));
      }
      return nsScore(c, vulnerabilityForBoard(board), p.declarerTricks);
    };
    let net = 0;
    for (let b = 1; b <= 8; b++) net += imps(playOut(b, true) - playOut(b, false));
    expect(net).toBeGreaterThan(8);
  }, 240000);
});
