/**
 *  What one heavy job costs a serverless function, measured instead of scaled by eye.
 *
 *  `probe/lane-contention.mts` prices 600 paths × 500 trades (12.2 s / 8.8 s alone). The wallet route
 *  accepts up to **5000** paths, so the number that decides `maxDuration` is not that one — it is the
 *  cost at the ceiling the route will actually accept. This walks the path counts the routes allow and
 *  records wall time and resident memory for each, on the same frozen fixture, offline, no chain.
 *
 *  One caveat this cannot remove: the fixture's trade and bar counts are small, so a real account with
 *  hundreds of closes in a 30-day window is the heavier case. Read these as the shape of the curve, not
 *  as a bound on any particular account.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "perp-function-budget-"));
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
const rssMb = (): number => Math.round(process.memoryUsage.rss() / 1048576);

const rows: { steps: number; paths: number; seconds: number; rssMb: number; note: string }[] = [];
// horizonTrades is held at 500, the value `probe/lane-contention.mts` used, so the two probes read
// against each other. What changes is paths — and `assertWorkBudget` cuts the job off at
// RESAMPLE_WORK_MAX steps, so the largest job the route can *accept* is the one that decides
// maxDuration, not the `paths <= 5000` parameter check.
for (const paths of [600, 1500, 3000, 4000, 5000]) {
  const steps = paths * 500;
  const t0 = performance.now();
  try {
    await resampleStoredRun(runId, { seed: `budget-${paths}`, paths, mode: "bootstrap_with_replacement", horizonTrades: 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rows.push({ steps, paths, seconds: (performance.now() - t0) / 1000, rssMb: rssMb(), note: `refused: ${message.slice(0, 96)}` });
    console.log(`paths=${paths}  refused before any work: ${message.slice(0, 140)}`);
    continue;
  }
  const seconds = (performance.now() - t0) / 1000;
  rows.push({ steps, paths, seconds, rssMb: rssMb(), note: "ran" });
  console.log(`paths=${paths}  steps=${steps}  ${seconds.toFixed(1)} s  rss=${rssMb()} MiB`);
}

const ran = rows.filter((row) => row.note === "ran");
console.log("\ncost per 1k steps (paths x horizonTrades):");
for (const row of ran) console.log(`  ${row.paths} paths: ${row.seconds.toFixed(1)} s, ${(row.seconds / (row.steps / 1000) * 1000).toFixed(1)} ms per 1k steps`);
const last = ran[ran.length - 1];
console.log(`\nlargest job the route accepts: ${last.paths} paths = ${last.steps} steps in ${last.seconds.toFixed(1)} s at ${last.rssMb} MiB rss`);
console.log(`observed peak rss: ${Math.max(...rows.map((r) => r.rssMb))} MiB`);
console.log("note: rss is read after each job, so it is a high-water observation, not a maximum.");

await rm(root, { recursive: true, force: true });
