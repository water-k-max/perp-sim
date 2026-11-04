/**
 *  The equity walker: one resampled path as an exact integer accumulation (spec §3).
 *
 *  A path is a sequence of `horizon` trades in a drawn order, walked at the chosen sizing.
 *  `static` applies each trade's exact PnL as-is; `compound` scales each PnL by the running
 *  equity over starting capital, optionally capped at a multiple of start. Equity is bigint
 *  quote units at every step — the only float step in the whole resample pipeline is
 *  percentile interpolation over decimals at the stats edge.
 *
 *  Max drawdown is measured from the account's start at the worst point along the path
 *  (their table's "losing" definition), not from a running high: `start - min(curve)`.
 */

import { drawOrder, type ResampleMode } from "./sample.js";
import { deriveStream } from "./rng.js";

export const SIZING_MODES = ["static", "compound"] as const;
export type SizingMode = (typeof SIZING_MODES)[number];

export type PathTrade = { pnl: bigint };

export type PathOutcome = {
  /** Equity at step 0 is `start`; one entry per trade after that (length horizon + 1). */
  curve: bigint[];
  finalEquity: bigint;
  /** Depth of the worst point below start, in quote units. */
  maxDrawdown: bigint;
  /** Depth as basis points of starting capital. */
  maxDrawdownBps: bigint;
  maxLosingStreak: number;
  /** True when equity reaches or passes zero at any step. */
  bankruptcy: boolean;
};

export type WalkOptions = {
  /** The drawn trade order (length = horizon). */
  order: readonly PathTrade[];
  /** Starting equity in quote units; must be positive. */
  start: bigint;
  sizing: SizingMode;
  /** Compound cap: equity multiple of start beyond which size stops growing (null = none). */
  compoundCapMultiple?: bigint | null;
};

export function walkPath(opts: WalkOptions): PathOutcome {
  const { order, start, sizing } = opts;
  const cap = opts.compoundCapMultiple ?? null;
  if (start <= 0n) throw new Error("starting equity must be positive");
  if (cap !== null && cap < 1n) throw new Error("compound cap must be at least 1x start");

  const curve: bigint[] = [start];
  let equity = start;
  let minEquity = start;
  let streak = 0;
  let maxStreak = 0;
  let bankrupt = false;

  for (const trade of order) {
    const applied =
      sizing === "static" || equity === start
        ? trade.pnl
        : (trade.pnl * (cap !== null && equity > cap * start ? cap * start : equity)) / start;
    equity += applied;
    curve.push(equity);
    if (equity < minEquity) minEquity = equity;
    if (equity <= 0n) bankrupt = true;
    if (applied < 0n) {
      streak += 1;
      if (streak > maxStreak) maxStreak = streak;
    } else if (applied > 0n) {
      streak = 0;
    }
  }

  const maxDrawdown = start > minEquity ? start - minEquity : 0n;
  return {
    curve,
    finalEquity: equity,
    maxDrawdown,
    maxDrawdownBps: (maxDrawdown * 10_000n) / start,
    maxLosingStreak: maxStreak,
    bankruptcy: bankrupt,
  };
}

export type SimulatePathsOptions = {
  trades: readonly PathTrade[];
  mode: ResampleMode;
  sizing: SizingMode;
  paths: number;
  horizon: number;
  start: bigint;
  seed: string | number | bigint;
  compoundCapMultiple?: bigint | null;
};

/** The full path set: one derived stream per path, each drawn and walked independently. */
export function simulatePaths(opts: SimulatePathsOptions): PathOutcome[] {
  const out: PathOutcome[] = [];
  for (let i = 0; i < opts.paths; i += 1) {
    const rng = deriveStream(opts.seed, i);
    const order = drawOrder(opts.trades, opts.mode, opts.horizon, rng);
    out.push(walkPath({ order, start: opts.start, sizing: opts.sizing, compoundCapMultiple: opts.compoundCapMultiple }));
  }
  return out;
}
