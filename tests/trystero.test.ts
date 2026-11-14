import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Trystero hands back the one room it already has for a name, and a room
 * never delivers a page its own messages. A browser playing both its own
 * table and a table of robots takes two places in the room the hosts report
 * into, so these are the things that must hold for the two to hear each
 * other at all.
 */
const joined: { roomId: string; left: boolean }[] = [];
let remotePeers: string[] = [];
let incoming: ((data: string, ctx: { peerId: string }) => void) | null = null;
const sent: { data: string; target?: string }[] = [];

vi.mock('trystero', () => ({
  selfId: 'me',
  joinRoom: (_config: unknown, roomId: string) => {
    /* The real thing returns the same room for a name until it is left. */
    const open = joined.find((r) => r.roomId === roomId && !r.left);
    if (open) throw new Error('joined the same room twice');
    const rec = { roomId, left: false };
    joined.push(rec);
    return {
      makeAction: (_name: string, o: { onMessage: (d: string, c: { peerId: string }) => void }) => {
        incoming = o.onMessage;
        return { send: async (data: string, o2?: { target: string }) => { sent.push({ data, ...(o2 ? { target: o2.target } : {}) }); } };
      },
      onPeerJoin: () => { /* assigned by the transport */ },
      onPeerLeave: () => { /* assigned by the transport */ },
      getPeers: () => Object.fromEntries(remotePeers.map((p) => [p, {}])),
      leave: async () => { rec.left = true; },
    };
  },
}));

const { trysteroTransport } = await import('../src/net/trystero');

afterEach(() => { joined.splice(0); sent.splice(0); remotePeers = []; incoming = null; });

describe('two places in one room', () => {
  it('lets them hear each other, and keeps the room until the last one leaves', () => {
    const a = trysteroTransport('results');
    const b = trysteroTransport('results');
    expect(joined).toHaveLength(1);              // one room underneath
    expect(a.selfId).not.toBe(b.selfId);         // but two names in it

    const toA: unknown[] = [];
    const toB: unknown[] = [];
    a.onMessage((m) => toA.push(m));
    b.onMessage((m) => toB.push(m));

    /* What one place says reaches the other — the network never sees it. */
    b.send({ r: 'board 1' }, a.selfId);
    expect(toA).toEqual([{ r: 'board 1' }]);
    expect(sent).toHaveLength(0);

    /* A broadcast reaches the other place and the room both. */
    a.send({ r: 'board 2' });
    expect(toB).toEqual([{ r: 'board 2' }]);
    expect(sent).toHaveLength(1);

    /* Each place counts the other as a peer, alongside the real ones. */
    remotePeers = ['them'];
    expect(a.peers()).toEqual(['them', b.selfId]);

    /* What the room says reaches both places. */
    incoming?.(JSON.stringify({ r: 'board 3' }), { peerId: 'them' });
    expect(toA).toHaveLength(2);
    expect(toB).toHaveLength(2);

    /* One place leaving is not the other being hung up on. */
    a.leave();
    expect(joined[0]!.left).toBe(false);
    b.send({ r: 'board 4' });
    expect(toA).toHaveLength(2);
    b.leave();
    expect(joined[0]!.left).toBe(true);
  });

  it('opens the room again after everybody has left it', () => {
    trysteroTransport('table').leave();
    expect(() => trysteroTransport('table')).not.toThrow();
    expect(joined).toHaveLength(2);
  });
});
