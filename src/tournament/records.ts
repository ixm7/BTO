/**
 * The hand records, written down.
 *
 * A tournament's play lives in an event log held by the browsers playing it,
 * and that log goes when the last of them leaves. Everything a player wants
 * afterwards — the deal, how every table bid it, what it scored — is derived
 * from a much smaller thing: the seed, the pairs, and a line per table per
 * board. That is what is kept here, and it is what goes up on the
 * tournament's page when the last board is in, so the records outlive the
 * session that produced them.
 *
 * The deals are not written down unless the director brought them in a file:
 * the seed deals them again exactly, for anybody, for ever, which is the same
 * reason the tournament itself needs no server.
 */
import { parseCall, callToString, type AuctionEntry, type Call } from '../engine/bidding';
import { readable } from '../engine/boards';
import { SEATS, type Seat } from '../engine/cards';
import { dealerForBoard } from '../engine/deal';
import type { BoardResult, TState, TournamentConfig } from './state';

/** One table's line on one board. Keys are short: this is written to a page. */
export interface RecordLine {
  /** Board number. */
  b: number;
  /** Table index. */
  t: number;
  /** The pair sitting North-South, and the pair East-West, by index. */
  n: number;
  e: number;
  /** The score to North-South. */
  s: number;
  /** The result as it is written, e.g. "4♠ N +1". */
  r: string;
  /** The auction from the dealer round, calls comma-separated. */
  a?: string;
}

export interface HandRecords {
  v: 1;
  seed: string;
  rounds: number;
  boardsPerRound: number;
  tables: number;
  scoring?: 'imps';
  /** Only when the boards came from a file; otherwise the seed has them. */
  deals?: string[];
  /** Pair index to the two players' names. */
  pairs: [string, string][];
  lines: RecordLine[];
}

/** "1S,P,2S,P!forcing,4S,P,P,P" — the auction, in order, from the dealer. */
export function auctionText(calls: readonly AuctionEntry[]): string {
  return calls.map((e) => callToString(e.call) + (e.alert ? `!${e.alert.replace(/[,!]/g, ' ')}` : '')).join(',');
}

/** The same read back, with the seats worked out from who dealt. */
export function auctionOf(text: string, board: number): AuctionEntry[] {
  const from = SEATS.indexOf(dealerForBoard(board));
  const out: AuctionEntry[] = [];
  text.split(',').forEach((piece, i) => {
    const cut = piece.indexOf('!');
    const word = (cut < 0 ? piece : piece.slice(0, cut)).trim();
    if (!word) return;
    let call: Call;
    try { call = parseCall(word); } catch { return; }
    const alert = cut < 0 ? '' : piece.slice(cut + 1).trim();
    out.push({ seat: SEATS[(from + i) % 4] as Seat, call, ...(alert ? { alert } : {}) });
  });
  return out;
}

/** What is worth keeping of a tournament that has been played out. */
export function recordsOf(state: TState): HandRecords {
  const c = state.config;
  return {
    v: 1,
    seed: c.seed,
    rounds: c.rounds,
    boardsPerRound: c.boardsPerRound,
    tables: c.tables,
    ...(c.scoring === 'imps' ? { scoring: 'imps' as const } : {}),
    ...(c.deals?.length ? { deals: [...c.deals] } : {}),
    pairs: c.pairs.map((p) => [p.players[0].name, p.players[1].name] as [string, string]),
    lines: [...state.results]
      .sort((a, b) => a.board - b.board || a.table - b.table)
      .map((r) => ({
        b: r.board, t: r.table, n: r.nsPair, e: r.ewPair, s: r.nsScore, r: r.text,
        ...(r.auction?.length ? { a: auctionText(r.auction) } : {}),
      })),
  };
}

/**
 * A page holds one comment of 65,536 characters, and a big field playing a
 * long card can write more than that. The bidding is the bulk of it, so a set
 * of records too large to post goes up without the auctions rather than not
 * at all: the deals, the contracts and the scores are what a traveller is
 * for, and they are a third of the size.
 */
export const RECORDS_MAX = 60_000;

