import type { RunResult } from "../engine/loop.js";
import type { Bar } from "../history/bars.js";
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
 *  The mean over the fills whose horizon was actually printed, and how many fills that was.
 *
 *  `priceAt` must be a published price for the requested second — the caller owns which
 *  series it reads, and a fill whose horizon was never observed is skipped, not estimated.
 *  Markouts are measured after the fact, so reading a mark published past the horizon is an
 *  observation of the outcome, never an input to a decision.
 */
function markoutAt(
  fills: readonly ModeledFill[],
  priceAt: (t: number) => bigint | null,
  horizonSec: number,
): { markoutBps: bigint | null; observed: number } {
  let sum = 0n;
  let count = 0;
  for (const fill of fills) {
    const later = priceAt(fill.t + horizonSec);
    if (later === null) continue;
    const raw = ((later - fill.price) * 10_000n) / fill.price;
    sum += fill.side === "buy" ? raw : -raw;
    count += 1;
  }
  return { markoutBps: count === 0 ? null : sum / BigInt(count), observed: count };
}

const MARKOUT_INTERVAL_MULTIPLES = [1, 4, 24] as const;

/**
 *  The horizons the ladder is read at: 1, 4 and 24 settlement intervals.
 *
 *  Multiples of the cadence rather than round wall-clock numbers, because the oracle only
 *  prints once per interval: a horizon shorter than one interval is indistinguishable from
 *  the next mark, and a ladder whose rungs cannot differ would claim a curve it cannot see.
 *  At Hideki's hourly settlement this is exactly 1 h / 4 h / 24 h.
 */
export function markoutHorizonsSec(settlementIntervalSec: number): number[] {
  return MARKOUT_INTERVAL_MULTIPLES.map((multiple) => multiple * settlementIntervalSec);
}

/**
 *  One rung of the ladder. `observed` is how many fills had a settlement printed inside the
 *  window at that horizon, out of `total`: a 24 h rung read on a 3-day window loses every fill
 *  from the last day, and a mean over what survives is only honest next to the count.
 */
export type MarkoutRung = {
  horizonSec: number;
  markoutBps: bigint | null;
  observed: number;
  total: number;
};

export function markoutLadder(
  fills: readonly ModeledFill[],
  priceAt: (t: number) => bigint | null,
  horizonsSec: readonly number[],
): MarkoutRung[] {
  return horizonsSec.map((horizonSec) => {
    const { markoutBps, observed } = markoutAt(fills, priceAt, horizonSec);
    return { horizonSec, markoutBps, observed, total: fills.length };
  });
}

/** The ladder as decimal strings, ready to serialise. */
export function markoutView(ladder: readonly MarkoutRung[]): {
  rungs: { horizonSec: number; label: string; bps: string | null; observed: number; total: number }[];
} {
  return {
    rungs: ladder.map((rung) => ({
      horizonSec: rung.horizonSec,
      label: markoutHorizonLabel(rung.horizonSec),
      bps: rung.markoutBps?.toString() ?? null,
      observed: rung.observed,
      total: rung.total,
    })),
  };
}

/** "1 h", "4 h", "24 h", "90 m" — the same string on the CLI and in the browser. */
export function markoutHorizonLabel(horizonSec: number): string {
  if (horizonSec % 3600 === 0) return `${horizonSec / 3600} h`;
  if (horizonSec % 60 === 0) return `${horizonSec / 60} m`;
  return `${horizonSec}s`;
}

/**
 *  Price lookup over the settlement marks the account is itself marked against: the first
 *  settlement at or after `t`, null once the series runs out.
 *
 *  Settlements are the venue's own cadence (hourly on Hideki), so a horizon measured against
 *  them is always fully elapsed and always an oracle mark. A candle close is neither: it sits
 *  a variable distance past the horizon and comes from a different price basis than the PnL
 *  the markout is describing.
 */
export function settlementPriceAt(bars: readonly Bar[]): (t: number) => bigint | null {
  return (t: number): bigint | null => {
    let lo = 0;
    let hi = bars.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid]!.t >= t) {
        best = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return best === -1 ? null : bars[best]!.mark;
  };
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
