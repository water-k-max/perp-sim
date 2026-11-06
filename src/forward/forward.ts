/**
 *  Forward-test analog design doc: land a public account's live fills against the stored
 *  resample band from the same strategy configuration.
 *
 *  There is no TradingView webhook here; the native source is better — the indexer's
 *  `PerpPositionChange` rows for any public testnet account, replayed through the same
 *  `PositionBook` the backtest uses (`reconcileAccount`). Each live fill's realized PnL
 *  accumulates from zero and is plotted against the stored band expressed as PnL offsets
 *  from the run's start equity, step for step. Bar-assumption errors show up as live
 *  points straying outside the band the backtest promised.
 *
 *  Read-only throughout: indexer reads, no signer, no keys, no other account touched.
 *
 *  Honesty framing, kept verbatim in spirit: the band models the backtest's own
 *  trade-order risk, not a forecast; a handful of live fills cannot validate or
 *  condemn a model — landing outside the band is an investigation trigger, not a
 *  verdict, and landing inside is not proof of an edge.
 */

import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { reconcileAccount } from "../verify/replay-account.js";
import { toRaw, fromRaw } from "../units.js";
import { loadRun } from "../runs/store.js";
import { resampleStoredRun } from "../resample/service.js";
import type { ResampleAnalysis } from "../resample/analysis.js";

export type LiveFill = {
  fillId: string;
  t: number;
  /** Realized PnL this fill produced, exact raw quote units. */
  pnl: bigint;
};

export type ForwardBandStep = {
  step: number;
  p10: bigint;
  p25: bigint;
  p50: bigint;
  p75: bigint;
  p90: bigint;
};

export type ForwardPoint = {
  seq: number;
  t: number;
  fillId: string;
  /** Cumulative realized PnL after this fill, raw quote units from zero. */
  cumulativePnl: bigint;
  /** Band quantiles at this step (offsets from the run's start), raw quote units. */
  band: ForwardBandStep | null;
  outsideP10P90: boolean;
};

export type ForwardTest = {
  runId: string;
  account: string;
  market: string;
  quoteDecimals: number;
  /** The distribution the band came from. */
  bandMode: string;
  fills: number;
  skippedFills: number;
  points: ForwardPoint[];
  outsideP10P90: number;
  insideP25P75: number;
  firstOutsideSeq: number | null;
  notes: string[];
};

/** The band for comparison: same-multiset shuffle order risk, else the first distribution. */
export function pickBand(analysis: ResampleAnalysis, quoteDecimals: number): ForwardBandStep[] {
  const dist = analysis.distributions.find((d) => d.mode === "shuffle_without_replacement") ?? analysis.distributions[0];
  if (!dist) throw new Error("The stored analysis has no distribution to compare against.");
  const start = toRaw(analysis.input.startEquity, quoteDecimals);
  const raw = (decimal: string) => toRaw(decimal, quoteDecimals) - start;
  return dist.fan.map((band) => ({
    step: band.step,
    p10: raw(band.p10),
    p25: raw(band.p25),
    p50: raw(band.p50),
    p75: raw(band.p75),
    p90: raw(band.p90),
  }));
}

/** Pure core: land chronological live fills on the band. Exact bigint end to end. */
export function buildForwardTest(opts: {
  runId: string;
  account: string;
  analysis: ResampleAnalysis;
  quoteDecimals: number;
  fills: readonly LiveFill[];
  skippedFills?: number;
}): ForwardTest {
  const band = pickBand(opts.analysis, opts.quoteDecimals);
  const points: ForwardPoint[] = [];
  let cumulative = 0n;
  let outside = 0;
  let insideInner = 0;
  let firstOutside: number | null = null;

  opts.fills.forEach((fill, i) => {
    cumulative += fill.pnl;
    const at = band[Math.min(i + 1, band.length - 1)] ?? null;
    const isOutside = at !== null && (cumulative < at.p10 || cumulative > at.p90);
    if (isOutside) {
      outside += 1;
      if (firstOutside === null) firstOutside = i + 1;
    }
    if (at !== null && cumulative >= at.p25 && cumulative <= at.p75) insideInner += 1;
    points.push({ seq: i + 1, t: fill.t, fillId: fill.fillId, cumulativePnl: cumulative, band: at, outsideP10P90: isOutside });
  });

  return {
    runId: opts.runId,
    account: opts.account,
    market: opts.analysis.input.market,
    quoteDecimals: opts.quoteDecimals,
    bandMode: opts.analysis.distributions.find((d) => d.mode === "shuffle_without_replacement")?.mode ?? opts.analysis.distributions[0]!.mode,
    fills: opts.fills.length,
    skippedFills: opts.skippedFills ?? 0,
    points,
    outsideP10P90: outside,
    insideP25P75: insideInner,
    firstOutsideSeq: firstOutside,
    notes: [
      "The band models the backtest's own trade-order risk; it is not a forecast of live PnL.",
      "Live fills come from a different account than the replay; both are compared as PnL offsets from their own starting points.",
      "A live point outside the p10–p90 band is an investigation trigger, not a verdict; inside is not proof of an edge.",
      "A few dozen live fills cannot validate or condemn a model — read the drift, not the verdict.",
    ],
  };
}

export type ForwardStoredOptions = {
  client: SomniaMarketsClient;
  account: string;
  runId: string;
  fromSec: number;
  toSec: number;
  maxFills?: number;
};

/**
 *  Poll a public account's fills over the window and land them on the stored run's
 *  band. The band rebuilds from the run store with the default (runId-derived) seed, so
 *  the same run always offers the same comparison surface.
 */
export async function forwardStoredRun(opts: ForwardStoredOptions): Promise<ForwardTest> {
  const saved = await loadRun<unknown>(opts.runId);
  if (!saved) throw new Error("No saved run with that id.");
  const cfg = saved.manifest.configSnapshot;
  const { analysis } = await resampleStoredRun(opts.runId, {});
  const report = await reconcileAccount({
    client: opts.client,
    cfg,
    account: opts.account,
    fromSec: opts.fromSec,
    toSec: opts.toSec,
    maxFills: opts.maxFills ?? 500,
  });
  const fills: LiveFill[] = report.rows.map((row, i) => ({
    fillId: row.fillId,
    t: row.t,
    pnl: row.actual.realizedPnl,
    seq: i,
  }));
  return buildForwardTest({
    runId: opts.runId,
    account: report.account,
    analysis,
    quoteDecimals: cfg.quoteDecimals,
    fills,
    skippedFills: report.unmatched,
  });
}

/** Decimal-string view for the API edge; the pure core stays bigint. */
export function forwardTestJson(test: ForwardTest) {
  const dec = (v: bigint) => fromRaw(v, test.quoteDecimals);
  return {
    runId: test.runId,
    account: test.account,
    market: test.market,
    quoteDecimals: test.quoteDecimals,
    bandMode: test.bandMode,
    fills: test.fills,
    skippedFills: test.skippedFills,
    outsideP10P90: test.outsideP10P90,
    insideP25P75: test.insideP25P75,
    firstOutsideSeq: test.firstOutsideSeq,
    points: test.points.map((p) => ({
      seq: p.seq,
      t: p.t,
      fillId: p.fillId,
      cumulativePnl: dec(p.cumulativePnl),
      band: p.band === null ? null : {
        step: p.band.step,
        p10: dec(p.band.p10),
        p25: dec(p.band.p25),
        p50: dec(p.band.p50),
        p75: dec(p.band.p75),
        p90: dec(p.band.p90),
      },
      outsideP10P90: p.outsideP10P90,
    })),
    notes: test.notes,
  };
}
