import { describe, expect, it } from 'vitest';
import { EXTEND_MS, MAX_EXTENSIONS, MIN_PLAYERS, MIN_WAIT_MS, SETTLE_MS, Directory, makeMeta, issueBody, pinnedRoster, planStart, type RawComment, type TournamentMeta } from '../src/directory/github';

const meta: TournamentMeta = makeMeta({
  name: 'Auto', director: 'Ido', start: '2030-01-01T19:30', timeZone: 'UTC',
  capacity: 16, rounds: 1, boardsPerRound: 2, levels: ['Beginner', 'Intermediate', 'Advanced', 'Expert', 'World Class'],
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
    expect(planStart(meta, players(16, T0 - M), T0 - 1)).toEqual({ kind: 'wait', until: T0, extensions: 0 });
  });

  it('1. starts on time when full — once everyone has had time to see the same comments', () => {
    const cs = players(16, T0 - 10 * M);
    expect(planStart(meta, cs, T0 + 1).kind).toBe('wait');
    expect(planStart(meta, cs, later(T0))).toEqual({ kind: 'start', at: T0 });
  });

  it('2. with fewer than eight, waits five minutes, then plays with robots in the empty seats', () => {
    expect(planStart(meta, [], T0 + 4 * M)).toEqual({ kind: 'wait', until: T0 + MIN_WAIT_MS, extensions: 0 });
    /* Nobody is sent away for being too few — one player is enough to play. */
    for (const n of [1, 2, MIN_PLAYERS - 1]) {
      expect(planStart(meta, players(n, T0 - M), later(T0 + MIN_WAIT_MS))).toEqual({ kind: 'start', at: T0 + MIN_WAIT_MS });
    }
    /* Only an empty entry list is nothing to play. */
    expect(planStart(meta, [], later(T0 + MIN_WAIT_MS))).toEqual({ kind: 'cancel', at: T0 + MIN_WAIT_MS });
    /* And everyone withdrawing is an empty list too. */
    const gone = [...players(3, T0 - M), wd('p0', T0 + M), wd('p1', T0 + M), wd('p2', T0 + M)];
    expect(planStart(meta, gone, later(T0 + MIN_WAIT_MS))).toEqual({ kind: 'cancel', at: T0 + MIN_WAIT_MS });
  });

  it('2→3. reaching the minimum starts it at once when the tables come out even', () => {
    const eighth = T0 + 3 * M;
    const cs = [...players(7, T0 - M), reg('late', eighth)];
    expect(planStart(meta, cs, eighth + 10 * S).kind).toBe('wait');       // still settling
    expect(planStart(meta, cs, later(eighth))).toEqual({ kind: 'start', at: eighth });
  });

  it('2→3. reaching it with an odd number opens the one-minute window from then', () => {
    const when = T0 + 3 * M;
    /* Two arrive together: nine players, so a table would need robots. */
    const cs = [...players(7, T0 - M), reg('x', when), reg('y', when)];
    expect(planStart(meta, cs, when + 30 * S)).toEqual({ kind: 'wait', until: when + EXTEND_MS, extensions: 0 });
    expect(planStart(meta, cs, later(when + EXTEND_MS))).toEqual({ kind: 'start', at: when + EXTEND_MS });
  });

  it('3. short of full: one minute, then starts if nobody else came', () => {
    const cs = players(10, T0 - M);
    expect(planStart(meta, cs, T0 + 30 * S)).toEqual({ kind: 'wait', until: T0 + EXTEND_MS, extensions: 0 });
    expect(planStart(meta, cs, later(T0 + EXTEND_MS))).toEqual({ kind: 'start', at: T0 + EXTEND_MS });
  });

  it('3. each newcomer buys another minute, at most five times', () => {
    /* Nine players throughout: somebody new arrives each minute as somebody
       else drops out, so the tables never come out even and the waiting is
       only ever ended by the cap on extensions. */
    const cs = players(9, T0 - M);
    for (let k = 0; k < 7; k++) {
      const at = T0 + k * M + 30 * S;
      cs.push(reg(`x${k}`, at), wd(k === 0 ? 'p0' : `x${k - 1}`, at));
    }
    const big = { ...meta, capacity: 100 };
    expect(planStart(big, cs, T0 + 2 * M + 10 * S)).toEqual({ kind: 'wait', until: T0 + 3 * M, extensions: 2 });
    const end = T0 + (MAX_EXTENSIONS + 1) * EXTEND_MS;
    expect(planStart(big, cs, later(end))).toEqual({ kind: 'start', at: end });
  });

  it('3. filling up during a window starts it at that moment', () => {
    const cs = [...players(14, T0 - M), reg('a', T0 + 20 * S), reg('b', T0 + 40 * S)];
    expect(planStart(meta, cs, later(T0 + 40 * S))).toEqual({ kind: 'start', at: T0 + 40 * S });
  });

  it('3. withdrawals that leave it short at the close are covered by robots', () => {
    /* Nine, then two leave at once: seven play on, with a robot each side. */
    const cs = [...players(9, T0 - M), wd('p0', T0 + 10 * S), wd('p1', T0 + 10 * S)];
    expect(planStart(meta, cs, later(T0 + EXTEND_MS))).toEqual({ kind: 'start', at: T0 + EXTEND_MS });
  });

  it('waits only for a tournament that would need robots', () => {
    /* Whole tables of four: nobody to wait for, whatever the capacity. */
    for (const n of [8, 12, 16]) {
      expect(planStart({ ...meta, capacity: 20 }, players(n, T0 - M), later(T0))).toEqual({ kind: 'start', at: T0 });
    }
    /* Ten would leave a table of two, so entries stay open … */
    const ten = players(10, T0 - M);
    expect(planStart(meta, ten, T0 + 20 * S)).toEqual({ kind: 'wait', until: T0 + EXTEND_MS, extensions: 0 });
    /* … an eleventh still leaves a table short, so it keeps waiting … */
    const eleven = [...ten, reg('k', T0 + 20 * S)];
    expect(planStart(meta, eleven, T0 + 30 * S)).toEqual({ kind: 'wait', until: T0 + EXTEND_MS, extensions: 0 });
    /* … and a twelfth makes three full tables, which ends it at that moment. */
    const twelve = [...eleven, reg('l', T0 + 40 * S)];
    expect(planStart(meta, twelve, later(T0 + 40 * S))).toEqual({ kind: 'start', at: T0 + 40 * S });
    /* A withdrawal can even them out, which also ends the wait. */
    const nine = [...players(9, T0 - M), wd('p0', T0 + 25 * S)];
    expect(planStart(meta, nine, later(T0 + 25 * S))).toEqual({ kind: 'start', at: T0 + 25 * S });
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
    const cs = [...players(10, T0 - M), reg('late', T0 + 2 * M), wd('p1', T0 + 3 * M)];
    const now = later(T0 + EXTEND_MS) + 5 * M;
    const a = await new Directory('ixm7/BTO', null, fakeGitHub(cs) as never).get(7, now);
    const b = await new Directory('ixm7/BTO', null, fakeGitHub(cs) as never).get(7, now + 9 * M);
    expect(a.status).toBe('in progress');
    expect(a.pinned?.at).toBe(new Date(T0 + EXTEND_MS).toISOString());
    expect(a.pinned?.seed).toMatch(/^[0-9a-f]{24}$/);
    expect(b.pinned?.seed).toBe(a.pinned?.seed);
    /* p1 withdrew after the close and is still in; "late" came after it and is not. */
    expect(pinnedRoster(a).map((r) => r.login)).toEqual(Array.from({ length: 10 }, (_, i) => `p${i}`));
  });

  it('shows "starting" while entries are open, then plays a short field rather than calling it off', async () => {
    const d = new Directory('ixm7/BTO', null, fakeGitHub(players(7, T0 - M)) as never);
    expect((await d.get(7, T0 + M)).status).toBe('starting');
    const on = await d.get(7, later(T0 + MIN_WAIT_MS));
    expect(on.status).toBe('in progress');
    expect(on.noPlayers).toBeUndefined();
    expect(pinnedRoster(on)).toHaveLength(7);
  });

  it('calls off a tournament nobody entered', async () => {
    const d = new Directory('ixm7/BTO', null, fakeGitHub([]) as never);
    const off = await d.get(7, later(T0 + MIN_WAIT_MS));
    expect(off.status).toBe('cancelled');
    expect(off.noPlayers).toBe(true);
    expect(off.pinned).toBeNull();
  });
});

