import assert from "node:assert/strict";
import test from "node:test";
import { hashMarketData } from "./ingest.js";
import type { MarketData } from "./types.js";

test("market hash covers unchanged-ID row mutations and provenance, not capture time", () => {
  const data = { manifest: { version: 3, chainId: 1, pool: "pool", market: "BTC", range: { fromSec: 1, toSec: 2, fromBlock: 3, toBlock: 4 }, rows: { funding: 1, candles3600: 1, epochs: 1 }, sha256: "", indexer: "source", sdkVersion: "test", capturedAt: "today" }, funding: [{ id: "funding", amount: 1n }], candles3600: [{ bucketStart: 1, lastFillId: "fill", close: 1n }], epochs: [{ blockNumber: 3, logIndex: 2, initialMarginBps: 500n }], complete: true, warnings: [] } as unknown as MarketData;
  const hash = hashMarketData(data);
  const mutate = (fn: (d: any) => void) => { const d = structuredClone(data); fn(d); assert.notEqual(hashMarketData(d), hash); };
  mutate(d => d.funding[0].amount++);
  mutate(d => d.candles3600[0].close++);
  mutate(d => d.epochs[0].initialMarginBps++);
  mutate(d => d.epochs[0].logIndex++);
  mutate(d => d.complete = false);
  mutate(d => d.manifest.indexer = "other");
  mutate(d => d.manifest.chainId++);
  mutate(d => d.manifest.range.toBlock++);
  data.manifest.capturedAt = "tomorrow";
  data.manifest.sha256 = "unrelated";
  assert.equal(hashMarketData(data), hash);
});
