/**
 *  Fill check: how much the run's results lean on fills that were assumed rather than observed.
 *
 *  Settlement-mark runs price every fill at a mark nobody traded at. A trade that opens and
 *  closes inside one settlement bar is then priced by an assumed path, so a high same-bar
 *  share flags the strategy as too dependent on that assumption, and a stress re-run moves
 *  each such trade that went against the position to the worst price it observed.
 *
 *  Tape runs are different: every fill is a recorded print, so a short hold is real data.
 *  The share is still reported as holding-time context, but no verdict is applied and
 *  nothing is re-priced.
 */

import type { TradeRecord, TradeList } from "./inputs.js";
import type { PathTrade, SizingMode } from "./path.js";
import { simulatePaths } from "./path.js";
import type { PathSummary } from "./stats.js";
import { summarizePaths } from "./stats.js";

export const DEFAULT_DISMISSAL_THRESHOLD_BPS = 5_000;

export type RunAssumptions = {
  fillModel: "tape" | "settlement-mark" | "imported";
  profile: string | null;
  latencySec: number;
  gasPerTx: string;
  intrabar: boolean;
};

export type AuditOptions = {
  dismissalThresholdBps?: number;
  paths: number;
  horizon: number;
  sizing: SizingMode;
  start: bigint;
  seed: string | number | bigint;
  quoteScale: bigint;
  oneBase: bigint;
};

export type AuditResult = {
  sameBarCount: number;
  tradeCount: number;
  sameBarShareBps: number;
  withoutExcursionCount: number;
  dismissalThresholdBps: number;
  /** True when assumed fills are in play and the same-bar share reaches the threshold. */
  dismissed: boolean;
  /** "observed" when fills are recorded tape prints; "assumed" when priced at a settlement mark. */
  fillBasis: "observed" | "assumed";
  /** Same-bar trades that provably went against the position and were re-priced. */
  repricedCount: number;
  repricedFinalEquities: bigint[];
  repricedMedianDeltaBps: number;
  /** Null when the trade list is empty: there is no distribution to re-run. */
  exportedSummary: PathSummary | null;
  repricedSummary: PathSummary | null;
  notes: string[];
};

/** Assumption lines, one per quiet flatterer in the run config, each with its live consequence. */
export function assumptionLines(config: RunAssumptions): string[] {
  if (config.fillModel === "imported") {
    return ["The trade list was imported: each PnL is taken as recorded, net of the importer's own fees and funding, and no fill model of ours prices any fill."];
  }
  const lines: string[] = [];
  if (config.fillModel === "tape" && config.profile === "optimistic") {
    lines.push("Fill profile is optimistic (5 s window, 100% of recorded volume): live fills would arrive later and take a smaller share of the tape than every modelled fill assumes.");
  } else if (config.fillModel === "tape") {
    lines.push(`Fill profile is ${config.profile}: fills are matched against the pool's recorded tape inside a window, not against a live book that reacts to the order.`);
  }
  if (config.fillModel === "settlement-mark") {
    lines.push("Fill model is settlement-mark: every fill is priced at the next settlement mark, a price nobody actually traded at; a live taker fill pays the book.");
  }
  if (config.latencySec === 0) lines.push("Decision latency is 0 s: orders reach the market instantly; on-chain inclusion takes blocks, and the price can move inside that gap.");
  if (Number(config.gasPerTx) === 0) lines.push("Gas per order is 0: native gas (STT) for each transaction is ignored; live trading pays it on every fill.");
  if (!config.intrabar) lines.push("Intrabar marking is off: equity is only marked at settlements, so nothing between marks can breach margin in this replay.");
  return lines;
}

export function sameBarShareBps(list: TradeList): number {
  if (list.trades.length === 0) return 0;
  return (list.sameBarCount * 10_000) / list.trades.length;
}

/**
 *  Re-price every same-bar trade that provably went against the position to the worst
 *  price it observed; everything else is untouched. Funding, fees and gas are kept exact,
 *  so only the price component of PnL moves.
 */
