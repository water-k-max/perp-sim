import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bar } from "../history/bars.js";
import type { ClosedTrade } from "../engine/portfolio.js";
import type { TapeFill } from "../data/types.js";
import { barIndexAt, extractTrades } from "./inputs.js";

const E18 = 10n ** 18n;
const oneBase = 10n ** 8n;

/** Hourly bars at t = 1000 + 3600*i with a chosen candle path. */
const bar = (i: number, low: bigint | null, high: bigint | null): Bar => ({
  t: 1_000 + i * 3_600, mark: 100n * E18, markSource: "mark", indexPrice: 100n * E18, cum: 0n, fundingDelta: 0n,
  rate: 0n, fundingWindowSec: 3600, fundingIntervalSec: 3600, intervalsSettled: 1, intervalsAccrued: 1,
  forgivenIntervals: 0, anchorResynced: false, gapSec: 3600, missedIntervals: 0, low, high, candles: 1,
});

const trade = (over: Partial<ClosedTrade>): ClosedTrade => ({
  seq: 1, t: 1_000 + 3_600, side: "long", size: oneBase, entryPrice: 100n * E18, exitPrice: 101n * E18,
  grossPnl: 1n * E18, funding: 0n, fee: 0n, gas: 0n, netPnl: 1n * E18, heldSec: 3_600, fillId: null, ...over,
});

const print = (t: number, price: bigint): TapeFill => ({
  id: `${t}`, block: 1, logIndex: 0, t, price, size: oneBase, quote: price, takerIsBid: null,
  maker: null, taker: null, txHash: "0x0",
});

test("barIndexAt places a timestamp in the bar whose interval contains it", () => {
  const bars = [bar(0, null, null), bar(1, null, null), bar(2, null, null)];
  assert.equal(barIndexAt(bars, 500), 0);      // before the first bar's t: first bar
  assert.equal(barIndexAt(bars, 1_000), 0);    // exactly on a settlement
  assert.equal(barIndexAt(bars, 1_001), 1);
  assert.equal(barIndexAt(bars, 4_600), 1);    // exactly on the second settlement
  assert.equal(barIndexAt(bars, 99_999), 2);   // past the end: last bar
  assert.equal(barIndexAt([], 1_000), null);
});

test("MAE/MFE come from the candle path of the bars the position lived through", () => {
  // Entry at t=1000 (bar 0), exit at t=4600 (bar 1): window covers bars 0..1.
  const bars = [bar(0, 90n * E18, 110n * E18), bar(1, 95n * E18, 105n * E18), bar(2, 10n * E18, 200n * E18)];
  const list = extractTrades([trade({})], { bars, oneBase });
  assert.equal(list.trades.length, 1);
  const rec = list.trades[0]!;
  assert.equal(rec.barsHeld, 1);
  assert.equal(rec.sameBar, false);
  assert.equal(rec.excursionSource, "candles");
  // Long from 100: worst observed 90, best observed 110, size 1 whole base.
  assert.equal(rec.worstPrice, 90n * E18);
  assert.equal(rec.bestPrice, 110n * E18);
  assert.equal(rec.mae, -10n * E18);
  assert.equal(rec.mfe, 10n * E18);
  assert.equal(list.withoutExcursionCount, 0);
});

test("bars outside the holding window never touch the excursion", () => {
  // Entry at t=4600 (bar 1), exit at t=8200 (bar 2): bar 0's wild path must be excluded.
  const bars = [bar(0, 1n * E18, 500n * E18), bar(1, 90n * E18, 110n * E18), bar(2, 95n * E18, 105n * E18)];
  const rec = extractTrades([trade({ t: 1_000 + 7_200, heldSec: 3_600 })], { bars, oneBase }).trades[0]!;
  assert.equal(rec.worstPrice, 90n * E18);
  assert.equal(rec.bestPrice, 110n * E18);
  assert.equal(rec.barsHeld, 1);
});

