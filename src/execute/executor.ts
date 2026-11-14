import type { Address, Hash, Hex } from "viem";
import type { MarketConfig } from "../history/market.js";
import { toRaw } from "../units.js";
import { decideExecution, ExecutionRefused, type ExecutionMode } from "./policy.js";
import { buildProposal, type MarketState, type OrderProposal, type OrderRequest } from "./proposal.js";
import { encodeApprove, encodeDeposit, encodePlaceOrder, farFutureExpiryNs, ORDER_TYPE, type UnsignedCall } from "./calldata.js";

/**
 *  The one place an order is previewed or sent. It reuses the pre-trade proposal for the exact money
 *  and the policy kernel for the send/refuse decision, then either encodes the bytes a live placement
 *  would broadcast (preview) or drives the venue SDK's own writer (live).
 *
 *  The writer is INJECTED and only constructed on the live arm: a dry-run never builds a signer, never
 *  touches the network and never sends. The same `expireTimestampNs` is computed once and shared by the
 *  preview calldata and the live order, so the two cannot drift.
 */

/** The subset of the SDK Trader this module drives — structurally satisfied by the real Trader. */
export type PerpWriter = {
  depositMargin(params: { marginBank: Address; amount: bigint }): Promise<{ hash: Hash }>;
  placePerpOrder(params: {
    pool: Address;
    isBid: boolean;
    price: bigint;
    quantity: bigint;
    expireTimestampNs: bigint;
    orderType: number;
  }): Promise<{ hash: Hash; orderId?: bigint }>;
};

export type ExecuteDeps = {
  /** Build a write-capable trader from the operator's key. Called ONLY on the live arm. */
  createWriter: (privateKey: Hex) => PerpWriter;
};

export type ExecuteInput = {
  cfg: MarketConfig;
  req: OrderRequest;
  state: MarketState;
  mode: ExecutionMode;
  confirm: boolean;
  enabled: boolean;
  dryRun: boolean;
  /** The operator's key. Present only locally; the policy sees just whether one exists. */
  privateKey?: Hex;
  /** Decimal quote ceiling on one order's notional, converted at the market's quoteDecimals. */
  capDecimal: string;
  /** Collateral token address, for the preview's approve calldata. */
  collateral: Address;
  /** Decimal collateral to deposit before placing (live), and to show in the preview. Omit/blank = skip. */
  deposit?: string;
  /** Clock for the GTC expiry; injected so a test can pin preview and live to the same value. */
  nowMs?: number;
};

export type PreviewResult = {
  action: "preview";
  reason: string;
  proposal: OrderProposal;
  /** Exactly what a live placement would broadcast, in order. Never sent. */
  calls: UnsignedCall[];
};

export type SendResult = {
  action: "send";
  proposal: OrderProposal;
  depositHash?: Hash;
  hash: Hash;
  orderId?: bigint;
};

export type ExecuteResult = PreviewResult | SendResult;

export async function executeOrder(input: ExecuteInput, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { cfg, req, state } = input;
  const capRaw = toRaw(input.capDecimal, cfg.quoteDecimals);
  const proposal = buildProposal(cfg, req, state, input.capDecimal);

  const decision = decideExecution(
    { enabled: input.enabled, dryRun: input.dryRun, hasKey: input.privateKey !== undefined, maxNotional: capRaw },
    { mode: input.mode, confirm: input.confirm, notional: proposal.notionalRaw, placeable: proposal.placeable },
  );

  const depositRaw = input.deposit !== undefined && input.deposit.trim() !== "" ? toRaw(input.deposit, cfg.quoteDecimals) : 0n;
  const expireTimestampNs = farFutureExpiryNs(input.nowMs);
  const orderType = req.orderType === "market" ? ORDER_TYPE.MARKET : ORDER_TYPE.LIMIT;
  const orderCall = encodePlaceOrder({
    pool: cfg.pool as Address,
    isBid: proposal.isBid,
    price: proposal.priceRaw,
    quantity: proposal.sizeRaw,
    orderType,
    expireTimestampNs,
  });

  if (decision.action === "preview") {
    const calls: UnsignedCall[] = [];
    if (depositRaw > 0n) {
      calls.push(encodeApprove(input.collateral, cfg.marginBank as Address, depositRaw));
      calls.push(encodeDeposit(cfg.marginBank as Address, depositRaw));
    }
    calls.push(orderCall);
    return { action: "preview", reason: decision.reason, proposal, calls };
  }

  // Live. The policy has already refused every unsafe arm; the key is guaranteed present here.
  const privateKey = input.privateKey;
  if (privateKey === undefined) throw new ExecutionRefused("Live execution requires PRIVATE_KEY; none is configured.");
  const writer = deps.createWriter(privateKey);

  let depositHash: Hash | undefined;
  if (depositRaw > 0n) {
    const deposited = await writer.depositMargin({ marginBank: cfg.marginBank as Address, amount: depositRaw });
    depositHash = deposited.hash;
  }
  const placed = await writer.placePerpOrder({
    pool: cfg.pool as Address,
    isBid: proposal.isBid,
    price: proposal.priceRaw,
    quantity: proposal.sizeRaw,
    expireTimestampNs,
    orderType,
  });

  return { action: "send", proposal, depositHash, hash: placed.hash, orderId: placed.orderId };
}