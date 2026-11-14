/**
 * The robots' thinking, kept off the page's own thread so the table stays
 * responsive while a card is being chosen. It loads the double-dummy solver
 * once, then answers one question at a time: which card?
 */
import { makeSolver, type DdsModule, type Solve } from '../engine/dds';
import { thinkCard } from '../engine/playEngine';
import { readAuction, type System } from '../engine/sayc';
import type { AuctionState } from '../engine/bidding';
import type { PlayState } from '../engine/play';
import type { Seat } from '../engine/cards';

export interface Ask {
  id: number; base: string; play: PlayState; seat: Seat; auction: AuctionState | null; system?: System;
  /** How hard to think. Left out, the robot takes its usual time. */
  budgetMs?: number;
  maxSamples?: number;
}
export interface Answer { id: number; card?: number; samples?: number; ms?: number; error?: string }

interface Scope {
  importScripts(...urls: string[]): void;
  create_dds_module?: (o: { locateFile(f: string): string }) => Promise<DdsModule>;
  postMessage(a: Answer): void;
  onmessage: ((e: MessageEvent<Ask>) => void) | null;
}
const scope = self as unknown as Scope;

let solver: Promise<Solve> | null = null;
function load(base: string): Promise<Solve> {
  solver ??= (async () => {
    scope.importScripts(`${base}compiled.js`);
    if (!scope.create_dds_module) throw new Error('The solver did not load');
    return makeSolver(await scope.create_dds_module({ locateFile: (f) => `${base}${f}` }));
  })();
  return solver;
}

scope.onmessage = (e) => {
  const q = e.data;
  void (async () => {
    try {
      const solve = await load(q.base);
      const know = q.auction ? readAuction(q.auction, q.system ?? 'sayc').know : undefined;
      const t = thinkCard(q.play, q.seat, {
        solve, know,
        ...(q.budgetMs === undefined ? {} : { budgetMs: q.budgetMs }),
        ...(q.maxSamples === undefined ? {} : { maxSamples: q.maxSamples }),
      });
      scope.postMessage({ id: q.id, card: t.card, samples: t.samples, ms: t.ms });
    } catch (err) {
      scope.postMessage({ id: q.id, error: String(err) });
    }
  })();
};
