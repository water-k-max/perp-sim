/**
 *  Distribution statistics over a path set (spec §4).
 *
 *  Path equity stays bigint-exact end to end. Percentile interpolation is the single
 *  float step, done here on decimal values (`Number(value) / quoteScale`) — per the
 *  AGENTS.md constraint it never touches raw units. The ladder is p05/p10/p25/p50/p75/
 *  p90/p95 with CVaR-95 (the mean of the worst 5% of finals), a per-step fan of
 *  p10/p25/p50/p75/p90, and the per-path drawdown (bps of start) and losing-streak
 *  distributions.
 */

import type { PathOutcome } from "./path.js";

export const FAN_QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9] as const;
export const LADDER_QUANTILES = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95] as const;
/** The fan's inner band (p25–p75) and outer band (p10–p90). */
export type FanBand = {
  step: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
};

export type PathSummary = {
  paths: number;
  /** One final equity per path, in path order (raw material for the edge). */
  finalEquities: bigint[];
  medianFinalEquity: number;
  p05FinalEquity: number;
  p10FinalEquity: number;
  p25FinalEquity: number;
  p50FinalEquity: number;
  p75FinalEquity: number;
  p90FinalEquity: number;
  p95FinalEquity: number;
  /** Mean of the worst 5% of finals, decimal-quote units. */
  cvar95: number;
  bankruptcyCount: number;
  bankruptcyRate: number;
  /** Percentiles of the per-path max-drawdown distribution, in basis points of start. */
  medianMaxDrawdownBps: number;
  p95MaxDrawdownBps: number;
  medianMaxLosingStreak: number;
  p95MaxLosingStreak: number;
  /** Per-path exact values, in path order. */
  maxDrawdownsBps: bigint[];
  maxLosingStreaks: number[];
  fan: FanBand[];
};

/** Quantile of sorted numbers by linear interpolation (the float edge step). */
export function quantileNum(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) throw new Error("quantile of an empty set");
  if (n === 1) return sorted[0]!;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

function dec(value: bigint, quoteScale: bigint): number {
  return Number(value) / Number(quoteScale);
}

/** Quantile of sorted bigint quote units, interpolated on decimal values. */
export function quantileBig(sorted: readonly bigint[], q: number, quoteScale: bigint): number {
  return quantileNum(sorted.map((v) => dec(v, quoteScale)), q);
}

export function summarizePaths(paths: readonly PathOutcome[], quoteScale: bigint): PathSummary {
  if (paths.length === 0) throw new Error("cannot summarize an empty path set");
  const n = paths.length;
  const finals = paths.map((p) => p.finalEquity);
  const sortedFinals = finals.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const decSorted = sortedFinals.map((v) => dec(v, quoteScale));

  const worstK = Math.max(1, Math.floor(n * 0.05));
  const cvar95 = decSorted.slice(0, worstK).reduce((a, b) => a + b, 0) / worstK;

  const ddBps = paths.map((p) => p.maxDrawdownBps);
  const ddSorted = ddBps.map(Number).sort((a, b) => a - b);
  const streaks = paths.map((p) => p.maxLosingStreak);
  const streakSorted = streaks.slice().sort((a, b) => a - b);
  const bankruptcies = paths.filter((p) => p.bankruptcy).length;

  const steps = paths[0]!.curve.length;
  const fan: FanBand[] = [];
  for (let s = 0; s < steps; s += 1) {
    const atStep = paths.map((p) => p.curve[s]!).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    fan.push({
      step: s,
      p10: quantileBig(atStep, 0.1, quoteScale),
      p25: quantileBig(atStep, 0.25, quoteScale),
      p50: quantileBig(atStep, 0.5, quoteScale),
      p75: quantileBig(atStep, 0.75, quoteScale),
      p90: quantileBig(atStep, 0.9, quoteScale),
    });
  }

  return {
    paths: n,
    finalEquities: finals,
    medianFinalEquity: quantileNum(decSorted, 0.5),
    p05FinalEquity: quantileNum(decSorted, 0.05),
    p10FinalEquity: quantileNum(decSorted, 0.1),
    p25FinalEquity: quantileNum(decSorted, 0.25),
    p50FinalEquity: quantileNum(decSorted, 0.5),
    p75FinalEquity: quantileNum(decSorted, 0.75),
    p90FinalEquity: quantileNum(decSorted, 0.9),
    p95FinalEquity: quantileNum(decSorted, 0.95),
    cvar95,
    bankruptcyCount: bankruptcies,
    bankruptcyRate: bankruptcies / n,
    medianMaxDrawdownBps: quantileNum(ddSorted, 0.5),
    p95MaxDrawdownBps: quantileNum(ddSorted, 0.95),
    medianMaxLosingStreak: quantileNum(streakSorted, 0.5),
    p95MaxLosingStreak: quantileNum(streakSorted, 0.95),
    maxDrawdownsBps: ddBps,
    maxLosingStreaks: streaks,
    fan,
  };
}
