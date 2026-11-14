import { encodeFunctionData, type Address, type Hex } from "viem";
import { erc20WriteAbi, marginBankWriteAbi, perpPoolWriteAbi } from "@somnia-chain/markets-sdk";

/**
 *  The exact bytes a perp order would send, encoded with the venue SDK's own exported ABIs and
 *  viem — no signer, no network, no key. This is the dry-run preview: it lets the lab show precisely
 *  what a live placement would broadcast, and it is pure so a test can pin it.
 *
 *  The argument order and defaults mirror the SDK's own perp wire call (`placeOrder(isBid, 0,
 *  price, quantity, expiry, orderType, 0, ZERO_ADDRESS, 0)`), so the preview and a live placement
 *  agree. `expireTimestampNs` is required rather than defaulted here: the caller computes it once
 *  and passes the same value to both the preview and the live order, so they cannot drift.
 */

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** ORDER_TYPE on the pool: 0 limit (GTC), 2 market (IOC). */
export const ORDER_TYPE = { LIMIT: 0, MARKET: 2 } as const;

/** A GTC expiry ~50 years out, in nanoseconds — the same horizon the SDK defaults to. */
export function farFutureExpiryNs(nowMs: number = Date.now()): bigint {
  return (BigInt(nowMs) + 50n * 365n * 86_400n * 1_000n) * 1_000_000n;
}

export type UnsignedCall = { to: Address; data: Hex; value: bigint; description: string };

export type PerpOrderCall = {
  pool: Address;
  isBid: boolean;
  /** Raw quote units per whole base. */
  price: bigint;
  /** Raw base units. */
  quantity: bigint;
  orderType: number;
  expireTimestampNs: bigint;
};

export function encodePlaceOrder(c: PerpOrderCall): UnsignedCall {
  const data = encodeFunctionData({
    abi: perpPoolWriteAbi,
    functionName: "placeOrder",
    args: [c.isBid, 0n, c.price, c.quantity, c.expireTimestampNs, c.orderType, 0, ZERO_ADDRESS, 0n],
  });
  return {
    to: c.pool,
    data,
    value: 0n,
    description: `placeOrder ${c.isBid ? "buy/long" : "sell/short"} qty ${c.quantity} price ${c.price} type ${c.orderType}`,
  };
}

export function encodeDeposit(marginBank: Address, amount: bigint): UnsignedCall {
  const data = encodeFunctionData({ abi: marginBankWriteAbi, functionName: "deposit", args: [amount] });
  return { to: marginBank, data, value: 0n, description: `MarginBank.deposit ${amount}` };
}

export function encodeApprove(collateral: Address, spender: Address, amount: bigint): UnsignedCall {
  const data = encodeFunctionData({ abi: erc20WriteAbi, functionName: "approve", args: [spender, amount] });
  return { to: collateral, data, value: 0n, description: `collateral.approve ${spender} ${amount}` };
}