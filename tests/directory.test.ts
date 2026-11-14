import { describe, expect, it } from 'vitest';
import { DEFAULT_IDLE_SEC, KEEP_CANCELLED_MS, Directory, GitHubError, SKILLS, levelPhrase, levelText, toSkill, welcomes, KEEP_FINISHED_MS, parseStart, pinnedRoster, randomSeed, MAX_IDLE_SEC, MIN_IDLE_SEC, deriveStatus, idleSecOf, inviteCode, issueBody, makeMeta, parseMeta, parsePartners, parseRegistrations, parseRepo, playingWindowMs, visibleInList, type TournamentResults, byStart, type Listing, type Status
} from '../src/directory/github';
import { countdown, formatInZone, zonedToUtc } from '../src/directory/time';

const base = { name: 'Friday Pairs', director: 'Ido', start: '2026-11-20T19:30', timeZone: 'America/New_York', levels: ['Intermediate', 'Advanced'] as const, capacity: 16, boardsPerRound: 2, rounds: 4 };

describe('levels of player', () => {
  const open = { levels: [...SKILLS] };

  it('reads a level written by hand, whatever the capitals', () => {
    expect(toSkill('world class')).toBe('World Class');
    expect(toSkill('  EXPERT ')).toBe('Expert');
    expect(toSkill('World  Class')).toBe('World Class');
    expect(toSkill('Grandmaster')).toBeNull();
    expect(toSkill(undefined)).toBeNull();
  });

  it('welcomes everybody when every level is listed', () => {
    expect(levelText(open)).toBe('All levels');
    expect(welcomes(open, '')).toBe(true);
    expect(welcomes(open, 'Beginner')).toBe(true);
  });

  it('turns away a player whose level is not one of them', () => {
    const meta = { levels: ['Advanced', 'Expert'] as const };
    expect(levelText(meta)).toBe('Advanced, Expert');
    expect(levelPhrase(meta)).toBe('Advanced and Expert players');
    expect(levelPhrase({ levels: ['Beginner'] })).toBe('Beginner players');
    expect(levelPhrase(open)).toBe('players of any level');
    expect(welcomes(meta, 'Expert')).toBe(true);
    expect(welcomes(meta, 'Beginner')).toBe(false);
    /* Somebody who has not said is not turned away from an open tournament,
       but cannot claim a seat set aside for a level. */
    expect(welcomes(meta, '')).toBe(false);
  });

  it('keeps the listed levels in one order, whatever order they are given in', () => {
    expect(makeMeta({ ...base, levels: ['Expert', 'Beginner', 'Expert'] }).levels).toEqual(['Beginner', 'Expert']);
    expect(() => makeMeta({ ...base, levels: [] })).toThrow(/at least one/i);
  });

  it('treats a tournament made before levels existed as open to everyone', () => {
    const body = `<!-- bridge-tournament ${JSON.stringify({ v: 1, name: 'Old', startUtc: '2026-11-21T00:30:00.000Z', level: 'Novice', capacity: 16 })} -->`;
    expect(parseMeta(body)?.levels).toEqual([...SKILLS]);
  });

  it('carries the level a player gave when they registered', () => {
    const c = (login: string, body: string) => ({ user: { login }, body, created_at: '2026-11-01T00:00:01Z' });
    const regs = parseRegistrations([
      c('ann', '/register Ann A pair:blue level:World Class'),
      c('bob', '/register Bob level:expert pair:red'),
      c('cat', '/register Cat level:Grandmaster'),
    ]);
    expect(regs.find((r) => r.login === 'ann')).toMatchObject({ name: 'Ann A', pairCode: 'blue', skill: 'World Class' });
    expect(regs.find((r) => r.login === 'bob')).toMatchObject({ name: 'Bob', pairCode: 'red', skill: 'Expert' });
    /* Not a level we know, so it stays part of the name rather than vanishing. */
    expect(regs.find((r) => r.login === 'cat')).toMatchObject({ name: 'Cat level:Grandmaster' });
    expect(regs.find((r) => r.login === 'cat')?.skill).toBeUndefined();
  });
});

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
    const now = Date.parse('2026-11-14T15:00:00Z');
    /* This year, so no year; half past, so the minutes are worth saying. */
    expect(formatInZone(new Date('2026-11-21T00:30:00Z'), 'America/New_York', 'en-US', now)).toMatch(/^Fri, Nov 20, 7:30\s*PM EST$/);
    /* On the hour, where nobody says the minutes. */
    expect(formatInZone(new Date('2026-11-21T16:00:00Z'), 'America/New_York', 'en-US', now)).toMatch(/^Sat, Nov 21, 11\s*AM EST$/);
    /* Another year is the one thing worth saying, so it is said. */
    expect(formatInZone(new Date('2027-01-02T16:00:00Z'), 'America/New_York', 'en-US', now)).toMatch(/^Sat, Jan 2, 2027, 11\s*AM EST$/);
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
    // ann and bob paired up at step 10, so they are no longer looking; dan cancelled, cat and eve never joined
    expect(seekers).toEqual([]);
    expect(invitations).toEqual([
      // same (from, to) pair collapses to one entry carrying its latest event's status, note and timestamp
      { from: 'ann', to: 'bob', status: 'accepted', at: '2026-11-01T00:00:10Z' },
      { from: 'eve', to: 'ann', status: 'cancelled', at: '2026-11-01T00:00:12Z' },
    ]);
  });

  it('takes a pair off the partner list once they accept, and puts them back if they split up', () => {
    const c = (login: string, body: string, at: string) => ({ user: { login }, body, created_at: at });
    const base = [
      c('ann', '/seek-partner happy to play anything', '2026-11-01T10:00:00Z'),
      c('bob', '/seek-partner weekends only', '2026-11-01T10:01:00Z'),
      c('cat', '/seek-partner', '2026-11-01T10:02:00Z'),
      c('ann', '/invite @bob', '2026-11-01T10:03:00Z'),
    ];
    /* While the invitation is only pending, both are still looking. */
    expect(parsePartners(base).seekers.map((x) => x.login)).toEqual(['ann', 'bob', 'cat']);

    const accepted = [...base, c('bob', '/accept @ann', '2026-11-01T10:04:00Z')];
    const after = parsePartners(accepted);
    expect(after.seekers.map((x) => x.login)).toEqual(['cat']);
    expect(after.invitations.find((i) => i.from === 'ann')!.status).toBe('accepted');

    /* A declined one leaves them both on the list. */
    const declined = [...base, c('bob', '/decline @ann', '2026-11-01T10:04:00Z')];
    expect(parsePartners(declined).seekers.map((x) => x.login)).toEqual(['ann', 'bob', 'cat']);

    /* Splitting up means they are looking again. */
    const split = [...accepted, c('ann', '/unpair @bob', '2026-11-01T11:00:00Z')];
    expect(parsePartners(split).seekers.map((x) => x.login)).toEqual(['ann', 'bob', 'cat']);

    /* Somebody who never joined the list is not added to it by pairing up. */
    const dan = [c('cat', '/seek-partner', '2026-11-01T10:02:00Z'), c('dan', '/invite @cat', '2026-11-01T10:03:00Z'), c('cat', '/accept @dan', '2026-11-01T10:04:00Z')];
    expect(parsePartners(dan).seekers).toEqual([]);

    /* The descriptions outlive the list: they say how somebody plays, which
       the registered players panel shows whether or not they still want a partner. */
    expect(after.notes).toEqual({ ann: 'happy to play anything', bob: 'weekends only' });
    expect(parsePartners([...base, c('ann', '/seek-partner cancel', '2026-11-01T10:05:00Z')]).notes.ann).toBe('happy to play anything');
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
    /* Started, but no result was ever posted: abandoned, not still running. */
    expect(deriveStatus(meta, { state: 'open' }, null, start + playingWindowMs(meta) - 1)).toBe('in progress');
    expect(deriveStatus(meta, { state: 'open' }, null, start + playingWindowMs(meta) + 1)).toBe('abandoned');
    expect(deriveStatus(meta, { state: 'closed', state_reason: 'not_planned' }, null, start)).toBe('cancelled');
    expect(deriveStatus(meta, { state: 'closed', state_reason: 'completed' }, null, start)).toBe('finished');
    /* Waiting on the automatic start, and called off by it. */
    const late = start + 60000;
    expect(deriveStatus(meta, { state: 'open' }, null, late, { started: false, plan: { kind: 'wait', until: late, extensions: 0 } })).toBe('starting');
    expect(deriveStatus(meta, { state: 'open' }, null, late, { started: false, plan: { kind: 'cancel', at: late } })).toBe('cancelled');
    expect(deriveStatus(meta, { state: 'open' }, null, late, { started: true, plan: null })).toBe('in progress');
    /* Cancelled ones leave the list after a day. */
    expect(visibleInList({ status: 'cancelled', meta }, start + KEEP_CANCELLED_MS - 1000)).toBe(true);
    expect(visibleInList({ status: 'cancelled', meta }, start + KEEP_CANCELLED_MS + 1000)).toBe(false);
  });
  it('keeps the list to what is still useful', () => {
    const meta = makeMeta(base);
    const start = Date.parse(meta.startUtc);
    const at = (status: Parameters<typeof visibleInList>[0]['status']) => ({ status, meta });
    /* Abandoned events are of no use to anyone and go straight off the list. */
    /* An abandoned one is shown for a day after it should have finished, then dropped. */
    expect(visibleInList(at('abandoned'), start + playingWindowMs(meta) + 1000)).toBe(true);
    expect(visibleInList(at('abandoned'), start + playingWindowMs(meta) + KEEP_CANCELLED_MS + 1000)).toBe(false);
    /* A played event stays a week so its results can be read, then goes. */
    expect(visibleInList(at('finished'), start + KEEP_FINISHED_MS - 1000)).toBe(true);
    expect(visibleInList(at('finished'), start + KEEP_FINISHED_MS + 1000)).toBe(false);
    /* Anything still to come, or under way, always shows. */
    expect(visibleInList(at('upcoming'), start - 1000)).toBe(true);
    expect(visibleInList(at('in progress'), start + 1000)).toBe(true);
  });

  it('carries the director’s inactivity limit, and defaults it for older entries', () => {
    /* Tournaments created before the setting existed keep the old behaviour. */
    expect(idleSecOf(makeMeta(base))).toBe(DEFAULT_IDLE_SEC);
    expect(DEFAULT_IDLE_SEC).toBe(60);
    expect(idleSecOf(makeMeta({ ...base, idleTimeoutSec: 120 }))).toBe(120);
    expect(idleSecOf(makeMeta({ ...base, idleTimeoutSec: MIN_IDLE_SEC }))).toBe(MIN_IDLE_SEC);

    /* It survives the round trip through the issue body. */
    const meta = makeMeta({ ...base, idleTimeoutSec: 45 });
    expect(parseMeta(issueBody(meta))!.idleTimeoutSec).toBe(45);

    /* The director may not leave players too little time to think. */
    expect(MIN_IDLE_SEC).toBe(20);
    expect(() => makeMeta({ ...base, idleTimeoutSec: MIN_IDLE_SEC - 1 })).toThrow(/Inactivity/);
    expect(() => makeMeta({ ...base, idleTimeoutSec: 0 })).toThrow(/Inactivity/);
    expect(() => makeMeta({ ...base, idleTimeoutSec: MAX_IDLE_SEC + 1 })).toThrow(/Inactivity/);
    expect(() => makeMeta({ ...base, idleTimeoutSec: 30.5 })).toThrow(/Inactivity/);

    /* An issue hand-edited on GitHub is pulled back into range, not rejected. */
    const hacked = issueBody(meta).replace('"idleTimeoutSec": 45', '"idleTimeoutSec": 1');
    expect(parseMeta(hacked)!.idleTimeoutSec).toBe(MIN_IDLE_SEC);
  });

  it('accepts repository names and URLs', () => {
    expect(parseRepo('ido/bridge')).toEqual({ owner: 'ido', repo: 'bridge' });
    expect(parseRepo('https://github.com/ido/bridge-club.git')).toEqual({ owner: 'ido', repo: 'bridge-club' });
    expect(() => parseRepo('nope')).toThrow();
  });
});

