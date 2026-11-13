import { describe, expect, it } from 'vitest';
import { chooseCall, chooseCard } from '../src/engine/bot';
import { crossImps, imps } from '../src/engine/scoring';
import { legalPlays, type Card, type Seat } from '../src/engine/cards';
import { seededRandom } from '../src/engine/deal';
import type { PlayState } from '../src/engine/play';
import { issueBody, makeMeta, parseMeta, parseResults, resultsBody, scoringName, type TournamentResults } from '../src/directory/github';
import { planConfig } from '../src/tournament/plan';
import { cardImps, impText, reviewBoard, scorecard } from '../src/tournament/review';
import { reduce, standings, turnAt, type LobbyPlayer, type TEvent, type TState } from '../src/tournament/state';

describe('IMPs', () => {
  it('follows the scale', () => {
    expect(imps(0)).toBe(0);
    expect(imps(10)).toBe(0);
    expect(imps(20)).toBe(1);
    expect(imps(-50)).toBe(-2);
    expect(imps(420 - 170)).toBe(6);      // game bid and made against a part-score
    expect(imps(620 + 100)).toBe(12);     // vulnerable game against one down
    expect(imps(4000)).toBe(24);
  });

  it('compares every table with every other and averages', () => {
    /* 420 against 170 is +6, against −50 is +10: average +8. 170 wins 6 and loses 6. */
    expect(crossImps([420, 170, -50])).toEqual([8, 0, -8]);
    /* What North-South win, East-West lose: it always sums to nothing. */
    expect(crossImps([620, 620, -100, 170, 650]).reduce((a, b) => a + b, 0)).toBeCloseTo(0);
    expect(crossImps([420])).toEqual([0]);
    expect(crossImps([])).toEqual([]);
  });

  it('writes them the way players do', () => {
    expect(impText(3.5)).toBe('+3.5');
    expect(impText(-2)).toBe('−2');
    expect(impText(0)).toBe('0');
    expect(impText(1 / 3)).toBe('+0.33');
  });
});

const roster = (n: number): LobbyPlayer[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, joinedAt: i }));

function playOut(scoring: 'imps' | 'matchpoints'): TState {
  const rnd = seededRandom('wild');
  const anyCard = (p: PlayState, seat: Seat): Card => { const legal = legalPlays(p.hands[seat], p.trick); return legal[Math.floor(rnd() * legal.length)] as Card; };
  let s = reduce(null, { t: 'start', config: planConfig({ id: 'i', name: 'I', seed: 'imp-pairs', roster: roster(12), boardsPerRound: 2, rounds: 2, scoring }) });
  for (let guard = 0; guard < 20000 && !s.finished; guard++) {
    const t = s.tables.find((x) => turnAt(x));
    if (!t) break;
    const turn = turnAt(t)!;
    const ev: TEvent = turn.phase === 'auction'
      ? { t: 'call', table: t.index, board: t.boardNo!, seat: turn.seat, call: chooseCall(t.deal![turn.seat], t.auction!, turn.seat) }
      /* Every table would play the same robots' game and tie every board, so
         table 0 plays its cards at random to give the scores something to compare. */
      : { t: 'play', table: t.index, board: t.boardNo!, seat: turn.seat, card: t.index === 0 ? anyCard(t.play!, turn.seat) : chooseCard(t.play!, turn.seat) };
    s = reduce(s, ev);
  }
  return s;
}

describe('an IMP pairs tournament', () => {
  const s = playOut('imps');
  const rows = standings(s);

  it('ranks pairs by IMPs, and the IMPs balance', () => {
    expect(s.finished).toBe(true);
    expect(s.config.scoring).toBe('imps');
    expect(rows).toHaveLength(6);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.imps).toBeGreaterThanOrEqual(rows[i]!.imps);
    expect(rows[0]!.rank).toBe(1);
    expect(rows.reduce((a, r) => a + r.imps, 0)).toBeCloseTo(0, 1);
    expect(rows.some((r) => r.imps !== 0)).toBe(true);
  });

  it('a pair\'s card adds up to its standing', () => {
    for (const r of rows) {
      const card = scorecard(s, r.pair.id);
      expect(card).toHaveLength(4);
      expect(cardImps(card)).toBeCloseTo(r.imps, 1);
    }
    const board = reviewBoard(s, 1, 0);
    expect(board.traveller.reduce((a, t) => a + t.nsImps, 0)).toBeCloseTo(0, 1);
  });

  it('the same play scored by matchpoints can rank differently, and says so', () => {
    const mp = playOut('matchpoints');
    expect(mp.config.scoring).toBeUndefined();
    expect(mp.results.map((r) => r.nsScore)).toEqual(s.results.map((r) => r.nsScore));
    expect(standings(mp)[0]!.percent).toBeGreaterThan(50);
    expect(standings(mp).every((r) => r.imps !== undefined)).toBe(true);
  });
});

describe('IMP pairs on the tournament list', () => {
  const base = { name: 'Friday IMPs', director: 'Ido', start: '2030-01-01T19:30', timeZone: 'UTC', capacity: 16, rounds: 2, boardsPerRound: 2, levels: ['Expert'] } as never;

  it('is kept with the tournament, and matchpoints is what an older one means', () => {
    const meta = makeMeta({ ...(base as object), scoring: 'imps' } as never);
    expect(meta.scoring).toBe('imps');
    expect(issueBody(meta)).toContain('| **Scoring** | IMP Pairs |');
    expect(parseMeta(issueBody(meta))!.scoring).toBe('imps');
    expect(makeMeta(base).scoring).toBe('matchpoints');
    expect(parseMeta(issueBody(makeMeta(base)))!.scoring).toBe('matchpoints');
    expect(scoringName(undefined)).toBe('Matchpoints');
  });

  it('publishes results in IMPs', () => {
    const r: TournamentResults = {
      v: 1, scoring: 'imps', finishedAt: '2030-01-01T22:00:00Z', tables: 2, boards: 4,
      rankings: [
        { rank: 1, players: 'Ann & Bob', direction: 'NS', percent: 60, matchpoints: 5, maxMatchpoints: 8, imps: 7.5 },
        { rank: 2, players: 'Cat & Dan', direction: 'EW', percent: 40, matchpoints: 3, maxMatchpoints: 8, imps: -7.5 },
      ],
    };
    const body = resultsBody(r);
    expect(body).toContain('| Rank | Pair | Dir | IMPs |');
    expect(body).toContain('| 1 | Ann & Bob | NS | +7.5 |');
    expect(body).toContain('| 2 | Cat & Dan | EW | −7.5 |');
    expect(parseResults([{ user: { login: 'x' }, body, created_at: '' }])).toEqual(r);
  });
});
