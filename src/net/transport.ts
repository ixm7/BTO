/**
 * Transport abstraction: a room of peers that can broadcast or send directly.
 * Three implementations:
 *   - MemoryHub      in-process, for tests and the single-player demo
 *   - localTransport BroadcastChannel, for several tabs of one browser (no network at all)
 *   - trystero.ts    WebRTC data channels with serverless signalling, for real play
 */
export interface Transport {
  readonly selfId: string;
  /** Send to one peer, or to everyone else in the room when `to` is omitted. */
  send(msg: unknown, to?: string): void;
  onMessage(cb: (msg: unknown, from: string) => void): void;
  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  peers(): string[];
  leave(): void;
}

type MsgCb = (msg: unknown, from: string) => void;
type PeerCb = (peerId: string) => void;

class Emitter {
  protected msgCbs: MsgCb[] = [];
  protected joinCbs: PeerCb[] = [];
  protected leaveCbs: PeerCb[] = [];
  onMessage(cb: MsgCb): void { this.msgCbs.push(cb); }
  onPeerJoin(cb: PeerCb): void { this.joinCbs.push(cb); }
  onPeerLeave(cb: PeerCb): void { this.leaveCbs.push(cb); }
}

export const randomId = (len = 12): string => {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
};

/* ------------------------------------------------------------------ memory */

class MemoryTransport extends Emitter implements Transport {
  alive = true;
  constructor(readonly selfId: string, private hub: MemoryHub) { super(); }
  send(msg: unknown, to?: string): void {
    if (this.alive) this.hub.route(this.selfId, JSON.parse(JSON.stringify(msg)), to);
  }
  peers(): string[] { return this.hub.ids().filter((id) => id !== this.selfId); }
  leave(): void { this.hub.disconnect(this.selfId); }
  deliver(msg: unknown, from: string): void { if (this.alive) for (const cb of this.msgCbs) cb(msg, from); }
  joined(id: string): void { if (this.alive) for (const cb of this.joinCbs) cb(id); }
  left(id: string): void { if (this.alive) for (const cb of this.leaveCbs) cb(id); }
}

/** An in-process room. Delivery is asynchronous (one macrotask), like a real network. */
export class MemoryHub {
  private nodes = new Map<string, MemoryTransport>();
  ids(): string[] { return [...this.nodes.keys()]; }

  connect(id: string = randomId()): Transport {
    const t = new MemoryTransport(id, this);
    const others = [...this.nodes.values()];
    this.nodes.set(id, t);
    setTimeout(() => {
      for (const o of others) {
        if (!this.nodes.has(o.selfId) || !this.nodes.has(id)) continue;
        o.joined(id);
        t.joined(o.selfId);
      }
    }, 0);
    return t;
  }

  disconnect(id: string): void {
    const t = this.nodes.get(id);
    if (!t) return;
    t.alive = false;
    this.nodes.delete(id);
    setTimeout(() => { for (const o of this.nodes.values()) o.left(id); }, 0);
  }

  route(from: string, msg: unknown, to?: string): void {
    setTimeout(() => {
      if (to !== undefined) this.nodes.get(to)?.deliver(msg, from);
      else for (const [id, n] of this.nodes) if (id !== from) n.deliver(msg, from);
    }, 0);
  }
}

/* ------------------------------------------------------- BroadcastChannel */

interface LocalEnvelope { k: 'hi' | 'hi-ack' | 'bye' | 'msg'; from: string; to?: string; body?: unknown }

/** Peers are other tabs of the same browser on the same origin. Useful for trying multi-player locally. */
export function localTransport(roomId: string): Transport {
  class Local extends Emitter implements Transport {
    readonly selfId = randomId();
    private known = new Set<string>();
    private ch = new BroadcastChannel(`bridge-p2p:${roomId}`);
    constructor() {
      super();
      this.ch.onmessage = (e: MessageEvent<LocalEnvelope>) => {
        const m = e.data;
        if (!m || m.from === this.selfId) return;
        if (m.to !== undefined && m.to !== this.selfId) return;
        if (m.k === 'bye') {
          if (this.known.delete(m.from)) for (const cb of this.leaveCbs) cb(m.from);
          return;
        }
        if (!this.known.has(m.from)) {
          this.known.add(m.from);
          if (m.k === 'hi') this.post({ k: 'hi-ack', from: this.selfId, to: m.from });
          for (const cb of this.joinCbs) cb(m.from);
        }
        if (m.k === 'msg') for (const cb of this.msgCbs) cb(m.body, m.from);
      };
      this.post({ k: 'hi', from: this.selfId });
      globalThis.addEventListener?.('pagehide', () => this.leave());
    }
    private post(m: LocalEnvelope): void { try { this.ch.postMessage(m); } catch { /* channel closed */ } }
    send(msg: unknown, to?: string): void { this.post({ k: 'msg', from: this.selfId, to, body: msg }); }
    peers(): string[] { return [...this.known]; }
    leave(): void { this.post({ k: 'bye', from: this.selfId }); this.ch.close(); }
  }
  return new Local();
}