/** A tiny in-memory stand-in for the GitHub Issues API.
 *  `canDelete` mirrors whether the token has admin rights on the repository,
 *  which is what GitHub requires before it will delete an issue. */
function fakeGitHub({ canDelete = true }: { canDelete?: boolean } = {}) {
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
    if (path === '/graphql') {
      if (!login) return reply(401, {});
      /* GitHub answers a refused mutation with 200 and an errors array. */
      if (!canDelete) return reply(200, { data: null, errors: [{ message: 'Must have admin access' }] });
      const id = JSON.parse(init.body).variables.id;
      const target = issues.find((i) => i.node_id === id);
      if (!target) return reply(200, { errors: [{ message: 'Could not resolve' }] });
      target.deleted = true;
      return reply(200, { data: { deleteIssue: { clientMutationId: null } } });
    }
    if (!path.startsWith('/repos/club/bridge')) return reply(404, { message: 'Not Found' });
    const rest = path.replace('/repos/club/bridge', '');
    let m: RegExpExecArray | null;
    if (rest.startsWith('/issues?')) return reply(200, [...issues].filter((i) => !i.deleted).reverse());
    if (rest === '/issues' && method === 'POST') {
      if (!login) return reply(401, {});
      const b = JSON.parse(init.body);
      const issue = { number: issues.length + 1, node_id: `NODE_${issues.length + 1}`, title: b.title, body: b.body, state: 'open', state_reason: null, comments: 0, user: { login }, html_url: `https://github.com/club/bridge/issues/${issues.length + 1}` };
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
    /* Soonest first: 'Earlier' starts on the 15th, 'Friday Pairs' on the 20th. */
    expect(list.map((l) => l.meta.name)).toEqual(['Earlier', 'Friday Pairs']);
    const t = list.find((l) => l.number === number)!;
    expect(t).toMatchObject({ number, initiatorLogin: 'ido', status: 'upcoming', roomId: `club/bridge#${number}` });
    expect(t.meta).toMatchObject({ director: 'Ido', scoring: 'matchpoints', levels: ['Intermediate', 'Advanced'], capacity: 16, timeZone: 'America/New_York' });
    expect(t.registrations!.map((r) => r.name)).toEqual(['Ann', 'Bob']);
    expect(t.registrations![0]!.pairCode).toBe('red-team');
    expect(list.find((l) => l.number !== number)!.registrations).toEqual([]);
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

    // Ann and Bob are partners now, so neither is on the seeking list, whatever Ann posts;
    // meanwhile a separate, uninvited user can still cancel their own invite.
    await as('ann').seekPartner(number, 'updated note');
    await as('cat').invitePartner(number, 'dan');
    await as('cat').cancelInvite(number, 'dan');
    await as('ann').cancelSeekingPartner(number);
    t = await director.get(number);
    expect(t.partners!.seekers).toEqual([]);
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

  it('explains a rate limit in words a player will understand', async () => {
    const reset = Math.floor(Date.now() / 1000) + 17 * 60;
    const headers = (reset_: number | null) => ({
      get: (k: string) => (k === 'x-ratelimit-remaining' ? '0' : reset_ === null ? null : String(reset_)),
    });
    const at = (r: number | null) => new Directory('club/bridge', null,
      async () => ({ ok: false, status: 403, json: async () => ({}), headers: headers(r) }));

    /* What went wrong, when it will right itself, and what to do about it. */
    await expect(at(reset).list()).rejects.toThrow(/asked for too often/i);
    await expect(at(reset).list()).rejects.toThrow(/answer again in 17 minutes/i);
    await expect(at(reset).list()).rejects.toThrow(/token/i);
    /* Players are not expected to know what the list is kept on. */
    await expect(at(reset).list()).rejects.not.toThrow(/github/i);

    /* The reset time is the service's to give; without it, say the rest. */
    await expect(at(null).list()).rejects.toThrow(/asked for too often/i);
    await expect(at(null).list()).rejects.not.toThrow(/answer again/i);

    /* And the error carries that time, so the page can stop asking until then. */
    const err = await at(reset).list().catch((e: unknown) => e as GitHubError);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).rateLimited).toBe(true);
    expect(Math.round(((err as GitHubError).resetAt!.getTime() - Date.now()) / 60000)).toBe(17);
  });
});

