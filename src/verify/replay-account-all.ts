/**
 *  Cross-market wallet replay: reconcile an account on every perp market the venue lists, then
 *  aggregate the per-market reports into one portfolio trade sequence and a per-market breakdown.
 *
 *  Each market is reconciled by the same `reconcileAccount` the single-market route uses — byte for
 *  byte, with its own paginated fill read, its own ground-truth diff and its own coverage block —
 *  so a per-market number here means exactly what it means on the single-market path. What this
 *  module adds is the fan-out, the quote-unit guard, and the summation. It reads only public indexer
 *  and chain state: no signer, no write.
 *
 *  Why aggregate at all: an account's profit can sit entirely in markets a single-market view never
 *  opens. Measured on Hideki 2026-11-13, address 0x8b6e…94f8 lost 4,343 USDso on BTC over the window
 *  while making 20,868 across all thirteen markets it traded — the BTC-only view inverted the sign
 *  of the account's result. The breakdown keeps every market's contribution visible beside the total.
 */
import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { onceLive } from "../data/live-cache.js";
import { listPerps, resolveConfig, type MarketConfig } from "../history/market.js";
import type { AccountReplayInput } from "../resample/account.js";
import type { FillReadCoverage } from "./fill-coverage.js";
import { reconcileAccount, type ReconcileReport, type RowReconcile } from "./replay-account.js";

export type MarketBreakdown = {
  market: string;
  pool: string;
  fills: number;
  closedTrades: number;
  openingFills: number;
  winRateBps: number;
  /** Gross realized PnL summed over this market's closing fills, formatted in the shared quote unit. */
  realizedTotal: string;
  mismatches: number;
  unmatched: number;
  ok: boolean;
  coverage: FillReadCoverage;
};

