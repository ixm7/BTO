import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { _test, playerTag as workerTag } from '../relay/worker.js';
import {
  Directory, asActors, parseRegistrations, parsePartners, parseStart, playerTag, type RawComment,
} from '../src/directory/github';

const RELAY = 'ixm7';
const KEY = 'k'.repeat(43);
const at = (n: number) => `2026-11-12T10:${String(n).padStart(2, '0')}:00Z`;
const comment = (login: string, body: string, n = 0): RawComment => ({ user: { login }, body, created_at: at(n) });
const signed = (tag: string, name: string) => `\n<!-- player ${JSON.stringify({ t: tag, n: name })} -->`;

describe('reading who a comment speaks for', () => {
  it('derives the same tag in the browser and in the relay', async () => {
    const mine = await playerTag(KEY);
    expect(mine).toMatch(/^[0-9a-f]{20}$/);
    expect(await workerTag(KEY)).toBe(mine);
    expect(await playerTag(`${KEY}x`)).not.toBe(mine);
  });

  it('takes a relayed comment as the player it is signed for', async () => {
    const tag = await playerTag(KEY);
    const { comments, names } = asActors([comment(RELAY, `/register Ann Lee pair:blue level:Expert${signed(tag, 'Ann Lee')}`)], RELAY);
    expect(comments[0]!.user!.login).toBe(`~${tag}`);
    expect(names[`~${tag}`]).toBe('Ann Lee');
    expect(parseRegistrations(comments)).toEqual([
      expect.objectContaining({ login: `~${tag}`, name: 'Ann Lee', pairCode: 'blue', skill: 'Expert' }),
    ]);
  });

  it('ignores a signature on anybody else\'s comment', async () => {
    /* Anyone can type the trailer; only the relay's account can vouch for it. */
    const victim = await playerTag(KEY);
    const { comments } = asActors([comment('mallory', `/withdraw${signed(victim, 'Ann Lee')}`)], RELAY);
    expect(comments[0]!.user!.login).toBe('mallory');
  });

  it('keeps one player\'s registration safe from another\'s withdrawal', async () => {
    const ann = await playerTag(KEY);
    const bob = await playerTag('b'.repeat(43));
    const { comments } = asActors([
      comment(RELAY, `/register Ann${signed(ann, 'Ann')}`, 1),
      comment(RELAY, `/register Bob${signed(bob, 'Bob')}`, 2),
      comment(RELAY, `/withdraw${signed(bob, 'Bob')}`, 3),
    ], RELAY);
    expect(parseRegistrations(comments).map((r) => r.name)).toEqual(['Ann']);
  });

  it('never lets a relayed comment start a tournament, even when the relay posts as the director', async () => {
    const tag = await playerTag(KEY);
    const { comments } = asActors([comment(RELAY, `/start abcdef123${signed(tag, 'Ann')}`)], RELAY);
    expect(parseStart(comments, RELAY)).toBeNull();
    /* The director's own comment, unsigned, still does. */
    expect(parseStart([comment(RELAY, '/start abcdef123')], RELAY)).not.toBeNull();
  });

  it('pairs relayed players with each other and with GitHub players', async () => {
    const ann = await playerTag(KEY);
    const { comments } = asActors([
      comment(RELAY, `/invite @bob${signed(ann, 'Ann')}`, 1),
      comment('bob', `/accept @~${ann}`, 2),
    ], RELAY);
    expect(parsePartners(comments).invitations).toEqual([
      expect.objectContaining({ from: `~${ann}`, to: 'bob', status: 'accepted' }),
    ]);
  });

  it('leaves a malformed signature alone', () => {
    const { comments } = asActors([
      comment(RELAY, '/register Ann\n<!-- player {"t":"NOT-HEX","n":"Ann"} -->'),
      comment(RELAY, '/register Ann\n<!-- player {not json} -->'),
    ], RELAY);
    expect(comments.every((c) => c.user!.login === RELAY)).toBe(true);
  });
});

