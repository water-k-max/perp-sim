import assert from "node:assert/strict";
import test from "node:test";
import type { MarketConfig } from "../history/market.js";
import { matchAgainstTape, PROFILES } from "./fills.js";
import type { TapeFill } from "../data/types.js";

const E18 = 10n ** 18n;
const oneBase = 10n ** 8n;
const cfg: MarketConfig = {
  symbol: "BTC",
  quoteSymbol: "USDso",
  pool: "0xpool",
  marginBank: "0xbank",
  stopRegistry: null,
  baseDecimals: 8,
  quoteDecimals: 18,
  oneBase,
  tickSize: 1n,
  lotSize: oneBase / 10n,
  minQuantity: 1n,
  imBps: 500n,
  mmBps: 250n,
  closeOutBps: 125n,
  effectiveImfBps: 500n,
  maxPositionSize: 10n ** 30n,
  maxOpenInterest: 10n ** 30n,
  takerFeeBpsTimes1k: 10_000n,
  makerFeeBpsTimes1k: 10_000n,
  fundingWindowSec: 3600,
  fundingIntervalSec: 3600,
  imBpsMismatch: false,
};

let n = 0;
const fill = (t: number, takerIsBid: boolean, sizeBase: number, whole: bigint): TapeFill => {
  n += 1;
  return {
    id: `f${n}`,
    block: 1,
    logIndex: n,
    t,
    price: whole * E18,
    size: BigInt(Math.round(sizeBase * 1e8)),
    quote: 0n,
    takerIsBid,
    maker: null,
    taker: null,
    txHash: "0x",
  };
};

test("a buy takes only buy-aggressor prints, in tape order", () => {
  const tape = [
    fill(100, true, 1, 100n),
    fill(101, false, 5, 90n),
    fill(102, true, 1, 101n),
  ];
  const r = matchAgainstTape(tape, { side: "buy", size: 2n * oneBase, limit: null, eligibleAt: 100 }, "optimistic", cfg);
  assert.equal(r.filled, 2n * oneBase);
  assert.equal(r.quote, (oneBase * 100n * E18) / oneBase + (oneBase * 101n * E18) / oneBase);
  assert.equal(r.vwap, (1005n * E18) / 10n);
  assert.deepEqual(r.consumedFillIds, [tape[0]!.id, tape[2]!.id]);
  assert.equal(r.reason, "filled");
});

test("the profile caps how much of the window flow an order may take", () => {
  const tape = [fill(100, true, 4, 100n)];
  const opt = matchAgainstTape(tape, { side: "buy", size: 4n * oneBase, limit: null, eligibleAt: 100 }, "optimistic", cfg);
  const real = matchAgainstTape(tape, { side: "buy", size: 4n * oneBase, limit: null, eligibleAt: 100 }, "realistic", cfg);
  const cons = matchAgainstTape(tape, { side: "buy", size: 4n * oneBase, limit: null, eligibleAt: 100 }, "conservative", cfg);
  assert.equal(opt.filled, 4n * oneBase);
  assert.equal(real.filled, oneBase, "a quarter of four base is one");
  assert.equal(real.reason, "partial");
  assert.equal(cons.filled, oneBase / 5n, "5% of four base is 0.2, two lots");
  assert.equal(cons.reason, "partial");
  assert.equal(cons.volumeCap, (4n * oneBase * 5n) / 100n);
  assert.equal(real.volumeCap, oneBase);
});

test("the profile window bounds which prints count", () => {
  const tape = [fill(100, true, 1, 100n), fill(110, true, 1, 100n), fill(135, true, 1, 100n)];
  const five = matchAgainstTape(tape, { side: "buy", size: 10n * oneBase, limit: null, eligibleAt: 100 }, "optimistic", cfg);
  const thirty = matchAgainstTape(tape, { side: "buy", size: 10n * oneBase, limit: null, eligibleAt: 100 }, "realistic", cfg);
  assert.equal(five.windowVolume, oneBase, "5 s window holds only the first print");
  assert.equal(thirty.windowVolume, 2n * oneBase, "30 s holds the print at 110, not the one at 135");
  assert.equal(PROFILES.realistic.windowSec, 30);
});

test("a limit skips prints past it instead of filling at the mark", () => {
  const tape = [fill(100, true, 2, 102n), fill(101, true, 2, 99n)];
  const r = matchAgainstTape(tape, { side: "buy", size: 2n * oneBase, limit: 100n * E18, eligibleAt: 100 }, "optimistic", cfg);
  assert.equal(r.filled, 2n * oneBase);
  assert.equal(r.vwap, 99n * E18);
});

test("size is floored to the lot size and cannot exceed the request", () => {
  const tape = [fill(100, true, 1, 100n)];
  const r = matchAgainstTape(tape, { side: "buy", size: oneBase / 100n, limit: null, eligibleAt: 100 }, "optimistic", cfg);
  assert.equal(r.filled, 0n, "a hundredth of a lot cannot fill");
  assert.equal(r.reason, "no-liquidity");
});

test("a sell takes sell-aggressor prints", () => {
  const tape = [fill(100, false, 2, 100n), fill(101, true, 2, 100n)];
  const r = matchAgainstTape(tape, { side: "sell", size: 2n * oneBase, limit: null, eligibleAt: 100 }, "optimistic", cfg);
  assert.equal(r.filled, 2n * oneBase);
  assert.ok(r.consumedFillIds.includes(tape[0]!.id));
  assert.ok(!r.consumedFillIds.includes(tape[1]!.id));
});
