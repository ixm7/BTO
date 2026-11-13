/**
 * Standard American Yellow Card, written as a table of rules.
 *
 * At each turn the system lists, in order of preference, the calls it knows
 * for that situation, each with what the call shows: a range of high-card
 * points and of lengths in each suit. The robot makes the first call on the
 * list its hand fits. Reading the same list the other way — "which hands make
 * this call?" — tells everybody at the table what a call showed, which is
 * what a partner needs in order to answer it, what the opponents are entitled
 * to be told, and what the card-play engine uses to picture the unseen hands.
 *
 * Covered: 5-card majors, 15–17 1NT with Stayman and Jacoby transfers, strong
 * 2♣, weak twos and pre-empts, weak jump raises, Jacoby 2NT, take-out and negative
 * doubles, overcalls, Michaels over a minor, the unusual 2NT, Blackwood.
 * Later rounds are placed by arithmetic on what the partnership has shown:
 * points for game or slam, and an eight-card fit.
 */
import { SUITS, cardRank, cardSuit, hcp as countHcp, nextSeat, partnerOf, sideOf, suitLengths, type Card, type Seat, type Strain, type Suit } from './cards';
import { PASS, bidValue, illegalReason, lastBid, type AuctionEntry, type AuctionState, type Call } from './bidding';

type Range = [number, number];

/** What is known about a hand from its calls: points and suit lengths. */
export interface Shape { hcp: Range; len: Record<Suit, Range> }

export const anyShape = (): Shape => ({ hcp: [0, 37], len: { C: [0, 13], D: [0, 13], H: [0, 13], S: [0, 13] } });

interface Rule {
  call: Call;
  /** Plain words for what the call shows, for the explanation shown at the table. */
  says: string;
  hcp?: Range;
  len?: Partial<Record<Suit, Range>>;
  /** Anything the ranges cannot express. Used to choose a call, not to read one. */
  when?: (v: View) => boolean;
  /** Partner may not pass (unless the next hand bids). */
  forcing?: boolean;
  /** A label later rules look for: 'stayman', 'transfer:H', 'takeout', … */
  tag?: string;
  /** The call does not mean what it names, so the opponents are alerted. */
  alert?: boolean;
  /** A last resort. It is not what the call normally shows, so it is not read into one. */
  fb?: boolean;
  /** The points partner should count on, where the rule itself admits the odd lighter hand. */
  read?: Range;
}

const lastResort = (rules: Rule[]): Rule[] => rules.map((r) => ({ ...r, fb: true }));

/* ------------------------------------------------------------- the hand */

interface View {
  hcp: number;
  len: Record<Suit, number>;
  balanced: boolean;
  /** Balanced, or 5-4-2-2 / 6-3-2-2. */
  semi: boolean;
  /** High cards plus a point for each card over four in a suit. */
  lp: number;
  /** Extra for shortness when raising: void 5, singleton 3, doubleton 1. */
  short(trump: Suit): number;
  /** How many of the top `n` honours (A K Q J 10) are held in the suit. */
  top(s: Suit, n: number): number;
  /** A stopper: A, Kx, Qxx or Jxxx. */
  stop(s: Suit): boolean;
  aces: number;
}

export function viewOf(cards: readonly Card[]): View {
  const len = suitLengths(cards);
  const pattern = SUITS.map((s) => len[s]).sort((a, b) => b - a).join('');
  const balanced = pattern === '4333' || pattern === '4432' || pattern === '5332';
  const ranks = (s: Suit): number[] => cards.filter((c) => cardSuit(c) === s).map(cardRank);
  const hcp = countHcp(cards);
  return {
    hcp, len, balanced,
    semi: balanced || pattern === '5422' || pattern === '6322',
    lp: hcp + SUITS.reduce((n, s) => n + Math.max(0, len[s] - 4), 0),
    short: (trump) => SUITS.reduce((n, s) => n + (s === trump ? 0 : len[s] === 0 ? 5 : len[s] === 1 ? 3 : len[s] === 2 ? 1 : 0), 0),
    top: (s, n) => ranks(s).filter((r) => r >= 15 - n).length,
    stop: (s) => { const r = ranks(s); return r.includes(14) || (r.includes(13) && r.length >= 2) || (r.includes(12) && r.length >= 3) || (r.includes(11) && r.length >= 4); },
    aces: cards.filter((c) => cardRank(c) === 14).length,
  };
}

/* ------------------------------------------------------------ small helpers */

const B = (level: number, strain: Strain): Call => ({ type: 'bid', level, strain });
const DBL: Call = { type: 'double' };
const RDBL: Call = { type: 'redouble' };
const same = (a: Call, b: Call): boolean =>
  a.type === b.type && (a.type !== 'bid' || (b.type === 'bid' && a.level === b.level && a.strain === b.strain));
const isMajor = (s: Strain): s is 'H' | 'S' => s === 'H' || s === 'S';
const isSuit = (s: Strain): s is Suit => s !== 'N';
const MAJORS: Suit[] = ['S', 'H'];
const NAME: Record<Strain, string> = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades', N: 'no-trump' };
const clamp = (n: number): number => Math.max(0, Math.min(37, n));
const R = (lo: number, hi: number): Range => [clamp(lo), clamp(hi)];
const mid = (r: Range): number => (r[0] + r[1]) / 2;

/* ---------------------------------------------------------- the situation */

interface Told { tag: string; forcing: boolean }

/**
 * Which system is being bid. Two-over-one is Standard American with two
 * changes: a new suit at the two level over partner's opening forces to game,
 * and one no-trump over a major is forcing — which is also where its
 * invitational raises go, a jump raise being weak in both systems.
 * Everything else is shared.
 */
export type System = 'sayc' | '2/1';
export const SYSTEM_NAME: Record<System, string> = { sayc: 'SAYC', '2/1': '2/1' };

interface Ctx {
  a: AuctionState;
  me: Seat; pd: Seat; lho: Seat; rho: Seat;
  know: Record<Seat, Shape>;
  told: Told[];
  last: { seat: Seat; level: number; strain: Strain } | null;
  legal(c: Call): boolean;
  /** Everything a seat has called, passes included. */
  by(s: Seat): { e: AuctionEntry; i: number }[];
  /** A seat's bids and doubles. */
  acts(s: Seat): { e: AuctionEntry; i: number }[];
  /** Who made the first bid. */
  opener: Seat | null;
  /** Suits the opponents have bid. */
  theirs: Suit[];
  /** The lowest legal level in a strain, or 0 if there is none. */
  cheapest(strain: Strain): number;
  /** Partner's last call was forcing and the hand between passed. */
  forced: boolean;
  /** The call just before mine, when my right-hand opponent made it. */
  rhoCall: Call | null;
  tagOf(i: number): string;
  sys: System;
  /** Our side has made a call that forces to game. */
  gf: boolean;
  /** I passed before partner opened: nothing I bid now can be game forcing. */
  passedHand: boolean;
}

function makeCtx(a: AuctionState, me: Seat, know: Record<Seat, Shape>, told: Told[], sys: System): Ctx {
  const pd = partnerOf(me);
  const lho = nextSeat(me);
  const rho = partnerOf(lho);
  const idx = a.calls.map((e, i) => ({ e, i }));
  const by = (s: Seat) => idx.filter((x) => x.e.seat === s);
  const acts = (s: Seat) => by(s).filter((x) => x.e.call.type !== 'pass');
  const last = lastBid(a);
  const firstBid = a.calls.find((e) => e.call.type === 'bid');
  const theirs: Suit[] = [];
  for (const e of a.calls) {
    if (e.call.type === 'bid' && sideOf(e.seat) !== sideOf(me) && isSuit(e.call.strain) && !theirs.includes(e.call.strain)) theirs.push(e.call.strain);
  }
  const legal = (c: Call): boolean => illegalReason(a, me, c) === null;
  const pdLast = by(pd).at(-1);
  const prev = a.calls.at(-1);
  const rhoCall = prev && prev.seat === rho ? prev.call : null;
  return {
    a, me, pd, lho, rho, know, told, last, legal, by, acts,
    opener: firstBid?.seat ?? null,
    theirs,
    cheapest: (strain) => { for (let l = 1; l <= 7; l++) if (legal(B(l, strain))) return l; return 0; },
    forced: !!pdLast && !!told[pdLast.i]?.forcing && (!rhoCall || rhoCall.type === 'pass'),
    rhoCall,
    tagOf: (i) => told[i]?.tag ?? '',
    sys,
    gf: a.calls.some((e, i) => sideOf(e.seat) === sideOf(me) && told[i]?.tag === 'gf'),
    passedHand: by(me)[0]?.e.call.type === 'pass',
  };
}

/* ================================================================ OPENING */

/** Which suit to open at the one level. */
function openingSuit(v: View): Suit {
  const { S, H, D, C } = v.len;
  if (S >= 5 || H >= 5) {
    const major: Suit = S >= H ? 'S' : 'H';
    const minor: Suit = D >= C ? 'D' : 'C';
    return v.len[minor] > v.len[major] ? minor : major;
  }
  if (D > C) return 'D';
  if (C > D) return 'C';
  return D >= 4 ? 'D' : 'C';
}

function opening(c: Ctx): Rule[] {
  const fourth = c.a.calls.length === 3;
  const out: Rule[] = [
    { call: B(2, 'C'), says: 'Strong and artificial: 22 or more points', hcp: R(22, 37), forcing: true, tag: '2c', alert: true },
    { call: B(2, 'N'), says: '20–21 points, balanced', hcp: R(20, 21), when: (v) => v.balanced },
    { call: B(1, 'N'), says: '15–17 points, balanced', hcp: R(15, 17), when: (v) => v.balanced },
  ];
  for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
    const min = isMajor(s) ? 5 : 3;
    out.push({
      call: B(1, s), says: `${isMajor(s) ? 'Five or more' : 'Three or more'} ${NAME[s]}, 12–21 points`,
      hcp: R(10, 21), read: R(12, 21), len: { [s]: [min, 13] },
      when: (v) => openingSuit(v) === s && (v.hcp >= 12 || (v.hcp >= 10 && v.hcp + twoLongest(v) >= 20))
        && (!fourth || v.hcp >= 12 || v.hcp + v.len.S >= 15),
    });
  }
  if (!fourth) {
    for (const s of ['S', 'H', 'D'] as Suit[]) {
      out.push({
        call: B(2, s), says: `Weak two: six ${NAME[s]}, 5–10 points`, hcp: R(5, 10), len: { [s]: [6, 6] },
        when: (v) => (v.top(s, 3) >= 2 || v.top(s, 5) >= 3) && MAJORS.every((m) => m === s || v.len[m] < 4),
      });
    }
    for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
      out.push({ call: B(4, s), says: `Pre-empt: eight ${NAME[s]}`, hcp: R(4, 10), len: { [s]: [8, 13] }, when: (v) => isMajor(s) && v.top(s, 5) >= 3 });
      out.push({ call: B(3, s), says: `Pre-empt: seven ${NAME[s]}, 5–10 points`, hcp: R(5, 10), len: { [s]: [7, 13] }, when: (v) => v.top(s, 5) >= 3 });
    }
  }
  out.push({ call: PASS, says: 'Not enough to open', hcp: R(0, 12) });
  return out;
}

