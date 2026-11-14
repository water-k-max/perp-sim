import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { perpPoolWriteAbi } from "@somnia-chain/markets-sdk";
import type { MarketConfig } from "../history/market.js";
import { executeOrder, type ExecuteDeps, type ExecuteInput, type PerpWriter } from "./executor.js";
import { ExecutionRefused } from "./policy.js";
import type { MarketState, OrderRequest } from "./proposal.js";
import { farFutureExpiryNs, ORDER_TYPE } from "./calldata.js";

const cfg: MarketConfig = {
  symbol: "BTC", quoteSymbol: "USDso", pool: `0x${"11".repeat(20)}`, marginBank: `0x${"22".repeat(20)}`, stopRegistry: null,
  baseDecimals: 2, quoteDecimals: 2, oneBase: 100n, tickSize: 10n, lotSize: 10n, minQuantity: 10n,
  imBps: 1000n, mmBps: 500n, closeOutBps: 250n, effectiveImfBps: 1000n,
  maxPositionSize: 1_000_000n, maxOpenInterest: 10_000_000n, takerFeeBpsTimes1k: 0n, makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 28800, fundingIntervalSec: 3600, imBpsMismatch: false,
};
const state: MarketState = { markPrice: 10_000n, openInterest: 0n };
const COLLATERAL: Address = `0x${"33".repeat(20)}`;
const KEY: Hex = `0x${"ab".repeat(32)}`;
const NOW = 1_700_000_000_000;
const EXPIRY = farFutureExpiryNs(NOW);
const req: OrderRequest = { side: "long", size: "1", orderType: "limit", cash: "1000" };

const base = (over: Partial<ExecuteInput> = {}): ExecuteInput => ({
  cfg, req, state, mode: "local", confirm: true, enabled: true, dryRun: false,
  privateKey: KEY, capDecimal: "100", collateral: COLLATERAL, deposit: "1000", nowMs: NOW, ...over,
});

/** A writer that records every call, so a test can prove what was (and was not) sent. */
function recorder() {
  const seen: { created: number; key?: Hex; deposit?: bigint; order?: Parameters<PerpWriter["placePerpOrder"]>[0] } = { created: 0 };
  const deps: ExecuteDeps = {
    createWriter: (key) => {
      seen.created += 1;
      seen.key = key;
      return {
        depositMargin: async (p) => { seen.deposit = p.amount; return { hash: `0x${"de".repeat(32)}` }; },
        placePerpOrder: async (p) => { seen.order = p; return { hash: `0x${"0d".repeat(32)}`, orderId: 7n }; },
      };
    },
  };
  return { deps, seen };
}

/** A writer factory that must never be reached — the dry-run and refusal canary. */
const forbidden: ExecuteDeps = { createWriter: () => { throw new Error("a writer was constructed on a path that must not send"); } };

test("dry-run previews the exact calldata and never constructs a writer", async () => {
  const r = await executeOrder(base({ enabled: false }), forbidden);
  assert.equal(r.action, "preview");
  if (r.action !== "preview") return;
  // approve -> deposit -> placeOrder, in the order a live placement would broadcast.
  assert.equal(r.calls.length, 3);
  assert.match(r.calls[0].description, /approve/);
  assert.match(r.calls[1].description, /deposit/);
  assert.match(r.calls[2].description, /placeOrder/);
  assert.equal(r.calls[2].value, 0n, "a perp placeOrder is non-payable");
  assert.equal(r.proposal.notionalRaw, 10_000n);
});

test("DRY_RUN=true previews even when enabled, and never constructs a writer", async () => {
  const r = await executeOrder(base({ dryRun: true }), forbidden);
  assert.equal(r.action, "preview");
});

test("a deployment can never send: the writer is never reached", async () => {
  await assert.rejects(() => executeOrder(base({ mode: "serverless" }), forbidden), ExecutionRefused);
});

test("live without a confirm is refused before any writer is built", async () => {
  await assert.rejects(() => executeOrder(base({ confirm: false }), forbidden), ExecutionRefused);
});

test("live without a key is refused before any writer is built", async () => {
  await assert.rejects(() => executeOrder(base({ privateKey: undefined }), forbidden), ExecutionRefused);
});

test("live over the notional cap is refused before any writer is built", async () => {
  await assert.rejects(() => executeOrder(base({ capDecimal: "50" }), forbidden), ExecutionRefused);
});

test("an unplaceable order is refused before any writer is built", async () => {
  await assert.rejects(() => executeOrder(base({ req: { ...req, cash: "5" } }), forbidden), ExecutionRefused);
});

test("the live allow arm deposits then places, with the exact grid-aligned args", async () => {
  const { deps, seen } = recorder();
  const r = await executeOrder(base(), deps);
  assert.equal(r.action, "send");
  if (r.action !== "send") return;
  assert.equal(seen.created, 1, "exactly one writer, built only on the live arm");
  assert.equal(seen.key, KEY);
  assert.equal(seen.deposit, 100_000n, "deposit 1000 at 2dp = 100000 raw");
  assert.deepEqual(seen.order, {
    pool: cfg.pool, isBid: true, price: 10_000n, quantity: 100n,
    expireTimestampNs: EXPIRY, orderType: ORDER_TYPE.LIMIT,
  });
  assert.equal(r.hash, `0x${"0d".repeat(32)}`);
  assert.equal(r.orderId, 7n);
  assert.equal(r.depositHash, `0x${"de".repeat(32)}`);
});

test("the live order carries the same expiry the preview encoded", async () => {
  const { deps, seen } = recorder();
  const live = await executeOrder(base(), deps);
  const preview = await executeOrder(base({ enabled: false }), forbidden);
  assert.equal(live.action, "send");
  assert.equal(preview.action, "preview");
  if (live.action !== "send" || preview.action !== "preview") return;
  const decoded = decodeFunctionData({ abi: perpPoolWriteAbi, data: preview.calls[2].data });
  assert.equal(decoded.functionName, "placeOrder");
  assert.equal(decoded.args[4], seen.order!.expireTimestampNs, "preview and live must agree on the expiry, or they are different orders");
  assert.equal(decoded.args[4], EXPIRY);
});

test("a live order with no deposit skips depositMargin and still places", async () => {
  const { deps, seen } = recorder();
  const r = await executeOrder(base({ deposit: "" }), deps);
  assert.equal(r.action, "send");
  assert.equal(seen.deposit, undefined, "no deposit was asked for, so none was sent");
  assert.ok(seen.order, "the order was still placed");
  if (r.action === "send") assert.equal(r.depositHash, undefined);
});

test("a market order encodes ORDER_TYPE.MARKET on both arms", async () => {
  const { deps, seen } = recorder();
  await executeOrder(base({ req: { ...req, orderType: "market" } }), deps);
  assert.equal(seen.order!.orderType, ORDER_TYPE.MARKET);
  const preview = await executeOrder(base({ enabled: false, req: { ...req, orderType: "market" } }), forbidden);
  if (preview.action === "preview") assert.match(preview.calls[2].description, /type 2/);
});