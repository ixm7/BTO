import { afterEach, describe, expect, it } from 'vitest';
import { chooseCall, chooseCard } from '../src/engine/bot';
import { nsScore } from '../src/engine/scoring';
import { MemoryHub } from '../src/net/transport';
import { TournamentNode, type Me } from '../src/tournament/node';
import { planConfig } from '../src/tournament/plan';
import {
  claimBlocked, claimParties, claimWaitingOn, reduce, tricksLeft, turnAt,
  type LobbyPlayer, type TEvent, type TState, type TableState,
} from '../src/tournament/state';

const roster = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

/** One table of four people, so a claim is allowed. */
const started = (): TState =>
  reduce(null, { t: 'start', config: planConfig({ id: 'c', name: 'Claims', seed: 'claims-1', roster: roster(4), boardsPerRound: 2, rounds: 1 }) });

const act = (t: TableState): TEvent => {
  const turn = turnAt(t)!;
  return turn.phase === 'auction'
    ? { t: 'call', table: t.index, board: t.boardNo!, seat: turn.seat, call: chooseCall(t.deal![turn.seat], t.auction!, turn.seat) }
    : { t: 'play', table: t.index, board: t.boardNo!, seat: turn.seat, card: chooseCard(t.play!, turn.seat) };
};

/** Play on until `cards` cards of the current board are on the table (redealing passed-out boards). */
function playTo(s: TState, cards: number): TState {
  for (let guard = 0; guard < 5000; guard++) {
    const t = s.tables[0]!;
    if (t.play && t.play.cardsPlayed >= cards) return s;
    s = reduce(s, act(t));
  }
  throw new Error('did not get there');
}

const tbl = (s: TState): TableState => s.tables[0]!;
const ev = (s: TState, rest: Record<string, unknown>): TEvent => ({ table: 0, board: tbl(s).boardNo!, ...rest }) as TEvent;

describe('claims and concessions', () => {
  it('ends the board when both defenders accept declarer\'s claim', () => {
    let s = playTo(started(), 5); // one full trick and one card more
    const p = tbl(s).play!;
    const decl = p.contract.declarer;
    const [d1, d2] = claimParties(p).filter((x) => x !== decl);
    const left = tricksLeft(p);
    expect(left).toBe(12);
    const before = p.declarerTricks;
    const vul = tbl(s).vul;

    s = reduce(s, ev(s, { t: 'claim', seat: decl, toDeclarer: 9 }));
    expect(tbl(s).claim).toMatchObject({ seat: decl, toDeclarer: 9 });
    expect(turnAt(tbl(s))).toBeNull(); // nobody is on turn while it waits
    expect(claimWaitingOn(tbl(s)).sort()).toEqual([d1, d2].sort());
    /* No cards meanwhile. */
    expect(() => reduce(s, ev(s, { t: 'play', seat: p.turn, card: p.hands[p.turn][0] }))).toThrow(/paused/);
    /* Dummy has no say. */
    expect(() => reduce(s, ev(s, { t: 'claimAnswer', seat: p.dummy, accept: true }))).toThrow();

    s = reduce(s, ev(s, { t: 'claimAnswer', seat: d1, accept: true }));
    expect(s.results).toHaveLength(0);
    expect(() => reduce(s, ev(s, { t: 'claimAnswer', seat: d1, accept: true }))).toThrow(); // only once
    const board = tbl(s).boardNo!;
    s = reduce(s, ev(s, { t: 'claimAnswer', seat: d2, accept: true }));

    const r = s.results[0]!;
    expect(r.board).toBe(board);
    expect(r.declarerTricks).toBe(before + 9);
    expect(r.claimed).toBe(true);
    expect(r.nsScore).toBe(nsScore(p.contract, vul, before + 9));
    expect(tbl(s).boardNo).toBe(board + 1);
    expect(tbl(s).claim).toBeNull();
  });

  it('lets a defender concede, with declarer and partner agreeing', () => {
    let s = playTo(started(), 4);
    const p = tbl(s).play!;
    const defender = claimParties(p).find((x) => x !== p.contract.declarer)!;
    const before = p.declarerTricks;
    s = reduce(s, ev(s, { t: 'claim', seat: defender, toDeclarer: 3 }));
    const waiting = claimWaitingOn(tbl(s));
    expect(waiting).toContain(p.contract.declarer);
    expect(waiting).toHaveLength(2);
    for (const w of waiting) s = reduce(s, ev(s, { t: 'claimAnswer', seat: w, accept: true }));
    expect(s.results[0]!.declarerTricks).toBe(before + 3);
  });

  it('resumes play when the claim is refused or withdrawn', () => {
    let s = playTo(started(), 6);
    const p = tbl(s).play!;
    const decl = p.contract.declarer;
    const def = claimParties(p).find((x) => x !== decl)!;

    s = reduce(s, ev(s, { t: 'claim', seat: decl, toDeclarer: 2 }));
    s = reduce(s, ev(s, { t: 'claimAnswer', seat: def, accept: false }));
    expect(tbl(s).claim).toBeNull();
    expect(tbl(s).claimEnd).toEqual({ seat: decl, why: 'refused', by: def });
    expect(turnAt(tbl(s))?.seat).toBe(p.turn);

    s = reduce(s, ev(s, { t: 'claim', seat: decl, toDeclarer: 2 }));
    expect(() => reduce(s, ev(s, { t: 'claimOff', seat: def, why: 'withdrawn' }))).toThrow(/Only the player/);
    s = reduce(s, ev(s, { t: 'claimOff', seat: decl, why: 'withdrawn' }));
    expect(tbl(s).claimEnd?.why).toBe('withdrawn');

    /* The note goes once the next card is played. */
    s = reduce(s, act(tbl(s)));
    expect(tbl(s).claimEnd).toBeNull();
    expect(tbl(s).play!.cardsPlayed).toBe(7);
  });

  it('refuses claims that make no sense', () => {
    let s = playTo(started(), 0);
    const p = tbl(s).play!;
    expect(claimBlocked(tbl(s), p.contract.declarer)).toMatch(/opening lead/);
    s = playTo(s, 1);
    expect(claimBlocked(tbl(s), p.dummy)).toMatch(/Dummy/);
    expect(() => reduce(s, ev(s, { t: 'claim', seat: p.contract.declarer, toDeclarer: 14 }))).toThrow(/0 to 13/);
    expect(() => reduce(s, ev(s, { t: 'claim', seat: p.contract.declarer, toDeclarer: 1.5 }))).toThrow();
  });

  it('is off when a robot is among declarer and the defenders, and lapses if one takes a seat', () => {
    let s = playTo(started(), 2);
    const p = tbl(s).play!;
    const decl = p.contract.declarer;
    const def = claimParties(p).find((x) => x !== decl)!;
    s = reduce(s, ev(s, { t: 'claim', seat: decl, toDeclarer: 5 }));
    s = reduce(s, { t: 'retire', playerId: tbl(s).seats[def].id });
    expect(tbl(s).claim).toBeNull();
    expect(tbl(s).claimEnd?.why).toBe('lapsed');
    expect(claimBlocked(tbl(s), decl)).toMatch(/robot/);
  });

  it('does not mind a robot as dummy', () => {
    let s = playTo(started(), 2);
    const p = tbl(s).play!;
    s = reduce(s, { t: 'retire', playerId: tbl(s).seats[p.dummy].id });
    expect(claimBlocked(tbl(s), p.contract.declarer)).toBeNull();
  });
});

