import { createClient } from "./client.js";
import { listPerps, resolveConfig, selectMarket, type MarketConfig } from "./history/market.js";
import { candleWindow, fundingWindow } from "./history/indexer.js";
import { buildBars, coverage, withIntraBarPath, type Bar, type Coverage } from "./history/bars.js";
import { simulate } from "./engine/simulate.js";
import { run, type RunResult } from "./engine/loop.js";
import { PROFILES, type FillProfile } from "./engine/fills.js";
import { ParameterTimeline } from "./data/params.js";
import { loadMarketData } from "./data/ingest.js";
import type { MarketData } from "./data/types.js";
import { createTapeSource, createFrozenTapeSource, type TapeSource } from "./data/tape.js";
import { readSnapshot, writeSnapshot, sha256 } from "./data/store.js";
import { loadRun, saveRun } from "./runs/store.js";
import { fixedPosition } from "./strategy/fixed.js";
import { smaCross } from "./strategy/sma.js";
import type { Strategy } from "./strategy/types.js";
import { computeMetrics, markouts, metricsView, type Metrics } from "./analytics/metrics.js";
import { attribute, attributionView, type Attribution } from "./analytics/attribution.js";
import { checkRun, checkResample, type Invariant } from "./verify/invariants.js";
import { buildResampleAnalysis, parseResampleRequest, type AnalysisInputs, type ResampleAnalysis, type ResampleRequest } from "./resample/analysis.js";
import { extractTrades, type TradeList } from "./resample/inputs.js";
import type { TapeFill } from "./data/types.js";
import { buildManifest, getCodeIdentity, type RunManifest } from "./runs/manifest.js";
import { fromRaw, toRaw } from "./units.js";

const loadedCode = await getCodeIdentity();
async function assertLoadedCode(): Promise<void> {
  if (sha256(await getCodeIdentity()) !== sha256(loadedCode)) {
    throw new Error("Source or runtime identity changed; restart the process before replaying.");
  }
}

export type Request = { market: string; days: number; side: "long" | "short"; size: string; cash: string; intrabar: boolean };
export function parseRequest(value: unknown): Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a backtest configuration.");
  const v = value as Record<string, unknown>;
  if (typeof v.market !== "string" || !/^[A-Za-z0-9/-]{1,64}$/.test(v.market)) throw new Error("Choose a valid market symbol or pool address.");
  if (!Number.isInteger(v.days) || Number(v.days) < 1 || Number(v.days) > 90) throw new Error("Lookback must be 1–90 whole days.");
  if (v.side !== "long" && v.side !== "short") throw new Error("Side must be long or short.");
  for (const field of ["size", "cash"] as const) {
    if (typeof v[field] !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(v[field]) || Number(v[field]) <= 0) throw new Error(`${field} must be a positive decimal (up to 12 whole and 18 fractional digits).`);
  }
  if (typeof v.intrabar !== "boolean") throw new Error("Intrabar must be true or false.");
  return v as Request;
}

export class BacktestInputError extends Error {}

/**
 *  The model request: the legacy fields plus everything the professional replay adds. A
 *  request that names none of the new fields is handled by the legacy path unchanged, so
 *  `/api/backtest` keeps its old answer for its old input.
 */
export type RunRequest = Request & {
  from: number | null;
  to: number | null;
  strategy: { id: "fixed" | "sma"; params: Record<string, string | number> };
  fillModel: "settlement-mark" | "tape";
  fillProfile: FillProfile;
  latencySec: number;
  gasPerTx: string;
  resample?: ResampleRequest;
};

export type ParsedRun = { kind: "legacy"; request: Request } | { kind: "model"; request: RunRequest };

const MAX_WINDOW_SEC = 90 * 86_400;
const NEW_FIELDS = ["from", "to", "fillModel", "fillProfile", "latencySec", "gasPerTx", "strategy", "resample"] as const;

