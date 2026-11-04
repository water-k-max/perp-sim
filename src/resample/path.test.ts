import assert from "node:assert/strict";
import { test } from "node:test";
import { simulatePaths, walkPath, type PathTrade } from "./path.js";

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

test("bankruptcy fires when equity reaches or passes zero", () => {
  const trades: PathTrade[] = [{ pnl: -60n * E18 }, { pnl: -41n * E18 }];
  const out = walkPath({ order: trades, start, sizing: "static" });
  assert.equal(out.bankruptcy, true);
  // The worst point is one unit below zero: the drawdown from start exceeds start itself.
  assert.equal(out.maxDrawdown, start + 1n * E18);
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

test("simulatePaths is bit-identical under the same seed and differs under another", () => {
  const trades: PathTrade[] = Array.from({ length: 12 }, (_, i) => ({ pnl: BigInt(i - 6) * E18 }));
  const run = (seed: string) =>
    simulatePaths({ trades, mode: "shuffle_without_replacement", sizing: "static", paths: 25, horizon: 30, start, seed });
  const a = run("same");
  const b = run("same");
  assert.deepEqual(a, b);
  const c = run("different");
  assert.notDeepEqual(a.map((p) => p.finalEquity), c.map((p) => p.finalEquity));
});

test("walkPath validates starting equity and cap", () => {
  assert.throws(() => walkPath({ order: [], start: 0n, sizing: "static" }), /positive/);
  assert.throws(() => walkPath({ order: [], start: start, sizing: "compound", compoundCapMultiple: 0n }), /cap/);
});
