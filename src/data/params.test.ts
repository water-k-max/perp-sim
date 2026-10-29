import assert from "node:assert/strict";
import test from "node:test";
import type { MarketConfig } from "../history/market.js";
import { applyParams, ParameterTimeline } from "./params.js";
import type { EpochRow } from "./types.js";

const live: MarketConfig = {
  symbol: "BTC",
  quoteSymbol: "USDso",
  pool: "0xpool",
  marginBank: "0xbank",
  stopRegistry: null,
  baseDecimals: 8,
  quoteDecimals: 18,
  oneBase: 10n ** 8n,
  tickSize: 1n,
  lotSize: 1n,
  minQuantity: 1n,
  imBps: 500n,
  mmBps: 250n,
  closeOutBps: 125n,
  effectiveImfBps: 500n,
  maxPositionSize: 9_000n,
  maxOpenInterest: 90_000n,
  takerFeeBpsTimes1k: 5_000n,
  makerFeeBpsTimes1k: 1_000n,
  fundingWindowSec: 3600,
  fundingIntervalSec: 3600,
  imBpsMismatch: false,
};

const epoch = (blockNumber: number, timestamp: number, over: Partial<EpochRow> = {}): EpochRow => ({
  blockNumber,
  timestamp,
  initialMarginBps: 700n,
  maintenanceMarginBps: 350n,
  closeOutMarginBps: 175n,
  takerFeeBpsTimes1k: 0n,
  makerFeeBpsTimes1k: 0n,
  maxPositionSize: 1_000n,
  maxOpenInterest: 2_000n,
  insuranceFundShareBps: 0n,
  source: "Event",
  ...over,
});

const epochs = [epoch(100, 1_000), epoch(300, 3_000), epoch(200, 2_000)];

test("epochs sort and resolve to the newest at or before a block", () => {
  const t = new ParameterTimeline(epochs, live);
  assert.deepEqual(t.blocks(), [100, 200, 300]);
  assert.equal(t.epochAtBlock(99), null);
  assert.equal(t.epochAtBlock(100)?.blockNumber, 100);
  assert.equal(t.epochAtBlock(299)?.blockNumber, 200);
  assert.equal(t.epochAtBlock(10_000)?.blockNumber, 300);
});

test("a block resolves by block number and a second by epoch timestamp", () => {
  const t = new ParameterTimeline(epochs, live);
  assert.equal(t.atBlock(250).epoch?.blockNumber, 200);
  assert.equal(t.at(2_500).epoch?.blockNumber, 200);
  assert.equal(t.at(1_500).epoch?.blockNumber, 100);
});

test("epoch values win over the live read, and origins say so", () => {
  const t = new ParameterTimeline(epochs, live);
  const at = t.atBlock(400);
  const cfg = applyParams(live, at);
  assert.equal(cfg.imBps, 700n);
  assert.equal(cfg.takerFeeBpsTimes1k, 0n, "a genuine zero fee must not fall back to the live read");
  assert.equal(cfg.maxPositionSize, 1_000n);
  assert.equal(at.origin.imBps, "epoch");
  assert.equal(at.missing.includes("imBps"), false);
  assert.equal(cfg.effectiveImfBps, 500n, "the account's effective IMF stays live");
});

test("a null epoch field falls back to the live read and is named", () => {
  const t = new ParameterTimeline([epoch(100, 1_000, { maxOpenInterest: null })], live);
  const at = t.atBlock(100);
  assert.equal(at.values.maxOpenInterest, 90_000n);
  assert.equal(at.origin.maxOpenInterest, "live");
  assert.deepEqual(at.missing, ["maxOpenInterest"]);
});

test("before the first epoch every field is live and declared missing", () => {
  const t = new ParameterTimeline(epochs, live);
  const at = t.atBlock(50);
  assert.equal(at.epoch, null);
  assert.equal(at.values.imBps, 500n);
  assert.equal(at.missing.length, 7);
  assert.ok(Object.values(at.origin).every((v) => v === "live"));
});

test("multiple epochs in one block resolve by log and hash full content", () => {
  const a = epoch(100, 1000, { logIndex: 2 });
  const b = epoch(100, 1000, { logIndex: 5, initialMarginBps: 900n });
  const timeline = new ParameterTimeline([b, a], live);
  assert.equal(timeline.atPosition(100, 1).epoch, null);
  assert.equal(timeline.atPosition(100, 2).values.imBps, 700n);
  assert.equal(timeline.atPosition(100, 4).values.imBps, 700n);
  assert.equal(timeline.atPosition(100, 5).values.imBps, 900n);
  assert.equal(timeline.at(1000n).values.imBps, 900n);
  assert.notEqual(timeline.digest(), new ParameterTimeline([a, { ...b, source: "changed" }], live).digest());
});

test("the digest names the epochs and is order-independent", () => {
  const a = new ParameterTimeline(epochs, live).digest();
  const b = new ParameterTimeline([...epochs].reverse(), live).digest();
  assert.equal(a, b);
  const c = new ParameterTimeline([epochs[0]!, epochs[1]!], live).digest();
  assert.notEqual(a, c);
});