describe('clearing away abandoned tournaments', () => {
  /** A tournament that started long enough ago to count as abandoned. */
  const longAgo = { ...base, name: 'Abandoned', start: '2026-11-01T19:00' };
  /* They are swept only once they have dropped off the list of their own accord. */
  const unfinished = Date.parse(makeMeta(longAgo).startUtc) + playingWindowMs(makeMeta(longAgo)) + 1000;
  const after = unfinished + KEEP_CANCELLED_MS;

  it('leaves what is over on the list for a day, saying what became of it', async () => {
    const gh = fakeGitHub({ canDelete: true });
    const d = new Directory('club/bridge', 'ido', gh.fetcher);
    await d.create(makeMeta(longAgo));
    /* Nobody registered, so this one was called off rather than left unfinished. */
    const shown = await d.list(unfinished);
    expect(shown.map((l) => [l.meta.name, l.status])).toEqual([['Abandoned', 'cancelled']]);
    expect(d.abandoned).toEqual([]);
    expect(await d.sweepAbandoned()).toEqual([]);
  });

  it('calls a tournament that began and never finished abandoned', () => {
    const meta = makeMeta(longAgo);
    const start = Date.parse(meta.startUtc);
    const started = { started: true, plan: null };
    expect(deriveStatus(meta, { state: 'open' }, null, start + 60_000, started)).toBe('in progress');
    expect(deriveStatus(meta, { state: 'open' }, null, start + playingWindowMs(meta) + 1, started)).toBe('abandoned');
    /* A result posted at any point settles it, however late. */
    expect(deriveStatus(meta, { state: 'open' }, { rankings: [] } as never, start + playingWindowMs(meta) + 1, started)).toBe('finished');
  });

  it('deletes the issue outright when the token may', async () => {
    const gh = fakeGitHub({ canDelete: true });
    const d = new Directory('club/bridge', 'ido', gh.fetcher);
    await d.create(makeMeta(longAgo));
    await d.create(makeMeta({ ...base, name: 'Upcoming', start: '2026-12-20T19:00' }));

    const before = await d.list(after);
    expect(before.map((l) => l.meta.name)).toEqual(['Upcoming']);
    expect(d.abandoned.map((l) => l.meta.name)).toEqual(['Abandoned']);

    expect(await d.sweepAbandoned()).toEqual([{ number: 1, name: 'Abandoned', outcome: 'deleted' }]);
    /* Gone from GitHub, not merely hidden: a fresh listing cannot see it. */
    expect(gh.issues.find((i: any) => i.number === 1).deleted).toBe(true);
    expect((await d.list(after)).map((l) => l.meta.name)).toEqual(['Upcoming']);
    expect(d.abandoned).toEqual([]);
  });

  it('closes the issue instead when deleting is refused', async () => {
    const gh = fakeGitHub({ canDelete: false });
    const d = new Directory('club/bridge', 'ido', gh.fetcher);
    await d.create(makeMeta(longAgo));
    await d.list(after);

    expect(await d.sweepAbandoned()).toEqual([{ number: 1, name: 'Abandoned', outcome: 'closed' }]);
    const issue = gh.issues.find((i: any) => i.number === 1);
    expect(issue.deleted).toBeUndefined();
    expect(issue).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    /* Closed as not planned, so for the day it is still listed it reads as
       cancelled rather than abandoned — and after that it is gone. */
    expect((await d.list(unfinished))[0]).toMatchObject({ status: 'cancelled' });
    expect(await d.list(after)).toEqual([]);
  });

  it('leaves everything else alone', async () => {
    const gh = fakeGitHub();
    const d = new Directory('club/bridge', 'ido', gh.fetcher);
    await d.create(makeMeta({ ...base, name: 'Upcoming', start: '2026-12-20T19:00' }));
    await d.create(makeMeta({ ...base, name: 'Under way', start: '2026-11-20T19:00' }));

    const duringSecond = Date.parse(makeMeta({ ...base, start: '2026-11-20T19:00' }).startUtc) + 60000;
    await d.list(duringSecond);
    expect(d.abandoned).toEqual([]);
    expect(await d.sweepAbandoned()).toEqual([]);
    expect(gh.issues.every((i: any) => !i.deleted && i.state === 'open')).toBe(true);
  });

  it('never removes a tournament that has results', async () => {
    const gh = fakeGitHub();
    const d = new Directory('club/bridge', 'ido', gh.fetcher);
    const number = await d.create(makeMeta(longAgo));
    await d.publishResults(number, { v: 1, finishedAt: '2026-11-01T22:00:00Z', tables: 1, boards: 2, rankings: [] });

    const list = await d.list(after);
    /* Results make it finished, so it is not swept at all. */
    expect(list[0]).toMatchObject({ status: 'finished' });
    expect(d.abandoned).toEqual([]);
    await expect(d.remove({ ...list[0]!, status: 'abandoned' })).rejects.toThrow(/results/);
    expect(gh.issues[0].deleted).toBeUndefined();
  });

  it('reports a failure and carries on with the rest', async () => {
    const gh = fakeGitHub({ canDelete: false });
    const d = new Directory('club/bridge', 'ido', gh.fetcher);
    await d.create(makeMeta(longAgo));
    await d.create(makeMeta({ ...base, name: 'Abandoned too', start: '2026-10-28T19:00' }));
    await d.list(after);
    expect(d.abandoned).toHaveLength(2);

    /* The first issue belongs to someone else, so closing it is refused. */
    gh.issues[0].user.login = 'someone-else';
    const done = await d.sweepAbandoned();
    expect(done.map((x) => x.outcome).sort()).toEqual(['closed', 'failed']);
  });

  it('refuses to remove anything without a token', async () => {
    const gh = fakeGitHub();
    const d = new Directory('club/bridge', 'ido', gh.fetcher);
    await d.create(makeMeta(longAgo));
    const list = await d.list(after);
    const reader = new Directory('club/bridge', null, gh.fetcher);
    await expect(reader.remove({ ...list[0]!, ...d.abandoned[0]! })).rejects.toThrow(/token/);
  });
});

