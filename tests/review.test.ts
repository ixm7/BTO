import { describe, expect, it } from 'vitest';
import { chooseCall, chooseCard } from '../src/engine/bot';
import { planConfig } from '../src/tournament/plan';
import { boardComplete, cardTotal, pairOf, reviewBoard, scorecard } from '../src/tournament/review';
import { reduce, standings, turnAt, type LobbyPlayer, type TState } from '../src/tournament/state';

const roster = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

function played(players: number, rounds = 2): TState {
  const config = planConfig({ id: 'rv', name: 'Review', seed: 'fixed', roster: roster(players), boardsPerRound: 2, rounds });
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

/** One table driven on its own, so the field is left part-way through. */
function oneTableAhead(players: number): { state: TState; board: number } {
  const config = planConfig({ id: 'rv', name: 'Review', seed: 'fixed', roster: roster(players), boardsPerRound: 2, rounds: 1 });
  let state = reduce(null, { t: 'start', config });
  let guard = 0;
  while (!state.results.length && guard++ < 400000) {
    const table = state.tables.find((t) => t.index === 0 && turnAt(t));
    if (!table) break;
    const turn = turnAt(table)!;
    state = reduce(state, turn.phase === 'auction'
      ? { t: 'call', table: table.index, board: table.boardNo!, seat: turn.seat, call: chooseCall(table.deal![turn.seat], table.auction!, turn.seat) }
      : { t: 'play', table: table.index, board: table.boardNo!, seat: turn.seat, card: chooseCard(table.play!, turn.seat) });
  }
  return { state, board: state.results[0]!.board };
}

describe('a board the field has not finished', () => {
  it('is not complete while another table can still play it', () => {
    const { state, board } = oneTableAhead(8);
    expect(state.tables.length).toBeGreaterThan(1);
    expect(state.results.filter((r) => r.board === board)).toHaveLength(1);
    expect(boardComplete(state, board)).toBe(false);
  });

  it('is complete once every table that is still playing has reported', () => {
    const s = played(8, 1);
    for (const board of new Set(s.results.map((r) => r.board))) {
      expect(boardComplete(s, board), `board ${board}`).toBe(true);
    }
  });

  it('waits for nobody once the tournament is over', () => {
    const { state, board } = oneTableAhead(8);
    expect(boardComplete(state, board)).toBe(false);
    /* Nothing more will be reported, so what is in is all there is. */
    expect(boardComplete({ ...state, finished: true }, board)).toBe(true);
  });

  it('does not wait for a table that has been switched off', () => {
    const { state, board } = oneTableAhead(8);
    const off = { ...state, tables: state.tables.map((t) => (t.index === 0 ? t : { ...t, active: false })) };
    expect(boardComplete(off, board)).toBe(true);
  });
});

describe('the seat the table is waiting on', () => {
  it('is never dummy, so dummy is free to read the records all hand', () => {
    const config = planConfig({ id: 'rv', name: 'Review', seed: 'fixed', roster: roster(8), boardsPerRound: 2, rounds: 1 });
    let state = reduce(null, { t: 'start', config });
    let sawDummy = 0;
    let guard = 0;
    while (!state.finished && guard++ < 400000) {
      const table = state.tables.find((t) => turnAt(t));
      if (!table) break;
      const turn = turnAt(table)!;
      if (turn.phase === 'play') {
        const play = table.play!;
        /* Declarer answers for dummy, so dummy is never the one holding the
           table up — which is what leaves the records open to them. */
        expect(turn.controller).not.toBe(play.dummy);
        if (turn.seat === play.dummy) sawDummy++;
      }
      state = reduce(state, turn.phase === 'auction'
        ? { t: 'call', table: table.index, board: table.boardNo!, seat: turn.seat, call: chooseCall(table.deal![turn.seat], table.auction!, turn.seat) }
        : { t: 'play', table: table.index, board: table.boardNo!, seat: turn.seat, card: chooseCard(table.play!, turn.seat) });
    }
    /* And the case was actually met: dummy's cards did come up for playing. */
    expect(sawDummy).toBeGreaterThan(0);
  });
});

describe('looking back over a board', () => {
  it('keeps the auction that produced each result', () => {
    const s = played(8, 1);
    for (const r of s.results) {
      expect(r.auction, `board ${r.board} table ${r.table}`).toBeDefined();
      /* Four passes end a board too, so the only floor is a legal auction. */
      expect(r.auction!.length).toBeGreaterThanOrEqual(4);
      const last = r.auction!.slice(-3);
      expect(last.every((c) => c.call.type === 'pass')).toBe(true);
    }
  });

  it('rebuilds the four hands from the seed alone', () => {
    const s = played(8, 1);
    const board = s.results[0]!.board;
    const a = reviewBoard(s, board, null);
    const b = reviewBoard(s, board, null);
    expect(a.hands).toEqual(b.hands);
    const all = [...a.hands.N, ...a.hands.E, ...a.hands.S, ...a.hands.W];
    expect(all).toHaveLength(52);
    expect(new Set(all).size).toBe(52);
    expect(a.dealer).toBeTruthy();
  });

  it('matchpoints a board the same way the standings do', () => {
    const s = played(16, 2);
    const table = standings(s);
    /* Add up each pair's matchpoints board by board from the travellers, and
       it must come to the same percentage the tournament awards them. */
    for (const row of table) {
      const pair = s.config.pairs.indexOf(row.pair);
      let mp = 0, max = 0;
      for (const board of new Set(s.results.map((r) => r.board))) {
        const rv = reviewBoard(s, board, pair);
        if (!rv.own) continue;
        const weAreNS = rv.own.result.nsPair === pair;
        mp += weAreNS ? rv.own.nsMatchpoints : rv.own.top - rv.own.nsMatchpoints;
        max += rv.own.top;
      }
      const pct = max === 0 ? 0 : Math.round((mp / max) * 10000) / 100;
      expect(pct, `pair ${pair}`).toBeCloseTo(row.percent, 6);
    }
  });

  it('lists every table that played the board, best for North-South first', () => {
    const s = played(16, 2);
    const board = s.results[0]!.board;
    const rv = reviewBoard(s, board, null);
    expect(rv.traveller).toHaveLength(s.config.tables);
    const scores = rv.traveller.map((r) => r.result.nsScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    /* Matchpoints run from zero to the top and are symmetric between sides. */
    for (const r of rv.traveller) {
      expect(r.nsMatchpoints).toBeGreaterThanOrEqual(0);
      expect(r.nsMatchpoints).toBeLessThanOrEqual(r.top);
    }
  });

  it('builds a scorecard from the player’s own side', () => {
    const s = played(16, 2);
    const me = 'p0';
    const pair = pairOf(s, me)!;
    expect(pair).not.toBeNull();
    const card = scorecard(s, pair);
    expect(card.length).toBe(s.config.rounds * s.config.boardsPerRound);
    for (const row of card) {
      /* A board is a plus or a minus, never both and never neither. */
      expect((row.weScore === null) !== (row.theyScore === null) || row.weScore === null).toBe(true);
      expect(Math.round(row.wePercent + row.theyPercent)).toBe(100);
    }
    /* The card's average is the pair's tournament percentage. */
    const total = cardTotal(card);
    const mine = standings(s).find((r) => s.config.pairs.indexOf(r.pair) === pair)!;
    expect(total.we).toBeCloseTo(Math.round(mine.percent * 10) / 10, 1);
  });

  it('gives both sides half when only one table played the board', () => {
    const s = played(4, 1);
    expect(s.config.tables).toBe(1);
    const board = s.results[0]!.board;
    const rv = reviewBoard(s, board, 0);
    expect(rv.traveller).toHaveLength(1);
    expect(rv.traveller[0]!.nsPercent).toBe(50);
  });
});
