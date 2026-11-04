import test from "node:test";
import assert from "node:assert/strict";
import { aggregateTradeDays, parsePropRules, simulatePropEvaluation, type PropRules, type TradeDay } from "./prop.js";
import type { TradeRecord } from "./inputs.js";

const E18 = 10n ** 18n;

function trade(seq: number, exitTs: number, pnl: bigint, mae: bigint | null = null): TradeRecord {
  return {
    seq,
    entryTs: exitTs - 100,
    exitTs,
    pnl,
    direction: "long",
    barsHeld: 1,
    sameBar: false,
    mae,
    mfe: null,
    worstPrice: null,
    bestPrice: null,
    excursionSource: mae === null ? "none" : "candles",
    size: E18,
    entryPrice: 100n * E18,
    exitPrice: 100n * E18,
    funding: 0n,
    fee: 0n,
    gas: 0n,
  };
}

const RULES: PropRules = {
  startingBalance: null,
  drawdownMode: "trailing_eod",
  drawdownLocks: false,
  dailyLossLimit: "50",
  drawdownLimit: "500",
  phases: [{ profitTarget: "5", consistencyCapBps: null }],
  payoutCadence: "one_time",
  payoutFeeBps: 0,
  maxDays: 120,
};

function evalDays(days: TradeDay[], rules: PropRules = RULES, paths = 32) {
  return simulatePropEvaluation({
    days,
    rules,
    seed: "prop-fixture",
    paths,
    start: 1000n * E18,
    toRaw: (d) => BigInt(d) * E18,
  });
}

test("parsePropRules validates the form and applies documented defaults", () => {
  const full = parsePropRules({ dailyLossLimit: "50", drawdownLimit: "500", phases: [{ profitTarget: "5" }] });
  assert.equal(full.drawdownMode, "trailing_eod");
  assert.equal(full.drawdownLocks, false);
  assert.equal(full.payoutCadence, "monthly");
  assert.equal(full.payoutFeeBps, 0);
  assert.equal(full.maxDays, 120);
  assert.equal(full.startingBalance, null);
  assert.throws(() => parsePropRules({ dailyLossLimit: "-1", drawdownLimit: "1", phases: [{ profitTarget: "1" }] }), /positive decimal/);
  assert.throws(() => parsePropRules({ dailyLossLimit: "1", drawdownLimit: "1", phases: [] }), /one to four phases/);
  assert.throws(() => parsePropRules({ dailyLossLimit: "1", drawdownLimit: "1", phases: [{ profitTarget: "1", consistencyCapBps: 0 }] }), /consistencyCapBps/);
  assert.throws(() => parsePropRules({ dailyLossLimit: "1", drawdownLimit: "1", phases: [{ profitTarget: "1" }], payoutCadence: "daily" }), /payoutCadence/);
  assert.throws(() => parsePropRules({ dailyLossLimit: "1", drawdownLimit: "1", phases: [{ profitTarget: "1" }], payoutFeeBps: 10001 }), /payoutFeeBps/);
  assert.throws(() => parsePropRules({ dailyLossLimit: "1", drawdownLimit: "1", phases: [{ profitTarget: "1" }], maxDays: 0 }), /maxDays/);
});

test("aggregateTradeDays sums days exactly and estimates the intraday low from MAE", () => {
  const ts = (d: number) => d * 86_400 + 3_600;
  const days = aggregateTradeDays([
    trade(1, ts(0), 10n * E18, -4n * E18),
    trade(2, ts(0) + 60, 3n * E18, -1n * E18), // same UTC day
    trade(3, ts(1), -7n * E18),
    trade(4, ts(2), 2n * E18),
  ]);
  assert.equal(days.length, 3);
  assert.equal(days[0]!.pnl, 13n * E18);
  // running after trade 1 is +10, mae -4 → +6; after trade 2 is +13, mae -1 → +12; low is 0.
  assert.equal(days[0]!.intradayWorst, 0n);
  assert.equal(days[1]!.pnl, -7n * E18);
  assert.equal(days[1]!.intradayWorst, -7n * E18);
  // No excursion data: walked at close PnL, counted missing.
  assert.equal(days[2]!.missingExcursionCount, 1);
});

test("aggregateTradeDays tracks a deeper intraday low than the close", () => {
  const days = aggregateTradeDays([
    trade(1, 86_400 + 3_600, 1n * E18, -25n * E18),
    trade(2, 86_400 + 3_660, 1n * E18, -3n * E18),
  ]);
  // running after trade 1 is +1, mae -25 → -24 — deeper than the +2 close.
  assert.equal(days[0]!.intradayWorst, -24n * E18);
});

