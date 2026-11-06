/**
 *  Trade-order drawing for the two resampling modes design doc.
 *
 *  `shuffle_without_replacement` permutes the trade list, preserving the exact multiset —
 *  it answers "was the *order* lucky?". When a path's horizon exceeds the trade count the
 *  walk cycles into a fresh permutation from the same stream, so every cycle still
 *  preserves the multiset. `bootstrap_with_replacement` draws i.i.d. from the trade list —
 *  it answers "what if the realized trades are a sample from a wider behaviour?".
 */

import type { Rng } from "./rng.js";
import { nextIndex } from "./rng.js";

export const RESAMPLE_MODES = ["shuffle_without_replacement", "bootstrap_with_replacement"] as const;
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

/** A path's full order of length `horizon`, per the mode, drawn from the path's stream. */
export function drawOrder<T>(items: readonly T[], mode: ResampleMode, horizon: number, rng: Rng): T[] {
  if (items.length === 0) throw new Error("cannot resample an empty trade list");
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error("horizon must be a positive integer");
  if (mode === "bootstrap_with_replacement") return bootstrapWithReplacement(items, horizon, rng);
  const out: T[] = [];
  while (out.length < horizon) out.push(...shuffleWithoutReplacement(items, rng));
  return out.slice(0, horizon);
}