export function parseRunRequest(value: unknown): ParsedRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a backtest configuration.");
  const v = value as Record<string, unknown>;
  if (!NEW_FIELDS.some((field) => v[field] !== undefined)) return { kind: "legacy", request: parseRequest(v) };

  const legacy = parseRequest({ ...v, days: v.days ?? 14 });
  const now = Math.floor(Date.now() / 1000);
  const to = v.to === undefined || v.to === null ? now : asSeconds(v.to, "to");
  const from = v.from === undefined || v.from === null ? to - Number(v.days ?? 14) * 86_400 : asSeconds(v.from, "from");
  if (from >= to) throw new Error("The window must end after it starts.");
  if (to - from > MAX_WINDOW_SEC) throw new Error("The window is limited to 90 days.");
  if (to > now + 300) throw new Error("The window cannot end in the future.");

  const fillModel = v.fillModel ?? "settlement-mark";
  if (fillModel !== "settlement-mark" && fillModel !== "tape") throw new Error("Fill model must be settlement-mark or tape.");
  const fillProfile = v.fillProfile ?? "realistic";
  if (typeof fillProfile !== "string" || !(fillProfile in PROFILES)) throw new Error("Fill profile must be optimistic, realistic or conservative.");
  const latencySec = v.latencySec ?? 1;
  if (!Number.isInteger(latencySec) || Number(latencySec) < 0 || Number(latencySec) > 300) throw new Error("Latency must be 0–300 whole seconds.");
  const gasPerTx = v.gasPerTx ?? "0";
  if (typeof gasPerTx !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(gasPerTx)) throw new Error("Gas must be a non-negative decimal.");

  const resample = v.resample === undefined ? undefined : parseResampleRequest(v.resample);

  return {
    kind: "model",
    request: { ...legacy, from, to, strategy: parseStrategy(v.strategy, legacy), fillModel, fillProfile: fillProfile as FillProfile, latencySec: Number(latencySec), gasPerTx, resample },
  };
}

