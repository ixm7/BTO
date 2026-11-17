import { describe, expect, it } from 'vitest';
import { auctionOf, auctionText, fitRecords, pairOfName, readRecords, recordsOf, stateOfRecords } from '../src/tournament/records';
import { parseRecords, recordsBody } from '../src/directory/github';
import { _test as relayTest } from '../relay/worker.js';
import { boardComplete, reviewBoard, scorecard } from '../src/tournament/review';
import { dealText } from '../src/engine/boards';
import { chooseCall, chooseCard } from '../src/engine/bot';
import { planConfig } from '../src/tournament/plan';
import { boardFor, reduce, turnAt, type LobbyPlayer, type TState } from '../src/tournament/state';

const roster = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

/** A whole tournament, played out by the engine against itself. */
function played(players: number, rounds: number): TState {
  const config = planConfig({ id: 'rec', name: 'Records', seed: 'fixed-seed', roster: roster(players), boardsPerRound: 2, rounds });
  let state = reduce(null, { t: 'start', config });
  let guard = 0;
  while (!state.finished && guard++ < 400000) {
    const table = state.tables.find((t) => turnAt(t));
    if (!table) break;
    const turn = turnAt(table)!;
    state = reduce(state, turn.phase === 'auction'
      ? { t: 'call', table: table.index, board: table.boardNo!, seat: turn.seat, call: chooseCall(table.deal![turn.seat], table.auction!, turn.seat) }
      : { t: 'play', table: table.index, board: table.boardNo!, seat: turn.seat, card: chooseCard(table.play!, turn.seat) });
  }
  return state;
}

describe('an auction written down', () => {
  it('comes back with its seats, worked out from who dealt', () => {
    const state = played(8, 1);
    const result = state.results.find((r) => r.auction?.length);
    expect(result).toBeDefined();
    const back = auctionOf(auctionText(result!.auction!), result!.board);
    expect(back.map((e) => e.seat)).toEqual(result!.auction!.map((e) => e.seat));
    expect(back.map((e) => e.call)).toEqual(result!.auction!.map((e) => e.call));
  });

  it('keeps an explanation with the call it belongs to', () => {
    const text = auctionText([
      { seat: 'N', call: { type: 'bid', level: 1, strain: 'C' } },
      { seat: 'E', call: { type: 'pass' } },
      { seat: 'S', call: { type: 'bid', level: 2, strain: 'D' }, alert: 'game forcing' },
    ]);
    const back = auctionOf(text, 1);
    expect(back[2]?.alert).toBe('game forcing');
    /* Commas separate the calls, so an explanation may not contain one. */
    expect(auctionText([{ seat: 'N', call: { type: 'pass' }, alert: 'a, b' }])).not.toContain('a,');
  });

  it('drops a call it cannot read rather than guessing at it', () => {
    expect(auctionOf('1S,sideways,P', 1).map((e) => e.call.type)).toEqual(['bid', 'pass']);
  });
});

describe('a tournament written down', () => {
  it('reads back as the same card and the same travellers', () => {
    const state = played(8, 2);
    expect(state.results.length).toBeGreaterThan(0);

    const back = stateOfRecords(recordsOf(state));
    for (const pair of state.config.pairs.keys()) {
      const was = scorecard(state, pair);
      const now = scorecard(back, pair);
      expect(now.map((r) => [r.board, r.weScore, r.theyScore, r.wePercent]))
        .toEqual(was.map((r) => [r.board, r.weScore, r.theyScore, r.wePercent]));
    }
    const board = state.results[0]!.board;
    expect(reviewBoard(back, board, 0).traveller.map((t) => t.result.nsScore))
      .toEqual(reviewBoard(state, board, 0).traveller.map((t) => t.result.nsScore));
  });

  it('deals the same cards again from the seed, so the deals need not be kept', () => {
    const state = played(8, 1);
    const records = recordsOf(state);
    expect(records.deals).toBeUndefined();
    const back = stateOfRecords(records);
    for (const board of new Set(state.results.map((r) => r.board))) {
      expect(dealText(boardFor(back.config, board))).toBe(dealText(boardFor(state.config, board)));
    }
  });

  it('keeps the director\'s own boards, which no seed can deal again', () => {
    const state = played(8, 1);
    const deal = dealText(boardFor(state.config, 1));
    const withDeals = { ...state, config: { ...state.config, deals: [deal] } };
    expect(recordsOf(withDeals).deals).toEqual([deal]);
  });

  it('is finished, so every board shows its traveller', () => {
    const state = played(8, 1);
    const back = stateOfRecords(recordsOf(state));
    for (const board of new Set(back.results.map((r) => r.board))) {
      expect(boardComplete(back, board)).toBe(true);
    }
  });

  it('finds the reader among the pairs by name', () => {
    const records = recordsOf(played(8, 1));
    expect(pairOfName(records, 'Player 0')).toBe(0);
    expect(pairOfName(records, ' player 0 ')).toBe(0);
    expect(pairOfName(records, 'Nobody')).toBeNull();
    expect(pairOfName(records, '')).toBeNull();
  });
});

