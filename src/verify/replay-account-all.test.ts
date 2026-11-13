import assert from "node:assert/strict";
import { test } from "node:test";
import { combineMarketReports, type MarketReport } from "./replay-account-all.js";
import type { ReconcileReport, RowReconcile } from "./replay-account.js";
import type { MarketConfig } from "../history/market.js";
import type { FillReadCoverage } from "./fill-coverage.js";

/**
 *  The aggregation is tested as the pure combiner it is: fixture reports in, portfolio out, no
 *  chain read. The fan-out (`replayAccountAllMarkets`) only fetches one verified report per market
 *  and hands them here, so every summation, guard and ranking rule is exercised offline.
 */

const cfg = (symbol: string, over: Partial<MarketConfig> = {}): MarketConfig => ({
  symbol, quoteSymbol: "USDso", pool: `0x${symbol}`, marginBank: "0xbank", stopRegistry: null,
  baseDecimals: 18, quoteDecimals: 6, oneBase: 10n ** 18n, tickSize: 1n, lotSize: 1n, minQuantity: 1n,
  imBps: 1000n, mmBps: 500n, closeOutBps: 250n, effectiveImfBps: 1000n, maxPositionSize: 10n ** 30n,
  maxOpenInterest: 10n ** 30n, takerFeeBpsTimes1k: 0n, makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 3600, fundingIntervalSec: 3600, imBpsMismatch: false, ...over,
});

const row = (t: number, closed: bigint, pnl: bigint): RowReconcile => ({
  fillId: `f${t}`, txHash: "0x", t, kind: null,
  expected: { sizeAfter: null, closedSize: null, exitPrice: null, realizedPnl: null },
  actual: { sizeAfter: 0n, closedSize: closed, exitPrice: null, realizedPnl: pnl }, diffs: [],
});

const cov = (over: Partial<FillReadCoverage> = {}): FillReadCoverage => ({
  firstFillSec: 0, lastFillSec: 1, rowsScanned: 1, rowsInWindow: 1, rowsKept: 1, pages: 1,
  truncated: false, stoppedBy: null, accountFillsInWindow: null, accountFillsAtCeiling: false, ...over,
});

const report = (market: string, rows: RowReconcile[], over: Partial<ReconcileReport> = {}): ReconcileReport => ({
  account: "0xabc", pool: `0x${market}`, market, fromSec: 0, toSec: 100,
  fills: rows.length, changes: rows.length, unmatched: 0, changesUnread: { fills: 0, reason: null },
  coverage: cov({ rowsScanned: rows.length, rowsInWindow: rows.length, rowsKept: rows.length, firstFillSec: rows[0]?.t ?? null, lastFillSec: rows[rows.length - 1]?.t ?? null }),
  rows, mismatches: 0,
  fees: {
    expected: 0n, actual: 0n, diff: 0n, rows: 0, leg: "vacuous-zero-rate",
    rates: { takerBpsTimes1k: 0n, makerBpsTimes1k: 0n },
    liquidation: { rows: 0, total: 0n }, unknown: { rows: 0, total: 0n, kinds: [] }, byKind: [],
  },
  ok: true, warnings: [], ...over,
});

const mr = (symbol: string, rows: RowReconcile[], over: Partial<ReconcileReport> = {}, cfgOver: Partial<MarketConfig> = {}): MarketReport =>
  ({ cfg: cfg(symbol, cfgOver), report: report(symbol, rows, over) });

const combine = (results: MarketReport[], listedCount = results.length) =>
  combineMarketReports({ account: "0xABC", fromSec: 0, toSec: 100, listedCount, results });

test("combine sums fills, changes, mismatches and unmatched across markets with fills", () => {
  const out = combine([
    mr("BTC", [row(1, 0n, 0n), row(2, 1n, 5n)], { changes: 7, mismatches: 1, unmatched: 2 }),
    mr("ETH", [row(3, 1n, -3n)], { changes: 4, mismatches: 0, unmatched: 1 }),
    mr("SOL", []),
  ]);
  assert.equal(out.marketsRead, 3);
  assert.equal(out.marketsWithFills, 2);
  assert.equal(out.input.fills, 3);
  assert.equal(out.input.changes, 11);
  assert.equal(out.input.mismatches, 1);
  assert.equal(out.input.unmatched, 3);
  assert.equal(out.input.account, "0xabc", "the account is lowercased");
  assert.equal(out.input.market, "ALL");
});

test("merged rows are chronological across markets", () => {
  const out = combine([
    mr("BTC", [row(10, 1n, 1n), row(30, 1n, 2n)]),
    mr("ETH", [row(20, 1n, 3n), row(40, 1n, 4n)]),
  ]);
  assert.deepEqual(out.input.rows.map((r) => r.t), [10, 20, 30, 40]);
});

test("the merged closing total is the sum of per-market closes, and the breakdown ranks by it", () => {
  const out = combine([
    mr("BTC", [row(1, 0n, 0n), row(2, 1n, -4343_000000n)]),
    mr("ZRO", [row(3, 1n, 14330_000000n)]),
    mr("LIT", [row(4, 1n, 8335_000000n)]),
  ]);
  const mergedTotal = out.input.rows.filter((r) => r.actual.closedSize > 0n).reduce((s, r) => s + r.actual.realizedPnl, 0n);
  assert.equal(mergedTotal, 18322_000000n);
  assert.deepEqual(out.markets.map((m) => m.market), ["ZRO", "LIT", "BTC"]);
  assert.deepEqual(out.markets.map((m) => m.realizedTotal), ["14330.000000", "8335.000000", "-4343.000000"]);
});

