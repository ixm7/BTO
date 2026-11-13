import { sideOf, type Side } from './cards';
import type { Contract } from './bidding';
import { isVulnerable, type Vulnerability } from './deal';

/** Duplicate score for the declaring side (negative when the contract fails). */
export function declarerScore(contract: Contract, vulnerable: boolean, tricksTaken: number): number {
  const { level, strain, doubled } = contract;
  const needed = level + 6;
  const diff = tricksTaken - needed;

  if (diff < 0) {
    const down = -diff;
    if (doubled === 0) return -down * (vulnerable ? 100 : 50);
    let penalty = 0;
    for (let i = 1; i <= down; i++) {
      if (vulnerable) penalty += i === 1 ? 200 : 300;
      else penalty += i === 1 ? 100 : i <= 3 ? 200 : 300;
    }
    return -penalty * (doubled === 2 ? 2 : 1);
  }

  const perTrick = strain === 'C' || strain === 'D' ? 20 : 30;
  const mult = doubled === 0 ? 1 : doubled === 1 ? 2 : 4;
  const trickPoints = (perTrick * level + (strain === 'N' ? 10 : 0)) * mult;
  let score = trickPoints;
  score += trickPoints >= 100 ? (vulnerable ? 500 : 300) : 50;
  if (level === 6) score += vulnerable ? 750 : 500;
  if (level === 7) score += vulnerable ? 1500 : 1000;
  if (doubled === 1) score += 50;
  if (doubled === 2) score += 100;
  if (doubled === 0) score += diff * perTrick;
  else score += diff * (vulnerable ? 200 : 100) * (doubled === 2 ? 2 : 1);
  return score;
}

/** Score from North-South's point of view. */
export function nsScore(contract: Contract | null, vul: Vulnerability, declarerTricks: number): number {
  if (!contract) return 0;
  const side: Side = sideOf(contract.declarer);
  const s = declarerScore(contract, isVulnerable(vul, side), declarerTricks);
  return side === 'NS' ? s : -s;
}

export function contractToString(contract: Contract | null): string {
  if (!contract) return 'Passed out';
  const sym = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' }[contract.strain];
  return `${contract.level}${sym}${contract.doubled === 1 ? 'x' : contract.doubled === 2 ? 'xx' : ''} ${contract.declarer}`;
}

export function resultToString(contract: Contract | null, declarerTricks: number): string {
  if (!contract) return 'Pass';
  const diff = declarerTricks - (contract.level + 6);
  return `${contractToString(contract)} ${diff === 0 ? '=' : diff > 0 ? `+${diff}` : `${diff}`}`;
}

/**
 * Matchpoint one board. Input: the NS score at each table that played it.
 * Output (same order): NS matchpoints, 2 per score beaten and 1 per tie; top = 2 * (n - 1).
 */
export function matchpoints(nsScores: readonly number[]): { ns: number[]; top: number } {
  const top = 2 * (nsScores.length - 1);
  const ns = nsScores.map((mine, i) => {
    let mp = 0;
    nsScores.forEach((other, j) => {
      if (i === j) return;
      if (mine > other) mp += 2;
      else if (mine === other) mp += 1;
    });
    return mp;
  });
  return { ns, top };
}

/** The International Match Point scale: how big a difference in score is. */
const IMP_SCALE = [20, 50, 90, 130, 170, 220, 270, 320, 370, 430, 500, 600, 750, 900, 1100, 1300, 1500, 1750, 2000, 2250, 2500, 3000, 3500, 4000];
export function imps(diff: number): number {
  const a = Math.abs(diff);
  let n = 0;
  while (n < IMP_SCALE.length && a >= (IMP_SCALE[n] as number)) n++;
  return Math.sign(diff) * n;
}

/**
 * IMP pairs ("cross-IMPs"): each table's North-South score is compared with
 * every other table's on the same board, each comparison turned into IMPs, and
 * the average taken — so the figure means the same however many tables played.
 * East-West get the same number with the sign turned. One table alone: zero.
 */
export function crossImps(nsScores: readonly number[]): number[] {
  const others = nsScores.length - 1;
  if (others <= 0) return nsScores.map(() => 0);
  return nsScores.map((mine, i) => {
    let sum = 0;
    nsScores.forEach((other, j) => { if (i !== j) sum += imps(mine - other); });
    return sum / others;
  });
}
