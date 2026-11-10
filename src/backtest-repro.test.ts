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
// Some tests below forbid the in-process network to prove a frozen replay needs none of it. These
// HTTP checks talk to a server they spawned, from this process, so they need the fetch that existed
// before any mock was installed on it.
const http = globalThis.fetch;
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

test("stored reports with a resample request replay byte-for-byte", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden during frozen replay"); });
  const request: RunRequest = {
    // A different cash changes the manifest config hash, so this run gets its own run id
    // (identity does not cover the resample request itself).
    ...input,
    cash: "1500",
    resample: {
      seed: "repro-seed", paths: 64, mode: "both", sizing: "static", horizonTrades: null,
      acceptedLoss: null, holdbackFraction: 0.3,
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

/**
 *  The lane over real HTTP, against a saved run so nothing here touches the network.
 *
 *  The scheduler's own arithmetic — one job per key, FIFO within the queue, the exact depth a
 *  refusal reports — is pinned in `src/bin/work-lanes.test.ts`. What these three checks add is the
 *  wiring: that a route's key really comes from the validated request, that a refusal reaches the
 *  client as a 429 with a `Retry-After`, and that a request which was never going to run cannot
 *  occupy a slot. The job itself is deliberately sized in the middle of the work budget (600 paths ×
 *  500 trades plus the fan summary) so it lasts comfortably longer than the millisecond window the
 *  concurrent arrivals take to land — the assertions below are written as bounds (`at least one`)
 *  rather than an exact split, because the exact split is a race the server can legitimately win.
 */
async function withLaneServer(runId: string, port: number, body: Record<string, unknown>, use: (post: (over?: Record<string, unknown>) => Promise<Response>, base: string) => Promise<void>): Promise<void> {
  const cwd = new URL("../", import.meta.url);
  const server = spawn(process.execPath, ["--import", "tsx", "src/bin/web.ts"], { cwd, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.race([
      once(server.stdout, "data"),
      once(server, "exit").then(([code]) => { throw new Error(`Server exited before listening: ${code}`); }),
    ]);
    const endpoint = `http://127.0.0.1:${port}`;
    const post = (over: Record<string, unknown> = {}) => http(`${endpoint}/api/resample`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, resample: { ...body, ...over } }),
    });
    await use(post, endpoint);
    assert.equal(server.exitCode, null, "the server died while its lane was working");
  } finally {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
}

test("a full lane refuses the overflow with a Retry-After, and answers everyone else", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden during frozen replay"); });
  const saved = await persistReplay(await replayPrepared(input, cfg, dataset()), input);
  const heavy = { paths: 600, mode: "bootstrap_with_replacement", horizonTrades: 500 };
  await withLaneServer(saved.manifest.runId, 3199, heavy, async (post) => {
    // Eight distinct seeds: two slots plus a queue of four means at most six may be admitted, so
    // something must be refused, and nothing may be refused twice.
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => post({ seed: `lane-${i}` })));
    const statuses = responses.map(r => r.status);
    assert.equal(statuses.filter(s => s === 200).length <= 6, true, `more than concurrency+queue were admitted: ${statuses.join(",")}`);
    assert.equal(statuses.filter(s => s !== 200 && s !== 429).length, 0, `unexpected status in ${statuses.join(",")}`);
    const refused = responses.filter(r => r.status === 429);
    assert.ok(refused.length >= 1, `a full lane answered every request: ${statuses.join(",")}`);
    for (const response of refused) {
      assert.equal(response.headers.get("retry-after"), "2", "the refusal carried no Retry-After");
      const body = await response.json() as { error: string; queue: Record<string, number> };
      assert.equal(body.queue.concurrency, 2);
      assert.equal(body.queue.queueLimit, 4);
      assert.match(body.error, /Try again in 2 seconds/);
      assert.ok(body.queue.running <= 2 && body.queue.waiting <= 4, `refusal reported an impossible depth: ${JSON.stringify(body.queue)}`);
    }
    for (const response of responses.filter(r => r.status === 200)) {
      const body = await response.json() as { resample?: unknown };
      assert.ok(body.resample, "an admitted request did not get a resample block");
    }
  });
});

test("the same request from two tabs is one job, not eight refusals", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden during frozen replay"); });
  const saved = await persistReplay(await replayPrepared(input, cfg, dataset()), input);
  const heavy = { paths: 600, mode: "bootstrap_with_replacement", horizonTrades: 500, seed: "identical" };
  await withLaneServer(saved.manifest.runId, 3200, heavy, async (post) => {
    // Identical bodies, so identical keys: the whole point is that nobody is refused here, however
    // many tabs open the same analysis. Anything other than 200 means the key missed.
    const responses = await Promise.all(Array.from({ length: 8 }, () => post()));
    const statuses = responses.map(r => r.status);
    assert.deepEqual(statuses, statuses.map(() => 200), `an identical request was refused: ${statuses.join(",")}`);
    const bodies = await Promise.all(responses.map(r => r.text()));
    assert.equal(new Set(bodies).size, 1, "eight copies of one request got eight different answers");
  });
});

test("a request the router can reject never costs a lane, even a full one", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden during frozen replay"); });
  const saved = await persistReplay(await replayPrepared(input, cfg, dataset()), input);
  const heavy = { paths: 600, mode: "bootstrap_with_replacement", horizonTrades: 500 };
  await withLaneServer(saved.manifest.runId, 3201, heavy, async (post, base) => {
    const issued = Array.from({ length: 8 }, (_, i) => post({ seed: `busy-${i}` }));
    // Refusals come back the instant the lane is at capacity; the jobs they refused take seconds. So
    // whichever response lands first is the evidence that the system was full, and full it stays for
    // the next few milliseconds.
    const first = await Promise.race(issued);
    assert.equal(first.status, 429, "the lane never filled, so this check would prove nothing");
    const bad = (init: RequestInit) => http(`${base}/api/resample`, init);
    const rejected = await Promise.all([
      bad({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: "nope" }) }),
      bad({ method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }),
      bad({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: saved.manifest.runId, resample: { paths: 7 } }) }),
    ]);
    // A digest that is not one, a body that is not JSON, a job outside the work budget: each is
    // answered by the router alone. Any 429 here means a request that would have failed anyway was
    // queued ahead of, or in place of, work somebody else asked for.
    assert.deepEqual(rejected.map((response) => response.status), [400, 415, 400], "a rejected request was queued or refused instead of answered");
    for (const response of rejected) await response.text();
    const settled = await Promise.all(issued);
    assert.equal(settled.filter((response) => response.status === 200).length >= 1, true, "a full lane still has to answer somebody");
    for (const response of settled) await response.text();
  });
});
