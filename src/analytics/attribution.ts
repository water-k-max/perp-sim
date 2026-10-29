import type { RunResult } from "../engine/loop.js";

/**
 *  Where the equity change came from, as signed contributions that must sum to it:
 *
 *      Δequity = price - funding - fees - gas + residual
 *
 *  `price` is built from the closed trades plus the open position marked at the last bar,
 *  not from the equity change itself, so the residual is a real check: it is zero when the
 *  books balance and nonzero when they do not. A residual is never rounded away.
 */
export type Attribution = {
  price: bigint;
  funding: bigint;
  feesTaker: bigint;
  feesMaker: bigint;
  gas: bigint;
  residual: bigint;
  delta: bigint;
};

export function attribute(result: RunResult): Attribution {
  const closedPrice = result.trades.reduce((sum, t) => sum + t.grossPnl, 0n);
  const last = result.trail[result.trail.length - 1];
  const openPrice = result.fundingOpen === 0n ? 0n : (last?.unrealizedPnl ?? 0n);
  const price = closedPrice + (result.status === "open" ? openPrice : 0n);
  const funding = result.fundingSettled + result.fundingOpen;
  const delta = result.equityEnd - result.equityStart;
  const residual = delta - (price - funding - result.feesTaker - result.feesMaker - result.gasPaid);
  return {
    price,
    funding,
    feesTaker: result.feesTaker,
    feesMaker: result.feesMaker,
    gas: result.gasPaid,
    residual,
    delta,
  };
}

export function attributionView(a: Attribution): Record<string, string> {
  return {
    price: a.price.toString(),
    funding: a.funding.toString(),
    feesTaker: a.feesTaker.toString(),
    feesMaker: a.feesMaker.toString(),
    gas: a.gas.toString(),
    residual: a.residual.toString(),
    delta: a.delta.toString(),
  };
}
