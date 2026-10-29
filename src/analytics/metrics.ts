import type { RunResult } from "../engine/loop.js";
import type { ModeledFill } from "../strategy/types.js";
import { bps, isqrt, sqrtScaled, toDecimal } from "./decimal.js";

/**
 *  Risk and activity numbers a quant expects, computed from exactly what the replay did.
 *
 *  Returns are per settlement bar, from equity at mark, so a change in margin requirement or
 *  a fee never leaks into the return series. Ratios are scaled by 10,000 (`X1e4`) so they
 *  are integers here and decimal strings at the API edge.
 */
export type Metrics = {
  bars: number;
  spanSec: number;
  /** Settlement bars per year implied by the median bar gap. */
  periodsPerYear: number;
  totalReturnBps: bigint | null;
  maxDrawdownBps: bigint | null;
  /** Annualised mean / standard deviation of per-bar returns, x 10,000. */
  sharpeX1e4: bigint | null;
  /** Annualised mean / downside deviation, x 10,000. */
  sortinoX1e4: bigint | null;
  /** Traded notional / mean equity, in basis points. */
  turnoverBps: bigint | null;
  trades: number;
  wins: number;
  losses: number;
  winRateBps: bigint | null;
  avgTrade: bigint | null;
  expectancy: bigint | null;
  avgHoldSec: number | null;
  bestTrade: bigint | null;
  worstTrade: bigint | null;
};

const YEAR_SEC = 31_536_000;
const RATIO_SCALE = 10_000n;
/**
 *  Returns are `delta / prev` in this fixed point. It is deliberately wide: equity is raw
 *  quote units (1e18 per unit), so a 1e18 return scale would floor every small bar to zero.
 *  A ratio of two returns is scale-free, so Sharpe and Sortino do not depend on this.
 */
const RETURN_SCALE = 10n ** 30n;

/** Per-bar equity returns, `(E_t - E_{t-1}) / E_{t-1}`, in `RETURN_SCALE` fixed point. */
export function barReturns(result: RunResult): bigint[] {
  const out: bigint[] = [];
  const trail = result.trail;
  for (let i = 1; i < trail.length; i += 1) {
    const prev = trail[i - 1]!.equityAtMark;
    if (prev === 0n) continue;
    out.push(((trail[i]!.equityAtMark - prev) * RETURN_SCALE) / prev);
  }
  return out;
}

function medianGapSec(result: RunResult): number {
  const gaps: number[] = [];
  for (let i = 1; i < result.trail.length; i += 1) gaps.push(result.trail[i]!.t - result.trail[i - 1]!.t);
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 === 0 ? Math.round((gaps[mid - 1]! + gaps[mid]!) / 2) : gaps[mid]!;
}

function mean(values: bigint[]): bigint {
  return values.reduce((sum, v) => sum + v, 0n) / BigInt(values.length);
}

function annualised(meanReturn: bigint, deviation: bigint, periodsPerYear: number): bigint | null {
  if (deviation === 0n || periodsPerYear <= 0) return null;
  // mean/deviation * sqrt(periodsPerYear), kept at four decimal places.
  const root = sqrtScaled(BigInt(periodsPerYear), 1_000_000n);
  return (meanReturn * RATIO_SCALE * root) / (deviation * 1_000_000n);
}

