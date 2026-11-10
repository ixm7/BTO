import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHub } from '../src/net/transport';
import { TournamentNode, deviceScore, type Me } from '../src/tournament/node';
import { buildConfig, ewPairAt, replay, standings, turnAt, type TEvent } from '../src/tournament/state';
import { chooseCall, chooseCard } from '../src/engine/bot';

const nodes: TournamentNode[] = [];
afterEach(() => { for (const n of nodes.splice(0)) n.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 20000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(5);
  }
}

function join(hub: MemoryHub, me: Partial<Me> & { playerId: string }, peerId?: string): TournamentNode {
  const n = new TournamentNode(hub.connect(peerId), {
    name: me.playerId, deviceScore: 50, isDirector: false, ...me,
  }, { botDelayMs: 0, tickMs: 30, absentGraceMs: 60, peerTimeoutMs: 100000 });
  nodes.push(n);
  return n;
}

/** Make a node play its own seat automatically, like a human clicking legal cards. */
function autopilot(n: TournamentNode): void {
  const act = () => {
    const at = n.mySeat();
    if (!at) return;
    const turn = turnAt(at.table);
    if (!turn || at.table.seats[turn.controller].id !== n.me.playerId) return;
    if (turn.phase === 'auction') n.call(chooseCall(at.table.deal![turn.seat], at.table.auction!, turn.seat));
    else n.play(turn.seat, chooseCard(at.table.play!, turn.seat));
  };
  n.onChange(() => setTimeout(act, 0));
}

