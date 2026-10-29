import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashMarketData } from "../data/ingest.js";
import { readSnapshot, sha256, writeSnapshot } from "../data/store.js";
import type { SliceRecord, TapeSlice, TapeSource } from "../data/tape.js";
import type { MarketData } from "../data/types.js";
import { PROFILES } from "../engine/fills.js";
import type { RunResult } from "../engine/loop.js";
import type { MarketConfig } from "../history/market.js";

export type CodeIdentity = {
  /** Hash of actual source/configuration bytes, including uncommitted changes. */
  sourceHash: string;
  sourceCommit: string;
  runtime: string;
};

export type EffectiveInput = {
  cash: bigint;
  requestedSize: bigint;
  size: bigint;
  fromSec: number;
  toSec: number;
  intrabar: boolean;
  closeAtEnd: boolean;
  untilBar: number;
  side: string;
};

export type RunManifest = {
  schemaVersion: 3;
  runId: string;
  dataVersion: string;
  configHash: string;
  codeHash: string;
  code: CodeIdentity;
  /** Retained for existing displays; sourceHash also identifies dirty/unknown trees. */
  codeCommit: string;
  configSnapshot: MarketConfig;
  effective: EffectiveInput & {
    model: RunResult["model"] & { profileParams: { windowSec: number; participation: bigint } | null };
    strategy: RunResult["strategy"];
  };
  data: {
    pool: string;
    market: string;
    fromSec: number;
    toSec: number;
    fromBlock: number;
    toBlock: number;
    fundingRows: number;
    candles: number;
    epochs: number;
  } | null;
  marketSnapshot: string | null;
  /** Immutable snapshot digests, in consumption order (including repeated reads). */
  tapeSlices: string[];
  tapeRecords: SliceRecord[];
  capturedAt: string;
};

export type ManifestInput = {
  cfg: MarketConfig;
  data: MarketData | null;
  model: RunResult["model"];
  strategy: RunResult["strategy"];
  tape?: TapeSource;
  effective: EffectiveInput;
  code?: CodeIdentity;
};

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
const DIGEST = /^[a-f0-9]{64}$/;

/** Only commit metadata is read from the environment, never arbitrary environment values. */
export function codeCommit(): string {
  const value = process.env.GIT_COMMIT ?? process.env.SOURCE_COMMIT ?? "";
  return /^[0-9a-f]{7,64}$/i.test(value) ? value.toLowerCase() : "unknown";
}

/** Deliberately uncached: a long-lived server must see edits made between runs. */
export async function getCodeIdentity(root = ROOT): Promise<CodeIdentity> {
  const files: string[] = [];
  async function walk(directory: string, sourceOnly: boolean): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Never follow links or include hidden files (notably .env) and dependency trees.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, sourceOnly);
      else if (entry.isFile() && (!sourceOnly || /\.(tsx?|css|html)$/.test(entry.name))) files.push(path);
    }
  }
  await walk(join(root, "src"), true);
  await walk(join(root, "public"), false);
  files.push(...["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.web.json"].map(name => join(root, name)));
  const contents = await Promise.all(files.sort().map(async path => ({
    path: relative(root, path).split("\\").join("/"),
    bytes: (await readFile(path)).toString("base64"),
  })));
  let sourceCommit = codeCommit();
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000 });
    if (/^[a-f0-9]{40,64}$/.test(stdout.trim())) sourceCommit = stdout.trim();
  } catch { /* Source bytes still identify a build without git metadata. */ }
  return {
    sourceHash: sha256(contents),
    sourceCommit,
    runtime: `node:${process.versions.node};v8:${process.versions.v8};${process.platform};${process.arch}`,
  };
}

function describeData(data: MarketData | null): RunManifest["data"] {
  if (!data) return null;
  return {
    pool: data.manifest.pool,
    market: data.manifest.market,
    ...data.manifest.range,
    fundingRows: data.funding.length,
    candles: data.candles3600.length,
    epochs: data.epochs.length,
  };
}

function dataIdentity(data: MarketData | null, tapeRecords: SliceRecord[]): string {
  return sha256({ market: data === null ? null : hashMarketData(data), tapeRecords });
}

function runIdentity(manifest: Pick<RunManifest, "schemaVersion" | "configHash" | "dataVersion" | "codeHash">): string {
  const { schemaVersion, configHash, dataVersion, codeHash } = manifest;
  return sha256({ schemaVersion, configHash, dataVersion, codeHash });
}

/** Snapshot pointers retain acquisition metadata; semantic run identity does not. */
export function stableManifest(manifest: RunManifest): Omit<RunManifest, "capturedAt" | "marketSnapshot"> {
  const { capturedAt: _capturedAt, marketSnapshot: _marketSnapshot, ...stable } = manifest;
  return stable;
}

