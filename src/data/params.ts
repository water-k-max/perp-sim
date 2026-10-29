import type { MarketConfig } from "../history/market.js";
import { sha256 } from "./store.js";
import type { EpochRow } from "./types.js";

/**
 *  The risk and fee parameters a market enforced at a given block.
 *
 *  Hideki records these as `PerpPoolParametersEpoch` rows. They are not constants: BTC's
 *  max open interest roughly doubled inside a week of the window this project replays, and
 *  a replay priced with today's read would hold a position the chain would have capped.
 *  Each field therefore resolves to the newest epoch at or before the instant being priced,
 *  and only a `null` in that epoch falls back to the live chain read.
 */
export const PARAM_FIELDS = [
  "imBps",
  "mmBps",
  "closeOutBps",
  "takerFeeBpsTimes1k",
  "makerFeeBpsTimes1k",
  "maxPositionSize",
  "maxOpenInterest",
] as const;

export type ParamField = (typeof PARAM_FIELDS)[number];
export type ParamOrigin = Record<ParamField, "epoch" | "live">;

export type ResolvedParams = {
  /** The newest epoch at or before the instant, or null when the market had none yet. */
  epoch: EpochRow | null;
  values: Record<ParamField, bigint>;
  origin: ParamOrigin;
  /** Fields the governing epoch left null; they carry the live read. */
  missing: ParamField[];
};

const EPOCH_FIELD: Record<ParamField, keyof EpochRow> = {
  imBps: "initialMarginBps",
  mmBps: "maintenanceMarginBps",
  closeOutBps: "closeOutMarginBps",
  takerFeeBpsTimes1k: "takerFeeBpsTimes1k",
  makerFeeBpsTimes1k: "makerFeeBpsTimes1k",
  maxPositionSize: "maxPositionSize",
  maxOpenInterest: "maxOpenInterest",
};

function liveValues(live: MarketConfig): Record<ParamField, bigint> {
  return {
    imBps: live.imBps,
    mmBps: live.mmBps,
    closeOutBps: live.closeOutBps,
    takerFeeBpsTimes1k: live.takerFeeBpsTimes1k,
    makerFeeBpsTimes1k: live.makerFeeBpsTimes1k,
    maxPositionSize: live.maxPositionSize,
    maxOpenInterest: live.maxOpenInterest,
  };
}

export class ParameterTimeline {
  private readonly epochs: readonly EpochRow[];
  private readonly live: Record<ParamField, bigint>;

  constructor(epochs: readonly EpochRow[], live: MarketConfig) {
    this.epochs = [...epochs].sort((a, b) => a.blockNumber - b.blockNumber || (a.logIndex ?? 0) - (b.logIndex ?? 0));
    this.live = liveValues(live);
  }

  get size(): number {
    return this.epochs.length;
  }

  blocks(): number[] {
    return this.epochs.map((e) => e.blockNumber);
  }

  /** Newest epoch at or before `block`, or null. Epochs are sorted, so this is a binary search. */
  epochAtBlock(block: number): EpochRow | null {
    const i = upperBound(this.epochs.length, (k) => this.epochs[k]!.blockNumber <= block);
    return i > 0 ? this.epochs[i - 1]! : null;
  }

  /** Newest epoch whose block timestamp is at or before `t`. */
  epochAt(t: number): EpochRow | null {
    const i = upperBound(this.epochs.length, (k) => this.epochs[k]!.timestamp <= t);
    return i > 0 ? this.epochs[i - 1]! : null;
  }

  atBlock(block: number): ResolvedParams {
    return this.resolve(this.epochAtBlock(block));
  }

  at(t: number | bigint): ResolvedParams {
    return this.resolve(this.epochAt(Number(t)));
  }

  atPosition(block: number, logIndex: number): ResolvedParams {
    const i = upperBound(this.epochs.length, k => {
      const e = this.epochs[k]!;
      return e.blockNumber < block || (e.blockNumber === block && (e.logIndex ?? 0) <= logIndex);
    });
    return this.resolve(i > 0 ? this.epochs[i - 1]! : null);
  }

  private resolve(epoch: EpochRow | null): ResolvedParams {
    const values = { ...this.live };
    const origin = Object.fromEntries(PARAM_FIELDS.map((f) => [f, "live"])) as ParamOrigin;
    const missing: ParamField[] = [];
    if (epoch) {
      for (const field of PARAM_FIELDS) {
        const value = epoch[EPOCH_FIELD[field]] as bigint | null;
        if (value === null) missing.push(field);
        else {
          values[field] = value;
          origin[field] = "epoch";
        }
      }
    } else {
      missing.push(...PARAM_FIELDS);
    }
    return { epoch, values, origin, missing };
  }

  /** Stable identity of the epochs that governed a replay, so a manifest can name them. */
  digest(): string {
    return sha256(this.epochs);
  }
}

/** Return the count of leading entries for which `pred` holds, assuming it is monotone. */
function upperBound(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Replace a live config's epoch-governed fields with the ones resolved at a block. */
export function applyParams(live: MarketConfig, at: ResolvedParams): MarketConfig {
  return {
    ...live,
    imBps: at.values.imBps,
    mmBps: at.values.mmBps,
    closeOutBps: at.values.closeOutBps,
    takerFeeBpsTimes1k: at.values.takerFeeBpsTimes1k,
    makerFeeBpsTimes1k: at.values.makerFeeBpsTimes1k,
    maxPositionSize: at.values.maxPositionSize,
    maxOpenInterest: at.values.maxOpenInterest,
  };
}
