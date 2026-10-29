import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile, rename, unlink, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const ROOT = process.env.PERP_SIM_CACHE ?? fileURLToPath(new URL("../../.cache/perp-sim/", import.meta.url));
const VERSION = 3;
export function canonical(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite values cannot identify a replay.");
  if (typeof value === "bigint") return `{"$bigint":${JSON.stringify(value.toString())}}`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
function decode(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "$bigint" in value && Object.keys(value).length === 1)
    return BigInt((value as { $bigint: string }).$bigint);
  return value;
}
export function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function datasetKey(spec: unknown): string { return sha256(spec); }
function validate(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error(`Invalid cache digest: ${key}`);
}
function path(kind: "snapshots" | "requests", key: string): string {
  validate(key);
  return join(ROOT, "v3", kind, key.slice(0, 2), `${key}.json.gz`);
}
export class SnapshotMissingError extends Error {}
export class CacheCorruptionError extends Error {}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
async function readObject(target: string): Promise<Record<string, unknown> | null> {
  let bytes: Buffer;
  try { bytes = await readFile(target); } catch (error) { if (missing(error)) return null; throw error; }
  try {
    const value: unknown = JSON.parse(gunzipSync(bytes).toString("utf8"), decode);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object envelope");
    return value as Record<string, unknown>;
  }
  catch (error) { throw new CacheCorruptionError(`Corrupt cache object ${target}: ${error}`); }
}
async function atomic(target: string, body: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, gzipSync(canonical(body)), { flag: "wx", flush: true });
    await rename(temp, target);
    const directory = await open(dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
}
/** Immutable full-content identity. Capture metadata is retained, unlike semantic hashes. */
export async function writeSnapshot(payload: unknown): Promise<string> {
  // Capture before the first await so caller mutation cannot change the object under its digest.
  payload = JSON.parse(canonical(payload), decode) as unknown;
  const digest = sha256(payload);
  const target = path("snapshots", digest);
  const existing = await readObject(target);
  if (existing !== null) { await readSnapshot(digest); return digest; }
  await atomic(target, { version: VERSION, digest, payload });
  return digest;
}
export async function readSnapshot<T>(digest: string): Promise<T> {
  const file = await readObject(path("snapshots", digest));
  if (file === null) throw new SnapshotMissingError(`Missing snapshot ${digest}`);
  if (file.version !== VERSION || file.digest !== digest || !("payload" in file) || sha256(file.payload) !== digest)
    throw new CacheCorruptionError(`Snapshot identity mismatch: ${digest}`);
  return file.payload as T;
}
/** Missing request indexes return null; corrupt indexes or dangling references throw. */
export async function readDataset<T>(key: string): Promise<T | null> {
  const file = await readObject(path("requests", key));
  if (file === null) return null;
  if (file.version !== VERSION || file.key !== key || typeof file.digest !== "string" || !/^[a-f0-9]{64}$/.test(file.digest))
    throw new CacheCorruptionError(`Request identity mismatch: ${key}`);
  return readSnapshot<T>(file.digest);
}
export async function writeDataset(key: string, payload: unknown): Promise<void> {
  const target = path("requests", key);
  const digest = await writeSnapshot(payload);
  await atomic(target, { version: VERSION, key, digest });
}
export function cacheRoot(): string { return ROOT; }
export type DatasetEntry = { key: string; bytes: number; modifiedAt: string };
async function list(kind: "snapshots" | "requests", limit: number): Promise<DatasetEntry[]> {
  const root = join(ROOT, "v3", kind);
  const out: DatasetEntry[] = [];
  let shards: string[];
  try { shards = await readdir(root); } catch (error) { if (missing(error)) return []; throw error; }
  for (const shard of shards) {
    if (!/^[a-f0-9]{2}$/.test(shard)) continue;
    for (const file of await readdir(join(root, shard))) {
      if (!/^[a-f0-9]{64}\.json\.gz$/.test(file) || !file.startsWith(shard)) continue;
      const info = await stat(join(root, shard, file));
      out.push({ key: file.slice(0, 64), bytes: info.size, modifiedAt: info.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}
export async function listDatasets(limit = 50): Promise<DatasetEntry[]> { return list("requests", limit); }
export async function listSnapshots(limit = 50): Promise<DatasetEntry[]> { return list("snapshots", limit); }
