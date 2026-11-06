/**
 *  The random-entry null: the closest thing to an edge test this trade-order view can give.
 *
 *  Each null path walks the recorded trades in order and, for every one, enters at a
 *  uniformly random settlement bar, holds exactly that trade's holding time, and closes at
 *  the settlement mark — same sides, same sizes, same holding times, no information. The
 *  trade's net is priced by the engine's own close arithmetic (floored gross PnL, the
 *  protocol kernel's settled funding, one taker fee on the closing leg), so a null trade
 *  and a recorded trade are the same object priced the same way; the kernel-equivalence
 *  canary pins that equality against a real PositionBook round trip.
 *
 *  The p-value is the share of null totals at or above the recorded total, with the add-one
 *  correction so it can never report an impossible zero. It is one-sided: a small p-value
 *  says entries beat random timing on this history — evidence worth investigating, not
 *  proof of skill.
 */

import { perpPositionAnalytics } from "@somnia-chain/markets-sdk";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { fillFee } from "../engine/portfolio.js";
import { fromRaw } from "../units.js";
import { deriveEdgeStream, nextIndex } from "./rng.js";
import { quantileBig } from "./stats.js";
import type { TradeList, TradeRecord } from "./inputs.js";

/** Null paths per test. Fixed: the p-value is a share, so more paths only smooth it. */
export const EDGE_PATHS = 300;

export type EdgeInputs = {
  /** The effective analysis seed; the null derives its own streams from it. */
  seed: string;
  list: TradeList;
  bars: readonly Bar[];
  cfg: MarketConfig;
  quoteScale: bigint;
};

export type EdgeBlock = {
  paths: number;
  /** Sum of recorded net PnL, decimal quote — the total the null is compared against. */
  realizedTotal: string;
  /** Null total percentiles and mean, decimal quote. */
  nullP05: string;
  nullMedian: string;
  nullP95: string;
  nullMean: string;
  /** Share of null totals at or above the recorded total, add-one corrected, in [0, 1]. */
  pValue: string;
  /** Trades no null path could place because the history is shorter than the holding time. */
  skippedTrades: number;
  notes: string[];
};

export type NullTrade = {
  entryIdx: number;
  exitIdx: number;
  /** floored gross price PnL, exactly as the engine's close realizes it */
  gross: bigint;
  /** settled funding over the hold, as a cost, from the protocol kernel */
  funding: bigint;
  /** taker fee on the closing leg's notional */
  fee: bigint;
  net: bigint;
};

/**
 *  One null trade: enter at `entryIdx`'s settlement mark, hold `holding` bars, close at the
 *  settlement mark. Costs follow the recorded-trade convention — one taker fee on the
 *  closing leg plus settled funding; the entry leg's fee is excluded on both sides, gas on
 *  both sides.
 */
export function nullTradeNet(bars: readonly Bar[], entryIdx: number, holding: number, trade: TradeRecord, cfg: MarketConfig): NullTrade {
  if (holding < 0 || entryIdx < 0 || entryIdx + holding > bars.length - 1) throw new Error("null trade out of the bar range");
  const exitIdx = entryIdx + holding;
  const signed = trade.direction === "long" ? trade.size : -trade.size;
  const entry = bars[entryIdx]!.mark;
  const exit = bars[exitIdx]!.mark;
  const gross = divFloor((exit - entry) * signed, cfg.oneBase);
  const funding = perpPositionAnalytics({
    size: signed,
    avgEntryPrice: entry,
    entryFundingIndex: bars[entryIdx]!.cum,
    markPrice: exit,
    projectedCumulativeFunding: bars[exitIdx]!.cum,
    oneBase: cfg.oneBase,
    effectiveImfBps: cfg.effectiveImfBps,
    maintenanceMarginBps: cfg.mmBps,
    closeOutMarginBps: cfg.closeOutBps,
  }).accruedFunding;
  const fee = fillFee(cfg, "taker", (trade.size * exit) / cfg.oneBase);
  return { entryIdx, exitIdx, gross, funding, fee, net: gross - funding - fee };
}

/** The full null test, or null when there is nothing to test (no trades, no history). */
export function runEdgeTest(inputs: EdgeInputs): EdgeBlock | null {
  const { list, bars, cfg, quoteScale } = inputs;
  if (list.trades.length === 0 || bars.length === 0) return null;
  const realizedTotal = list.trades.reduce((sum, t) => sum + t.pnl, 0n);

  const totals: bigint[] = [];
  let skipped = 0;
  for (let p = 0; p < EDGE_PATHS; p += 1) {
    const rng = deriveEdgeStream(inputs.seed, p);
    let total = 0n;
    for (const trade of list.trades) {
      const holding = trade.barsHeld;
      if (holding > bars.length - 1) {
        skipped += 1;
        continue;
      }
      // Uniform entry over every bar that still leaves room for the full hold.
      const entryIdx = nextIndex(rng, bars.length - holding);
      total += nullTradeNet(bars, entryIdx, holding, trade, cfg).net;
    }
    totals.push(total);
  }

  const sorted = [...totals].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const atOrAbove = totals.reduce((count, t) => (t >= realizedTotal ? count + 1 : count), 0);
  const pValue = (atOrAbove + 1) / (EDGE_PATHS + 1);
  const mean = sorted.reduce((sum, t) => sum + Number(t) / Number(quoteScale), 0) / sorted.length;

  const notes = [
    "Null trades enter at a uniformly random settlement mark and close at the settlement mark their recorded holding time later; costs are the engine's closing-leg taker fee and settled funding, the same per-trade convention as recorded PnL. Entry-leg fees and gas are excluded on both sides.",
    "The p-value is the share of null totals at or above the recorded total, add-one corrected. It is one-sided: small means entries beat random timing on this history, which is a reason to look closer, not proof of skill.",
  ];
  if (skipped > 0) notes.push(`${skipped} null trade(s) could not be placed: the market history is shorter than the holding time, so they contribute nothing to the null totals.`);

  return {
    paths: EDGE_PATHS,
    realizedTotal: fromRaw(realizedTotal, cfg.quoteDecimals),
    nullP05: f6(quantileBig(sorted, 0.05, quoteScale)),
    nullMedian: f6(quantileBig(sorted, 0.5, quoteScale)),
    nullP95: f6(quantileBig(sorted, 0.95, quoteScale)),
    nullMean: f6(mean),
    pValue: pValue.toFixed(4),
    skippedTrades: skipped,
    notes,
  };
}

/** Division rounding down — the engine's close arithmetic, pinned by the kernel-equivalence canary. */
function divFloor(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divisor must be positive");
  const q = n / d;
  return n < 0n && q * d !== n ? q - 1n : q;
}

/** The same decimal edge step the analysis document uses: six places, trailing zeroes trimmed. */
function f6(value: number): string {
  return Number(value.toFixed(6)).toString();
}
