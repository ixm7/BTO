/**
 * Card play for the robots: picture the hands it cannot see, many times over,
 * work out the best play for each picture, and play the card that does best
 * across them all. This is the method GIB made standard.
 *
 * The robot sees only what a player in its seat sees: its own cards, dummy
 * once it is down, and every card played so far. From those it knows who has
 * shown out of which suit; from the auction it knows roughly what each hidden
 * hand must look like. Every picture it deals respects all of that.
 */
import { SEATS, SUITS, cardRank, cardSuit, hcp, legalPlays, nextSeat, sideOf, type Card, type Seat, type Suit } from './cards';
import { controllerOf, isDummyVisible, trickWinner, type PlayState, type TrickCard } from './play';
import { chooseCard as simpleCard } from './bot';
import type { Solve } from './dds';
import type { Shape } from './sayc';

export interface ThinkOptions {
  solve: Solve;
  /** What each seat's bidding showed, if anything is known. */
  know?: Record<Seat, Shape>;
  rng?: () => number;
  /** Stop dealing new layouts after this long. */
  budgetMs?: number;
  maxSamples?: number;
  minSamples?: number;
  now?: () => number;
}

export interface Thought { card: Card; samples: number; ms: number }

/** Who played each card so far, worked out by replaying the tricks. */
export function playHistory(p: PlayState): TrickCard[] {
  const out: TrickCard[] = [];
  let seat: Seat = nextSeat(p.contract.declarer);
  let trick: TrickCard[] = [];
  for (const card of p.played) {
    trick.push({ seat, card });
    out.push({ seat, card });
    if (trick.length === 4) { seat = trickWinner(trick, p.contract.strain); trick = []; } else seat = nextSeat(seat);
  }
  return out;
}

/** The suits each seat has shown out of. */
function shownOut(p: PlayState, history: TrickCard[]): Record<Seat, Set<Suit>> {
  const out: Record<Seat, Set<Suit>> = { N: new Set(), E: new Set(), S: new Set(), W: new Set() };
  for (let i = 0; i < history.length; i += 4) {
    const led = cardSuit((history[i] as TrickCard).card);
    for (const tc of history.slice(i, i + 4)) if (cardSuit(tc.card) !== led) out[tc.seat].add(led);
  }
  void p;
  return out;
}

const shuffle = <T>(xs: T[], rng: () => number): T[] => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
  }
  return xs;
};

/** Does this hand, as it was dealt, look like what its bidding showed? */
function plausible(original: readonly Card[], shape: Shape | undefined, slack: number): boolean {
  if (!shape) return true;
  const points = hcp(original);
  if (points < shape.hcp[0] - slack || points > shape.hcp[1] + slack) return false;
  for (const s of SUITS) {
    const n = original.filter((c) => cardSuit(c) === s).length;
    const r = shape.len[s];
    if (n < r[0] - (slack > 1 ? 1 : 0) || n > r[1] + (slack > 1 ? 1 : 0)) return false;
  }
  return true;
}

/**
 * Deal the unseen cards to the hidden seats: the right number each, nobody
 * given a suit they have shown out of, and — as far as luck allows — hands
 * that fit their bidding. If the bidding cannot be matched in a reasonable
 * number of tries it is believed a little less, then not at all: a player may
 * have bid off the system, and a picture is better than none.
 */
function dealHidden(
  unseen: readonly Card[], hidden: readonly Seat[], sizes: Record<Seat, number>, voids: Record<Seat, Set<Suit>>,
  playedBy: Record<Seat, Card[]>, know: Record<Seat, Shape> | undefined, rng: () => number,
): Record<Seat, Card[]> | null {
  let fallback: Record<Seat, Card[]> | null = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const slack = attempt < 200 ? 1 : attempt < 320 ? 3 : 99;
    const hands: Record<Seat, Card[]> = { N: [], E: [], S: [], W: [] };
    /* Cards only one hidden seat can hold go first, so they are never stranded. */
    const cards = shuffle([...unseen], rng).sort((a, b) =>
      hidden.filter((h) => !voids[h].has(cardSuit(a))).length - hidden.filter((h) => !voids[h].has(cardSuit(b))).length);
    let ok = true;
    for (const card of cards) {
      const able = hidden.filter((h) => hands[h].length < sizes[h] && !voids[h].has(cardSuit(card)));
      if (able.length === 0) { ok = false; break; }
      /* Weighted by room left, which keeps the deal uniform. */
      const room = able.map((h) => sizes[h] - hands[h].length);
      let pick = rng() * room.reduce((x, y) => x + y, 0);
      let who = able[0] as Seat;
      for (let i = 0; i < able.length; i++) { pick -= room[i] as number; if (pick < 0) { who = able[i] as Seat; break; } }
      hands[who].push(card);
    }
    if (!ok) continue;
    fallback ??= hands;
    if (slack >= 99 || hidden.every((h) => plausible([...hands[h], ...playedBy[h]], know?.[h], slack))) return hands;
  }
  return fallback;
}

