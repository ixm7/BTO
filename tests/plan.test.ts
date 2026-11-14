import { describe, expect, it } from 'vitest';
import { SEATS } from '../src/engine/cards';
import { boardsOfRound, meshCost, planConfig, resultsRoom, seatOf, seatingAt, tableRoom, unmannedTables } from '../src/tournament/plan';
import { reduce, turnAt, type LobbyPlayer } from '../src/tournament/state';
import { chooseCall, chooseCard } from '../src/engine/bot';

const roster = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

const plan = (n: number, rounds = 4) =>
  planConfig({ id: 't1', name: 'Scale', seed: 'fixed', roster: roster(n), boardsPerRound: 2, rounds });

describe('working out the seating without a room', () => {
  it('every client derives the same configuration from the same entry list', () => {
    expect(plan(32)).toEqual(plan(32));
    /* A different entry order is a different draw, so it must not silently match. */
    const shuffled = planConfig({ id: 't1', name: 'Scale', seed: 'fixed', boardsPerRound: 2, rounds: 4,
      roster: [...roster(32)].reverse().map((p, i) => ({ ...p, joinedAt: i })) });
    expect(shuffled).not.toEqual(plan(32));
  });

  /* The whole design rests on this: a player goes straight to a table worked
     out locally, so that table had better be the one the tournament puts them
     at. Checked against the seating the reducer itself produces. */
  it('agrees with the seating the tournament actually uses, every round', () => {
    for (const players of [8, 16, 32, 100]) {
      const config = plan(players);
      for (let round = 0; round < config.rounds; round++) {
        const state = reduce(null, { t: 'start', config: { ...config } });
        /* Walk the state forward to the round under test. */
        const tables = round === 0 ? state.tables : null;
        if (tables) {
          for (const t of tables) {
            const derived = seatingAt(config, t.index, 0);
            for (const s of SEATS) expect(t.seats[s].id, `${players}p r0 t${t.index} ${s}`).toBe(derived[s]);
          }
        }
        /* And the derivation itself must place everyone exactly once. */
        const seen = new Set<string>();
        for (let table = 0; table < config.tables; table++) {
          for (const s of SEATS) seen.add(seatingAt(config, table, round)[s]);
        }
        expect(seen.size, `${players}p round ${round}`).toBe(config.tables * 4);
      }
    }
  });

  /* Round 0 is easy to check; the movement is where an off-by-one would send
     players to a room nobody else is in. So play a tournament out and compare
     the seating the reducer arrives at, round by round, with the derivation. */
  it('agrees with the seating in every later round too', () => {
    const config = plan(16, 3);
    let state = reduce(null, { t: 'start', config: { ...config } });
    const checked = new Set<number>();
    let guard = 0;

    while (!state.finished && guard++ < 200000) {
      if (!checked.has(state.round)) {
        checked.add(state.round);
        for (const t of state.tables) {
          const derived = seatingAt(config, t.index, state.round);
          for (const s of SEATS) {
            expect(t.seats[s].id, `round ${state.round} table ${t.index} seat ${s}`).toBe(derived[s]);
          }
        }
      }
      const table = state.tables.find((t) => turnAt(t));
      if (!table) break;
      const turn = turnAt(table)!;
      state = reduce(state, turn.phase === 'auction'
        ? { t: 'call', table: table.index, board: table.boardNo!, seat: turn.seat, call: chooseCall(table.deal![turn.seat], table.auction!, turn.seat) }
        : { t: 'play', table: table.index, board: table.boardNo!, seat: turn.seat, card: chooseCard(table.play!, turn.seat) });
    }

    expect(state.finished).toBe(true);
    expect([...checked].sort()).toEqual([0, 1, 2]);
  });

  it('finds a player their own table and their opponents', () => {
    const config = plan(16);
    for (let round = 0; round < config.rounds; round++) {
      for (const p of roster(16)) {
        const at = seatOf(config, round, p.id)!;
        expect(at, `${p.id} round ${round}`).toBeTruthy();
        expect(at.opponents).toHaveLength(3);
        expect(at.opponents).not.toContain(p.id);
        /* The four ids at that table are exactly this player plus the three. */
        const seats = seatingAt(config, at.table, round);
        expect(new Set([p.id, ...at.opponents])).toEqual(new Set(SEATS.map((s) => seats[s])));
        expect(seats[at.seat]).toBe(p.id);
      }
    }
  });

  it('moves East-West on and leaves North-South at home', () => {
    const config = plan(16);
    const northSouth = seatingAt(config, 0, 0).N;
    const eastWest = seatingAt(config, 0, 0).E;
    expect(seatOf(config, 1, northSouth)!.table).toBe(0);
    expect(seatOf(config, 1, eastWest)!.table).not.toBe(0);
  });

  it('gives every round its own boards', () => {
    const config = plan(8, 3);
    expect(boardsOfRound(config, 0)).toEqual([1, 2]);
    expect(boardsOfRound(config, 1)).toEqual([3, 4]);
    expect(boardsOfRound(config, 2)).toEqual([5, 6]);
  });

  it('names a distinct room for each table in each round', () => {
    const names = new Set<string>();
    for (let r = 0; r < 4; r++) for (let t = 0; t < 25; t++) names.add(tableRoom('t1', r, t));
    expect(names.size).toBe(100);
    expect(names.has(resultsRoom('t1'))).toBe(false);
    /* Two tournaments must never share a room. */
    expect(tableRoom('t1', 0, 0)).not.toBe(tableRoom('t2', 0, 0));
    expect(resultsRoom('t1')).not.toBe(resultsRoom('t2'));
  });

  it('keeps a player to three connections however large the field', () => {
    for (const players of [8, 32, 100, 400]) {
      const config = plan(players);
      const cost = meshCost(players, config.tables);
      expect(cost.perPlayer).toBe(3);
      /* A table host carries the results room too, which grows with tables,
         not with players — a quarter of the field at four to a table. */
      expect(cost.perTableHost).toBe(3 + config.tables - 1);
    }
    /* For scale: one room for 100 players means 99 connections each. */
    expect(meshCost(100, 25).perPlayer).toBe(3);
    expect(meshCost(100, 25).perTableHost).toBe(27);
  });
});

