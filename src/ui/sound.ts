/**
 * The two sounds the table makes: a chime when it is your turn, and the brush
 * of a card going down. Both are synthesised rather than loaded, so there is
 * no second file to fetch and nothing to go missing.
 *
 * A browser will not let a page make a noise before the person has touched it,
 * so the audio is set up on their first click and the clip asked for before
 * that is simply dropped. Everything here fails quietly: a browser without
 * Web Audio, or with it refused, should cost the table nothing.
 */

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let enabled = true;
/** Keeps a burst of play from turning into a pile-up of overlapping clips. */
let lastAt = 0;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctx: Ctor | undefined = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  if (!Ctx) return null;
  try { ctx = new Ctx(); } catch { return null; }
  return ctx;
}

/** Whether the table makes any sound at all. */
export function setSound(on: boolean): void {
  enabled = on;
}

/**
 * Wake the audio up on the first touch of the page, which is the only moment
 * a browser will allow it. Safe to call more than once.
 */
export function armSound(): void {
  const wake = (): void => {
    const c = audio();
    if (c && c.state === 'suspended') void c.resume().catch(() => { /* not allowed yet */ });
  };
  for (const ev of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(ev, wake, { passive: true });
  }
}

function ready(): AudioContext | null {
  if (!enabled) return null;
  const c = audio();
  if (!c || c.state !== 'running') return null;
  const now = c.currentTime;
  if (now - lastAt < 0.05) return null;
  lastAt = now;
  return c;
}

/** Your turn: two soft notes, the second a fifth above the first. */
export function turnChime(): void {
  const c = ready();
  if (!c) return;
  const t0 = c.currentTime;
  for (const [i, hz] of [880, 1320].entries()) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const at = t0 + i * 0.1;
    /* Shaped rather than switched on: an abrupt start clicks. */
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.13, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(gain).connect(c.destination);
    osc.start(at);
    osc.stop(at + 0.24);
  }
}

/** A card going down: a short rush of noise, falling as it lands. */
export function cardSwoosh(): void {
  const c = ready();
  if (!c) return;
  const t0 = c.currentTime;
  const len = 0.16;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const src = c.createBufferSource();
  src.buffer = buf;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.9;
  /* The sweep downwards is what makes it a brush rather than a hiss. */
  band.frequency.setValueAtTime(1800, t0);
  band.frequency.exponentialRampToValueAtTime(420, t0 + len);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + len);

  src.connect(band).connect(gain).connect(c.destination);
  src.start(t0);
  src.stop(t0 + len);
}