describe('records off a page anyone may comment on', () => {
  const good = () => recordsOf(played(8, 1));

  it('go up and come back as themselves', () => {
    const r = good();
    const back = parseRecords([{ user: { login: 'ida' }, body: recordsBody(r), created_at: '2026-11-17T12:00:00Z' }]);
    expect(back).toEqual(r);
  });

  it('say how many boards they hold, for somebody reading the page itself', () => {
    const r = good();
    const boards = new Set(r.lines.map((l) => l.b)).size;
    expect(recordsBody(r)).toContain(`${boards} board(s)`);
  });

  it('are refused when they are not records', () => {
    expect(readRecords(null)).toBeNull();
    expect(readRecords({ v: 1 })).toBeNull();
    expect(readRecords({ ...good(), seed: '' })).toBeNull();
    expect(readRecords({ ...good(), pairs: [] })).toBeNull();
    expect(readRecords({ ...good(), lines: [] })).toBeNull();
    /* A line pointing at a pair that is not in the field. */
    expect(readRecords({ ...good(), lines: [{ b: 1, t: 0, n: 99, e: 0, s: 100, r: '1N =' }] })).toBeNull();
    /* And a board the tournament never had. */
    expect(readRecords({ ...good(), lines: [{ b: 999, t: 0, n: 0, e: 1, s: 100, r: '1N =' }] })).toBeNull();
  });

  it('drop boards that are not deals rather than refusing the lot', () => {
    const r = { ...good(), deals: ['not a deal'] };
    expect(readRecords(r)?.deals).toBeUndefined();
    expect(readRecords(r)?.lines.length).toBe(r.lines.length);
  });

  it('take the last word, since two browsers may write them at once', () => {
    const a = good();
    const b = { ...a, seed: 'another-seed' };
    const back = parseRecords([
      { user: { login: 'ida' }, body: recordsBody(a), created_at: '2026-11-17T12:00:00Z' },
      { user: { login: 'bob' }, body: recordsBody(b), created_at: '2026-11-17T12:01:00Z' },
    ]);
    expect(back?.seed).toBe('another-seed');
  });
});

describe('the records the relay will write', () => {
  const { command } = relayTest;
  const good = () => recordsOf(played(8, 1));

  it('builds the same records a browser with a token would post', () => {
    const r = good();
    const fromRelay = parseRecords([{ user: { login: 'ixm7' }, body: command('records', { records: r }, 'Ann'), created_at: '2026-11-17T12:00:00Z' }]);
    /* A relayed player and a token-holding one must leave the same page
       behind, or the records would read differently depending on who
       happened to finish first. */
    expect(fromRelay).toEqual(parseRecords([{ user: { login: 'ida' }, body: recordsBody(r), created_at: '2026-11-17T12:00:00Z' }]));
  });

  it('refuses records it cannot make sense of', () => {
    expect(() => command('records', { records: null }, 'Ann')).toThrow();
    expect(() => command('records', { records: { ...good(), seed: '' } }, 'Ann')).toThrow();
    expect(() => command('records', { records: { ...good(), pairs: [] } }, 'Ann')).toThrow();
    expect(() => command('records', { records: { ...good(), lines: [] } }, 'Ann')).toThrow();
    expect(() => command('records', { records: { ...good(), deals: ['not a deal'] } }, 'Ann')).toThrow();
  });

  it('refuses a board, a table or a pair the tournament did not have', () => {
    const r = good();
    for (const bad of [{ b: 999 }, { t: 99 }, { n: 99 }, { e: 99 }, { s: 1e9 }]) {
      expect(() => command('records', { records: { ...r, lines: [{ ...r.lines[0], ...bad }] } }, 'Ann'), JSON.stringify(bad)).toThrow();
    }
  });

  it('refuses bidding that is not bidding', () => {
    const r = good();
    const line = { ...r.lines[0], a: '1S,P,sideways' };
    expect(() => command('records', { records: { ...r, lines: [line] } }, 'Ann')).toThrow();
    expect(() => command('records', { records: { ...r, lines: [{ ...r.lines[0], a: '1S,P,P,P' }] } }, 'Ann')).not.toThrow();
  });
});

describe('records too big for one page', () => {
  const good = () => recordsOf(played(8, 1));

  it('go up without the bidding rather than not at all', () => {
    const r = good();
    expect(r.lines.some((l) => l.a)).toBe(true);
    /* A cap just under what the bidding costs, so the first step is taken. */
    const lean = fitRecords(r, JSON.stringify({ ...r, lines: r.lines.map(({ a, ...x }) => x) }).length);
    expect(lean.lines.some((l) => l.a)).toBe(false);
    expect(lean.lines.map((l) => [l.b, l.t, l.s])).toEqual(r.lines.map((l) => [l.b, l.t, l.s]));
  });

  it('are left as they are when they fit', () => {
    const r = good();
    expect(fitRecords(r)).toBe(r);
  });

  it('say so rather than posting half a tournament', () => {
    expect(() => fitRecords(good(), 10)).toThrow(/page will hold/);
  });
});
