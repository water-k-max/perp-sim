/**
 *  Backtest-optimism audit (spec §5): where the run's own assumptions are kinder than live.
 *
 *  Header figure: the same-bar trade share — trades decided inside one settlement
 *  interval, priced by the bar's path assumption rather than observed data. Above the
 *  dismissal threshold the strategy is labelled *not reliably backtestable*.
 *
 *  The "gone the other way" re-run moves every same-bar trade that provably went against
 *  the position to the worst price that position observed (keeping funding, fees and gas
 *  exact) and re-runs the distribution, so the exported and re-priced curves render side
 *  by side. That is a bounded worst-case, not a claim about what happened.
 *
 *  The disclosure lines are honest by construction: the same-bar count is what can be
 *  counted, never a bound, and the unbounded case is stated in the spec's own words.
 */

import type { TradeRecord, TradeList } from "./inputs.js";
import type { PathTrade, SizingMode } from "./path.js";
import { simulatePaths } from "./path.js";
import type { PathSummary } from "./stats.js";
import { summarizePaths } from "./stats.js";

export const DEFAULT_DISMISSAL_THRESHOLD_BPS = 5_000;

export type RunAssumptions = {
  fillModel: "tape" | "settlement-mark";
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
  /** True when the same-bar share reaches the threshold: not reliably backtestable. */
  dismissed: boolean;
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

export function auditTradeList(list: TradeList, config: RunAssumptions, opts: AuditOptions): AuditResult {
  const threshold = opts.dismissalThresholdBps ?? DEFAULT_DISMISSAL_THRESHOLD_BPS;
  const shareBps = sameBarShareBps(list);
  const dismissed = shareBps >= threshold && list.trades.length > 0;

  const base = {
    mode: "shuffle_without_replacement" as const,
    sizing: opts.sizing,
    paths: opts.paths,
    horizon: opts.horizon,
    start: opts.start,
    seed: opts.seed,
  };
  const empty = list.trades.length === 0;
  const exported = empty ? [] : simulatePaths({ trades: list.trades.map((t) => ({ pnl: t.pnl })), ...base });
  const { trades: repricedTrades, repriced } = repriceSameBarAdverse(list.trades, opts.oneBase);
  const repricedPaths = empty ? [] : simulatePaths({ trades: repricedTrades, ...base });
  const exportedSummary = empty ? null : summarizePaths(exported, opts.quoteScale);
  const repricedSummary = empty ? null : summarizePaths(repricedPaths, opts.quoteScale);
  const deltaBps =
    exportedSummary === null || repricedSummary === null || exportedSummary.medianFinalEquity === 0
      ? 0
      : ((repricedSummary.medianFinalEquity - exportedSummary.medianFinalEquity) * 10_000) /
        Math.abs(exportedSummary.medianFinalEquity);

  const notes: string[] = [
    "The same-bar count is what can be counted, not a bound: a longer trade whose final bar holds both stop and target has the same problem and is undetectable from the trade list.",
  ];
  if (list.trades.some((t) => t.sameBar && t.excursionSource !== "none")) {
    notes.push("For same-bar trades the excursion is observed (candle path or tape prints), so the re-priced curve is a bounded worst-case for those trades, not a claim about what happened.");
  }
  if (list.withoutExcursionCount > 0) {
    notes.push(`${list.withoutExcursionCount} trade(s) carry no excursion data and cannot be re-priced; they are counted, not adjusted.`);
  }

  return {
    sameBarCount: list.sameBarCount,
    tradeCount: list.trades.length,
    sameBarShareBps: shareBps,
    withoutExcursionCount: list.withoutExcursionCount,
    dismissalThresholdBps: threshold,
    dismissed,
    repricedCount: repriced,
    repricedFinalEquities: repricedSummary?.finalEquities ?? [],
    repricedMedianDeltaBps: deltaBps,
    exportedSummary,
    repricedSummary,
    notes,
  };
}
