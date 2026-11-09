import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestInput } from "./manifest.js";
import type { MarketData } from "../data/types.js";
import type { SliceRecord, TapeSlice, TapeSource } from "../data/tape.js";

const root = await mkdtemp(join(tmpdir(), "run-manifest-"));
process.env.PERP_SIM_CACHE = join(root, "cache");
const { buildManifest, codeIsLoaded, getCodeIdentity, validateManifest } = await import("./manifest.js");
const { readSnapshot, sha256, writeSnapshot } = await import("../data/store.js");
const { hashMarketData } = await import("../data/ingest.js");
const { PROFILES } = await import("../engine/fills.js");
after(() => rm(root, { recursive: true, force: true }));

function input(): ManifestInput {
  return {
    cfg: {
      symbol: "BTC", quoteSymbol: "USD", pool: "pool", marginBank: "bank", stopRegistry: null,
      baseDecimals: 18, quoteDecimals: 6, oneBase: 10n ** 18n, tickSize: 10n, lotSize: 100n,
      minQuantity: 100n, imBps: 500n, mmBps: 300n, closeOutBps: 200n, effectiveImfBps: 500n,
      maxPositionSize: 10n ** 24n, maxOpenInterest: 10n ** 28n, takerFeeBpsTimes1k: 30n,
      makerFeeBpsTimes1k: 10n, fundingWindowSec: 3600, fundingIntervalSec: 60, imBpsMismatch: false,
    },
    data: null,
    model: { fillModel: "tape", profile: "realistic", latencySec: 1, windowSec: 30, gasPerTx: 0n },
    strategy: { id: "fixed", params: { side: "long", size: "100", atBar: 1 } },
    effective: { cash: 1_000_000n, requestedSize: 101n, size: 100n, fromSec: 1, toSec: 3601, intrabar: true, closeAtEnd: true, untilBar: 2, side: "long" },
    code: { sourceHash: sha256("source"), sourceCommit: "unknown", runtime: "node:test" },
  };
}

function data(): MarketData {
  return {
    manifest: {
      version: 3, chainId: 1, pool: "pool", market: "BTC",
      range: { fromSec: 1, toSec: 3601, fromBlock: 1, toBlock: 10 },
      rows: { funding: 1, candles3600: 1, epochs: 1 }, sha256: "stale",
      indexer: "source", sdkVersion: "test", capturedAt: "2025-01-01T00:00:00.000Z",
    },
    funding: [{
      id: "funding-1", pool: "pool", fundingRate: "1", cumulativeFundingPerUnit: "1", indexPrice: "100",
      markPrice: "100", intervalsSettled: "1", intervalsAccrued: "1", fundingWindowSec: 3600,
      fundingIntervalSec: 60, spanStart: "1", spanEnd: "61", anchorResynced: false, timestamp: "61", blockNumber: "1", txHash: "tx",
    }],
    candles3600: [{ bucketStart: "0", openPrice: "100", high: "101", low: "99", closePrice: "100", baseVolume: "1", quoteVolume: "100", tradeCount: 1, lastFillId: "fill-1" }],
    epochs: [{ blockNumber: 1, timestamp: 1, logIndex: 0, initialMarginBps: 500n, maintenanceMarginBps: 300n,
      closeOutMarginBps: 200n, takerFeeBpsTimes1k: 30n, makerFeeBpsTimes1k: 10n, maxPositionSize: 1000n,
      maxOpenInterest: 10000n, insuranceFundShareBps: 0n, source: "epoch" }],
    complete: true, warnings: [],
  };
}

function tape(records: SliceRecord[]): TapeSource {
  return { consumed: () => records, digest: () => "ignored request key hash", slice: async () => { throw new Error("must not fetch"); } };
}

async function slice(change: Partial<TapeSlice> = {}): Promise<SliceRecord> {
  const payload: TapeSlice = {
    key: sha256("request"), fromSec: 1, toSec: 31, complete: true, pages: 1, truncated: false,
    fills: [{ id: "1_0", block: 1, logIndex: 0, t: 2, price: 100n, size: 100n, quote: 100n, takerIsBid: true, maker: null, taker: null, txHash: "tx" }],
    ...change,
  };
  return { key: payload.key, digest: await writeSnapshot(payload), fromSec: payload.fromSec, toSec: payload.toSec, fills: payload.fills.length, complete: payload.complete };
}