const twoLongest = (v: View): number => {
  const l = SUITS.map((s) => v.len[s]).sort((a, b) => b - a);
  return (l[0] as number) + (l[1] as number);
};

/* ==================================================== RESPONSES TO NO-TRUMP */

/**
 * Stayman, transfers and the quantitative raises, for any natural no-trump
 * bid that showed `lo`–`hi` points. `level` is the level it was bid at.
 */
function ntResponses(c: Ctx, level: number, lo: number, hi: number): Rule[] {
  const game = 25 - lo;        // points for game opposite a minimum
  const invite = game - 2;     // worth a try
  const quant = 33 - hi;       // slam if partner is maximum
  const slam = 33 - lo;
  const L = level + 1;
  const out: Rule[] = [];
  const fiveMajor = (v: View): Suit | null => (v.len.S >= 5 && v.len.S >= v.len.H ? 'S' : v.len.H >= 5 ? 'H' : null);
  if (c.legal(B(L, 'D'))) {
    out.push({ call: B(L, 'D'), says: 'Transfer: five or more hearts', len: { H: [5, 13] }, when: (v) => fiveMajor(v) === 'H', forcing: true, tag: 'transfer:H', alert: true });
    out.push({ call: B(L, 'H'), says: 'Transfer: five or more spades', len: { S: [5, 13] }, when: (v) => fiveMajor(v) === 'S', forcing: true, tag: 'transfer:S', alert: true });
    out.push({
      call: B(L, 'C'), says: 'Stayman: asks for a four-card major', hcp: R(level === 1 ? invite : game - 1, 37),
      when: (v) => (v.len.H === 4 || v.len.S === 4) && !(v.len.H === 4 && v.len.S <= 3 && v.len.D === 3 && v.len.C === 3 && false),
      forcing: true, tag: 'stayman', alert: true,
    });
  }
  out.push({ call: B(6, 'N'), says: 'To play: enough for a small slam', hcp: R(slam, 37) });
  out.push({ call: B(4, 'N'), says: 'Invites six no-trump', hcp: R(quant, slam - 1), tag: 'quant' });
  out.push({ call: B(3, 'N'), says: 'To play', hcp: R(game, quant - 1) });
  if (level === 1) out.push({ call: B(2, 'N'), says: 'Invites game', hcp: R(invite, game - 1), tag: 'invite' });
  out.push({ call: PASS, says: 'Not enough for game', hcp: R(0, (level === 1 ? invite : game) - 1) });
  return out;
}

/** Partner opened or overcalled 1NT and the next hand came in: bid naturally. */
function ntInterfered(c: Ctx): Rule[] {
  const out: Rule[] = [];
  for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
    if (c.theirs.includes(s)) continue;
    const l = c.cheapest(s);
    if (l === 2) out.push({ call: B(2, s), says: `To play: five or more ${NAME[s]}`, hcp: R(0, 9), len: { [s]: [5, 13] } });
    if (isMajor(s) && c.legal(B(4, s))) out.push({ call: B(4, s), says: 'To play', hcp: R(10, 37), len: { [s]: [6, 13] } });
  }
  out.push({ call: B(3, 'N'), says: 'To play', hcp: R(10, 37), when: (v) => c.theirs.every((t) => v.stop(t)) });
  out.push({ call: PASS, says: 'Nothing to say', hcp: R(0, 9) });
  return out;
}

/* ============================================ RESPONSES TO ONE OF A SUIT */

function respondToOne(c: Ctx, x: Suit): Rule[] {
  const out: Rule[] = [];
  const rho = c.rhoCall;
  const overcall = rho?.type === 'bid' ? rho : null;
  const doubled = rho?.type === 'double';
  const need = isMajor(x) ? 3 : x === 'D' ? 4 : 5;
  const lvl = (s: Strain): number => c.cheapest(s);
  /* Two-over-one applies to an unpassed hand in an auction the opponents have stayed out of. */
  const twoOne = c.sys === '2/1' && !c.passedHand && (!rho || rho.type === 'pass');

  if (doubled) out.push({ call: RDBL, says: '10 or more points', hcp: R(10, 37), when: (v) => v.len[x] < need + 1, tag: 'rdbl' });

  if (overcall && isSuit(overcall.strain)) {
    const y = overcall.strain;
    /* The cue bid is the strong raise once they have come in. */
    out.push({
      call: B(lvl(y), y), says: `A good raise of ${NAME[x]}: 10 or more points with support`, hcp: R(10, 37), len: { [x]: [need, 13] },
      when: (v) => lvl(y) <= 3 && (isMajor(x) || !MAJORS.some((m) => m !== y && v.len[m] >= 5)),
      forcing: true, tag: 'cue-raise', alert: true,
    });
    if (lvl(x) === 2) out.push({ call: B(3, x), says: `Weak jump raise: four or more ${NAME[x]}, fewer than 6 points`, hcp: R(0, 5), len: { [x]: [Math.max(4, need), 13] }, when: (v) => v.short(x) >= 1, tag: 'preempt', alert: true });
    out.push({ call: B(lvl(x), x), says: `Raise: support for ${NAME[x]}, 6–10 points`, hcp: R(5, 10), len: { [x]: [need, 13] }, when: (v) => v.hcp + (v.len[x] >= need ? v.short(x) : 0) >= 6 });
    /* Negative double: the unbid majors, not enough to bid one freely. */
    const unbidMajors = MAJORS.filter((m) => m !== x && m !== y);
    if (unbidMajors.length > 0 && bidValue(overcall.level, y) <= bidValue(2, 'S')) {
      const min = overcall.level === 1 ? 6 : 8;
      const len = Object.fromEntries(unbidMajors.map((m) => [m, [4, 13] as Range]));
      out.push({
        call: DBL, says: `Negative double: four cards in ${unbidMajors.map((m) => NAME[m]).join(' and ')}`, hcp: R(min, 37), len,
        when: (v) => unbidMajors.every((m) => v.len[m] >= 4) && !unbidMajors.some((m) => v.len[m] >= 5 && (lvl(m) === 1 || v.hcp >= 10)),
        forcing: true, tag: 'negdbl', alert: true,
      });
    }
    for (const s of newSuits(x, [y])) {
      const l = lvl(s);
      if (l === 1) out.push({ call: B(1, s), says: `Four or more ${NAME[s]}, 6 or more points`, hcp: R(6, 37), len: { [s]: [4, 13] }, forcing: true, when: (v) => bestNewSuit(v, x, [y], c) === s });
      else if (l === 2) out.push({ call: B(2, s), says: `Five or more ${NAME[s]}, 10 or more points`, hcp: R(10, 37), len: { [s]: [5, 13] }, forcing: true, when: (v) => bestNewSuit(v, x, [y], c) === s });
    }
    out.push({ call: B(3, 'N'), says: 'To play: 13–15 with their suit stopped', hcp: R(13, 15), when: (v) => v.stop(y) });
    out.push({ call: B(2, 'N'), says: '11–12 with their suit stopped', hcp: R(11, 12), when: (v) => v.stop(y), tag: 'invite' });
    if (lvl('N') === 1) out.push({ call: B(1, 'N'), says: '8–10 with their suit stopped', hcp: R(8, 10), when: (v) => v.stop(y) });
    out.push({ call: PASS, says: 'Nothing to say', hcp: R(0, 9) });
    return out;
  }

  /* --- no overcall (they passed or doubled) --- */
  if (isMajor(x)) {
    if (!doubled) out.push({ call: B(2, 'N'), says: `Jacoby: four or more ${NAME[x]}, game values`, hcp: R(13, 37), len: { [x]: [4, 13] }, forcing: true, tag: 'jacoby2nt', alert: true });
    else out.push({ call: B(2, 'N'), says: `A good raise: four or more ${NAME[x]}, 10 or more points`, hcp: R(10, 37), len: { [x]: [4, 13] }, forcing: true, tag: 'cue-raise', alert: true });
    out.push({ call: B(4, x), says: `Pre-emptive: five or more ${NAME[x]}, weak`, hcp: R(0, 9), len: { [x]: [5, 13] }, when: (v) => v.short(x) >= 3 });
    if (!doubled) out.push({ call: B(3, x), says: `Weak jump raise: four or more ${NAME[x]}, fewer than 6 points`, hcp: R(0, 5), len: { [x]: [4, 13] }, when: (v) => v.short(x) >= 1, tag: 'preempt', alert: true });
    else out.push({ call: B(3, x), says: `Weak jump raise: four or more ${NAME[x]}, fewer than 6 points`, hcp: R(0, 5), len: { [x]: [4, 13] }, when: (v) => v.short(x) >= 1, tag: 'preempt', alert: true });
    out.push({ call: B(2, x), says: `Raise: three or more ${NAME[x]}, 6–10 points`, hcp: R(5, 10), len: { [x]: [3, 13] }, when: (v) => { const p = v.hcp + v.short(x); return p >= 6 && p <= 10; } });
  }
  for (const s of newSuits(x, [])) {
    const l = lvl(s);
    if (l === 1) out.push({ call: B(1, s), says: `Four or more ${NAME[s]}, 6 or more points`, hcp: R(6, 37), len: { [s]: [4, 13] }, forcing: true, when: (v) => bestNewSuit(v, x, [], c) === s });
    else if (l === 2 && twoOne) out.push({ call: B(2, s), says: `Game forcing: four or more ${NAME[s]}, 12 or more points`, hcp: R(12, 37), len: { [s]: [s === 'H' ? 5 : 4, 13] }, forcing: true, tag: 'gf', when: (v) => bestNewSuit(v, x, [], c, 12) === s });
    else if (l === 2) out.push({ call: B(2, s), says: `Four or more ${NAME[s]}, 10 or more points`, hcp: R(10, 37), len: { [s]: [s === 'H' ? 5 : 4, 13] }, forcing: true, when: (v) => bestNewSuit(v, x, [], c) === s });
  }
  if (!isMajor(x)) {
    const noMajor = (v: View): boolean => v.len.H < 4 && v.len.S < 4;
    if (!doubled) out.push({ call: B(3, x), says: `Weak jump raise: four or more ${NAME[x]}, fewer than 6 points`, hcp: R(0, 5), len: { [x]: [Math.max(5, need), 13] }, when: (v) => v.short(x) >= 1 && noMajor(v), tag: 'preempt', alert: true });
    out.push({ call: B(2, x), says: `Raise: 6–10 points with ${NAME[x]}`, hcp: R(6, 10), len: { [x]: [need, 13] }, when: noMajor });
  }
  out.push({ call: B(3, 'N'), says: '16–18 points, balanced', hcp: R(16, 18), when: (v) => v.balanced });
  if (isMajor(x) && !doubled) {
    /* Game values and nothing to bid naturally: a minor, even on three cards, to keep the bidding open. */
    /* In Standard American an invitational hand with support has no jump raise:
       it bids a new suit and raises next time. */
    const open = 13;
    const supported = (v: View): boolean => c.sys === 'sayc' && v.len[x] >= 3 && v.hcp + v.short(x) >= 11;
    for (const s of ['C', 'D'] as Suit[]) {
      if (lvl(s) === 2) out.push({
        call: B(2, s),
        says: twoOne ? `Game forcing: 13 or more points; may be only three ${NAME[s]}` : `Forcing: 10 or more points; may be only three ${NAME[s]}`,
        hcp: R(twoOne ? 13 : 9, 37), len: { [s]: [3, 13] }, forcing: true, ...(twoOne ? { tag: 'gf' } : {}),
        when: (v) => v.len[s] >= 3 && (s === 'C' ? v.len.C >= v.len.D : true) && (v.hcp >= open || supported(v)),
      });
    }
  }
  if (!isMajor(x) || true) out.push({ call: B(2, 'N'), says: '13–15 points, balanced, forcing to game', hcp: R(13, 15), when: (v) => v.balanced && !isMajor(x), forcing: true });
  if (twoOne && isMajor(x)) out.push({ call: B(1, 'N'), says: 'Forcing: 6–12 points, no suit to show at the one level', hcp: R(6, 12), forcing: true, tag: '1ntf', alert: true });
  out.push({ call: B(1, 'N'), says: '6–10 points, no suit to show at the one level', hcp: R(6, 10) });
  /* 11–12 with nowhere to go: the least misleading thing left. */
  out.push({ call: B(2, 'N'), says: '11–12 points, balanced', hcp: R(11, 12), when: (v) => !isMajor(x) || v.len[x] < 3, tag: 'invite' });
  out.push({ call: PASS, says: 'Fewer than 6 points', hcp: R(0, 5) });
  return out;
}

