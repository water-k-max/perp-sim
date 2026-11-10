import test from "node:test";
import assert from "node:assert/strict";
import { clearLiveCache, liveCacheSec, liveCacheStats, onceLive } from "./live-cache.js";

/**
 *  `onceLive` decides whether the venue gets asked again. Each case counts the reads underneath it,
 *  because "returned the right value" is also what a cache that never stores anything would do.
 */
const withTtl = async (seconds: string | undefined, runTest: () => Promise<void>) => {
  const previous = process.env.PERP_SIM_LIVE_CACHE_SEC;
  if (seconds === undefined) delete process.env.PERP_SIM_LIVE_CACHE_SEC;
  else process.env.PERP_SIM_LIVE_CACHE_SEC = seconds;
  clearLiveCache();
  try {
    await runTest();
  } finally {
    if (previous === undefined) delete process.env.PERP_SIM_LIVE_CACHE_SEC;
    else process.env.PERP_SIM_LIVE_CACHE_SEC = previous;
    clearLiveCache();
  }
};

test("the cache is off until someone asks: unset ttl calls the reader every time", async () => {
  let calls = 0;
  await withTtl(undefined, async () => {
    assert.equal(liveCacheSec(), 0);
    for (let i = 0; i < 3; i++) assert.equal(await onceLive("perp-markets", async () => ++calls), calls);
    assert.deepEqual(liveCacheStats(), { reads: 0, hits: 0, entries: 0 }, "a disabled cache must not be counting");
  });
  assert.equal(calls, 3, "an unset ttl must not serve a remembered value");
});

test("ttl 0 is off too, and a nonsense ttl is refused instead of silently disabling", async () => {
  await withTtl("0", async () => {
    let calls = 0;
    await onceLive("k", async () => ++calls);
    await onceLive("k", async () => ++calls);
    assert.equal(calls, 2);
  });
  for (const bad of ["-1", "abc", "NaN", "Infinity"]) {
    await withTtl(bad, async () => {
      assert.throws(() => liveCacheSec(), /non-negative number/);
      await assert.rejects(() => onceLive("k", async () => 1), /non-negative number/);
    });
  }
});

test("one read serves the window: repeat and concurrent calls share it", async () => {
  let calls = 0;
  let release = (): void => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  await withTtl("60", async () => {
    const slow = onceLive("perp-config:0xaaa", async () => {
      calls++;
      await gate;
      return "value";
    });
    const pending = onceLive("perp-config:0xaaa", async () => {
      calls++;
      return "second";
    });
    release();
    assert.equal(await slow, "value");
    assert.equal(await pending, "value", "a concurrent read must join the one in flight, not start another");
    assert.equal(await onceLive("perp-config:0xaaa", async () => "third"), "value");
    assert.deepEqual(liveCacheStats(), { reads: 1, hits: 2, entries: 1 });
  });
  assert.equal(calls, 1, "three callers, one read");
});

test("the window closes: after the ttl the reader is asked again", async () => {
  const realNow = Date.now;
  let clock = 1_000;
  Date.now = () => clock;
  try {
    let calls = 0;
    await withTtl("60", async () => {
      assert.equal(await onceLive("perp-markets", async () => ++calls), 1);
      clock += 59_000;
      assert.equal(await onceLive("perp-markets", async () => ++calls), 1, "59 s is inside a 60 s window");
      clock += 2_000;
      assert.equal(await onceLive("perp-markets", async () => ++calls), 2, "61 s must re-read, not remember");
    });
  } finally {
    Date.now = realNow;
  }
});

test("a failed read is not remembered, so one indexer hiccup cannot answer for a minute", async () => {
  let calls = 0;
  await withTtl("60", async () => {
    await assert.rejects(() => onceLive("perp-markets", async () => {
      calls++;
      throw new Error("indexer unavailable");
    }), /indexer unavailable/);
    assert.equal(liveCacheStats().entries, 0, "the rejected key must have been dropped");
    assert.equal(await onceLive("perp-markets", async () => ++calls), 2, "the next caller re-reads and succeeds");
    assert.equal(await onceLive("perp-markets", async () => "never"), 2, "and the success is cached normally");
  });
  assert.equal(calls, 2);
});

test("keys are separate: two pools do not share one risk parameter", async () => {
  await withTtl("60", async () => {
    assert.equal(await onceLive("perp-config:0xaaa", async () => "imf-aaa"), "imf-aaa");
    assert.equal(await onceLive("perp-config:0xbbb", async () => "imf-bbb"), "imf-bbb");
    assert.equal(await onceLive("perp-config:0xaaa", async () => "wrong"), "imf-aaa");
    assert.equal(liveCacheStats().entries, 2);
  });
});

test("the value round-trips untouched, including bigint and undefined", async () => {
  await withTtl("60", async () => {
    const value = { imBps: 500n, pool: "0xabc" };
    assert.equal(await onceLive("object", async () => value), value, "same reference, not a copy");
    assert.equal(await onceLive("undefined", async () => undefined), undefined);
    assert.equal(await onceLive("zero", async () => 0), 0);
  });
});