test("a trade opened and closed inside one settlement interval is same-bar", () => {
  const bars = [bar(0, 90n * E18, 110n * E18), bar(1, null, null)];
  // Entry 1001 s, exit 1200 s: both inside bar 1's interval (1000, 4600].
  const rec = extractTrades([trade({ t: 1_200, heldSec: 199 })], { bars, oneBase }).trades[0]!;
  assert.equal(rec.barsHeld, 0);
  assert.equal(rec.sameBar, true);
  const list = extractTrades([trade({ t: 1_200, heldSec: 199 })], { bars, oneBase });
  assert.equal(list.sameBarCount, 1);
});

test("short excursions invert: worst is the high side", () => {
  const bars = [bar(0, 90n * E18, 120n * E18)];
  const rec = extractTrades([trade({ t: 1_500, heldSec: 500, side: "short" })], { bars, oneBase }).trades[0]!;
  assert.equal(rec.worstPrice, 120n * E18);
  assert.equal(rec.bestPrice, 90n * E18);
  assert.equal(rec.mae, -20n * E18); // short from 100 rose to 120
  assert.equal(rec.mfe, 10n * E18);  // and fell to 90
});

test("a bar without a candle path falls back to the tape prints in the window", () => {
  const bars = [bar(0, null, null), bar(1, null, null)];
  const tape = [print(1_100, 88n * E18), print(4_000, 115n * E18), print(9_999, 1n * E18)];
  const rec = extractTrades([trade({})], { bars, tape, oneBase }).trades[0]!;
  assert.equal(rec.excursionSource, "tape");
  assert.equal(rec.worstPrice, 88n * E18);
  assert.equal(rec.bestPrice, 115n * E18);
});

test("tape prints outrank candle extremes when both cover the holding window", () => {
  // The candle bars would say 90/110; tape prints inside the exact window say 97/104.
  // A settlement bar spans time before entry and after exit, so its extremes overstate
  // what the position could have seen — the tape window is the exact one and must win.
  const bars = [bar(0, 90n * E18, 110n * E18), bar(1, 95n * E18, 105n * E18)];
  const tape = [print(500, 70n * E18), print(1_500, 97n * E18), print(4_000, 104n * E18), print(9_999, 1n * E18)];
  const rec = extractTrades([trade({})], { bars, tape, oneBase }).trades[0]!;
  assert.equal(rec.excursionSource, "tape");
  assert.equal(rec.worstPrice, 97n * E18);
  assert.equal(rec.bestPrice, 104n * E18);
  assert.equal(rec.mae, -3n * E18);
  assert.equal(rec.mfe, 4n * E18);
});

test("tape with no print inside the holding window falls back to candles", () => {
  // Prints exist, but only before entry and after exit: the candle path is the fallback.
  const bars = [bar(0, 90n * E18, 110n * E18), bar(1, 95n * E18, 105n * E18)];
  const tape = [print(200, 70n * E18), print(9_999, 130n * E18)];
  const rec = extractTrades([trade({})], { bars, tape, oneBase }).trades[0]!;
  assert.equal(rec.excursionSource, "candles");
  assert.equal(rec.worstPrice, 90n * E18);
  assert.equal(rec.bestPrice, 110n * E18);
});

test("with neither candles nor tape the trade is counted as without excursion", () => {
  const bars = [bar(0, null, null)];
  const list = extractTrades([trade({ t: 1_500, heldSec: 500 })], { bars, oneBase });
  assert.equal(list.trades[0]!.excursionSource, "none");
  assert.equal(list.trades[0]!.mae, null);
  assert.equal(list.withoutExcursionCount, 1);
});

test("the trade window spans entry to exit", () => {
  const bars = [bar(0, null, null), bar(1, null, null), bar(2, null, null)];
  const trades = [trade({ seq: 1, t: 4_600, heldSec: 3_600 }), trade({ seq: 2, t: 1_000 + 7_200, heldSec: 0 })];
  const list = extractTrades(trades, { bars, oneBase });
  assert.equal(list.window.from, 1_000);
  assert.equal(list.window.to, 8_200);
  assert.equal(list.trades.length, 2);
});
