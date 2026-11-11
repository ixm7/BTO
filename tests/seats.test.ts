import { describe, expect, it } from 'vitest';
import { SEATS } from '../src/engine/cards';
import { chooseCall, chooseCard } from '../src/engine/bot';
import { planConfig } from '../src/tournament/plan';
import { reduce, standIn, turnAt, type LobbyPlayer, type TEvent, type TState } from '../src/tournament/state';

const roster = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

const started = (n = 8, rounds = 2): TState =>
  reduce(null, { t: 'start', config: planConfig({ id: 's', name: 'Seats', seed: 'fixed', roster: roster(n), boardsPerRound: 2, rounds }) });

/** Play on until the given board is finished. */
function playBoard(state: TState): TState {
  const target = state.results.length;
  let guard = 0;
  while (state.results.length === target && guard++ < 100000) {
    const table = state.tables.find((t) => turnAt(t));
    if (!table) break;
    const turn = turnAt(table)!;
    const ev: TEvent = turn.phase === 'auction'
      ? { t: 'call', table: table.index, board: table.boardNo!, seat: turn.seat, call: chooseCall(table.deal![turn.seat], table.auction!, turn.seat) }
      : { t: 'play', table: table.index, board: table.boardNo!, seat: turn.seat, card: chooseCard(table.play!, turn.seat) };
    state = reduce(state, ev);
  }
  return state;
}

const seatOf = (s: TState, id: string) => {
  for (const t of s.tables) for (const x of SEATS) if (t.seats[x].id === id) return { table: t.index, seat: x };
  return null;
};

describe('standing down and sitting back in', () => {
  it('puts a robot in the seat of a player who stands down', () => {
    let s = started();
    const me = 'p0';
    expect(seatOf(s, me)).not.toBeNull();

    s = reduce(s, { t: 'retire', playerId: me });
    expect(s.retired).toContain(me);
    expect(seatOf(s, me)).toBeNull();

    /* The robot is named for whom it stands in for, so the table can see who
       is missing and a returning player can be matched back to their seat. */
    const stand = standIn({ id: me, name: 'Player 0' });
    const at = seatOf(s, stand.id)!;
    expect(at).not.toBeNull();
    expect(stand.name).toContain('Player 0');
  });

  it('gives a returning player their own seat back, on the next board', () => {
    let s = started();
    const me = 'p0';
    const home = seatOf(s, me)!;
    s = reduce(s, { t: 'retire', playerId: me });

    s = reduce(s, { t: 'seat', forPlayerId: me, player: null });
    /* Not yet: a hand is in progress and is not interrupted. */
    expect(seatOf(s, me)).toBeNull();
    expect(s.pendingSeats[me]).toBeNull();

    s = playBoard(s);
    expect(seatOf(s, me)).toEqual(home);
    expect(s.retired).not.toContain(me);
    expect(s.pendingSeats).toEqual({});
  });

  it('lets a newcomer take over a robot, and keeps the seat through the movement', () => {
    let s = started(8, 2);
    const gone = 'p0';
    s = reduce(s, { t: 'retire', playerId: gone });
    const late = { id: 'late', name: 'Latecomer' };

    s = reduce(s, { t: 'seat', forPlayerId: gone, player: late });
    s = playBoard(s);
    const at = seatOf(s, 'late');
    expect(at).not.toBeNull();
    expect(s.substitutes[gone]).toEqual(late);

    /* The stand-in follows that seat when the field moves round. */
    let guard = 0;
    const round = s.round;
    while (s.round === round && !s.finished && guard++ < 50) s = playBoard(s);
    if (!s.finished) expect(seatOf(s, 'late'), 'still seated after the move').not.toBeNull();
  });
});

describe('seats that are not free', () => {
  it('refuses a seat somebody is already sitting in', () => {
    const s = started();
    /* p1 is playing; nobody may take that seat from them. */
    expect(() => reduce(s, { t: 'seat', forPlayerId: 'p1', player: { id: 'late', name: 'Late' } }))
      .toThrow(/already/i);
  });

  it('refuses a second claim on the same seat', () => {
    let s = started();
    s = reduce(s, { t: 'retire', playerId: 'p0' });
    s = reduce(s, { t: 'seat', forPlayerId: 'p0', player: { id: 'a', name: 'A' } });
    expect(() => reduce(s, { t: 'seat', forPlayerId: 'p0', player: { id: 'b', name: 'B' } }))
      .toThrow(/already been taken/i);
  });

  it('refuses to seat one person twice', () => {
    let s = started();
    s = reduce(s, { t: 'retire', playerId: 'p0' });
    s = reduce(s, { t: 'retire', playerId: 'p1' });
    s = reduce(s, { t: 'seat', forPlayerId: 'p0', player: { id: 'late', name: 'Late' } });
    expect(() => reduce(s, { t: 'seat', forPlayerId: 'p1', player: { id: 'late', name: 'Late' } }))
      .toThrow(/already at a table/i);
  });

  it('refuses a seat that was never in the draw', () => {
    const s = started();
    expect(() => reduce(s, { t: 'seat', forPlayerId: 'nobody', player: { id: 'late', name: 'Late' } }))
      .toThrow(/No such seat/i);
  });

  it('replays to the same seating from the log alone', () => {
    let s = started();
    const log: TEvent[] = [];
    const add = (e: TEvent) => { log.push(e); s = reduce(s, e); };
    add({ t: 'retire', playerId: 'p0' });
    add({ t: 'seat', forPlayerId: 'p0', player: { id: 'late', name: 'Late' } });
    s = playBoard(s);

    let replayed = started();
    for (const e of JSON.parse(JSON.stringify(log)) as TEvent[]) replayed = reduce(replayed, e);
    replayed = playBoard(replayed);
    expect(replayed.substitutes).toEqual(s.substitutes);
    expect(replayed.retired).toEqual(s.retired);
    expect(seatOf(replayed, 'late')).toEqual(seatOf(s, 'late'));
  });
});