function asSeconds(value: unknown, name: string): number {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
    if (Number.isNaN(ms)) throw new Error(`${name} is not a valid date.`);
    return Math.floor(ms / 1000);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a unix second count or an ISO date.`);
  return value;
}

function parseStrategy(value: unknown, legacy: Request): RunRequest["strategy"] {
  if (value === undefined) return { id: "fixed", params: { side: legacy.side, size: legacy.size, atBar: 1 } };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Strategy must be an object.");
  const v = value as Record<string, unknown>;
  if (v.id !== "fixed" && v.id !== "sma") throw new Error("Strategy must be fixed or sma.");
  const raw = v.params ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Strategy parameters must be an object.");
  const params: Record<string, string | number> = {};
  for (const [key, param] of Object.entries(raw)) {
    if (typeof param === "string" || typeof param === "number" || typeof param === "boolean") params[key] = param as string | number;
    else throw new Error(`Strategy parameter ${key} must be a scalar.`);
  }
  return { id: v.id, params: { ...(v.id === "fixed" ? { side: legacy.side, size: legacy.size, atBar: 1 } : {}), ...params } };
}

export async function listMarkets() {
  const client = createClient().client;
  return (await listPerps(client)).filter(m => m.baseSymbol && m.baseDecimals !== null && m.baseDecimals !== undefined)
    .map(m => ({ symbol: m.baseSymbol as string, quoteSymbol: m.quoteSymbol ?? "USDso", baseDecimals: m.baseDecimals as number, lot: fromRaw(BigInt(m.lotSize), m.baseDecimals as number), minQuantity: fromRaw(BigInt(m.minQuantity), m.baseDecimals as number) }));
}

export async function runRequest(parsed: ParsedRun) {
  return parsed.kind === "legacy" ? runBacktest(parsed.request) : runModel(parsed.request);
}

/** Everything one replay produced, before it is shaped into a response. */
export type Replay = {
  cfg: MarketConfig;
  data: MarketData;
  bars: Bar[];
  cov: Coverage;
  result: RunResult;
  metrics: Metrics;
  attribution: Attribution;
  invariants: Invariant[];
  manifest: RunManifest;
  priceAt: (t: number) => bigint | null;
  requested: bigint;
  size: bigint;
  cash: bigint;
  drawdownBps: bigint;
  list: TradeList;
  resample?: { analysis: ResampleAnalysis; invariants: Invariant[] };
};

/** Record every tape slice the engine consumes, so the resampler sees the same prints. */
function recordTape(source: TapeSource): { source: TapeSource; fills: () => readonly TapeFill[] } {
  const fills: TapeFill[] = [];
  return {
    fills: () => fills,
    source: {
      slice: async (fromSec, toSec) => {
        const slice = await source.slice(fromSec, toSec);
        fills.push(...slice.fills);
        return slice;
      },
      consumed: () => source.consumed(),
      digest: () => source.digest(),
    },
  };
}

/**
 *  Fetch the window, build the bars, resolve parameters per epoch and replay the strategy.
 *  Both the CLI and the HTTP API go through here so their numbers cannot drift apart.
 */
export async function runReplay(input: RunRequest): Promise<Replay> {
  const client = createClient().client;
  const rows = await listPerps(client);
  let market;
  try {
    market = selectMarket(rows, input.market);
  } catch (error) {
    throw new BacktestInputError(error instanceof Error ? error.message : "Market could not be resolved.");
  }
  const cfg = await resolveConfig(client, market);

  let data;
  try {
    data = await loadMarketData(client, cfg, { fromSec: input.from!, toSec: input.to! });
  } catch (error) {
    throw new BacktestInputError(error instanceof Error ? error.message : "History could not be loaded for that window.");
  }
  const tape = input.fillModel === "tape" ? createTapeSource(client, cfg.pool, data.manifest.range) : undefined;
  const replay = await replayPrepared(input, cfg, data, tape);
  await persistReplay(replay, input);
  return replay;
}

export async function replayPrepared(input: RunRequest, cfg: MarketConfig, data: MarketData, tape?: TapeSource): Promise<Replay> {
  ({ input, cfg, data } = structuredClone({ input, cfg, data }));
  await assertLoadedCode();
  if (input.from === null || input.to === null) throw new BacktestInputError("Resolve the replay window before execution.");
  let bars = buildBars(data.funding);
  if (bars.length < 3) throw new BacktestInputError("Fewer than three settlements in this window. Widen it.");
  if (input.intrabar) bars = withIntraBarPath(bars, data.candles3600);

  const cash = toRaw(input.cash, cfg.quoteDecimals);
  if (cash <= 0n) throw new BacktestInputError("Collateral rounds to zero at quote precision.");
  const requested = toRaw(input.size, cfg.baseDecimals);
  const size = requested - (requested % cfg.lotSize);
  if (size <= 0n) {
    throw new BacktestInputError(
      `Position size rounds to zero: ${cfg.symbol} trades in lots of ${fromRaw(cfg.lotSize, cfg.baseDecimals)} and requires at least ${fromRaw(cfg.minQuantity, cfg.baseDecimals)}.`,
    );
  }

  const strategy = buildStrategy(input, size);
  const recorded = tape ? recordTape(tape) : undefined;
  let result;
  try {
    result = await run({
      cfg,
      bars,
      cash,
      strategy,
      fillModel: input.fillModel,
      fillProfile: input.fillProfile,
      latencySec: input.latencySec,
      gasPerTx: toRaw(input.gasPerTx, cfg.quoteDecimals),
      tape: recorded?.source ?? tape,
      params: new ParameterTimeline(data.epochs, cfg),
    });
  } catch (error) {
    throw new BacktestInputError(error instanceof Error ? error.message : "The replay could not be completed.");
  }

  const list = extractTrades(result.trades, { bars, tape: recorded?.fills() ?? [], oneBase: cfg.oneBase });

  const cov = coverage(bars);
  let peak = cash;
  let drawdownBps = 0n;
  for (const point of result.trail) {
    if (point.equity > peak) peak = point.equity;
    const dd = ((peak - point.equity) * 10_000n) / peak;
    if (dd > drawdownBps) drawdownBps = dd;
  }

  const manifest = await buildManifest({
    cfg, data, model: result.model, strategy: result.strategy, tape, code: loadedCode,
    effective: { cash, requestedSize: requested, size, fromSec: input.from, toSec: input.to, intrabar: input.intrabar, closeAtEnd: true, untilBar: bars.length - 1, side: input.side },
  });

  const replay: Replay = {
    cfg, data, bars, cov, result,
    metrics: computeMetrics(result),
    attribution: attribute(result),
    invariants: checkRun(result, { coverage: cov }),
    manifest,
    priceAt: candlePriceAt(data.candles3600, 3600),
    requested,
    size,
    cash,
    drawdownBps,
    list,
    resample: undefined,
  };
  if (input.resample) {
    const analysisInputs = resampleInputs(replay, input.resample, manifest, input.intrabar);
    const analysis = buildResampleAnalysis(analysisInputs);
    replay.resample = { analysis, invariants: checkResample(analysis, analysisInputs) };
  }

  await assertLoadedCode();
  return replay;
}

/** The analysis inputs are rebuilt identically for live runs and frozen replays, so stored reports reproduce. */
function resampleInputs(replay: Replay, request: ResampleRequest, manifest: RunManifest, intrabar: boolean): AnalysisInputs {
  const { cfg, result, list, cash } = replay;
  return {
    runId: manifest.runId,
    list,
    request,
    createdAt: manifest.capturedAt,
    start: cash,
    quoteDecimals: cfg.quoteDecimals,
    baseDecimals: cfg.baseDecimals,
    quoteScale: 10n ** BigInt(cfg.quoteDecimals),
    oneBase: cfg.oneBase,
    lotSize: cfg.lotSize,
    maxSize: cfg.maxPositionSize,
    markPrice: result.trail[result.trail.length - 1]?.mark ?? 0n,
    effectiveImfBps: cfg.effectiveImfBps,
    market: cfg.symbol,
    assumptions: {
      fillModel: result.model.fillModel,
      profile: result.model.profile,
      latencySec: result.model.latencySec,
      gasPerTx: fromRaw(result.model.gasPerTx, cfg.quoteDecimals),
      intrabar,
    },
  };
}

/**
 *  The professional response. Everything the legacy response carries keeps its meaning, so a
 *  caller that only reads the old keys still reads the same kind of answer.
 */
export async function runModel(input: RunRequest) {
  return modelResponse(await runReplay(input), input);
}

export async function persistReplay(replay: Replay, input: RunRequest) {
  const normalized: RunRequest = {
    ...input,
    market: replay.cfg.symbol,
    days: Math.ceil((input.to! - input.from!) / 86_400),
    size: fromRaw(replay.requested, replay.cfg.baseDecimals),
    cash: fromRaw(replay.cash, replay.cfg.quoteDecimals),
    gasPerTx: fromRaw(replay.result.model.gasPerTx, replay.cfg.quoteDecimals),
    fillProfile: replay.result.model.profile ?? "realistic",
    strategy: { id: input.strategy.id, params: Object.fromEntries(Object.entries(replay.result.strategy.params).map(([key, value]) => [key, typeof value === "boolean" ? String(value) : value])) },
  };
  const replaySnapshot = await writeSnapshot({ version: 3, input: normalized, result: replay.result });
  return saveRun({ manifest: replay.manifest, request: input, result: modelResponse(replay, input), replaySnapshot });
}

export async function replaySavedRun(runId: string) {
  const saved = await loadRun<ReturnType<typeof modelResponse>>(runId);
  if (!saved || !saved.manifest.marketSnapshot) throw new Error("No frozen replay with that run id.");
  const snapshot = await readSnapshot<{ version: number; input: RunRequest; result: RunResult }>(saved.replaySnapshot);
  if (snapshot.version !== 3) throw new Error("Unsupported frozen replay version.");
  const data = await readSnapshot<MarketData>(saved.manifest.marketSnapshot);
  const tape = snapshot.input.fillModel === "tape" ? createFrozenTapeSource(saved.manifest.tapeRecords) : undefined;
  const replay = await replayPrepared(snapshot.input, saved.manifest.configSnapshot, data, tape);
  if (replay.manifest.runId !== runId) throw new Error("Frozen replay identity changed: use the recorded source, dependencies and runtime.");
  if (sha256(replay.result) !== sha256(snapshot.result)) throw new Error("Frozen replay did not reproduce the recorded engine result.");
  // The stored report was built from the original manifest (its capturedAt feeds analysis metadata),
  // so the response is rebuilt against that manifest, not the freshly replayed one.
  const rebuilt: Replay = { ...replay, manifest: saved.manifest };
  if (snapshot.input.resample) {
    const analysisInputs = resampleInputs(rebuilt, snapshot.input.resample, saved.manifest, snapshot.input.intrabar);
    const analysis = buildResampleAnalysis(analysisInputs);
    rebuilt.resample = { analysis, invariants: checkResample(analysis, analysisInputs) };
  }
  const response = modelResponse(rebuilt, snapshot.input);
  if (sha256(response) !== sha256(saved.result)) throw new Error("Frozen replay did not reproduce the recorded report.");
  return response;
}

function modelResponse(replay: Replay, input: RunRequest) {
  const { cfg, data, bars, cov, result, metrics, attribution, invariants, manifest, priceAt, requested, size, cash, drawdownBps, resample } = replay;
  const money = (n: bigint) => fromRaw(n, cfg.quoteDecimals);
  const funding = -(result.fundingSettled + result.fundingOpen);
  const fees = -(result.feesTaker + result.feesMaker);
  const entry = result.fills[0]?.price ?? null;

  const warnings = [
    result.model.fillModel === "tape"
      ? `Fills are modelled against the pool's own trade tape at the ${result.model.profile} profile (${result.model.windowSec}s window), not executed orders.`
      : "Fills are priced at the settlement mark, which is not a book fill.",
    ...data.warnings,
  ];
  const timeline = new ParameterTimeline(data.epochs, cfg);
  const fallbackFields = new Set([
    ...timeline.atPosition(data.manifest.range.fromBlock, -1).missing,
    ...data.epochs.flatMap(epoch => timeline.atPosition(epoch.blockNumber, epoch.logIndex ?? 0).missing),
  ]);
  if (fallbackFields.size) warnings.push(`Historical parameters are incomplete for ${[...fallbackFields].join(", ")}; missing values use the pinned market configuration, not proven historical values.`);
  if (requested !== size) warnings.push("Position size was rounded down to the market lot grid.");
  if (size < cfg.minQuantity || size > cfg.maxPositionSize) warnings.push("This size is outside the market's placement limits.");
  const tapeComplete = manifest.tapeRecords.every(slice => slice.complete);
  const candlesCovered = bars.filter(b => b.low !== null).length;
  const candleComplete = !input.intrabar || candlesCovered === bars.length;
  if (!data.complete || cov.missingSettlements || cov.gaps || cov.anchorResynced) warnings.push("History has gaps, resyncs or incomplete pagination. Interpret results with caution.");
  if (!tapeComplete) warnings.push("Trade tape coverage is incomplete; fills depend on partial execution-window data.");
  if (!candleComplete) warnings.push("Candle coverage is incomplete; not every interval has an intrabar path.");
  if (result.relaxedStressBars.length > 0) warnings.push(`The position opened mid-interval on bar(s) ${result.relaxedStressBars.join(", ")}; intrabar stress there is bounded to provably post-entry prices, so a same-interval maintenance breach cannot be asserted.`);
  const rejected = result.orders.filter((o) => o.status === "rejected");
  for (const order of rejected) warnings.push(`Order ${order.id} (${order.side} ${fromRaw(order.requested, cfg.baseDecimals)}) did not fill: ${order.reason ?? "unknown reason"}.`);
  const partial = result.orders.filter((o) => o.status === "partial");
  for (const order of partial) warnings.push(`Order ${order.id} filled only ${fromRaw(order.filled, cfg.baseDecimals)} of ${fromRaw(order.requested, cfg.baseDecimals)} ${cfg.symbol}.`);
  if (result.model.fillModel === "tape" && result.fills.some((f) => f.consumedFillIds.length === 0)) {
    warnings.push("The end-of-run close is priced at the final settlement mark, not matched against the tape.");
  }
  if (result.status === "liquidated") warnings.push("Modeled maintenance breach; no liquidation fill price or liquidation fee is applied.");

  return {
    market: cfg.symbol,
    quoteSymbol: cfg.quoteSymbol,
    side: input.side,
    size: fromRaw(size, cfg.baseDecimals),
    cash: money(cash),
    entryPrice: entry === null ? null : money(entry),
    from: cov.from,
    to: cov.to,
    status: result.status,
    equityEnd: money(result.equityEnd),
    pnl: money(result.equityEnd - cash - funding - fees),
    funding: money(funding),
    fees: money(fees),
    maxDrawdownPct: fromRaw(drawdownBps, 2),
    coverage: cov,
    complete: data.complete && tapeComplete && candleComplete && !cov.missingSettlements && !cov.gaps && !cov.anchorResynced && result.orders.every((o) => o.status !== "rejected" || o.tag !== "entry"),
    candleCoverage: input.intrabar ? { bars: bars.length, covered: candlesCovered, complete: candleComplete } : null,
    warnings,
    trail: result.trail.map((p) => ({ t: p.t, equity: money(p.equity), funding: money(-p.fundingAccrued), mark: money(p.mark) })),
    model: {
      fillModel: result.model.fillModel,
      profile: result.model.profile,
      latencySec: result.model.latencySec,
      windowSec: result.model.windowSec,
      gasPerTx: money(result.model.gasPerTx),
      requiresFills: true,
    },
    strategy: result.strategy,
    analytics: { ...metricsView(metrics), markout1hBps: markouts(result.fills, priceAt, 3600)?.toString() ?? null },
    attribution: attributionView(attribution),
    invariants,
    fills: result.fills.map((f) => ({
      id: f.id,
      orderId: f.orderId,
      t: f.t,
      side: f.side,
      size: fromRaw(f.size, cfg.baseDecimals),
      price: money(f.price),
      quote: money(f.quote),
      fee: money(f.fee),
      feeBps: f.feeBps.toString(),
      tapeFills: f.consumedFillIds.length,
      tag: f.tag,
    })),
    orders: result.orders.map((o) => ({
      id: o.id,
      side: o.side,
      requested: fromRaw(o.requested, cfg.baseDecimals),
      filled: fromRaw(o.filled, cfg.baseDecimals),
      price: o.price === null ? null : money(o.price),
      status: o.status,
      reason: o.reason,
      decidedAt: o.decidedAt,
      eligibleAt: o.eligibleAt,
      tag: o.tag,
    })),
    trades: result.trades.map((t) => ({
      seq: t.seq,
      t: t.t,
      side: t.side,
      size: fromRaw(t.size, cfg.baseDecimals),
      entryPrice: money(t.entryPrice),
      exitPrice: money(t.exitPrice),
      grossPnl: money(t.grossPnl),
      funding: money(-t.funding),
      fee: money(t.fee),
      netPnl: money(t.netPnl),
      heldSec: t.heldSec,
    })),
    paramEpochs: data.epochs.map((e) => ({
      block: e.blockNumber,
      t: e.timestamp,
      initialMarginBps: e.initialMarginBps?.toString() ?? null,
      maintenanceMarginBps: e.maintenanceMarginBps?.toString() ?? null,
      closeOutMarginBps: e.closeOutMarginBps?.toString() ?? null,
      takerFeeBpsTimes1k: e.takerFeeBpsTimes1k?.toString() ?? null,
      makerFeeBpsTimes1k: e.makerFeeBpsTimes1k?.toString() ?? null,
      maxPositionSize: e.maxPositionSize?.toString() ?? null,
    })),
    logs: result.logs,
    manifest: manifestView(manifest),
    ...(resample ? { resample: { ...resample.analysis, invariants: resample.invariants } } : {}),
    eventHash: result.eventHash,
  };
}

