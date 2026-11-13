/**
 * How many people have Bridge Break open.
 *
 * There is no server to ask, so the page counts for itself: every browser
 * joins one small room over the same peer-to-peer signalling the tables use,
 * and the people in it are the people online. Nothing is sent in that room —
 * it exists only so that everybody can see who else is there.
 *
 * Everyone connects to everyone, which is cheap for the numbers this site
 * sees and would not be for thousands. `LIMIT` is where the count stops being
 * reported exactly, and is the point to replace this with a counter kept
 * somewhere central if the site ever grows into it.
 */
import { trysteroTransport } from '../net/trystero';
import type { Transport } from '../net/transport';

const ROOM = 'bridgebreak-lobby-v1';
export const LIMIT = 60;

let room: Transport | null = null;
let count = 1;
let listener: ((n: number) => void) | null = null;

/** People online, this browser included. */
export const online = (): number => count;

function tell(): void {
  const n = 1 + (room?.peers().length ?? 0);
  if (n === count) return;
  count = n;
  listener?.(count);
}

/**
 * Start counting, and call `onChange` whenever the number moves. Safe to call
 * more than once. Does nothing where there is no peer-to-peer network to join
 * (the local transport used for testing), and a failure to reach the
 * signalling relays leaves the count at one rather than breaking the page.
 */
export function watchOnline(onChange: (n: number) => void, enabled: boolean): void {
  listener = onChange;
  if (room || !enabled) return;
  try {
    room = trysteroTransport(ROOM);
    room.onPeerJoin(tell);
    room.onPeerLeave(tell);
    /* Peers arrive a few seconds after the page loads, and a peer that
       vanishes without saying goodbye is noticed only when it times out. */
    setInterval(tell, 5000);
    tell();
  } catch {
    room = null;
  }
}