test("coverage combines: sums counts, spans the window, and keeps the worst truncation", () => {
  const out = combine([
    mr("BTC", [row(10, 1n, 1n)], { coverage: cov({ firstFillSec: 10, lastFillSec: 10, rowsScanned: 5, rowsInWindow: 4, rowsKept: 3, pages: 2, truncated: true, stoppedBy: "page-bound", accountFillsInWindow: 4 }) }),
    mr("ETH", [row(20, 1n, 1n)], { coverage: cov({ firstFillSec: 20, lastFillSec: 30, rowsScanned: 7, rowsInWindow: 6, rowsKept: 5, pages: 3, truncated: true, stoppedBy: "maxFills", accountFillsInWindow: 100, accountFillsAtCeiling: true }) }),
  ]);
  const c = out.input.coverage;
  assert.equal(c.firstFillSec, 10);
  assert.equal(c.lastFillSec, 30);
  assert.equal(c.rowsScanned, 12);
  assert.equal(c.rowsInWindow, 10);
  assert.equal(c.rowsKept, 8);
  assert.equal(c.pages, 5);
  assert.equal(c.truncated, true);
  assert.equal(c.stoppedBy, "maxFills", "maxFills outranks page-bound");
  assert.equal(c.accountFillsInWindow, 104);
  assert.equal(c.accountFillsAtCeiling, true);
});

test("a complete read on every market leaves the population null, not a fabricated count", () => {
  const out = combine([mr("BTC", [row(1, 1n, 1n)]), mr("ETH", [row(2, 1n, 1n)])]);
  assert.equal(out.input.coverage.accountFillsInWindow, null);
  assert.equal(out.input.coverage.truncated, false);
  assert.equal(out.input.coverage.stoppedBy, null);
});

test("ok is false when any market with fills failed reconcile", () => {
  assert.equal(combine([mr("BTC", [row(1, 1n, 1n)]), mr("ETH", [row(2, 1n, 1n)])]).input.ok, true);
  const bad = combine([mr("BTC", [row(1, 1n, 1n)]), mr("ETH", [row(2, 1n, 1n)], { ok: false, mismatches: 2 })]);
  assert.equal(bad.input.ok, false);
  assert.equal(bad.input.mismatches, 2);
});

test("markets that quote in different units refuse aggregation when both have fills", () => {
  assert.throws(() => combine([mr("BTC", [row(1, 1n, 1n)]), mr("ETH", [row(2, 1n, 1n)], {}, { quoteSymbol: "USDC" })]), /different units/);
  assert.throws(() => combine([mr("BTC", [row(1, 1n, 1n)]), mr("ETH", [row(2, 1n, 1n)], {}, { quoteDecimals: 18 })]), /different units/);
});

test("a differently-quoted market the account never traded does not block the read", () => {
  const out = combine([mr("BTC", [row(1, 1n, 1n)]), mr("ETH", [], {}, { quoteSymbol: "USDC", quoteDecimals: 18 })]);
  assert.equal(out.marketsWithFills, 1);
  assert.equal(out.quoteSymbol, "USDso");
});

test("no reports to combine is an error, not an empty portfolio", () => {
  assert.throws(() => combine([], 0), /no market reports/);
});

test("an account with no fills on any listed market yields an empty sequence", () => {
  const out = combine([mr("BTC", []), mr("ETH", []), mr("SOL", [])]);
  assert.equal(out.marketsWithFills, 0);
  assert.equal(out.markets.length, 0);
  assert.equal(out.input.rows.length, 0);
  assert.equal(out.input.fills, 0);
  assert.equal(out.input.coverage.firstFillSec, null);
  assert.equal(out.input.coverage.lastFillSec, null);
  assert.equal(out.input.ok, true);
  assert.equal(out.quoteSymbol, "USDso");
});

test("warnings carry the market tag and an aggregate scope line", () => {
  const out = combine([
    mr("BTC", [row(1, 1n, 1n)], { warnings: ["something happened"] }),
    mr("ETH", [row(2, 1n, 1n)], { coverage: cov({ truncated: true, stoppedBy: "maxFills" }) }),
    mr("SOL", []), mr("ZRO", []),
  ]);
  assert.ok(out.input.warnings.includes("[BTC] something happened"));
  assert.ok(out.input.warnings.some((w) => w.includes("1 of 2 market reads stopped early") && w.includes("ETH")));
  assert.ok(out.input.warnings.some((w) => w.includes("Aggregated across 2 market(s)") && w.includes("2 listed market(s) had none")));
});

test("each breakdown row splits closes from opens and counts wins on closes only", () => {
  const out = combine([mr("BTC", [row(1, 0n, 0n), row(2, 1n, 5_000000n), row(3, 1n, -3_000000n), row(4, 1n, 7_000000n)])]);
  const m = out.markets[0]!;
  assert.equal(m.fills, 4);
  assert.equal(m.closedTrades, 3);
  assert.equal(m.openingFills, 1);
  assert.equal(m.winRateBps, 6667);
  assert.equal(m.realizedTotal, "9.000000");
});