async function validateTape(records: SliceRecord[]): Promise<void> {
  for (const record of records) {
    if (!record || !DIGEST.test(record.digest) || typeof record.key !== "string" ||
        !Number.isSafeInteger(record.fromSec) || !Number.isSafeInteger(record.toSec) || record.toSec < record.fromSec ||
        !Number.isSafeInteger(record.fills) || record.fills < 0 || typeof record.complete !== "boolean") {
      throw new Error("Invalid tape record");
    }
    const slice = await readSnapshot<TapeSlice>(record.digest);
    if (!slice || slice.key !== record.key || slice.fromSec !== record.fromSec || slice.toSec !== record.toSec ||
        !Array.isArray(slice.fills) || slice.fills.length !== record.fills || slice.complete !== record.complete) {
      throw new Error("Tape snapshot identity mismatch");
    }
  }
}

export async function buildManifest(input: ManifestInput): Promise<RunManifest> {
  // Capture caller-owned mutable state before the first await.
  const { cfg, data, model, strategy, effective, code: override } = structuredClone({
    cfg: input.cfg, data: input.data, model: input.model, strategy: input.strategy,
    effective: input.effective, code: input.code,
  });
  const tapeRecords = structuredClone(input.tape?.consumed() ?? []);
  const profileParams = model.profile === null ? null : structuredClone(PROFILES[model.profile]);
  const resolved = { ...effective, model: { ...model, profileParams }, strategy };
  const code = override ?? await getCodeIdentity();
  // Do not trust a stale row hash supplied by the caller.
  if (data) data.manifest.sha256 = hashMarketData(data);
  const manifest: RunManifest = {
    schemaVersion: 3,
    runId: "",
    configHash: sha256({ configSnapshot: cfg, effective: resolved }),
    dataVersion: dataIdentity(data, tapeRecords),
    codeHash: sha256(code),
    code,
    codeCommit: code.sourceCommit,
    configSnapshot: cfg,
    effective: resolved,
    data: describeData(data),
    marketSnapshot: data === null ? null : await writeSnapshot(data),
    tapeSlices: tapeRecords.map(record => record.digest),
    tapeRecords,
    capturedAt: new Date().toISOString(),
  };
  manifest.runId = runIdentity(manifest);
  await validateManifest(manifest);
  return manifest;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate saved identity against its own pinned inputs, not today's code or profiles. */
export async function validateManifest(value: unknown): Promise<RunManifest> {
  if (!object(value) || value.schemaVersion !== 3 ||
      ![value.runId, value.configHash, value.dataVersion, value.codeHash].every(v => typeof v === "string" && DIGEST.test(v)) ||
      !object(value.code) || !object(value.configSnapshot) || !object(value.effective) ||
      !object(value.effective.model) || !object(value.effective.strategy) ||
      !object(value.effective.strategy.params) || !Array.isArray(value.tapeRecords) || !Array.isArray(value.tapeSlices) ||
      typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) {
    throw new Error("Invalid run manifest");
  }
  const manifest = value as unknown as RunManifest;
  const { effective, code } = manifest;
  if (!DIGEST.test(code.sourceHash) || typeof code.sourceCommit !== "string" || typeof code.runtime !== "string" ||
      typeof effective.cash !== "bigint" || typeof effective.requestedSize !== "bigint" || typeof effective.size !== "bigint" ||
      ![effective.fromSec, effective.toSec, effective.untilBar].every(Number.isSafeInteger) || effective.toSec < effective.fromSec ||
      typeof effective.intrabar !== "boolean" || typeof effective.closeAtEnd !== "boolean" || typeof effective.side !== "string" ||
      typeof effective.model.gasPerTx !== "bigint" || typeof effective.strategy.id !== "string") {
    throw new Error("Invalid effective run inputs or code identity");
  }
  if (manifest.codeCommit !== code.sourceCommit || manifest.codeHash !== sha256(code) ||
      manifest.configHash !== sha256({ configSnapshot: manifest.configSnapshot, effective }) ||
      manifest.runId !== runIdentity(manifest)) throw new Error("Run manifest identity mismatch");
  if (manifest.marketSnapshot !== null && (typeof manifest.marketSnapshot !== "string" || !DIGEST.test(manifest.marketSnapshot))) {
    throw new Error("Invalid market snapshot digest");
  }
  const data = manifest.marketSnapshot === null ? null : await readSnapshot<MarketData>(manifest.marketSnapshot);
  if (manifest.marketSnapshot !== null && (!object(data) || !object(data.manifest) || !Array.isArray(data.funding) ||
      !Array.isArray(data.candles3600) || !Array.isArray(data.epochs) || data.manifest.sha256 !== hashMarketData(data))) {
    throw new Error("Market snapshot identity mismatch");
  }
  await validateTape(manifest.tapeRecords);
  if (sha256(manifest.tapeSlices) !== sha256(manifest.tapeRecords.map(record => record.digest)) ||
      sha256(manifest.data) !== sha256(describeData(data)) || manifest.dataVersion !== dataIdentity(data, manifest.tapeRecords)) {
    throw new Error("Run manifest data identity mismatch");
  }
  return manifest;
}