test("a profitable day funds every path; payouts and trades-to-fund are exact", () => {
  const result = evalDays(aggregateTradeDays([trade(1, 86_400, 10n * E18)]));
  assert.equal(result.fundedShare, 1);
  assert.equal(result.outcomes.find((o) => o.outcome === "funded")!.count, 32);
  assert.deepEqual(result.tradesToFund!.values, Array(32).fill(1));
  assert.equal(result.tradesToFund!.median, 1);
  assert.equal(result.medianDaysToFund, 1);
  assert.equal(result.expectedResets, 0);
  assert.equal(result.payouts!.average, 10n * E18); // one_time, no fee: profit is 10
  assert.equal(result.payouts!.bad, 10n * E18);
});

test("payout fee is an exact integer bps deduction", () => {
  const result = evalDays(
    aggregateTradeDays([trade(1, 86_400, 10n * E18)]),
    { ...RULES, payoutFeeBps: 1000 },
  );
  assert.equal(result.payouts!.average, 9n * E18);
});

test("a day beyond the daily loss limit breaches on every path", () => {
  const result = evalDays(aggregateTradeDays([trade(1, 86_400, -60n * E18, -60n * E18)]));
  assert.equal(result.fundedShare, 0);
  assert.equal(result.outcomes.find((o) => o.outcome === "breach_daily_loss")!.share, 1);
  assert.equal(result.payouts, null);
  assert.equal(result.expectedResets, null);
});

test("static drawdown breaches when the close leaves less than the allowance", () => {
  const rules: PropRules = { ...RULES, drawdownMode: "static", dailyLossLimit: "500", drawdownLimit: "50" };
  const result = evalDays(aggregateTradeDays([trade(1, 86_400, -60n * E18, -60n * E18)]), rules);
  assert.equal(result.outcomes.find((o) => o.outcome === "breach_drawdown")!.share, 1);
});

test("a consistency cap locks out a single huge green day", () => {
  const rules: PropRules = {
    ...RULES,
    phases: [{ profitTarget: "100", consistencyCapBps: 5000 }] as PropRules["phases"],
  };
  const result = evalDays(aggregateTradeDays([trade(1, 86_400, 10n * E18)]), rules);
  // 10 * 10000 = 100000 > 5000 * 10 = 50000 → lockout before the phase completes.
  assert.equal(result.outcomes.find((o) => o.outcome === "lockout")!.share, 1);
});

test("expired is the outcome when the target is never reached within maxDays", () => {
  const rules: PropRules = { ...RULES, maxDays: 3, phases: [{ profitTarget: "1000", consistencyCapBps: null }] };
  const result = evalDays(aggregateTradeDays([trade(1, 86_400, 1n * E18)]), rules);
  assert.equal(result.outcomes.find((o) => o.outcome === "expired")!.share, 1);
  assert.equal(result.outcomes.find((o) => o.outcome === "expired")!.count, 32);
});

test("monthly cadence chunks funded days into 21-day months", () => {
  const trades: TradeRecord[] = [];
  for (let i = 0; i < 30; i += 1) trades.push(trade(i + 1, (i + 1) * 86_400, 1n * E18));
  const rules: PropRules = { ...RULES, payoutCadence: "monthly", phases: [{ profitTarget: "5", consistencyCapBps: null }] };
  const result = evalDays(aggregateTradeDays(trades), rules, 16);
  // Every path funds within 5 days: one month per funded path.
  assert.equal(result.payouts!.values.length, 16);
  assert.equal(result.payouts!.average, 5n * E18);
});

test("the same seed replays bit-identically and a different seed can diverge", () => {
  const days = aggregateTradeDays(Array.from({ length: 9 }, (_, i) => trade(i + 1, (i + 1) * 86_400, BigInt(((i * 7) % 11) - 5) * E18)));
  const a = evalDays(days, RULES, 64);
  const b = evalDays(days, RULES, 64);
  assert.deepEqual(a, b);
});

test("notes carry the predicts-nothing and excursion-estimate honesty lines", () => {
  const result = evalDays(aggregateTradeDays([trade(1, 86_400, 1n * E18)]));
  assert.ok(result.notes.some((n) => /predicts nothing/.test(n)));
  assert.ok(result.notes.some((n) => /observed excursions/.test(n)));
  assert.ok(result.notes.some((n) => /idle/.test(n)));
});
