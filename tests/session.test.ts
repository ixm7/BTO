import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHub, type Transport } from '../src/net/transport';
import { TournamentSession } from '../src/ui/session';
import { planConfig } from '../src/tournament/plan';
import { standings, turnAt, type LobbyPlayer } from '../src/tournament/state';
import { chooseCall, chooseCard } from '../src/engine/bot';

const live: TournamentSession[] = [];
afterEach(() => { for (const s of live.splice(0)) s.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 60000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(5);
  }
}

const roster = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

/** One hub per room name, so a room really is a room: nothing leaks between them. */
function world() {
  const hubs = new Map<string, MemoryHub>();
  const joined: string[] = [];
  return {
    hubs, joined,
    connect(room: string): Transport {
      joined.push(room);
      if (!hubs.has(room)) hubs.set(room, new MemoryHub());
      return hubs.get(room)!.connect();
    },
  };
}

describe('playing a tournament a table at a time', () => {
  it('moves itself between rounds and scores the whole field', async () => {
    const players = 16;
    const config = planConfig({ id: 'ses', name: 'Session', seed: 'fixed', roster: roster(players), boardsPerRound: 1, rounds: 3 });
    expect(config.tables).toBe(4);

    const net = world();
    const sessions = roster(players).map((p) => {
      const s = new TournamentSession({
        config, botDelayMs: 0,
        me: { playerId: p.id, name: p.name, deviceScore: Number(p.id.slice(1)), isDirector: false },
        connect: (room) => net.connect(room),
        onChange: () => { /* the interface would redraw here */ },
      });
      live.push(s);
      return s;
    });

    await Promise.all(sessions.map((s) => s.start()));
    await until(() => sessions.every((s) => s.node?.state));

    /* Everyone plays their own seat as it comes round to them. */
    const tick = setInterval(() => {
      for (const s of sessions) {
        const n = s.node;
        if (!n) continue;
        const at = n.mySeat();
        if (!at) continue;
        const turn = turnAt(at.table);
        if (!turn || at.table.seats[turn.controller].id !== n.me.playerId) continue;
        if (turn.phase === 'auction') n.call(chooseCall(at.table.deal![turn.seat], at.table.auction!, turn.seat));
        else n.play(turn.seat, chooseCard(at.table.play!, turn.seat));
      }
    }, 4);

    try {
      await until(() => sessions.every((s) => s.node?.state?.finished), 90000);
    } finally {
      clearInterval(tick);
    }

    const boards = config.tables * config.rounds * config.boardsPerRound;
    for (const s of sessions) {
      expect(s.node!.state!.results, `${s.node!.me.playerId} scored every board`).toHaveLength(boards);
      expect(s.round).toBe(config.rounds - 1);
    }

    /* Everybody agrees on the result, having seen only their own tables. */
    const first = standings(sessions[0]!.node!.state!);
    for (const s of sessions) expect(standings(s.node!.state!)).toEqual(first);
    expect(first.reduce((a, r) => a + r.percent, 0) / first.length).toBeCloseTo(50, 6);

    /* And the topology is what was promised: table rooms plus one for hosts. */
    const rooms = new Set(net.joined);
    const tableRooms = [...rooms].filter((r) => !r.endsWith('#results'));
    expect(tableRooms).toHaveLength(config.tables * config.rounds);
    expect([...rooms].filter((r) => r.endsWith('#results'))).toHaveLength(1);
    /* Four players in a table room, so three connections each. */
    for (const r of tableRooms) expect(net.hubs.get(r)!.ids().length).toBeLessThanOrEqual(4);
  }, 120000);

  it('tells a player who is not in the draw', async () => {
    const config = planConfig({ id: 'ses2', name: 'Session', seed: 'fixed', roster: roster(8), boardsPerRound: 1, rounds: 1 });
    const net = world();
    const s = new TournamentSession({
      config, botDelayMs: 0,
      me: { playerId: 'stranger', name: 'Stranger', deviceScore: 50, isDirector: false },
      connect: (room) => net.connect(room),
      onChange: () => { /* no-op */ },
    });
    live.push(s);
    await s.start();
    expect(s.notPlaying).toBe(true);
    expect(s.node).toBeNull();
    expect(net.joined).toEqual([]);
  });
});
