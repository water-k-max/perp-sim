import type { Candle, FundingRateUpdate } from "@somnia-chain/markets-sdk";

/** One executed trade from the pool's tape, normalised to raw protocol units. */
export type TapeFill = {
  /** `${blockNumber}_${logIndex}` — the SDK's stable fill identity. */
  id: string;
  block: number;
  logIndex: number;
  /** Unix seconds. */
  t: number;
  /** Raw quote units per whole base. */
  price: bigint;
  /** Raw base units filled. */
  size: bigint;
  /** Raw quote units paid, as the chain recorded it (floored by the contract). */
  quote: bigint;
  /** True when the aggressor bought. Null when the indexer has not bridged the taker side. */
  takerIsBid: boolean | null;
  maker: string | null;
  taker: string | null;
  txHash: string;
};

/** An inclusive window, in both the units a replay needs. */
export type DataRange = {
  fromSec: number;
  toSec: number;
  fromBlock: number;
  toBlock: number;
};

/**
 *  What identifies a dataset. Two runs over the same manifest saw the same rows, so a
 *  result difference is a model difference, not a data difference.
 */
export type DataManifest = {
  version: 2 | 3;
  chainId: number;
  pool: string;
  market: string;
  range: DataRange;
  rows: {
    funding: number;
    candles3600: number;
    epochs: number;
  };
  /** sha256 over the canonical serialisation of everything above plus the row digests. */
  sha256: string;
  indexer: string;
  sdkVersion: string;
  capturedAt: string;
};

/** A market's history, ready to replay. The tape is fetched in slices, around executions. */
export type MarketData = {
  manifest: DataManifest;
  funding: FundingRateUpdate[];
  /** 3600 s buckets: intra-bar maintenance checks and arrival prices. */
  candles3600: Candle[];
  epochs: EpochRow[];
  /** False when any read hit its page budget before the window ended. */
  complete: boolean;
  warnings: string[];
};

/** One resolved per-pool risk/fee epoch. Absent fields fall back to the live read. */
export type EpochRow = {
  blockNumber: number;
  logIndex?: number;
  timestamp: number;
  initialMarginBps: bigint | null;
  maintenanceMarginBps: bigint | null;
  closeOutMarginBps: bigint | null;
  takerFeeBpsTimes1k: bigint | null;
  makerFeeBpsTimes1k: bigint | null;
  maxPositionSize: bigint | null;
  maxOpenInterest: bigint | null;
  insuranceFundShareBps: bigint | null;
  source: string;
};