describe('closing the entry list', () => {
  const c = (login: string, body: string, sec: number) =>
    ({ user: { login }, body, created_at: `2026-11-01T00:00:${String(sec).padStart(2, '0')}Z` });

  it('takes the start only from the director, and only the first one', () => {
    const comments = [
      c('mallory', '/start aaaaaaaa', 1),
      c('ido', '/start bbbbbbbb', 2),
      c('ido', '/start cccccccc', 3),
    ];
    expect(parseStart(comments, 'ido')).toEqual({ seed: 'bbbbbbbb', at: '2026-11-01T00:00:02Z' });
    /* A redraw by anyone else, or a second one, must not move the field. */
    expect(parseStart([c('mallory', '/start aaaaaaaa', 1)], 'ido')).toBeNull();
    expect(parseStart([], 'ido')).toBeNull();
    expect(parseStart([c('ido', 'starting soon!', 1)], 'ido')).toBeNull();
  });

  it('freezes the field at that moment, and in a settled order', () => {
    const regs = parseRegistrations([
      c('ann', '/register Ann', 1),
      c('bob', '/register Bob', 2),
      c('cat', '/register Cat', 9),
    ]);
    const pinned = { seed: 'seedseed', at: '2026-11-01T00:00:05Z' };
    const roster = pinnedRoster({ registrations: regs, pinned });
    /* Cat entered after the director called time, so Cat is not in the draw. */
    expect(roster.map((r) => r.login)).toEqual(['ann', 'bob']);
    /* Until the start is called there is no field at all. */
    expect(pinnedRoster({ registrations: regs, pinned: null })).toEqual([]);
  });

  it('refuses a seed that could not have come from us', () => {
    const d = new Directory('club/bridge', 'ido', async () => ({ ok: true, status: 200, json: async () => ({}), headers: { get: () => null } }));
    expect(() => d.pinStart(1, 'short')).toThrow(/seed/i);
    expect(() => d.pinStart(1, 'has spaces in it')).toThrow(/seed/i);
    expect(randomSeed()).toMatch(/^[a-z0-9]{12}$/);
    expect(randomSeed()).not.toBe(randomSeed());
  });
});

