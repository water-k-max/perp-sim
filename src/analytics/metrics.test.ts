import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { run } from "../engine/loop.js";
import { fixedPosition } from "../strategy/fixed.js";
import { computeMetrics, markouts, metricsView } from "./metrics.js";
import { attribute } from "./attribution.js";
import { isqrt, sqrtScaled, toDecimal } from "./decimal.js";

const E18 = 10n ** 18n;
const oneBase = 10n ** 8n;

const cfg: MarketConfig = {
  symbol: "BTC", quoteSymbol: "USDso", pool: "0xpool", marginBank: "0xbank", stopRegistry: null,
  baseDecimals: 8, quoteDecimals: 18, oneBase, tickSize: 1n, lotSize: 1n, minQuantity: 1n,
  imBps: 500n, mmBps: 250n, closeOutBps: 125n, effectiveImfBps: 500n,
  maxPositionSize: 10n ** 30n, maxOpenInterest: 10n ** 30n,
  takerFeeBpsTimes1k: 0n, makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 3600, fundingIntervalSec: 3600, imBpsMismatch: false,
};

const bar = (i: number, mark: bigint): Bar => ({
  t: 1_000 + i * 3_600, mark, markSource: "mark", indexPrice: mark, cum: 0n, fundingDelta: 0n,
  rate: 0n, fundingWindowSec: 3600, fundingIntervalSec: 3600, intervalsSettled: 1, intervalsAccrued: 1,
  forgivenIntervals: 0, anchorResynced: false, gapSec: 3600, missedIntervals: 0, low: mark, high: mark, candles: 1,
});

const marks = [100n, 101n, 80n, 103n, 102n, 104n];
const bars = marks.map((m, i) => bar(i, m * E18));

test("integer square root is exact on squares and floors otherwise", () => {
  assert.equal(isqrt(0n), 0n);
  assert.equal(isqrt(1n), 1n);
  assert.equal(isqrt(144n), 12n);
  assert.equal(isqrt(145n), 12n);
  assert.equal(sqrtScaled(2n, 1_000n), 1_414n);
  assert.equal(toDecimal(12345n, 1_000n, 2), "12.34");
  assert.equal(toDecimal(-12345n, 1_000n, 2), "-12.34");
});

test("metrics come from the equity series, not from the trades", async () => {
  const out = await run({
    cfg, bars, cash: 1_000n * E18,
    strategy: fixedPosition({ side: "long", size: oneBase, atBar: 1 }),
    fillModel: "settlement-mark",
  });
  const m = computeMetrics(out);
  assert.equal(m.bars, out.trail.length);
  assert.equal(m.periodsPerYear, 8_760);
  assert.equal(m.totalReturnBps, (((out.equityEnd - out.equityStart) * 10_000n) / out.equityStart));
  assert.equal(m.trades, 1);
  assert.equal(m.wins, out.trades[0]!.netPnl > 0n ? 1 : 0);
  assert.ok(m.sharpeX1e4 !== null, "varying returns give a Sharpe");
  assert.ok(m.maxDrawdownBps !== null && m.maxDrawdownBps > 0n, "101 -> 80 is a drawdown");
  assert.ok(m.turnoverBps !== null && m.turnoverBps > 0n);
  const view = metricsView(m);
  assert.equal(typeof view.sharpe, "string");
});

test("a flat run has no trades and no Sharpe, and says so as null", async () => {
  const out = await run({
    cfg, bars, cash: 1_000n * E18,
    strategy: fixedPosition({ side: "long", size: 0n, atBar: 1 }),
    fillModel: "settlement-mark",
  });
  const m = computeMetrics(out);
  assert.equal(m.trades, 0);
  assert.equal(m.winRateBps, null);
  assert.equal(m.avgTrade, null);
  assert.equal(m.sharpeX1e4, null);
  assert.equal(m.totalReturnBps, 0n);
  assert.equal(m.maxDrawdownBps, 0n);
});

test("attribution reconciles exactly and exposes no residual on a clean run", async () => {
  const out = await run({
    cfg, bars, cash: 1_000n * E18,
    strategy: fixedPosition({ side: "long", size: oneBase, atBar: 1 }),
    fillModel: "settlement-mark",
  });
  const a = attribute(out);
  assert.equal(a.residual, 0n);
  assert.equal(a.delta, a.price - a.funding - a.feesTaker - a.feesMaker - a.gas);
});

test("markouts look up a later price and sign by direction", () => {
  const fill = {
    id: "f", orderId: "o", side: "buy" as const, size: oneBase, price: 100n * E18, quote: 100n * E18,
    t: 1_000, role: "taker" as const, fee: 0n, feeBps: 0n, consumedFillIds: [], tag: null,
  };
  const priceAt = (t: number) => (t === 1_060 ? 101n * E18 : null);
  assert.equal(markouts([fill], priceAt, 60), 100n, "1 quote on 100 is 100 bps");
  assert.equal(markouts([{ ...fill, side: "sell" }], priceAt, 60), -100n);
  assert.equal(markouts([fill], () => null, 60), null);
});
