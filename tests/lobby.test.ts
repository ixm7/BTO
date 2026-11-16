import { describe, expect, it } from 'vitest';
import { CHAT_KEEP, Directory, LOBBY_LABEL, LOBBY_MARK, PAIRS_LABEL, PAIRS_MARK, pairKey, systemBetween } from '../src/directory/github';

/** A GitHub with one labelled lobby issue and whatever comments a test gives it. */
function fakeGitHub(comments: { id: number; login: string; body: string; at?: string }[]) {
  const sent: { url: string; method: string; body?: unknown }[] = [];
  const raw = comments.map((c) => ({
    id: c.id, user: { login: c.login }, body: c.body, created_at: c.at ?? '2026-11-16T12:00:00Z',
  }));
  const fetcher = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    sent.push({ url, method, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const u = new URL(url);
    const json = (x: unknown): Response => new Response(JSON.stringify(x), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname.endsWith('/issues') && u.searchParams.get('labels') === LOBBY_LABEL) {
      return json([{ number: 9, body: LOBBY_MARK }]);
    }
    if (u.pathname.endsWith('/issues/9')) return json({ number: 9, comments: raw.length });
    if (u.pathname.endsWith('/issues/9/comments')) return json(raw);
    if (/\/issues\/comments\/\d+$/.test(u.pathname)) {
      /* GitHub answers a delete with 204 and no body at all. */
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return json({ body: raw.find((c) => String(c.id) === u.pathname.split('/').pop())?.body ?? '' });
    }
    return json({});
  };
  return { fetcher: fetcher as never, sent };
}

describe('the lobby', () => {
  const relay = { url: 'https://api.bridgebreak.org', login: 'relaybot', key: 'k'.repeat(40), name: 'Ida' };

  it('reads messages, and says who left each one', async () => {
    const { fetcher } = fakeGitHub([
      { id: 1, login: 'ann', body: 'back at eight' },
      { id: 2, login: 'relaybot', body: 'see you then\n<!-- player {"t":"0123456789abcdef0123","n":"Ida"} -->' },
    ]);
    const msgs = await new Directory('ixm7/BTO', null, fetcher, relay).messages();
    expect(msgs.map((m) => `[${m.name}]: ${m.text}`)).toEqual([
      '[ann]: back at eight',
      '[Ida]: see you then',
    ]);
    /* A message the relay posted belongs to the player it names, not the relay. */
    expect(msgs[1]?.who).toBe('~0123456789abcdef0123');
  });

  it('keeps the last fifty, and holds pinned ones above them', async () => {
    const many = Array.from({ length: CHAT_KEEP + 20 }, (_, i) => ({ id: i + 10, login: 'ann', body: `message ${i}` }));
    const { fetcher } = fakeGitHub([{ id: 1, login: 'ida', body: 'read the rules\n<!-- pinned -->' }, ...many]);
    const msgs = await new Directory('ixm7/BTO', null, fetcher, relay).messages();
    expect(msgs).toHaveLength(CHAT_KEEP + 1);
    expect(msgs[0]).toMatchObject({ text: 'read the rules', pinned: true });
    expect(msgs[1]?.text).toBe('message 20');
    expect(msgs.at(-1)?.text).toBe(`message ${CHAT_KEEP + 19}`);
  });

  it('pins by marking the message, and unpins by taking the mark off', async () => {
    const { fetcher, sent } = fakeGitHub([{ id: 5, login: 'ann', body: 'back at eight' }]);
    const d = new Directory('ixm7/BTO', 'tok', fetcher);
    await d.pinMessage(5, true);
    expect(sent.at(-1)).toMatchObject({ method: 'PATCH', body: { body: 'back at eight\n<!-- pinned -->' } });
    await d.pinMessage(5, false);
    expect(sent.at(-1)).toMatchObject({ method: 'PATCH', body: { body: 'back at eight' } });
  });

  it('takes a message down only with a token', async () => {
    const { fetcher, sent } = fakeGitHub([{ id: 5, login: 'ann', body: 'back at eight' }]);
    /* Deleting answers 204 and no body, which is not an error. */
    await expect(new Directory('ixm7/BTO', 'tok', fetcher).removeMessage(5)).resolves.toBeUndefined();
    expect(sent.at(-1)).toMatchObject({ method: 'DELETE' });
    await expect(new Directory('ixm7/BTO', null, fetcher, relay).removeMessage(5)).rejects.toThrow(/token/i);
  });

  it('will not open a lobby without a token, and finds the one that exists', async () => {
    const { fetcher } = fakeGitHub([]);
    await expect(new Directory('ixm7/BTO', null, fetcher, relay).openLobby()).resolves.toBe(9);
    expect(await new Directory('ixm7/BTO', null, fetcher, relay).lobby()).toBe(9);
  });
});

describe('pair cards', () => {
  const relay = { url: 'https://api.bridgebreak.org', login: 'relaybot', key: 'k'.repeat(40), name: 'Ida' };

  /** A GitHub whose pairs page carries whatever lines a test gives it. */
  function pairsGitHub(lines: { login: string; body: string }[]) {
    const sent: { url: string; method: string; body?: unknown }[] = [];
    const raw = lines.map((c, i) => ({ id: i + 1, user: { login: c.login }, body: c.body, created_at: '2026-11-16T12:00:00Z' }));
    const fetcher = async (url: string, init?: { method?: string; body?: string }) => {
      sent.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      const u = new URL(url);
      const json = (x: unknown): Response => new Response(JSON.stringify(x), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.pathname.endsWith('/issues') && u.searchParams.get('labels') === PAIRS_LABEL) return json([{ number: 4, body: PAIRS_MARK }]);
      if (u.pathname.endsWith('/issues/4/comments')) return json(u.searchParams.get('page') === '1' ? raw : []);
      return json({});
    };
    return { fetcher: fetcher as never, sent };
  }

  it('names a pair by their ids, whichever order they are given in', () => {
    expect(pairKey('Ann', 'bob')).toBe('ann+bob');
    expect(pairKey('bob', 'Ann')).toBe('ann+bob');
    /* Two players called Ido are two players: the id is what counts. */
    expect(pairKey('~aaa', '~bbb')).toBe('~aaa+~bbb');
  });

  it('keeps the last card a pair saved, and ignores one written by an outsider', async () => {
    const { fetcher } = pairsGitHub([
      { login: 'ann', body: '/pair ann+bob sys:sayc note:Natural discards' },
      { login: 'ann', body: '/pair ann+bob sys:21 note:Bergen raises, weak 1NT' },
      { login: 'cat', body: '/pair ann+bob sys:sayc note:not theirs to write' },
    ]);
    const cards = await new Directory('ixm7/BTO', null, fetcher, relay).pairCards();
    expect(cards.get('ann+bob')).toEqual({ system: '2/1', note: 'Bergen raises, weak 1NT' });
  });

  it('writes the card as a line the page can be read for', async () => {
    const { fetcher, sent } = pairsGitHub([]);
    await new Directory('ixm7/BTO', 'tok', fetcher).savePairCard('ann+bob', '2/1', '  Weak  1NT  ');
    expect(sent.at(-1)).toMatchObject({ method: 'POST', body: { body: '/pair ann+bob sys:21 note:Weak 1NT' } });
  });

  it('falls back to the system both players own to', () => {
    /* Ann sorts first, so her order decides between two they share. */
    expect(systemBetween({ id: 'ann', systems: 'SAYC, 2/1' }, { id: 'bob', systems: '2/1, SAYC' })).toBe('SAYC');
    expect(systemBetween({ id: 'bob', systems: '2/1, SAYC' }, { id: 'ann', systems: 'SAYC, 2/1' })).toBe('SAYC');
    /* Only one in common, whatever each would rather play. */
    expect(systemBetween({ id: 'ann', systems: 'SAYC, 2/1' }, { id: 'bob', systems: '2/1' })).toBe('2/1');
    /* Nothing said, or nothing shared: the table is told SAYC. */
    expect(systemBetween({ id: 'ann', systems: '' }, { id: 'bob', systems: '2/1' })).toBe('SAYC');
    expect(systemBetween({ id: 'ann' }, { id: 'bob' })).toBe('SAYC');
  });
});
