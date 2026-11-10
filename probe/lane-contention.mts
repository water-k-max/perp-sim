/**
 *  Does a second lane actually buy parallelism? `simulatePaths` is synchronous CPU, so the
 *  expectation is that two concurrent resamples take about twice as long as one, and that the lane's
 *  value is queueing (nobody is refused) rather than throughput. Measure it instead of asserting it.
 *
 *  This calls the service directly, not through the HTTP lanes, so what it prices is the intrinsic
 *  cost of running two jobs at once — the server would never start the third. The third line is
 *  there to show the ratio keeps climbing rather than to describe a state the server can reach.
 *  Read-only, no chain access: the fixture is frozen and the run is persisted to a temp cache.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "perp-lane-timing-"));
process.env.PERP_SIM_CACHE = root;

const { replayPrepared, persistReplay } = await import("../src/backtest-api.js");
const { resampleStoredRun } = await import("../src/resample/service.js");
const { hashMarketData } = await import("../src/data/ingest.js");
const cfg = {
  symbol: "BTC", quoteSymbol: "USDso", pool: "0x1111111111111111111111111111111111111111", marginBank: "0x2222222222222222222222222222222222222222", stopRegistry: null,
  baseDecimals: 0, quoteDecimals: 6, oneBase: 1n, tickSize: 1n, lotSize: 1n, minQuantity: 1n,
  imBps: 500n, mmBps: 250n, closeOutBps: 100n, effectiveImfBps: 500n,
  maxPositionSize: 1000n, maxOpenInterest: 10000n, takerFeeBpsTimes1k: 1000n, makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 3600, fundingIntervalSec: 3600, imBpsMismatch: false,
} as any;
const start = 1780000000;
const input = { market: "BTC", days: 1, side: "long", size: "4", cash: "1000", intrabar: false, from: start, to: start + 7200, fillModel: "settlement-mark", fillProfile: "realistic", latencySec: 1, gasPerTx: "0", strategy: { id: "fixed", params: { atBar: 1, side: "long" } } } as any;
const data = {
  manifest: { version: 3, chainId: 50383, pool: cfg.pool, market: cfg.symbol, range: { fromSec: start, toSec: start + 7200, fromBlock: 100, toBlock: 300 }, rows: { funding: 3, candles3600: 0, epochs: 0 }, sha256: "", indexer: "fixture", sdkVersion: "fixture", capturedAt: "2026-10-01T00:00:00Z" },
  funding: Array.from({ length: 3 }, (_, i) => ({
    id: `${100 + i * 100}_1`, pool: cfg.pool, fundingRate: "0", cumulativeFundingPerUnit: "0", indexPrice: String(100000000 + i * 1000000), markPrice: String(100000000 + i * 1000000), intervalsSettled: "1", intervalsAccrued: "1", fundingWindowSec: 3600, fundingIntervalSec: 3600, spanStart: String(start + (i - 1) * 3600), spanEnd: String(start + i * 3600), anchorResynced: false, timestamp: String(start + i * 3600), blockNumber: String(100 + i * 100), logIndex: 1, txHash: `0x${"1".repeat(64)}`,
  })), candles3600: [], epochs: [], complete: true, warnings: [],
} as any;
data.manifest.sha256 = hashMarketData(data);

const saved = await persistReplay(await replayPrepared(input, cfg, data), input);
const runId = saved.manifest.runId;
const options = (seed: string) => ({ seed, paths: 600, mode: "bootstrap_with_replacement", horizonTrades: 500 });

const time = async (label: string, fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(`${label}: ${ms.toFixed(0)} ms`);
  return ms;
};

await time("warm (discarded, first run pays module + cache costs)", () => resampleStoredRun(runId, options("warm")));
const one = await time("one job alone", () => resampleStoredRun(runId, options("alone")));
const two = await time("two distinct jobs started together", async () => {
  await Promise.all([resampleStoredRun(runId, options("a")), resampleStoredRun(runId, options("b"))]);
});
const three = await time("three distinct jobs started together", async () => {
  await Promise.all([resampleStoredRun(runId, options("a")), resampleStoredRun(runId, options("b")), resampleStoredRun(runId, options("c"))]);
});
console.log(`ratio two/one = ${(two / one).toFixed(2)} (1.00 = full parallelism, 2.00 = none)`);
console.log(`ratio three/one = ${(three / one).toFixed(2)}`);
await rm(root, { recursive: true, force: true });