/** The card to play, chosen by sampling the unseen hands. */
export function thinkCard(play: PlayState, seat: Seat, o: ThinkOptions): Thought {
  const now = o.now ?? (() => Date.now());
  const started = now();
  const rng = o.rng ?? Math.random;
  const hand = play.hands[seat];
  const legal = legalPlays(hand, play.trick);
  const done = (card: Card, samples: number): Thought => ({ card, samples, ms: now() - started });
  if (legal.length === 1) return done(legal[0] as Card, 0);

  /* Touching cards are the same card. Solve for one of each run. */
  const viewer = controllerOf(play, seat);
  const dummyUp = isDummyVisible(play);
  const seen = new Set<Seat>([viewer]);
  if (dummyUp) seen.add(play.dummy);
  if (seat === play.dummy) seen.add(play.dummy);
  const hidden = SEATS.filter((s) => !seen.has(s));

  const history = playHistory(play);
  const voids = shownOut(play, history);
  const playedBy: Record<Seat, Card[]> = { N: [], E: [], S: [], W: [] };
  for (const tc of history) playedBy[tc.seat].push(tc.card);

  const known = new Set<Card>([...play.played]);
  for (const s of seen) for (const c of play.hands[s]) known.add(c);
  const unseen: Card[] = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) unseen.push(c);
  const sizes: Record<Seat, number> = { N: play.hands.N.length, E: play.hands.E.length, S: play.hands.S.length, W: play.hands.W.length };

  const leader = play.trick.length ? (play.trick[0] as TrickCard).seat : seat;
  const trickCards = play.trick.map((t) => t.card);
  const declaring = sideOf(seat) === sideOf(play.contract.declarer);
  const need = play.contract.level + 6;
  /* Tricks from here that reach the goal: the contract, or its defeat. */
  const goal = declaring ? need - play.declarerTricks : 14 - need - play.defenderTricks;

  const sum = new Map<Card, number>(legal.map((c) => [c, 0]));
  const made = new Map<Card, number>(legal.map((c) => [c, 0]));
  const full = hand.length >= 12;
  const budget = o.budgetMs ?? (full ? 3500 : 2000);
  const max = o.maxSamples ?? (full ? 24 : hand.length >= 9 ? 40 : 60);
  const min = o.minSamples ?? 5;
  let samples = 0;

  while (samples < max) {
    const elapsed = now() - started;
    if (samples >= min && elapsed > budget) break;
    if (elapsed > budget * 2.5 && samples >= 2) break;
    const dealt = dealHidden(unseen, hidden, sizes, voids, playedBy, o.know, rng);
    if (!dealt) break;
    const hands: Record<Seat, readonly Card[]> = { N: dealt.N, E: dealt.E, S: dealt.S, W: dealt.W };
    for (const s of seen) hands[s] = play.hands[s];
    let solved;
    try { solved = o.solve(hands, play.contract.strain, leader, trickCards); } catch { break; }
    if (solved.length === 0) break;
    for (const card of legal) {
      /* The solver names one card of each touching run; a neighbour stands for the rest. */
      const suit = cardSuit(card);
      let best: { tricks: number; gap: number } | null = null;
      for (const r of solved) {
        if (cardSuit(r.card) !== suit) continue;
        const gap = Math.abs(cardRank(r.card) - cardRank(card)) + (cardRank(r.card) < cardRank(card) ? 0.5 : 0);
        if (!best || gap < best.gap) best = { tricks: r.tricks, gap };
      }
      const tricks = best?.tricks ?? 0;
      sum.set(card, (sum.get(card) as number) + tricks);
      if (tricks >= goal) made.set(card, (made.get(card) as number) + 1);
    }
    samples++;
  }
  if (samples === 0) return done(simpleCard(play, seat), 0);

  /* Mostly tricks, with a lean towards the plays that make or break the contract. */
  const score = (c: Card): number => (sum.get(c) as number) / samples + 0.75 * (made.get(c) as number) / samples;
  const top = Math.max(...legal.map(score));
  const close = legal.filter((c) => score(c) >= top - 0.04);
  /* Between plays the layouts cannot separate, common sense breaks the tie:
     the simple robot's choice if it is among them, else the cheapest card. */
  const habit = simpleCard(play, seat);
  if (close.includes(habit)) return done(habit, samples);
  return done(close.sort((a, b) => cardRank(a) - cardRank(b))[0] as Card, samples);
}