/** Suits that would be new: not partner's, not theirs. */
const newSuits = (x: Suit, theirs: Suit[]): Suit[] => (['C', 'D', 'H', 'S'] as Suit[]).filter((s) => s !== x && !theirs.includes(s));

/**
 * The suit to respond in: the longest, the higher of two five-card suits, the
 * cheaper of two fours. A suit that has to be bid at the two level needs ten
 * points (and five cards if it is hearts over spades, or after an overcall).
 */
function bestNewSuit(v: View, x: Suit, theirs: Suit[], c: Ctx, twoLevel = 10): Suit | null {
  const able = newSuits(x, theirs).filter((s) => {
    const l = c.cheapest(s);
    if (l === 1) return v.len[s] >= 4 && v.hcp >= 6;
    if (l === 2) return v.hcp >= twoLevel && v.len[s] >= (theirs.length > 0 || (s === 'H' && x === 'S') ? 5 : 4);
    return false;
  });
  if (able.length === 0) return null;
  /* With a major to show at the one level, a weak hand skips the diamonds. */
  const longest = Math.max(...able.map((s) => v.len[s]));
  const cands = able.filter((s) => v.len[s] === longest);
  if (longest >= 5) return cands.sort((p, q) => SUITS.indexOf(q) - SUITS.indexOf(p))[0] as Suit;
  const oneLevel = cands.filter((s) => c.cheapest(s) === 1);
  const pool = oneLevel.length ? oneLevel : cands;
  const majors = pool.filter(isMajor);
  if (v.hcp < 11 && majors.length) return majors.sort((p, q) => SUITS.indexOf(p) - SUITS.indexOf(q))[0] as Suit;
  return pool.sort((p, q) => SUITS.indexOf(p) - SUITS.indexOf(q))[0] as Suit;
}

/* ===================================== RESPONSES TO 2♣, WEAK TWOS, PRE-EMPTS */

function respondTo2C(): Rule[] {
  const out: Rule[] = [];
  for (const s of ['S', 'H'] as Suit[]) out.push({ call: B(2, s), says: `Five or more ${NAME[s]}, 8 or more points`, hcp: R(8, 37), len: { [s]: [5, 13] }, when: (v) => v.top(s, 3) >= 2, forcing: true });
  for (const s of ['D', 'C'] as Suit[]) out.push({ call: B(3, s), says: `Five or more ${NAME[s]}, 8 or more points`, hcp: R(8, 37), len: { [s]: [5, 13] }, when: (v) => v.top(s, 3) >= 2, forcing: true });
  out.push({ call: B(2, 'N'), says: '8 or more points, balanced', hcp: R(8, 37), when: (v) => v.balanced, forcing: true });
  out.push({ call: B(2, 'D'), says: 'Waiting: says nothing about diamonds', hcp: R(0, 37), forcing: true, tag: 'waiting', alert: true });
  return out;
}

function respondToPreempt(c: Ctx, level: number, x: Suit): Rule[] {
  const out: Rule[] = [];
  const game = isMajor(x) ? 4 : 5;
  if (isMajor(x) && level < 4) {
    out.push({ call: B(4, x), says: 'To play', hcp: R(0, 37), len: { [x]: [2, 13] }, when: (v) => (v.len[x] >= 2 && v.hcp >= 16) || (v.len[x] >= 4 && v.short(x) >= 3) });
  }
  if (!isMajor(x)) out.push({ call: B(3, 'N'), says: 'To play', hcp: R(16, 37), when: (v) => SUITS.every((s) => s === x || v.stop(s)) && v.len[x] >= 2 });
  if (level === 2) out.push({ call: B(3, x), says: 'Pre-emptive raise', hcp: R(0, 13), len: { [x]: [3, 13] }, when: (v) => v.hcp >= 5, tag: 'preempt' });
  void game;
  out.push({ call: PASS, says: 'Nothing to add', hcp: R(0, 15) });
  return out;
}

/* ========================================================== THEY OPENED */

function defensive(c: Ctx): Rule[] {
  const out: Rule[] = [];
  const last = c.last;
  if (!last || sideOf(last.seat) === sideOf(c.me)) return [{ call: PASS, says: 'Pass' }];
  const balancing = c.a.calls.slice(-2).every((e) => e.call.type === 'pass') && c.a.calls.length >= 3;
  const light = balancing ? 3 : 0;
  const theirs = c.theirs;
  const unbid = (['S', 'H', 'D', 'C'] as Suit[]).filter((s) => !theirs.includes(s));

  /* Over their no-trump: a good suit, or a penalty double with a strong hand. */
  if (last.strain === 'N' && theirs.length === 0) {
    if (last.level === 1) out.push({ call: DBL, says: 'Penalty: 16 or more points', hcp: R(16, 37), tag: 'penalty' });
    for (const s of unbid) {
      if (c.cheapest(s) === 2) out.push({ call: B(2, s), says: `Natural: six ${NAME[s]}, or a good five`, hcp: R(9, 15), len: { [s]: [5, 13] }, when: (v) => v.len[s] >= 6 || (v.top(s, 5) >= 3 && v.hcp >= 12) });
    }
    out.push({ call: PASS, says: 'Pass' });
    return out;
  }

  const simple = theirs.length === 1;      // only their opening suit so far
  const t = theirs[0] as Suit;

  if (simple && last.level === 1 && last.strain !== 'N') {
    out.push({ call: B(1, 'N'), says: `${15 - light}–${18 - light} points, balanced, their suit stopped`, hcp: R(15 - light, 18 - light), when: (v) => v.balanced && v.stop(t), tag: 'nt-overcall' });
    if (!isMajor(t) && !balancing) out.push({ call: B(2, t), says: 'Michaels: five hearts and five spades', hcp: R(7, 37), len: { H: [5, 13], S: [5, 13] }, forcing: true, tag: 'michaels', alert: true });
    const low = unbid.slice().sort((p, q) => SUITS.indexOf(p) - SUITS.indexOf(q)).slice(0, 2) as [Suit, Suit];
    if (!balancing) out.push({ call: B(2, 'N'), says: `Unusual: five ${NAME[low[0]]} and five ${NAME[low[1]]}`, hcp: R(7, 37), len: { [low[0]]: [5, 13], [low[1]]: [5, 13] }, forcing: true, tag: `unusual:${low[0]}${low[1]}`, alert: true });
  }

  /* A hand too strong for a simple overcall doubles first. */
  if (last.level <= 3) {
    const min = (last.level === 1 ? 12 : last.level === 2 ? 13 : 15) - light;
    const len = Object.fromEntries(unbid.map((s) => [s, [3, 13] as Range]));
    out.push({
      call: DBL, says: `Take-out: support for the unbid suits, ${min} or more points`, hcp: R(min, 37), len,
      when: (v) => theirs.every((s) => v.len[s] <= 2 || (v.len[s] === 3 && v.hcp >= 15)) && unbid.every((s) => v.len[s] >= 3)
        && !(unbid.some((s) => isMajor(s) && v.len[s] >= 5 && v.hcp <= 16)),
      forcing: true, tag: 'takeout',
    });
    out.push({ call: DBL, says: 'Take-out: a strong hand', hcp: R(17, 37), len: Object.fromEntries(unbid.map((s) => [s, [2, 13] as Range])), when: (v) => !(v.balanced && v.hcp <= 18 && theirs.every((s) => v.stop(s))), forcing: true, tag: 'takeout' });
  }

  for (const s of unbid.slice().sort((p, q) => SUITS.indexOf(q) - SUITS.indexOf(p))) {
    const l = c.cheapest(s);
    if (!l) continue;
    const best = (v: View): boolean => unbid.every((o) => v.len[o] < v.len[s] || (v.len[o] === v.len[s] && SUITS.indexOf(o) <= SUITS.indexOf(s)));
    if (l === 1) out.push({ call: B(1, s), says: `Overcall: five or more ${NAME[s]}, 8–16 points`, hcp: R(8 - light, 16), len: { [s]: [5, 13] }, when: (v) => best(v) && (v.top(s, 5) >= 2 || v.hcp >= 11) });
    else if (l === 2) out.push({ call: B(2, s), says: `Overcall: five or more ${NAME[s]}, 11–16 points`, hcp: R(11 - light, 16), len: { [s]: [5, 13] }, when: (v) => best(v) && (v.len[s] >= 6 || v.top(s, 5) >= 3) });
    else if (l === 3) out.push({ call: B(3, s), says: `Overcall: six or more ${NAME[s]}, opening values`, hcp: R(12, 17), len: { [s]: [6, 13] }, when: (v) => best(v) && v.top(s, 5) >= 3 });
    /* Weak jump overcalls. */
    if (simple && !balancing && l <= 2 && c.legal(B(l + 1, s))) {
      out.push({ call: B(l + 1, s), says: `Weak jump: ${l === 1 ? 'six' : 'seven'} ${NAME[s]}, 5–10 points`, hcp: R(5, 10), len: { [s]: [l === 1 ? 6 : 7, 13] }, when: (v) => v.top(s, 5) >= 3 && (l === 1 ? v.len[s] === 6 : true) });
    }
  }
  if (simple && last.level === 2) out.push({ call: B(2, 'N'), says: '15–18 points, balanced, their suit stopped', hcp: R(15, 18), when: (v) => v.balanced && v.stop(t), tag: 'nt-overcall' });
  if (simple && last.level === 3) out.push({ call: B(3, 'N'), says: 'To play: their suit stopped', hcp: R(16, 37), when: (v) => v.stop(t) && v.semi });
  out.push({ call: PASS, says: 'Pass' });
  return out;
}