export type PortfolioReplay = {
  account: string;
  fromSec: number;
  toSec: number;
  quoteSymbol: string;
  quoteDecimals: number;
  /** Perp markets the venue lists. */
  marketsRead: number;
  /** Markets with at least one fill in the window — the breakdown rows. */
  marketsWithFills: number;
  /** The aggregate the resampler consumes: one chronological trade sequence across markets. */
  input: AccountReplayInput;
  /** Per-market contributions, largest gross realized total first. */
  markets: MarketBreakdown[];
  /** The full per-market reports, for forensics; the resample route does not return these. */
  reports: ReconcileReport[];
};

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** A raw quote amount as a plain decimal string, the same shape `resampleAccount` emits. */
function decimal(value: bigint, quoteDecimals: number): string {
  const scale = 10n ** BigInt(quoteDecimals);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(quoteDecimals, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

const closingRows = (report: ReconcileReport): RowReconcile[] => report.rows.filter((r) => r.actual.closedSize > 0n);
const closesTotal = (report: ReconcileReport): bigint => closingRows(report).reduce((s, r) => s + r.actual.realizedPnl, 0n);

export type MarketReport = { cfg: MarketConfig; report: ReconcileReport };

/**
 *  Pure aggregation: combine the per-market verified reports into one portfolio trade sequence and
 *  a per-market breakdown. Split from the fan-out so the summation, the quote-unit guard, the
 *  coverage combination and the ranking can be tested against fixtures without a chain read.
 */
export function combineMarketReports(options: {
  account: string;
  fromSec: number;
  toSec: number;
  /** Perp markets the venue lists, including ones the account never traded. */
  listedCount: number;
  /** One verified report per listed market, in list order. */
  results: MarketReport[];
}): PortfolioReplay {
  const { account, fromSec, toSec, listedCount, results } = options;
  if (results.length === 0) throw new Error("no market reports to combine");
  const who = account.toLowerCase();
  const active = results.filter((r) => r.report.fills > 0);
  // Aggregation sums raw realized PnL across markets, which is only meaningful in one quote unit.
  // Guard the markets that actually contribute; a venue that lists a differently-quoted market the
  // account never traded must not block the read, but one it did trade must refuse rather than mix units.
  const quoteCfg = (active[0] ?? results[0])!.cfg;
  for (const r of active) {
    if (r.cfg.quoteDecimals !== quoteCfg.quoteDecimals || r.cfg.quoteSymbol !== quoteCfg.quoteSymbol) {
      throw new Error(
        `markets quote in different units (${quoteCfg.quoteSymbol}/${quoteCfg.quoteDecimals} vs ${r.cfg.quoteSymbol}/${r.cfg.quoteDecimals}); cross-market aggregation needs one quote unit`,
      );
    }
  }

  const rows = active.flatMap((r) => r.report.rows).sort((a, b) => a.t - b.t);
  const covs = active.map((r) => r.report.coverage);
  const firsts = covs.map((c) => c.firstFillSec).filter((x): x is number => x !== null);
  const lasts = covs.map((c) => c.lastFillSec).filter((x): x is number => x !== null);
  const coverage: FillReadCoverage = {
    firstFillSec: firsts.length > 0 ? Math.min(...firsts) : null,
    lastFillSec: lasts.length > 0 ? Math.max(...lasts) : null,
    rowsScanned: sum(covs.map((c) => c.rowsScanned)),
    rowsInWindow: sum(covs.map((c) => c.rowsInWindow)),
    rowsKept: sum(covs.map((c) => c.rowsKept)),
    pages: sum(covs.map((c) => c.pages)),
    truncated: covs.some((c) => c.truncated),
    stoppedBy: covs.some((c) => c.stoppedBy === "maxFills") ? "maxFills" : covs.some((c) => c.stoppedBy === "page-bound") ? "page-bound" : null,
    // A complete read's population is its own rowsInWindow (the cursor ran out); a truncated read's
    // is the indexer count when it was obtained. Sum the best-known per-market population, and flag
    // it as a lower bound when any market reached the count ceiling.
    accountFillsInWindow: covs.every((c) => c.accountFillsInWindow === null) ? null : sum(covs.map((c) => c.accountFillsInWindow ?? c.rowsInWindow)),
    accountFillsAtCeiling: covs.some((c) => c.accountFillsAtCeiling),
  };

  const warnings: string[] = [];
  for (const r of active) for (const w of r.report.warnings) warnings.push(`[${r.report.market}] ${w}`);
  const truncatedMarkets = active.filter((r) => r.report.coverage.truncated);
  if (truncatedMarkets.length > 0) {
    warnings.push(
      `${truncatedMarkets.length} of ${active.length} market reads stopped early (${truncatedMarkets.map((r) => r.report.market).join(", ")}); their per-market coverage blocks say which fills are missing, so these totals describe the slice that was read.`,
    );
  }
  warnings.push(
    `Aggregated across ${active.length} market(s) with fills in the window; ${listedCount - active.length} listed market(s) had none. Totals sum each market's gross realized PnL in ${quoteCfg.quoteSymbol}.`,
  );

  const input: AccountReplayInput = {
    account: who,
    market: "ALL",
    fromSec,
    toSec,
    rows,
    coverage,
    warnings,
    mismatches: sum(active.map((r) => r.report.mismatches)),
    unmatched: sum(active.map((r) => r.report.unmatched)),
    ok: active.every((r) => r.report.ok),
    fills: sum(active.map((r) => r.report.fills)),
    changes: sum(active.map((r) => r.report.changes)),
  };

  const ranked = active.map((r) => ({ r, total: closesTotal(r.report) })).sort((a, b) => (a.total > b.total ? -1 : a.total < b.total ? 1 : 0));
  const markets: MarketBreakdown[] = ranked.map(({ r, total }) => {
    const closes = closingRows(r.report);
    const wins = closes.filter((x) => x.actual.realizedPnl > 0n).length;
    return {
      market: r.report.market,
      pool: r.report.pool,
      fills: r.report.fills,
      closedTrades: closes.length,
      openingFills: r.report.rows.length - closes.length,
      winRateBps: closes.length === 0 ? 0 : Math.round((wins * 10_000) / closes.length),
      realizedTotal: decimal(total, r.cfg.quoteDecimals),
      mismatches: r.report.mismatches,
      unmatched: r.report.unmatched,
      ok: r.report.ok,
      coverage: r.report.coverage,
    };
  });

  return {
    account: who,
    fromSec,
    toSec,
    quoteSymbol: quoteCfg.quoteSymbol,
    quoteDecimals: quoteCfg.quoteDecimals,
    marketsRead: listedCount,
    marketsWithFills: active.length,
    input,
    markets,
    reports: active.map((r) => r.report),
  };
}

export async function replayAccountAllMarkets(options: {
  client: SomniaMarketsClient;
  account: string;
  fromSec: number;
  toSec: number;
  /** Per-market fill cap, the same default `reconcileAccount` applies to a single market. */
  maxFills?: number;
  /** Markets reconciled at once. Bounded to stay polite to a shared indexer endpoint. */
  concurrency?: number;
}): Promise<PortfolioReplay> {
  const { client, account, fromSec, toSec } = options;
  const who = account.toLowerCase();
  const listed = await onceLive("perp-markets", () => listPerps(client));
  if (listed.length === 0) throw new Error("the venue lists no perp markets to aggregate");

  const results: MarketReport[] = new Array(listed.length);
  const errors: unknown[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= listed.length) return;
      try {
        const market = listed[i]!;
        const cfg = await onceLive(`perp-config:${market.poolAddress}`, () => resolveConfig(client, market));
        results[i] = { cfg, report: await reconcileAccount({ client, cfg, account: who, fromSec, toSec, maxFills: options.maxFills }) };
      } catch (error) {
        // Drain every worker before surfacing a failure, so a rejected read does not leave sibling
        // workers running as unhandled rejections. The first error is the one the caller sees.
        errors.push(error);
      }
    }
  }
  const lanes = Math.max(1, Math.min(options.concurrency ?? 4, listed.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  if (errors.length > 0) throw errors[0];

  return combineMarketReports({ account, fromSec, toSec, listedCount: listed.length, results });
}