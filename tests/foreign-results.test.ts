import { describe, expect, it } from 'vitest';
import { chooseCall, chooseCard } from '../src/engine/bot';
import { planConfig } from '../src/tournament/plan';
import { reduce, standings, turnAt, type BoardResult, type LobbyPlayer, type TEvent, type TState } from '../src/tournament/state';

const roster = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

const config = (n: number, rounds = 2) =>
  planConfig({ id: 't1', name: 'Scale', seed: 'fixed', roster: roster(n), boardsPerRound: 2, rounds });

/** Play the whole field out in one state, the way it works today. */
function playAll(c: ReturnType<typeof config>): { state: TState; log: TEvent[] } {
  const log: TEvent[] = [{ t: 'start', config: c }];
  let state = reduce(null, log[0]!);
  let guard = 0;
  while (!state.finished && guard++ < 400000) {
    const table = state.tables.find((t) => turnAt(t));
    if (!table) break;
    const turn = turnAt(table)!;
    const ev: TEvent = turn.phase === 'auction'
      ? { t: 'call', table: table.index, board: table.boardNo!, seat: turn.seat, call: chooseCall(table.deal![turn.seat], table.auction!, turn.seat) }
      : { t: 'play', table: table.index, board: table.boardNo!, seat: turn.seat, card: chooseCard(table.play!, turn.seat) };
    log.push(ev);
    state = reduce(state, ev);
  }
  return { state, log };
}

describe('scoring from one table plus imported results', () => {
  it('reaches the same standings as a node that watched every table', () => {
    const c = config(16);
    const { state: full, log } = playAll(c);
    expect(full.finished).toBe(true);

    /* Now the same tournament as one player sees it: their own table's cards
       as they are played, and from the rest of the field nothing but a result
       record as each board is finished, arriving when it is finished. */
    const mine = 0;
    let solo = reduce(null, log[0]!);
    let replayed = reduce(null, log[0]!);
    let seen = 0;

    for (const e of log.slice(1)) {
      replayed = reduce(replayed, e);
      if ((e.t === 'call' || e.t === 'play') && e.table === mine) {
        solo = reduce(solo, e);
      }
      /* Whatever the rest of the field just finished reaches us as a result. */
      for (const r of replayed.results.slice(seen)) {
        if (r.table !== mine) solo = reduce(solo, { t: 'result', result: r });
      }
      seen = replayed.results.length;
    }

    /* Same results, and therefore the same matchpoints for the whole field. */
    const key = (r: BoardResult) => `${r.table}:${r.board}`;
    expect(new Set(solo.results.map(key))).toEqual(new Set(full.results.map(key)));
    expect(standings(solo)).toEqual(standings(full));
  });

  it('ignores a result it already has, however often it arrives', () => {
    const c = config(8);
    const { state: full } = playAll(c);
    const foreign = full.results.find((r) => r.table === 1)!;

    let s = reduce(null, { t: 'start', config: c });
    s = reduce(s, { t: 'result', result: foreign });
    const after = s.results.length;
    for (let i = 0; i < 5; i++) s = reduce(s, { t: 'result', result: foreign });
    expect(s.results.length).toBe(after);
  });

  it('refuses a result for a table that does not exist', () => {
    const c = config(8);
    const { state: full } = playAll(c);
    const bogus: BoardResult = { ...full.results[0]!, table: 99 };
    const s = reduce(null, { t: 'start', config: c });
    expect(() => reduce(s, { t: 'result', result: bogus })).toThrow(/No such table/);
  });

  it('leaves the importing node’s own play untouched', () => {
    const c = config(8);
    const { state: full } = playAll(c);
    let s = reduce(null, { t: 'start', config: c });
    const before = JSON.stringify(s.tables[0]);
    s = reduce(s, { t: 'result', result: full.results.find((r) => r.table === 1)! });
    expect(JSON.stringify(s.tables[0])).toBe(before);
  });
});
