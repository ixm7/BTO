import { STRAINS, nextSeat, sideOf, type Seat, type Strain } from './cards';

export type Call =
  | { type: 'pass' }
  | { type: 'double' }
  | { type: 'redouble' }
  | { type: 'bid'; level: number; strain: Strain };

export interface AuctionState {
  dealer: Seat;
  /**
   * Each call, with the explanation its bidder offered the opponents, if any.
   * An alert is a courtesy rather than a rule of bridge, so nothing in this
   * module reads it; it travels with the call so the two cannot drift apart.
   */
  calls: { seat: Seat; call: Call; alert?: string }[];
}

export interface Contract {
  level: number;
  strain: Strain;
  declarer: Seat;
  doubled: 0 | 1 | 2; // 0 = undoubled, 1 = doubled, 2 = redoubled
}

export const PASS: Call = { type: 'pass' };

export const bidValue = (level: number, strain: Strain): number => (level - 1) * 5 + STRAINS.indexOf(strain);

export function callToString(c: Call): string {
  switch (c.type) {
    case 'pass': return 'Pass';
    case 'double': return 'X';
    case 'redouble': return 'XX';
    case 'bid': return `${c.level}${c.strain}`;
  }
}

export function parseCall(s: string): Call {
  const t = s.trim().toUpperCase();
  if (t === 'P' || t === 'PASS') return { type: 'pass' };
  if (t === 'X' || t === 'DBL' || t === 'DOUBLE') return { type: 'double' };
  if (t === 'XX' || t === 'RDBL' || t === 'REDOUBLE') return { type: 'redouble' };
  const m = /^([1-7])(C|D|H|S|N|NT)$/.exec(t);
  if (!m) throw new Error(`Bad call: ${s}`);
  return { type: 'bid', level: Number(m[1]), strain: (m[2] === 'NT' ? 'N' : m[2]) as Strain };
}

export function newAuction(dealer: Seat): AuctionState {
  return { dealer, calls: [] };
}

export function currentBidder(a: AuctionState): Seat {
  const last = a.calls[a.calls.length - 1];
  return last ? nextSeat(last.seat) : a.dealer;
}

/** Index of the last actual bid (not pass/double/redouble), or -1. */
function lastBidIndex(a: AuctionState): number {
  for (let i = a.calls.length - 1; i >= 0; i--) {
    if ((a.calls[i] as { call: Call }).call.type === 'bid') return i;
  }
  return -1;
}

export function lastBid(a: AuctionState): { seat: Seat; level: number; strain: Strain } | null {
  const i = lastBidIndex(a);
  if (i < 0) return null;
  const e = a.calls[i] as { seat: Seat; call: Call };
  if (e.call.type !== 'bid') return null;
  return { seat: e.seat, level: e.call.level, strain: e.call.strain };
}

/** 0 = none, 1 = doubled, 2 = redoubled, relative to the last bid. */
function doubleStatus(a: AuctionState): 0 | 1 | 2 {
  const i = lastBidIndex(a);
  let status: 0 | 1 | 2 = 0;
  for (let k = i + 1; k < a.calls.length; k++) {
    const t = (a.calls[k] as { call: Call }).call.type;
    if (t === 'double') status = 1;
    else if (t === 'redouble') status = 2;
  }
  return status;
}

/** Over after four opening passes, or a bid followed by three passes. */
export function isAuctionOver(a: AuctionState): boolean {
  return a.calls.length >= 4 && a.calls.slice(-3).every((e) => e.call.type === 'pass');
}

export function isPassedOut(a: AuctionState): boolean {
  return a.calls.length >= 4 && a.calls.every((e) => e.call.type === 'pass');
}

/** Returns null if legal, otherwise a reason string. */
export function illegalReason(a: AuctionState, seat: Seat, call: Call): string | null {
  if (isAuctionOver(a)) return 'Auction is over';
  if (seat !== currentBidder(a)) return 'Not your turn to call';
  const lb = lastBid(a);
  const status = doubleStatus(a);
  switch (call.type) {
    case 'pass':
      return null;
    case 'bid':
      if (!Number.isInteger(call.level) || call.level < 1 || call.level > 7) return 'Level must be 1-7';
      if (!STRAINS.includes(call.strain)) return 'Bad strain';
      if (lb && bidValue(call.level, call.strain) <= bidValue(lb.level, lb.strain)) return 'Bid must be higher than the last bid';
      return null;
    case 'double':
      if (!lb) return 'Nothing to double';
      if (sideOf(lb.seat) === sideOf(seat)) return 'Cannot double your own side';
      if (status !== 0) return 'Already doubled';
      return null;
    case 'redouble':
      if (!lb) return 'Nothing to redouble';
      if (status !== 1) return 'Nothing to redouble';
      if (sideOf(lb.seat) !== sideOf(seat)) return 'Can only redouble a double of your own side';
      return null;
  }
}

export function applyCall(a: AuctionState, seat: Seat, call: Call, alert?: string): AuctionState {
  const why = illegalReason(a, seat, call);
  if (why) throw new Error(why);
  const note = alert?.trim();
  return { dealer: a.dealer, calls: [...a.calls, note ? { seat, call, alert: note } : { seat, call }] };
}

/** Legal calls for the seat to act (used by bots and the bidding box). */
export function legalCalls(a: AuctionState): Call[] {
  if (isAuctionOver(a)) return [];
  const seat = currentBidder(a);
  const out: Call[] = [PASS];
  for (let level = 1; level <= 7; level++) {
    for (const strain of STRAINS) {
      const c: Call = { type: 'bid', level, strain };
      if (illegalReason(a, seat, c) === null) out.push(c);
    }
  }
  if (illegalReason(a, seat, { type: 'double' }) === null) out.push({ type: 'double' });
  if (illegalReason(a, seat, { type: 'redouble' }) === null) out.push({ type: 'redouble' });
  return out;
}

/** Determine the final contract; null if passed out. Declarer = first of the side to name the strain. */
export function finalContract(a: AuctionState): Contract | null {
  if (!isAuctionOver(a) || isPassedOut(a)) return null;
  const lb = lastBid(a);
  if (!lb) return null;
  const side = sideOf(lb.seat);
  let declarer: Seat = lb.seat;
  for (const e of a.calls) {
    if (e.call.type === 'bid' && e.call.strain === lb.strain && sideOf(e.seat) === side) {
      declarer = e.seat;
      break;
    }
  }
  return { level: lb.level, strain: lb.strain, declarer, doubled: doubleStatus(a) };
}
