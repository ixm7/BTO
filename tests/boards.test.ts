import { describe, expect, it } from 'vitest';
import { BoardError, dealText, handsOf, readBoards } from '../src/engine/boards';
import { cardName } from '../src/engine/cards';
import { dealBoard } from '../src/engine/deal';
import { boardsBody, parseBoards } from '../src/directory/github';
import { boardFor, buildConfig } from '../src/tournament/state';

const PBN = `% PBN 2.1
[Event "Club night"]
[Board "1"]
[Dealer "N"]
[Deal "N:AK52.Q84.KJ3.A97 QJT.AK9.AQT2.K64 983.JT7532.84.QJ 764.6.9765.T8532"]

[Board "2"]
[Dealer "E"]
[Deal "E:KQJT.AK.QJT9.AK2 A98.QJT.8765.QJT 7654.98765.4.987 32.432.AK32.6543"]
`;

/* One board as Bridge Base writes it: a dealer digit, then South, West and
   North, with East left to be whatever is over. */
const LIN = 'qx|o1|md|3S983HJT7532D84CQJ,S764H6D9765CT8532,SAK52HQ84DKJ3CA97|sv|o|';

describe('reading somebody else\'s boards', () => {
  it('reads a PBN file, board by board', () => {
    const deals = readBoards(PBN);
    expect(deals).toHaveLength(2);
    /* Written from North whatever seat the file started at. */
    expect(deals[0]).toBe('N:AK52.Q84.KJ3.A97 QJT.AK9.AQT2.K64 983.JT7532.84.QJ 764.6.9765.T8532');
    /* Board 2 is dealt from East, so its fourth hand is North's. */
    expect(deals[1]?.startsWith('N:32.432.AK32.6543')).toBe(true);
  });

  it('turns a deal into hands the engine can play', () => {
    const hands = handsOf('N:AK52.Q84.KJ3.A97 QJT.AK9.AQT2.K64 983.JT7532.84.QJ 764.6.9765.T8532');
    expect(hands.N.map(cardName).sort()).toEqual(['C7', 'C9', 'CA', 'D3', 'DJ', 'DK', 'H4', 'H8', 'HQ', 'S2', 'S5', 'SA', 'SK'].sort());
    expect(hands.E).toHaveLength(13);
    expect(hands.S).toHaveLength(13);
    expect(hands.W).toHaveLength(13);
    /* And back again unchanged. */
    expect(dealText(hands)).toBe('N:AK52.Q84.KJ3.A97 QJT.AK9.AQT2.K64 983.JT7532.84.QJ 764.6.9765.T8532');
  });

  it('reads a LIN file, working out the hand it leaves out', () => {
    const deals = readBoards(LIN);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toBe('N:AK52.Q84.KJ3.A97 QJT.AK9.AQT2.K64 983.JT7532.84.QJ 764.6.9765.T8532');
  });

  it('writes any dealt board back out in the same form', () => {
    const deal = dealText(dealBoard('a-seed', 3));
    expect(readBoards(`[Deal "${deal}"]`)).toEqual([deal]);
  });

  it('says what is wrong rather than playing a broken board', () => {
    expect(() => handsOf('N:AK52.Q84.KJ3.A9 QJT.AK9.AQT2.K64 983.JT7532.84.QJ 764.6.9765.T8532'))
      .toThrow(/12 cards/);
    /* The same card twice is the usual sign of a file edited by hand. */
    expect(() => handsOf('N:AK52.Q84.KJ3.A97 AQJT.AK9.AQT2.K6 983.JT7532.84.QJ 764.6.9765.T8532'))
      .toThrow(/in two hands/);
    expect(() => handsOf('AK52.Q84.KJ3.A97 QJT.AK9.AQT2.K64 983.JT7532.84.QJ 764.6.9765.T8532'))
      .toThrow(BoardError);
    expect(() => readBoards('')).toThrow(/empty/);
    /* A file of auctions without the cards is a common thing to pick up. */
    expect(() => readBoards('[Event "x"]\n[Auction "N"]\n1S Pass 2S Pass')).toThrow(/No \[Deal/);
  });
});

describe('boards kept with the tournament', () => {
  const deal1 = 'N:AK52.Q84.KJ3.A97 QJT.AK9.AQT2.K64 983.JT7532.84.QJ 764.6.9765.T8532';
  const deal2 = dealText(dealBoard('other', 1));
  const c = (login: string, body: string, at: string) => ({ user: { login }, body, created_at: at });

  it('takes the director\'s word for them, and nobody else\'s', () => {
    const mine = parseBoards([c('ida', boardsBody([deal1, deal2]), '2026-11-16T12:00:00Z')], 'ida');
    expect(mine).toEqual([deal1, deal2]);

    /* A player posting boards would be posting boards they had seen. */
    expect(parseBoards([c('bob', boardsBody([deal1, deal2]), '2026-11-16T12:00:00Z')], 'ida')).toBeNull();
  });

  it('takes the last word, and lets them be taken back', () => {
    const later = parseBoards([
      c('ida', boardsBody([deal1]), '2026-11-16T12:00:00Z'),
      c('ida', boardsBody([deal2]), '2026-11-16T12:05:00Z'),
    ], 'ida');
    expect(later).toEqual([deal2]);

    expect(parseBoards([
      c('ida', boardsBody([deal1]), '2026-11-16T12:00:00Z'),
      c('ida', '/boards clear', '2026-11-16T12:05:00Z'),
    ], 'ida')).toBeNull();
  });

  it('ignores a board list that is not all deals', () => {
    const broken = boardsBody([deal1]).replace('N:AK52', 'N:AK5');
    expect(parseBoards([c('ida', broken, '2026-11-16T12:00:00Z')], 'ida')).toBeNull();
  });

  it('plays the boards it was given, and deals the rest itself', () => {
    const config = buildConfig({
      id: 't', name: 'Club night', seed: 'a-seed', players: [],
      boardsPerRound: 2, rounds: 2, minTables: 1, deals: [deal1],
    });
    /* The one it was given. */
    expect(dealText(boardFor(config, 1))).toBe(deal1);
    /* And board two, which the file did not have, from the seed as before. */
    expect(dealText(boardFor(config, 2))).toBe(dealText(dealBoard('a-seed', 2)));
  });
});
