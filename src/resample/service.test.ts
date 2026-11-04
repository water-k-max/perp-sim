import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { MarketConfig } from "../history/market.js";
import type { MarketData } from "../data/types.js";
import type { ClosedTrade } from "../engine/portfolio.js";
import type { ManifestInput } from "../runs/manifest.js";
import type { TapeFill } from "../data/types.js";

const root = await mkdtemp(join(tmpdir(), "perp-sim-resample-svc-"));
process.env.PERP_SIM_CACHE = root;

const { sha256, writeSnapshot } = await import("../data/store.js");
const { buildManifest } = await import("../runs/manifest.js");
const { saveRun, loadRun } = await import("../runs/store.js");
const { resampleStoredRun } = await import("./service.js");
const { loadResampleAnalysis } = await import("./store.js");

after(() => rm(root, { recursive: true, force: true }));

const E18 = 10n ** 18n;

function cfg(): MarketConfig {
  return {
    symbol: "BTC", quoteSymbol: "USD", pool: "pool", marginBank: "bank", stopRegistry: null,
    baseDecimals: 18, quoteDecimals: 6, oneBase: E18, tickSize: 10n, lotSize: 100n,
    minQuantity: 100n, imBps: 500n, mmBps: 300n, closeOutBps: 200n, effectiveImfBps: 500n,
    maxPositionSize: 10n ** 24n, maxOpenInterest: 10n ** 28n, takerFeeBpsTimes1k: 30n,
    makerFeeBpsTimes1k: 10n, fundingWindowSec: 3600, fundingIntervalSec: 60, imBpsMismatch: false,
  };
}

function marketData(): MarketData {
  const funding = Array.from({ length: 30 }, (_, i) => ({
    id: `${i + 1}_0`,
    timestamp: BigInt(1_000 + i * 3_600),
    markPrice: (100n + BigInt(i % 5)) * E18,
    indexPrice: (100n + BigInt(i % 5)) * E18,
    cumulativeFundingPerUnit: 0n,
    fundingRate: 0n,
    fundingWindowSec: 3600,
    anchorResynced: false,
    intervalsSettled: 1,
    intervalsAccrued: 1,
    fundingIntervalSec: 3600,
    blockNumber: i + 1,
  })) as unknown as MarketData["funding"];
  return {
    manifest: {
      version: 3, chainId: 50383, pool: "pool", market: "BTC",
      range: { fromSec: 1_000, toSec: 1_000 + 29 * 3_600, fromBlock: 1, toBlock: 30 },
      rows: { funding: funding.length, candles3600: 0, epochs: 0 }, sha256: "", indexer: "test", sdkVersion: "test",
      capturedAt: "2026-11-01T00:00:00.000Z",
    },
    funding,
    candles3600: [],
    epochs: [],
    complete: true,
    warnings: [],
  };
}

function closedTrades(): ClosedTrade[] {
  return Array.from({ length: 14 }, (_, i) => ({
    seq: i + 1,
    t: 1_000 + (i + 1) * 3_000,
    side: (i % 2 === 0 ? "long" : "short") as ClosedTrade["side"],
    size: E18,
    entryPrice: 100n * E18,
    exitPrice: (100n + BigInt((i % 3) - 1)) * E18,
    grossPnl: BigInt(((i * 11) % 9) - 4) * E18 / 10n,
    funding: 0n,
    fee: 10n ** 15n,
    gas: 0n,
    netPnl: BigInt(((i * 11) % 9) - 4) * E18 / 10n - 10n ** 15n,
    heldSec: 2_000,
    fillId: null,
  }));
}

async function savedRun() {
  const data = marketData();
  const manifestInput: ManifestInput = {
    cfg: cfg(), data,
    model: { fillModel: "settlement-mark", profile: null, latencySec: 1, windowSec: null, gasPerTx: 0n },
    strategy: { id: "fixed", params: { size: "1", side: "long", atBar: 1 } },
    effective: { cash: 1_000_000_000n, requestedSize: E18, size: E18, fromSec: 1_000, toSec: 1_000 + 29 * 3_600, intrabar: false, closeAtEnd: true, untilBar: 29, side: "long" },
    code: { sourceHash: sha256("source"), sourceCommit: "unknown", runtime: "test" },
    tape: undefined,
  };
  const manifest = await buildManifest(manifestInput);
  const trades = closedTrades();
  const engineResult = {
    market: "BTC", quoteSymbol: "USD", from: 1_000, to: 1_000 + 29 * 3_600, status: "closed", equityEnd: 1_050n,
    model: { fillModel: "settlement-mark", profile: null, latencySec: 1, windowSec: null, gasPerTx: 0n, revision: 2 },
    strategy: { id: "fixed" }, manifest,
    eventHash: sha256("events"), trail: [{ t: 1_000, mark: 100n * E18, equity: 1_000n } as never],
    trades, fills: [], orders: [],
  };
  const replaySnapshot = await writeSnapshot({
    version: 3,
    input: { market: "BTC", cash: "1000", intrabar: false },
    result: engineResult,
  });
  const result = {
    market: "BTC", quoteSymbol: "USD", from: 1_000, to: 1_000 + 29 * 3_600, status: "closed", equityEnd: "1050",
    model: { fillModel: "settlement-mark", profile: null }, strategy: { id: "fixed" }, manifest,
    eventHash: sha256("events"), trades,
  };
  await saveRun({ manifest, request: { market: "BTC", size: "1", days: 1 }, result, replaySnapshot });
  return manifest.runId;
}

test("resampleStoredRun rebuilds the analysis offline and persists it by (runId, seed)", async () => {
  const runId = await savedRun();
  assert.ok(await loadRun(runId));

  const first = await resampleStoredRun(runId, { seed: "svc-seed", paths: 64 });
  assert.equal(first.analysis.meta.seed, "svc-seed");
  assert.equal(first.analysis.input.tradeCount, 14);
  assert.equal(first.analysis.input.market, "BTC");
  assert.equal(first.analysis.distributions.length, 2);
  assert.notEqual(first.analysis.oos, null);
  assert.ok(first.invariants.every((i) => i.status === "pass"), JSON.stringify(first.invariants.map((i) => `${i.id}:${i.status}`)));

  // The identical request returns the identical document from the store.
  const second = await resampleStoredRun(runId, { seed: "svc-seed", paths: 64 });
  assert.deepEqual(second, first);

  // A different seed is a different analysis, also persisted.
  const third = await resampleStoredRun(runId, { seed: "svc-seed-2", paths: 64 });
  assert.notDeepEqual(third.analysis.meta.seed, first.analysis.meta.seed);
  const stored = await loadResampleAnalysis(runId, "svc-seed");
  assert.equal(stored?.runId, runId);
  assert.deepEqual(stored?.analysis, first.analysis);
  assert.deepEqual(stored?.invariants, first.invariants);

  // Default seed derives from the run id; a bad id and bad options are errors.
  const defaulted = await resampleStoredRun(runId, { paths: 32 });
  assert.equal(defaulted.analysis.meta.seed.length, 64);
  await assert.rejects(resampleStoredRun("0".repeat(64), { paths: 32 }), /No saved run/);
  await assert.rejects(resampleStoredRun(runId, { paths: 3 }), /\[10, 20000\]/);
});