/* ============================================ PARTNER OVERCALLED OR DOUBLED */

function advanceOvercall(c: Ctx, p: Suit, level: number): Rule[] {
  const out: Rule[] = [];
  const t = c.theirs[0];
  if (t) {
    const l = c.cheapest(t);
    if (l && l <= 3) out.push({ call: B(l, t), says: `A good raise of ${NAME[p]}: 11 or more points with support`, hcp: R(11, 37), len: { [p]: [3, 13] }, forcing: true, tag: 'cue-raise', alert: true });
  }
  if (c.legal(B(level + 2, p)) && level + 2 <= 4) out.push({ call: B(level + 2, p), says: 'Pre-emptive raise: four or more trumps, weak', hcp: R(0, 8), len: { [p]: [4, 13] }, when: (v) => v.hcp >= 3 && v.short(p) >= 1, tag: 'preempt' });
  if (c.cheapest(p) === level + 1) out.push({ call: B(level + 1, p), says: `Raise: three or more ${NAME[p]}, 6–10 points`, hcp: R(6, 10), len: { [p]: [3, 13] } });
  for (const s of (['S', 'H', 'D', 'C'] as Suit[])) {
    if (s === p || c.theirs.includes(s)) continue;
    const l = c.cheapest(s);
    if (l === 1 || l === 2) out.push({ call: B(l, s), says: `Five or more ${NAME[s]}, ${l === 1 ? 8 : 10} or more points`, hcp: R(l === 1 ? 8 : 10, 16), len: { [s]: [5, 13] }, when: (v) => v.len[p] <= 2 && v.top(s, 5) >= 2 });
  }
  const stopped = (v: View): boolean => c.theirs.every((s) => v.stop(s));
  out.push({ call: B(3, 'N'), says: 'To play', hcp: R(15, 37), when: stopped });
  out.push({ call: B(2, 'N'), says: '12–14 points, their suit stopped', hcp: R(12, 14), when: stopped, tag: 'invite' });
  if (c.cheapest('N') === 1) out.push({ call: B(1, 'N'), says: '8–11 points, their suit stopped', hcp: R(8, 11), when: stopped });
  out.push({ call: PASS, says: 'Nothing to say', hcp: R(0, 10) });
  return out;
}

function advanceDouble(c: Ctx): Rule[] {
  const out: Rule[] = [];
  const theirs = c.theirs;
  const unbid = (['S', 'H', 'D', 'C'] as Suit[]).filter((s) => !theirs.includes(s));
  const free = c.rhoCall?.type === 'bid';   // the next hand bid, so I need not
  const best = (v: View): Suit => unbid.slice().sort((p, q) => (v.len[q] - v.len[p]) || (Number(isMajor(q)) - Number(isMajor(p))) || (SUITS.indexOf(p) - SUITS.indexOf(q)))[0] as Suit;
  const stopped = (v: View): boolean => theirs.every((s) => v.stop(s));
  const t = theirs[0] as Suit;

  if (!free) out.push({ call: PASS, says: 'Converts the double to penalties', len: { [t]: [5, 13] }, when: (v) => v.len[t] >= 5 && v.top(t, 5) >= 3, tag: 'final' });
  for (const s of MAJORS) {
    if (unbid.includes(s) && c.legal(B(4, s))) out.push({ call: B(4, s), says: 'To play', hcp: R(11, 37), len: { [s]: [4, 13] }, when: (v) => best(v) === s && (v.len[s] >= 5 || v.hcp >= 13) && v.hcp + v.short(s) >= 13 });
  }
  out.push({ call: B(3, 'N'), says: 'To play: their suit stopped', hcp: R(13, 37), when: (v) => stopped(v) && !MAJORS.some((m) => unbid.includes(m) && v.len[m] >= 4) });
  { const l = c.cheapest(t); if (l && l <= 3) out.push({ call: B(l, t), says: 'Strong: asks the doubler to choose', hcp: R(12, 37), forcing: true, tag: 'cue', alert: true }); }
  for (const s of unbid) {
    const l = c.cheapest(s);
    if (l && c.legal(B(l + 1, s)) && l + 1 <= 3) out.push({ call: B(l + 1, s), says: `Jump: four or more ${NAME[s]}, 9–11 points`, hcp: R(9, 11), len: { [s]: [4, 13] }, when: (v) => best(v) === s, tag: 'invite' });
  }
  out.push({ call: B(2, 'N'), says: '11–12 points, their suit stopped', hcp: R(11, 12), when: stopped, tag: 'invite' });
  if (c.cheapest('N') === 1) out.push({ call: B(1, 'N'), says: '6–10 points, their suit stopped', hcp: R(6, 10), when: (v) => stopped(v) && !MAJORS.some((m) => unbid.includes(m) && v.len[m] >= 4) });
  for (const s of unbid) {
    const l = c.cheapest(s);
    if (!l || l > 3) continue;
    const top = c.legal(B(l + 1, s)) && l + 1 <= 3 ? (free ? 9 : 8) : 11;   // no room to jump: the range stretches
    out.push({ call: B(l, s), says: `${free ? 6 : 0}–${top} points, best suit ${NAME[s]}`, hcp: R(free ? 6 : 0, top), len: { [s]: [free ? 4 : 3, 13] }, when: (v) => best(v) === s });
  }
  if (free) out.push({ call: PASS, says: 'Nothing to say', hcp: R(0, 5) });
  else for (const s of unbid) { const l = c.cheapest(s); if (l) out.push({ call: B(l, s), says: `Best suit ${NAME[s]}`, when: (v) => best(v) === s, fb: true }); }
  if (free) out.push({ call: PASS, says: 'Nothing to say', fb: true });
  return out;
}

/** Partner showed two suits (Michaels or the unusual no-trump): choose one. */
function advanceTwoSuiter(c: Ctx, suits: Suit[]): Rule[] {
  const out: Rule[] = [];
  const pick = (v: View): Suit => suits.slice().sort((p, q) => (v.len[q] - v.len[p]) || (c.cheapest(p) - c.cheapest(q)) || (SUITS.indexOf(p) - SUITS.indexOf(q)))[0] as Suit;
  for (const s of suits) {
    if (isMajor(s) && c.legal(B(4, s))) out.push({ call: B(4, s), says: 'To play', hcp: R(12, 37), len: { [s]: [3, 13] }, when: (v) => pick(v) === s });
    const l = c.cheapest(s);
    if (l) out.push({ call: B(l, s), says: `Prefers ${NAME[s]}`, hcp: R(0, 11), when: (v) => pick(v) === s });
  }
  return out;
}

/* ============================================================ LATER ROUNDS */