/* ---------------------------------------------------------------- over the wire */

const nodes: TournamentNode[] = [];
afterEach(() => { for (const n of nodes.splice(0)) n.close(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(5); }
}
function join(hub: MemoryHub, me: Partial<Me> & { playerId: string }, idleTimeoutMs: number): TournamentNode {
  const n = new TournamentNode(hub.connect(), { name: me.playerId, deviceScore: 50, isDirector: false, ...me },
    { botDelayMs: 0, tickMs: 20, absentGraceMs: 1_000_000, peerTimeoutMs: 100000, idleTimeoutMs });
  nodes.push(n);
  return n;
}

async function tableOfFour(idleTimeoutMs: number): Promise<TournamentNode[]> {
  const hub = new MemoryHub();
  const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `n${i}`, isDirector: i === 0 }, idleTimeoutMs));
  await until(() => all.every((n) => n.lobby().length === 4));
  all[0]!.start({ id: 'w', name: 'Wire', boardsPerRound: 1, rounds: 1, seed: 'claims-1', idleTimeoutMs });
  await until(() => all.every((n) => n.state !== null));
  /* Everyone plays their own turn until the opening lead and one more card. */
  for (let i = 0; i < 400; i++) {
    const t = all[0]!.state!.tables[0]!;
    if (t.play && t.play.cardsPlayed >= 2) break;
    const turn = turnAt(t)!;
    const who = all.find((n) => n.me.playerId === t.seats[turn.controller].id)!;
    const e = act(t);
    if (e.t === 'call') who.call(e.call); else if (e.t === 'play') who.play(e.seat, e.card);
    await until(() => all.every((n) => n.log.length === all[0]!.log.length) && all[0]!.log.length > 0);
    await sleep(2);
  }
  return all;
}
const nodeAt = (all: TournamentNode[], seat: string) => all.find((n) => n.mySeat()?.seat === seat)!;

describe('claims between peers', () => {
  it('a claim made and accepted at the table scores at every peer', async () => {
    const all = await tableOfFour(0);
    const t = all[0]!.state!.tables[0]!;
    const p = t.play!;
    const decl = nodeAt(all, p.contract.declarer);
    const defs = claimParties(p).filter((x) => x !== p.contract.declarer).map((x) => nodeAt(all, x));
    const dummy = nodeAt(all, p.dummy);

    decl.claim(7);
    await until(() => all.every((n) => !!n.state!.tables[0]!.claim));
    /* Dummy cannot answer for the defence. */
    dummy.answerClaim(true);
    await sleep(60);
    expect(all[0]!.state!.tables[0]!.claim!.agreed).toHaveLength(0);

    for (const d of defs) d.answerClaim(true);
    await until(() => all.every((n) => n.state!.finished));
    for (const n of all) {
      expect(n.state!.results[0]!.claimed).toBe(true);
      expect(n.state!.results[0]!.declarerTricks).toBe(p.declarerTricks + 7);
    }
  });

  it('a claim nobody answers lapses after the time limit, without costing anybody their seat', async () => {
    const all = await tableOfFour(200);
    const p = all[0]!.state!.tables[0]!.play!;
    nodeAt(all, p.contract.declarer).claim(5);
    await until(() => all.every((n) => n.state!.tables[0]!.claimEnd?.why === 'lapsed'), 4000);
    expect(all[0]!.state!.retired).toEqual([]);
    expect(all[0]!.state!.tables[0]!.claim).toBeNull();
  });
});
