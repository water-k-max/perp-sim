import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStream } from "./rng.js";
import { blockLength, bootstrapBlocks, bootstrapWithReplacement, drawOrder, shuffleWithoutReplacement } from "./sample.js";

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

test("block length follows the n^(1/3) rule and rejects nonsense counts", () => {
  assert.equal(blockLength(1), 1);
  assert.equal(blockLength(8), 2);
  assert.equal(blockLength(27), 3);
  assert.equal(blockLength(64), 4);
  assert.equal(blockLength(100), 5);
  assert.throws(() => blockLength(0), /trade count/);
  assert.throws(() => blockLength(12.5), /trade count/);
});

test("block bootstrap keeps real adjacency inside every drawn block", () => {
  // Five trades, block length ceil(5^(1/3)) = 2, horizon 20: exactly ten blocks, so each
  // even/odd pair is one block and must be a consecutive pair of the original list (mod
  // wrap). Reverting to i.i.d. draws breaks this — a random pair is adjacent only 1/5 of
  // the time, so ten-for-ten is the canary.
  const items = Array.from({ length: 5 }, (_, i) => ({ id: i }));
  const order = drawOrder(items, "block_bootstrap_with_replacement", 20, deriveStream("adjacency", 0));
  assert.equal(order.length, 20);
  for (let k = 0; k < 10; k += 1) {
    const a = order[2 * k]!.id;
    const b = order[2 * k + 1]!.id;
    assert.equal(b, (a + 1) % 5, `block ${k} drew ${a} then ${b}, which is not a consecutive pair`);
  }
});

test("block bootstrap draws start anywhere, wraps past the end and truncates at the horizon", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: i }));
  const rng = deriveStream("wrap", 0);
  const blocks = Array.from({ length: 200 }, () => bootstrapBlocks(items, 7, rng));
  const wrapped = blocks.some((b) => {
    // A block that starts near the end wraps: consecutive ids mod 7 appear in it.
    return b.some((t, i) => i > 0 && t.id === (b[i - 1]!.id + 1) % 7 && b[i - 1]!.id > t.id);
  });
  assert.ok(wrapped, "expected at least one block to wrap past the end");
  const short = bootstrapBlocks(items, 3, deriveStream("short", 0));
  assert.equal(short.length, 3);
  // Positions 0-1 are one whole block of 2; position 2 starts a fresh block.
  assert.equal(short[1]!.id, (short[0]!.id + 1) % 7);
});

test("block bootstrap is deterministic under the same stream and differs under another", () => {
  const draw = (seed: string) => drawOrder(TRADES, "block_bootstrap_with_replacement", 25, deriveStream(seed, 0)).map((t) => t.id);
  assert.deepEqual(draw("one"), draw("one"));
  assert.notDeepEqual(draw("one"), draw("two"));
});
