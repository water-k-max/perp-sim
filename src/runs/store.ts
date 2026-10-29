import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashMarketData } from "../data/ingest.js";
import { cacheRoot, CacheCorruptionError, readSnapshot, sha256, writeSnapshot } from "../data/store.js";
import type { MarketData } from "../data/types.js";
import { stableManifest, validateManifest, type RunManifest } from "./manifest.js";

export type RunSummary = {
  runId: string;
  market: string;
  from: number;
  to: number;
  fillModel: string;
  profile: string | null;
  strategy: string;
  status: string;
  equityEnd: string;
  quoteSymbol: string;
  finishedAt: string;
};

export type RunBundle<T> = {
  version: 3;
  manifest: RunManifest;
  request: unknown;
  result: T;
  resultDigest: string;
  replaySnapshot: string;
  /** Semantic digest permits reacquisition timestamps to differ on an identical replay. */
  replayDigest: string;
  summary: RunSummary;
};

export class RunConflictError extends Error {}

const DIGEST = /^[a-f0-9]{64}$/;
function digest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasCode(error: unknown, code: string): boolean { return object(error) && error.code === code; }
function directory(): string { return join(cacheRoot(), "v3", "runs"); }
function pointerPath(runId: string): string {
  if (!digest(runId)) throw new Error("Invalid run ID: expected a lowercase SHA256 digest");
  return join(directory(), `${runId}.json`);
}
function text(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function summarize(manifest: RunManifest, result: unknown): RunSummary {
  const view = object(result) ? result : {};
  const model = object(view.model) ? view.model : {};
  const strategy = object(view.strategy) ? view.strategy : {};
  return {
    runId: manifest.runId,
    market: text(view.market, manifest.configSnapshot.symbol),
    from: number(view.from, manifest.effective.fromSec),
    to: number(view.to, manifest.effective.toSec),
    fillModel: text(model.fillModel, manifest.effective.model.fillModel),
    profile: model.profile === null ? null : text(model.profile, manifest.effective.model.profile ?? "") || null,
    strategy: text(strategy.id, manifest.effective.strategy.id),
    status: text(view.status, "?"),
    equityEnd: typeof view.equityEnd === "bigint" || typeof view.equityEnd === "number"
      ? String(view.equityEnd) : text(view.equityEnd, "0"),
    quoteSymbol: text(view.quoteSymbol, manifest.configSnapshot.quoteSymbol),
    finishedAt: manifest.capturedAt,
  };
}

async function resultIdentity(result: unknown, manifest: RunManifest): Promise<string> {
  if (!object(result) || !("manifest" in result)) return sha256(result);
  const publicManifest: unknown = JSON.parse(JSON.stringify(manifest, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value));
  if (sha256(result.manifest) !== sha256(manifest) && sha256(result.manifest) !== sha256(publicManifest)) {
    throw new Error("Result manifest identity mismatch");
  }
  return sha256({ ...result, manifest: stableManifest(manifest) });
}

function marketData(value: unknown): value is MarketData {
  return object(value) && object(value.manifest) && Array.isArray(value.funding) &&
    Array.isArray(value.candles3600) && Array.isArray(value.epochs);
}

/** Normalize only acquisition metadata, never engine rows, events, or request parameters. */
async function replayIdentity(snapshot: string): Promise<string> {
  async function normalize(value: unknown, acquisition = false): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(item => normalize(item)));
    if (!object(value)) return value;
    if (value.schemaVersion === 3 && "runId" in value) return stableManifest(await validateManifest(value));
    if (marketData(value)) return { marketDataHash: hashMarketData(value) };
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      if (acquisition && (key === "capturedAt" || key === "captureTimestamp")) continue;
      if (key === "marketSnapshot" && item !== null) {
        if (!digest(item)) throw new Error("Invalid replay market snapshot digest");
        const data = await readSnapshot<unknown>(item);
        if (!marketData(data) || data.manifest.sha256 !== hashMarketData(data)) throw new Error("Invalid replay market snapshot");
        entries.push([key, { marketDataHash: hashMarketData(data) }]);
      } else entries.push([key, await normalize(item, key === "manifest")]);
    }
    return Object.fromEntries(entries);
  }
  return sha256(await normalize(await readSnapshot<unknown>(snapshot), true));
}

