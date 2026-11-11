import { describe, expect, it } from 'vitest';
import { SEATS, cardSuit, makeCard, type Card, type Seat } from '../src/engine/cards';
import { applyPlay, startPlay, type PlayState } from '../src/engine/play';
import type { Contract } from '../src/engine/bidding';
import { chooseCall, chooseCard } from '../src/engine/bot';
import * as baseline from './fixtures/bot-baseline';
import { boardRange, match, type Robot } from './fixtures/match';

const c = makeCard;
type Hands = Record<Seat, Card[]>;

/** Deal thirteen named cards to each seat. */
function deal(h: Record<Seat, Card[]>): Hands {
  for (const s of SEATS) expect(h[s], `${s} has thirteen cards`).toHaveLength(13);
  const all = SEATS.flatMap((s) => h[s]);
  expect(new Set(all).size, 'no card dealt twice').toBe(52);
  return h;
}

const spades = (ranks: number[]) => ranks.map((r) => c('S', r));
const hearts = (ranks: number[]) => ranks.map((r) => c('H', r));
const diamonds = (ranks: number[]) => ranks.map((r) => c('D', r));
const clubs = (ranks: number[]) => ranks.map((r) => c('C', r));

describe('what the robot is allowed to know', () => {
  it('records every card played, in order', () => {
    const hands = deal({
      N: [...spades([14, 13, 12, 11]), ...hearts([14, 13, 12]), ...diamonds([14, 13, 12]), ...clubs([14, 13, 12])],
      E: [...spades([10, 9, 8]), ...hearts([11, 10, 9, 8]), ...diamonds([11, 10, 9]), ...clubs([11, 10, 9])],
      S: [...spades([7, 6, 5]), ...hearts([7, 6, 5]), ...diamonds([8, 7, 6, 5]), ...clubs([8, 7, 6])],
      W: [...spades([4, 3, 2]), ...hearts([4, 3, 2]), ...diamonds([4, 3, 2]), ...clubs([5, 4, 3, 2])],
    });
    const contract: Contract = { level: 3, strain: 'N', declarer: 'N', doubled: 0 };
    let play = startPlay(contract, hands);
    expect(play.played).toEqual([]);
    const first = play.hands[play.turn][0] as Card;
    play = applyPlay(play, play.turn, first);
    expect(play.played).toEqual([first]);
    const second = play.hands[play.turn].find((x) => cardSuit(x) === cardSuit(first)) ?? play.hands[play.turn][0] as Card;
    play = applyPlay(play, play.turn, second);
    expect(play.played).toEqual([first, second]);
  });

  /* The robot is handed the whole table, hidden hands included. This is what
     stops it quietly reading them: the same visible position with the unseen
     cards shuffled between the two opponents must produce the same card. */
  it('plays the same card however the hidden cards are arranged', () => {
    const north = [...spades([14, 13, 5]), ...hearts([14, 9, 8]), ...diamonds([14, 7, 6]), ...clubs([14, 6, 5, 4])];
    const south = [...spades([12, 11, 10]), ...hearts([13, 12, 11]), ...diamonds([13, 12, 11]), ...clubs([13, 12, 11, 10])];
    const rest: Card[] = [];
    for (const s of ['S', 'H', 'D', 'C'] as const) {
      for (let r = 2; r <= 14; r++) {
        const card = c(s, r);
        if (!north.includes(card) && !south.includes(card)) rest.push(card);
      }
    }
    expect(rest).toHaveLength(26);

    const contract: Contract = { level: 3, strain: 'N', declarer: 'S', doubled: 0 };
    const chooseFor = (east: Card[], west: Card[]): Card => {
      const hands = deal({ N: [...north], E: east, S: [...south], W: west });
      let play: PlayState = startPlay(contract, hands);
      /* Move the lead round to declarer so the decision is declarer's. */
      play = { ...play, turn: 'S' };
      return chooseCard(play, 'S');
    };

    const half = rest.length / 2;
    const a = chooseFor(rest.slice(0, half), rest.slice(half));
    const b = chooseFor(rest.slice(half), rest.slice(0, half));
    /* A third arrangement, interleaved rather than cut in half. */
    const odd = rest.filter((_, i) => i % 2 === 0);
    const even = rest.filter((_, i) => i % 2 === 1);
    const d = chooseFor(odd, even);
    expect(a).toBe(b);
    expect(a).toBe(d);
  });
});

