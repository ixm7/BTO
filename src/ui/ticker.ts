/**
 * A clock that keeps time in a tab nobody is looking at.
 *
 * A browser slows the timers of a background tab right down — to one wake a
 * minute, once it has been out of sight a few minutes. That is fine for a
 * page that is only waiting for news, and ruinous for one that is playing a
 * table of robots on the field's behalf: a hand that takes a minute in front
 * of you takes an hour behind you, and everybody else waits on it.
 *
 * A worker's timers are not slowed in the same way, so one worker ticking
 * away keeps every waiting robot moving. If a worker cannot be had, this
 * falls back to the ordinary timer, which is what the page had before.
 */

const SRC = 'setInterval(() => postMessage(0), 100);';

interface Waiting { at: number; fn: () => void }

let worker: Worker | null = null;
let broken = false;
const waiting = new Set<Waiting>();

function start(): Worker | null {
  if (worker || broken) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' })));
    worker.onmessage = () => {
      const now = Date.now();
      for (const w of [...waiting]) {
        if (w.at > now) continue;
        waiting.delete(w);
        try { w.fn(); } catch { /* the caller's problem, not the clock's */ }
      }
    };
    worker.onerror = () => { broken = true; worker = null; };
  } catch { broken = true; worker = null; }
  return worker;
}

/** Call `fn` in about `ms`, whether or not this tab is in front. Returns a way to call it off. */
export function wakeIn(fn: () => void, ms: number): () => void {
  if (!start()) {
    const t = setTimeout(fn, ms);
    return () => { clearTimeout(t); };
  }
  const w: Waiting = { at: Date.now() + ms, fn };
  waiting.add(w);
  return () => { waiting.delete(w); };
}
