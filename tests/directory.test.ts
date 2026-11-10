import { describe, expect, it } from 'vitest';
import { Directory, deriveStatus, inviteCode, issueBody, makeMeta, parseMeta, parsePartners, parseRegistrations, parseRepo, type TournamentResults } from '../src/directory/github';
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
  it('parses the partner-seeking list and invitations, folding comments in order', () => {
    const c = (login: string, body: string, t: number) => ({ user: { login }, body, created_at: `2026-11-01T00:00:${String(t).padStart(2, '0')}Z` });
    const { seekers, invitations } = parsePartners([
      c('ann', '/seek-partner looking for a strong 2/1 partner', 1),
      c('bob', '/seek-partner', 2),
      c('cat', 'just chatting', 3),
      c('ann', '/invite @bob want to play together?', 4),
      c('dan', '/seek-partner', 5),
      c('ann', '/invite @ann', 6), // an inviter cannot invite themselves: ignored entirely
      c('eve', '/invite @ann', 7), // eve was never a seeker, but inviting is still recorded
      c('bob', '/decline @ann', 8), // bob declines ann's invite from step 4
      c('ann', '/invite @bob.', 9), // re-invite after decline; trailing punctuation doesn't break the match or leak into the note
      c('bob', '/accept @ann', 10),
      c('dan', '/seek-partner cancel', 11),
      c('eve', '/invite-cancel @ann', 12),
    ]);
    expect(seekers).toEqual([
      { login: 'ann', note: 'looking for a strong 2/1 partner', at: '2026-11-01T00:00:01Z' },
      { login: 'bob', at: '2026-11-01T00:00:02Z' },
    ]); // dan cancelled, cat never joined, eve never joined
    expect(invitations).toEqual([
      // same (from, to) pair collapses to one entry carrying its latest event's status, note and timestamp
      { from: 'ann', to: 'bob', status: 'accepted', at: '2026-11-01T00:00:10Z' },
      { from: 'eve', to: 'ann', status: 'cancelled', at: '2026-11-01T00:00:12Z' },
    ]);
  });
  it('ignores a self-invite and treats accept/decline of a non-pending invite as a no-op', () => {
    const c = (login: string, body: string, t: number) => ({ user: { login }, body, created_at: `2026-11-01T00:00:${String(t).padStart(2, '0')}Z` });
    const { invitations } = parsePartners([
      c('ann', '/invite @ann', 1), // self-invite: ignored entirely
      c('bob', '/accept @ann', 2), // nothing pending from ann to bob: no-op
      c('ann', '/invite @bob', 3),
      c('bob', '/accept @ann', 4),
      c('bob', '/decline @ann', 5), // already accepted: a late decline does not flip it back
    ]);
    expect(invitations).toEqual([{ from: 'ann', to: 'bob', status: 'accepted', at: '2026-11-01T00:00:04Z' }]);
  });
  it('lets either side of an accepted partnership break it up with /unpair', () => {
    const c = (login: string, body: string, t: number) => ({ user: { login }, body, created_at: `2026-11-01T00:00:${String(t).padStart(2, '0')}Z` });
    // ann invited bob, so the invitation key is ann->bob; bob (the invitee) unpairs.
    const unpairedByInvitee = parsePartners([
      c('ann', '/invite @bob', 1), c('bob', '/accept @ann', 2), c('bob', '/unpair @ann', 3),
    ]).invitations;
    expect(unpairedByInvitee).toEqual([{ from: 'ann', to: 'bob', status: 'unpaired', at: '2026-11-01T00:00:03Z' }]);
    // Same, but ann (the inviter) unpairs instead.
    const unpairedByInviter = parsePartners([
      c('ann', '/invite @bob', 1), c('bob', '/accept @ann', 2), c('ann', '/unpair @bob', 3),
    ]).invitations;
    expect(unpairedByInviter).toEqual([{ from: 'ann', to: 'bob', status: 'unpaired', at: '2026-11-01T00:00:03Z' }]);
    // /unpair with nothing accepted between the two is a no-op.
    expect(parsePartners([c('ann', '/unpair @bob', 1)]).invitations).toEqual([]);
  });
  it('builds a stable, order-independent invite code for a pair', () => {
    expect(inviteCode(12, 'Ann', 'bob')).toBe(inviteCode(12, 'Bob', 'ann'));
    expect(inviteCode(12, 'ann', 'bob')).not.toBe(inviteCode(13, 'ann', 'bob'));
    expect(inviteCode(12, 'ann', 'bob')).toMatch(/^inv-12-ann-bob$/);
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

  it('runs a full partner-list flow through the Directory API: seek, invite, decline, re-invite, accept', async () => {
    const gh = fakeGitHub();
    const director = new Directory('club/bridge', 'ido', gh.fetcher);
    const number = await director.create(makeMeta(base));
    const as = (login: string) => new Directory('club/bridge', login, gh.fetcher);

    await as('ann').seekPartner(number, 'strong NT, prefers Stayman');
    await as('bob').seekPartner(number);
    let t = await director.get(number);
    expect(t.partners!.seekers.map((s) => s.login)).toEqual(['ann', 'bob']);
    expect(t.partners!.seekers[0]!.note).toBe('strong NT, prefers Stayman');
    expect(t.partners!.invitations).toEqual([]);

    await as('bob').invitePartner(number, 'ann', 'fancy a game?');
    t = await director.get(number);
    expect(t.partners!.invitations).toEqual([{ from: 'bob', to: 'ann', note: 'fancy a game?', status: 'pending', at: expect.any(String) }]);

    // Ann declines; Bob invites again; Ann accepts the second invitation.
    await as('ann').respondToInvite(number, 'bob', false);
    t = await director.get(number);
    expect(t.partners!.invitations[0]!.status).toBe('declined');

    await as('bob').invitePartner(number, 'ann');
    await as('ann').respondToInvite(number, 'bob', true);
    t = await director.get(number);
    expect(t.partners!.invitations).toHaveLength(1); // same (from, to) pair collapses to its latest status
    expect(t.partners!.invitations[0]!.status).toBe('accepted');

    // Ann leaves the seeking list; a separate, uninvited user can still cancel their own invite.
    await as('ann').seekPartner(number, 'updated note'); // still on the list, just a note change
    await as('cat').invitePartner(number, 'dan');
    await as('cat').cancelInvite(number, 'dan');
    await as('ann').cancelSeekingPartner(number);
    t = await director.get(number);
    expect(t.partners!.seekers.map((s) => s.login)).toEqual(['bob']);
    expect(t.partners!.invitations.find((i) => i.from === 'cat')).toEqual({ from: 'cat', to: 'dan', status: 'cancelled', at: expect.any(String) });

    await expect(new Directory('club/bridge', null, gh.fetcher).seekPartner(number)).rejects.toThrow(/token/);
  });

  it('breaks up and re-forms a partnership with unpair', async () => {
    const gh = fakeGitHub();
    const director = new Directory('club/bridge', 'ido', gh.fetcher);
    const number = await director.create(makeMeta(base));
    const as = (login: string) => new Directory('club/bridge', login, gh.fetcher);

    await as('bob').invitePartner(number, 'ann');
    await as('ann').respondToInvite(number, 'bob', true);
    let t = await director.get(number);
    expect(t.partners!.invitations[0]).toMatchObject({ from: 'bob', to: 'ann', status: 'accepted' });

    // Either side can split up; here the invitee (ann) does it.
    await as('ann').unpair(number, 'bob');
    t = await director.get(number);
    expect(t.partners!.invitations[0]).toMatchObject({ from: 'bob', to: 'ann', status: 'unpaired' });

    // They can re-invite and re-accept afterwards.
    await as('bob').invitePartner(number, 'ann');
    await as('ann').respondToInvite(number, 'bob', true);
    t = await director.get(number);
    expect(t.partners!.invitations[0]).toMatchObject({ from: 'bob', to: 'ann', status: 'accepted' });
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
