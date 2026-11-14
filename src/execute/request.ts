import type { Side } from "../engine/simulate.js";
import type { OrderRequest } from "./proposal.js";

/**
 *  The HTTP boundary for one order. It validates the request DTO before a market is read or a lane is
 *  asked for, so a malformed order is answered with its own 400 rather than spending a slot on it.
 *  The exact-money pricing — lot/tick alignment, positivity against the grid, the margin gates — stays
 *  in `buildProposal`; this only checks the shape and the decimal grammar the edge accepts, the same
 *  grammar the resample and backtest parsers use.
 *
 *  `confirm` is the caller's explicit, per-request acknowledgment that a live send is a real testnet
 *  transaction. It is never inferred from the environment: the policy kernel still requires
 *  EXECUTION_ENABLED and DRY_RUN=false on top of it, so a stray `confirm:true` cannot send on its own.
 */

export type ExecuteRequest = {
  market: string;
  order: OrderRequest;
  confirm: boolean;
  /** Decimal collateral to deposit before placing; omitted or blank skips the deposit. */
  deposit?: string;
};

const DECIMAL = /^\d{1,12}(\.\d{1,18})?$/;

function positiveDecimal(value: unknown, name: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive decimal amount.`);
  }
  return value;
}

/** A blank or absent optional decimal means "omit"; anything else must parse as a decimal. */
function optionalDecimal(value: unknown, name: string, allowZero: boolean): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  if (typeof value !== "string" || !DECIMAL.test(value) || (!allowZero && Number(value) <= 0)) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} decimal amount.`);
  }
  return value;
}

export function parseExecuteRequest(value: unknown): ExecuteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an order configuration.");
  const v = value as Record<string, unknown>;

  const market = v.market ?? "BTC";
  if (typeof market !== "string" || market.trim() === "" || market.length > 32) throw new Error("market must be a symbol string.");

  const side = v.side;
  if (side !== "long" && side !== "short") throw new Error("side must be long or short.");

  const orderType = v.orderType ?? "limit";
  if (orderType !== "limit" && orderType !== "market") throw new Error("orderType must be limit or market.");

  const size = positiveDecimal(v.size, "size");
  const cash = positiveDecimal(v.cash, "cash");
  const price = optionalDecimal(v.price, "price", false);
  const deposit = optionalDecimal(v.deposit, "deposit", true);

  const confirm = v.confirm ?? false;
  if (typeof confirm !== "boolean") throw new Error("confirm must be a boolean.");

  return { market: market.trim(), order: { side: side as Side, size, price, orderType, cash }, confirm, deposit };
}