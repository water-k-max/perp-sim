import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import type { ManifestInput, RunManifest } from "./manifest.js";
import type { RunBundle } from "./store.js";
import type { MarketData } from "../data/types.js";
import type { SliceRecord, TapeSlice } from "../data/tape.js";

const root = await mkdtemp(join(tmpdir(), "run-store-"));
process.env.PERP_SIM_CACHE = root;
const { buildManifest } = await import("./manifest.js");
const { saveRun, loadRun, listRuns, RunConflictError } = await import("./store.js");
const { canonical, readSnapshot, writeSnapshot, sha256, CacheCorruptionError } = await import("../data/store.js");
after(() => rm(root, { recursive: true, force: true }));
const exec = promisify(execFile);

function input(id: number): ManifestInput {
  return {
    cfg: {
      symbol: "BTC", quoteSymbol: "USD", pool: "pool", marginBank: "bank", stopRegistry: null,
      baseDecimals: 18, quoteDecimals: 6, oneBase: 10n ** 18n, tickSize: 10n, lotSize: 100n,
      minQuantity: 100n, imBps: 500n, mmBps: 300n, closeOutBps: 200n, effectiveImfBps: 500n,
      maxPositionSize: 10n ** 24n, maxOpenInterest: 10n ** 28n, takerFeeBpsTimes1k: 30n,
      makerFeeBpsTimes1k: 10n, fundingWindowSec: 3600, fundingIntervalSec: 60, imBpsMismatch: false,
    },
    data: null,
    model: { fillModel: "settlement-mark", profile: null, latencySec: 1, windowSec: null, gasPerTx: 0n },
    strategy: { id: "fixed", params: { size: "100", side: "long", atBar: 1 } },
    effective: { cash: 1_000_000n, requestedSize: BigInt(id), size: 100n, fromSec: 1, toSec: 3601, intrabar: true, closeAtEnd: true, untilBar: 2, side: "long" },
    code: { sourceHash: sha256("source"), sourceCommit: "unknown", runtime: "test" },
  };
}

function data(capturedAt: string): MarketData {
  return {
    manifest: {
      version: 3, chainId: 1, pool: "pool", market: "BTC", range: { fromSec: 1, toSec: 3601, fromBlock: 1, toBlock: 10 },
      rows: { funding: 0, candles3600: 0, epochs: 0 }, sha256: "", indexer: "source", sdkVersion: "test", capturedAt,
    },
    funding: [], candles3600: [], epochs: [], complete: true, warnings: [],
  };
}

function result(manifest: RunManifest) {
  return {
    market: "BTC", quoteSymbol: "USD", from: 1, to: 3601, status: "closed", equityEnd: "1.05",
    model: { fillModel: "settlement-mark", profile: null }, strategy: { id: "fixed" }, manifest,
    eventHash: sha256("events"), trail: [{ t: 1, equity: "1.00" }, { t: 3601, equity: "1.05" }],
  };
}

async function savedInput(id: number, market?: MarketData) {
  const manifest = await buildManifest({ ...input(id), data: market ?? null });
  const replaySnapshot = await writeSnapshot({ version: 3, marketSnapshot: manifest.marketSnapshot,
    config: manifest.configSnapshot, effective: manifest.effective, result: { eventHash: sha256("events"), equityEnd: 105n },
    capturedAt: manifest.capturedAt,
  });
  return { manifest, request: { market: "BTC", size: "100", days: 1 }, result: result(manifest), replaySnapshot };
}

function pointer(runId: string): string { return join(root, "v3", "runs", `${runId}.json`); }
function snapshot(digest: string): string { return join(root, "v3", "snapshots", digest.slice(0, 2), `${digest}.json.gz`); }

