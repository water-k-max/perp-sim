import type { PerpMarket, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { retryRead } from "../retry.js";

/**
 *  One perp market, with every constant a backtest needs resolved from the chain and the
 *  market row — and nothing hardcoded. `oneBase` is derived from `baseDecimals`, which
 *  ranges 6..24 across the live Hideki pools, so assuming 1e18 misprices 12 of 21 markets.
 */
export type MarketConfig = {
  symbol: string;
  quoteSymbol: string;
  pool: string;
  marginBank: string;
  stopRegistry: string | null;
  baseDecimals: number;
  quoteDecimals: number;
  /** 10^baseDecimals — one whole synthetic base in raw base units. */
  oneBase: bigint;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  imBps: bigint;
  mmBps: bigint;
  closeOutBps: bigint;
  /** The IMF actually applied to this account/pool, which can exceed the listed one. */
  effectiveImfBps: bigint;
  maxPositionSize: bigint;
  maxOpenInterest: bigint;
  takerFeeBpsTimes1k: bigint;
  makerFeeBpsTimes1k: bigint;
  fundingWindowSec: number;
  fundingIntervalSec: number;
  /** The indexer's `initialMarginBps` disagreed with the chain's, so the caller can say so. */
  imBpsMismatch: boolean;
};

export async function listPerps(client: SomniaMarketsClient): Promise<PerpMarket[]> {
  return retryRead("listPerpMarkets", () => client.listPerpMarkets({ limit: 200 }));
}

/** Accepts a base symbol (`BTC`), a pair (`BTC/USDso`) or a pool address. */
export function selectMarket(rows: readonly PerpMarket[], selector: string): PerpMarket {
  const wanted = selector.trim().toUpperCase();
  const byAddress = wanted.startsWith("0X") ? wanted.slice(2) : null;
  const match = rows.find((r) =>
    byAddress !== null
      ? r.poolAddress.toLowerCase() === `0x${byAddress.toLowerCase()}`
      : (r.baseSymbol ?? "").toUpperCase() === wanted ||
        `${r.baseSymbol ?? ""}/${r.quoteSymbol ?? ""}`.toUpperCase() === wanted,
  );
  if (!match) {
    const known = rows.map((r) => r.baseSymbol ?? "?").join(", ");
    throw new Error(`no perp market matching "${selector}". Available: ${known || "(none)"}`);
  }
  if (match.baseDecimals === null || match.baseDecimals === undefined) {
    throw new Error(`market ${match.baseSymbol} has no baseDecimals; cannot derive oneBase`);
  }
  return match;
}

export async function resolveConfig(
  client: SomniaMarketsClient,
  market: PerpMarket,
): Promise<MarketConfig> {
  const pool = market.poolAddress;
  const risk = await retryRead(`getPerpRiskParams ${market.baseSymbol}`, () => client.getPerpRiskParams(pool));
  const effectiveImfBps = await retryRead(`getEffectiveImfBps ${market.baseSymbol}`, () => client.getEffectiveImfBps(pool));
  const oneBase = 10n ** BigInt(market.baseDecimals);
  return {
    symbol: market.baseSymbol ?? market.poolAddress.slice(0, 10),
    quoteSymbol: market.quoteSymbol ?? "USDso",
    pool: market.poolAddress,
    marginBank: market.marginBank,
    stopRegistry: market.stopRegistry,
    baseDecimals: market.baseDecimals,
    quoteDecimals: market.quoteDecimals,
    oneBase,
    tickSize: BigInt(market.tickSize),
    lotSize: BigInt(market.lotSize),
    minQuantity: BigInt(market.minQuantity),
    imBps: risk.initialMarginBps,
    mmBps: risk.maintenanceMarginBps,
    closeOutBps: risk.closeOutMarginBps,
    effectiveImfBps,
    maxPositionSize: risk.maxPositionSize,
    maxOpenInterest: risk.maxOpenInterest,
    takerFeeBpsTimes1k: risk.takerFeeBpsTimes1k,
    makerFeeBpsTimes1k: risk.makerFeeBpsTimes1k,
    fundingWindowSec: market.fundingWindowSec as number,
    fundingIntervalSec: market.fundingIntervalSec as number,
    imBpsMismatch: BigInt(market.initialMarginBps) !== risk.initialMarginBps,
  };
}
