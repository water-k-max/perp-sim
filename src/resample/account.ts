/**
 *  Resample a real account: the realized closes the indexer recorded for a public address
 *  become the trade list, so the Monte Carlo describes that trader's own outcomes.
 *
 *  Only closing fills carry a realized PnL; opens are skipped. PnL here is the chain's own
 *  gross realized figure (before fees and funding), and the result says so.
 */
import type { ReconcileReport } from "../verify/replay-account.js";
import type { FillReadCoverage } from "../verify/fill-coverage.js";
import { simulatePaths, type SizingMode } from "./path.js";
import { summarizePaths } from "./stats.js";
import { distributionBlock, type DistributionBlock } from "./analysis.js";
import { sha256 } from "../data/store.js";
import { tempoOf, type Tempo } from "../verify/tempo.js";

export type AccountResampleOptions = {
  paths: number;
  seed: string;
  start: bigint;
  quoteDecimals: number;
  /** The quote unit every amount on this result is denominated in; the panel labels totals with it. */
  quoteSymbol: string;
  sizing?: SizingMode;
};

/**
 *  The fields `resampleAccount` actually reads. A single-market `ReconcileReport` satisfies it, and
 *  so does the cross-market aggregate — which has no single pool's fee block to carry, so it is
 *  built from exactly these fields rather than a synthetic report with invented fee rates.
 */
export type AccountReplayInput = Pick<
  ReconcileReport,
  "account" | "market" | "fromSec" | "toSec" | "rows" | "coverage" | "warnings" | "mismatches" | "unmatched" | "ok" | "fills" | "changes"
>;

export type AccountResample = {
  account: string;
  market: string;
  quoteSymbol: string;
  closedTrades: number;
  openingFills: number;
  winRateBps: number;
  realizedTotal: string;
  /**
   *  Descriptive cadence of the closes: how often this trader realized a position over the window.
   *  Inter-close tempo, not holding time — the fill read does not match opens to closes.
   */
  tempo: Tempo;
  /**
   *  What the fill read actually covered. The distributions describe these fills, so a
   *  truncated read has to be visible next to them rather than only inside the warnings.
   */
  coverage: FillReadCoverage;
  distributions: DistributionBlock[];
  warnings: string[];
  /**
   *  Reconcile integrity: how many fills disagreed with the chain, how many had no chain
   *  counterpart, and whether the read was fully consistent. The wallet panel shows these
   *  beside the total so a number built on a partial or mismatched read cannot sit alone.
   */
  mismatches: number;
  unmatched: number;
  reconcileOk: boolean;
  fillsRead: number;
  changesReconciled: number;
};

export function accountTrades(report: AccountReplayInput): { pnl: bigint }[] {
  return report.rows.filter((r) => r.actual.closedSize > 0n).map((r) => ({ pnl: r.actual.realizedPnl }));
}

export async function resampleAccount(report: AccountReplayInput, opts: AccountResampleOptions): Promise<AccountResample> {
  const trades = accountTrades(report);
  const closingTimes = report.rows.filter((r) => r.actual.closedSize > 0n).map((r) => r.t);
  const tempo = tempoOf(closingTimes, report.fromSec, report.toSec);
  const scale = 10n ** BigInt(opts.quoteDecimals);
  const seed = opts.seed === "" ? sha256(`account-resample/${report.account.toLowerCase()}/${report.market}/${report.fromSec}/${report.toSec}`) : opts.seed;
  const warnings = [
    "PnL is the chain's gross realized figure per closing fill: fees and funding are not deducted.",
    "Distributions describe trade-order risk on this account's past closes; they are not a forecast.",
    ...report.warnings,
  ];
  if (trades.length < 30) warnings.push(`Only ${trades.length} closed trades: percentiles over so few observations are wide and unstable.`);
  const wins = trades.filter((t) => t.pnl > 0n).length;
  const distributions: DistributionBlock[] = [];
  if (trades.length > 0) {
    for (const mode of ["shuffle_without_replacement", "bootstrap_with_replacement", "block_bootstrap_with_replacement"] as const) {
      const paths = await simulatePaths({
        trades, mode, sizing: opts.sizing ?? "static", paths: opts.paths, horizon: trades.length, start: opts.start, seed,
      });
      distributions.push(distributionBlock(mode, summarizePaths(paths, scale), opts.quoteDecimals));
    }
  }
  const total = trades.reduce((s, t) => s + t.pnl, 0n);
  const neg = total < 0n;
  const abs = neg ? -total : total;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(opts.quoteDecimals, "0");
  return {
    account: report.account, market: report.market, quoteSymbol: opts.quoteSymbol, closedTrades: trades.length,
    openingFills: report.rows.length - trades.length,
    winRateBps: trades.length === 0 ? 0 : Math.round((wins * 10_000) / trades.length),
    realizedTotal: `${neg ? "-" : ""}${whole}.${frac}`,
    tempo,
    coverage: report.coverage,
    distributions, warnings,
    mismatches: report.mismatches,
    unmatched: report.unmatched,
    reconcileOk: report.ok,
    fillsRead: report.fills,
    changesReconciled: report.changes,
  };
}