type JsonData<T> = T extends bigint ? string : T extends readonly (infer U)[] ? JsonData<U>[] : T extends object ? { [K in keyof T]: JsonData<T[K]> } : T;
function manifestView(manifest: RunManifest): JsonData<RunManifest> {
  return JSON.parse(JSON.stringify(manifest, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)) as JsonData<RunManifest>;
}

function buildStrategy(input: RunRequest, size: bigint): Strategy {
  const params = input.strategy.params;
  const side = params.side === "short" ? "short" : params.side === "long" ? "long" : input.side;
  const atBar = Number(params.atBar ?? 1);
  if (input.strategy.id === "sma") {
    return smaCross({
      fast: Number(params.fast ?? 6),
      slow: Number(params.slow ?? 24),
      size,
      side: params.side === "both" ? "both" : side,
    });
  }
  return fixedPosition({ side, size, atBar: Number.isInteger(atBar) && atBar >= 1 ? atBar : 1 });
}

/**
 *  Price as of `t`, approximated by the close of the candle that contains `t`.
 *
 *  Markouts are measured after the fact, so the containing bar's close (which lands within
 *  one interval of `t`) is the closest published price — it is never used to make a trading
 *  decision, and requiring a fully elapsed bar would blank the first hour of every run.
 *  Past the last bar the horizon is unobservable and returns null rather than a stale price.
 */
