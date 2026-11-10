import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { run } from "../engine/loop.js";
import { fixedPosition } from "../strategy/fixed.js";
import { computeMetrics, markoutHorizonLabel, markoutHorizonsSec, markoutLadder, markoutView, metricsView, settlementPriceAt } from "./metrics.js";
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

test("a markout looks up a later price and signs by direction", () => {
  const fill = {
    id: "f", orderId: "o", side: "buy" as const, size: oneBase, price: 100n * E18, quote: 100n * E18,
    t: 1_000, role: "taker" as const, fee: 0n, feeBps: 0n, consumedFillIds: [], tag: null,
  };
  const priceAt = (t: number) => (t === 1_060 ? 101n * E18 : null);
  assert.equal(markoutLadder([fill], priceAt, [60])[0]!.markoutBps, 100n, "1 quote on 100 is 100 bps");
  assert.equal(markoutLadder([{ ...fill, side: "sell" }], priceAt, [60])[0]!.markoutBps, -100n, "favourable is the direction the position points");
  const unread = markoutLadder([fill], () => null, [60])[0]!;
  assert.equal(unread.markoutBps, null, "no printed mark is no number, not a zero");
  assert.equal(unread.observed, 0, "and the fill that was skipped is counted as unobserved");
});

test("settlementPriceAt gives the first mark at or after the second asked for", () => {
  const priceAt = settlementPriceAt(bars);
  assert.equal(priceAt(1_000), 100n * E18, "a settlement landing on the requested second is its own price");
  assert.equal(priceAt(1_001), 101n * E18, "one second past a settlement never reads back to the bar that just closed");
  assert.equal(priceAt(1_000 + 5 * 3_600), 104n * E18);
  assert.equal(priceAt(1_000 + 6 * 3_600), null, "past the series the horizon is unobservable");
  assert.equal(settlementPriceAt([])(0), null);
});

test("a horizon that never printed skips the fill instead of guessing it", () => {
  const fill = {
    id: "f", orderId: "o", side: "buy" as const, size: oneBase, price: 100n * E18, quote: 100n * E18,
    t: 1_000, role: "taker" as const, fee: 0n, feeBps: 0n, consumedFillIds: [], tag: null,
  };
  // fill.t + 1 h is bar 1's settlement exactly: 101 against a 100 fill.
  assert.deepEqual(markoutLadder([fill], settlementPriceAt(bars), [3_600]).map((r) => [r.markoutBps, r.observed, r.total]), [[100n, 1, 1]]);
  // With only two settlements the hour horizon is unreadable, so the fill is skipped, not guessed.
  assert.deepEqual(markoutLadder([fill], settlementPriceAt(bars.slice(0, 2)), [5 * 3_600]).map((r) => [r.markoutBps, r.observed, r.total]), [[null, 0, 1]], "total still reports the fill that was dropped");
});

const ladderFill = {
  id: "f", orderId: "o", side: "buy" as const, size: oneBase, price: 100n * E18, quote: 100n * E18,
  t: 1_000, role: "taker" as const, fee: 0n, feeBps: 0n, consumedFillIds: [], tag: null,
};

test("the ladder is read at whole settlement intervals, never below one", () => {
  assert.deepEqual(markoutHorizonsSec(3_600), [3_600, 14_400, 86_400], "hourly marks give 1 h / 4 h / 24 h");
  assert.deepEqual(markoutHorizonsSec(900), [900, 3_600, 21_600], "a 15-minute venue is asked 15 m / 1 h / 6 h, not a horizon that cannot differ from the next mark");
});

test("the ladder shows the shape of the curve and how much of it was observed", () => {
  const ladder = markoutLadder([ladderFill], settlementPriceAt(bars), markoutHorizonsSec(cfg.fundingIntervalSec));
  assert.deepEqual(ladder.map((r) => r.horizonSec), [3_600, 14_400, 86_400], "rungs come back in the order asked for");
  assert.equal(ladder[0]!.markoutBps, 100n, "one quote on 100 at the next mark");
  assert.equal(ladder[1]!.markoutBps, 200n, "four marks later the same fill reads 102 against its 100");
  assert.equal(ladder[2]!.markoutBps, null, "a horizon past the end of the window is unobserved, and unobserved is never zero");
  assert.deepEqual(ladder.map((r) => [r.observed, r.total]), [[1, 1], [1, 1], [0, 1]], "the long rung loses the only fill, and says so");
});

test("a ladder over no fills still has every rung, each observed zero times", () => {
  const ladder = markoutLadder([], settlementPriceAt(bars), markoutHorizonsSec(3_600));
  assert.equal(ladder.length, 3, "a run with no fills is a question not asked, not a missing row");
  assert.deepEqual(ladder.map((r) => [r.markoutBps, r.observed, r.total]), [[null, 0, 0], [null, 0, 0], [null, 0, 0]]);
});

test("a sell is signed the other way at every horizon of the ladder", () => {
  const ladder = markoutLadder([{ ...ladderFill, side: "sell" }], settlementPriceAt(bars), [3_600, 14_400]);
  assert.deepEqual(ladder.map((r) => r.markoutBps), [-100n, -200n], "favourable is positive for the direction the position points");
});

test("markoutView puts decimal strings and one shared label on the wire", () => {
  const view = markoutView(markoutLadder([ladderFill], settlementPriceAt(bars), markoutHorizonsSec(cfg.fundingIntervalSec)));
  assert.deepEqual(view.rungs.map((r) => r.label), ["1 h", "4 h", "24 h"]);
  assert.deepEqual(view.rungs.map((r) => r.bps), ["100", "200", null], "bigint never crosses the API edge");
  assert.deepEqual(view.rungs.map((r) => [r.observed, r.total]), [[1, 1], [1, 1], [0, 1]]);
});

test("the horizon label is the string both surfaces print", () => {
  assert.equal(markoutHorizonLabel(3_600), "1 h");
  assert.equal(markoutHorizonLabel(14_400), "4 h");
  assert.equal(markoutHorizonLabel(86_400), "24 h");
  assert.equal(markoutHorizonLabel(900), "15 m");
  assert.equal(markoutHorizonLabel(5_400), "90 m", "an hour and a half is not rounded to a whole hour");
  assert.equal(markoutHorizonLabel(61), "61s", "a horizon that is not a whole minute is printed in seconds");
});
