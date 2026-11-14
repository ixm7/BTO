/**
 * The stronger robot: Standard American bidding, and card play worked out by
 * a solver running in the background. If the background thread or the solver
 * cannot be had — an old browser, a blocked download — it quietly plays as
 * the simple robot does, so a table never waits on it.
 *
 * One worker serves every robot on the page, in the order they ask. A browser
 * that is also running a table of robots nobody is sitting at gives those
 * robots a shorter think, so the person's own table is never kept waiting
 * behind a hand nobody is watching.
 */
import { chooseCard as simpleCard } from '../engine/bot';
import { chooseSayc } from '../engine/sayc';
import type { RobotBrain } from '../tournament/node';
import type { Answer, Ask } from './robotWorker';

/** Longer than any card should take; after this the simple robot's card is played. */
const GIVE_UP_MS = 15000;

/** What the robot has been doing, for diagnosis from the browser console (`robotStats`). */
export const robotStats = { asked: 0, solved: 0, simple: 0, totalMs: 0, maxMs: 0, samples: 0 };
(globalThis as { robotStats?: typeof robotStats }).robotStats = robotStats;

let worker: Worker | null = null;
let broken = false;
let next = 1;
const waiting = new Map<number, (a: Answer) => void>();

const start = (): Worker | null => {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL('./robotWorker.ts', import.meta.url));
    worker.onmessage = (e: MessageEvent<Answer>) => { const done = waiting.get(e.data.id); waiting.delete(e.data.id); done?.(e.data); };
    worker.onerror = () => { broken = true; worker = null; for (const done of waiting.values()) done({ id: 0, error: 'worker failed' }); waiting.clear(); };
  } catch { broken = true; worker = null; }
  return worker;
};

/** How hard this set of robots thinks. Left out, they take their usual time. */
export interface RobotEffort {
  budgetMs?: number;
  maxSamples?: number;
}

export function makeRobot(effort: RobotEffort = {}): RobotBrain {
  const base = new URL('./dds/', document.baseURI).href;
  return {
    call(hand, auction, seat, system) {
      const c = chooseSayc(hand, auction, seat, system);
      /* Every bid and double is explained, the plain ones too: a partner or an
         opponent should never have to guess what a robot meant. */
      return { call: c.call, ...(c.call.type !== 'pass' && c.says ? { alert: c.says } : {}) };
    },
    card(play, seat, auction, system) {
      const w = start();
      robotStats.asked++;
      if (!w) { robotStats.simple++; return Promise.resolve(simpleCard(play, seat)); }
      return new Promise((resolve) => {
        const id = next++;
        const timer = setTimeout(() => { waiting.delete(id); robotStats.simple++; resolve(simpleCard(play, seat)); }, GIVE_UP_MS);
        waiting.set(id, (a) => {
          clearTimeout(timer);
          if (a.error) broken ||= /did not load|worker failed/.test(a.error);
          if (typeof a.card === 'number') { robotStats.solved++; robotStats.totalMs += a.ms ?? 0; robotStats.maxMs = Math.max(robotStats.maxMs, a.ms ?? 0); robotStats.samples += a.samples ?? 0; }
          else robotStats.simple++;
          resolve(typeof a.card === 'number' ? a.card : simpleCard(play, seat));
        });
        const ask: Ask = {
          id, base, play, seat, auction, system,
          ...(effort.budgetMs === undefined ? {} : { budgetMs: effort.budgetMs }),
          ...(effort.maxSamples === undefined ? {} : { maxSamples: effort.maxSamples }),
        };
        w.postMessage(ask);
      });
    },
  };
}
