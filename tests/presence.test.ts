import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '../src/net/transport';

/** A stand-in for the lobby room, so the count can be driven by hand. */
const peers: string[] = [];
let joined: string | null = null;
let join: (() => void) | null = null;
let leave: (() => void) | null = null;
let fail = false;

vi.mock('../src/net/trystero', () => ({
  trysteroTransport: (roomId: string): Transport => {
    if (fail) throw new Error('no relays');
    joined = roomId;
    return {
      selfId: 'me',
      send: () => {},
      onMessage: () => {},
      onPeerJoin: (cb) => { join = () => cb('x'); },
      onPeerLeave: (cb) => { leave = () => cb('x'); },
      peers: () => [...peers],
      leave: () => {},
    };
  },
}));

async function fresh(): Promise<typeof import('../src/ui/presence')> {
  vi.resetModules();
  peers.length = 0; joined = null; join = null; leave = null;
  return import('../src/ui/presence');
}

describe('how many are online', () => {
  beforeEach(() => { fail = false; });

  it('counts the people in the lobby, this browser included', async () => {
    const p = await fresh();
    const seen: number[] = [];
    p.watchOnline((n) => seen.push(n), true);
    expect(joined).toBeTruthy();
    expect(p.online()).toBe(1);               // alone to begin with

    peers.push('a', 'b');
    join!();
    expect(p.online()).toBe(3);
    peers.pop();
    leave!();
    expect(p.online()).toBe(2);
    /* Only real changes are reported, so the page is not redrawn for nothing. */
    join!();
    expect(seen).toEqual([3, 2]);
  });

  it('notices peers that vanished without saying goodbye', async () => {
    vi.useFakeTimers();
    const p = await fresh();
    p.watchOnline(() => {}, true);
    peers.push('a');
    vi.advanceTimersByTime(5000);
    expect(p.online()).toBe(2);
    peers.length = 0;                          // the browser was closed
    vi.advanceTimersByTime(5000);
    expect(p.online()).toBe(1);
    vi.useRealTimers();
  });

  it('stays at one when there is no network to join, and joins nothing when switched off', async () => {
    fail = true;
    const p = await fresh();
    p.watchOnline(() => {}, true);
    expect(p.online()).toBe(1);

    fail = false;
    const q = await fresh();
    q.watchOnline(() => {}, false);
    expect(joined).toBeNull();
    expect(q.online()).toBe(1);
  });
});
