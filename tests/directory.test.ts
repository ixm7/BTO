import { describe, expect, it } from 'vitest';
import { Directory, deriveStatus, issueBody, makeMeta, parseMeta, parseRegistrations, parseRepo, type TournamentResults } from '../src/directory/github';
import { formatInZone, zonedToUtc } from '../src/directory/time';

const base = { name: 'Friday Pairs', director: 'Ido', start: '2026-11-20T19:30', timeZone: 'America/New_York', level: 'Intermediate' as const, capacity: 16, boardsPerRound: 2, rounds: 4 };

describe('time zones', () => {
  it('converts wall time in a zone to UTC, including daylight saving', () => {
    expect(zonedToUtc('2026-11-20T19:30', 'America/New_York').toISOString()).toBe('2026-11-21T00:30:00.000Z');
    expect(zonedToUtc('2026-07-04T19:30', 'America/New_York').toISOString()).toBe('2026-07-04T23:30:00.000Z');
    expect(zonedToUtc('2026-01-15T09:00', 'Asia/Kolkata').toISOString()).toBe('2026-01-15T03:30:00.000Z');
    expect(zonedToUtc('2026-06-01T12:00', 'Europe/London').toISOString()).toBe('2026-06-01T11:00:00.000Z');
    expect(zonedToUtc('2026-12-25T00:00', 'UTC').toISOString()).toBe('2026-12-25T00:00:00.000Z');
    expect(zonedToUtc('2026-03-08T03:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('formats an instant in another zone', () => {
    expect(formatInZone(new Date('2026-11-21T00:30:00Z'), 'America/New_York', 'en-US')).toMatch(/Fri, Nov 20, 2026.*7:30.*PM.*EST/);
  });
});

describe('issue format', () => {
  it('round-trips metadata through the issue body', () => {
    const meta = makeMeta(base);
    expect(meta.startUtc).toBe('2026-11-21T00:30:00.000Z');
    const body = issueBody(meta);
    expect(body).toContain('/register');
    expect(parseMeta(body)).toEqual(meta);
    expect(parseMeta('just a bug report')).toBeNull();
    expect(parseMeta('<!-- bridge-tournament {broken -->')).toBeNull();
  });
  it('validates input', () => {
    expect(() => makeMeta({ ...base, name: ' ' })).toThrow(/name/);
    expect(() => makeMeta({ ...base, capacity: 2 })).toThrow(/Capacity/);
    expect(() => makeMeta({ ...base, timeZone: 'Mars/Olympus' })).toThrow();
  });
  it('parses registrations: latest command per user wins, order by first registration', () => {
    const c = (login: string, body: string, t: number) => ({ user: { login }, body, created_at: `2026-11-01T00:00:${String(t).padStart(2, '0')}Z` });
    const regs = parseRegistrations([
      c('ann', '/register Ann A pair:blue', 1), c('bob', 'Looking forward to it!', 2), c('cat', '/register', 3),
      c('dan', '/register Dan', 4), c('dan', '/withdraw', 5), c('ann', 'hi\n/register Annie pair: Blue', 6),
      c('eve', '/withdraw', 7), c('dan', '/register Dan D', 8),
    ]);
    expect(regs).toEqual([
      { login: 'ann', name: 'Annie', pairCode: 'Blue', at: '2026-11-01T00:00:01Z' },
      { login: 'cat', name: 'cat', at: '2026-11-01T00:00:03Z' },
      { login: 'dan', name: 'Dan D', at: '2026-11-01T00:00:08Z' },
    ]);
  });
  it('derives status', () => {
    const meta = makeMeta(base);
    const start = Date.parse(meta.startUtc);
    expect(deriveStatus(meta, { state: 'open' }, null, start - 1)).toBe('upcoming');
    expect(deriveStatus(meta, { state: 'open' }, null, start + 60000)).toBe('in progress');
    expect(deriveStatus(meta, { state: 'open' }, null, start + 7 * 3600000)).toBe('expired');
    expect(deriveStatus(meta, { state: 'closed', state_reason: 'not_planned' }, null, start)).toBe('cancelled');
    expect(deriveStatus(meta, { state: 'closed', state_reason: 'completed' }, null, start)).toBe('finished');
  });
  it('accepts repository names and URLs', () => {
    expect(parseRepo('ido/bridge')).toEqual({ owner: 'ido', repo: 'bridge' });
    expect(parseRepo('https://github.com/ido/bridge-club.git')).toEqual({ owner: 'ido', repo: 'bridge-club' });
    expect(() => parseRepo('nope')).toThrow();
  });
});

/** A tiny in-memory stand-in for the GitHub Issues API. */
function fakeGitHub() {
  const issues: any[] = [];
  const comments = new Map<number, any[]>();
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 1, 0, 0, clock++)).toISOString();
  const calls: string[] = [];
  const fetcher = async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const login = /Bearer (\w+)/.exec(init.headers?.Authorization ?? '')?.[1];
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
    const path = url.replace('https://api.github.com', '');
    if (path === '/user') return login ? reply(200, { login }) : reply(401, {});
    if (!path.startsWith('/repos/club/bridge')) return reply(404, { message: 'Not Found' });
    const rest = path.replace('/repos/club/bridge', '');
    let m: RegExpExecArray | null;
    if (rest.startsWith('/issues?')) return reply(200, [...issues].reverse());
    if (rest === '/issues' && method === 'POST') {
      if (!login) return reply(401, {});
      const b = JSON.parse(init.body);
      const issue = { number: issues.length + 1, title: b.title, body: b.body, state: 'open', state_reason: null, comments: 0, user: { login }, html_url: `https://github.com/club/bridge/issues/${issues.length + 1}` };
      issues.push(issue);
      return reply(201, issue);
    }
    if ((m = /^\/issues\/(\d+)\/comments/.exec(rest))) {
      const n = Number(m[1]);
      if (method === 'POST') {
        if (!login) return reply(401, {});
        const list = comments.get(n) ?? [];
        list.push({ user: { login }, body: JSON.parse(init.body).body, created_at: stamp() });
        comments.set(n, list);
        issues[n - 1].comments++;
        return reply(201, {});
      }
      return reply(200, comments.get(n) ?? []);
    }
    if ((m = /^\/issues\/(\d+)$/.exec(rest))) {
      const issue = issues[Number(m[1]) - 1];
      if (!issue) return reply(404, {});
      if (method === 'PATCH') {
        if (login !== issue.user.login) return reply(403, { message: 'Must be author' });
        Object.assign(issue, JSON.parse(init.body));
      }
      return reply(200, issue);
    }
    return reply(404, {});
  };
  return { fetcher, issues, calls };
}

