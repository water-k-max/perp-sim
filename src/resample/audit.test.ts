import assert from "node:assert/strict";
import { test } from "node:test";
import type { TradeRecord, TradeList } from "./inputs.js";
import { assumptionLines, auditTradeList, repriceSameBarAdverse, sameBarShareBps } from "./audit.js";

const E18 = 10n ** 18n;
const oneBase = 10n ** 8n;

const rec = (over: Partial<TradeRecord>): TradeRecord => ({
  entryTs: 1, exitTs: 2, pnl: 0n, direction: "long", barsHeld: 1, sameBar: false,
  mae: null, mfe: null, worstPrice: null, bestPrice: null, excursionSource: "none",
  size: oneBase, entryPrice: 100n * E18, exitPrice: 101n * E18, funding: 0n, fee: 0n, gas: 0n, seq: 1,
  ...over,
});

const listOf = (trades: TradeRecord[]): TradeList => ({
  trades,
  sameBarCount: trades.filter((t) => t.sameBar).length,
  withoutExcursionCount: trades.filter((t) => t.excursionSource === "none").length,
  window: { from: null, to: null },
});

test("same-bar share is exact basis points of the trade count", () => {
  assert.equal(sameBarShareBps(listOf([])), 0);
  assert.equal(sameBarShareBps(listOf([rec({ sameBar: true })])), 10_000);
  assert.equal(sameBarShareBps(listOf([rec({ sameBar: true }), rec({}), rec({}), rec({})])), 2_500);
});

test("re-pricing moves a same-bar adverse trade to its worst observed price, exactly", () => {
  // Long from 100, closed at 101 for +1 net; the bar's low was 90 and its excursion was observed.
  const adverse = rec({
    sameBar: true, barsHeld: 0, pnl: 1n * E18, mae: -10n * E18, mfe: 2n * E18,
    worstPrice: 90n * E18, bestPrice: 102n * E18, excursionSource: "candles",
    funding: 1n * E18, fee: 2n * E18, gas: 3n * E18,
  });
  const { trades, repriced } = repriceSameBarAdverse([adverse], oneBase);
  assert.equal(repriced, 1);
  // New gross at 90: -10; net = gross - funding - fee - gas.
  assert.equal(trades[0]!.pnl, -10n * E18 - 1n * E18 - 2n * E18 - 3n * E18);
});

test("re-pricing leaves everything else untouched", () => {
  const cases = [
    rec({ pnl: 5n * E18 }),                                                          // ordinary trade
    rec({ sameBar: true, pnl: 5n * E18 }),                                           // same-bar, no excursion
    rec({ sameBar: true, pnl: 5n * E18, mae: 0n, mfe: 3n * E18, worstPrice: 100n * E18, bestPrice: 103n * E18, excursionSource: "candles" }), // same-bar, never adverse
    rec({ pnl: -7n * E18, mae: -20n * E18, worstPrice: 80n * E18, excursionSource: "candles" }), // adverse but not same-bar
  ];
  const { trades, repriced } = repriceSameBarAdverse(cases, oneBase);
  assert.equal(repriced, 0);
  assert.deepEqual(trades.map((t) => t.pnl), cases.map((t) => t.pnl));
});

test("the dismissal verdict fires at and only at the threshold share", () => {
  const config = { fillModel: "settlement-mark" as const, profile: null, latencySec: 1, gasPerTx: "0", intrabar: true };
  const opts = { paths: 16, horizon: 8, sizing: "static" as const, start: 100n * E18, seed: "audit", quoteScale: E18, oneBase };
  const atThreshold = listOf([rec({ sameBar: true }), rec({})]);
  assert.equal(auditTradeList(atThreshold, config, { ...opts, dismissalThresholdBps: 5_000 }).dismissed, true);
  assert.equal(auditTradeList(atThreshold, config, { ...opts, dismissalThresholdBps: 5_001 }).dismissed, false);
  assert.equal(auditTradeList(listOf([]), config, opts).dismissed, false);
});

test("assumption lines name each quiet flatterer and its live consequence", () => {
  const lines = assumptionLines({ fillModel: "tape", profile: "optimistic", latencySec: 0, gasPerTx: "0", intrabar: false });
  const joined = lines.join("\n");
  assert.ok(joined.includes("optimistic"), joined);
  assert.ok(joined.includes("latency is 0"), joined);
  assert.ok(joined.includes("Gas per order is 0"), joined);
  assert.ok(joined.includes("Intrabar marking is off"), joined);
  const settlement = assumptionLines({ fillModel: "settlement-mark", profile: null, latencySec: 1, gasPerTx: "0.5", intrabar: true });
  assert.ok(settlement.join("\n").includes("settlement-mark"), settlement.join("\n"));
  assert.equal(settlement.some((l) => l.includes("latency is 0")), false);
});

test("the audit re-run is deterministic and reprices only the adverse same-bar trades", () => {
  const config = { fillModel: "settlement-mark" as const, profile: "realistic", latencySec: 1, gasPerTx: "0", intrabar: true };
  const opts = { paths: 32, horizon: 20, sizing: "static" as const, start: 100n * E18, seed: "audit-det", quoteScale: E18, oneBase };
  const list = listOf([
    rec({ sameBar: true, barsHeld: 0, pnl: 3n * E18, mae: -5n * E18, mfe: 1n * E18, worstPrice: 95n * E18, bestPrice: 101n * E18, excursionSource: "candles" }),
    rec({ pnl: 2n * E18 }),
    rec({ pnl: -1n * E18 }),
  ]);
  const a = auditTradeList(list, config, opts);
  const b = auditTradeList(list, config, opts);
  assert.deepEqual(a, b);
  assert.equal(a.repricedCount, 1);
  assert.ok(a.repricedSummary!.medianFinalEquity < a.exportedSummary!.medianFinalEquity);
  // The unbounded-case disclosure is always present, always present.
  assert.ok(a.notes.some((n) => n.includes("not a bound") && n.includes("stop and target")));
});

test("tape fills: same-bar share is context only, with no verdict and no re-pricing", () => {
  const config = { fillModel: "tape" as const, profile: "realistic", latencySec: 1, gasPerTx: "0", intrabar: true };
  const opts = { paths: 32, horizon: 20, sizing: "static" as const, start: 100n * E18, seed: "audit-tape", quoteScale: E18, oneBase, dismissalThresholdBps: 1 };
  const list = listOf([
    rec({ sameBar: true, barsHeld: 0, pnl: 3n * E18, mae: -5n * E18, mfe: 1n * E18, worstPrice: 95n * E18, bestPrice: 101n * E18, excursionSource: "tape" }),
    rec({ pnl: 2n * E18 }),
  ]);
  const a = auditTradeList(list, config, opts);
  assert.equal(a.fillBasis, "observed");
  assert.equal(a.dismissed, false);
  assert.equal(a.repricedCount, 0);
  assert.equal(a.repricedFinalEquities.length, 0);
  assert.ok(a.sameBarShareBps > 0);
});
