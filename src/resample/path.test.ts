import assert from "node:assert/strict";
import { test } from "node:test";
import { RESAMPLE_WORK_MAX, simulatePaths, walkPath, type PathTrade } from "./path.js";

const E18 = 10n ** 18n;
const start = 100n * E18;

test("static walk accumulates exact integer PnLs and tracks streaks", () => {
  const trades: PathTrade[] = [{ pnl: 5n * E18 }, { pnl: -3n * E18 }, { pnl: -2n * E18 }, { pnl: 7n * E18 }];
  const out = walkPath({ order: trades, start, sizing: "static" });
  assert.deepEqual(out.curve, [start, 105n * E18, 102n * E18, 100n * E18, 107n * E18]);
  assert.equal(out.finalEquity, 107n * E18);
  assert.equal(out.maxLosingStreak, 2);
  assert.equal(out.bankruptcy, false);
});

test("max drawdown is measured from the account start, not a running high", () => {
  // Rises first, then falls below start: the depth is from start to the worst point.
  const trades: PathTrade[] = [{ pnl: 50n * E18 }, { pnl: -80n * E18 }, { pnl: 10n * E18 }];
  const out = walkPath({ order: trades, start, sizing: "static" });
  assert.equal(out.maxDrawdown, 30n * E18);
  assert.equal(out.maxDrawdownBps, 3000n);
  // The peak-to-trough fall (130) is intentionally not what is measured.
  assert.notEqual(out.maxDrawdown, 130n * E18);
});

test("bankruptcy clamps the wipe at zero and reports a full drawdown", () => {
  const trades: PathTrade[] = [{ pnl: -60n * E18 }, { pnl: -41n * E18 }];
  const out = walkPath({ order: trades, start, sizing: "static" });
  assert.equal(out.bankruptcy, true);
  // A liquidating account cannot go below zero: the second trade lands exactly on the floor,
  // so the worst point is zero and the drawdown from start is the whole account.
  assert.deepEqual(out.curve, [start, 40n * E18, 0n]);
  assert.equal(out.finalEquity, 0n);
  assert.equal(out.maxDrawdown, start);
  assert.equal(out.maxDrawdownBps, 10_000n);
});

test("bankruptcy is absorbing: later trades neither resurrect nor deepen the wipe", () => {
  const out = walkPath({ order: [{ pnl: -110n * E18 }, { pnl: 50n * E18 }], start, sizing: "static" });
  assert.equal(out.bankruptcy, true);
  // The +50 is never applied — the curve stays pinned at zero for the remaining steps.
  assert.deepEqual(out.curve, [start, 0n, 0n]);
  assert.equal(out.finalEquity, 0n);
  assert.equal(out.maxDrawdown, start);
  assert.equal(out.maxLosingStreak, 1);
  // Only the trades applied before the wipe count towards the path's own metrics.
  assert.equal(out.winRateBps, 0n);
});

test("compound sizing never scales a PnL by a negative equity base", () => {
  const trades: PathTrade[] = [{ pnl: -110n * E18 }, { pnl: 50n * E18 }, { pnl: -50n * E18 }];
  const out = walkPath({ order: trades, start, sizing: "compound" });
  // Without the barrier the second trade would size against a negative equity and flip to a loss.
  assert.equal(out.finalEquity, 0n);
  assert.deepEqual(out.curve, [start, 0n, 0n, 0n]);
  assert.equal(out.bankruptcy, true);
});

test("compound sizing scales PnL by equity over start", () => {
  const trades: PathTrade[] = [{ pnl: 10n * E18 }, { pnl: 10n * E18 }];
  const out = walkPath({ order: trades, start, sizing: "compound" });
  // First trade earns 10%: equity 110. Second trade scales by 110/100: +11.
  assert.equal(out.finalEquity, 121n * E18);
});

test("compound cap bounds the equity multiple used for scaling", () => {
  const trades: PathTrade[] = [{ pnl: 50n * E18 }, { pnl: 50n * E18 }, { pnl: 50n * E18 }, { pnl: 50n * E18 }];
  const capped = walkPath({ order: trades, start, sizing: "compound", compoundCapMultiple: 2n });
  // Uncapped: 100 -> 150 -> 225 -> 337.5 -> 506.25. Capped at 2x start:
  // the third and fourth trades scale against 2x start, not 2.25x / 3.25x.
  assert.deepEqual(capped.curve, [start, 150n * E18, 225n * E18, 325n * E18, 425n * E18]);
  const uncapped = walkPath({ order: trades, start, sizing: "compound" });
  assert.ok(capped.finalEquity < uncapped.finalEquity);
});

