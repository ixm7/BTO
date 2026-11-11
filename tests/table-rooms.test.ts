import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHub, type Transport } from '../src/net/transport';
import { TournamentNode } from '../src/tournament/node';
import { planConfig, seatOf, tableRoom } from '../src/tournament/plan';
import { standings, turnAt, type BoardResult, type LobbyPlayer, type TournamentConfig } from '../src/tournament/state';
import { chooseCall, chooseCard } from '../src/engine/bot';

const open: { close(): void }[] = [];
afterEach(() => { for (const x of open.splice(0)) x.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 30000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(5);
  }
}

const roster = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

/**
 * Plays one round the new way: every table in a room of its own, and a results
 * room holding only the table hosts. Returns every board the round produced.
 *
 * `carried` is what the field has already played. A player moves tables
 * between rounds, so each round is a fresh room with a fresh log, and the
 * backlog of results is what walks the new room's state up to the right round.
 */
async function playRound(config: TournamentConfig, round: number, carried: BoardResult[]): Promise<BoardResult[]> {
  const hubs = new Map<number, MemoryHub>();
  const resultsHub = new MemoryHub();
  const nodes: TournamentNode[] = [];
  const links: Transport[] = [];
  const roomNames = new Set<string>();
  const seatedAt = new Set<number>();

  for (const p of roster(config.tables * 4)) {
    const at = seatOf(config, round, p.id)!;
    roomNames.add(tableRoom(config.id, round, at.table));
    if (!hubs.has(at.table)) hubs.set(at.table, new MemoryHub());
    /* The first player to reach each table gets the strongest device, so the
       host of each table is settled rather than racing. */
    const first = !seatedAt.has(at.table);
    seatedAt.add(at.table);
    nodes.push(new TournamentNode(hubs.get(at.table)!.connect(), {
      playerId: p.id, name: p.name, deviceScore: first ? 99 : 10, isDirector: false,
    }, { botDelayMs: 0, tickMs: 20, absentGraceMs: 1e9, peerTimeoutMs: 1e9, idleTimeoutMs: 0, tableIndex: at.table }));
  }
  open.push({ close: () => { for (const n of nodes) n.close(); for (const l of links) l.leave(); } });

  /* One room per table, and one room where the hosts meet. Nothing else. */
  expect(roomNames.size).toBe(config.tables);

  await until(() => nodes.every((n) => n.lobby().length === 4));
  const hosts = nodes.filter((n) => n.isCoordinator);
  expect(hosts, `one host per table in round ${round}`).toHaveLength(config.tables);

  for (const h of hosts) {
    const link = resultsHub.connect();
    link.onMessage((msg) => {
      const r = (msg as { r?: BoardResult }).r;
      if (r) h.importResult(r);
    });
    h.onResult((r) => link.send({ r }));
    links.push(link);
  }

  for (const h of hosts) {
    h.startWithConfig(config);
    /* Bring this fresh room up to date with everything already played. */
    for (const r of carried) h.importResult(r);
  }
  await until(() => nodes.every((n) => n.state !== null && n.state.round === round));

  const tick = setInterval(() => {
    for (const n of nodes) {
      const at = n.mySeat();
      if (!at) continue;
      const turn = turnAt(at.table);
      if (!turn || at.table.seats[turn.controller].id !== n.me.playerId) continue;
      if (turn.phase === 'auction') n.call(chooseCall(at.table.deal![turn.seat], at.table.auction!, turn.seat));
      else n.play(turn.seat, chooseCard(at.table.play!, turn.seat));
    }
  }, 4);

  const wanted = carried.length + config.tables * config.boardsPerRound;
  try {
    await until(() => nodes.every((n) => n.state!.results.length >= wanted), 60000);
  } finally {
    clearInterval(tick);
  }

  const out = [...nodes[0]!.state!.results];
  for (const n of nodes) n.close();
  for (const l of links) l.leave();
  return out;
}

describe('one room per table', () => {
  it('plays a whole tournament with nobody ever connected to the field', async () => {
    const config = planConfig({ id: 'tt', name: 'Split', seed: 'fixed', roster: roster(16), boardsPerRound: 1, rounds: 3 });
    expect(config.tables).toBe(4);

    let results: BoardResult[] = [];
    for (let round = 0; round < config.rounds; round++) {
      results = await playRound(config, round, results);
      expect(results, `after round ${round}`).toHaveLength(config.tables * (round + 1) * config.boardsPerRound);
    }

    /* Scored as a tournament, from boards played in twelve separate rooms. */
    const table = standings({
      config, round: config.rounds - 1, tables: [], results, finished: true, aborted: false, retired: [], substitutes: {}, pendingSeats: {},
    });
    expect(table).toHaveLength(config.pairs.length);
    const avg = table.reduce((a, r) => a + r.percent, 0) / table.length;
    expect(avg).toBeCloseTo(50, 6);
    expect(table.every((r) => r.boardsPlayed === config.rounds * config.boardsPerRound)).toBe(true);
  }, 120000);
});