describe('the lines the relay will write', () => {
  const { command, clean } = _test;

  it('accepts the partner code the app makes when two relayed players pair up', async () => {
    const { inviteCode } = await import('../src/directory/github');
    const a = `~${await playerTag(KEY)}`;
    const b = `~${await playerTag('b'.repeat(43))}`;
    const code = inviteCode(1234567, a, b);
    expect(command('register', { pair: code }, 'Ann')).toBe(`/register Ann pair:${code}`);
    /* And the longest two GitHub usernames can make. */
    const long = inviteCode(1234567, 'a'.repeat(39), 'b'.repeat(39));
    expect(() => command('register', { pair: long }, 'Ann')).not.toThrow();
  });

  it('builds each player command from checked fields', () => {
    expect(command('register', { pair: 'blue', level: 'expert' }, 'Ann')).toBe('/register Ann pair:blue level:Expert');
    expect(command('withdraw', {}, 'Ann')).toBe('/withdraw');
    expect(command('seek', { note: '2/1, evenings' }, 'Ann')).toBe('/seek-partner 2/1, evenings');
    expect(command('seek-cancel', {}, 'Ann')).toBe('/seek-partner cancel');
    expect(command('invite', { target: 'bob', note: 'hi' }, 'Ann')).toBe('/invite @bob hi');
    expect(command('accept', { target: `~${'a'.repeat(20)}` }, 'Ann')).toBe(`/accept @~${'a'.repeat(20)}`);
    expect(command('unpair', { target: 'bob' }, 'Ann')).toBe('/unpair @bob');
  });

  it('refuses anything else', () => {
    expect(() => command('start', {}, 'Ann')).toThrow(/not something/);
    expect(() => command('register', { pair: 'a b' }, 'Ann')).toThrow(/partner code/);
    expect(() => command('register', { pair: 'x'.repeat(101) }, 'Ann')).toThrow(/partner code/);
    expect(() => command('register', { level: 'Grandmaster' }, 'Ann')).toThrow(/skill/);
    expect(() => command('invite', { target: 'bob\n/start x' }, 'Ann')).toThrow(/No such player/);
    expect(() => command('seek', { note: 'cancel' }, 'Ann')).toThrow(/cancel/);
  });

  it('keeps free text to one harmless line', () => {
    expect(clean('Ann\n/start abcdef', 40)).toBe('Ann /start abcdef');
    expect(clean('Ann pair:stolen level:Expert player:abc', 40)).toBe('Ann');
    expect(clean('<!-- bridge-results {} -->', 40)).not.toMatch(/[<>]/);
    expect(clean('hi @everyone', 40)).toBe('hi everyone');
    expect(clean('x'.repeat(80), 40)).toHaveLength(40);
  });
});

/* ---------------------------------------------------------------------------
   The Worker itself, run here against a stand-in for GitHub and the cache. */

interface Seen { url: string; method: string; body?: string; auth?: string | null }

