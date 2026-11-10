import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHub } from '../src/net/transport';
import { TournamentNode, type Me } from '../src/tournament/node';
import { ALERT_MAX, replay, turnAt, type TEvent } from '../src/tournament/state';
import { applyCall, newAuction, parseCall } from '../src/engine/bidding';

const nodes: TournamentNode[] = [];
afterEach(() => { for (const n of nodes.splice(0)) n.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 20000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(5);
  }
}

function join(hub: MemoryHub, me: Partial<Me> & { playerId: string }): TournamentNode {
  const n = new TournamentNode(hub.connect(), {
    name: me.playerId, deviceScore: 50, isDirector: false, ...me,
  }, { botDelayMs: 0, tickMs: 30, absentGraceMs: 60, peerTimeoutMs: 100000 });
  nodes.push(n);
  return n;
}

describe('alert explanations on a call', () => {
  it('travels with its own call, so the two cannot drift apart', () => {
    const a = applyCall(newAuction('N'), 'N', parseCall('1H'), 'Could be a 4-card suit');
    expect(a.calls[0]).toEqual({ seat: 'N', call: { type: 'bid', level: 1, strain: 'H' }, alert: 'Could be a 4-card suit' });
  });

  it('omits the field entirely when the explanation is blank', () => {
    for (const blank of [undefined, '', '   ', '\n\t']) {
      const a = applyCall(newAuction('N'), 'N', parseCall('1H'), blank);
      expect(a.calls[0]).not.toHaveProperty('alert');
    }
  });

  it('trims surrounding whitespace', () => {
    const a = applyCall(newAuction('N'), 'N', parseCall('1H'), '  Transfer  ');
    expect(a.calls[0]!.alert).toBe('Transfer');
  });

  it('keeps alerts attached to the right call as the auction grows', () => {
    let a = newAuction('N');
    a = applyCall(a, 'N', parseCall('1H'), 'five-card major');
    a = applyCall(a, 'E', parseCall('P'));
    a = applyCall(a, 'S', parseCall('2C'), 'game-forcing relay');
    expect(a.calls.map((c) => c.alert)).toEqual(['five-card major', undefined, 'game-forcing relay']);
  });

  describe('across the network', () => {
    it('reaches the other players and survives a replay of the log', async () => {
      const hub = new MemoryHub();
      const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `p${i}`, isDirector: i === 0 }));
      await until(() => all.every((n) => n.lobby().length === 4));

      all[0]!.start({ id: 't1', name: 'Alerts', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
      await until(() => all.every((n) => n.state !== null));

      /* Whoever is on lead explains their opening call. */
      const bidder = all.find((n) => {
        const at = n.mySeat();
        const turn = at && turnAt(at.table);
        return !!turn && turn.phase === 'auction' && at!.table.seats[turn.controller].id === n.me.playerId;
      });
      expect(bidder).toBeDefined();
      const seat = bidder!.mySeat()!.seat;
      bidder!.call({ type: 'pass' }, '  Could be as few as 8 points  ');

      await until(() => all.every((n) => (n.state?.tables[0]?.auction?.calls.length ?? 0) > 0));

      for (const n of all) {
        const first = n.state!.tables[0]!.auction!.calls[0]!;
        expect(first.seat).toBe(seat);
        expect(first.alert).toBe('Could be as few as 8 points');
      }

      /* The log alone must reproduce the alert: optional fields are easy to
         drop in serialisation, and the log is what late joiners replay. */
      const fromLog = replay(JSON.parse(JSON.stringify(all[0]!.log)) as TEvent[]);
      expect(fromLog!.tables[0]!.auction!.calls[0]!.alert).toBe('Could be as few as 8 points');
    });

    it('clamps an over-long explanation rather than replicating it whole', async () => {
      const hub = new MemoryHub();
      const all = [0, 1, 2, 3].map((i) => join(hub, { playerId: `q${i}`, isDirector: i === 0 }));
      await until(() => all.every((n) => n.lobby().length === 4));
      all[0]!.start({ id: 't2', name: 'Alerts', boardsPerRound: 1, rounds: 1, seed: 'fixed' });
      await until(() => all.every((n) => n.state !== null));

      const bidder = all.find((n) => {
        const at = n.mySeat();
        const turn = at && turnAt(at.table);
        return !!turn && turn.phase === 'auction' && at!.table.seats[turn.controller].id === n.me.playerId;
      })!;
      bidder.call({ type: 'pass' }, 'x'.repeat(ALERT_MAX * 3));
      await until(() => all.every((n) => (n.state?.tables[0]?.auction?.calls.length ?? 0) > 0));

      for (const n of all) {
        expect(n.state!.tables[0]!.auction!.calls[0]!.alert!.length).toBe(ALERT_MAX);
      }
    });
  });
});