export function computeMetrics(result: RunResult): Metrics {
  const returns = barReturns(result);
  const gap = medianGapSec(result);
  const periodsPerYear = gap > 0 ? Math.max(1, Math.round(YEAR_SEC / gap)) : 0;
  const spanSec = result.trail.length > 1 ? result.trail[result.trail.length - 1]!.t - result.trail[0]!.t : 0;

  let sharpe: bigint | null = null;
  let sortino: bigint | null = null;
  if (returns.length >= 3) {
    const m = mean(returns);
    let variance = 0n;
    let downside = 0n;
    for (const r of returns) {
      const d = r - m;
      variance += d * d;
      if (r < 0n) downside += r * r;
    }
    variance /= BigInt(returns.length);
    const sd = isqrt(variance);
    sharpe = annualised(m, sd, periodsPerYear);
    const downDev = isqrt(downside / BigInt(returns.length));
    sortino = annualised(m, downDev, periodsPerYear);
  }

  let peak = result.trail.length > 0 ? result.trail[0]!.equityAtMark : 0n;
  let maxDd = 0n;
  for (const bar of result.trail) {
    if (bar.equityAtMark > peak) peak = bar.equityAtMark;
    if (peak > 0n) {
      const dd = ((peak - bar.equityAtMark) * 10_000n) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }

  const equitySeries = result.trail.filter((t) => t.size !== 0n);
  const meanEquity =
    equitySeries.length === 0
      ? result.equityStart
      : equitySeries.reduce((sum, t) => sum + t.equityAtMark, 0n) / BigInt(equitySeries.length);

  const tradedNotional = result.fills.reduce((sum, f) => sum + f.quote, 0n);
  const trades = result.trades;
  const wins = trades.filter((t) => t.netPnl > 0n).length;
  const losses = trades.filter((t) => t.netPnl < 0n).length;
  const totalNet = trades.reduce((sum, t) => sum + t.netPnl, 0n);
  const holdSecs = trades.map((t) => t.heldSec).filter((s) => s > 0);

  return {
    bars: result.trail.length,
    spanSec,
    periodsPerYear,
    totalReturnBps: bps(result.equityEnd - result.equityStart, result.equityStart),
    maxDrawdownBps: maxDd,
    sharpeX1e4: sharpe,
    sortinoX1e4: sortino,
    turnoverBps: bps(tradedNotional, meanEquity),
    trades: trades.length,
    wins,
    losses,
    winRateBps: trades.length === 0 ? null : (BigInt(wins) * 10_000n) / BigInt(trades.length),
    avgTrade: trades.length === 0 ? null : totalNet / BigInt(trades.length),
    expectancy: trades.length === 0 ? null : totalNet / BigInt(trades.length),
    avgHoldSec: holdSecs.length === 0 ? null : Math.round(holdSecs.reduce((a, b) => a + b, 0) / holdSecs.length),
    bestTrade: trades.length === 0 ? null : trades.reduce((best, t) => (t.netPnl > best ? t.netPnl : best), trades[0]!.netPnl),
    worstTrade: trades.length === 0 ? null : trades.reduce((worst, t) => (t.netPnl < worst ? t.netPnl : worst), trades[0]!.netPnl),
  };
}

/**
 *  Markout: how a fill looks at a fixed horizon afterwards, in basis points of the fill
 *  price. Positive is favourable (price moved the way the position points).
 *
 *  `priceAt` must be a lookup over prices that existed at or before the requested second —
 *  the caller owns that, because using a bar that closes after the horizon is lookahead.
 */
export function markouts(
  fills: readonly ModeledFill[],
  priceAt: (t: number) => bigint | null,
  horizonSec: number,
): bigint | null {
  let sum = 0n;
  let count = 0;
  for (const fill of fills) {
    const later = priceAt(fill.t + horizonSec);
    if (later === null) continue;
    const raw = ((later - fill.price) * 10_000n) / fill.price;
    sum += fill.side === "buy" ? raw : -raw;
    count += 1;
  }
  return count === 0 ? null : sum / BigInt(count);
}

/** The metrics as decimal strings, ready to serialise. */
export function metricsView(m: Metrics): Record<string, string | number | null> {
  return {
    bars: m.bars,
    spanSec: m.spanSec,
    periodsPerYear: m.periodsPerYear,
    totalReturnBps: m.totalReturnBps?.toString() ?? null,
    maxDrawdownBps: m.maxDrawdownBps?.toString() ?? null,
    sharpe: m.sharpeX1e4 === null ? null : toDecimal(m.sharpeX1e4, RATIO_SCALE),
    sortino: m.sortinoX1e4 === null ? null : toDecimal(m.sortinoX1e4, RATIO_SCALE),
    turnoverBps: m.turnoverBps?.toString() ?? null,
    trades: m.trades,
    wins: m.wins,
    losses: m.losses,
    winRateBps: m.winRateBps?.toString() ?? null,
    avgTrade: m.avgTrade?.toString() ?? null,
    expectancy: m.expectancy?.toString() ?? null,
    avgHoldSec: m.avgHoldSec,
    bestTrade: m.bestTrade?.toString() ?? null,
    worstTrade: m.worstTrade?.toString() ?? null,
  };
}
