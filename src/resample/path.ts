/**
 *  The equity walker: one resampled path as an exact integer accumulation design doc.
 *
 *  A path is a sequence of `horizon` trades in a drawn order, walked at the chosen sizing.
 *  `static` applies each trade's exact PnL as-is; `compound` scales each PnL by the running
 *  equity over starting capital, optionally capped at a multiple of start. Equity is bigint
 *  quote units at every step — the only float step in the whole resample pipeline is
 *  percentile interpolation over decimals at the stats edge.
 *
 *  Max drawdown is measured from the account's start at the worst point along the path
 *  (their table's "losing" definition), not from a running high: `start - min(curve)`.
 *  Bankruptcy is an absorbing barrier — equity clamps at zero and every later step stays
 *  there — because a liquidated perp account has no position left to win or lose on, and
 *  letting trades land on a zero or negative base would let the tail stats resurrect it.
 *  Each path also carries its own win rate and per-trade Sharpe (exact integers, ×10⁴),
 *  so the stats edge can state confidence intervals for the metrics a single run reports.
 */

import { setImmediate } from "node:timers";
import { drawOrder, type ResampleMode } from "./sample.js";
import { deriveStream } from "./rng.js";
import { isqrt } from "../analytics/decimal.js";

export const SIZING_MODES = ["static", "compound"] as const;
export type SizingMode = (typeof SIZING_MODES)[number];

/** Hard ceiling on walked steps per simulation (paths × horizon); measured ~1.5M steps/s, so a pass stays ~1–2 s. */
export const RESAMPLE_WORK_MAX = 2_000_000;
/** Event-loop slice budget: yield to other requests after roughly this many walked steps. */
const WORK_PER_CHUNK = 100_000;

export function assertWorkBudget(paths: number, horizon: number): void {
  if (paths * horizon > RESAMPLE_WORK_MAX) {
    throw new Error(`resample work budget exceeded: paths × horizonTrades = ${paths * horizon} is above the ${RESAMPLE_WORK_MAX} step ceiling; reduce paths or horizonTrades.`);
  }
}

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
  /** Share of applied PnLs that are positive, x 10,000 (the path's own win rate). */
  winRateBps: bigint;
  /**
   *  Per-trade Sharpe of the path's applied PnLs, x 10,000, exact integers — the same
   *  convention as the run metrics, but over trades and not annualised. Null when the
   *  deviation is zero or the path holds fewer than three trades.
   */
  sharpeX1e4: bigint | null;
  /** True when equity reaches or passes zero at any step; once true, the rest of the walk is frozen at zero. */
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
  const appliedPnls: bigint[] = [];
  let equity = start;
  let minEquity = start;
  let streak = 0;
  let maxStreak = 0;
  let bankrupt = false;

  for (const trade of order) {
    if (bankrupt) {
      // Absorbing barrier: once the account is wiped it stays flat at zero. No later trade
      // resurrects it, so the tail stats (CVaR, p05) never mix in post-bankruptcy recovery.
      // The curve keeps its fixed horizon+1 length so the fan and stats stay step-aligned.
      curve.push(0n);
      continue;
    }
    const applied =
      sizing === "static" || equity === start
        ? trade.pnl
        : (trade.pnl * (cap !== null && equity > cap * start ? cap * start : equity)) / start;
    equity += applied;
    if (equity <= 0n) {
      // A liquidating perp account cannot go below zero: clamp the wipe to zero and freeze here.
      equity = 0n;
      bankrupt = true;
    }
    curve.push(equity);
    appliedPnls.push(applied);
    if (equity < minEquity) minEquity = equity;
    if (applied < 0n) {
      streak += 1;
      if (streak > maxStreak) maxStreak = streak;
    } else if (applied > 0n) {
      streak = 0;
    }
  }

  const wins = appliedPnls.filter((p) => p > 0n).length;
  const count = BigInt(appliedPnls.length);
  const winRateBps = (BigInt(wins) * 10_000n) / count;
  let sharpeX1e4: bigint | null = null;
  if (appliedPnls.length >= 3) {
    const sum = appliedPnls.reduce((s, p) => s + p, 0n);
    const mean = sum / count;
    let variance = 0n;
    for (const p of appliedPnls) {
      const d = p - mean;
      variance += d * d;
    }
    variance /= count;
    const sd = isqrt(variance);
    if (sd > 0n) sharpeX1e4 = (mean * 10_000n) / sd;
  }

  const maxDrawdown = start > minEquity ? start - minEquity : 0n;
  return {
    curve,
    finalEquity: equity,
    maxDrawdown,
    maxDrawdownBps: (maxDrawdown * 10_000n) / start,
    maxLosingStreak: maxStreak,
    winRateBps,
    sharpeX1e4,
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
export async function simulatePaths(opts: SimulatePathsOptions): Promise<PathOutcome[]> {
  assertWorkBudget(opts.paths, opts.horizon);
  const out: PathOutcome[] = [];
  // Chunk by walked steps so a long horizon still yields between paths instead of freezing the loop.
  const chunk = Math.max(1, Math.floor(WORK_PER_CHUNK / Math.max(1, opts.horizon)));
  for (let i = 0; i < opts.paths; i += 1) {
    const rng = deriveStream(opts.seed, i);
    const order = drawOrder(opts.trades, opts.mode, opts.horizon, rng);
    out.push(walkPath({ order, start: opts.start, sizing: opts.sizing, compoundCapMultiple: opts.compoundCapMultiple }));
    if ((i + 1) % chunk === 0 && i + 1 < opts.paths) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return out;
}
