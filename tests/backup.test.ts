import { describe, expect, it } from 'vitest';
import { BackupError, collect, describe as summarise, ours, pack, unpack } from '../src/ui/backup';

const settings = (over: Record<string, unknown> = {}): string => JSON.stringify({
  name: 'Ida Millet', skill: 'Advanced', sound: true, repo: 'ixm7/BTO',
  githubLogin: '', token: '', pairCode: '', playerId: 'u1a2b3c',
  playerKey: 'bHu9TzQ2xK7pR4mN8vY6wC3jF1sD5gA0eL-_hJiOkPq',
  partnerNote: 'Weeknights, 2/1', systems: '2/1', transport: 'p2p', ...over,
});

/** A localStorage good enough for the two functions that touch one. */
function store(items: Record<string, string>): Storage {
  const keys = (): string[] => Object.keys(items);
  return {
    get length() { return keys().length; },
    key: (i: number) => keys()[i] ?? null,
    getItem: (k: string) => items[k] ?? null,
    setItem: (k: string, v: string) => { items[k] = v; },
    removeItem: (k: string) => { delete items[k]; },
    clear: () => { for (const k of keys()) delete items[k]; },
  } as Storage;
}

describe('a settings code', () => {
  const whole = {
    'bridge-p2p:settings': settings(),
    'bridge-p2p:pw:ixm7/BTO:12': 'club-night',
    'bridge-p2p:invite-said': '1763480000000',
  };

  it('comes back exactly as it went in', async () => {
    expect(await unpack(await pack(whole))).toEqual(whole);
  });

  it('is one line, and short enough to paste into a message', async () => {
    const code = await pack(whole);
    expect(code).not.toMatch(/\s/);
    expect(code.length).toBeLessThan(600);
  });

  it('is smaller packed than the settings it came from', async () => {
    const plain = JSON.stringify(whole);
    const code = await pack(whole);
    expect(code.startsWith('BBKIT1.')).toBe(true);
    expect(code.length).toBeLessThan(plain.length);
  });

  it('survives being pasted with the line breaks a mail client adds', async () => {
    const code = await pack(whole);
    const wrapped = `${code.slice(0, 40)}\n ${code.slice(40, 90)}\r\n${code.slice(90)}  `;
    expect(await unpack(wrapped)).toEqual(whole);
  });

  it('can still be read by a browser that cannot compress', async () => {
    /* The plain form exists so an older browser is not cut off; it must read
       the same as the packed one. */
    const plain = `BBKIT0.${Buffer.from(JSON.stringify(whole)).toString('base64url')}`;
    expect(await unpack(plain)).toEqual(whole);
  });
});

describe('a code that is not one', () => {
  const fails = async (text: string, like: RegExp): Promise<void> => {
    await expect(unpack(text)).rejects.toThrow(like);
    await expect(unpack(text)).rejects.toBeInstanceOf(BackupError);
  };

  it('says what is wrong rather than half-applying it', async () => {
    await fails('', /Nothing was pasted/);
    await fails('hello', /should begin with "BBKIT"/);
    await fails(`BBKIT0.${'x'.repeat(30000)}`, /far too long/);
    await fails('BBKIT1.not-base64-at-all!!', /damaged/);
    await fails(`BBKIT0.${Buffer.from('[1,2,3]').toString('base64url')}`, /does not hold any settings/);
    await fails(`BBKIT0.${Buffer.from('{"other.site":"x"}').toString('base64url')}`, /does not hold any settings/);
  });

  it('drops anything in it that is not this site\'s own', async () => {
    const mixed = `BBKIT0.${Buffer.from(JSON.stringify({
      'bridge-p2p:settings': settings(),
      'evil.example:token': 'sk-live-1234',
      'bridge-p2p:settings:test3': settings({ name: 'Test 3' }),
      'bridge-p2p:pw:x:1': { not: 'a string' },
    })).toString('base64url')}`;
    expect(Object.keys(await unpack(mixed))).toEqual(['bridge-p2p:settings']);
  });
});

describe('what goes into a code', () => {
  it('takes this site\'s keys and leaves the test players behind', () => {
    const s = store({
      'bridge-p2p:settings': settings(),
      'bridge-p2p:settings:test1': settings({ name: 'Test 1' }),
      'bridge-p2p:pw:ixm7/BTO:12': 'club-night',
      'theme': 'dark',
    });
    expect(Object.keys(collect(s, true)).sort()).toEqual(['bridge-p2p:pw:ixm7/BTO:12', 'bridge-p2p:settings']);
    expect(ours('bridge-p2p:settings:test7')).toBe(false);
    expect(ours('bridge-p2p:log:a')).toBe(true);
  });

  it('can leave the tournament-creator token behind, and its login with it', () => {
    const s = store({ 'bridge-p2p:settings': settings({ token: 'ghp_secret', githubLogin: 'ida' }) });
    const kept = JSON.parse(collect(s, true)['bridge-p2p:settings'] as string) as Record<string, string>;
    expect(kept.token).toBe('ghp_secret');
    expect(kept.githubLogin).toBe('ida');

    const without = JSON.parse(collect(s, false)['bridge-p2p:settings'] as string) as Record<string, string>;
    expect(without.token).toBe('');
    /* A login with no token names an account this device cannot act as. */
    expect(without.githubLogin).toBe('');
    /* Everything else is still there. */
    expect(without.playerKey).toBe(JSON.parse(settings()).playerKey);
    expect(without.name).toBe('Ida Millet');
  });

  it('carries the key, which is the whole point of it', async () => {
    const s = store({ 'bridge-p2p:settings': settings() });
    const back = await unpack(await pack(collect(s, false)));
    const mine = JSON.parse(back['bridge-p2p:settings'] as string) as { playerKey: string };
    expect(mine.playerKey).toBe(JSON.parse(settings()).playerKey);
  });
});

describe('what a code says about itself before it is used', () => {
  it('names the player, the token and the passwords', async () => {
    const items = {
      'bridge-p2p:settings': settings({ token: 'ghp_x' }),
      'bridge-p2p:pw:ixm7/BTO:12': 'a',
      'bridge-p2p:pw:ixm7/BTO:14': 'b',
    };
    expect(summarise(items)).toEqual({ name: 'Ida Millet', hasToken: true, passwords: 2 });
  });

  it('says so plainly when there is no name and no token', () => {
    expect(summarise({ 'bridge-p2p:settings': settings({ name: '  ' }) }))
      .toEqual({ name: '', hasToken: false, passwords: 0 });
  });

  it('does not fall over on settings it cannot read', () => {
    expect(summarise({ 'bridge-p2p:settings': 'not json' })).toEqual({ name: '', hasToken: false, passwords: 0 });
  });
});