async function validateBundle<T>(value: unknown, runId: string): Promise<RunBundle<T>> {
  if (!object(value) || value.version !== 3 || !("request" in value) || !("result" in value) ||
      !digest(value.resultDigest) || !digest(value.replaySnapshot) || !digest(value.replayDigest) || !object(value.summary)) {
    throw new Error("Invalid run bundle");
  }
  const manifest = await validateManifest(value.manifest);
  if (manifest.runId !== runId) throw new Error("Run bundle identity mismatch");
  if (await resultIdentity(value.result, manifest) !== value.resultDigest) throw new Error("Run result digest mismatch");
  if (await replayIdentity(value.replaySnapshot) !== value.replayDigest) throw new Error("Run replay digest mismatch");
  if (sha256(summarize(manifest, value.result)) !== sha256(value.summary)) throw new Error("Run summary mismatch");
  return value as unknown as RunBundle<T>;
}

/** Missing IDs return null; malformed IDs, corrupt objects, and dangling snapshots throw. */
export async function loadRun<T>(runId: string): Promise<RunBundle<T> | null> {
  const target = pointerPath(runId);
  let body: string;
  try { body = await readFile(target, "utf8"); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  try {
    const pointer: unknown = JSON.parse(body);
    if (!object(pointer) || pointer.version !== 3 || pointer.runId !== runId || !digest(pointer.bundleDigest)) {
      throw new Error("Invalid run pointer");
    }
    return await validateBundle<T>(await readSnapshot<unknown>(pointer.bundleDigest), runId);
  } catch (error) {
    throw new CacheCorruptionError(`Corrupt saved run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Publish a complete immutable bundle, with an atomic create-only run-ID pointer. */
export async function saveRun<T>(input: {
  manifest: RunManifest;
  request: unknown;
  result: T;
  replaySnapshot: string;
}): Promise<RunBundle<T>> {
  const { manifest, request, result, replaySnapshot } = structuredClone(input);
  const target = pointerPath(manifest.runId);
  if (request === undefined || result === undefined) throw new Error("Run request and result must be serializable values");
  await validateManifest(manifest);
  if (!digest(replaySnapshot)) throw new Error("Invalid replay snapshot digest");
  const resultDigest = await resultIdentity(result, manifest);
  const replayDigest = await replayIdentity(replaySnapshot);
  const bundle: RunBundle<T> = {
    version: 3, manifest, request, result, resultDigest, replaySnapshot, replayDigest,
    summary: summarize(manifest, result),
  };
  const accept = (existing: RunBundle<T>): RunBundle<T> => {
    if (existing.resultDigest !== resultDigest || existing.replayDigest !== replayDigest) {
      throw new RunConflictError(`Run ${manifest.runId} already exists with a different result or replay semantics`);
    }
    return existing;
  };
  const existing = await loadRun<T>(manifest.runId);
  if (existing) return accept(existing);
  const bundleDigest = await writeSnapshot(bundle);
  await mkdir(directory(), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 3, runId: manifest.runId, bundleDigest }), { flag: "wx", flush: true });
    try { await link(temp, target); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const parent = await open(directory(), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await unlink(temp).catch(error => { if (!hasCode(error, "ENOENT")) throw error; });
  }
  // Another process may have won publication. Always return the first, fully validated object.
  const published = await loadRun<T>(manifest.runId);
  if (!published) throw new Error("Published run pointer disappeared");
  return accept(published);
}

/** Disk-backed listing has no eviction policy; limit affects this response only. */
export async function listRuns(limit = 50): Promise<RunSummary[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Run limit must be a non-negative integer");
  if (limit === 0) return [];
  let names: string[];
  try { names = await readdir(directory()); }
  catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  const summaries: RunSummary[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const run = await loadRun<unknown>(name.slice(0, 64));
    if (run) summaries.push(run.summary);
  }
  return summaries.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.runId.localeCompare(b.runId)).slice(0, limit);
}
