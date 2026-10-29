import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import type { PositionBook } from "../engine/portfolio.js";

/** One order a strategy asks for. It is matched against the model, not sent anywhere. */
export type OrderRequest = {
  side: "buy" | "sell";
  /** Raw base units, positive. */
  size: bigint;
  /** Worst acceptable price, raw quote per whole base. Absent means market. */
  limit?: bigint;
  /** Clamp to the open position instead of flipping it. */
  reduceOnly?: boolean;
  /** Free-form label carried into the fill and order log. */
  tag?: string;
};

/** A fill the model produced, with enough provenance to audit it. */
export type ModeledFill = {
  id: string;
  orderId: string;
  side: "buy" | "sell";
  size: bigint;
  /** Raw quote per whole base. */
  price: bigint;
  /** Raw quote paid or received. */
  quote: bigint;
  t: number;
  block?: number;
  logIndex?: number;
  role: "taker" | "maker";
  fee: bigint;
  /** The `bps x 1000` rate the fee was charged at, so the invariant check can recompute it. */
  feeBps: bigint;
  /** Tape rows that priced this fill; empty when the settlement mark priced it. */
  consumedFillIds: string[];
  tag: string | null;
};

export type PositionView = {
  size: bigint;
  /** Weighted average entry across the open lots, or null when flat. */
  entryPrice: bigint | null;
  unrealized: bigint;
  accruedFunding: bigint;
  equity: bigint;
};

export type StrategyContext = {
  /** Actual event time, unix seconds. On fills, bar is the latest historical mark. */
  readonly now: number;
  /** Index of the bar in the run's series. */
  readonly index: number;
  readonly bar: Bar;
  /** Parameters in force at this bar. */
  readonly cfg: MarketConfig;
  readonly book: PositionBook;
  position(): PositionView;
  equity(): bigint;
  submit(order: OrderRequest): void;
  /** Close the whole position with a reduce-only market order. */
  close(tag?: string): void;
  log(message: string): void;
};

export type StrategyStart = { now: number; cfg: MarketConfig; log(message: string): void };
export type StrategyEnd = { now: number; book: PositionBook; equity: bigint; log(message: string): void };

/**
 *  What a strategy sees and does. `onBar` is the only required hook: it is called once per
 *  settlement bar, after that bar has been marked, and any order it submits is filled at the
 *  next opportunity the fill model defines.
 */
export type Strategy = {
  readonly id: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  onStart?(ctx: StrategyStart): void;
  onBar(ctx: StrategyContext): void;
  onFill?(ctx: StrategyContext, fill: ModeledFill): void;
  onEnd?(ctx: StrategyEnd): void;
};

/** Coerce a strategy parameter that a caller may have supplied as a number or a string. */
export function paramBigInt(params: Strategy["params"], key: string, fallback: bigint): bigint {
  const value = params[key];
  return value === undefined ? fallback : BigInt(value);
}

export function paramNumber(params: Strategy["params"], key: string, fallback: number): number {
  const value = params[key];
  return value === undefined ? fallback : Number(value);
}
