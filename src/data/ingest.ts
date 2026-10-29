import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import type { MarketConfig } from "../history/market.js";
import { candleWindow, fundingWindow } from "../history/indexer.js";
import { config } from "../config.js";
import { epochWindow } from "./graphql.js";
import { datasetKey, readDataset, sha256, writeDataset } from "./store.js";
import type { DataManifest, DataRange, MarketData } from "./types.js";

const require = createRequire(import.meta.url);

/** The package pins `exports`, so the version is read beside the resolved entry. */
function sdkVersion(): string {
  try {
    const entry = require.resolve("@somnia-chain/markets-sdk");
    const root = entry.slice(0, entry.indexOf("/dist/"));
    return (JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}
const SDK_VERSION = sdkVersion();

export type IngestOptions = {
  /** Re-read the indexer even when a matching dataset is cached. */
  refresh?: boolean;
  /** Turn the settled window into block bounds and an inclusive second range. */
  fromSec: number;
  toSec: number;
};

/**
 *  Everything a replay needs that is bounded by the window itself: settlements, hourly
 *  candles and the parameter epochs that governed them.
 *
 *  The trade tape is deliberately NOT here. Hideki perp pools carry on the order of
 *  100k fills a day, so a whole window is minutes of paging for data a run never reads;
 *  `createTapeSource` fetches it in short slices around each execution instead.
 *
 *  The window is resolved to block bounds from the settlements themselves: the first and
 *  last settlement of the window are events whose blocks the indexer has, by definition,
 *  already processed, so a later tape read can never ask for blocks the indexer cannot
 *  serve.
 */
export async function loadMarketData(
  client: SomniaMarketsClient,
  cfg: MarketConfig,
  options: IngestOptions,
): Promise<MarketData> {
  if (!(options.toSec > options.fromSec)) throw new Error("history window must end after it starts");
  const key = datasetKey({
    kind: "perp-market-data",
    version: 3,
    chainId: config.chainId,
    source: config.indexerUrl,
    pool: cfg.pool.toLowerCase(),
    fromSec: options.fromSec,
    toSec: options.toSec,
  });
  if (!options.refresh) {
    const hit = await readDataset<MarketData>(key);
    if (hit) {
      if (hit.manifest.version !== 3 || hit.manifest.sha256 !== hashMarketData(hit)) throw new Error("Market data semantic hash mismatch");
      return hit;
    }
  }

  const warnings: string[] = [];
  const funding = await fundingWindow(client, cfg.pool, options.fromSec, options.toSec);
  if (!funding.complete) warnings.push("Funding history was truncated by the page budget; the window is not fully covered.");
  if (funding.rows.length < 2) throw new Error(`only ${funding.rows.length} settlement(s) in the window; widen it`);

  const range: DataRange = {
    fromSec: Number(funding.rows[0].timestamp),
    toSec: Number(funding.rows[funding.rows.length - 1].timestamp),
    fromBlock: Number(BigInt(funding.rows[0].blockNumber)),
    toBlock: Number(BigInt(funding.rows[funding.rows.length - 1].blockNumber)),
  };

  const candles3600 = await candleWindow(client, cfg.pool, 3600, range.fromSec, range.toSec);
  if (!candles3600.complete) warnings.push("Hourly candles were truncated; some bars have no intra-bar path.");

  const epochs = await epochWindow(cfg.pool, range.fromBlock, range.toBlock);
  if (epochs.length === 0) warnings.push("No parameter epochs indexed for this window; current chain parameters are used throughout.");

  const manifest: DataManifest = {
    version: 3,
    chainId: config.chainId,
    pool: cfg.pool.toLowerCase(),
    market: cfg.symbol,
    range,
    rows: {
      funding: funding.rows.length,
      candles3600: candles3600.rows.length,
      epochs: epochs.length,
    },
    sha256: "",
    indexer: config.indexerUrl,
    sdkVersion: SDK_VERSION,
    capturedAt: new Date().toISOString(),
  };

  const data: MarketData = {
    manifest,
    funding: funding.rows,
    candles3600: candles3600.rows,
    epochs,
    complete: funding.complete && candles3600.complete,
    warnings,
  };
  manifest.sha256 = hashMarketData(data);
  await writeDataset(key, data);
  return data;
}

/** Semantic identity excludes capture time and the self-referential manifest hash. */
export function hashMarketData(data: MarketData): string {
  const { capturedAt: _capturedAt, sha256: _hash, ...manifest } = data.manifest;
  return sha256({ ...data, manifest, epochs: [...data.epochs].sort((a, b) => a.blockNumber - b.blockNumber || (a.logIndex ?? 0) - (b.logIndex ?? 0)) });
}