function rebid(c: Ctx): Rule[] {
  const mine = c.acts(c.me);
  const pds = c.acts(c.pd);
  const pdLast = c.by(c.pd).at(-1);
  const myLast = mine.at(-1) as { e: AuctionEntry; i: number };
  const pdTag = pdLast ? c.tagOf(pdLast.i) : '';
  const myTag = c.tagOf(myLast.i);
  const pdCall = pdLast?.e.call;
  const quiet = !c.rhoCall || c.rhoCall.type === 'pass';

  if (pdTag === 'final') return [{ call: PASS, says: 'Pass' }];
  if (pdCall?.type === 'double' && pdTag === 'penalty') return [{ call: PASS, says: 'Leaves the double in' }];

  /* ---- answers to partner's conventional calls ---- */
  if (pdCall?.type === 'bid' && quiet) {
    if (pdTag === 'stayman') {
      const L = pdCall.level;
      return [
        { call: B(L, 'H'), says: 'Four hearts', len: { H: [4, 5] }, tag: 'stayans' },
        { call: B(L, 'S'), says: 'Four spades, fewer than four hearts', len: { S: [4, 5], H: [0, 3] }, tag: 'stayans' },
        { call: B(L, 'D'), says: 'No four-card major', len: { H: [0, 3], S: [0, 3] }, tag: 'stayans', alert: true },
      ];
    }
    if (pdTag.startsWith('transfer:')) {
      const s = pdTag.slice(9) as Suit;
      return [{ call: B(c.cheapest(s), s), says: 'Completes the transfer', tag: 'accept' }];
    }
    if (pdTag === 'blackwood') {
      return (['C', 'D', 'H', 'S'] as Suit[]).map((s, n) => ({
        call: B(5, s), says: n === 0 ? 'No ace, or all four' : `${n} ace${n === 1 ? '' : 's'}`, when: (v: View) => v.aces % 4 === n, tag: `aces:${n}`, alert: true,
      }));
    }
    if (pdTag === 'jacoby2nt' && myLast.e.call.type === 'bid' && isSuit(myLast.e.call.strain)) {
      const x = myLast.e.call.strain;
      return [
        { call: B(3, x), says: '18 or more points', hcp: R(18, 21) },
        { call: B(3, 'N'), says: '15–17 points', hcp: R(15, 17) },
        { call: B(4, x), says: 'A minimum opening', hcp: R(0, 14), read: R(12, 14) },
      ];
    }
    if (pdTag === 'waiting') {
      const out: Rule[] = [
        { call: B(3, 'N'), says: '25–27 points, balanced', hcp: R(25, 27), when: (v) => v.balanced },
        { call: B(2, 'N'), says: '22–24 points, balanced', hcp: R(22, 24), when: (v) => v.balanced, tag: 'nt22' },
      ];
      for (const s of ['S', 'H'] as Suit[]) out.push({ call: B(2, s), says: `Five or more ${NAME[s]}`, len: { [s]: [5, 13] }, when: (v) => openingSuit(v) === s, forcing: true });
      for (const s of ['D', 'C'] as Suit[]) out.push({ call: B(3, s), says: `Five or more ${NAME[s]}`, len: { [s]: [5, 13] }, when: (v) => openingSuit(v) === s, forcing: true });
      out.push({ call: B(2, 'N'), says: '22–24 points', hcp: R(22, 24), tag: 'nt22' });
      return out;
    }
    if (pdTag === 'cue-raise' && myLast.e.call.type === 'bid' && isSuit(myLast.e.call.strain)) {
      const x = myLast.e.call.strain;
      const opened = c.opener === c.me;
      const extra = opened ? 14 : 13;
      const out: Rule[] = [];
      if (isMajor(x)) out.push({ call: B(4, x), says: 'Accepts: enough for game', hcp: R(extra - 1, 37), when: (v) => v.lp >= extra });
      else out.push({ call: B(3, 'N'), says: 'Accepts: enough for game', hcp: R(extra, 37), when: (v) => c.theirs.every((s) => v.stop(s)) });
      out.push({ call: B(c.cheapest(x), x), says: 'A minimum', hcp: R(0, extra) });
      return out;
    }
    if (pdTag === 'cue') {
      /* Partner asked me to pick again after my take-out double. */
      return place(c);
    }
  }
  if (pdCall?.type === 'double' && pdTag === 'negdbl' && quiet) return answerNegativeDouble(c);
  if (pdCall?.type === 'double' && pdTag === 'takeout' && quiet) return advanceDouble(c);

  /* ---- partner answered mine ---- */
  if (myTag === 'stayman' && pdTag === 'stayans' && pdCall?.type === 'bid') return afterStayman(c, pdCall);
  if (myTag.startsWith('transfer:') && pdTag === 'accept') return afterTransfer(c, myTag.slice(9) as Suit);
  if (myTag === 'blackwood' && pdTag.startsWith('aces:')) return afterBlackwood(c, Number(pdTag.slice(5)));
  if (myTag === 'takeout' && mine.length === 1 && pdCall?.type === 'bid' && isSuit(pdCall.strain) && pdTag !== 'cue') {
    /* The doubler speaks again only with a hand too good for the first double to have shown. */
    const y = pdCall.strain;
    const out: Rule[] = [];
    if (isMajor(y) && c.legal(B(4, y))) out.push({ call: B(4, y), says: 'Support and 20 or more points', hcp: R(20, 37), len: { [y]: [4, 13] }, when: (v) => v.hcp + v.short(y) >= 21 });
    for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
      const l = c.cheapest(s);
      if (s !== y && !c.theirs.includes(s) && l && l <= 3) out.push({ call: B(l, s), says: `A strong hand with five or more ${NAME[s]}`, hcp: R(17, 37), len: { [s]: [5, 13] }, tag: 'invite' });
    }
    { const l = c.cheapest(y); if (l && l <= 3) out.push({ call: B(l, y), says: 'Support and 16–19 points: invites game', hcp: R(16, 19), len: { [y]: [4, 13] }, when: (v) => v.hcp + v.short(y) >= 17, tag: 'invite' }); }
    { const l = c.cheapest('N'); if (l && l <= 2) out.push({ call: B(l, 'N'), says: '18–20 points, their suit stopped', hcp: R(18, 20), when: (v) => c.theirs.every((t) => v.stop(t)), tag: 'invite' }); }
    if (c.cheapest('N') === 3) out.push({ call: B(3, 'N'), says: 'To play: 18 or more points, their suit stopped', hcp: R(18, 37), when: (v) => c.theirs.every((t) => v.stop(t)) });
    return [...out, ...lastResort(place(c))];
  }
  if (myTag.startsWith('unusual:') || myTag === 'michaels') return [{ call: PASS, says: 'Pass', when: (v) => v.hcp < 17 }, ...lastResort(place(c))];

  /* ---- the no-trump bidder after an invitation ---- */
  if (pdTag === 'quant') return [{ call: B(6, 'N'), says: 'Accepts: a maximum', when: (v) => v.hcp > mid(c.know[c.me].hcp) }, { call: PASS, says: 'Declines: a minimum' }];

  /* ---- opener's second call after a natural response ---- */
  if (c.opener === c.me && mine.length === 1 && pds.length === 1 && myLast.e.call.type === 'bid' && myLast.e.call.level === 1
      && isSuit(myLast.e.call.strain) && pdCall?.type === 'bid' && pdTag !== 'negdbl') {
    return [...openerRebid(c, myLast.e.call.strain, pdCall), ...lastResort(place(c))];
  }
  return place(c);
}

function answerNegativeDouble(c: Ctx): Rule[] {
  const out: Rule[] = [];
  const mine = c.acts(c.me)[0]?.e.call;
  const x = mine?.type === 'bid' && isSuit(mine.strain) ? mine.strain : 'C';
  const majors = MAJORS.filter((m) => m !== x && !c.theirs.includes(m));
  for (const m of majors) {
    const l = c.cheapest(m);
    if (!l) continue;
    if (c.legal(B(4, m))) out.push({ call: B(4, m), says: `Four ${NAME[m]}, 19 or more points`, hcp: R(18, 21), len: { [m]: [4, 13] }, when: (v) => v.lp >= 19 });
    if (c.legal(B(l + 1, m))) out.push({ call: B(l + 1, m), says: `Four ${NAME[m]}, 16–18 points`, hcp: R(15, 18), len: { [m]: [4, 13] }, when: (v) => v.lp >= 16, tag: 'invite' });
    out.push({ call: B(l, m), says: `Four ${NAME[m]}, a minimum`, hcp: R(0, 15), read: R(12, 15), len: { [m]: [4, 13] } });
  }
  const stopped = (v: View): boolean => c.theirs.every((s) => v.stop(s));
  out.push({ call: B(3, 'N'), says: '18 or more points, their suit stopped', hcp: R(18, 21), when: stopped });
  if (c.legal(B(3, x)) && c.cheapest(x) <= 2) out.push({ call: B(3, x), says: `Six ${NAME[x]}, 16 or more points`, hcp: R(16, 21), len: { [x]: [6, 13] }, tag: 'invite' });
  if (c.cheapest('N') === 1) out.push({ call: B(1, 'N'), says: '12–14 points, their suit stopped', hcp: R(0, 14), read: R(12, 14), when: stopped });
  out.push({ call: B(c.cheapest(x), x), says: `Rebids ${NAME[x]}`, hcp: R(0, 15), read: R(12, 15), len: { [x]: [5, 13] }, when: (v) => v.len[x] >= 5 });
  for (const s of (['C', 'D'] as Suit[])) {
    if (s !== x && !c.theirs.includes(s) && c.cheapest(s) && c.cheapest(s) <= 2) out.push({ call: B(c.cheapest(s), s), says: `Four or more ${NAME[s]}`, len: { [s]: [4, 13] } });
  }
  out.push({ call: B(c.cheapest(x), x), says: `Rebids ${NAME[x]}` });
  return out;
}

function afterStayman(c: Ctx, answer: Call & { type: 'bid' }): Rule[] {
  const pd = c.know[c.pd].hcp;
  const game = 25 - pd[0];
  const L = answer.level;
  const out: Rule[] = [];
  out.push({ call: B(6, 'N'), says: 'To play: enough for a small slam', hcp: R(33 - pd[0], 37), tag: 'final' });
  if (isMajor(answer.strain)) {
    const m = answer.strain;
    out.push({ call: B(4, m), says: 'To play: a fit, and enough for game', hcp: R(game, 37), len: { [m]: [4, 4] }, when: (v) => v.len[m] >= 4 });
    if (L === 2) out.push({ call: B(3, m), says: 'A fit: invites game', hcp: R(game - 2, game - 1), len: { [m]: [4, 4] }, when: (v) => v.len[m] >= 4, tag: 'invite' });
  }
  out.push({ call: B(3, 'N'), says: 'To play', hcp: R(game, 37) });
  if (L === 2) out.push({ call: B(2, 'N'), says: 'Invites game', hcp: R(game - 2, game - 1), tag: 'invite' });
  out.push({ call: PASS, says: 'Pass' });
  return out;
}

function afterTransfer(c: Ctx, m: Suit): Rule[] {
  const pd = c.know[c.pd].hcp;
  const game = 25 - pd[0];
  const accepted = c.last?.level ?? 2;
  const out: Rule[] = [];
  out.push({ call: B(6, m), says: 'To play: enough for a small slam', hcp: R(33 - pd[0] - 1, 37), len: { [m]: [6, 13] }, tag: 'final' });
  out.push({ call: B(6, 'N'), says: 'To play: enough for a small slam', hcp: R(33 - pd[0], 37), tag: 'final' });
  out.push({ call: B(4, m), says: 'To play: six or more trumps', hcp: R(game - 1, 37), len: { [m]: [6, 13] } });
  if (accepted === 2) out.push({ call: B(3, m), says: 'Six trumps: invites game', hcp: R(game - 3, game - 2), len: { [m]: [6, 13] }, tag: 'invite' });
  out.push({ call: B(3, 'N'), says: 'Exactly five trumps, enough for game: choose', hcp: R(game, 37), len: { [m]: [5, 5] }, tag: 'choice' });
  if (accepted === 2) out.push({ call: B(2, 'N'), says: 'Exactly five trumps: invites game', hcp: R(game - 2, game - 1), len: { [m]: [5, 5] }, tag: 'invite-choice' });
  out.push({ call: PASS, says: 'To play', hcp: R(0, game - 3) });
  return out;
}

function afterBlackwood(c: Ctx, shown: number): Rule[] {
  const fit = findFit(c);
  const strain: Strain = fit ?? 'N';
  return [
    { call: B(6, strain), says: 'To play', when: (v) => { const n = shown === 0 && v.aces <= 1 ? 4 : shown; return v.aces + n >= 3; }, tag: 'final' },
    ...(c.legal(B(5, strain)) ? [{ call: B(5, strain), says: 'To play: two aces are missing', tag: 'final' } as Rule] : []),
    { call: PASS, says: 'To play', when: () => c.last?.strain === strain, tag: 'final' },
    { call: B(6, strain), says: 'To play', tag: 'final' },
  ];
}

