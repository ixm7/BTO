import { describe, expect, it } from 'vitest';
import { EXTEND_MS, MAX_EXTENSIONS, MIN_WAIT_MS, SETTLE_MS, Directory, makeMeta, issueBody, pinnedRoster, planStart, type RawComment, type TournamentMeta } from '../src/directory/github';

const meta: TournamentMeta = makeMeta({
  name: 'Auto', director: 'Ido', start: '2030-01-01T19:30', timeZone: 'UTC',
  capacity: 8, rounds: 1, boardsPerRound: 2, levels: ['Beginner', 'Intermediate', 'Advanced', 'Expert', 'World Class'],
} as never);
const T0 = Date.parse(meta.startUtc);
const S = 1000;
const M = 60 * S;
const reg = (who: string, at: number): RawComment => ({ user: { login: who }, body: `/register ${who}`, created_at: new Date(at).toISOString() });
const wd = (who: string, at: number): RawComment => ({ user: { login: who }, body: '/withdraw', created_at: new Date(at).toISOString() });
const players = (n: number, at: number): RawComment[] => Array.from({ length: n }, (_, i) => reg(`p${i}`, at + i));
const later = (at: number) => at + SETTLE_MS;

describe('automatic start', () => {
  it('waits for the start time', () => {
    expect(planStart(meta, players(8, T0 - M), T0 - 1)).toEqual({ kind: 'wait', until: T0, extensions: 0 });
  });

  it('1. starts on time when full — once everyone has had time to see the same comments', () => {
    const cs = players(8, T0 - 10 * M);
    expect(planStart(meta, cs, T0 + 1).kind).toBe('wait');
    expect(planStart(meta, cs, later(T0))).toEqual({ kind: 'start', at: T0 });
  });

  it('2. with fewer than four, waits five minutes, then cancels', () => {
    expect(planStart(meta, [], T0 + 4 * M)).toEqual({ kind: 'wait', until: T0 + MIN_WAIT_MS, extensions: 0 });
    expect(planStart(meta, players(3, T0 - M), later(T0 + MIN_WAIT_MS))).toEqual({ kind: 'cancel', at: T0 + MIN_WAIT_MS });
  });

  it('2→3. the fourth arriving inside five minutes opens the one-minute window from then', () => {
    const fourth = T0 + 3 * M;
    const cs = [...players(3, T0 - M), reg('late', fourth)];
    expect(planStart(meta, cs, fourth + 30 * S)).toEqual({ kind: 'wait', until: fourth + EXTEND_MS, extensions: 0 });
    expect(planStart(meta, cs, later(fourth + EXTEND_MS))).toEqual({ kind: 'start', at: fourth + EXTEND_MS });
  });

  it('3. short of full: one minute, then starts if nobody else came', () => {
    const cs = players(5, T0 - M);
    expect(planStart(meta, cs, T0 + 30 * S)).toEqual({ kind: 'wait', until: T0 + EXTEND_MS, extensions: 0 });
    expect(planStart(meta, cs, later(T0 + EXTEND_MS))).toEqual({ kind: 'start', at: T0 + EXTEND_MS });
  });

  it('3. each newcomer buys another minute, at most five times', () => {
    const cs = players(4, T0 - M);
    /* Someone arrives in every minute, more often than the rule allows for. */
    for (let k = 0; k < 7; k++) cs.push(reg(`x${k}`, T0 + k * M + 30 * S));
    const big = { ...meta, capacity: 100 };
    expect(planStart(big, cs, T0 + 2 * M + 10 * S)).toEqual({ kind: 'wait', until: T0 + 3 * M, extensions: 2 });
    const end = T0 + (MAX_EXTENSIONS + 1) * EXTEND_MS;
    expect(planStart(big, cs, later(end))).toEqual({ kind: 'start', at: end });
  });

  it('3. filling up during a window starts it at that moment', () => {
    const cs = [...players(6, T0 - M), reg('a', T0 + 20 * S), reg('b', T0 + 40 * S)];
    expect(planStart(meta, cs, later(T0 + 40 * S))).toEqual({ kind: 'start', at: T0 + 40 * S });
  });

  it('3. withdrawals that leave it short at the close cancel it', () => {
    const cs = [...players(4, T0 - M), wd('p0', T0 + 10 * S)];
    expect(planStart(meta, cs, later(T0 + EXTEND_MS))).toEqual({ kind: 'cancel', at: T0 + EXTEND_MS });
  });
});

/* ---------------------------------------------------------- through the directory */

function fakeGitHub(comments: RawComment[]) {
  const issue = { number: 7, node_id: 'I_7', html_url: 'u', title: 't', body: issueBody(meta), state: 'open', user: { login: 'ixm7' }, comments: comments.length };
  return async (url: string): Promise<Response> => {
    const body = url.includes('/comments') ? comments : url.endsWith('/issues/7') ? issue : [issue];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('the listing every browser sees', () => {
  it('starts with the field as it stood at the close, the same seed everywhere, latecomers left out', async () => {
    const cs = [...players(5, T0 - M), reg('late', T0 + 2 * M), wd('p1', T0 + 3 * M)];
    const now = later(T0 + EXTEND_MS) + 5 * M;
    const a = await new Directory('ixm7/BTO', null, fakeGitHub(cs) as never).get(7, now);
    const b = await new Directory('ixm7/BTO', null, fakeGitHub(cs) as never).get(7, now + 9 * M);
    expect(a.status).toBe('in progress');
    expect(a.pinned?.at).toBe(new Date(T0 + EXTEND_MS).toISOString());
    expect(a.pinned?.seed).toMatch(/^[0-9a-f]{24}$/);
    expect(b.pinned?.seed).toBe(a.pinned?.seed);
    /* p1 withdrew after the close and is still in; "late" came after it and is not. */
    expect(pinnedRoster(a).map((r) => r.login)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('shows "starting" while entries are open, and cancelled for want of players', async () => {
    const d = new Directory('ixm7/BTO', null, fakeGitHub(players(2, T0 - M)) as never);
    expect((await d.get(7, T0 + M)).status).toBe('starting');
    const off = await d.get(7, later(T0 + MIN_WAIT_MS));
    expect(off.status).toBe('cancelled');
    expect(off.tooFew).toBe(true);
    expect(off.pinned).toBeNull();
  });
});