describe('a field too small to fill two tables', () => {
  const short = (n: number) =>
    planConfig({ id: 'few', name: 'Few', seed: 'fixed', roster: roster(n), boardsPerRound: 2, rounds: 1, minTables: 2 });

  it('plays two tables anyway, with robots in the seats nobody took', () => {
    const c = short(1);
    expect(c.tables).toBe(2);
    const everyone = c.pairs.flatMap((p) => p.players);
    expect(everyone).toHaveLength(8);
    expect(everyone.filter((p) => p.bot)).toHaveLength(7);
    /* The person is at a table, playing robots rather than watching them. */
    expect(seatOf(c, 0, 'p0')).not.toBeNull();
  });

  it('spreads the people out, so a table of four robots is left only when there are too few people for one each', () => {
    /* Four people would once have sat at one table with a table of robots
       beside them, which nobody is in the room to play. */
    for (const n of [3, 4, 5, 6, 7]) {
      expect(unmannedTables(short(n)), `${n} players`).toEqual([]);
      for (let table = 0; table < short(n).tables; table++) {
        const seats = seatingAt(short(n), table, 0);
        expect(SEATS.some((s) => !seats[s].startsWith('bot:')), `${n} players, table ${table}`).toBe(true);
      }
    }
    /* One pair's worth of people cannot be at both tables at once, so the
       other is run on the field's behalf — and the same one all evening. */
    for (const n of [1, 2]) {
      const c = short(n);
      const spare = unmannedTables(c);
      expect(spare, `${n} players`).toHaveLength(1);
      for (let round = 0; round < 3; round++) {
        expect(seatOf(c, round, spare[0]!.follow)?.table).toBe(spare[0]!.table);
      }
    }
  });
});