test("v3 identities cover every effective setting and all market configuration fields", async () => {
  const base = input();
  const first = await buildManifest(base);
  assert.match(first.runId, /^[a-f0-9]{64}$/);
  assert.equal(first.schemaVersion, 3);
  assert.deepEqual(first.configSnapshot, base.cfg);
  assert.deepEqual(first.effective.model.profileParams, PROFILES.realistic);
  assert.deepEqual(first.effective.strategy, base.strategy);
  assert.equal(first.marketSnapshot, null);
  for (const [key, value] of Object.entries(base.cfg)) {
    const cfg = { ...base.cfg, [key]: typeof value === "bigint" ? value + 1n : typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : `${value}-changed` };
    const next = await buildManifest({ ...base, cfg });
    assert.notEqual(next.configHash, first.configHash, key);
    assert.notEqual(next.runId, first.runId, key);
    assert.equal(next.dataVersion, first.dataVersion, key);
  }
  for (const [key, value] of Object.entries(base.effective)) {
    const effective = { ...base.effective, [key]: typeof value === "bigint" ? value + 1n : typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : "short" };
    const next = await buildManifest({ ...base, effective });
    assert.notEqual(next.configHash, first.configHash, key);
    assert.notEqual(next.runId, first.runId, key);
  }
  const models: ManifestInput["model"][] = [
    { ...base.model, latencySec: 2 }, { ...base.model, gasPerTx: 1n },
    { ...base.model, windowSec: 31 }, { ...base.model, profile: "optimistic" },
    { ...base.model, fillModel: "settlement-mark", profile: null, windowSec: null },
  ];
  for (const model of models) assert.notEqual((await buildManifest({ ...base, model })).runId, first.runId);
  const parameters: ManifestInput["strategy"]["params"][] = [{ side: "short" }, { size: "200" }, { atBar: 2 }, { fast: 6, slow: 24 }, { extra: true }];
  for (const params of parameters) {
    assert.notEqual((await buildManifest({ ...base, strategy: { id: "fixed", params: { ...base.strategy.params, ...params } } })).runId, first.runId);
  }
  assert.notEqual((await buildManifest({ ...base, strategy: { ...base.strategy, id: "sma" } })).runId, first.runId);
  const old = PROFILES.realistic.participation;
  try {
    PROFILES.realistic.participation = old + 1n;
    assert.notEqual((await buildManifest(base)).runId, first.runId);
    await validateManifest(first); // Saved profiles must not be compared against current code.
  } finally { PROFILES.realistic.participation = old; }
});

test("market identity hashes full rows with stable IDs, not the supplied digest or acquisition time", async () => {
  const base = { ...input(), data: data() };
  const first = await buildManifest(base);
  assert.notEqual(first.marketSnapshot, null);
  assert.equal((await readSnapshot<MarketData>(first.marketSnapshot!)).manifest.sha256, hashMarketData(base.data));
  assert.equal(base.data.manifest.sha256, "stale", "caller data is not mutated");
  assert.equal(first.data?.fundingRows, 1);
  const mutations: ((d: MarketData) => void)[] = [
    d => { d.funding[0].fundingRate = "2"; }, d => { d.funding[0].markPrice = "101"; },
    d => { d.candles3600[0].closePrice = "101"; }, d => { d.candles3600[0].quoteVolume = "101"; },
    d => { d.epochs[0].initialMarginBps = 501n; }, d => { d.epochs[0].logIndex = 1; },
    d => { d.complete = false; }, d => { d.warnings.push("incomplete"); },
    d => { d.manifest.chainId = 2; }, d => { d.manifest.range.toBlock = 11; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(base.data);
    mutate(changed);
    const next = await buildManifest({ ...base, data: changed });
    assert.notEqual(next.dataVersion, first.dataVersion);
    assert.notEqual(next.runId, first.runId);
    assert.equal(next.configHash, first.configHash);
  }
  base.data.manifest.capturedAt = "2026-01-01T00:00:00.000Z";
  base.data.manifest.sha256 = "also stale";
  const refreshed = await buildManifest(base);
  assert.equal(refreshed.runId, first.runId);
  assert.equal(refreshed.dataVersion, first.dataVersion);
  assert.notEqual(refreshed.marketSnapshot, first.marketSnapshot);
});

test("consumed tape records pin full payloads, same-count fills, bounds, completeness and order", async () => {
  const a = await slice();
  const first = await buildManifest({ ...input(), tape: tape([a]) });
  assert.deepEqual(first.tapeSlices, [a.digest]);
  assert.deepEqual(first.tapeRecords, [a]);
  const payload = await readSnapshot<TapeSlice>(a.digest);
  const alternatives = [
    await slice({ fills: [{ ...payload.fills[0], price: 101n }] }),
    await slice({ complete: false }), await slice({ fromSec: 2 }), await slice({ toSec: 32 }),
    await slice({ key: sha256("different request") }), await slice({ pages: 2 }),
  ];
  for (const b of alternatives) {
    assert.equal(b.fills, a.fills);
    const next = await buildManifest({ ...input(), tape: tape([b]) });
    assert.notEqual(next.runId, first.runId);
    assert.notEqual(next.dataVersion, first.dataVersion);
  }
  const b = alternatives[0];
  assert.notEqual((await buildManifest({ ...input(), tape: tape([a, b]) })).runId,
    (await buildManifest({ ...input(), tape: tape([b, a]) })).runId);
  assert.notEqual((await buildManifest({ ...input(), tape: tape([a, a]) })).runId, first.runId);
  await assert.rejects(buildManifest({ ...input(), tape: tape([{ ...a, fills: 2 }]) }), /Tape snapshot identity mismatch/);
  await assert.rejects(buildManifest({ ...input(), tape: tape([{ ...a, digest: "../bad" }]) }), /Invalid tape record/);
});

test("source, commit metadata and runtime independently participate in code/run identity", async () => {
  const base = input();
  const first = await buildManifest(base);
  for (const code of [
    { ...base.code!, sourceHash: sha256("edited source") },
    { ...base.code!, sourceCommit: "a".repeat(40) },
    { ...base.code!, runtime: "node:other" },
  ]) {
    const next = await buildManifest({ ...base, code });
    assert.notEqual(next.codeHash, first.codeHash);
    assert.notEqual(next.runId, first.runId);
    assert.equal(next.configHash, first.configHash);
    assert.equal(next.dataVersion, first.dataVersion);
  }
});

test("the loaded-code guard keys on executing bytes and runtime, never on commit metadata", async () => {
  const project = join(root, "guard-project");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "public"), { recursive: true });
  await writeFile(join(project, "src", "main.ts"), "original");
  for (const name of ["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.web.json"]) await writeFile(join(project, name), "{}");
  const identity = await getCodeIdentity(project);
  assert.equal(codeIsLoaded(identity, identity), true);
  // A commit between runs moves HEAD without touching a single byte of running code.
  assert.equal(codeIsLoaded({ ...identity, sourceCommit: "0".repeat(40) }, identity), true, "a commit does not change executing code");
  // What does change what the process executes:
  assert.equal(codeIsLoaded({ ...identity, sourceHash: "0".repeat(64) }, identity), false, "edited source bytes must invalidate");
  assert.equal(codeIsLoaded({ ...identity, runtime: `${identity.runtime};changed` }, identity), false, "a runtime change must invalidate");
});

