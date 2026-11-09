import assert from "node:assert/strict";
import { test } from "node:test";
import type { TradeRecord } from "./inputs.js";
import { runOos, splitHoldback } from "./oos.js";

const E18 = 10n ** 18n;
const start = 100n * E18;

let nextSeq = 1;
const rec = (pnl: bigint, over: Partial<TradeRecord> = {}): TradeRecord => ({
  entryTs: nextSeq, exitTs: nextSeq + 1, pnl, direction: "long", barsHeld: 1, sameBar: false,
  mae: null, mfe: null, worstPrice: null, bestPrice: null, excursionSource: "none",
  size: 10n ** 8n, entryPrice: 100n * E18, exitPrice: 100n * E18, funding: 0n, fee: 0n, gas: 0n,
  seq: nextSeq++, ...over,
});

const baseOpts = { seed: "oos", paths: 400, start, quoteScale: E18 };

test("splitHoldback takes the tail and validates the fraction", () => {
  const trades = Array.from({ length: 10 }, () => rec(1n * E18));
  const first = trades[0]!.seq;
  const { fit, held } = splitHoldback(trades, 0.3);
  assert.equal(fit.length, 7);
  assert.equal(held.length, 3);
  assert.deepEqual(held.map((t) => t.seq), [first + 7, first + 8, first + 9]);
  assert.throws(() => splitHoldback(trades, 0), /\(0, 1\)/);
  assert.throws(() => splitHoldback(trades, 1), /\(0, 1\)/);
  assert.throws(() => splitHoldback([rec(1n * E18)], 0.5), /two trades/);
  // Any fraction below 1 keeps at least one fit trade.
  assert.equal(splitHoldback(trades, 0.99).fit.length, 1);
});

test("the boundary is the 95th percentile: about 5% of fit paths cross it", async () => {
  const trades = Array.from({ length: 20 }, (_, i) => rec(BigInt(((i * 37) % 11) - 5) * E18));
  const result = await runOos({ ...baseOpts, trades, holdbackFraction: 0.25 });
  const crossings = result.fitFinals.filter((f) => Number(f) / Number(E18) > result.boundary).length;
  const share = crossings / result.fitFinals.length;
  assert.ok(share <= 0.05, `${share} of fit paths crossed the p95 boundary`);
  assert.ok(share >= 0.02, `${share} of fit paths crossed the p95 boundary`);
  assert.equal(result.fitFinals.length, 400);
});

test("a held-back replay stronger than the fit half crosses the boundary", async () => {
  const fit = Array.from({ length: 16 }, (_, i) => rec(BigInt(((i * 13) % 7) - 3) * E18));
  const quiet = await runOos({ ...baseOpts, trades: [...fit, rec(1n * E18), rec(1n * E18), rec(1n * E18), rec(1n * E18)], holdbackFraction: 0.2 });
  const loud = await runOos({ ...baseOpts, trades: [...fit, rec(80n * E18), rec(80n * E18), rec(80n * E18), rec(80n * E18)], holdbackFraction: 0.2 });
  assert.equal(quiet.crossed, false);
  assert.equal(loud.crossed, true);
  assert.equal(loud.heldFinalMinusStart, 320n * E18);
  assert.deepEqual(loud.heldCurve.length, loud.heldCount + 1);
  assert.equal(loud.heldCurve[0], start);
  assert.equal(Number(loud.heldCurve[4]) / Number(E18), 420);
});

test("no look-ahead: held trades cannot move the boundary", async () => {
  const fit = Array.from({ length: 12 }, (_, i) => rec(BigInt(((i * 7) % 9) - 4) * E18));
  const heldQuiet = [rec(2n * E18), rec(-1n * E18), rec(3n * E18)];
  const heldLoud = [rec(900n * E18), rec(-800n * E18), rec(700n * E18)];
  const a = await runOos({ ...baseOpts, trades: [...fit, ...heldQuiet], holdbackFraction: 0.2 });
  const b = await runOos({ ...baseOpts, trades: [...fit, ...heldLoud], holdbackFraction: 0.2 });
  assert.equal(a.boundary, b.boundary);
  assert.deepEqual(a.fitFinals, b.fitFinals);
  // The seq records partition the trade list for the invariant check.
  assert.deepEqual([...a.fitSeqs, ...a.heldSeqs].sort((x, y) => x - y), [...fit, ...heldQuiet].map((t) => t.seq).sort((x, y) => x - y));
});

test("oos output is deterministic under the seed and carries the verdict framing", async () => {
  const trades = Array.from({ length: 14 }, (_, i) => rec(BigInt(((i * 11) % 8) - 4) * E18));
  const a = await runOos({ ...baseOpts, trades, holdbackFraction: 0.3 });
  const b = await runOos({ ...baseOpts, trades, holdbackFraction: 0.3 });
  assert.deepEqual(a, b);
  assert.ok(a.notes.some((n) => n.includes("not proof of an edge")));
  assert.ok(a.notes.some((n) => n.includes("inherit its biases")));
});
