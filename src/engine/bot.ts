/**
 * A deliberately simple robot. It fills empty seats and stands in for players
 * who drop out, so a table never stalls. It bids a few natural calls and plays
 * sensible-but-basic cards. It is not a strong player.
 */
import { SUITS, cardRank, cardSuit, hcp, legalPlays, makeCard, partnerOf, sideOf, suitLengths, type Card, type Seat, type Suit } from './cards';
import { PASS, illegalReason, lastBid, type AuctionState, type Call } from './bidding';
import { isDummyVisible, trickWinner, type PlayState } from './play';

function longestSuit(hand: readonly Card[]): Suit {
  const len = suitLengths(hand);
  let best: Suit = 'C';
  for (const s of SUITS) if (len[s] >= len[best]) best = s; // ties go to the higher suit
  return best;
}

/** No void or singleton, at most one doubleton, no suit longer than five. */
function isBalanced(hand: readonly Card[]): boolean {
  const lens = Object.values(suitLengths(hand)).sort((x, y) => x - y) as [number, number, number, number];
  return lens[0] >= 2 && lens[1] >= 3 && lens[3] <= 5;
}

export function chooseCall(hand: readonly Card[], auction: AuctionState, seat: Seat): Call {
  const points = hcp(hand);
  const len = suitLengths(hand);
  const legal = (c: Call): boolean => illegalReason(auction, seat, c) === null;
  const pick = (...cands: Call[]): Call => cands.find(legal) ?? PASS;
  const lb = lastBid(auction);
  const myCalls = auction.calls.filter((e) => e.seat === seat);
  const partnerBids = auction.calls.filter((e) => e.seat === partnerOf(seat) && e.call.type === 'bid');
  const iHaveBid = myCalls.some((e) => e.call.type === 'bid');

  // Opening (or overcalling at the one level with opening values).
  if (!iHaveBid && partnerBids.length === 0) {
    if (points < 12) return PASS;
    if (!lb && points >= 15 && points <= 17 && isBalanced(hand)) return pick({ type: 'bid', level: 1, strain: 'N' });
    const suit: Suit = len.S >= 5 && len.S >= len.H ? 'S' : len.H >= 5 ? 'H' : len.D >= len.C ? 'D' : 'C';
    if (lb && len[suit] < 5) return PASS;
    const one: Call = { type: 'bid', level: 1, strain: suit };
    if (legal(one)) return one;
    /* They have taken the one level away. With an opening hand and a suit of
         five, coming in at the two level still measured better than passing. */
    if (lb && len[suit] >= 5) {
      const two: Call = { type: 'bid', level: 2, strain: suit };
      if (legal(two)) return two;
    }
    return PASS;
  }

  // Responding to partner's first bid.
  if (!iHaveBid && partnerBids.length === 1) {
    const pb = (partnerBids[0] as { call: Call }).call;
    if (pb.type !== 'bid' || points < 6) return PASS;
    if (pb.strain === 'N') {
      return points >= 10 ? pick({ type: 'bid', level: 3, strain: 'N' }) : PASS;
    }
    const support = len[pb.strain as Suit];
    const major = pb.strain === 'H' || pb.strain === 'S';
    if (support >= (major ? 3 : 4)) {
      if (points >= 13 && major) return pick({ type: 'bid', level: 4, strain: pb.strain });
      if (points >= 10) return pick({ type: 'bid', level: 3, strain: pb.strain });
      return pick({ type: 'bid', level: 2, strain: pb.strain });
    }
    if (points >= 13) return pick({ type: 'bid', level: 3, strain: 'N' });
    const own = longestSuit(hand);
    if (len[own] >= 4) {
      const oneLevel: Call = { type: 'bid', level: 1, strain: own };
      if (legal(oneLevel)) return oneLevel;
    }
    return pick({ type: 'bid', level: 1, strain: 'N' });
  }

  // Opener's rebid: accept an invitation with extras, otherwise stop.
  if (iHaveBid && lb && lb.seat === partnerOf(seat) && myCalls.length === 1 && points >= 15) {
    if (lb.strain === 'N' && lb.level === 1) return pick({ type: 'bid', level: 2, strain: 'N' });
    if ((lb.strain === 'H' || lb.strain === 'S') && lb.level === 3) return pick({ type: 'bid', level: 4, strain: lb.strain });
    if (lb.strain === 'N' && lb.level === 2) return pick({ type: 'bid', level: 3, strain: 'N' });
  }
  return PASS;
}