/* ------------------------------------------------------------- weekly series */

import { nextInSeries, nextWeekly, parseMeta, seriesDue } from '../src/directory/github';
import worker, { nextWeekly as relayNextWeekly } from '../relay/worker.js';

describe('weekly tournaments', () => {
  const ny = makeMeta({
    name: 'Thursday', director: 'Ido', start: '2026-10-29T19:30', timeZone: 'America/New_York',
    capacity: 16, rounds: 1, boardsPerRound: 2, levels: ['Expert'], repeat: 'weekly',
  } as never);

  it('keeps the wall-clock time across a change of clocks', () => {
    /* Clocks went back on Nov 1, 2026: 19:30 EDT is 23:30 UTC, 19:30 EST is 00:30 UTC. */
    expect(ny.startUtc).toBe('2026-10-29T23:30:00.000Z');
    const next = nextWeekly(ny, Date.parse(ny.startUtc) + 1);
    expect(next).toEqual({ start: '2026-11-05T19:30', startUtc: '2026-11-06T00:30:00.000Z' });
    expect(relayNextWeekly(ny, Date.parse(ny.startUtc) + 1)).toEqual(next);
  });

  it('skips weeks already gone, and remembers the series', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const n = nextInSeries(ny, 41, now);
    expect(n.start).toBe('2026-11-26T19:30');
    expect(n.seriesId).toBe(41);
    expect(parseMeta(issueBody(n))).toMatchObject({ repeat: 'weekly', seriesId: 41, start: '2026-11-26T19:30' });
  });

  it('asks only for series whose latest has begun, and that have not been stopped', () => {
    const at = Date.parse(ny.startUtc);
    const one = { issue: { number: 1, state: 'open' }, meta: ny };
    const next = { issue: { number: 2, state: 'open' }, meta: nextInSeries(ny, 1, at + 1) };
    expect(seriesDue([one], at - 1)).toEqual([]);
    expect(seriesDue([one], at + 1)).toEqual([1]);
    expect(seriesDue([one, next], at + 1)).toEqual([]); // next week's is already there
    expect(seriesDue([{ ...one, issue: { number: 1, state: 'closed', state_reason: 'not_planned' } }], at + 1)).toEqual([]);
    expect(seriesDue([{ ...one, issue: { number: 1, state: 'closed', state_reason: 'completed' } }], at + 1)).toEqual([1]);
    expect(seriesDue([{ ...one, meta: { ...ny, repeat: undefined } }], at + 1)).toEqual([]);
  });

  it('the relay creates next week\'s once, and refuses what is not due', async () => {
    const issues: { number: number; title: string; body: string; state: string; user: { login: string } }[] = [
      { number: 5, title: '🂡 Thursday', body: issueBody(ny), state: 'open', user: { login: 'ixm7' } },
      { number: 6, title: '🂡 Other', body: issueBody({ ...ny, repeat: undefined }), state: 'open', user: { login: 'ixm7' } },
    ];
    const real = globalThis.fetch;
    const store = new Map<string, Response>();
    (globalThis as { caches?: unknown }).caches = { default: { match: async () => undefined, put: async (r: Request, res: Response) => { store.set(r.url, res); }, delete: async () => true } };
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const m = /\/issues\/(\d+)$/.exec(u.pathname);
      if (init.method === 'POST' && u.pathname.endsWith('/issues')) {
        const b = JSON.parse(String(init.body));
        const made = { number: issues.length + 5, title: b.title, body: b.body, state: 'open', user: { login: 'ixm7' } };
        issues.push(made);
        return Response.json(made, { status: 201 });
      }
      if (m) return Response.json(issues.find((i) => i.number === Number(m[1])) ?? {}, { status: issues.some((i) => i.number === Number(m[1])) ? 200 : 404 });
      return Response.json([...issues].reverse());
    }) as typeof fetch;
    const ask = (issue: number) => worker.fetch(new Request('https://api.bridgebreak.org/act', {
      method: 'POST', headers: { Origin: 'https://www.bridgebreak.org', 'Content-Type': 'application/json' }, body: JSON.stringify({ act: 'repeat', issue }),
    }), { GITHUB_TOKEN: 't', REPO: 'ixm7/BTO', ALLOWED_ORIGINS: 'https://www.bridgebreak.org' }, { waitUntil: () => {} });
    try {
      const first = await ask(5);
      expect(first.status).toBe(200);
      const made = issues.at(-1)!;
      const meta = parseMeta(made.body)!;
      expect(meta.seriesId).toBe(5);
      expect(Date.parse(meta.startUtc)).toBeGreaterThan(Date.now());
      expect(made.body).toContain(`| **Start** | ${meta.start.replace('T', ' ')} (America/New_York)`);
      expect(made.title).toBe('🂡 Thursday');
      /* Asking again changes nothing. */
      const again = await ask(5);
      expect(await again.json()).toMatchObject({ existed: true });
      expect(issues).toHaveLength(3);
      /* The new one is not due until its own start; a one-off never is. */
      expect((await ask(made.number)).status).toBe(409);
      expect((await ask(6)).status).toBe(409);
    } finally { globalThis.fetch = real; }
  });
});
