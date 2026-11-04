/**
 *  The spec §11 analysis document: one deterministic JSON value that carries the
 *  distribution, the optimism audit, the sizing ladder and the out-of-sample boundary.
 *
 *  Every quantity is either an exact decimal string or a plain number produced by the
 *  single permitted float step (percentile interpolation on decimal units). Building the
 *  document twice from the same inputs yields a bit-identical value, which is what the
 *  resample-deterministic invariant checks mechanically.
 */

import { sha256, canonical } from "../data/store.js";
import { fromRaw, toRaw } from "../units.js";
import { summarizePaths, type PathSummary } from "./stats.js";
import { simulatePaths, type SizingMode } from "./path.js";
import { isResampleMode, type ResampleMode } from "./sample.js";
import { auditTradeList, assumptionLines, type RunAssumptions } from "./audit.js";
import { simulateSizing } from "./sizing.js";
import { runOos } from "./oos.js";
import { aggregateTradeDays, parsePropRules, simulatePropEvaluation, type PropRules } from "./prop.js";
import type { TradeList } from "./inputs.js";

export type ResampleModeSelection = ResampleMode | "both";

export type ResampleRequest = {
  seed: string;
  paths: number;
  mode: ResampleModeSelection;
  sizing: SizingMode;
  /** Path length in trades; null = the trade count. */
  horizonTrades: number | null;
  /** Maximum accepted loss in decimal quote units; null = 10% of start equity. */
  acceptedLoss: string | null;
  /** Fraction of the tail held back; null = no OOS block. */
  holdbackFraction: number | null;
  /** Prop-evaluation rules form (spec §9); null = no prop block. */
  prop: PropRules | null;
};

export const RESAMPLE_PATHS_MIN = 10;
export const RESAMPLE_PATHS_MAX = 20_000;

export function defaultResampleSeed(runId: string): string {
  return sha256(canonical(["perp-sim/resample-seed/v1", runId]));
}

