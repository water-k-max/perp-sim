import type { MarketConfig } from "../history/market.js";
import { lockFor, staticGates, type Check, type Intent } from "../pretrade/gates.js";
import type { Side } from "../engine/simulate.js";
import { fromRaw, toRaw } from "../units.js";

/**
 *  The order proposal: what the lab would place, priced with the same pre-trade gates the pre-flight
 *  check uses. No new arithmetic — `staticGates`/`lockFor` already compute the exact notional, the
 *  initial margin, the adverse mark-to-entry reserve and the liquidation price from the market's own
 *  decimals and grid. This module turns a human order into that intent, aligns it to the lot and tick
 *  grids, and carries both the exact raw units (for the executor) and decimal strings (for the edge).
 *
 *  Size is aligned DOWN to the lot grid and never silently bumped up: an order below one lot is
 *  refused, not resized into something the operator did not ask for. The notional cap is surfaced
 *  (`underCap`) rather than enforced here — the policy kernel is what refuses to send over it.
 */

export type OrderRequest = {
  side: Side;
  /** Decimal base amount. */
  size: string;
  /** Decimal quote price; omitted or blank means the mark. */
  price?: string;
  orderType: "limit" | "market";
  /** Decimal quote collateral the bankruptcy/margin gates are measured against. */
  cash: string;
};

export type MarketState = { markPrice: bigint; openInterest: bigint };

export type OrderProposal = {
  symbol: string;
  quoteSymbol: string;
  pool: string;
  marginBank: string;
  side: Side;
  isBid: boolean;
  orderType: "limit" | "market";
  baseDecimals: number;
  quoteDecimals: number;
  sizeRaw: bigint;
  priceRaw: bigint;
  markPriceRaw: bigint;
  notionalRaw: bigint;
  lockRaw: bigint;
  initialMarginRaw: bigint;
  adverseGapRaw: bigint;
  liquidationPriceRaw: bigint | null;
  cashRaw: bigint;
  capRaw: bigint;
  size: string;
  price: string;
  markPrice: string;
  notional: string;
  lock: string;
  initialMargin: string;
  liquidationPrice: string | null;
  cash: string;
  cap: string;
  underCap: boolean;
  placeable: boolean;
  binding: string | null;
  checks: Check[];
  requestedSize: string;
  aligned: boolean;
};

export function buildProposal(cfg: MarketConfig, req: OrderRequest, state: MarketState, capDecimal: string): OrderProposal {
  const cashRaw = toRaw(req.cash, cfg.quoteDecimals);
  const capRaw = toRaw(capDecimal, cfg.quoteDecimals);

  const requestedSizeRaw = toRaw(req.size, cfg.baseDecimals);
  if (requestedSizeRaw <= 0n) throw new Error("size must be a positive base amount.");
  const sizeRaw = requestedSizeRaw - (requestedSizeRaw % cfg.lotSize);
  const aligned = sizeRaw !== requestedSizeRaw;
  if (sizeRaw <= 0n) throw new Error(`size ${req.size} is below one lot (${fromRaw(cfg.lotSize, cfg.baseDecimals)} ${cfg.symbol}); nothing to place.`);

  const markPriceRaw = state.markPrice;
  const priceInput = req.price !== undefined && req.price.trim() !== "" ? toRaw(req.price, cfg.quoteDecimals) : markPriceRaw;
  if (priceInput <= 0n) throw new Error("price must be a positive quote amount.");
  const priceRaw = priceInput - (priceInput % cfg.tickSize);
  if (priceRaw <= 0n) throw new Error("price aligns to zero on the tick grid; it is too small for this market.");

  const intent: Intent = { side: req.side, size: sizeRaw, price: priceRaw };
  const gates = staticGates(cfg, intent, { cash: cashRaw, markPrice: markPriceRaw, openInterest: state.openInterest });
  const { notional } = lockFor(cfg, intent, markPriceRaw);

  return {
    symbol: cfg.symbol,
    quoteSymbol: cfg.quoteSymbol,
    pool: cfg.pool,
    marginBank: cfg.marginBank,
    side: req.side,
    isBid: req.side === "long",
    orderType: req.orderType,
    baseDecimals: cfg.baseDecimals,
    quoteDecimals: cfg.quoteDecimals,
    sizeRaw,
    priceRaw,
    markPriceRaw,
    notionalRaw: notional,
    lockRaw: gates.lock,
    initialMarginRaw: gates.initialMargin,
    adverseGapRaw: gates.adverseGap,
    liquidationPriceRaw: gates.liquidationPrice,
    cashRaw,
    capRaw,
    size: fromRaw(sizeRaw, cfg.baseDecimals),
    price: fromRaw(priceRaw, cfg.quoteDecimals),
    markPrice: fromRaw(markPriceRaw, cfg.quoteDecimals),
    notional: fromRaw(notional, cfg.quoteDecimals),
    lock: fromRaw(gates.lock, cfg.quoteDecimals),
    initialMargin: fromRaw(gates.initialMargin, cfg.quoteDecimals),
    liquidationPrice: gates.liquidationPrice === null ? null : fromRaw(gates.liquidationPrice, cfg.quoteDecimals),
    cash: fromRaw(cashRaw, cfg.quoteDecimals),
    cap: fromRaw(capRaw, cfg.quoteDecimals),
    underCap: notional <= capRaw,
    placeable: gates.placeable,
    binding: gates.binding,
    checks: gates.checks,
    requestedSize: req.size,
    aligned,
  };
}