describe('configuration', () => {
  it('pairs by code, then randomly among the rest, and fills with robots', () => {
    const players = [
      { id: 'a', name: 'A', joinedAt: 1 }, { id: 'b', name: 'B', joinedAt: 2, pairCode: 'X' },
      { id: 'c', name: 'C', joinedAt: 3 }, { id: 'd', name: 'D', joinedAt: 4, pairCode: 'x ' },
      { id: 'e', name: 'E', joinedAt: 5 },
    ];
    const c = buildConfig({ id: 't', name: 'T', seed: 's', boardsPerRound: 2, players });
    expect(c.tables).toBe(2);
    expect(c.pairs).toHaveLength(4);
    const names = c.pairs.map((p) => p.players.map((x) => x.name).join('+'));
    expect(names[0]).toBe('B+D'); // paired by shared code, regardless of how the rest shuffle
    // A, C and E (no shared code) are shuffled rather than paired strictly in arrival order.
    // Three humans is odd, so one of them is seated with a robot, and because that leaves an
    // odd number of pairs overall, one further all-robot pair is added to fill out the tables.
    const allPairedPlayers = c.pairs.flatMap((p) => p.players);
    const humanNames = new Set(allPairedPlayers.filter((p) => !p.bot).map((p) => p.name));
    expect(humanNames).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
    expect(allPairedPlayers.filter((p) => p.bot)).toHaveLength(3);
  });
  it('randomizes who pairs with whom among players without a shared code, deterministically per seed', () => {
    const players = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, joinedAt: i }));
    const namesOf = (seed: string) => buildConfig({ id: 't', name: 'T', seed, boardsPerRound: 1, players })
      .pairs.map((p) => p.players.map((x) => x.name).join('+'));
    expect(namesOf('seed-a')).toEqual(namesOf('seed-a')); // same seed -> reproducible pairing
    expect(namesOf('seed-a')).not.toEqual(Array.from({ length: 4 }, (_, i) => `P${2 * i}+P${2 * i + 1}`)); // not plain arrival order
    expect(namesOf('seed-a')).not.toEqual(namesOf('seed-b')); // a different seed shuffles differently
  });
  it('respects capacity and always makes at least one full table', () => {
    const players = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, joinedAt: i }));
    expect(buildConfig({ id: 't', name: 'T', seed: 's', boardsPerRound: 1, players, capacity: 8 }).tables).toBe(2);
    const solo = buildConfig({ id: 't', name: 'T', seed: 's', boardsPerRound: 1, players: players.slice(0, 1) });
    expect(solo.tables).toBe(1);
    expect(solo.pairs.flatMap((p) => p.players).filter((p) => p.bot)).toHaveLength(3);
  });
  it('every East-West pair meets a different North-South pair each round', () => {
    const players = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, joinedAt: i }));
    const c = buildConfig({ id: 't', name: 'T', seed: 's', boardsPerRound: 1, players, rounds: 4 });
    for (let t = 0; t < 4; t++) expect(new Set([0, 1, 2, 3].map((r) => ewPairAt(c, t, r))).size).toBe(4);
    for (let r = 0; r < 4; r++) expect(new Set([0, 1, 2, 3].map((t) => ewPairAt(c, t, r))).size).toBe(4);
  });
  it('ranks desktops above tablets above phones as hosts', () => {
    const d = deviceScore({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', hardwareConcurrency: 8 });
    const t = deviceScore({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)', hardwareConcurrency: 8 });
    const p = deviceScore({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile', hardwareConcurrency: 8 });
    expect(d).toBeGreaterThan(t);
    expect(t).toBeGreaterThan(p);
  });
});

describe('peer-to-peer tournament', () => {
  it('eight browsers play a full matchpoint tournament and all agree on the result', async () => {
    const hub = new MemoryHub();
    const all = Array.from({ length: 8 }, (_, i) => join(hub, { playerId: `p${i}`, isDirector: i === 3, deviceScore: 50 + i }));
    all.forEach(autopilot);
    await until(() => all.every((n) => n.lobby().length === 8));
    const director = all[3]!;
    expect(all.every((n) => n.coordinatorName === 'p3')).toBe(true);
    expect(() => all[0]!.start({ id: 't1', name: 'Test', boardsPerRound: 2 })).toThrow(/host/);
    director.start({ id: 't1', name: 'Test', boardsPerRound: 2, rounds: 2, seed: 'fixed' });
    await until(() => all.every((n) => n.state?.finished === true));

    const s = director.state!;
    expect(s.config.tables).toBe(2);
    expect(s.results).toHaveLength(2 * 2 * 2); // tables x rounds x boards
    for (const n of all) expect(n.log).toEqual(director.log);
    // The log alone reproduces the whole tournament.
    expect(replay(JSON.parse(JSON.stringify(director.log)) as TEvent[])).toEqual(s);

    const table = standings(s);
    expect(table).toHaveLength(4);
    // Each board is scored once from each side, so percentages average exactly 50.
    const avg = table.reduce((a, r) => a + r.percent, 0) / table.length;
    expect(avg).toBeCloseTo(50, 1);
    expect(table.every((r) => r.boardsPlayed === 4)).toBe(true);
    expect(table[0]!.rank).toBe(1);
  });

  it('survives losing the host: another device takes over and a robot plays for the missing player', async () => {
    const hub = new MemoryHub();
    const all = Array.from({ length: 4 }, (_, i) => join(hub, { playerId: `p${i}`, isDirector: i === 0, deviceScore: 80 - i }));
    all.forEach(autopilot);
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 't2', name: 'Failover', boardsPerRound: 3, rounds: 1, seed: 'fail' });
    await until(() => (all[1]!.state?.results.length ?? 0) >= 1);
    all[0]!.close(); // the director's browser disappears mid-tournament
    const rest = all.slice(1);
    await until(() => rest.every((n) => n.coordinatorName === 'p1'));
    expect(rest[0]!.isCoordinator).toBe(true);
    await until(() => rest.every((n) => n.state?.finished === true));
    expect(rest[0]!.state!.results).toHaveLength(3);
    for (const n of rest) expect(n.log).toEqual(rest[0]!.log);
  });

  it('a player who reconnects with a new connection gets the log back and resumes their seat', async () => {
    const hub = new MemoryHub();
    const a = join(hub, { playerId: 'ann', isDirector: true });
    const b = join(hub, { playerId: 'bob' });
    autopilot(a);
    await until(() => a.lobby().length === 2 && b.lobby().length === 2);
    a.start({ id: 't3', name: 'Rejoin', boardsPerRound: 2, rounds: 1, seed: 'rejoin' });
    await until(() => b.state !== null);
    b.close();
    const b2 = join(hub, { playerId: 'bob' });
    autopilot(b2);
    await until(() => b2.state !== null && b2.mySeat() !== null);
    await until(() => a.state?.finished === true && b2.state?.finished === true);
    expect(b2.log).toEqual(a.log);
  });

  it('restores a tournament from persisted storage after a refresh', async () => {
    const hub = new MemoryHub();
    let saved: TEvent[] | null = null;
    const persist = { load: () => saved, save: (e: TEvent[]) => { saved = JSON.parse(JSON.stringify(e)); } };
    const a = new TournamentNode(hub.connect(), { playerId: 'solo', name: 'Solo', deviceScore: 1, isDirector: true },
      { botDelayMs: 0, tickMs: 30, persist });
    nodes.push(a);
    a.start({ id: 't4', name: 'Persist', boardsPerRound: 1, rounds: 1, seed: 'p' });
    await until(() => saved !== null); // the start event (robots then wait for the human)
    a.close();
    const again = new TournamentNode(hub.connect(), { playerId: 'solo', name: 'Solo', deviceScore: 1, isDirector: true },
      { botDelayMs: 0, tickMs: 30, persist });
    nodes.push(again);
    expect(again.state).not.toBeNull();
    expect(again.mySeat()).not.toBeNull();
  });
});
