/**
 * Real peer-to-peer transport: WebRTC data channels, with peers finding each
 * other through public Nostr relays (via Trystero). There is no game server:
 * the relays only carry the WebRTC handshake, never game traffic.
 */
import { joinRoom, selfId } from 'trystero';
import type { Transport } from './transport';

export interface TrysteroOptions {
  /** Optional TURN servers for players behind strict NATs / corporate firewalls. */
  turnConfig?: { urls: string | string[]; username?: string; credential?: string }[];
}

const APP_ID = 'bridge-p2p-duplicate-v1';

export function trysteroTransport(roomId: string, opts: TrysteroOptions = {}): Transport {
  const room = joinRoom({ appId: APP_ID, ...(opts.turnConfig ? { turnConfig: opts.turnConfig } : {}) }, roomId);
  const msgCbs: ((msg: unknown, from: string) => void)[] = [];
  const joinCbs: ((id: string) => void)[] = [];
  const leaveCbs: ((id: string) => void)[] = [];

  // Messages travel as JSON strings so the payload type stays simple.
  const action = room.makeAction<string>('m', {
    onMessage: (data, ctx) => {
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      for (const cb of msgCbs) cb(parsed, ctx.peerId);
    },
  });
  room.onPeerJoin = (id) => { for (const cb of joinCbs) cb(id); };
  room.onPeerLeave = (id) => { for (const cb of leaveCbs) cb(id); };

  return {
    selfId,
    send(msg, to) {
      const data = JSON.stringify(msg);
      void action.send(data, to === undefined ? undefined : { target: to }).catch(() => { /* peer went away */ });
    },
    onMessage(cb) { msgCbs.push(cb); },
    onPeerJoin(cb) { joinCbs.push(cb); },
    onPeerLeave(cb) { leaveCbs.push(cb); },
    peers: () => Object.keys(room.getPeers()),
    leave() { void room.leave(); },
  };
}