/* ------------------------------------------------------- opener's rebid */

function openerRebid(c: Ctx, x: Suit, r: Call & { type: 'bid' }): Rule[] {
  const out: Rule[] = [];
  const cheap = (s: Strain): number => c.cheapest(s);
  const rTag = c.tagOf((c.by(c.pd).at(-1) as { i: number }).i);

  /* Partner raised. */
  if (r.strain === x) {
    if (rTag === 'preempt') {
      if (isMajor(x) && r.level < 4) out.push({ call: B(4, x), says: '19 or more points', hcp: R(19, 21) });
      out.push({ call: PASS, says: 'Pass' });
      return out;
    }
    if (r.level === 2) {
      if (isMajor(x)) {
        out.push({ call: B(4, x), says: '19 or more points', hcp: R(18, 21), when: (v) => v.lp + (v.short(x) > 2 ? 1 : 0) >= 19 });
        out.push({ call: B(3, x), says: 'Invites game: 16–18 points', hcp: R(15, 18), when: (v) => v.lp >= 16, tag: 'invite' });
      } else {
        out.push({ call: B(3, 'N'), says: '18–19 points, balanced', hcp: R(18, 19), when: (v) => v.balanced });
        out.push({ call: B(2, 'N'), says: 'Invites game', hcp: R(16, 17), when: (v) => v.semi, tag: 'invite' });
      }
      out.push({ call: PASS, says: 'A minimum', hcp: R(0, 15), read: R(12, 15) });
    } else if (r.level === 3) {
      if (isMajor(x)) out.push({ call: B(4, x), says: 'Accepts the invitation', hcp: R(13, 21), when: (v) => v.lp >= 14 || v.hcp >= 13 });
      else out.push({ call: B(3, 'N'), says: 'Accepts the invitation', hcp: R(14, 21), when: (v) => v.semi || v.hcp >= 16 });
      out.push({ call: PASS, says: 'Declines: a minimum', hcp: R(0, 13), read: R(12, 13) });
    } else out.push({ call: PASS, says: 'Pass' });
    return out;
  }

  if (r.strain === 'N') {
    if (r.level === 1) {
      for (const s of SUITS) if (s !== x && SUITS.indexOf(s) > SUITS.indexOf(x)) out.push({ call: B(2, s), says: `Reverse: 17 or more points, four ${NAME[s]}`, hcp: R(17, 21), len: { [s]: [4, 13], [x]: [5, 13] }, when: (v) => v.len[x] > v.len[s], forcing: true });
      for (const s of SUITS) if (s !== x && SUITS.indexOf(s) < SUITS.indexOf(x)) out.push({ call: B(3, s), says: `Jump shift: 19 or more points, four or more ${NAME[s]}`, hcp: R(19, 21), len: { [s]: [4, 13], [x]: [5, 13] }, when: (v) => !v.semi, forcing: true, tag: c.sys === '2/1' ? 'gf' : '' });
      out.push({ call: B(3, 'N'), says: '19–21 points', hcp: R(19, 21) });
      out.push({ call: B(2, 'N'), says: 'Invites game: 18–19 points', hcp: R(17, 19), when: (v) => v.semi && v.hcp >= 18, tag: 'invite' });
      out.push({ call: B(3, x), says: `Six ${NAME[x]}, 16–18 points`, hcp: R(15, 18), len: { [x]: [6, 13] }, when: (v) => v.lp >= 17, tag: 'invite' });
      const mustBid = rTag === '1ntf';
      for (const s of SUITS) if (s !== x && SUITS.indexOf(s) < SUITS.indexOf(x)) out.push({ call: B(2, s), says: `Four or more ${NAME[s]}`, hcp: R(0, 18), read: R(12, 18), len: { [s]: [4, 13], [x]: [5, 13] }, when: (v) => mustBid || !v.balanced });
      out.push({ call: B(2, x), says: `Six ${NAME[x]}, a minimum`, hcp: R(0, 15), read: R(12, 15), len: { [x]: [6, 13] } });
      if (mustBid) {
        /* Partner's no-trump was forcing: with nothing else to say, the longer minor, even on three cards. */
        out.push({ call: B(2, 'C'), says: 'A minimum; may be only three clubs', hcp: R(0, 16), read: R(12, 16), len: { C: [3, 13] }, when: (v) => v.len.C >= v.len.D });
        out.push({ call: B(2, 'D'), says: 'A minimum; may be only three diamonds', hcp: R(0, 16), read: R(12, 16), len: { D: [3, 13] } });
        out.push({ call: B(2, x), says: `Rebids ${NAME[x]}`, fb: true });
        return out;
      }
      out.push({ call: PASS, says: 'A minimum, balanced', hcp: R(0, 16), read: R(12, 16) });
      return out;
    }
    if (r.level === 2 && rTag !== 'invite') {            // 13–15, forcing to game
      if (isMajor(x)) out.push({ call: B(4, x), says: `Six ${NAME[x]}`, len: { [x]: [6, 13] } });
      out.push({ call: B(6, 'N'), says: 'To play', hcp: R(20, 21) });
      out.push({ call: B(3, 'N'), says: 'To play' });
      return out;
    }
    if (r.level === 2) {                                   // 11–12, invitational
      out.push({ call: B(3, 'N'), says: 'Accepts', hcp: R(14, 21) });
      out.push({ call: PASS, says: 'Declines', hcp: R(0, 13), read: R(12, 13) });
      return out;
    }
    if (r.level === 3) { out.push({ call: B(6, 'N'), says: 'To play', hcp: R(17, 21) }); out.push({ call: PASS, says: 'Pass', hcp: R(0, 16), read: R(12, 16) }); return out; }
  }

  if (!isSuit(r.strain)) return out;
  const y = r.strain;

  /* Partner bid a new suit at the one level: 6 or more, forcing. */
  if (r.level === 1) {
    if (isMajor(y)) {
      out.push({ call: B(4, y), says: 'Four-card support, 19 or more points', hcp: R(18, 21), len: { [y]: [4, 13] }, when: (v) => v.hcp + v.short(y) >= 20 });
      out.push({ call: B(3, y), says: 'Four-card support, 16–18 points', hcp: R(15, 18), len: { [y]: [4, 13] }, when: (v) => v.hcp + v.short(y) >= 16, tag: 'invite' });
      out.push({ call: B(2, y), says: 'Four-card support, a minimum', hcp: R(0, 15), read: R(12, 15), len: { [y]: [4, 13] } });
    }
    for (const s of MAJORS) if (s !== x && s !== y && cheap(s) === 1) out.push({ call: B(1, s), says: `Four or more ${NAME[s]}`, hcp: R(0, 18), read: R(12, 18), len: { [s]: [4, 13] }, forcing: false });
    out.push({ call: B(2, 'N'), says: '18–19 points, balanced', hcp: R(18, 19), when: (v) => v.balanced });
    out.push({ call: B(1, 'N'), says: '12–14 points, balanced', hcp: R(0, 14), read: R(12, 14), when: (v) => v.balanced });
    for (const s of SUITS) if (s !== x && s !== y) out.push({ call: B(3, s), says: `Jump shift: 19 or more points, four ${NAME[s]}`, hcp: R(19, 21), len: { [s]: [4, 13] }, when: (v) => !v.balanced && cheap(s) === 2, forcing: true });
    for (const s of SUITS) if (s !== x && s !== y && SUITS.indexOf(s) > SUITS.indexOf(x) && cheap(s) === 2) out.push({ call: B(2, s), says: `Reverse: 17 or more points, four ${NAME[s]}`, hcp: R(17, 21), len: { [s]: [4, 13], [x]: [5, 13] }, when: (v) => v.len[x] > v.len[s], forcing: true });
    out.push({ call: B(3, x), says: `Six ${NAME[x]}, 16–18 points`, hcp: R(15, 18), len: { [x]: [6, 13] }, when: (v) => v.lp >= 17, tag: 'invite' });
    for (const s of SUITS) if (s !== x && s !== y && SUITS.indexOf(s) < SUITS.indexOf(x)) out.push({ call: B(2, s), says: `Four or more ${NAME[s]}`, hcp: R(0, 18), read: R(12, 18), len: { [s]: [4, 13], [x]: [4, 13] } });
    out.push({ call: B(2, x), says: `Six ${NAME[x]}, a minimum`, hcp: R(0, 15), read: R(12, 15), len: { [x]: [6, 13] } });
    if (isMajor(y)) out.push({ call: B(2, y), says: 'Three-card support, a minimum', hcp: R(0, 15), read: R(12, 15), len: { [y]: [3, 13] }, when: (v) => v.short(y) >= 3 });
    out.push({ call: B(2, x), says: `Five ${NAME[x]}, a minimum`, hcp: R(0, 15), read: R(12, 15), len: { [x]: [5, 13] } });
    out.push({ call: B(1, 'N'), says: 'A minimum', hcp: R(0, 15), read: R(12, 15) });
    return out;
  }

  /* Partner bid a new suit at the two level: 10 or more, forcing. */
  if (r.level === 2 && SUITS.indexOf(y) < SUITS.indexOf(x)) {
    const need = y === 'H' ? 3 : 4;
    if (isMajor(y)) out.push({ call: B(4, y), says: 'Support and extra values', hcp: R(15, 21), len: { [y]: [need, 13] } });
    out.push({ call: B(3, y), says: 'Support', hcp: R(0, 16), read: R(12, 16), len: { [y]: [need, 13] }, forcing: true });
    out.push({ call: B(3, 'N'), says: '15 or more points, balanced', hcp: R(15, 19), when: (v) => v.balanced });
    for (const s of SUITS) if (s !== x && s !== y && cheap(s) === 2) {
      const reverse = SUITS.indexOf(s) > SUITS.indexOf(x);
      out.push({ call: B(2, s), says: `Four or more ${NAME[s]}${reverse ? ', extra values' : ''}`, hcp: R(reverse ? 15 : 11, 21), len: { [s]: [4, 13] }, forcing: true });
    }
    out.push({ call: B(3, x), says: `Six ${NAME[x]}, extra values`, hcp: R(15, 21), len: { [x]: [6, 13] }, forcing: true });
    out.push({ call: B(2, 'N'), says: '12–14 points, balanced', hcp: R(0, 14), read: R(12, 14), when: (v) => v.balanced, forcing: true });
    out.push({ call: B(2, x), says: `Rebids ${NAME[x]}, a minimum`, hcp: R(0, 15), read: R(12, 15), len: { [x]: [5, 13] }, forcing: true });
    out.push({ call: B(2, 'N'), says: 'A minimum', hcp: R(0, 14), read: R(12, 14), forcing: true });
    return out;
  }
  return out;
}