describe('how the robot plays', () => {
  it('pulls the opponents’ trumps before anything else', () => {
    const hands = deal({
      S: [...spades([14, 13, 12, 11, 10]), ...hearts([14, 13]), ...diamonds([14, 13]), ...clubs([14, 13, 12, 11])],
      N: [...spades([9, 8, 7, 6]), ...hearts([12, 11, 10]), ...diamonds([12, 11, 10]), ...clubs([10, 9, 8])],
      E: [...spades([5, 4]), ...hearts([9, 8, 7, 6]), ...diamonds([9, 8, 7, 6]), ...clubs([7, 6, 5])],
      W: [...spades([3, 2]), ...hearts([5, 4, 3, 2]), ...diamonds([5, 4, 3, 2]), ...clubs([4, 3, 2])],
    });
    const contract: Contract = { level: 4, strain: 'S', declarer: 'S', doubled: 0 };
    const play: PlayState = { ...startPlay(contract, hands), turn: 'S' };
    /* Four trumps are still out between the defenders, so lead one. */
    expect(cardSuit(chooseCard(play, 'S'))).toBe('S');
  });

  it('takes a trick it cannot lose rather than leading small', () => {
    /* Every spade above the nine has gone; declarer's nine is now the master. */
    const hands = deal({
      S: [...spades([9, 3, 2]), ...hearts([2, 3, 4]), ...diamonds([2, 3, 4]), ...clubs([2, 3, 4, 5])],
      N: [...spades([8, 7, 6]), ...hearts([5, 6, 7]), ...diamonds([5, 6, 7]), ...clubs([6, 7, 8, 9])],
      E: [...spades([14, 13, 12]), ...hearts([8, 9, 10]), ...diamonds([8, 9, 10]), ...clubs([10, 11, 12, 13])],
      W: [...spades([11, 10, 5, 4]), ...hearts([11, 12, 13, 14]), ...diamonds([11, 12, 13, 14]), ...clubs([14])],
    });
    const contract: Contract = { level: 1, strain: 'N', declarer: 'S', doubled: 0 };
    let play: PlayState = { ...startPlay(contract, hands), turn: 'S' };
    /* Tell the table that the ace, king, queen, jack and ten have been played. */
    play = { ...play, played: [c('S', 14), c('S', 13), c('S', 12), c('S', 11), c('S', 10)] };
    play = { ...play, hands: { ...play.hands, E: play.hands.E.filter((x) => cardSuit(x) !== 'S' || x < c('S', 10)), W: play.hands.W.filter((x) => x !== c('S', 11) && x !== c('S', 10)) } };
    const picked = chooseCard(play, 'S');
    expect(cardSuit(picked)).toBe('S');
    expect(picked).toBe(c('S', 9));
  });
});

describe('measured against the robot it replaces', () => {
  const current: Robot = { name: 'current', chooseCall, chooseCard };
  const old: Robot = { name: 'baseline', chooseCall: baseline.chooseCall, chooseCard: baseline.chooseCard };

  it('is level with itself, which is what makes the comparison fair', () => {
    const r = match(old, old, boardRange(40), 'fairness');
    expect(r.net).toBe(0);
    expect(r.tied).toBe(40);
  });

  it('beats it over a set of boards it was not tuned on', () => {
    const r = match(current, old, boardRange(80), 'regression-seed');
    expect(r.net, `net ${r.net}, ${r.impsPerBoard} IMP/board`).toBeGreaterThan(0);
    expect(r.won).toBeGreaterThan(r.lost);
  }, 120000);
});
