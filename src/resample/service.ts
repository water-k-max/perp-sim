/**
 *  Re-run the full resample analysis over a saved run without touching the chain: the
 *  run bundle pins the market snapshot, the tape slices and the engine result, so the
 *  trade list rebuilds exactly and the analysis for a given (runId, seed) is reproducible.
 */

import { readSnapshot, sha256 } from "../data/store.js";
import type { MarketData } from "../data/types.js";
import type { TapeSlice } from "../data/tape.js";
import type { RunResult } from "../engine/loop.js";
import { buildBars, withIntraBarPath } from "../history/bars.js";
import { toRaw } from "../units.js";
import { loadRun } from "../runs/store.js";
import { checkResample, type Invariant } from "../verify/invariants.js";
import { buildResampleAnalysis, parseResampleRequest, type AnalysisInputs, type ResampleAnalysis } from "./analysis.js";
import { extractTrades } from "./inputs.js";
import { saveResampleAnalysis } from "./store.js";

export type ResampleOutcome = {
  analysis: ResampleAnalysis;
  invariants: Invariant[];
};

export async function resampleStoredRun(runId: string, rawResample: unknown): Promise<ResampleOutcome> {
  const request = parseResampleRequest(rawResample);
  const saved = await loadRun<unknown>(runId);
  if (!saved) throw new Error("No saved run with that id.");
  if (!saved.manifest.marketSnapshot) throw new Error("Saved run has no frozen market snapshot to resample over.");

  const snapshot = await readSnapshot<{ version: number; input: { cash: string; intrabar: boolean }; result: RunResult }>(saved.replaySnapshot);
  if (snapshot.version !== 3) throw new Error("Unsupported frozen replay version.");
  const data = await readSnapshot<MarketData>(saved.manifest.marketSnapshot);
  const cfg = saved.manifest.configSnapshot;

  let bars = buildBars(data.funding);
  if (snapshot.input.intrabar) bars = withIntraBarPath(bars, data.candles3600);

  const tapeFills = [];
  for (const record of saved.manifest.tapeRecords) {
    // Stored tape payloads carry no digest field (it is added only in the returned slice),
    // so identity is verified against the record the same way createFrozenTapeSource does.
    const slice = await readSnapshot<TapeSlice>(record.digest);
    if (
      slice.key !== record.key || slice.fromSec !== record.fromSec || slice.toSec !== record.toSec ||
      slice.fills.length !== record.fills || slice.complete !== record.complete || sha256(slice) !== record.digest
    ) throw new Error("Frozen tape slice identity mismatch.");
    tapeFills.push(...slice.fills);
  }

  const list = extractTrades(snapshot.result.trades, { bars, tape: tapeFills, oneBase: cfg.oneBase });
  const inputs: AnalysisInputs = {
    runId,
    list,
    request,
    createdAt: saved.manifest.capturedAt,
    start: toRaw(snapshot.input.cash, cfg.quoteDecimals),
    quoteDecimals: cfg.quoteDecimals,
    baseDecimals: cfg.baseDecimals,
    quoteScale: 10n ** BigInt(cfg.quoteDecimals),
    oneBase: cfg.oneBase,
    lotSize: cfg.lotSize,
    maxSize: cfg.maxPositionSize,
    markPrice: snapshot.result.trail.length > 0 ? snapshot.result.trail[snapshot.result.trail.length - 1]!.mark : 0n,
    effectiveImfBps: cfg.effectiveImfBps,
    market: cfg.symbol,
    assumptions: {
      fillModel: snapshot.result.model.fillModel,
      profile: snapshot.result.model.profile,
      latencySec: snapshot.result.model.latencySec,
      gasPerTx: String(snapshot.result.model.gasPerTx),
      intrabar: snapshot.input.intrabar,
    },
    edge: { bars, cfg },
  };
  const analysis = await buildResampleAnalysis(inputs);
  const invariants = await checkResample(analysis, inputs);
  await saveResampleAnalysis(runId, analysis.meta.seed, analysis, invariants);
  return { analysis, invariants };
}
