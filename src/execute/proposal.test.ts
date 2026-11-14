import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketConfig } from "../history/market.js";
import { buildProposal, type MarketState, type OrderRequest } from "./proposal.js";

/**
 *  A hand-computable market: two decimals on both legs, one lot = one tick = 10 raw units, 10% IMF.
 *  Every number below is derived by hand from `lockFor`/`staticGates`, so a canary fails if the
 *  proposal stops reusing that exact arithmetic (the adverse mark-to-entry term especially).
 */
const cfg: MarketConfig = {
  symbol: "BTC",
  quoteSymbol: "USDso",
  pool: `0x${"11".repeat(20)}`,
  marginBank: `0x${"22".repeat(20)}`,
  stopRegistry: null,
  baseDecimals: 2,
  quoteDecimals: 2,
  oneBase: 100n,
  tickSize: 10n,
  lotSize: 10n,
  minQuantity: 10n,
  imBps: 1000n,
  mmBps: 500n,
  closeOutBps: 250n,
  effectiveImfBps: 1000n,
  maxPositionSize: 1_000_000n,
  maxOpenInterest: 10_000_000n,
  takerFeeBpsTimes1k: 0n,
  makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 28800,
  fundingIntervalSec: 3600,
  imBpsMismatch: false,
};

const state: MarketState = { markPrice: 10_000n, openInterest: 0n };
const long = (over: Partial<OrderRequest> = {}): OrderRequest => ({ side: "long", size: "1", orderType: "limit", cash: "1000", ...over });

test("a long of one lot at the mark is placeable, under cap, with exact margin", () => {
  const p = buildProposal(cfg, long(), state, "100");
  // notional = size*price/oneBase = 100*10000/100 = 10000; IMF = ceil(10000*1000/10000) = 1000.
  assert.equal(p.sizeRaw, 100n);
  assert.equal(p.priceRaw, 10_000n);
  assert.equal(p.notionalRaw, 10_000n);
  assert.equal(p.initialMarginRaw, 1_000n);
  assert.equal(p.adverseGapRaw, 0n, "entry is at the mark, so nothing is reserved on top of IMF");
  assert.equal(p.lockRaw, 1_000n);
  assert.equal(p.placeable, true);
  assert.equal(p.binding, null);
  assert.equal(p.underCap, true);
  assert.equal(p.aligned, false);
  assert.equal(p.isBid, true);
  // Decimal strings at the edge, trailing-zero trimmed by fromRaw.
  assert.equal(p.notional, "100.0");
  assert.equal(p.initialMargin, "10.0");
  assert.equal(p.lock, "10.0");
  assert.equal(p.size, "1.0");
  assert.equal(p.price, "100.0");
  assert.equal(p.cash, "1000.0");
  assert.equal(p.cap, "100.0");
});

test("size aligns DOWN to the lot grid and flags that it moved", () => {
  const p = buildProposal(cfg, long({ size: "1.05" }), state, "100");
  assert.equal(p.sizeRaw, 100n, "1.05 -> 105 raw -> floor to the 10-lot = 100");
  assert.equal(p.aligned, true);
  assert.equal(p.requestedSize, "1.05");
});

test("a size below one lot is refused, never silently bumped up", () => {
  assert.throws(() => buildProposal(cfg, long({ size: "0.05" }), state, "100"), /below one lot/);
});

test("a non-positive size is refused before any grid math", () => {
  assert.throws(() => buildProposal(cfg, long({ size: "0" }), state, "100"), /positive base amount/);
});

test("price aligns to the tick grid", () => {
  const p = buildProposal(cfg, long({ price: "100.05" }), state, "100");
  assert.equal(p.priceRaw, 10_000n, "100.05 -> 10005 raw -> floor to the 10-tick = 10000");
});

test("an order over the notional cap is surfaced, not silently allowed", () => {
  const p = buildProposal(cfg, long(), state, "50");
  assert.equal(p.underCap, false, "notional 10000 raw > cap 5000 raw");
  assert.equal(p.placeable, true, "the cap is a send-time policy, not a placement gate");
});

test("collateral below the lock is unplaceable and names the binding gate", () => {
  const p = buildProposal(cfg, long({ cash: "5" }), state, "100");
  assert.equal(p.placeable, false);
  assert.equal(p.binding, "collateral");
});

test("a short flips isBid but keeps the same magnitude and margin", () => {
  const p = buildProposal(cfg, long({ side: "short" }), state, "100");
  assert.equal(p.isBid, false);
  assert.equal(p.sizeRaw, 100n);
  assert.equal(p.notionalRaw, 10_000n);
  assert.equal(p.initialMarginRaw, 1_000n);
  assert.equal(p.placeable, true);
});

test("an adverse limit price reserves the mark-to-entry gap ON TOP of initial margin", () => {
  // Long bidding 110 against a 100 mark: gap = (11000-10000)*100/100 = 1000, IMF on 11000 notional
  // = 1100, so the lock is 2100 — the term a naive `notional x IMF` estimate drops. This is the whole
  // reason the proposal reuses lockFor instead of re-deriving margin.
  const p = buildProposal(cfg, long({ price: "110" }), state, "100");
  assert.equal(p.notionalRaw, 11_000n);
  assert.equal(p.initialMarginRaw, 1_100n);
  assert.equal(p.adverseGapRaw, 1_000n);
  assert.equal(p.lockRaw, 2_100n);
  assert.equal(p.placeable, true, "the adverse gap is a warn, not a fail — it is reserved, not forbidden");
  const adverse = p.checks.find((c) => c.id === "adverseGap");
  assert.equal(adverse?.verdict, "warn");
});