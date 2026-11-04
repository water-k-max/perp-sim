import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStream } from "./rng.js";
import { bootstrapWithReplacement, drawOrder, shuffleWithoutReplacement } from "./sample.js";

const TRADES = Array.from({ length: 10 }, (_, i) => ({ id: i, pnl: BigInt((i + 1) * 10) }));

function multiset<T>(items: readonly T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const t of items) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

test("shuffle preserves the exact trade multiset", () => {
  const rng = deriveStream("shuffle-multiset", 0);
  for (let trial = 0; trial < 50; trial += 1) {
    assert.deepEqual(multiset(shuffleWithoutReplacement(TRADES, rng)), multiset(TRADES));
  }
});

test("shuffle with a fresh stream is deterministic", () => {
  const draw = () => shuffleWithoutReplacement(TRADES, deriveStream("det", 0)).map((t) => t.id);
  assert.deepEqual(draw(), draw());
});

test("bootstrap may repeat and omit trades", () => {
  const rng = deriveStream("bootstrap", 0);
  const draws = Array.from({ length: 200 }, () => bootstrapWithReplacement(TRADES, 10, rng));
  assert.ok(draws.some((d) => multiset(d).size < 10), "expected at least one repeated trade");
  assert.ok(draws.every((d) => multiset(d).size <= 10));
});

test("drawOrder produces the requested horizon in both modes", () => {
  for (const mode of ["shuffle_without_replacement", "bootstrap_with_replacement"] as const) {
    const order = drawOrder(TRADES, mode, 37, deriveStream("horizon", 0));
    assert.equal(order.length, 37);
    assert.ok(order.every((t) => TRADES.includes(t)));
  }
});

test("shuffle drawOrder cycles fresh permutations when the horizon exceeds the trade count", () => {
  const rng = deriveStream("cycle", 0);
  const order = drawOrder(TRADES, "shuffle_without_replacement", 25, rng);
  assert.equal(order.length, 25);
  // Each block of 10 is a permutation of the full list.
  for (const block of [order.slice(0, 10), order.slice(10, 20)]) {
    assert.deepEqual(multiset(block), multiset(TRADES));
  }
});

test("drawOrder rejects an empty trade list and a non-positive horizon", () => {
  assert.throws(() => drawOrder([], "shuffle_without_replacement", 5, deriveStream("e", 0)), /empty/);
  assert.throws(() => drawOrder(TRADES, "bootstrap_with_replacement", 0, deriveStream("e", 0)), /horizon/);
});