export function parseResampleRequest(value: unknown): ResampleRequest {
  if (value === undefined || value === null) {
    return { seed: "", paths: 1000, mode: "both", sizing: "static", horizonTrades: null, acceptedLoss: null, holdbackFraction: 0.3, prop: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("resample must be an object.");
  const v = value as Record<string, unknown>;
  const seed = v.seed ?? "";
  if (typeof seed !== "string" || seed.length > 128) throw new Error("resample seed must be a string of at most 128 characters.");
  const paths = v.paths ?? 1000;
  if (!Number.isInteger(paths) || Number(paths) < RESAMPLE_PATHS_MIN || Number(paths) > RESAMPLE_PATHS_MAX) {
    throw new Error(`resample paths must be a whole number in [${RESAMPLE_PATHS_MIN}, ${RESAMPLE_PATHS_MAX}].`);
  }
  const mode = v.mode ?? "both";
  if (mode !== "both" && !isResampleMode(mode)) throw new Error("resample mode must be shuffle_without_replacement, bootstrap_with_replacement or both.");
  const sizing = v.sizing ?? "static";
  if (sizing !== "static" && sizing !== "compound") throw new Error("resample sizing must be static or compound.");
  const horizonTrades = v.horizonTrades === undefined || v.horizonTrades === null ? null : Number(v.horizonTrades);
  if (horizonTrades !== null && (!Number.isInteger(horizonTrades) || horizonTrades < 1 || horizonTrades > 1_000_000)) {
    throw new Error("resample horizonTrades must be a positive whole number.");
  }
  const acceptedLoss = v.acceptedLoss ?? null;
  if (acceptedLoss !== null && (typeof acceptedLoss !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(acceptedLoss) || Number(acceptedLoss) <= 0)) {
    throw new Error("resample acceptedLoss must be a positive decimal.");
  }
  const holdbackFraction = v.holdbackFraction === undefined ? 0.3 : v.holdbackFraction;
  if (holdbackFraction !== null && !(typeof holdbackFraction === "number" && holdbackFraction > 0 && holdbackFraction < 1)) {
    throw new Error("resample holdbackFraction must be in (0, 1).");
  }
  const prop = v.prop === undefined || v.prop === null ? null : parsePropRules(v.prop);
  return { seed, paths: Number(paths), mode, sizing: sizing as SizingMode, horizonTrades, acceptedLoss, holdbackFraction, prop };
}

export type DistributionBlock = {
  mode: ResampleMode;
  paths: number;
  finalEquities: string[];
  median: string;
  p05: string;
  p10: string;
  p25: string;
  p50: string;
  p75: string;
  p90: string;
  p95: string;
  cvar95: string;
  bankruptcyRate: string;
  medianMaxDrawdownBps: number;
  p95MaxDrawdownBps: number;
  medianMaxLosingStreak: number;
  p95MaxLosingStreak: number;
  fan: { step: number; p10: string; p25: string; p50: string; p75: string; p90: string }[];
};

export type ResampleAnalysis = {
  version: 1;
  meta: {
    seed: string;
    paths: number;
    horizonTrades: number;
    mode: ResampleModeSelection;
    sizing: SizingMode;
    source: { kind: "run"; runId: string };
    createdAt: string;
  };
  input: {
    market: string;
    tradeCount: number;
    sameBarCount: number;
    withoutExcursionCount: number;
    sameBarShareBps: number;
    dismissed: boolean;
    window: { from: number | null; to: number | null };
    startEquity: string;
  };
  assumptions: string[];
  distributions: DistributionBlock[];
  audit: {
    sameBarShareBps: number;
    dismissed: boolean;
    repricedCount: number;
    repricedFinalEquities: string[];
    repricedMedianDeltaBps: number;
    notes: string[];
  };
  sizing: {
    acceptedLoss: string;
    horizonTrades: number;
    rows: { sizeBase: string; lossProbability: string; medianPnl: string; p05Pnl: string }[];
    note: string | null;
  };
  oos: {
    holdbackFraction: number;
    fitCount: number;
    heldCount: number;
    boundary: string;
    heldCurve: string[];
    heldFinalMinusStart: string;
    crossed: boolean;
    /** Trade seqs per half, so the no-lookahead invariant is checkable from the artifact. */
    fitSeqs: number[];
    heldSeqs: number[];
    notes: string[];
  } | null;
  warnings: string[];
  /** Prop-evaluation replay of the strategy's own trading days (spec §9); null when not requested. */
  prop: {
    rules: PropRules;
    dayCount: number;
    daysWithMissingExcursion: number;
    outcomes: { outcome: string; count: number; share: string }[];
    fundedShare: string;
    tradesToFund: { median: string; p05: string; p95: string } | null;
    medianDaysToFund: number | null;
    expectedResets: string | null;
    payouts: { cadence: string; feeBps: number; average: string; bad: string } | null;
    notes: string[];
  } | null;
};

function f6(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function distributionBlock(mode: ResampleMode, summary: PathSummary, quoteDecimals: number): DistributionBlock {
  return {
    mode,
    paths: summary.paths,
    finalEquities: summary.finalEquities.map((v) => fromRaw(v, quoteDecimals)),
    median: f6(summary.medianFinalEquity),
    p05: f6(summary.p05FinalEquity),
    p10: f6(summary.p10FinalEquity),
    p25: f6(summary.p25FinalEquity),
    p50: f6(summary.p50FinalEquity),
    p75: f6(summary.p75FinalEquity),
    p90: f6(summary.p90FinalEquity),
    p95: f6(summary.p95FinalEquity),
    cvar95: f6(summary.cvar95),
    bankruptcyRate: summary.bankruptcyRate.toFixed(3),
    medianMaxDrawdownBps: summary.medianMaxDrawdownBps,
    p95MaxDrawdownBps: summary.p95MaxDrawdownBps,
    medianMaxLosingStreak: summary.medianMaxLosingStreak,
    p95MaxLosingStreak: summary.p95MaxLosingStreak,
    fan: summary.fan.map((band) => ({
      step: band.step,
      p10: f6(band.p10),
      p25: f6(band.p25),
      p50: f6(band.p50),
      p75: f6(band.p75),
      p90: f6(band.p90),
    })),
  };
}

export type AnalysisInputs = {
  runId: string;
  list: TradeList;
  request: ResampleRequest;
  /** Deterministic timestamp (the run manifest's capturedAt) so replays stay bit-identical. */
  createdAt: string;
  start: bigint;
  quoteDecimals: number;
  baseDecimals: number;
  quoteScale: bigint;
  oneBase: bigint;
  lotSize: bigint;
  maxSize: bigint;
  markPrice: bigint;
  effectiveImfBps: bigint;
  market: string;
  assumptions: RunAssumptions;
};

export function buildResampleAnalysis(inputs: AnalysisInputs): ResampleAnalysis {
  const { list, request } = inputs;
  const seed = request.seed === "" ? defaultResampleSeed(inputs.runId) : request.seed;
  const horizon = request.horizonTrades ?? Math.max(list.trades.length, 1);
  const acceptedLossQuote = request.acceptedLoss === null
    ? inputs.start / 10n
    : toRaw(request.acceptedLoss, inputs.quoteDecimals);
  const modes: ResampleMode[] = request.mode === "both"
    ? ["shuffle_without_replacement", "bootstrap_with_replacement"]
    : [request.mode];

  const distributions = modes.map((mode) => {
    const paths = list.trades.length === 0 ? [] : simulatePaths({
      trades: list.trades.map((t) => ({ pnl: t.pnl })),
      mode,
      sizing: request.sizing,
      paths: request.paths,
      horizon,
      start: inputs.start,
      seed,
    });
    const summary = list.trades.length === 0
      ? null
      : summarizePaths(paths, inputs.quoteScale);
    return summary === null ? null : distributionBlock(mode, summary, inputs.quoteDecimals);
  }).filter((d): d is DistributionBlock => d !== null);

  const audit = auditTradeList(list, inputs.assumptions, {
    paths: request.paths,
    horizon,
    sizing: request.sizing,
    start: inputs.start,
    seed,
    quoteScale: inputs.quoteScale,
    oneBase: inputs.oneBase,
  });

  const sizing = list.trades.length === 0 ? null : simulateSizing({
    trades: list.trades,
    seed,
    paths: request.paths,
    horizonTrades: horizon,
    acceptedLossQuote,
    start: inputs.start,
    mode: modes[0]!,
    sizing: request.sizing,
    lotSize: inputs.lotSize,
    maxSize: inputs.maxSize,
    markPrice: inputs.markPrice,
    oneBase: inputs.oneBase,
    effectiveImfBps: inputs.effectiveImfBps,
    quoteScale: inputs.quoteScale,
  });

  const oos = list.trades.length < 2 || request.holdbackFraction === null ? null : runOos({
    trades: list.trades,
    holdbackFraction: request.holdbackFraction,
    seed,
    paths: request.paths,
    start: inputs.start,
    quoteScale: inputs.quoteScale,
  });

  const prop = request.prop === null || list.trades.length === 0 ? null : (() => {
    const start = request.prop.startingBalance === null
      ? inputs.start
      : toRaw(request.prop.startingBalance, inputs.quoteDecimals);
    const result = simulatePropEvaluation({
      days: aggregateTradeDays(list.trades),
      rules: request.prop,
      seed,
      paths: request.paths,
      start,
      toRaw: (decimal) => toRaw(decimal, inputs.quoteDecimals),
    });
    return {
      rules: result.rules,
      dayCount: result.dayCount,
      daysWithMissingExcursion: result.daysWithMissingExcursion,
      outcomes: result.outcomes.map((o) => ({ outcome: o.outcome, count: o.count, share: o.share.toFixed(4) })),
      fundedShare: result.fundedShare.toFixed(4),
      tradesToFund: result.tradesToFund === null ? null : {
        median: f6(result.tradesToFund.median),
        p05: f6(result.tradesToFund.p05),
        p95: f6(result.tradesToFund.p95),
      },
      medianDaysToFund: result.medianDaysToFund,
      expectedResets: result.expectedResets === null ? null : f6(result.expectedResets),
      payouts: result.payouts === null ? null : {
        cadence: result.payouts.cadence,
        feeBps: result.payouts.feeBps,
        average: fromRaw(result.payouts.average, inputs.quoteDecimals),
        bad: fromRaw(result.payouts.bad, inputs.quoteDecimals),
      },
      notes: result.notes,
    };
  })();

  const warnings: string[] = [];
  warnings.push("Distributions model trade-order risk on the recorded trade list; they are not a forecast of future PnL.");
  if (inputs.list.sameBarCount > 0) {
    warnings.push("Some trades entered and exited inside one settlement bar; only the observable excursion is priced, never a bound.");
  }
  if (list.trades.length < 30) warnings.push(`Only ${list.trades.length} trades: percentiles over so few observations are wide and unstable.`);
  if (request.paths < 5_000) warnings.push(`${request.paths} paths is a small sample; tail figures move noticeably with the seed.`);
  if (sizing !== null) for (const row of sizing.rows) {
    if (row.lossProbability > 0.5) {
      warnings.push(`Odds describe resampled paths, not the future: size ${fromRaw(row.sizeBase, inputs.baseDecimals)} breaches the accepted loss on a majority of paths.`);
      break;
    }
  }

  return {
    version: 1,
    meta: {
      seed,
      paths: request.paths,
      horizonTrades: horizon,
      mode: request.mode,
      sizing: request.sizing,
      source: { kind: "run", runId: inputs.runId },
      createdAt: inputs.createdAt,
    },
    input: {
      market: inputs.market,
      tradeCount: list.trades.length,
      sameBarCount: list.sameBarCount,
      withoutExcursionCount: list.withoutExcursionCount,
      sameBarShareBps: audit.sameBarShareBps,
      dismissed: audit.dismissed,
      window: list.window,
      startEquity: fromRaw(inputs.start, inputs.quoteDecimals),
    },
    assumptions: assumptionLines(inputs.assumptions),
    distributions,
    audit: {
      sameBarShareBps: audit.sameBarShareBps,
      dismissed: audit.dismissed,
      repricedCount: audit.repricedCount,
      repricedFinalEquities: audit.repricedFinalEquities.map((v) => fromRaw(v, inputs.quoteDecimals)),
      repricedMedianDeltaBps: audit.repricedMedianDeltaBps,
      notes: audit.notes,
    },
    sizing: sizing === null
      ? { acceptedLoss: fromRaw(acceptedLossQuote, inputs.quoteDecimals), horizonTrades: horizon, rows: [], note: null }
      : {
          acceptedLoss: fromRaw(acceptedLossQuote, inputs.quoteDecimals),
          horizonTrades: sizing.horizonTrades,
          rows: sizing.rows.map((row) => ({
            sizeBase: fromRaw(row.sizeBase, inputs.baseDecimals),
            lossProbability: row.lossProbability.toFixed(3),
            medianPnl: f6(row.medianPnl),
            p05Pnl: f6(row.p05Pnl),
          })),
          note: sizing.note,
        },
    oos: oos === null ? null : {
      holdbackFraction: oos.holdbackFraction,
      fitCount: oos.fitCount,
      heldCount: oos.heldCount,
      boundary: f6(oos.boundary),
      heldCurve: oos.heldCurve.map((v) => fromRaw(v, inputs.quoteDecimals)),
      heldFinalMinusStart: fromRaw(oos.heldFinalMinusStart, inputs.quoteDecimals),
      crossed: oos.crossed,
      fitSeqs: oos.fitSeqs,
      heldSeqs: oos.heldSeqs,
      notes: oos.notes,
    },
    warnings,
    prop,
  };
}
