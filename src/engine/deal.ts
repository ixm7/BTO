import { SEATS, type Card, type Seat, type Side } from './cards';

export type Vulnerability = 'None' | 'NS' | 'EW' | 'Both';
export type Hands = Record<Seat, Card[]>;

/* ---- Seeded PRNG (xmur3 string hash -> sfc32). Deterministic across browsers. ---- */

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: string): () => number {
  const h = xmur3(seed);
  const rand = sfc32(h(), h(), h(), h());
  for (let i = 0; i < 12; i++) rand(); // warm up
  return rand;
}

/** Deterministically deal board `boardNo` from a tournament secret. */
export function dealBoard(secret: string, boardNo: number): Hands {
  const rand = seededRandom(`${secret}|board|${boardNo}`);
  const deck: Card[] = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j] as Card, deck[i] as Card];
  }
  const hands = { N: [], E: [], S: [], W: [] } as Hands;
  SEATS.forEach((seat, k) => {
    hands[seat] = deck.slice(k * 13, k * 13 + 13).sort((a, b) => a - b);
  });
  return hands;
}

/** Standard duplicate dealer rotation: board 1 = North, 2 = East, 3 = South, 4 = West, repeat. */
export function dealerForBoard(boardNo: number): Seat {
  return SEATS[(((boardNo - 1) % 4) + 4) % 4] as Seat;
}

const VUL_CYCLE: Vulnerability[] = [
  'None', 'NS', 'EW', 'Both',
  'NS', 'EW', 'Both', 'None',
  'EW', 'Both', 'None', 'NS',
  'Both', 'None', 'NS', 'EW',
];

/** Standard 16-board vulnerability cycle. */
export function vulnerabilityForBoard(boardNo: number): Vulnerability {
  return VUL_CYCLE[(((boardNo - 1) % 16) + 16) % 16] as Vulnerability;
}

export function isVulnerable(vul: Vulnerability, side: Side): boolean {
  return vul === 'Both' || vul === side;
}
