import { afterEach, describe, expect, it } from 'vitest';
import * as simple from '../src/engine/bot';
import { chooseSayc } from '../src/engine/sayc';
import { MemoryHub } from '../src/net/transport';
import { TournamentNode, type RobotBrain } from '../src/tournament/node';
import { turnAt } from '../src/tournament/state';

const nodes: TournamentNode[] = [];
afterEach(() => { for (const n of nodes.splice(0)) n.close(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 20000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(5); }
}

describe('a table run by a thinking robot', () => {
  it('plays a whole tournament with a robot that answers late, out of order, illegally or not at all', async () => {
    let asked = 0;
    const brain: RobotBrain = {
      call: (hand, auction, seat) => { const c = chooseSayc(hand, auction, seat); return { call: c.call, ...(c.alert ? { alert: c.says } : {}) }; },
      card: async (play, seat) => {
        asked++;
        await sleep(asked % 5);
        if (asked % 11 === 0) throw new Error('the solver fell over');
        if (asked % 7 === 0) return 99 as never;             // nonsense: the table must not accept it
        return simple.chooseCard(play, seat);
      },
    };
    const n = new TournamentNode(new MemoryHub().connect(), { playerId: 'solo', name: 'Solo', deviceScore: 50, isDirector: true },
      { botDelayMs: 0, tickMs: 20, idleTimeoutMs: 0, robot: brain });
    nodes.push(n);
    n.start({ id: 't', name: 'T', boardsPerRound: 2, rounds: 1, minTables: 2, seed: 'brain' });
    /* The one person at it plays their own cards as the simple robot would; robots play the other seven seats. */
    await until(() => n.state !== null);
    const t0 = Date.now();
    while (!n.state!.finished) {
      if (Date.now() - t0 > 60000) throw new Error('timed out');
      const at = n.mySeat();
      const turn = at ? turnAt(at.table) : null;
      if (at && turn && at.table.seats[turn.controller].id === 'solo') {
        if (turn.phase === 'auction') n.call(simple.chooseCall(at.table.deal![turn.seat], at.table.auction!, turn.seat));
        else n.play(turn.seat, simple.chooseCard(at.table.play!, turn.seat));
      }
      await sleep(3);
    }
    expect(n.state!.results.length).toBe(4);
    expect(asked).toBeGreaterThan(100);
    /* Conventional calls made by the robot carry their explanation. */
    const alerts = n.state!.results.flatMap((r) => r.auction ?? []).filter((e) => e.alert);
    for (const a of alerts) expect(a.alert!.length).toBeGreaterThan(3);
  }, 90000);
});