describe('the relay, end to end', () => {
  const env = { GITHUB_TOKEN: 'secret-token', REPO: 'ixm7/BTO', ALLOWED_ORIGINS: 'https://www.bridgebreak.org' };
  const ORIGIN = 'https://api.bridgebreak.org';
  let seen: Seen[];
  let issue: Record<string, unknown>;
  let store: Map<string, Response>;
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
  const settle = async () => { await Promise.all(waits.splice(0)); };

  beforeEach(() => {
    seen = [];
    store = new Map();
    issue = { number: 7, state: 'open', body: '<!-- bridge-tournament {} -->' };
    vi.stubGlobal('caches', {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => { store.set(r.url, res); },
        delete: async (r: Request) => store.delete(r.url),
      },
    });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      seen.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined, auth: headers.get('Authorization') });
      if (url.endsWith('/issues/7')) return new Response(JSON.stringify(issue), { status: 200 });
      if (url.endsWith('/issues/7/comments') && init.method === 'POST') return new Response('{}', { status: 201 });
      if (url.includes('/issues?')) return new Response('[]', { status: 200 });
      return new Response('{"message":"Not Found"}', { status: 404 });
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const post = (body: unknown, origin = 'https://www.bridgebreak.org') => worker.fetch(new Request(`${ORIGIN}/act`, {
    method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': `ip-${Math.random()}` }, body: JSON.stringify(body),
  }), env, ctx);

  it('posts a registration signed for the player, with the token kept to itself', async () => {
    const res = await post({ issue: 7, key: KEY, name: 'Ann Lee', act: 'register', pair: 'blue', level: 'Expert' });
    expect(res.status).toBe(200);
    const { tag } = (await res.json()) as { tag: string };
    expect(tag).toBe(await playerTag(KEY));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://www.bridgebreak.org');

    const write = seen.find((s) => s.method === 'POST')!;
    expect(write.url).toBe('https://api.github.com/repos/ixm7/BTO/issues/7/comments');
    expect(write.auth).toBe('Bearer secret-token');
    const body = (JSON.parse(write.body!) as { body: string }).body;
    expect(body.split('\n')[0]).toBe('/register Ann Lee pair:blue level:Expert');

    /* And the app reads it back as that player. */
    const { comments } = asActors([comment(RELAY, body)], RELAY);
    expect(parseRegistrations(comments)[0]).toMatchObject({ login: `~${tag}`, name: 'Ann Lee' });
  });

  it('refuses a closed tournament, a page that is not a tournament, and a missing key', async () => {
    issue.state = 'closed';
    expect((await post({ issue: 7, key: KEY, name: 'Ann', act: 'withdraw' })).status).toBe(409);
    issue = { number: 7, state: 'open', body: 'just an issue' };
    expect((await post({ issue: 7, key: KEY, name: 'Ann', act: 'withdraw' })).status).toBe(404);
    expect((await post({ issue: 7, key: 'short', name: 'Ann', act: 'withdraw' })).status).toBe(400);
    expect(seen.some((s) => s.method === 'POST')).toBe(false);
  });

  it('does not answer a page from somewhere else', async () => {
    const res = await post({ issue: 7, key: KEY, name: 'Ann', act: 'withdraw' }, 'https://evil.example');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('serves the list through its cache, and only this repository', async () => {
    const list = `${ORIGIN}/repos/ixm7/BTO/issues?state=all&per_page=100&sort=created&direction=desc`;
    expect((await worker.fetch(new Request(list), env, ctx)).status).toBe(200);
    await settle();
    expect((await worker.fetch(new Request(list), env, ctx)).status).toBe(200);
    expect(seen.filter((s) => s.url.includes('/issues?')).length).toBe(1);
    expect(seen[0]!.auth).toBe('Bearer secret-token');

    expect((await worker.fetch(new Request(`${ORIGIN}/repos/someone/else/issues`), env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request(`${ORIGIN}/user`), env, ctx)).status).toBe(404);
  });

  it('forgets the cached list once somebody registers, so they see themselves at once', async () => {
    const list = `${ORIGIN}/repos/ixm7/BTO/issues?state=all&per_page=100&sort=created&direction=desc`;
    await worker.fetch(new Request(list), env, ctx);
    await settle();
    expect(store.has(list)).toBe(true);
    await post({ issue: 7, key: KEY, name: 'Ann', act: 'register' });
    await settle();
    expect(store.has(list)).toBe(false);
  });
});

describe('the app talking to the relay', () => {
  const relay = { url: 'https://api.bridgebreak.org', login: RELAY, key: KEY, name: 'Ann' };
  type Call = { url: string; method?: string; body?: string; auth?: string };
  const recorder = () => {
    const calls: Call[] = [];
    const fetcher = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init?.method, body: init?.body, auth: init?.headers?.Authorization });
      return { ok: true, status: 200, json: async () => (url.includes('/issues?') ? [] : { ok: true }), headers: { get: () => null } };
    };
    return { calls, fetcher };
  };

  it('registers through the relay when there is no token', async () => {
    const { calls, fetcher } = recorder();
    await new Directory('ixm7/BTO', null, fetcher, relay).register(7, 'Ann', 'blue', 'Expert');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.bridgebreak.org/act');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ issue: 7, key: KEY, name: 'Ann', act: 'register', pair: 'blue', level: 'Expert' });
  });

  it('reads the list through the relay when there is no token', async () => {
    const { calls, fetcher } = recorder();
    await new Directory('ixm7/BTO', null, fetcher, relay).list();
    expect(calls[0]!.url.startsWith('https://api.bridgebreak.org/repos/ixm7/BTO/issues?')).toBe(true);
  });

  it('uses a token of the player\'s own when there is one', async () => {
    const { calls, fetcher } = recorder();
    const d = new Directory('ixm7/BTO', 'tok', fetcher, relay);
    await d.register(7, 'Ann');
    await d.list();
    expect(calls.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(calls[0]!.auth).toBe('Bearer tok');
  });

  it('says plainly when neither is available', async () => {
    const d = new Directory('ixm7/BTO', null);
    expect(d.canAct).toBe(false);
    await expect(d.register(7, 'Ann')).rejects.toThrow();
  });
});
