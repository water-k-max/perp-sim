/**
 *  Trade-order drawing for the resampling modes design doc.
 *
 *  `shuffle_without_replacement` permutes the trade list, preserving the exact multiset —
 *  it answers "was the *order* lucky?". When a path's horizon exceeds the trade count the
 *  walk cycles into a fresh permutation from the same stream, so every cycle still
 *  preserves the multiset. `bootstrap_with_replacement` draws i.i.d. from the trade list —
 *  it answers "what if the realized trades are a sample from a wider behaviour?".
 *  `block_bootstrap_with_replacement` draws circular blocks of consecutive trades, so
 *  streaks and regime clustering survive the resample — i.i.d. draws hide them by
 *  construction. The block length follows the usual n^(1/3) rule and is disclosed, not tuned.
 */

import type { Rng } from "./rng.js";
import { nextIndex } from "./rng.js";

export const RESAMPLE_MODES = ["shuffle_without_replacement", "bootstrap_with_replacement", "block_bootstrap_with_replacement"] as const;
export type ResampleMode = (typeof RESAMPLE_MODES)[number];

export function isResampleMode(value: unknown): value is ResampleMode {
  return typeof value === "string" && (RESAMPLE_MODES as readonly string[]).includes(value);
}

/** Fisher–Yates permutation of `items` driven by `rng`. */
export function shuffleWithoutReplacement<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = nextIndex(rng, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** `count` independent draws from `items` (a path may repeat or omit trades). */
export function bootstrapWithReplacement<T>(items: readonly T[], count: number, rng: Rng): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) out.push(items[nextIndex(rng, items.length)]!);
  return out;
}

/** The block length for a circular block bootstrap over `tradeCount` trades: ⌈n^(1/3)⌉, at least 1. */
export function blockLength(tradeCount: number): number {
  if (!Number.isInteger(tradeCount) || tradeCount < 1) throw new Error("block length needs a positive trade count");
  return Math.max(1, Math.ceil(Math.cbrt(tradeCount)));
}

/**
 *  `count` draws as circular blocks of consecutive trades: each block starts at a uniform
 *  index and wraps past the end, so adjacency inside a block is always real adjacency in
 *  the chronological list. Blocks are drawn until the horizon is filled, then truncated.
 */
export function bootstrapBlocks<T>(items: readonly T[], count: number, rng: Rng): T[] {
  if (items.length === 0) throw new Error("cannot resample an empty trade list");
  const n = items.length;
  const block = Math.min(blockLength(n), n);
  const out: T[] = [];
  while (out.length < count) {
    const start = nextIndex(rng, n);
    for (let i = 0; i < block && out.length < count; i += 1) out.push(items[(start + i) % n]!);
  }
  return out;
}

/** A path's full order of length `horizon`, per the mode, drawn from the path's stream. */
export function drawOrder<T>(items: readonly T[], mode: ResampleMode, horizon: number, rng: Rng): T[] {
  if (items.length === 0) throw new Error("cannot resample an empty trade list");
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error("horizon must be a positive integer");
  if (mode === "bootstrap_with_replacement") return bootstrapWithReplacement(items, horizon, rng);
  if (mode === "block_bootstrap_with_replacement") return bootstrapBlocks(items, horizon, rng);
  const out: T[] = [];
  while (out.length < horizon) out.push(...shuffleWithoutReplacement(items, rng));
  return out.slice(0, horizon);
}