export function fitRecords(r: HandRecords, max = RECORDS_MAX): HandRecords {
  if (JSON.stringify(r).length <= max) return r;
  const lean: HandRecords = { ...r, lines: r.lines.map(({ a, ...rest }) => rest) };
  if (JSON.stringify(lean).length <= max) return lean;
  throw new Error('This tournament played more boards than its page will hold.');
}

/**
 * The records as a state the review can read.
 *
 * Everything the records view asks of a tournament is the config it was dealt
 * from, who the pairs were and what each table scored — so a played-out
 * tournament and a written-down one are the same thing to it, and there is
 * one renderer rather than two that drift apart.
 */
export function stateOfRecords(r: HandRecords, name = 'Hand records'): TState {
  const config: TournamentConfig = {
    id: 'records', name, seed: r.seed,
    ...(r.deals?.length ? { deals: r.deals } : {}),
    tables: r.tables, rounds: r.rounds, boardsPerRound: r.boardsPerRound,
    ...(r.scoring === 'imps' ? { scoring: 'imps' as const } : {}),
    pairs: r.pairs.map((names, i) => ({
      id: i,
      players: [
        { id: `p${i}a`, name: names[0] },
        { id: `p${i}b`, name: names[1] },
      ] as [{ id: string; name: string }, { id: string; name: string }],
    })),
  };
  const results: BoardResult[] = r.lines.map((l) => ({
    board: l.b, round: 0, table: l.t, nsPair: l.n, ewPair: l.e,
    contract: null, declarerTricks: 0, nsScore: l.s, text: l.r,
    ...(l.a ? { auction: auctionOf(l.a, l.b) } : {}),
  }));
  return {
    config, round: r.rounds, tables: [], results,
    finished: true, aborted: false, retired: [], standIns: {},
  } as unknown as TState;
}

/** Which pair this name belongs to, for a reader who was in the field. */
export function pairOfName(r: HandRecords, name: string): number | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  for (const [i, pair] of r.pairs.entries()) {
    if (pair.some((p) => p.trim().toLowerCase() === want)) return i;
  }
  return null;
}

/**
 * Is this something we can show? Records come off a page anyone may comment
 * on, so they are checked before they are drawn rather than trusted.
 */
export function readRecords(value: unknown): HandRecords | null {
  const r = value as Partial<HandRecords> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.seed !== 'string' || !r.seed) return null;
  const n = (x: unknown, lo: number, hi: number): number | null =>
    (typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : null);
  const rounds = n(r.rounds, 1, 60);
  const bpr = n(r.boardsPerRound, 1, 60);
  const tables = n(r.tables, 1, 200);
  if (rounds === null || bpr === null || tables === null) return null;
  if (!Array.isArray(r.pairs) || r.pairs.length === 0 || r.pairs.length > 400) return null;
  const pairs = r.pairs.map((p) => [String((p as string[])[0] ?? '').slice(0, 60), String((p as string[])[1] ?? '').slice(0, 60)] as [string, string]);
  if (!Array.isArray(r.lines) || r.lines.length === 0 || r.lines.length > 4000) return null;
  const lines: RecordLine[] = [];
  for (const raw of r.lines as RecordLine[]) {
    const b = n(raw?.b, 1, rounds * bpr);
    const t = n(raw?.t, 0, tables - 1);
    const ns = n(raw?.n, 0, pairs.length - 1);
    const ew = n(raw?.e, 0, pairs.length - 1);
    const s = typeof raw?.s === 'number' && Number.isFinite(raw.s) && Math.abs(raw.s) <= 10000 ? Math.round(raw.s) : null;
    if (b === null || t === null || ns === null || ew === null || s === null) return null;
    const text = String(raw?.r ?? '').slice(0, 40);
    const a = typeof raw?.a === 'string' ? raw.a.slice(0, 600) : undefined;
    lines.push({ b, t, n: ns, e: ew, s, r: text, ...(a ? { a } : {}) });
  }
  const deals = Array.isArray(r.deals) && r.deals.every((d) => typeof d === 'string' && readable(d))
    ? (r.deals as string[]).slice(0, rounds * bpr)
    : undefined;
  return {
    v: 1, seed: r.seed.slice(0, 80), rounds, boardsPerRound: bpr, tables,
    ...(r.scoring === 'imps' ? { scoring: 'imps' as const } : {}),
    ...(deals?.length ? { deals } : {}),
    pairs, lines,
  };
}