test("code reads current source/config/web bytes without caching or environment secrets", async () => {
  const project = join(root, "project");
  await mkdir(join(project, "src", "web"), { recursive: true });
  await mkdir(join(project, "public"));
  const files = ["src/main.ts", "src/web/main.tsx", "src/web/style.css", "public/index.html", "public/app.css", "package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.web.json"];
  for (const name of files) await writeFile(join(project, name), "original");
  const first = await getCodeIdentity(project);
  assert.match(first.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(first.runtime, /node:/);
  for (const name of files) {
    await writeFile(join(project, name), "changed");
    assert.notEqual((await getCodeIdentity(project)).sourceHash, first.sourceHash, name);
    await writeFile(join(project, name), "original");
  }
  await writeFile(join(project, ".env"), "DO_NOT_HASH=secret");
  await writeFile(join(project, "src", ".env"), "secret");
  await writeFile(join(project, "public", ".env"), "secret");
  // A link into a secret tree must not be followed; a junction needs no symlink privilege on Windows.
  await mkdir(join(root, "secret-tree"), { recursive: true });
  await writeFile(join(root, "secret-tree", "leak.ts"), "secret");
  await symlink(join(root, "secret-tree"), join(project, "src", "linked"), process.platform === "win32" ? "junction" : "dir");
  const previous = process.env.RUN_TEST_SECRET;
  try {
    process.env.RUN_TEST_SECRET = "never include environment secrets";
    assert.equal((await getCodeIdentity(project)).sourceHash, first.sourceHash);
  } finally {
    if (previous === undefined) delete process.env.RUN_TEST_SECRET;
    else process.env.RUN_TEST_SECRET = previous;
  }
});

test("validation rejects tampered identity, effective input, data references and displayed counts", async () => {
  const manifest = await buildManifest({ ...input(), data: data(), tape: tape([await slice()]) });
  const mutations: ((m: typeof manifest) => void)[] = [
    m => { m.runId = "0".repeat(64); }, m => { m.configSnapshot.marginBank = "other"; },
    m => { m.effective.cash++; }, m => { m.code.sourceHash = sha256("other"); },
    m => { m.codeCommit = "other"; }, m => { m.data!.candles++; },
    m => { m.marketSnapshot = null; }, m => { m.tapeSlices = []; },
    m => { m.tapeRecords[0].complete = false; }, m => { m.dataVersion = sha256("other"); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(manifest);
    mutate(changed);
    await assert.rejects(validateManifest(changed));
  }
  const changedTime = { ...manifest, capturedAt: "2030-01-01T00:00:00.000Z" };
  await validateManifest(changedTime);
  const withoutData = await buildManifest(input());
  await assert.rejects(validateManifest({ ...withoutData, marketSnapshot: await writeSnapshot(null) }), /Market snapshot identity mismatch/);
});

test("build captures effective inputs, normalized parameters and row data before awaiting I/O", async () => {
  const source = { ...input(), data: data() };
  const expected = await buildManifest(source);
  const pending = buildManifest(source);
  source.cfg.marginBank = "changed";
  source.effective.cash++;
  source.strategy.params.size = "999";
  source.data.funding[0].markPrice = "999";
  const built = await pending;
  assert.equal(built.runId, expected.runId);
  assert.equal(built.configSnapshot.marginBank, expected.configSnapshot.marginBank);
  assert.deepEqual(await readSnapshot(built.marketSnapshot!), await readSnapshot(expected.marketSnapshot!));
});