test("zero-PnL trades neither extend nor reset a losing streak", () => {
  const trades: PathTrade[] = [{ pnl: -1n * E18 }, { pnl: 0n }, { pnl: -1n * E18 }, { pnl: 0n }];
  const out = walkPath({ order: trades, start, sizing: "static" });
  assert.equal(out.maxLosingStreak, 2);
});

test("simulatePaths is bit-identical under the same seed and differs under another", async () => {
  const trades: PathTrade[] = Array.from({ length: 12 }, (_, i) => ({ pnl: BigInt(i - 6) * E18 }));
  const run = (seed: string) =>
    simulatePaths({ trades, mode: "shuffle_without_replacement", sizing: "static", paths: 25, horizon: 30, start, seed });
  const a = await run("same");
  const b = await run("same");
  assert.deepEqual(a, b);
  const c = await run("different");
  assert.notDeepEqual(a.map((p) => p.finalEquity), c.map((p) => p.finalEquity));
});

test("simulatePaths rejects a path set over the work budget before walking", async () => {
  const trades: PathTrade[] = [{ pnl: E18 }];
  await assert.rejects(
    simulatePaths({ trades, mode: "bootstrap_with_replacement", sizing: "static", paths: RESAMPLE_WORK_MAX + 1, horizon: 1, start, seed: "over" }),
    /work budget/,
  );
});

test("simulatePaths yields to the event loop mid-set without changing the result", async () => {
  const trades: PathTrade[] = Array.from({ length: 8 }, (_, i) => ({ pnl: BigInt(i - 4) * E18 }));
  // 9000 × 40 = 360k steps over 2500-path chunks: several chunks remain after the first
  // yield, so a macrotask queued here fires while the set is still walking.
  const opts = { trades, mode: "bootstrap_with_replacement" as const, sizing: "static" as const, paths: 9000, horizon: 40, start, seed: "yield" };
  let completed = false;
  const pending = simulatePaths(opts).then((out) => { completed = true; return out; });
  const firedWhileRunning = await new Promise<boolean>((resolve) => setImmediate(() => resolve(!completed)));
  assert.equal(firedWhileRunning, true, "simulation ran to completion without yielding");
  const yielded = await pending;
  const straight = await simulatePaths(opts);
  assert.deepEqual(yielded, straight);
});

test("walkPath validates starting equity and cap", () => {
  assert.throws(() => walkPath({ order: [], start: 0n, sizing: "static" }), /positive/);
  assert.throws(() => walkPath({ order: [], start: start, sizing: "compound", compoundCapMultiple: 0n }), /cap/);
});

test("win rate and per-trade Sharpe are pinned exactly on a fixed order", () => {
  // wins 2 of 4 -> 5000 bps. mean pnl = (3-1-1+3)/4 = 1; deviations (2,-2,-2,2);
  // variance = 16/4 = 4; sd = 2; sharpe = 1*10000/2 = 5000. Every step is exact bigint.
  const trades: PathTrade[] = [{ pnl: 3n }, { pnl: -1n }, { pnl: -1n }, { pnl: 3n }];
  const out = walkPath({ order: trades, start: 100n, sizing: "static" });
  assert.equal(out.winRateBps, 5000n);
  assert.equal(out.sharpeX1e4, 5000n);
});

test("Sharpe is null when the applied PnLs do not vary and when the horizon is under three", () => {
  const flat: PathTrade[] = [{ pnl: 2n }, { pnl: 2n }, { pnl: 2n }];
  const flatOut = walkPath({ order: flat, start: 100n, sizing: "static" });
  assert.equal(flatOut.winRateBps, 10000n);
  assert.equal(flatOut.sharpeX1e4, null);
  const two: PathTrade[] = [{ pnl: 5n }, { pnl: -1n }];
  const twoOut = walkPath({ order: two, start: 100n, sizing: "static" });
  assert.equal(twoOut.sharpeX1e4, null);
});

test("win rate is computed over applied PnLs, not raw order PnLs", () => {
  // Under compound sizing the second trade's applied PnL is +11 (10 scaled by 110/100),
  // not the raw +10. Both applied PnLs are positive, so the rate is full.
  const trades: PathTrade[] = [{ pnl: 10n }, { pnl: 10n }];
  const out = walkPath({ order: trades, start: 100n, sizing: "compound" });
  assert.equal(out.winRateBps, 10000n);
  assert.equal(out.finalEquity, 121n); // 100 -> 110 -> 121, per the compound test above
});