test("disk-backed save/load survives a fresh process with typed bigint results", async () => {
  assert.deepEqual(await listRuns(), []);
  const source = await savedInput(1);
  const typed = { ...source, result: { ...source.result, equityEnd: 105n } };
  const bundle = await saveRun(typed);
  assert.equal(bundle.version, 3);
  assert.equal(bundle.result.equityEnd, 105n);
  assert.equal(bundle.summary.equityEnd, "105");
  assert.equal(bundle.summary.market, "BTC");
  assert.equal(bundle.summary.quoteSymbol, "USD");
  assert.equal(bundle.summary.from, 1);
  assert.equal(bundle.summary.to, 3601);
  assert.equal(bundle.summary.fillModel, "settlement-mark");
  assert.equal(bundle.summary.profile, null);
  assert.equal(bundle.summary.strategy, "fixed");
  assert.equal(bundle.summary.status, "closed");
  assert.deepEqual(await loadRun<typeof typed.result>(source.manifest.runId), bundle);
  const moduleUrl = new URL("./store.ts", import.meta.url).href;
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    const { loadRun, listRuns } = await import(${JSON.stringify(moduleUrl)});
    const bundle = await loadRun(${JSON.stringify(source.manifest.runId)});
    if (!bundle || bundle.result.equityEnd !== 105n || bundle.manifest.effective.cash !== 1000000n) throw Error("lost run");
    process.stdout.write(JSON.stringify({ id: bundle.manifest.runId, count: (await listRuns()).length }));
  `], { cwd: new URL("../../", import.meta.url), env: { ...process.env, PERP_SIM_CACHE: root } });
  assert.deepEqual(JSON.parse(stdout), { id: source.manifest.runId, count: 1 });
});

test("listing retains more than twenty runs and defaults to fifty without evicting older IDs", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 55; i++) {
    const source = await savedInput(100 + i);
    source.manifest.capturedAt = new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString();
    ids.push((await saveRun(source)).manifest.runId);
  }
  assert.equal((await listRuns()).length, 50);
  const all = await listRuns(100);
  assert.equal(all.length, 56);
  assert.equal(all[0].runId, ids[54]);
  assert.deepEqual((await listRuns(3)).map(summary => summary.runId), ids.slice(-3).reverse());
  assert.ok(await loadRun(ids[0]));
  assert.deepEqual(await listRuns(0), []);
  for (const limit of [-1, 1.5, Infinity, NaN]) await assert.rejects(listRuns(limit), /limit/);
});

test("same semantic run with different capture times and market snapshot digests returns the original bundle", async () => {
  const first = await savedInput(2, data("2025-01-01T00:00:00.000Z"));
  first.manifest.capturedAt = "2025-02-01T00:00:00.000Z";
  const original = await saveRun(first);
  const second = await savedInput(2, data("2026-01-01T00:00:00.000Z"));
  second.manifest.capturedAt = "2026-02-01T00:00:00.000Z";
  second.request.days = 2; // Raw request syntax is not the effective identity.
  assert.equal(first.manifest.runId, second.manifest.runId);
  assert.notEqual(first.manifest.marketSnapshot, second.manifest.marketSnapshot);
  assert.notEqual(first.replaySnapshot, second.replaySnapshot);
  assert.deepEqual(await saveRun(second), original);
  assert.deepEqual(await loadRun(first.manifest.runId), original);
  const replay = await readSnapshot<Record<string, unknown>>(second.replaySnapshot);
  second.replaySnapshot = await writeSnapshot({ ...replay, capturedAt: "later" });
  assert.deepEqual(await saveRun(second), original);
});

test("duplicate identity rejects changed deterministic result or replay semantics", async () => {
  const source = await savedInput(3);
  const original = await saveRun(source);
  await assert.rejects(saveRun({ ...source, result: { ...source.result, equityEnd: "1.06" } }), RunConflictError);
  await assert.rejects(saveRun({ ...source, result: { ...source.result, trail: [{ t: 1, equity: "0.9" }] } }), RunConflictError);
  const replay = await readSnapshot<Record<string, unknown>>(source.replaySnapshot);
  const replaySnapshot = await writeSnapshot({ ...replay, result: { equityEnd: 999n, eventHash: sha256("different events") } });
  await assert.rejects(saveRun({ ...source, replaySnapshot }), RunConflictError);
  const otherManifest = await buildManifest(input(3000));
  await assert.rejects(saveRun({ ...source, result: { ...source.result, manifest: otherManifest } }), /Result manifest identity mismatch/);
  assert.deepEqual(await loadRun(source.manifest.runId), original);
});

test("atomic create-only publication converges identical writers and rejects conflicting races", async () => {
  const source = await savedInput(4);
  const copies = await Promise.all(Array.from({ length: 12 }, () => saveRun(source)));
  for (const bundle of copies) assert.deepEqual(bundle, copies[0]);
  const race = await savedInput(5);
  const outcomes = await Promise.allSettled([
    saveRun(race), saveRun({ ...race, result: { ...race.result, equityEnd: "2.00" } }),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find(outcome => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof RunConflictError);
  const winner = outcomes.find(outcome => outcome.status === "fulfilled");
  assert.ok(winner?.status === "fulfilled");
  assert.deepEqual(await loadRun(race.manifest.runId), winner.value);
  // A pre-publication temporary file is never mistaken for a saved run.
  await writeFile(`${pointer(sha256("unfinished"))}.tmp`, "partial");
  assert.ok((await listRuns(100)).every(summary => summary.runId !== sha256("unfinished")));
});

test("IDs are strictly validated before any path lookup and missing IDs return null", async () => {
  for (const id of ["../escape", "../../package.json", "/tmp/run", "a".repeat(63), "a".repeat(65), "A".repeat(64), "0".repeat(64) + "/x", ""]) {
    await assert.rejects(loadRun(id), /Invalid run ID/);
  }
  assert.equal(await loadRun("0".repeat(64)), null);
  const source = await savedInput(6);
  await assert.rejects(saveRun({ ...source, manifest: { ...source.manifest, runId: "../escape" } }), /Invalid run ID/);
  await assert.rejects(saveRun({ ...source, replaySnapshot: "../escape" }), /Invalid replay snapshot digest/);
  await assert.rejects(saveRun({ ...source, replaySnapshot: "0".repeat(64) }), /Missing snapshot/);
});

test("loaded bundles validate pointer, manifest, result and summary hashes even in valid snapshot envelopes", async () => {
  const source = await savedInput(7);
  const original = await saveRun(source);
  const target = pointer(source.manifest.runId);
  const bytes = await readFile(target);
  const mutations: ((bundle: RunBundle<typeof source.result>) => void)[] = [
    b => { b.result.equityEnd = "tampered"; }, b => { b.result.eventHash = sha256("tampered"); },
    b => { b.manifest.effective.cash++; }, b => { b.manifest.configHash = sha256("tampered"); },
    b => { b.manifest.code.sourceHash = sha256("tampered"); },
    b => { b.manifest.runId = sha256("wrong id"); }, b => { b.summary.market = "tampered"; },
    b => { b.resultDigest = sha256("tampered"); }, b => { b.replayDigest = sha256("tampered"); },
    b => { b.replaySnapshot = "0".repeat(64); },
  ];
  try {
    for (const mutate of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      const bundleDigest = await writeSnapshot(changed);
      await writeFile(target, JSON.stringify({ version: 3, runId: source.manifest.runId, bundleDigest }));
      await assert.rejects(loadRun(source.manifest.runId), CacheCorruptionError);
    }
    for (const value of ["not JSON", "{}", JSON.stringify({ version: 3, runId: "other", bundleDigest: sha256("missing") }), JSON.stringify({ version: 3, runId: source.manifest.runId, bundleDigest: "0".repeat(64) })]) {
      await writeFile(target, value);
      await assert.rejects(loadRun(source.manifest.runId), CacheCorruptionError);
      await assert.rejects(listRuns(100), CacheCorruptionError);
    }
  } finally { await writeFile(target, bytes); }
  assert.deepEqual(await loadRun(source.manifest.runId), original);
});

test("tampered or missing bundle, market, tape and replay snapshots fail closed", async () => {
  const payload: TapeSlice = { key: sha256("tape request"), fromSec: 1, toSec: 31, fills: [], complete: true, pages: 1, truncated: false };
  const tapeDigest = await writeSnapshot(payload);
  const record: SliceRecord = { key: payload.key, digest: tapeDigest, fromSec: 1, toSec: 31, fills: 0, complete: true };
  const manifest = await buildManifest({ ...input(8), data: data("2025-01-01T00:00:00.000Z"),
    tape: { consumed: () => [record], digest: () => "unused", slice: async () => { throw new Error("offline"); } },
  });
  const replaySnapshot = await writeSnapshot({ marketSnapshot: manifest.marketSnapshot, engine: { eventHash: "original" } });
  const original = await saveRun({ manifest, request: {}, result: result(manifest), replaySnapshot });
  const index = JSON.parse(await readFile(pointer(manifest.runId), "utf8")) as { bundleDigest: string };
  for (const digest of [index.bundleDigest, manifest.marketSnapshot!, tapeDigest, replaySnapshot]) {
    const target = snapshot(digest);
    const bytes = await readFile(target);
    try {
      await writeFile(target, gzipSync(canonical({ version: 3, digest, payload: { changed: true } })));
      await assert.rejects(loadRun(manifest.runId), CacheCorruptionError);
      await writeFile(target, "invalid gzip");
      await assert.rejects(loadRun(manifest.runId), CacheCorruptionError);
      await rm(target);
      await assert.rejects(loadRun(manifest.runId), CacheCorruptionError);
    } finally { await writeFile(target, bytes); }
  }
  assert.deepEqual(await loadRun(manifest.runId), original);
});

test("generic results need no unsafe cast and summaries fall back to effective manifest fields", async () => {
  const source = await savedInput(9);
  const bundle = await saveRun({ ...source, result: { raw: 42n } });
  assert.equal(bundle.result.raw, 42n);
  assert.equal(bundle.summary.market, source.manifest.configSnapshot.symbol);
  assert.equal(bundle.summary.strategy, source.manifest.effective.strategy.id);
  assert.equal(bundle.summary.equityEnd, "0");
  assert.deepEqual(await loadRun<{ raw: bigint }>(source.manifest.runId), bundle);
});
