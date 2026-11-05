import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import type { MarketConfig } from "./history/market.js";
import type { MarketData } from "./data/types.js";
import type { RunRequest } from "./backtest-api.js";
import type { TapeSlice } from "./data/tape.js";

const root = await mkdtemp(join(tmpdir(), "perp-replay-test-"));
process.env.PERP_SIM_CACHE = root;
const { replayPrepared, persistReplay, replaySavedRun } = await import("./backtest-api.js");
const { hashMarketData } = await import("./data/ingest.js");
const { createFrozenTapeSource } = await import("./data/tape.js");
const { writeSnapshot } = await import("./data/store.js");
after(() => rm(root, { recursive: true, force: true }));

const cfg: MarketConfig = {
  symbol: "BTC", quoteSymbol: "USDso", pool: "0x1111111111111111111111111111111111111111", marginBank: "0x2222222222222222222222222222222222222222", stopRegistry: null,
  baseDecimals: 0, quoteDecimals: 6, oneBase: 1n, tickSize: 1n, lotSize: 1n, minQuantity: 1n,
  imBps: 500n, mmBps: 250n, closeOutBps: 100n, effectiveImfBps: 500n,
  maxPositionSize: 1000n, maxOpenInterest: 10000n, takerFeeBpsTimes1k: 1000n, makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 3600, fundingIntervalSec: 3600, imBpsMismatch: false,
};
const start = 1780000000;
const input: RunRequest = { market: "BTC", days: 1, side: "long", size: "4", cash: "1000", intrabar: false, from: start, to: start + 7200, fillModel: "settlement-mark", fillProfile: "realistic", latencySec: 1, gasPerTx: "0", strategy: { id: "fixed", params: { atBar: 1, side: "long" } } };
function dataset(): MarketData {
  const data: MarketData = {
    manifest: { version: 3, chainId: 50383, pool: cfg.pool, market: cfg.symbol, range: { fromSec: start, toSec: start + 7200, fromBlock: 100, toBlock: 300 }, rows: { funding: 3, candles3600: 0, epochs: 0 }, sha256: "", indexer: "fixture", sdkVersion: "fixture", capturedAt: "2026-10-01T00:00:00Z" },
    funding: Array.from({ length: 3 }, (_, i) => ({
      id: `${100 + i * 100}_1`, pool: cfg.pool, fundingRate: "0", cumulativeFundingPerUnit: "0", indexPrice: String(100000000 + i * 1000000), markPrice: String(100000000 + i * 1000000), intervalsSettled: "1", intervalsAccrued: "1", fundingWindowSec: 3600, fundingIntervalSec: 3600, spanStart: String(start + (i - 1) * 3600), spanEnd: String(start + i * 3600), anchorResynced: false, timestamp: String(start + i * 3600), blockNumber: String(100 + i * 100), logIndex: 1, txHash: `0x${"1".repeat(64)}`,
    })), candles3600: [], epochs: [], complete: true, warnings: [],
  };
  data.manifest.sha256 = hashMarketData(data);
  return data;
}

test("saved report and engine reproduce without network; cash and intrabar change identities", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden during frozen replay"); });
  const data = dataset();
  const replay = await replayPrepared(input, cfg, data);
  const saved = await persistReplay(replay, input);
  assert.doesNotThrow(() => JSON.stringify(saved.result));
  assert.ok(saved.result.warnings.some(w => w.includes("not proven historical values")));
  const { saveRun } = await import("./runs/store.js");
  const tampered = structuredClone(saved.result);
  tampered.manifest.effective.cash = "999";
  await assert.rejects(saveRun({ manifest: saved.manifest, request: input, result: tampered, replaySnapshot: saved.replaySnapshot }), /Result manifest identity mismatch/);
  assert.deepEqual(await replaySavedRun(replay.manifest.runId), saved.result);
  const cash = await replayPrepared({ ...input, cash: "2000" }, cfg, data);
  const intrabar = await replayPrepared({ ...input, intrabar: true }, cfg, data);
  assert.notEqual(cash.manifest.runId, replay.manifest.runId);
  assert.notEqual(intrabar.manifest.runId, replay.manifest.runId);
  const formatted = { ...input, size: "4.0", cash: "1000.000000", days: 2 };
  const same = await replayPrepared(formatted, cfg, data);
  assert.equal(same.manifest.runId, replay.manifest.runId);
  await persistReplay(same, formatted);
  data.manifest.capturedAt = "2026-10-02T00:00:00Z";
  const recaptured = await replayPrepared(input, cfg, data);
  assert.equal(recaptured.manifest.runId, replay.manifest.runId);
  await persistReplay(recaptured, input);
});

