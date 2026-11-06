/**
 *  Trade-list extraction: a completed run's closed trades become the resampling engine's
 *  input records design doc.
 *
 *  Better data than an exporter's CSV: pnl is the engine's exact net PnL (bigint quote
 *  units), entry/exit times come from the run's own clock, and MAE/MFE are *observed* —
 *  computed from the tape prints inside the exact holding window, falling back to the
 *  hourly candle extremes of the settlement bars the position lived through (a coarser,
 *  more pessimistic bound) when the tape has no print in that window. The source used is recorded per trade, and a trade with no excursion
 *  data at all is counted in `withoutExcursionCount` instead of being silently dropped.
 *
 *  `barsHeld` counts settlement bars between the entry bar and the exit bar; zero means
 *  the entry and exit landed inside one settlement interval — the audit's same-bar case.
 */

import type { Bar } from "../history/bars.js";
import type { ClosedTrade } from "../engine/portfolio.js";
import type { TapeFill } from "../data/types.js";

export type ExcursionSource = "candles" | "tape" | "none";

export type TradeRecord = {
  entryTs: number;
  exitTs: number;
  /** Exact net PnL in quote units: gross - funding - fees - gas. */
  pnl: bigint;
  direction: "long" | "short";
  /** Settlement bars between entry and exit; 0 ⇒ same-bar trade. */
  barsHeld: number;
  sameBar: boolean;
  /** Observed max adverse / favourable excursion, as signed PnL in quote units (adverse negative). */
  mae: bigint | null;
  mfe: bigint | null;
  /** The worst / best price the position provably saw while open (re-pricing material). */
  worstPrice: bigint | null;
  bestPrice: bigint | null;
  excursionSource: ExcursionSource;
  size: bigint;
  entryPrice: bigint;
  exitPrice: bigint;
  /** Components of net PnL, kept so audit re-pricing stays exact. */
  funding: bigint;
  fee: bigint;
  gas: bigint;
  /** The closing execution's index in the run. */
  seq: number;
};

export type TradeList = {
  trades: TradeRecord[];
  sameBarCount: number;
  withoutExcursionCount: number;
  /** Trade window, unix seconds (null when the list is empty). */
  window: { from: number | null; to: number | null };
};

export type ExtractOptions = {
  bars: readonly Bar[];
  /** The pool's trade tape, for the excursion fallback. */
  tape?: readonly TapeFill[];
  /** Raw base units per whole base (10^baseDecimals). */
  oneBase: bigint;
};

/** Index of the settlement bar whose interval contains `ts`: bar i covers (t_{i-1}, t_i]. */
export function barIndexAt(bars: readonly Bar[], ts: number): number | null {
  if (bars.length === 0) return null;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function excursionFromCandles(
  bars: readonly Bar[],
  entryIdx: number,
  exitIdx: number,
  side: "long" | "short",
): { worst: bigint; best: bigint } | null {
  let worst: bigint | null = null;
  let best: bigint | null = null;
  for (let i = entryIdx; i <= exitIdx; i += 1) {
    const bar = bars[i]!;
    const adverse = side === "long" ? bar.low : bar.high;
    const favourable = side === "long" ? bar.high : bar.low;
    if (adverse !== null && (worst === null || (side === "long" ? adverse < worst : adverse > worst)))
      worst = adverse;
    if (favourable !== null && (best === null || (side === "long" ? favourable > best : favourable < best)))
      best = favourable;
  }
  return worst === null || best === null ? null : { worst, best };
}

function excursionFromTape(
  tape: readonly TapeFill[],
  entryTs: number,
  exitTs: number,
  side: "long" | "short",
): { worst: bigint; best: bigint } | null {
  let worst: bigint | null = null;
  let best: bigint | null = null;
  for (const print of tape) {
    if (print.t < entryTs || print.t > exitTs) continue;
    if (worst === null || (side === "long" ? print.price < worst : print.price > worst)) worst = print.price;
    if (best === null || (side === "long" ? print.price > best : print.price < best)) best = print.price;
  }
  return worst === null || best === null ? null : { worst, best };
}

export function extractTrades(trades: readonly ClosedTrade[], opts: ExtractOptions): TradeList {
  const { bars, oneBase } = opts;
  const tape = opts.tape ?? [];
  const out: TradeRecord[] = [];

  for (const trade of trades) {
    const side = trade.side;
    // heldSec is the age of the oldest consumed lot at close: its open time is the entry.
    const entryTs = trade.t - trade.heldSec;
    const exitTs = trade.t;
    const entryIdx = barIndexAt(bars, entryTs);
    const exitIdx = barIndexAt(bars, exitTs);
    const barsHeld = entryIdx === null || exitIdx === null ? 0 : exitIdx - entryIdx;

    // Tape prints inside [entryTs, exitTs] are the exact holding window; a settlement bar's
    // candle also spans time before entry and after exit, so it only overstates the adverse
    // move. Candles are the fallback when the tape holds no print in the window.
    let excursion: { worst: bigint; best: bigint } | null = null;
    let source: ExcursionSource = "none";
    if (tape.length > 0) {
      excursion = excursionFromTape(tape, entryTs, exitTs, side);
      source = excursion !== null ? "tape" : "none";
    }
    if (excursion === null && entryIdx !== null && exitIdx !== null) {
      excursion = excursionFromCandles(bars, entryIdx, exitIdx, side);
      source = excursion !== null ? "candles" : "none";
    }

    // Excursions as signed PnL at this trade's size; adverse is negative, as in the run's PnL.
    let mae: bigint | null = null;
    let mfe: bigint | null = null;
    if (excursion !== null) {
      const adversePnl = side === "long"
        ? ((trade.entryPrice - excursion.worst) * trade.size) / oneBase
        : ((excursion.worst - trade.entryPrice) * trade.size) / oneBase;
      const favourablePnl = side === "long"
        ? ((excursion.best - trade.entryPrice) * trade.size) / oneBase
        : ((trade.entryPrice - excursion.best) * trade.size) / oneBase;
      mae = adversePnl > 0n ? -adversePnl : 0n;
      mfe = favourablePnl > 0n ? favourablePnl : 0n;
    }

    out.push({
      entryTs,
      exitTs,
      pnl: trade.netPnl,
      direction: side,
      barsHeld,
      sameBar: barsHeld === 0,
      mae,
      mfe,
      worstPrice: excursion?.worst ?? null,
      bestPrice: excursion?.best ?? null,
      excursionSource: source,
      size: trade.size,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      funding: trade.funding,
      fee: trade.fee,
      gas: trade.gas,
      seq: trade.seq,
    });
  }

  return {
    trades: out,
    sameBarCount: out.filter((t) => t.sameBar).length,
    withoutExcursionCount: out.filter((t) => t.excursionSource === "none").length,
    window: out.length === 0 ? { from: null, to: null } : {
      from: Math.min(...out.map((t) => t.entryTs)),
      to: Math.max(...out.map((t) => t.exitTs)),
    },
  };
}
