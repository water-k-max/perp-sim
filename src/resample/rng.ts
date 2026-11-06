/**
 *  Seeded PRNG for the resampling engine.
 *
 *  Fixed, documented construction: every path gets its own stream, derived as
 *  `sha256(["perp-sim/resample/v1", seed, pathIndex])` and used to seed splitmix64, which
 *  fills the four state words of a xoshiro256** generator. All arithmetic is uint64 via
 *  bigint — no floats anywhere in the stream, and no `Math.random()` anywhere in the
 *  resample path (pinned by the determinism tests).
 */

import { createHash } from "node:crypto";

const MASK64 = (1n << 64n) - 1n;
const U64 = (x: bigint): bigint => x & MASK64;

/** A raw uint64 stream. */
export type Rng = () => bigint;

const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

/** splitmix64 as a stream: each call advances the state and returns one mixed uint64. */
export function splitmix64Stream(seed: bigint): Rng {
  let state = U64(seed);
  return () => {
    state = U64(state + GOLDEN_GAMMA);
    let z = state;
    z = U64((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = U64((z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return U64(z ^ (z >> 31n));
  };
}

function rotl(x: bigint, k: number): bigint {
  return U64((x << BigInt(k)) | (x >> BigInt(64 - k)));
}

/** xoshiro256** seeded by four splitmix64 words from `seed`. */
export function xoshiro256ss(seed: bigint): Rng {
  const fill = splitmix64Stream(seed);
  let s0 = fill();
  let s1 = fill();
  let s2 = fill();
  let s3 = fill();
  return () => {
    const result = U64(rotl(U64(s1 * 5n), 7) * 9n);
    const t = s1 << 17n;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 45);
    s0 = U64(s0);
    s1 = U64(s1);
    s2 = U64(s2);
    return result;
  };
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return `{"$bigint":"${value}"}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The independent random stream for one resampled path. */
export function deriveStream(seed: string | number | bigint, pathIndex: number): Rng {
  return deriveDomainStream("perp-sim/resample/v1", seed, pathIndex);
}

/** The independent random stream for one random-entry null path (a distinct domain, so edge draws never line up with resample draws). */
export function deriveEdgeStream(seed: string | number | bigint, pathIndex: number): Rng {
  return deriveDomainStream("perp-sim/edge/v1", seed, pathIndex);
}

function deriveDomainStream(domain: string, seed: string | number | bigint, pathIndex: number): Rng {
  if (!Number.isInteger(pathIndex) || pathIndex < 0) throw new Error("pathIndex must be a non-negative integer");
  const digest = createHash("sha256")
    .update(canonical([domain, seed, pathIndex]))
    .digest("hex");
  return xoshiro256ss(BigInt(`0x${digest}`));
}

/** An index in `[0, n)` via Lemire's multiply-high; the bias is below `n / 2^64`. */
export function nextIndex(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error("n must be a positive integer");
  return Number((rng() * BigInt(n)) >> 64n);
}