test("stored reports with a resample request replay byte-for-byte, including the prop block", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden during frozen replay"); });
  const request: RunRequest = {
    // A different cash changes the manifest config hash, so this run gets its own run id
    // (identity does not cover the resample request itself).
    ...input,
    cash: "1500",
    resample: {
      seed: "repro-seed", paths: 64, mode: "both", sizing: "static", horizonTrades: null,
      acceptedLoss: null, holdbackFraction: 0.3,
      prop: {
        startingBalance: null, drawdownMode: "trailing_eod", drawdownLocks: false,
        dailyLossLimit: "50", drawdownLimit: "500",
        phases: [{ profitTarget: "5", consistencyCapBps: null }],
        payoutCadence: "one_time", payoutFeeBps: 500, maxDays: 30,
      },
    },
  };
  const replay = await replayPrepared(request, cfg, dataset());
  const saved = await persistReplay(replay, request);
  assert.ok(saved.result.resample, "the stored report carries the resample block");
  assert.deepEqual(await replaySavedRun(replay.manifest.runId), saved.result);
});

test("frozen tape includes full contents, terminal close, and partial coverage", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden during frozen replay"); });
  const data = dataset();
  const slice: TapeSlice = { key: "a".repeat(64), fromSec: start + 1, toSec: start + 31, complete: true, pages: 2, truncated: false, fills: [{ id: "101_1", block: 101, logIndex: 1, t: start + 10, price: 100000000n, size: 40n, quote: 4000000000n, takerIsBid: true, maker: null, taker: null, txHash: `0x${"2".repeat(64)}` }] };
  const source = async () => createFrozenTapeSource([{ key: slice.key, digest: await writeSnapshot(slice), fromSec: slice.fromSec, toSec: slice.toSec, fills: slice.fills.length, complete: slice.complete }]);
  const request = { ...input, fillModel: "tape" as const };
  const replay = await replayPrepared(request, cfg, data, await source());
  const saved = await persistReplay(replay, request);
  assert.deepEqual(await replaySavedRun(replay.manifest.runId), saved.result);
  assert.ok(replay.result.fills.some(fill => fill.tag === "terminal-close"));
  assert.ok(saved.result.warnings.some(w => w.includes("end-of-run close")));
  slice.fills[0]!.price += 1n;
  const changed = await replayPrepared(request, cfg, data, await source());
  assert.notEqual(changed.manifest.dataVersion, replay.manifest.dataVersion);
  slice.complete = false; slice.truncated = true;
  const partial = await replayPrepared(request, cfg, data, await source());
  const partialSaved = await persistReplay(partial, request);
  assert.equal(partialSaved.result.complete, false);
  assert.ok(partialSaved.result.warnings.some(w => w.includes("Trade tape coverage is incomplete")));
});

test("saved reports survive server restarts and CLI replay in fresh processes", async () => {
  const replay = await replayPrepared(input, cfg, dataset());
  const saved = await persistReplay(replay, input);
  const cwd = new URL("../", import.meta.url);
  const cli = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/bin/replay-run.ts", saved.manifest.runId], { cwd, timeout: 20000 });
  assert.match(cli.stdout, new RegExp(saved.manifest.runId));
  for (let restart = 0; restart < 2; restart++) {
    const server = spawn(process.execPath, ["--import", "tsx", "src/bin/web.ts"], { cwd, env: { ...process.env, PORT: "3197" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await Promise.race([
        once(server.stdout, "data"),
        once(server, "exit").then(([code]) => { throw new Error(`Preview exited before listening: ${code}`); }),
      ]);
      const base = "http://127.0.0.1:3197/api/runs";
      const response = await fetch(`${base}/${saved.manifest.runId}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), saved.result);
      const listing = await fetch(base);
      assert.ok((await listing.json() as { runId: string }[]).some(row => row.runId === saved.manifest.runId));
      assert.equal((await fetch(`${base}/invalid`)).status, 400);
      assert.equal((await fetch(`${base}/${"0".repeat(64)}`)).status, 404);
    } finally {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
  }
});

test("malformed account URLs and cross-site browser requests never kill the server", async () => {
  const cwd = new URL("../", import.meta.url);
  const server = spawn(process.execPath, ["--import", "tsx", "src/bin/web.ts"], { cwd, env: { ...process.env, PORT: "3198" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.race([
      once(server.stdout, "data"),
      once(server, "exit").then(([code]) => { throw new Error(`Preview exited before listening: ${code}`); }),
    ]);
    const base = "http://127.0.0.1:3198";
    for (const path of ["/api/accounts/%zz/reconcile", "/api/accounts/%/reconcile", "/api/accounts/%E0%A4/reconcile"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 400, path);
      assert.equal((await response.json() as { error: string }).error.includes("account address"), true);
    }
    const crossSite = await fetch(`${base}/api/runs`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    const crossSitePost = await fetch(`${base}/api/backtest`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: "{}" });
    assert.equal(crossSitePost.status, 403);
    const sameOrigin = await fetch(`${base}/api/runs`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    assert.equal(sameOrigin.status, 200);
    const noHeader = await fetch(`${base}/api/runs`);
    assert.equal(noHeader.status, 200);
    assert.equal(server.exitCode, null, "server survived malformed and cross-site requests");
  } finally {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
});
