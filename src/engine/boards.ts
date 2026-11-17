/**
 * Boards somebody else dealt.
 *
 * A tournament normally deals itself: every browser shuffles the same cards
 * from the same seed, so nobody has to send anything. A director who wants
 * particular boards — a club's own set, a lesson built around them, a hand
 * from a book — brings them in a file instead, and this reads the two formats
 * such files come in.
 *
 * PBN is the written one, used by dealing machines and most club software.
 * LIN is what Bridge Base writes. BRI, the third, is a binary format of a
 * particular dealing machine: anything that writes it also writes PBN, so it
 * is not read here.
 *
 * Deals are kept as one PBN deal string per board, North's hand first,
 * because that is the form the files already use and it can be read by a
 * person looking at the tournament's page.
 */
import { RANK_CHARS, SEATS, SUITS as ENGINE_SUITS, makeCard, type Card, type Seat } from './cards';
import { type Hands } from './deal';

/** Files write a hand from the top down, and spades first. */
const RANKS = 'AKQJT98765432';
const SUITS = ['S', 'H', 'D', 'C'] as const;
const cardOf = (suit: typeof SUITS[number], rank: string): Card =>
  makeCard(suit, RANK_CHARS.indexOf(rank) + 2);

export class BoardError extends Error {}

/** "N:AK5.QJ4.T98.76542 …" — a whole deal, in the order the file gives it. */
export type DealText = string;

/**
 * One deal as the engine wants it. Throws when the text is not a deal: a
 * board of 51 cards would otherwise be found out in the middle of a round.
 */
export function handsOf(deal: DealText): Hands {
  const m = /^([NESW]):(.+)$/i.exec(deal.trim());
  if (!m) throw new BoardError('A deal must start with the seat it begins at, as in "N:".');
  const first = SEATS.indexOf((m[1] as string).toUpperCase() as Seat);
  const hands = (m[2] as string).trim().split(/\s+/);
  if (hands.length !== 4) throw new BoardError(`A deal has four hands; this one has ${hands.length}.`);
  const out = { N: [], E: [], S: [], W: [] } as Hands;
  const seen = new Set<number>();
  hands.forEach((hand, i) => {
    const seat = SEATS[(first + i) % 4] as Seat;
    const suits = hand.split('.');
    if (suits.length !== 4) throw new BoardError(`${seat}'s hand must have four suits separated by dots.`);
    const cards: Card[] = [];
    suits.forEach((text, s) => {
      for (const rank of text.toUpperCase()) {
        if (!RANKS.includes(rank)) throw new BoardError(`"${rank}" is not a card.`);
        const card = cardOf(SUITS[s] as typeof SUITS[number], rank);
        if (seen.has(card)) throw new BoardError(`The ${rank} of ${SUITS[s]} is in two hands.`);
        seen.add(card);
        cards.push(card);
      }
    });
    if (cards.length !== 13) throw new BoardError(`${seat} has ${cards.length} cards, not 13.`);
    out[seat] = cards.sort((a, b) => a - b);
  });
  return out;
}

/** The same the other way about, for writing a deal back out. */
export function dealText(hands: Hands): DealText {
  const hand = (cards: readonly Card[]): string => SUITS.map((suit) => cards
    .filter((c) => ENGINE_SUITS[Math.floor(c / 13)] === suit)
    .sort((a, b) => b - a)
    .map((c) => RANK_CHARS.charAt(c % 13))
    .join('')).join('.');
  return `N:${SEATS.map((seat) => hand(hands[seat])).join(' ')}`;
}

/** Is this a deal we could play? Said without throwing, for a quick check. */
export function readable(deal: DealText): boolean {
  try { handsOf(deal); return true; } catch { return false; }
}

/** Every deal in a PBN file, in the order it gives them. */
function fromPbn(text: string): DealText[] {
  const out: DealText[] = [];
  for (const m of text.matchAll(/\[\s*Deal\s+"([^"]+)"\s*\]/gi)) out.push(normal(m[1] as string));
  return out;
}

/**
 * Every deal in a LIN file. Bridge Base writes the four hands after a digit
 * for the dealer, starting at South and going round; the last hand is often
 * left out, being whatever is left.
 */
function fromLin(text: string): DealText[] {
  const out: DealText[] = [];
  for (const m of text.matchAll(/md\|\d?([^|]*)\|/gi)) {
    const given = (m[1] as string).split(',').map((h) => h.replace(/^\s+|\s+$/g, ''));
    /* South, West, North, East, as LIN writes them. */
    const seats: Seat[] = ['S', 'W', 'N', 'E'];
    const hands: Record<string, string> = {};
    given.forEach((hand, i) => { if (hand && seats[i]) hands[seats[i] as Seat] = linHand(hand); });
    const missing = seats.filter((s) => !hands[s]);
    if (missing.length === 1) hands[missing[0] as Seat] = restOf(Object.values(hands));
    else if (missing.length) continue;
    out.push(normal(`N:${SEATS.map((s) => hands[s]).join(' ')}`));
  }
  return out;
}

/** "SAKQJ4HT62D83CJ94" as "AKQJ4.T62.83.J94". */
function linHand(hand: string): string {
  const suits = { S: '', H: '', D: '', C: '' } as Record<string, string>;
  let at = '';
  for (const ch of hand.toUpperCase()) {
    if (ch in suits) { at = ch; continue; }
    if (at) suits[at] += ch;
  }
  return [suits.S, suits.H, suits.D, suits.C].join('.');
}

/** The thirteen cards nobody else was given. */
function restOf(hands: string[]): string {
  const held = new Set<string>();
  for (const hand of hands) {
    hand.split('.').forEach((text, s) => { for (const r of text) held.add(`${s}${r}`); });
  }
  return [0, 1, 2, 3].map((s) => [...RANKS].filter((r) => !held.has(`${s}${r}`)).join('')).join('.');
}

/** A deal written from North, whichever seat the file started at. */
function normal(deal: DealText): DealText {
  return dealText(handsOf(deal));
}

/**
 * The boards in a file of either format. The error says what was wrong with
 * the file rather than leaving a director to guess, since the file is
 * somebody else's and they may never have looked inside it.
 */
export function readBoards(text: string): DealText[] {
  const trimmed = text.trim();
  if (!trimmed) throw new BoardError('That file is empty.');
  const looksLin = /\bmd\|/i.test(trimmed);
  const deals = looksLin ? fromLin(trimmed) : fromPbn(trimmed);
  if (!deals.length) {
    throw new BoardError(looksLin
      ? 'No complete deal was found in that LIN file.'
      : 'No [Deal "…"] was found. A PBN file from a dealing machine has one for each board; '
        + 'a file of auctions and play alone does not say what the cards were.');
  }
  return deals;
}
