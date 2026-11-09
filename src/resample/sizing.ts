/**
 *  Sizing module design doc: how many base units, for the loss you would accept.
 *
 *  For each candidate size — a multiple of the market's lot grid — every resampled path is
 *  re-walked with each trade's PnL scaled to that size (`pnl * size / tradeSize`, floored),
 *  and the row reports the share of paths whose worst point from start is at least the
 *  accepted loss, plus the median and p05 outcome at that size. Rows past even-money odds
 *  are dropped: the first size whose loss probability exceeds 1/2 ends the table, since
 *  every larger size is worse by construction (one seed drives the same drawn orders for
 *  every size, so loss events nest exactly). A leverage sanity note compares each row's
 *  notional leverage against what the market's initial-margin factor would permit.
 *
 *  The odds describe resampled paths, not the future — the UI carries that line.
 */

import type { TradeRecord } from "./inputs.js";
import { simulatePaths, type PathTrade, type SizingMode } from "./path.js";
import { quantileNum } from "./stats.js";
import type { ResampleMode } from "./sample.js";

export const SIZING_LADDER_STEPS = [1n, 2n, 4n, 8n, 16n, 32n, 64n] as const;

export type SizingRow = {
  /** Candidate size, raw base units, aligned to the lot grid. */
  sizeBase: bigint;
  /** Share of paths whose worst point from start reaches the accepted loss, in [0, 1]. */
  lossProbability: number;
  /** Median and p05 path outcome (final minus start), decimal quote units. */
  medianPnl: number;
  p05Pnl: number;
};

export type SizingOptions = {
  trades: readonly TradeTrade[];
  seed: string | number | bigint;
  paths: number;
  /** Path length in trades for the loss check (their "first hundred"). */
  horizonTrades: number;
  /** The maximum loss the user accepts, in quote units. */
  acceptedLossQuote: bigint;
  start: bigint;
  mode: ResampleMode;
  sizing: SizingMode;
  lotSize: bigint;
  maxSize: bigint;
  /** A reference price for the leverage note (the run's last mark). */
  markPrice: bigint;
  oneBase: bigint;
  /** The market's effective initial-margin factor, basis points. */
  effectiveImfBps: bigint;
  quoteScale: bigint;
};

export type SizingResult = {
  acceptedLoss: number;
  horizonTrades: number;
  rows: SizingRow[];
  /** Leverage sanity note, null when no row exceeds the IMF-implied bound. */
  note: string | null;
};

type TradeTrade = Pick<TradeRecord, "pnl" | "size">;

/** The candidate ladder: lot multiples, the run's own size, capped by the position limit. */
export function sizeLadder(lotSize: bigint, maxSize: bigint, include: readonly bigint[]): bigint[] {
  const ladder = new Set<bigint>();
  for (const step of SIZING_LADDER_STEPS) {
    const size = step * lotSize;
    if (size <= maxSize) ladder.add(size);
  }
  for (const size of include) {
    if (size > 0n && size <= maxSize) ladder.add(size);
  }
  return [...ladder].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function dec(value: bigint, quoteScale: bigint): number {
  return Number(value) / Number(quoteScale);
}

export async function simulateSizing(opts: SizingOptions): Promise<SizingResult> {
  if (opts.acceptedLossQuote <= 0n) throw new Error("accepted loss must be positive");
  if (!Number.isInteger(opts.horizonTrades) || opts.horizonTrades < 1) throw new Error("horizonTrades must be a positive integer");
  if (opts.trades.length === 0) throw new Error("cannot size an empty trade list");
  const ladder = sizeLadder(opts.lotSize, opts.maxSize, opts.trades.map((t) => t.size));
  const scale = opts.quoteScale;

  const rows: SizingRow[] = [];
  let note: string | null = null;
  const maxLeverageX100 = opts.effectiveImfBps > 0n ? Number(10_000n * 100n / opts.effectiveImfBps) : null;
  const breaches: string[] = [];

  for (const size of ladder) {
    const scaled: PathTrade[] = opts.trades.map((t) => ({ pnl: (t.pnl * size) / t.size }));
    const paths = await simulatePaths({
      trades: scaled,
      mode: opts.mode,
      sizing: opts.sizing,
      paths: opts.paths,
      horizon: opts.horizonTrades,
      start: opts.start,
      seed: opts.seed,
    });
    const steps = Math.min(opts.horizonTrades, paths[0]!.curve.length - 1);
    let losses = 0;
    const pnls: number[] = [];
    for (const path of paths) {
      let minEquity = path.curve[0]!;
      for (let s = 1; s <= steps; s += 1) if (path.curve[s]! < minEquity) minEquity = path.curve[s]!;
      if (opts.start - minEquity >= opts.acceptedLossQuote) losses += 1;
      pnls.push(dec(path.finalEquity - opts.start, scale));
    }
    pnls.sort((a, b) => a - b);
    const lossProbability = losses / paths.length;
    // Rows past even-money odds are dropped: the first size worse than a coin flip ends
    // the table, because loss events nest exactly across the ladder.
    if (lossProbability > 0.5) break;
    rows.push({
      sizeBase: size,
      lossProbability,
      medianPnl: quantileNum(pnls, 0.5),
      p05Pnl: quantileNum(pnls, 0.05),
    });
    if (maxLeverageX100 !== null && opts.markPrice > 0n) {
      const leverageX100 = Number((size * opts.markPrice * 100n) / (opts.oneBase * opts.start));
      if (leverageX100 > maxLeverageX100) {
        breaches.push(
          `${formatBase(size, opts.oneBase)} base ≈ ${(leverageX100 / 100).toFixed(1)}x notional leverage, above the ${(maxLeverageX100 / 100).toFixed(1)}x the ${(Number(opts.effectiveImfBps) / 100).toFixed(0)}% initial-margin factor permits`,
        );
      }
    }
  }

  if (breaches.length > 0) {
    note = `Leverage sanity: ${breaches.join("; ")}. The exchange would require more margin than this replay assumes at those sizes.`;
  }

  return {
    acceptedLoss: dec(opts.acceptedLossQuote, scale),
    horizonTrades: opts.horizonTrades,
    rows,
    note,
  };
}

function formatBase(size: bigint, oneBase: bigint): string {
  const whole = size / oneBase;
  const frac = ((size % oneBase) * 100n) / oneBase;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, "0")}`;
}
