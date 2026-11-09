import assert from "node:assert/strict";
import { test } from "node:test";
import { simulatePaths } from "./path.js";
import { quantileNum, summarizePaths } from "./stats.js";

const E18 = 10n ** 18n;
const SCALE = E18;
const start = 100n * E18;

/** A hand-written 10-trade list, pinned for the golden fixture below. */
const GOLDEN_TRADES = [
  { pnl: 12n * E18 }, { pnl: -7n * E18 }, { pnl: 3n * E18 }, { pnl: -15n * E18 }, { pnl: 9n * E18 },
  { pnl: -2n * E18 }, { pnl: 21n * E18 }, { pnl: -11n * E18 }, { pnl: 4n * E18 }, { pnl: -6n * E18 },
];
const GOLDEN_SEED = "golden-10-trade-fixture";

function goldenPaths() {
  return simulatePaths({
    trades: GOLDEN_TRADES,
    mode: "shuffle_without_replacement",
    sizing: "static",
    paths: 64,
    horizon: 37,
    start,
    seed: GOLDEN_SEED,
  });
}

test("quantile interpolation is exact at the endpoints and monotone between them", () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(quantileNum(sorted, 0), 1);
  assert.equal(quantileNum(sorted, 1), 5);
  assert.equal(quantileNum(sorted, 0.5), 3);
  const values = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1].map((q) => quantileNum(sorted, q));
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i]! >= values[i - 1]!, `ladder fell at ${i}`);
});

test("summarizePaths returns an ordered percentile ladder and CVaR below VaR", async () => {
  const summary = summarizePaths(await goldenPaths(), SCALE);
  const ladder = [
    summary.p05FinalEquity, summary.p10FinalEquity, summary.p25FinalEquity, summary.p50FinalEquity,
    summary.p75FinalEquity, summary.p90FinalEquity, summary.p95FinalEquity,
  ];
  for (let i = 1; i < ladder.length; i += 1) assert.ok(ladder[i]! >= ladder[i - 1]!, `ladder fell at index ${i}`);
  assert.ok(summary.cvar95 <= summary.p05FinalEquity, "CVaR-95 must not exceed the p05 (VaR) final");
  assert.ok(summary.cvar95 <= summary.medianFinalEquity);
  assert.equal(summary.paths, 64);
  assert.equal(summary.finalEquities.length, 64);
  assert.ok(summary.bankruptcyRate >= 0 && summary.bankruptcyRate <= 1);
  // Step 0 of the fan is starting equity for every path.
  assert.equal(summary.fan[0]!.p10, 100);
  assert.equal(summary.fan[0]!.p90, 100);
});

test("golden fixture: 10-trade list with a pinned seed reproduces exactly", async () => {
  const summary = summarizePaths(await goldenPaths(), SCALE);
  // Pinned outputs of the current implementation for the hand-written list above, seed
  // "golden-10-trade-fixture", 64 paths, horizon 37, static sizing, 100 start. If a
  // deliberate algorithm change makes these drift, update them in the same commit that
  // changes the algorithm.
  assert.equal(summary.medianFinalEquity, 127.5);
  assert.equal(summary.p05FinalEquity, 96.3);
  assert.equal(summary.p95FinalEquity, 155);
  assert.equal(summary.cvar95, 95.33333333333333);
  assert.equal(summary.bankruptcyCount, 0);
  assert.equal(summary.bankruptcyRate, 0);
  assert.equal(summary.medianMaxLosingStreak, 4);
  assert.equal(summary.p95MaxLosingStreak, 5);
  assert.equal(summary.medianMaxDrawdownBps, 1450);
  assert.equal(summary.p95MaxDrawdownBps, 3369.999999999999);
  assert.equal(summary.fan.length, 38);
  assert.deepEqual(summary.fan[37], { step: 37, p10: 107.3, p25: 118, p50: 127.5, p75: 140, p90: 150.7 });
});

test("a path set with a ruinous trade reports a positive bankruptcy rate", async () => {
  const trades = [{ pnl: -200n * E18 }, { pnl: 1n * E18 }];
  const paths = await simulatePaths({ trades, mode: "bootstrap_with_replacement", sizing: "static", paths: 32, horizon: 8, start, seed: "ruin" });
  const summary = summarizePaths(paths, SCALE);
  assert.ok(summary.bankruptcyCount > 0);
  assert.equal(summary.bankruptcyRate, summary.bankruptcyCount / 32);
});

test("same seed re-run is identical end to end (pinned JSON)", async () => {
  const render = async () => JSON.stringify(summarizePaths(await goldenPaths(), SCALE), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  assert.equal(await render(), await render());
});