const lowest = (cards: readonly Card[]): Card => [...cards].sort((a, b) => cardRank(a) - cardRank(b) || a - b)[0] as Card;
const highest = (cards: readonly Card[]): Card => [...cards].sort((a, b) => cardRank(b) - cardRank(a) || b - a)[0] as Card;

/**
 * The cards of one suit this player cannot account for: not in their own
 * hand, not in dummy once dummy is face up, and not yet played. Everything
 * here was seen by the whole table, so working it out is not a peek into
 * anyone's hand — it is what any player does when they count.
 */
function unseen(play: PlayState, seat: Seat, suit: Suit): Card[] {
  const seen = new Set<Card>([...play.played, ...play.hands[seat], ...play.trick.map((t) => t.card)]);
  const canSeeDummy = seat === play.contract.declarer || (isDummyVisible(play) && seat !== play.dummy);
  if (canSeeDummy) for (const c of play.hands[play.dummy]) seen.add(c);
  const out: Card[] = [];
  for (let r = 2; r <= 14; r++) {
    const c = makeCard(suit, r);
    if (!seen.has(c)) out.push(c);
  }
  return out;
}

/** True when nobody else can still hold a higher card of the same suit. */
function isWinner(play: PlayState, seat: Seat, card: Card): boolean {
  const suit = cardSuit(card);
  return unseen(play, seat, suit).every((c) => cardRank(c) < cardRank(card));
}

/** Whether the opponents still hold a trump. */
function opponentsHaveTrumps(play: PlayState, seat: Seat): boolean {
  const trump = play.contract.strain;
  if (trump === 'N') return false;
  return unseen(play, seat, trump).length > 0;
}

/** Choose a card for `seat` (the seat whose turn it is, which may be dummy). */
export function chooseCard(play: PlayState, seat: Seat): Card {
  const hand = play.hands[seat];
  const options = legalPlays(hand, play.trick);
  if (options.length === 1) return options[0] as Card;
  const trump = play.contract.strain;
  const declaring = sideOf(seat) === sideOf(play.contract.declarer);

  if (play.trick.length === 0) {
    /* Leading. Declarer pulls the opponents' trumps first, so they cannot
       ruff the side suits later. */
    if (declaring && trump !== 'N' && opponentsHaveTrumps(play, seat)) {
      const trumps = options.filter((c) => cardSuit(c) === trump);
      if (trumps.length > 0) return highest(trumps);
    }
    /* Then take the tricks that are already yours: a card no one can beat. */
    const sure = options.filter((c) => isWinner(play, seat, c) && (trump === 'N' || cardSuit(c) !== trump));
    if (sure.length > 0) return highest(sure);

    const side = options.filter((c) => cardSuit(c) !== trump);
    const pool = side.length > 0 ? side : options;
    const suit = longestSuit(pool);
    const inSuit = pool.filter((c) => cardSuit(c) === suit).sort((a, b) => b - a);
    const top = inSuit[0] as Card;
    const second = inSuit[1];
    if (second !== undefined && cardRank(top) >= 11 && cardRank(top) - cardRank(second) === 1) return top;
    return inSuit.length >= 4 ? (inSuit[3] as Card) : (inSuit[inSuit.length - 1] as Card);
  }

  const winnerSoFar = trickWinner(play.trick, trump);
  const partnerWinning = sideOf(winnerSoFar) === sideOf(seat);
  const lastToPlay = play.trick.length === 3;
  const winning = options.filter((c) => trickWinner([...play.trick, { seat, card: c }], trump) === seat);

  if (partnerWinning && (lastToPlay || winning.length === 0)) return lowest(options);
  if (winning.length > 0) {
    if (partnerWinning) return lowest(options);
    /* Win as cheaply as the position allows. Playing second of four, a card
       the opponents can still beat is usually wasted, so keep it back unless
       it settles the trick outright. */
    const plain = winning.filter((c) => cardSuit(c) !== trump);
    const pool = plain.length > 0 ? plain : winning;
    if (play.trick.length === 1 && !lastToPlay) {
      const certain = pool.filter((c) => isWinner(play, seat, c));
      if (certain.length === 0) return lowest(options);
      return lowest(certain);
    }
    return lowest(pool);
  }
  /* Cannot win: throw the lowest card, sparing trumps and sure winners. */
  const spare = options.filter((c) => cardSuit(c) !== trump && !isWinner(play, seat, c));
  if (spare.length > 0) return lowest(spare);
  const plain = options.filter((c) => cardSuit(c) !== trump);
  return lowest(plain.length > 0 ? plain : options);
}
