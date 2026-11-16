import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHub } from '../src/net/transport';
import { TournamentNode, idleMoments, type Me } from '../src/tournament/node';
import { SEATS } from '../src/engine/cards';
import { replay, turnAt, type TEvent, type TState } from '../src/tournament/state';

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

function join(hub: MemoryHub, me: Partial<Me> & { playerId: string }, idleTimeoutMs = 120): TournamentNode {
  const n = new TournamentNode(hub.connect(), {
    name: me.playerId, deviceScore: 50, isDirector: false, ...me,
  }, { botDelayMs: 0, tickMs: 20, absentGraceMs: 1_000_000, peerTimeoutMs: 100000, idleTimeoutMs });
  nodes.push(n);
  return n;
}

const humansLeft = (s: TState): number =>
  s.tables.reduce((n, t) => n + SEATS.filter((x) => !t.seats[x].bot).length, 0);

describe('replacing a player who stops responding', () => {
  it('seats a robot in their place, at every peer, and keeps them retired', async () => {
    const hub = new MemoryHub();
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `p${i}`, isDirector: i === 0 }));
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 't1', name: 'Idle', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));

    /* Nobody acts. Whoever is on lead keeps the table waiting past the limit. */
    const table0 = all[0]!.state!.tables[0]!;
    const onLead = table0.seats[turnAt(table0)!.controller];
    expect(onLead.bot).toBeFalsy();

    await until(() => all.every((n) => n.state!.retired.includes(onLead.id)), 8000);

    for (const n of all) {
      const seat = SEATS.find((s) => n.state!.tables[0]!.seats[s].id === `bot:${onLead.id}`);
      expect(seat, `${n.me.playerId} seated the stand-in`).toBeDefined();
      expect(n.state!.tables[0]!.seats[seat!].bot).toBe(true);
      expect(n.state!.tables[0]!.seats[seat!].name).toContain('Robot');
    }

    /* The log alone must reproduce the replacement for anyone joining late. */
    const fromLog = replay(JSON.parse(JSON.stringify(all[0]!.log)) as TEvent[])!;
    expect(fromLog.retired).toContain(onLead.id);
  });

  it('counts the waiting seat down, so the table can be warned before time is up', async () => {
    const hub = new MemoryHub();
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `w${i}`, isDirector: i === 0 }, 4000));
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 'tw', name: 'Clock', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));

    const n = all[0]!;
    await until(() => n.idleClock(0) !== null);
    const first = n.idleClock(0)!;
    expect(first.leftMs).toBeGreaterThan(0);
    expect(first.leftMs).toBeLessThanOrEqual(4000);

    await sleep(150);
    const later = n.idleClock(0)!;
    /* Same turn, less time: a countdown rather than a fresh start. */
    expect(later.key).toBe(first.key);
    expect(later.leftMs).toBeLessThan(first.leftMs);
  });

  it('starts each turn on a full clock, never the clock of the turn before', async () => {
    const hub = new MemoryHub();
    /* A slow coordinator, so that the gap between a turn starting and the
       clock being started for it is wide enough to look at — the gap a
       countdown used to fill with the previous turn's clock. */
    const all = [0, 1, 2, 3].map((i) => {
      const n = new TournamentNode(hub.connect(), { name: `f${i}`, deviceScore: 50, isDirector: i === 0, playerId: `f${i}` },
        { botDelayMs: 400, tickMs: 400, absentGraceMs: 1_000_000, peerTimeoutMs: 100000, idleTimeoutMs: 4000 });
      nodes.push(n);
      return n;
    });
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 'tf', name: 'Fresh', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));

    const host = all[0]!;
    await until(() => host.idleClock(0) !== null);
    /* Let the seat on turn keep the table waiting for a while. */
    await sleep(1500);
    expect(host.idleClock(0)!.leftMs).toBeLessThan(3000);

    const table = host.state!.tables[0]!;
    const turn = turnAt(table)!;
    const actor = all.find((n) => n.me.playerId === table.seats[turn.controller].id) as TournamentNode;
    actor.call({ type: 'pass' });
    /* Wait for the call to reach the host rather than for its own clock. */
    await until(() => turnAt(host.state!.tables[0]!)!.seat !== turn.seat);

    /* The next seat has only just been put on the clock, so either there is
       no clock to read yet or it is a full one. What it must never be is the
       last seat's clock, most of which has already gone. */
    const seen = host.idleClock(0);
    expect(seen === null || seen.leftMs > 3500).toBe(true);
    await until(() => (host.idleClock(0)?.leftMs ?? 0) > 3500);
  });

  it.each([
    [20_000, 10_000, 22_000],
    [30_000, 18_000, 30_000],
    [60_000, 48_000, 60_000],
    [900_000, 888_000, 900_000],
  ])('on a %ims clock warns at %ims and gives the seat up at %ims', (limit, warnAt, retireAt) => {
    expect(idleMoments(limit)).toEqual({ warnAt, retireAt });
    /* The two promises: ten seconds of turn before the warning, and twelve
       more after it — ten to act on, once the warning has been spoken. */
    expect(warnAt).toBeGreaterThanOrEqual(10_000);
    expect(retireAt - warnAt).toBeGreaterThanOrEqual(12_000);
  });

  it('has no clock to read when the tournament plays without one', async () => {
    const hub = new MemoryHub();
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `z${i}`, isDirector: i === 0 }, 0));
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 'tz', name: 'No clock', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));
    await sleep(100);
    expect(all[0]!.idleClock(0)).toBeNull();
  });

  it('closes a table once its last human is gone, and calls the tournament off', async () => {
    const hub = new MemoryHub();
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `q${i}`, isDirector: i === 0 }));
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 't2', name: 'Abandoned', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));

    const started = all[0]!.state!;
    expect(humansLeft(started)).toBe(4);
    expect(started.tables.every((t) => t.active)).toBe(true);

    /* With nobody acting, every seat times out in turn. */
    await until(() => all[0]!.state!.aborted, 20000);

    const s = all[0]!.state!;
    expect(humansLeft(s)).toBe(0);
    expect(s.finished).toBe(true);
    expect(s.tables.filter((t) => t.hadHuman).every((t) => !t.active)).toBe(true);

    /* Every peer must reach the same verdict, and so must a fresh replay. */
    await until(() => all.every((n) => n.state!.aborted));
    expect(replay(JSON.parse(JSON.stringify(all[0]!.log)) as TEvent[])!.aborted).toBe(true);
  });

  it('leaves a closed table alone: no further play is accepted there', async () => {
    const hub = new MemoryHub();
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `r${i}`, isDirector: i === 0 }));
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 't3', name: 'Closed', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));
    await until(() => all[0]!.state!.aborted, 20000);

    for (const t of all[0]!.state!.tables.filter((x) => x.hadHuman)) {
      expect(turnAt(t)).toBeNull();
    }
    const before = all[0]!.log.length;
    await sleep(300);
    expect(all[0]!.log.length).toBe(before);
  });

  it('never retires anyone when the rule is switched off, as in the demo', async () => {
    const hub = new MemoryHub();
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `d${i}`, isDirector: i === 0 }, 0));
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 't4', name: 'Demo', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));

    await sleep(600);
    const s = all[0]!.state!;
    expect(s.retired).toEqual([]);
    expect(s.aborted).toBe(false);
    expect(humansLeft(s)).toBe(4);
  });

  it('does not call off a live tournament because a filler table is all robots', async () => {
    const hub = new MemoryHub();
    /* Two humans padded out to two tables: the second is robots only, there to
       give the humans scores to be compared against. */
    const all = [0, 1].map((i) => join(hub, { playerId: `f${i}`, isDirector: i === 0 }, 0));
    await until(() => all.every((n) => n.lobby().length === 2));
    all[0]!.start({ id: 't6', name: 'Filler', boardsPerRound: 1, rounds: 1, seed: 'fixed', minTables: 2 });
    await until(() => all.every((n) => n.state !== null));

    const s = all[0]!.state!;
    const filler = s.tables.filter((t) => !t.hadHuman);
    expect(filler.length).toBeGreaterThan(0);
    expect(filler.every((t) => SEATS.every((x) => t.seats[x].bot))).toBe(true);
    /* All robots, but it must stay in play and must not abort the event. */
    expect(filler.every((t) => t.active)).toBe(true);
    expect(s.aborted).toBe(false);
  });

  it('calls the event off once the staffed tables empty, leaving filler aside', async () => {
    const hub = new MemoryHub();
    const all = [0, 1].map((i) => join(hub, { playerId: `g${i}`, isDirector: i === 0 }, 120));
    await until(() => all.every((n) => n.lobby().length === 2));
    all[0]!.start({ id: 't7', name: 'Thin', boardsPerRound: 1, rounds: 1, seed: 'fixed', minTables: 2 });
    await until(() => all.every((n) => n.state !== null));

    await until(() => all[0]!.state!.aborted, 20000);
    const s = all[0]!.state!;
    expect(s.tables.filter((t) => t.hadHuman).every((t) => !t.active)).toBe(true);
    expect(humansLeft(s)).toBe(0);
  });

  it('uses the director’s limit over the local one, so every host agrees', async () => {
    const hub = new MemoryHub();
    /* Each node is configured to retire nobody. The director's setting travels
       in the config and must override that for all of them. */
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `c${i}`, isDirector: i === 0 }, 0));
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 't8', name: 'Directed', boardsPerRound: 1, rounds: 1, seed: 'fixed', idleTimeoutMs: 120 });
    await until(() => all.every((n) => n.state !== null));

    expect(all[0]!.state!.config.idleTimeoutMs).toBe(120);
    await until(() => all[0]!.state!.retired.length > 0, 8000);
  });

  it('respects a longer limit from the director: nobody goes early', async () => {
    const hub = new MemoryHub();
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `h${i}`, isDirector: i === 0 }, 50));
    await until(() => all.every((n) => n.lobby().length === 4));
    /* The local option would retire after 50ms; the director says 10s. */
    all[0]!.start({ id: 't9', name: 'Patient', boardsPerRound: 1, rounds: 1, seed: 'fixed', idleTimeoutMs: 10000 });
    await until(() => all.every((n) => n.state !== null));

    await sleep(700);
    expect(all[0]!.state!.retired).toEqual([]);
  });

  it('lets a player stand themselves down from any device', async () => {
    const hub = new MemoryHub();
    const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `w${i}`, isDirector: i === 0 }, 0));
    await until(() => all.every((n) => n.lobby().length === 4));
    all[0]!.start({ id: 'tw', name: 'Withdraw', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));

    /* Not the host, so the request has to travel and be allowed through. */
    const quitter = all[3]!;
    expect(quitter.isCoordinator).toBe(false);
    quitter.withdraw();

    await until(() => all.every((n) => n.state!.retired.includes('w3')), 5000);
    /* A robot plays on in their place, as every peer sees it. */
    for (const n of all) expect(humansLeft(n.state!)).toBe(3);
    expect(quitter.mySeat()).toBeNull();
  });

  it('refuses a claim to be standing in for a player who is at the table', async () => {
    const hub = new MemoryHub();
    const all = [0, 1].map((i) => join(hub, { playerId: `y${i}`, isDirector: i === 0 }, 0));
    await until(() => all.every((n) => n.lobby().length === 2));
    all[0]!.start({ id: 't6', name: 'Impostor', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));

    /* y1 says it is playing y0's cards. y0 is sitting right there. */
    const victim = all[0]!.me.playerId;
    all[1]!.declareStanding({ [victim]: { round: 0, retired: true, sub: { id: 'y1', name: 'y1' } } });

    await sleep(300);
    expect(all[0]!.state!.retired).not.toContain(victim);
    expect(all[0]!.state!.substitutes).toEqual({});
    expect(humansLeft(all[0]!.state!)).toBe(2);
  });

  it('ignores a retirement a peer tries to force on someone else', async () => {
    const hub = new MemoryHub();
    const all = [0, 1].map((i) => join(hub, { playerId: `x${i}`, isDirector: i === 0 }, 0));
    await until(() => all.every((n) => n.lobby().length === 2));
    all[0]!.start({ id: 't5', name: 'Hostile', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
    await until(() => all.every((n) => n.state !== null));

    const victim = all[0]!.me.playerId;
    /* A peer sends the coordinator a retirement for somebody else. */
    const naughty = all[1]!;
    (naughty as unknown as { transport: { send(m: unknown, to: string): void } }).transport
      .send({ k: 'intent', ev: { t: 'retire', playerId: victim } }, (all[0]! as unknown as { transport: { selfId: string } }).transport.selfId);

    await sleep(300);
    expect(all[0]!.state!.retired).not.toContain(victim);
    expect(humansLeft(all[0]!.state!)).toBe(2);
  });
});
