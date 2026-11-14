import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, type Address } from "viem";
import { marginBankWriteAbi, perpPoolWriteAbi } from "@somnia-chain/markets-sdk";
import { encodeApprove, encodeDeposit, encodePlaceOrder, farFutureExpiryNs, ORDER_TYPE, ZERO_ADDRESS } from "./calldata.js";

const POOL: Address = `0x${"11".repeat(20)}`;
const BANK: Address = `0x${"22".repeat(20)}`;
const EXPIRY = 2_000_000_000_000_000_000n;

test("placeOrder calldata round-trips to the exact wire args the SDK sends", () => {
  const call = encodePlaceOrder({ pool: POOL, isBid: true, price: 62_000n, quantity: 1_000n, orderType: ORDER_TYPE.MARKET, expireTimestampNs: EXPIRY });
  assert.equal(call.to, POOL);
  assert.equal(call.value, 0n, "a perp placeOrder is non-payable — margin comes from the bank");
  const decoded = decodeFunctionData({ abi: perpPoolWriteAbi, data: call.data });
  assert.equal(decoded.functionName, "placeOrder");
  assert.deepEqual(decoded.args, [true, 0n, 62_000n, 1_000n, EXPIRY, ORDER_TYPE.MARKET, 0, ZERO_ADDRESS, 0n]);
});

test("the selector is placeOrder's, and a different quantity is different bytes", () => {
  const a = encodePlaceOrder({ pool: POOL, isBid: true, price: 100n, quantity: 10n, orderType: ORDER_TYPE.LIMIT, expireTimestampNs: EXPIRY });
  const b = encodePlaceOrder({ pool: POOL, isBid: true, price: 100n, quantity: 11n, orderType: ORDER_TYPE.LIMIT, expireTimestampNs: EXPIRY });
  const selector = decodeFunctionData({ abi: perpPoolWriteAbi, data: a.data });
  assert.equal(selector.functionName, "placeOrder");
  assert.notEqual(a.data, b.data, "quantity must change the calldata — a canary against a stubbed encoder");
  assert.equal(a.data.slice(0, 10), b.data.slice(0, 10), "same function, same 4-byte selector");
});

test("side flips isBid, not the quantity sign", () => {
  const short = encodePlaceOrder({ pool: POOL, isBid: false, price: 100n, quantity: 10n, orderType: ORDER_TYPE.LIMIT, expireTimestampNs: EXPIRY });
  const decoded = decodeFunctionData({ abi: perpPoolWriteAbi, data: short.data });
  assert.equal(decoded.args[0], false);
  assert.equal(decoded.args[3], 10n, "quantity stays positive; direction is isBid");
});

test("deposit and approve encode against the bank and collateral ABIs", () => {
  const deposit = encodeDeposit(BANK, 5_000n);
  assert.equal(deposit.to, BANK);
  assert.deepEqual(decodeFunctionData({ abi: marginBankWriteAbi, data: deposit.data }).args, [5_000n]);
  const approve = encodeApprove(POOL, BANK, 5_000n);
  assert.equal(approve.to, POOL);
  assert.equal(approve.value, 0n);
});

test("the GTC expiry is ~50 years out and fits uint64", () => {
  const nowMs = 1_700_000_000_000;
  const ns = farFutureExpiryNs(nowMs);
  const fiftyYearsNs = 50n * 365n * 86_400n * 1_000_000_000n;
  assert.ok(ns > BigInt(nowMs) * 1_000_000n + fiftyYearsNs - 1_000_000_000n);
  assert.ok(ns < 2n ** 64n, "must fit the pool's uint64 expireTimestampNs");
});