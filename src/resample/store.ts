/**
 *  Disk persistence for resample analyses, keyed by (runId, seed). The document is stored
 *  as a content-addressed snapshot with a small pointer file, mirroring the run store, so
 *  a re-request with the same seed returns the identical validated document and a different
 *  seed never collides with an existing one.
 */

import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheRoot, canonical, readSnapshot, sha256, writeSnapshot } from "../data/store.js";
import type { Invariant } from "../verify/invariants.js";
import type { ResampleAnalysis } from "./analysis.js";

export type StoredResample = {
  version: 1;
  runId: string;
  seed: string;
  analysis: ResampleAnalysis;
  invariants: Invariant[];
  documentDigest: string;
};

function key(runId: string, seed: string): string {
  return sha256(canonical(["perp-sim/resample-store/v1", runId, seed]));
}

function directory(): string { return join(cacheRoot(), "v3", "resample"); }
function pointerPath(runId: string, seed: string): string { return join(directory(), `${key(runId, seed)}.json`); }

/** Publish the document; an existing pointer with identical content returns the stored copy. */
export async function saveResampleAnalysis(runId: string, seed: string, analysis: ResampleAnalysis, invariants: Invariant[]): Promise<StoredResample> {
  const document: StoredResample = {
    version: 1, runId, seed, analysis, invariants, documentDigest: sha256({ analysis, invariants }),
  };
  const existing = await loadResampleAnalysis(runId, seed);
  if (existing) {
    if (existing.documentDigest !== document.documentDigest) throw new Error("Stored resample analysis conflicts with the rebuilt one.");
    return existing;
  }
  const digest = await writeSnapshot(document);
  await mkdir(directory(), { recursive: true });
  const target = pointerPath(runId, seed);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, runId, seed, digest }), { flag: "wx", flush: true });
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
  const stored = await loadResampleAnalysis(runId, seed);
  if (!stored) throw new Error("Published resample pointer disappeared.");
  return stored;
}

/** Missing keys return null; corrupt content throws. */
export async function loadResampleAnalysis(runId: string, seed: string): Promise<StoredResample | null> {
  let body: string;
  try { body = await readFile(pointerPath(runId, seed), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const pointer: unknown = JSON.parse(body);
  if (typeof pointer !== "object" || pointer === null || (pointer as { version?: unknown }).version !== 1) throw new Error("Invalid resample pointer.");
  const { digest } = pointer as { digest?: unknown };
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid resample pointer digest.");
  const document = await readSnapshot<StoredResample>(digest);
  if (document.version !== 1 || document.runId !== runId || document.seed !== seed || sha256({ analysis: document.analysis, invariants: document.invariants }) !== document.documentDigest) {
    throw new Error("Resample analysis identity mismatch.");
  }
  return document;
}
