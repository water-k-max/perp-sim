import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStream, nextIndex, splitmix64Stream, xoshiro256ss } from "./rng.js";

test("splitmix64 matches the reference first outputs", () => {
  // Reference values from the splitmix64 paper's test (seed 0).
  const stream = splitmix64Stream(0n);
  assert.equal(stream(), 0xe220a8397b1dcdafn);
  assert.equal(stream(), 0x6e789e6aa1b965f4n);
  assert.equal(stream(), 0x06c45d188009454fn);
});

test("xoshiro256** matches the reference implementation", () => {
  // Vectors produced by compiling the canonical C (xoroshiro.di.unimi.it) with the same
  // splitmix64 seeding, seeds 42 and 0.
  const seed42 = xoshiro256ss(42n);
  for (const want of [0x15780b2e0c2ec716n, 0x6104d9866d113a7en, 0xae17533239e499a1n, 0xecb8ad4703b360a1n])
    assert.equal(seed42(), want);
  const seed0 = xoshiro256ss(0n);
  for (const want of [0x99ec5f36cb75f2b4n, 0x0bf6e1f784956452an, 0x1a5f849d4933e6e0n, 0x6aa594f1262d2d2cn])
    assert.equal(seed0(), want);
});

test("derived streams are independent per path index", () => {
  const a = deriveStream("seed", 0);
  const b = deriveStream("seed", 1);
  const c = deriveStream("other-seed", 0);
  const take = (rng: () => bigint) => [rng(), rng(), rng(), rng()];
  assert.notDeepEqual(take(a), take(b));
  assert.notDeepEqual(take(a), take(c));
});

test("nextIndex stays in bounds across a long draw", () => {
  const rng = deriveStream("bounds", 0);
  for (const n of [1, 2, 3, 7, 10, 100, 1000]) {
    for (let i = 0; i < 500; i += 1) {
      const v = nextIndex(rng, n);
      assert.ok(v >= 0 && v < n, `draw ${v} out of [0, ${n})`);
    }
  }
});

test("a stream is replayable: same seed and index reproduce the sequence", () => {
  const take = (seed: string, i: number) => {
    const rng = deriveStream(seed, i);
    return [rng(), rng(), rng()];
  };
  assert.deepEqual(take("replay", 3), take("replay", 3));
});