export function repriceSameBarAdverse(trades: readonly TradeRecord[], oneBase: bigint): {
  trades: PathTrade[];
  repriced: number;
} {
  const out: PathTrade[] = [];
  let repriced = 0;
  for (const trade of trades) {
    if (trade.sameBar && trade.mae !== null && trade.mae < 0n && trade.worstPrice !== null) {
      repriced += 1;
      const gross =
        trade.direction === "long"
          ? ((trade.worstPrice - trade.entryPrice) * trade.size) / oneBase
          : ((trade.entryPrice - trade.worstPrice) * trade.size) / oneBase;
      out.push({ pnl: gross - trade.funding - trade.fee - trade.gas });
    } else {
      out.push({ pnl: trade.pnl });
    }
  }
  return { trades: out, repriced };
}

export async function auditTradeList(list: TradeList, config: RunAssumptions, opts: AuditOptions): Promise<AuditResult> {
  const threshold = opts.dismissalThresholdBps ?? DEFAULT_DISMISSAL_THRESHOLD_BPS;
  const shareBps = sameBarShareBps(list);
  const observed = config.fillModel !== "settlement-mark";
  const dismissed = !observed && shareBps >= threshold && list.trades.length > 0;

  const base = {
    mode: "shuffle_without_replacement" as const,
    sizing: opts.sizing,
    paths: opts.paths,
    horizon: opts.horizon,
    start: opts.start,
    seed: opts.seed,
  };
  const empty = list.trades.length === 0;
  const exported = empty ? [] : await simulatePaths({ trades: list.trades.map((t) => ({ pnl: t.pnl })), ...base });
  const skipReprice = empty || observed;
  const { trades: repricedTrades, repriced } = skipReprice ? { trades: [], repriced: 0 } : repriceSameBarAdverse(list.trades, opts.oneBase);
  const repricedPaths = skipReprice ? [] : await simulatePaths({ trades: repricedTrades, ...base });
  const exportedSummary = empty ? null : summarizePaths(exported, opts.quoteScale);
  const repricedSummary = skipReprice ? null : summarizePaths(repricedPaths, opts.quoteScale);
  const deltaBps =
    exportedSummary === null || repricedSummary === null || exportedSummary.medianFinalEquity === 0
      ? 0
      : ((repricedSummary.medianFinalEquity - exportedSummary.medianFinalEquity) * 10_000) /
        Math.abs(exportedSummary.medianFinalEquity);

  const notes: string[] = config.fillModel === "imported"
    ? ["The trade list was imported: the same-bar share says how finely the market history available here can resolve each holding window, not a verdict on the importer's fills. Nothing is re-priced."]
    : observed
      ? ["Fills are recorded tape prints, so a short hold is priced on observed trades, not an assumed path. The same-bar share is holding-time context only: no verdict is applied and nothing is re-priced."]
      : ["The same-bar count is what can be counted, not a bound: a longer trade whose final bar holds both stop and target has the same problem and cannot be seen here."];
  if (config.fillModel === "imported" && list.withoutExcursionCount > 0) {
    notes.push(`${list.withoutExcursionCount} trade(s) carry no excursion data: no market history here covers their holding window.`);
  }
  if (!observed && list.trades.some((t) => t.sameBar && t.excursionSource !== "none")) {
    notes.push("For same-bar trades the excursion is observed (candle path or tape prints), so the re-priced curve is a bounded worst-case for those trades, not a claim about what happened.");
  }
  if (!observed && list.withoutExcursionCount > 0) {
    notes.push(`${list.withoutExcursionCount} trade(s) carry no excursion data and cannot be re-priced; they are counted, not adjusted.`);
  }

  return {
    sameBarCount: list.sameBarCount,
    tradeCount: list.trades.length,
    sameBarShareBps: shareBps,
    withoutExcursionCount: list.withoutExcursionCount,
    dismissalThresholdBps: threshold,
    dismissed,
    fillBasis: observed ? "observed" : "assumed",
    repricedCount: repriced,
    repricedFinalEquities: repricedSummary?.finalEquities ?? [],
    repricedMedianDeltaBps: deltaBps,
    exportedSummary,
    repricedSummary,
    notes,
  };
}
