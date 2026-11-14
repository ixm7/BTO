/**
 * Real peer-to-peer transport: WebRTC data channels, with peers finding each
 * other through public Nostr relays (via Trystero). There is no game server:
 * the relays only carry the WebRTC handshake, never game traffic.
 *
 * One page can take two places in the same room — a player's own table reports
 * its boards in the room the hosts share, and so does a table of robots the
 * same browser is playing on the field's behalf. Trystero hands back the one
 * room it already has for a name, and a room never delivers a page its own
 * messages, so the two would be deaf to each other and either could hang up on
 * the other by leaving. Each place therefore gets a transport of its own here,
 * over a shared room: messages between places in the same page are delivered
 * directly, and the room itself is left only when the last place has gone.
 */
import { joinRoom, selfId } from 'trystero';
import type { Transport } from './transport';

export interface TrysteroOptions {
  /** Optional TURN servers for players behind strict NATs / corporate firewalls. */
  turnConfig?: { urls: string | string[]; username?: string; credential?: string }[];
}

const APP_ID = 'bridge-p2p-duplicate-v1';

interface Place {
  id: string;
  msgCbs: ((msg: unknown, from: string) => void)[];
  joinCbs: ((id: string) => void)[];
  leaveCbs: ((id: string) => void)[];
}

interface Shared {
  send(data: string, to?: string): void;
  leave(): void;
  remotes(): string[];
  places: Set<Place>;
  taken: number;
}

const rooms = new Map<string, Shared>();

function sharedRoom(roomId: string, opts: TrysteroOptions): Shared {
  const found = rooms.get(roomId);
  if (found) return found;
  const room = joinRoom({ appId: APP_ID, ...(opts.turnConfig ? { turnConfig: opts.turnConfig } : {}) }, roomId);
  const places = new Set<Place>();
  // Messages travel as JSON strings so the payload type stays simple.
  const action = room.makeAction<string>('m', {
    onMessage: (data, ctx) => {
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      for (const p of [...places]) for (const cb of p.msgCbs) cb(parsed, ctx.peerId);
    },
  });
  room.onPeerJoin = (id) => { for (const p of [...places]) for (const cb of p.joinCbs) cb(id); };
  room.onPeerLeave = (id) => { for (const p of [...places]) for (const cb of p.leaveCbs) cb(id); };
  const shared: Shared = {
    places,
    taken: 0,
    send: (data, to) => { void action.send(data, to === undefined ? undefined : { target: to }).catch(() => { /* peer went away */ }); },
    leave: () => { rooms.delete(roomId); void room.leave(); },
    remotes: () => Object.keys(room.getPeers()),
  };
  rooms.set(roomId, shared);
  return shared;
}

export function trysteroTransport(roomId: string, opts: TrysteroOptions = {}): Transport {
  const shared = sharedRoom(roomId, opts);
  /* Everyone in the room must be able to tell this place from the others in
     the same page, the page's own name being the same for all of them. */
  const me: Place = { id: shared.taken === 0 ? selfId : `${selfId}~${shared.taken}`, msgCbs: [], joinCbs: [], leaveCbs: [] };
  shared.taken++;
  const siblings = (): Place[] => [...shared.places].filter((p) => p !== me);
  let gone = false;
  /* The places already here are peers of this one, and it of them. */
  for (const p of siblings()) {
    for (const cb of p.joinCbs) cb(me.id);
    /* After this transport's owner has had a chance to listen. */
    setTimeout(() => { if (!gone) for (const cb of me.joinCbs) cb(p.id); }, 0);
  }
  shared.places.add(me);

  return {
    selfId: me.id,
    send(msg, to) {
      if (gone) return;
      const mine = siblings().filter((p) => to === undefined || p.id === to);
      for (const p of mine) for (const cb of p.msgCbs) cb(msg, me.id);
      /* A message for a place in this page never goes near the network. */
      if (to !== undefined && mine.length > 0) return;
      shared.send(JSON.stringify(msg), to);
    },
    onMessage(cb) { me.msgCbs.push(cb); },
    onPeerJoin(cb) { me.joinCbs.push(cb); },
    onPeerLeave(cb) { me.leaveCbs.push(cb); },
    peers: () => [...shared.remotes(), ...siblings().map((p) => p.id)],
    leave() {
      if (gone) return;
      gone = true;
      shared.places.delete(me);
      for (const p of siblings()) for (const cb of p.leaveCbs) cb(me.id);
      /* The room itself goes only when the last place in this page has left. */
      if (shared.places.size === 0) shared.leave();
    },
  };
}