function candlePriceAt(candles: readonly { bucketStart: string; closePrice: string }[], intervalSec: number) {
  return (t: number): bigint | null => {
    let lo = 0;
    let hi = candles.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (Number(candles[mid]!.bucketStart) <= t) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return null;
    const bucketStart = Number(candles[best]!.bucketStart);
    if (t >= bucketStart + 2 * intervalSec) return null;
    return BigInt(candles[best]!.closePrice);
  };
}

export async function runBacktest(input: Request) {
  const client = createClient().client;
  const rows = await listPerps(client);
  let market;
  try { market = selectMarket(rows, input.market); }
  catch (error) { throw new BacktestInputError(error instanceof Error ? error.message : "Market could not be resolved."); }
  const cfg = await resolveConfig(client, market);
  const end = Math.floor(Date.now() / 1000);
  const found = await fundingWindow(client, cfg.pool, end - input.days * 86400, end);
  let bars = buildBars(found.rows);
  if (bars.length < 3) throw new BacktestInputError("Fewer than three settlements found. Try a longer lookback.");
  let candleCoverage: { bars: number; covered: number; complete: boolean } | null = null;
  if (input.intrabar) {
    // One interval earlier: the first bar may open on the hour-aligned bucket at or before
    // its own settlement, which a fetch from bars[0].t alone would drop.
    const candles = await candleWindow(client, cfg.pool, 3600, bars[0].t - 3600 + 1, end);
    bars = withIntraBarPath(bars, candles.rows);
    candleCoverage = { bars: bars.length, covered: bars.filter(b => b.low !== null).length, complete: candles.complete };
  }
  const requested = toRaw(input.size, cfg.baseDecimals);
  const size = requested - requested % cfg.lotSize;
  if (size <= 0n) throw new BacktestInputError(`Position size rounds to zero: ${cfg.symbol} trades in lots of ${fromRaw(cfg.lotSize, cfg.baseDecimals)} and requires at least ${fromRaw(cfg.minQuantity, cfg.baseDecimals)}.`);
  const cash = toRaw(input.cash, cfg.quoteDecimals);
  if (cash <= 0n) throw new BacktestInputError("Collateral rounds to zero at quote precision.");
  const out = simulate({ cfg, bars, cash, entries: [{ bar: 1, side: input.side, size, price: bars[1].mark }] });
  const cov = coverage(bars);
  const warnings = ["Hypothetical fixed-position replay; settlement-mark entry is not a book fill."];
  if (requested !== size) warnings.push("Position size was rounded down to the market lot grid.");
  if (size < cfg.minQuantity || size > cfg.maxPositionSize) warnings.push("This hypothetical size is outside the market's placement limits.");
  if (!found.complete || cov.missingSettlements || cov.gaps || cov.anchorResynced) warnings.push("History has gaps, resyncs or incomplete pagination. Interpret results with caution.");
  if (candleCoverage && (!candleCoverage.complete || candleCoverage.covered < candleCoverage.bars)) warnings.push("Candle coverage is incomplete; not every interval has an intrabar path.");
  if (out.status === "liquidated") warnings.push("Modeled maintenance breach; this is not an actual liquidation. Ending equity uses the settlement mark, not liquidation proceeds.");
  const money = (n: bigint) => fromRaw(n, cfg.quoteDecimals);
  let peak = cash;
  let drawdownBps = 0n;
  for (const point of out.trail) {
    if (point.equity > peak) peak = point.equity;
    const dd = (peak - point.equity) * 10000n / peak;
    if (dd > drawdownBps) drawdownBps = dd;
  }
  const funding = -(out.fundingSettled + out.fundingOpen);
  const fees = -out.feesPaid;
  return {
    market: cfg.symbol, quoteSymbol: cfg.quoteSymbol, side: input.side, size: fromRaw(size, cfg.baseDecimals),
    cash: money(cash), entryPrice: money(bars[1].mark), from: cov.from, to: cov.to,
    status: out.status, equityEnd: money(out.equityEnd), pnl: money(out.equityEnd - cash - funding - fees),
    funding: money(funding), fees: money(fees), maxDrawdownPct: fromRaw(drawdownBps, 2),
    coverage: cov, complete: found.complete, candleCoverage, warnings,
    trail: out.trail.map(p => ({ t: p.t, equity: money(p.equity), funding: money(-p.fundingAccrued), mark: money(p.mark) })),
  };
}
