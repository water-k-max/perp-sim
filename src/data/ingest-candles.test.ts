import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle, FundingRateUpdate, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import type { MarketConfig } from "../history/market.js";
import { buildBars, withIntraBarPath } from "../history/bars.js";

/**
 *  Live pools settle 704s past the hour while candle buckets are hour-aligned, so the
 *  bucket covering the first bar OPENS BEFORE the first settlement. Fetching candles from
 *  the first settlement's timestamp dropped that bucket and left bar 0 without an
 *  intra-bar path in every window — every run reported PARTIAL RESULT. These canaries pin
 *  the one-interval-earlier fetch and the attachment it enables.
 */
const HOUR = 3_600;
const T0 = 3_600_000 + 704;
const SETTLEMENTS = 4;
const FIRST_BUCKET = T0 - 704;

const settlement = (i: number): FundingRateUpdate =>
  ({
    id: `${1000 + i}_0`,
    timestamp: BigInt(T0 + i * HOUR),
    blockNumber: BigInt(100 + i),
    markPrice: 100n * 10n ** 18n,
    indexPrice: 100n * 10n ** 18n,
    cumulativeFundingPerUnit: BigInt(i),
    fundingRate: 0n,
    fundingWindowSec: 28_800,
    fundingIntervalSec: HOUR,
    intervalsSettled: 1,
    intervalsAccrued: 1,
    anchorResynced: false,
  }) as unknown as FundingRateUpdate;

const candle = (bucketStart: number): Candle =>
  ({ bucketStart: BigInt(bucketStart), open: 100n, high: 101n, low: 99n, close: 100n }) as unknown as Candle;

const cfg = {
  symbol: "TEST",
  quoteSymbol: "USDso",
  pool: "0xpool",
  marginBank: "0xmargin",
  stopRegistry: null,
  baseDecimals: 8,
  quoteDecimals: 6,
  oneBase: 10n ** 8n,
  tickSize: 10n ** 16n,
  lotSize: 1n,
  minQuantity: 0n,
  imBps: 500n,
  mmBps: 250n,
  closeOutBps: 125n,
  effectiveImfBps: 500n,
  maxPositionSize: 10n ** 12n,
  maxOpenInterest: 10n ** 15n,
  takerFeeBpsTimes1k: 0n,
  makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 28_800,
  fundingIntervalSec: 3_600,
  imBpsMismatch: false,
} as unknown as MarketConfig;

test("candle fetch starts one interval before the first settlement, so every bar keeps its intra-bar path", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-ingest-"));
  process.env.PERP_SIM_CACHE = root;
  const originalFetch = globalThis.fetch;
  // epochWindow reads over plain fetch; an empty epoch table only adds a warning.
  globalThis.fetch = (async () => Response.json({ data: { PerpPoolParametersEpoch: [] } })) as typeof fetch;
  const rows = Array.from({ length: SETTLEMENTS }, (_, i) => settlement(i));
  const buckets = Array.from({ length: SETTLEMENTS }, (_, i) => FIRST_BUCKET + i * HOUR);
  const candleCalls: { from: number; to: number }[] = [];
  const client = {
    listFundingRateHistory: async (_pool: string, args: { from: number; to: number }) =>
      rows.filter((r) => Number(r.timestamp) >= args.from && Number(r.timestamp) <= args.to),
    getCandles: async (_pool: string, _interval: number, args: { from: number; to: number }) => {
      candleCalls.push({ from: args.from, to: args.to });
      return buckets.filter((b) => b >= args.from && b <= args.to).map(candle);
    },
  } as unknown as SomniaMarketsClient;
  try {
    const { loadMarketData } = await import("./ingest.js");
    const data = await loadMarketData(client, cfg, {
      fromSec: T0 - HOUR,
      toSec: T0 + (SETTLEMENTS - 1) * HOUR + 1,
      refresh: true,
    });
    assert.equal(candleCalls.length, 1, "one page covers the window");
    // The read must start at or before the first hour bucket, but no more than one
    // interval early — the bucket at/before the first settlement is exactly what bar 0 needs.
    assert.ok(candleCalls[0]!.from <= FIRST_BUCKET, "candle fetch must reach the bucket before the first settlement");
    assert.ok(candleCalls[0]!.from > FIRST_BUCKET - HOUR, "candle fetch must not reach a second interval back");
    assert.equal(data.manifest.version, 4, "re-fetched datasets invalidate old caches");
    const bars = withIntraBarPath(buildBars(data.funding), data.candles3600);
    assert.equal(bars[0]!.candles, 1, "bar 0 gets the pre-settlement bucket");
    assert.equal(bars[0]!.low, 99n);
    assert.equal(bars.filter((b) => b.low !== null).length, bars.length, "every bar covered");
    assert.equal(data.complete, true);
    assert.ok(!data.warnings.some((w) => /candle/i.test(w)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("the pre-settlement hour bucket attaches to bar 0; a feed starting at the settlement drops it", () => {
  const bars = buildBars([settlement(0), settlement(1)]);
  const covered = withIntraBarPath(bars, [candle(FIRST_BUCKET), candle(FIRST_BUCKET + HOUR)]);
  assert.equal(covered[0]!.candles, 1, "bucket opening 704s before the settlement belongs to bar 0");
  assert.equal(covered[0]!.low, 99n);
  assert.equal(covered[1]!.candles, 1);
  // What the old fetch delivered: buckets from the first settlement's timestamp onward,
  // leaving bar 0 with no intra-bar path while bar 1 stayed covered.
  const bare = withIntraBarPath(bars, [candle(FIRST_BUCKET + HOUR)]);
  assert.equal(bare[0]!.candles, 0);
  assert.equal(bare[0]!.low, null);
  assert.equal(bare[1]!.candles, 1);
});