describe('GitHub directory', () => {
  it('creates, lists, registers, withdraws and publishes results', async () => {
    const gh = fakeGitHub();
    gh.issues.push({ number: 1, title: 'A bug', body: 'not a tournament', state: 'open', comments: 0, user: { login: 'x' }, html_url: '' });
    const as = (login: string | null) => new Directory('club/bridge', login, gh.fetcher);
    const director = as('ido');
    expect(await director.whoAmI()).toBe('ido');

    const meta = makeMeta(base);
    const number = await director.create(meta);
    const early = makeMeta({ ...base, name: 'Earlier', start: '2026-11-15T10:00' });
    await director.create(early);
    await expect(as(null).create(meta)).rejects.toThrow(/token/);

    await as('ann').register(number, 'Ann', 'red team');
    await as('bob').register(number, 'Bob');
    await as('cat').register(number, 'Cat');
    await as('cat').withdraw(number);

    const now = Date.parse('2026-11-10T12:00:00Z');
    const list = await as(null).list(now); // reading needs no login
    expect(list.map((l) => l.meta.name)).toEqual(['Earlier', 'Friday Pairs']);
    const t = list[1]!;
    expect(t).toMatchObject({ number, initiatorLogin: 'ido', status: 'upcoming', roomId: `club/bridge#${number}` });
    expect(t.meta).toMatchObject({ director: 'Ido', scoring: 'matchpoints', level: 'Intermediate', capacity: 16, timeZone: 'America/New_York' });
    expect(t.registrations!.map((r) => r.name)).toEqual(['Ann', 'Bob']);
    expect(t.registrations![0]!.pairCode).toBe('red-team');
    expect(list[0]!.registrations).toEqual([]);
    // Tournaments without comments cost no extra request.
    expect(gh.calls.filter((c) => c.includes('/comments') && c.startsWith('GET'))).toHaveLength(1);

    const results: TournamentResults = {
      v: 1, finishedAt: '2026-11-21T03:00:00Z', tables: 2, boards: 8,
      rankings: [{ rank: 1, players: 'Ann & Bob', direction: 'NS', percent: 62.5, matchpoints: 10, maxMatchpoints: 16 }],
    };
    // An outsider cannot plant results; a registered player can publish but not close; the director closes.
    await as('mallory').publishResults(number, { ...results, tables: 99 });
    expect((await as(null).get(number, now)).results).toBeNull();
    expect(await as('ann').publishResults(number, results)).toEqual({ closed: false });
    const done = await as(null).get(number, now);
    expect(done.status).toBe('finished');
    expect(done.results).toEqual(results);
    expect(await director.publishResults(number, results)).toEqual({ closed: true });
    expect(gh.issues[number - 1].state_reason).toBe('completed');
  });

  it('bypasses the HTTP cache so a refresh right after a write sees it, not a ~60s-stale response', async () => {
    const seen: (RequestCache | undefined)[] = [];
    const fetcher = async (_url: string, init: any = {}) => {
      seen.push(init.cache);
      return { ok: true, status: 200, json: async () => [], headers: { get: () => null } };
    };
    await new Directory('club/bridge', null, fetcher).list();
    expect(seen).toEqual(['no-store']);
  });

  it('builds a pre-filled github.com link for users without a token', () => {
    const d = new Directory('club/bridge');
    const url = new URL(d.newIssueUrl(makeMeta(base)));
    expect(url.origin + url.pathname).toBe('https://github.com/club/bridge/issues/new');
    expect(parseMeta(url.searchParams.get('body'))).toEqual(makeMeta(base));
  });

  it('explains a rate limit clearly', async () => {
    const d = new Directory('club/bridge', null, async () => ({ ok: false, status: 403, json: async () => ({}), headers: { get: () => '0' } }));
    await expect(d.list()).rejects.toThrow(/rate limit/i);
  });
});