/* ---------------------------------------------- placing the final contract */

/** The suit to play in: eight cards between the hands, majors first. */
function findFit(c: Ctx, v?: View): Suit | null {
  const mine = c.know[c.me].len;
  const pd = c.know[c.pd].len;
  let best: Suit | null = null;
  let bestN = 0;
  for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
    if (c.theirs.includes(s)) continue;
    const n = (v ? v.len[s] : mine[s][0]) + pd[s][0];
    if (n < 8) continue;
    const score = n + (isMajor(s) ? 10 : 0);
    if (score > bestN) { bestN = score; best = s; }
  }
  return best;
}

/**
 * Past the first round or two, the meanings above have narrowed both hands
 * enough to decide by arithmetic: is there a fit, and are there the points
 * for game or slam opposite the least partner can hold?
 */
function place(c: Ctx): Rule[] {
  const out: Rule[] = [];
  const pd = c.know[c.pd].hcp;
  const me = c.know[c.me].hcp;
  const last = c.last;
  if (!last) return [{ call: PASS, says: 'Pass' }];
  const oursLast = sideOf(last.seat) === sideOf(c.me);
  const pdLast = c.by(c.pd).at(-1);
  const pdTag = pdLast ? c.tagOf(pdLast.i) : '';
  const myLastAct = c.acts(c.me).at(-1);
  const myTag = myLastAct ? c.tagOf(myLastAct.i) : '';
  const fitOf = (v: View): Suit | null => findFit(c, v);
  /* What the hand is worth: shortness counts once a fit is known. */
  const worth = (v: View): number => { const f = fitOf(v); return f && v.len[f] >= 3 ? Math.max(v.lp, v.hcp + v.short(f)) : v.lp; };
  const total = (v: View): number => worth(v) + pd[0];
  const gameIn = (s: Strain): number => (s === 'N' ? 3 : isMajor(s) ? 4 : 5);
  const atGame = oursLast && last.level >= gameIn(last.strain);
  /* A game force is on: nobody passes short of game, whatever the count says. */
  const gf = c.gf && !atGame;
  const strainFor = (v: View): Strain => {
    const f = fitOf(v);
    if (f && isMajor(f)) return f;
    if (f && !v.semi && v.short(f) >= 3) return f;
    return 'N';
  };
  const slack = 2;
  /* Choosing a suit as trumps says something: enough cards in it to make eight with what partner has shown. */
  const fitLen = (s: Suit): Partial<Record<Suit, Range>> => ({ [s]: [Math.max(0, 8 - c.know[c.pd].len[s][0]), 13] });

  /* ---- the opponents hold the contract ---- */
  if (!oursLast) {
    const stillOurs = (v: View): boolean => total(v) >= 25;
    for (const s of ['S', 'H', 'N', 'D', 'C'] as Strain[]) {
      const g = gameIn(s);
      if (c.legal(B(g, s)) && c.cheapest(s) <= g) out.push({ call: B(g, s), says: 'To play', hcp: R(25 - pd[0] - slack, 37), when: (v) => stillOurs(v) && strainFor(v) === s && (s !== 'N' || c.theirs.every((t) => v.stop(t))) });
    }
    if (last.level >= 3) out.push({ call: DBL, says: 'Penalty: we hold the balance of the points', hcp: R(25 - pd[0], 37), when: (v) => v.hcp + pd[0] >= 25 && c.theirs.includes(last.strain as Suit) ? v.len[last.strain as Suit] >= 2 : v.hcp + pd[0] >= 26, tag: 'penalty' });
    /* Competing for the part-score: as high as the trumps are long. */
    for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
      const l = c.cheapest(s);
      if (!l || l > 3) continue;
      out.push({ call: B(l, s), says: `Competing in ${NAME[s]}`, hcp: R(0, 24 - pd[0]), when: (v) => fitOf(v) === s && v.len[s] + c.know[c.pd].len[s][0] - 6 >= l && worth(v) + mid(pd) >= 17 + l });
    }
    out.push({ call: PASS, says: 'Pass' });
    return out;
  }

  /* ---- slam ---- */
  const askedAlready = c.acts(c.me).some((x) => c.tagOf(x.i) === 'blackwood') || c.acts(c.pd).some((x) => c.tagOf(x.i) === 'blackwood');
  if (last.level < 6) {
    if (!askedAlready && c.legal(B(4, 'N')) && last.strain !== 'N') {
      out.push({ call: B(4, 'N'), says: 'Blackwood: how many aces?', hcp: R(33 - pd[0] - slack, 37), when: (v) => total(v) >= 33 && !!fitOf(v) && v.hcp + pd[0] >= 29, forcing: true, tag: 'blackwood', alert: true });
    }
    out.push({ call: B(6, 'N'), says: 'To play', hcp: R(33 - pd[0], 37), when: (v) => v.hcp + pd[0] >= 33 && strainFor(v) === 'N', tag: 'final' });
  }

  /* ---- an invitation was made: accept with the better half of what I showed ---- */
  if (pdTag === 'invite' || pdTag === 'invite-choice' || pdTag === 'choice') {
    const accept = (v: View): boolean => pdTag === 'choice' || total(v) >= 25 || (worth(v) > mid(me) && worth(v) + mid(pd) >= 24.5);
    const pdSuit = pdTag.endsWith('choice') ? (MAJORS.find((m) => c.know[c.pd].len[m][0] >= 5) ?? null) : null;
    for (const s of ['S', 'H'] as Suit[]) {
      if (c.legal(B(4, s))) out.push({ call: B(4, s), says: 'Accepts: game in the fit', when: (v) => accept(v) && (pdSuit ? pdSuit === s && v.len[s] >= 3 : strainFor(v) === s) });
    }
    if (c.legal(B(3, 'N')) && last.level <= 3) out.push({ call: B(3, 'N'), says: 'Accepts', when: (v) => accept(v) && pdTag !== 'choice' && (!pdSuit || v.len[pdSuit] < 3) });
    for (const s of ['D', 'C'] as Suit[]) if (c.legal(B(5, s))) out.push({ call: B(5, s), says: 'Accepts', when: (v) => accept(v) && strainFor(v) === s });
    if (pdSuit && c.cheapest(pdSuit) === 3) out.push({ call: B(3, pdSuit), says: 'Declines, with three-card support', len: { [pdSuit]: [3, 13] } });
    out.push({ call: PASS, says: pdTag === 'choice' ? 'No fit: plays in no-trump' : 'Declines' });
    return out;
  }

  /* ---- game ---- */
  if (!atGame) {
    for (const s of ['S', 'H'] as Suit[]) {
      if (c.legal(B(4, s))) out.push({ call: B(4, s), says: 'To play', hcp: R(25 - pd[0] - slack, 32 - pd[0]), len: fitLen(s), when: (v) => (gf || total(v) >= 25) && strainFor(v) === s });
    }
    for (const s of ['S', 'H'] as Suit[]) {
      if (c.legal(B(4, s))) out.push({ call: B(4, s), says: `To play: six or more ${NAME[s]}`, hcp: R(26 - pd[0] - slack, 32 - pd[0]), len: { [s]: [6, 13] }, when: (v) => total(v) >= 26 && !fitOf(v) });
    }
    if (c.legal(B(3, 'N'))) out.push({ call: B(3, 'N'), says: 'To play', hcp: R(25 - pd[0], 32 - pd[0]), when: (v) => (gf || v.hcp + pd[0] >= 25) && strainFor(v) === 'N' });
    for (const s of ['D', 'C'] as Suit[]) {
      if (c.legal(B(5, s))) out.push({ call: B(5, s), says: 'To play', hcp: R(27 - pd[0] - slack, 32 - pd[0]), when: (v) => total(v) >= 28 && fitOf(v) === s });
    }
    /* Past three no-trump with the points for game: the best spot left. */
    for (const s of ['S', 'H'] as Suit[]) {
      if (c.legal(B(4, s))) out.push({ call: B(4, s), says: 'To play', hcp: R(25 - pd[0], 32 - pd[0]), when: (v) => (gf || v.hcp + pd[0] >= 25) && !c.legal(B(3, 'N')) && v.len[s] + c.know[c.pd].len[s][0] >= 7 });
    }
    if (gf) for (const s of ['D', 'C'] as Suit[]) {
      if (c.legal(B(5, s)) && !c.legal(B(3, 'N'))) out.push({ call: B(5, s), says: 'To play', when: (v) => fitOf(v) === s });
    }

    /* ---- worth a try ---- */
    if (myTag !== 'invite') {
      /* Close to game opposite a minimum — or opposite an average hand, where
         partner's range is still wide. Anything stronger has bid game above. */
      const pdMid = pd[0] + Math.min(pd[1] - pd[0], 8) / 2;
      const near = (v: View): boolean => total(v) >= 23 || worth(v) + pdMid >= 25.5;
      for (const s of ['S', 'H'] as Suit[]) {
        if (c.legal(B(3, s)) && c.cheapest(s) <= 3 && !(last.strain === s && last.level === 3)) out.push({ call: B(3, s), says: 'Invites game', hcp: R(23 - pd[0] - slack, 24 - pd[0]), len: fitLen(s), when: (v) => near(v) && strainFor(v) === s, tag: 'invite' });
      }
      for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
        if (c.legal(B(3, s)) && c.cheapest(s) <= 3 && !(last.strain === s && last.level === 3) && c.acts(c.me).some((x) => x.e.call.type === 'bid' && x.e.call.strain === s)) {
          out.push({ call: B(3, s), says: `Invites game: six or more ${NAME[s]}`, hcp: R(23 - pd[0] - slack, 24 - pd[0]), len: { [s]: [6, 13] }, when: (v) => near(v), tag: 'invite' });
        }
      }
      if (c.cheapest('N') === 2) out.push({ call: B(2, 'N'), says: 'Invites game', hcp: R(23 - pd[0], 24 - pd[0]), when: (v) => near(v) && strainFor(v) === 'N' && v.hcp + pd[0] >= 23, tag: 'invite' });
    }
  }

  /* ---- nothing more to look for: find somewhere to stop ---- */
  const pdBid = pdLast?.e.call.type === 'bid' ? pdLast.e.call : null;
  const canPass = !c.forced && !gf;
  const pdFirst = c.acts(c.pd).find((x) => x.e.call.type === 'bid' && isSuit((x.e.call as { strain: Strain }).strain) && c.know[c.pd].len[(x.e.call as { strain: Suit }).strain][0] >= 3)?.e.call as (Call & { type: 'bid' }) | undefined;
  const playable = (v: View): boolean => !pdBid || last.seat !== c.pd || pdBid.strain === 'N'
    || v.len[pdBid.strain as Suit] + c.know[c.pd].len[pdBid.strain as Suit][0] >= 7;
  if (canPass) out.push({ call: PASS, says: 'Content to play here', hcp: R(0, 22 - pd[0] + slack), when: (v) => atGame || playable(v) });
  for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
    const l = c.cheapest(s);
    if (l && l <= 3) out.push({ call: B(l, s), says: `Prefers ${NAME[s]}`, hcp: R(0, 22 - pd[0] + slack), len: fitLen(s), when: (v) => fitOf(v) === s });
  }
  if (pdFirst && isSuit(pdFirst.strain)) {
    const s = pdFirst.strain;
    const l = c.cheapest(s);
    if (l && l <= 3) out.push({ call: B(l, s), says: `Gives preference to ${NAME[s]}`, hcp: R(0, 22 - pd[0] + slack), when: (v) => v.len[s] >= 3 || (v.len[s] >= 2 && c.know[c.pd].len[s][0] >= 5) });
  }
  const own = c.acts(c.me).find((x) => x.e.call.type === 'bid' && isSuit((x.e.call as { strain: Strain }).strain))?.e.call as (Call & { type: 'bid' }) | undefined;
  if (own && isSuit(own.strain)) {
    const s = own.strain;
    const l = c.cheapest(s);
    if (l && l <= 3) out.push({ call: B(l, s), says: `Rebids ${NAME[s]}`, len: { [s]: [6, 13] }, when: (v) => v.len[s] >= 6 });
  }
  /* A long suit of one's own that has not been mentioned: to play, when the alternatives are worse. */
  for (const s of ['S', 'H', 'D', 'C'] as Suit[]) {
    if (c.cheapest(s) === 2 && !c.theirs.includes(s) && !c.acts(c.me).some((x) => x.e.call.type === 'bid' && x.e.call.strain === s)) {
      out.push({ call: B(2, s), says: `To play: six or more ${NAME[s]}`, hcp: R(0, 22 - pd[0] + slack), len: { [s]: [6, 13] }, when: (v) => !fitOf(v) && c.know[c.pd].len[s][0] === 0 });
    }
  }
  const n = c.cheapest('N');
  if (n === 1) out.push({ call: B(1, 'N'), says: 'No fit: 6–10 points', hcp: R(6, 10), when: (v) => !playable(v) });
  if (canPass) out.push({ call: PASS, says: 'Pass' });
  /* Forced, with nothing above to say: the cheapest honest thing. */
  const rest: Rule[] = [];
  if (n && n <= 3) rest.push({ call: B(n, 'N'), says: 'Nothing more to show', when: (v) => v.semi || !pdFirst || !isSuit(pdFirst.strain) || v.len[pdFirst.strain] < 2 });
  if (own && isSuit(own.strain) && c.cheapest(own.strain)) rest.push({ call: B(c.cheapest(own.strain), own.strain), says: `Rebids ${NAME[own.strain]}`, when: (v) => v.len[own.strain as Suit] >= 5 });
  if (pdFirst && isSuit(pdFirst.strain) && c.cheapest(pdFirst.strain)) rest.push({ call: B(c.cheapest(pdFirst.strain), pdFirst.strain), says: `Back to ${NAME[pdFirst.strain]}` });
  if (n) rest.push({ call: B(n, 'N'), says: 'Nothing more to show' });
  out.push(...lastResort(rest));
  return out;
}

