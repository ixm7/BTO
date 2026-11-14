import { describe, expect, it } from 'vitest';
import { dealBoard } from '../src/engine/deal';
import { SEATS } from '../src/engine/cards';

import { seedFor } from '../src/directory/github';

/** An entry list, as the seed takes it. */
const field = (...logins: string[]) => logins.map((login) => ({ login, name: login, at: '2026-11-14T14:00:00Z' }));

const shared = (a: ReturnType<typeof dealBoard>, b: ReturnType<typeof dealBoard>): number =>
  SEATS.reduce((n, s) => n + a[s].filter((c) => b[s].includes(c)).length, 0);

describe('two tournaments that look alike', () => {
  it('share nothing: the seeds are a hash apart', async () => {
    /* The same field, the same minute, consecutive issue numbers. */
    const t0 = Date.parse('2026-11-14T15:00:00Z');
    /* Same field, same minute, consecutive issue numbers — as alike as two
       tournaments can be. */
    const a = await seedFor({ number: 41 }, t0, field('ixm7'));
    const b = await seedFor({ number: 42 }, t0, field('ixm7'));
    /* One minute later, same issue. */
    const c = await seedFor({ number: 41 }, t0 + 60000, field('ixm7'));
    console.log('seeds:', a, b, c);
    for (const [x, y] of [[a, b], [a, c], [b, c]]) {
      expect(x).not.toBe(y);
      const common = shared(dealBoard(x as string, 1), dealBoard(y as string, 1));
      console.log(`cards in the same hand in both: ${common} of 52 (chance alone gives 13)`);
      expect(common).toBeLessThan(26);
    }
    /* And the same tournament always deals the same board, which is the point. */
    expect(dealBoard(a, 1)).toEqual(dealBoard(await seedFor({ number: 41 }, t0, field('ixm7')), 1));
  });
});
