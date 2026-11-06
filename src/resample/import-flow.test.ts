import assert from "node:assert/strict";
import { test } from "node:test";
import { runImportFlow, type ImportFlowDeps } from "./import-flow.js";
import { parseImport } from "./import.js";
import { selectMarket } from "../history/market.js";
import type { Candle, FundingRateUpdate, PerpMarket, SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { MarketConfig } from "../history/market.js";
import type { MarketData } from "../data/types.js";

const Q6 = 10n ** 6n;

const CFG: MarketConfig = {
  symbol: "TEST", quoteSymbol: "USDso", pool: "0x" + "1".repeat(40), marginBank: "0x" + "2".repeat(40),
  stopRegistry: null, baseDecimals: 6, quoteDecimals: 6, oneBase: Q6, tickSize: 10n, lotSize: 10n,
  minQuantity: 10n, imBps: 5000n, mmBps: 2500n, closeOutBps: 1250n, effectiveImfBps: 5000n,
  maxPositionSize: Q6, maxOpenInterest: 1000n * Q6, takerFeeBpsTimes1k: 500n, makerFeeBpsTimes1k: 100n,
  fundingWindowSec: 3600, fundingIntervalSec: 3600, imBpsMismatch: false,
};

const T0 = 3_600_000;

function fundingRow(t: number): FundingRateUpdate {
  return {
    id: `0xpool_1_0`, pool: CFG.pool, fundingRate: "0", cumulativeFundingPerUnit: "0",
    indexPrice: "100000000", markPrice: "100000000", intervalsSettled: "1", intervalsAccrued: "1",
    fundingWindowSec: 3600, fundingIntervalSec: 3600, spanStart: String(t - 3600), spanEnd: String(t),
    anchorResynced: false, timestamp: String(t), blockNumber: "1", txHash: "0x" + "0".repeat(64),
  };
}

function candleRow(bucketStart: number, low: string, high: string): Candle {
  return {
    bucketStart: String(bucketStart), openPrice: "100000000", high, low, closePrice: "100000000",
    baseVolume: "1000000", quoteVolume: "100000000", tradeCount: 3, lastFillId: "1_0",
  };
}

const DATA: MarketData = {
  manifest: {
    version: 4, chainId: 50383, pool: CFG.pool, market: "TEST",
    range: { fromSec: T0 - 3599, toSec: T0 + 400, fromBlock: 1, toBlock: 2 },
    rows: { funding: 2, candles3600: 2, epochs: 0 }, sha256: "0".repeat(64),
    indexer: "http://indexer.test", sdkVersion: "test", capturedAt: "2026-01-01T00:00:00.000Z",
  },
  funding: [fundingRow(T0), fundingRow(T0 + 3600)],
  candles3600: [candleRow(T0, "99000000", "101000000"), candleRow(T0 + 3600, "99500000", "100500000")],
  epochs: [],
  complete: true,
  warnings: [],
};

const CSV = [
  "side,entryTime,exitTime,pnl,size,entryPrice,fee,funding",
  `long,${T0 - 100},${T0 + 100},-1.5,2,100,0.1,0.05`,
  `short,${T0 + 100},${T0 + 200},0.5,1,100.25,0.1,-0.02`,
  `long,${T0 + 8000},${T0 + 8100},2,1.5,99.9,0.1,0`,
].join("\n");

function fakeDeps(data: MarketData | null, seen?: { fromSec: number; toSec: number }[]): ImportFlowDeps {
  return {
    createClient: () => ({}) as unknown as SomniaMarkets,
    listPerps: async () => [{ poolAddress: CFG.pool, baseSymbol: "TEST", quoteSymbol: "USDso", baseDecimals: 6 }] as unknown as PerpMarket[],
    selectMarket,
    resolveConfig: async () => CFG,
    loadMarketData: async (_client, _cfg, options) => {
      seen?.push({ fromSec: options.fromSec, toSec: options.toSec });
      if (data === null) throw new Error("indexer unreachable");
      return data;
    },
  };
}

test("the import flow resolves the market, rebuilds bars from market data and returns the wire shape", async () => {
  const seen: { fromSec: number; toSec: number }[] = [];
  const outcome = await runImportFlow(parseImport({ payload: CSV, market: "TEST", startingCash: "1000" }), fakeDeps(DATA, seen));
  // The ingest window opens one interval earlier than the first entry, matching the replay.
  assert.deepEqual(seen, [{ fromSec: T0 - 100 - 3599, toSec: T0 + 8100 }]);
  assert.match(outcome.runId, /^[a-f0-9]{64}$/);
  assert.equal(outcome.market, "TEST");
  assert.equal(outcome.quoteSymbol, "USDso");
  assert.equal(outcome.tradeCount, 3);
  assert.equal(outcome.resample.version, 3);
  assert.equal(outcome.resample.meta.source.kind, "import");
  assert.equal(outcome.resample.distributions.length, 2); // default mode "both"
  assert.equal(outcome.resample.input.withoutExcursionCount, 1); // trade 3 lies beyond the last bar
  assert.ok(outcome.resample.invariants.every((i) => i.status === "pass"), outcome.resample.invariants.map((i) => `${i.id}:${i.status}`).join(","));
});

test("the same import through the flow is deterministic", async () => {
  const a = await runImportFlow(parseImport({ payload: CSV, market: "TEST", startingCash: "1000" }), fakeDeps(DATA));
  const b = await runImportFlow(parseImport({ payload: CSV, market: "TEST", startingCash: "1000" }), fakeDeps(DATA));
  assert.deepEqual(a, b);
});

test("a market that does not resolve is reported, not masked", async () => {
  const deps = fakeDeps(DATA);
  deps.listPerps = async () => [{ poolAddress: CFG.pool, baseSymbol: "OTHER", quoteSymbol: "USDso", baseDecimals: 6 }] as unknown as PerpMarket[];
  await assert.rejects(
    () => runImportFlow(parseImport({ payload: CSV, market: "TEST", startingCash: "1000" }), deps),
    /no perp market matching "TEST"/,
  );
});

test("a history load failure degrades to no excursion data and the flow still completes", async () => {
  const outcome = await runImportFlow(parseImport({ payload: CSV, market: "TEST", startingCash: "1000" }), fakeDeps(null));
  assert.equal(outcome.resample.input.withoutExcursionCount, 3);
  assert.ok(outcome.resample.warnings.some((w) => w.includes("could not be loaded")));
  // Without history there is no random-entry null: edge-realized-total is a skip, not a pass.
  assert.ok(outcome.resample.invariants.every((i) => i.status !== "fail"), outcome.resample.invariants.map((i) => `${i.id}:${i.status}`).join(","));
  assert.equal(outcome.resample.invariants.find((i) => i.id === "edge-realized-total")!.status, "skip");
});