describe('the order of the list', () => {
  const at = (name: string, start: string, status: Status): Listing =>
    ({ meta: { name, startUtc: start }, status }) as unknown as Listing;

  it('puts the next tournament at the top and what is over below', () => {
    const rows = [
      at('later today', '2030-03-01T23:00:00Z', 'upcoming'),
      at('last week', '2030-02-22T19:00:00Z', 'finished'),
      at('in an hour', '2030-03-01T20:00:00Z', 'upcoming'),
      at('yesterday', '2030-02-28T19:00:00Z', 'finished'),
      at('playing now', '2030-03-01T18:30:00Z', 'in progress'),
      at('next week', '2030-03-08T19:00:00Z', 'upcoming'),
      at('called off', '2030-03-01T12:00:00Z', 'cancelled'),
    ];
    expect([...rows].sort(byStart).map((l) => l.meta.name)).toEqual([
      'playing now', 'in an hour', 'later today', 'next week',   // soonest first
      'called off', 'yesterday', 'last week',                     // then the past, most recent first
    ]);
  });
});

describe('the countdown to a start', () => {
  const now = Date.parse('2026-11-13T18:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();

  it('counts hours and minutes, within a day of the start', () => {
    expect(countdown(at(2 * 3600_000 + 15 * 60_000), now)).toBe('[02:15]');
    expect(countdown(at(45 * 60_000), now)).toBe('[00:45]');
    expect(countdown(at(90_000), now)).toBe('[00:01]');
    expect(countdown(at(30_000), now)).toBe('[00:00]');          // under way in seconds
    expect(countdown(at(23 * 3600_000 + 59 * 60_000), now)).toBe('[23:59]');
  });

  it('says nothing for a start that is further off, or past', () => {
    expect(countdown(at(24 * 3600_000), now)).toBeNull();
    expect(countdown(at(48 * 3600_000), now)).toBeNull();
    expect(countdown(at(-60_000), now)).toBeNull();
    expect(countdown('not a date', now)).toBeNull();
  });
});