/* ================================================================ dispatch */

function rulesFor(c: Ctx): Rule[] {
  if (!c.last) return opening(c);
  const mine = c.acts(c.me).length;
  const pds = c.acts(c.pd);
  if (mine > 0) return rebid(c);
  if (pds.length === 0) return defensive(c);
  if (pds.length > 1) return place(c);

  const first = pds[0] as { e: AuctionEntry; i: number };
  const call = first.e.call;
  const tag = c.tagOf(first.i);
  const quiet = !c.rhoCall || c.rhoCall.type === 'pass';
  if (call.type === 'double') {
    if (tag === 'takeout') return advanceDouble(c);
    return [{ call: PASS, says: 'Leaves the double in' }];
  }
  if (call.type !== 'bid') return [{ call: PASS, says: 'Pass' }];

  if (c.opener === c.pd) {
    if (call.strain === 'N') {
      if (!quiet) return ntInterfered(c);
      if (call.level === 1) return ntResponses(c, 1, 15, 17);
      if (call.level === 2) return ntResponses(c, 2, 20, 21);
      return [{ call: PASS, says: 'Pass' }];
    }
    if (tag === '2c') return quiet ? respondTo2C() : [{ call: PASS, says: 'Pass', hcp: R(0, 7) }, ...lastResort(place(c))];
    if (call.level === 1) return respondToOne(c, call.strain);
    return quiet ? respondToPreempt(c, call.level, call.strain) : [{ call: PASS, says: 'Pass' }];
  }
  /* Partner came in over their opening. */
  if (tag === 'nt-overcall') return quiet ? ntResponses(c, call.level, 15, 18) : ntInterfered(c);
  if (tag === 'michaels') return advanceTwoSuiter(c, ['H', 'S']);
  if (tag.startsWith('unusual:')) return advanceTwoSuiter(c, [tag[8] as Suit, tag[9] as Suit]);
  if (isSuit(call.strain)) return advanceOvercall(c, call.strain, call.level);
  return [{ call: PASS, says: 'Pass' }];
}

/* ========================================================= reading and bidding */

const fits = (r: Rule, v: View): boolean => {
  if (r.hcp && (v.hcp < r.hcp[0] || v.hcp > r.hcp[1])) return false;
  if (r.len) for (const s of SUITS) { const x = r.len[s]; if (x && (v.len[s] < x[0] || v.len[s] > x[1])) return false; }
  return !r.when || r.when(v);
};

/** Everything a list of rules for the same call allows, taken together. */
function hull(rules: Rule[]): Shape {
  const out = anyShape();
  out.hcp = [Math.min(...rules.map((r) => (r.read ?? r.hcp)?.[0] ?? 0)), Math.max(...rules.map((r) => (r.read ?? r.hcp)?.[1] ?? 37))];
  for (const s of SUITS) out.len[s] = [Math.min(...rules.map((r) => r.len?.[s]?.[0] ?? 0)), Math.max(...rules.map((r) => r.len?.[s]?.[1] ?? 13))];
  return out;
}

function narrow(a: Shape, b: Shape): Shape {
  const cut = (x: Range, y: Range): Range => { const lo = Math.max(x[0], y[0]); const hi = Math.min(x[1], y[1]); return lo <= hi ? [lo, hi] : y; };
  return { hcp: cut(a.hcp, b.hcp), len: { C: cut(a.len.C, b.len.C), D: cut(a.len.D, b.len.D), H: cut(a.len.H, b.len.H), S: cut(a.len.S, b.len.S) } };
}

export interface Reading {
  /** What each seat's calls have shown. */
  know: Record<Seat, Shape>;
  /** One entry per call made: what it meant, in words, or '' if the system has no reading of it. */
  says: string[];
  told: Told[];
}

/** Read an auction: what every call showed, as this system understands it. */
export function readAuction(a: AuctionState, sys: System = 'sayc'): Reading {
  const know: Record<Seat, Shape> = { N: anyShape(), E: anyShape(), S: anyShape(), W: anyShape() };
  const told: Told[] = [];
  const says: string[] = [];
  for (let i = 0; i < a.calls.length; i++) {
    const e = a.calls[i] as AuctionEntry;
    const prefix: AuctionState = { dealer: a.dealer, calls: a.calls.slice(0, i) };
    const c = makeCtx(prefix, e.seat, know, told, sys);
    const all = rulesFor(c).filter((r) => same(r.call, e.call));
    const proper = all.filter((r) => !r.fb);
    const pool = proper.length ? proper : all;
    /* The first rule for a call is what it most likely means. Later rules of
       the same kind widen it; rules of another kind are a different message. */
    const match = pool.filter((r) => (r.tag ?? '') === (pool[0]?.tag ?? ''));
    if (match.length > 0) {
      know[e.seat] = narrow(know[e.seat], hull(match));
      const first = match[0] as Rule;
      told.push({ tag: first.tag ?? '', forcing: !!first.forcing });
      says.push(first.says);
    } else {
      /* Off the system. Two calls are worth a guess even so. */
      let tag = '';
      if (e.call.type === 'bid' && e.call.level === 4 && e.call.strain === 'N') {
        const pdPrev = c.by(c.pd).at(-1)?.e.call;
        tag = pdPrev?.type === 'bid' && pdPrev.strain === 'N' ? 'quant' : 'blackwood';
      } else if (e.call.type === 'double') {
        tag = c.last && c.last.level <= 2 && c.acts(c.pd).length === 0 ? 'takeout' : 'penalty';
      }
      told.push({ tag, forcing: tag === 'blackwood' || tag === 'takeout' });
      says.push('');
    }
  }
  return { know, says, told };
}

export interface Chosen { call: Call; says: string; alert: boolean }

/** The system's call for this hand, with what it shows. */
export function chooseSayc(hand: readonly Card[], a: AuctionState, seat: Seat, sys: System = 'sayc'): Chosen {
  const read = readAuction(a, sys);
  const c = makeCtx(a, seat, read.know, read.told, sys);
  const v = viewOf(hand);
  const rules = rulesFor(c);
  for (const r of rules) {
    if (!c.legal(r.call) || !fits(r, v)) continue;
    /* A last resort must not borrow a call that partner would read as one of
       the system's proper meanings — a meaning this hand has just failed. */
    if (r.fb && rules.some((o) => !o.fb && same(o.call, r.call))) continue;
    return { call: r.call, says: r.says, alert: !!r.alert };
  }
  /* Nothing fits. Pass, unless partner's call was forcing: then the cheapest bid in partner's suit or no-trump. */
  if (c.forced) {
    for (const r of rules) if (r.fb && c.legal(r.call) && r.call.type === 'bid') return { call: r.call, says: r.says, alert: false };
  }
  return { call: PASS, says: 'Pass', alert: false };
}

/** Drop-in for the robot: just the call. */
export function chooseCall(hand: readonly Card[], a: AuctionState, seat: Seat): Call {
  return chooseSayc(hand, a, seat).call;
}
