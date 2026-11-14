import type { listMarkets, runModel, runBacktest, RunRequest } from '../backtest-api.js';
import type { metricsView, markoutView } from '../analytics/metrics.js';
import type { ResampleAnalysis } from '../resample/analysis.js';

type ModelResult = Awaited<ReturnType<typeof runModel>>;
type LegacyResult = Awaited<ReturnType<typeof runBacktest>>;
export type InvariantDTO = { id: string; status: 'pass' | 'fail' | 'skip'; severity: string; detail: string };
export type ResampleBlock = Omit<ResampleAnalysis, 'invariants'> & { invariants: InvariantDTO[] };
export type Result = Omit<LegacyResult, 'entryPrice' | 'from' | 'to'> & {
  entryPrice: string | null; from: number; to: number;
  analytics?: ReturnType<typeof metricsView> & ModelResult['analytics'];
  resample?: ResampleBlock;
} & Partial<Omit<ModelResult, keyof LegacyResult | 'analytics' | 'resample'>>;
export type Market = Awaited<ReturnType<typeof listMarkets>>[number];
/** The ladder the server publishes, taken from the module that publishes it — never restated here. */
export type MarkoutRungs = ReturnType<typeof markoutView>['rungs'];
export type RequestDTO = Omit<RunRequest, 'days' | 'from' | 'to'> & { days?: number; from?: string; to?: string };
export const decimal = /^-?\d+(?:\.\d+)?$/;
export const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 *  Which inputs moved since the read that produced what is on screen. `inputs` is both the
 *  watch-list and the label table, in form order; both records must hold flat primitives,
 *  because the compare is `!==`. An empty list means the result still answers the inputs.
 */
export function changedLabels<T extends Record<string, unknown>>(current: T, ranWith: T | null, inputs: Partial<Record<keyof T, string>>): string[] {
  if (!ranWith) return [];
  return (Object.keys(inputs) as (keyof T)[]).filter(key => current[key] !== ranWith[key]).map(key => inputs[key]!);
}

/**
 *  The market list, read once for the page. Three panels want the same rows and the endpoint
 *  answers the same way for the life of the process, so one in-flight read is shared. A
 *  failed read is never cached: each caller keeps its own offline fallback and may retry.
 */
let marketsRead: Promise<Market[]> | null = null;
export function fetchMarkets(): Promise<Market[]> {
  if (!marketsRead) {
    marketsRead = (async (): Promise<Market[]> => {
      const response = await fetch('/api/markets', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Market list failed (HTTP ${response.status}).`);
      const list: unknown = await response.json();
      const usable = Array.isArray(list) && list.length > 0 && list.every(
        (m: unknown) => record(m) && typeof m.symbol === 'string' && typeof m.quoteSymbol === 'string' && typeof m.lot === 'string' && typeof m.minQuantity === 'string',
      );
      if (!usable) throw new Error('Market list came back unusable.');
      return list as Market[];
    })().catch((error: unknown) => { marketsRead = null; throw error; });
  }
  return marketsRead;
}

/**
 *  Which network this page is reading, taken from the server that reads it.
 *
 *  The topbar used to carry the word `Tokyo` as text typed into a component while every request
 *  went to Hideki through the SDK chain object in `src/client.ts`. A label that is not asked about
 *  cannot be wrong only in innocent ways — it is also how a repointed server, or a `CHAIN_ID` that
 *  disagrees with the client, would go on looking normal. So the label is built from this report or
 *  says it does not know; there is no fallback chain name in the frontend to be stale.
 */
export type ChainReport = {
  name: string;
  readChainId: string;
  manifestChainId: string;
  indexerUrl: string;
  testnet: boolean;
  agrees: boolean;
};

export function parseChainReport(value: unknown): ChainReport | null {
  if (!record(value)) return null;
  const text = ['name', 'readChainId', 'manifestChainId', 'indexerUrl'] as const;
  if (!text.every(key => typeof value[key] === 'string' && (value[key] as string).trim().length > 0)) return null;
  if (typeof value.testnet !== 'boolean' || typeof value.agrees !== 'boolean') return null;
  return { name: value.name, readChainId: value.readChainId, manifestChainId: value.manifestChainId, indexerUrl: value.indexerUrl, testnet: value.testnet, agrees: value.agrees } as ChainReport;
}

export function chainLabel(report: ChainReport | null): string {
  if (!report) return 'Chain unknown';
  if (!report.agrees) return `Chain mismatch · ${report.readChainId} ≠ ${report.manifestChainId}`;
  return `${report.name} · ${report.readChainId}`;
}

/** The report, or null. A failed read must not leave a name on screen from an earlier guess. */
export async function fetchChain(): Promise<ChainReport | null> {
  try {
    const response = await fetch('/api/chain', { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return parseChainReport(await response.json());
  } catch {
    return null;
  }
}

export type RunFailure = {
  /** Human headline for the failure state and the form alert. */
  message: string;
  /** What the user can do next. */
  hint: string;
  /** Raw service/OS text, kept for the collapsible technical detail. */
  raw: string | null;
};

/** Map a failed run to human copy; raw text never becomes the headline. */
export function runFailure(error: unknown, response?: { status: number; body: unknown }): RunFailure {
  if (response) {
    const body = record(response.body) ? response.body : {};
    const serverMessage = typeof body.error === 'string' ? body.error : null;
    const raw = typeof body.detail === 'string' ? body.detail : null;
    if (response.status === 429) return { message: serverMessage ?? 'The lab is running other heavy work right now.', hint: 'Nothing was started for you. Wait a couple of seconds and run it again.', raw };
    if (response.status === 503) return { message: serverMessage ?? 'The backtest service is unavailable.', hint: 'The failure is on the lab machine, not in your inputs.', raw };
    if (response.status === 422) return { message: serverMessage ?? 'The backtest service could not process the run.', hint: 'Retry once; if it repeats, check the server console.', raw };
    if (response.status >= 500) return { message: 'The backtest service hit an internal error.', hint: 'Retry once; if it repeats, check the server console.', raw: raw ?? serverMessage };
    return { message: serverMessage ?? `Request failed (HTTP ${response.status}).`, hint: 'Adjust the inputs and run again.', raw };
  }
  if (error instanceof Error && error.name === 'AbortError') return { message: 'The run timed out after 3 minutes.', hint: 'Narrow the window or retry when the indexer is less busy.', raw: null };
  if (error instanceof TypeError) return { message: 'Cannot reach the backtest service.', hint: 'Check that the local lab server is running, then retry.', raw: null };
  return { message: error instanceof Error ? error.message : String(error), hint: 'Retry; if it repeats, reload the page so it matches the server build.', raw: null };
}

/**
 *  The headline a finished response earns. A rejected entry order with nothing filled is
 *  not a "complete run" — saying RUN COMPLETE over an empty position is the loudest lie this
 *  screen could tell — and an incomplete read is not a complete one either.
 */
export function runBadge(result: Result): 'NO FILL' | 'RUN COMPLETE' | 'PARTIAL RESULT' {
  const rejectedEntry = (result.orders || []).some(o => o.status === 'rejected' && o.tag === 'entry');
  if (rejectedEntry && (result.fills || []).length === 0) return 'NO FILL';
  return result.complete ? 'RUN COMPLETE' : 'PARTIAL RESULT';
}
const timestamp = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t) && !Number.isNaN(new Date(t * 1000).getTime());

// Validate the wire response before it enters UI state. Optional detail DTOs mirror the API.
export function validateResponse(data: unknown): Result {
  if (!record(data) || !data.coverage || !Array.isArray(data.trail) || !Array.isArray(data.warnings)) throw new Error('The server returned an unexpected result. Please retry.');
  for (const key of ['market', 'quoteSymbol', 'side', 'status']) {
    if (typeof data[key] !== 'string') throw new Error('The result is missing required metadata.');
  }
  for (const key of ['size', 'cash', 'equityEnd', 'pnl', 'funding', 'fees', 'maxDrawdownPct']) {
    const value = data[key];
    if (typeof value !== 'string' || !decimal.test(value) || !Number.isFinite(Number(value))) throw new Error('The result contains an invalid amount.');
  }
  if (data.entryPrice !== null && (typeof data.entryPrice !== 'string' || !decimal.test(data.entryPrice))) throw new Error('The result contains an invalid entry price.');
  if (!timestamp(data.from) || !timestamp(data.to) || typeof data.complete !== 'boolean') throw new Error('The result contains invalid period or completion data.');
  for (const point of data.trail as unknown[]) {
    if (!record(point) || !timestamp(point.t) || typeof point.equity !== 'string' || !decimal.test(point.equity) || !Number.isFinite(Number(point.equity))) throw new Error('The result contains invalid chart data.');
  }
  if (!data.warnings.every((w: unknown) => typeof w === 'string')) throw new Error('The result contains invalid warnings.');
  if (data.invariants !== undefined) {
    if (!Array.isArray(data.invariants)) throw new Error('The result contains an invalid invariant list.');
    for (const item of data.invariants as unknown[]) {
      if (!record(item) || typeof item.id !== 'string' || typeof item.status !== 'string' || !['pass', 'fail', 'skip'].includes(item.status) || typeof item.detail !== 'string') throw new Error('The result contains an invalid invariant.');
    }
  }
  for (const key of ['fills', 'trades', 'orders', 'paramEpochs', 'logs']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`The result contains an invalid ${key} list.`);
  }
  for (const key of ['analytics', 'attribution', 'manifest']) {
    if (data[key] !== undefined && !record(data[key])) throw new Error(`The result contains ${key === 'manifest' ? 'an invalid manifest' : `invalid ${key}`}.`);
  }
  if (data.resample !== undefined) validateResample(data.resample);
  return data as Result;
}

const dec = (value: unknown): value is string => typeof value === 'string' && decimal.test(value) && Number.isFinite(Number(value));

/** Validate the optional resample analysis block before it enters UI state. */
export function validateResample(value: unknown): ResampleBlock {
  // Version 1 documents (stored in older run bundles) stay valid; version 2 adds the
  // per-path metric confidence intervals; version 3 adds the random-entry null (edge);
  // version 4 adds the null tally the p-value is counted from. Version 3 is required for
  // anything produced now, and 4 since the tally shipped.
  if (!record(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) || !record(value.meta) || !record(value.input)) throw new Error('The result contains an invalid resample analysis.');
  const meta = value.meta;
  if (typeof meta.seed !== 'string' || !Number.isInteger(meta.paths) || typeof meta.mode !== 'string' || typeof meta.sizing !== 'string' || !record(meta.source) || typeof meta.createdAt !== 'string') throw new Error('The resample analysis has invalid metadata.');
  if (!Array.isArray(value.assumptions) || !value.assumptions.every((a: unknown) => typeof a === 'string')) throw new Error('The resample analysis has invalid assumptions.');
  if (!Array.isArray(value.distributions)) throw new Error('The resample analysis has no distributions.');
  for (const dist of value.distributions as unknown[]) {
    if (!record(dist) || typeof dist.mode !== 'string' || !Number.isInteger(dist.paths) || !Array.isArray(dist.finalEquities)) throw new Error('The resample analysis has an invalid distribution.');
    for (const key of ['median', 'p05', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'cvar95', 'bankruptcyRate'] as const) if (!dec(dist[key])) throw new Error(`The resample distribution has an invalid ${key}.`);
    if (!(dist.finalEquities as unknown[]).every(dec)) throw new Error('The resample distribution has invalid final equities.');
    if (!Array.isArray(dist.fan) || !(dist.fan as unknown[]).every(band => record(band) && Number.isInteger(band.step) && dec(band.p10) && dec(band.p25) && dec(band.p50) && dec(band.p75) && dec(band.p90))) throw new Error('The resample distribution has an invalid fan.');
    if (value.version >= 2) {
      for (const key of ['p05WinRateBps', 'medianWinRateBps', 'p95WinRateBps'] as const) {
        if (typeof dist[key] !== 'number' || !Number.isFinite(dist[key])) throw new Error(`The resample distribution has an invalid ${key}.`);
      }
      for (const key of ['p05SharpeX1e4', 'medianSharpeX1e4', 'p95SharpeX1e4'] as const) {
        const v = dist[key];
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`The resample distribution has an invalid ${key}.`);
      }
    }
  }
  if (!record(value.audit) || !Array.isArray(value.audit.repricedFinalEquities) || !(value.audit.repricedFinalEquities as unknown[]).every(dec) || !Array.isArray(value.audit.notes)) throw new Error('The resample analysis has an invalid audit block.');
  if (!record(value.sizing) || !Array.isArray(value.sizing.rows)) throw new Error('The resample analysis has an invalid sizing block.');
  for (const row of value.sizing.rows as unknown[]) {
    if (!record(row) || !dec(row.sizeBase) || !dec(row.lossProbability) || !dec(row.medianPnl) || !dec(row.p05Pnl)) throw new Error('The resample sizing ladder has an invalid row.');
  }
  if (value.oos !== null && (!record(value.oos) || !dec(value.oos.boundary) || !Array.isArray(value.oos.heldCurve) || !(value.oos.heldCurve as unknown[]).every(dec))) throw new Error('The resample analysis has an invalid out-of-sample block.');
  // Pre-edge documents (version 1–2) carry no edge key; version 3 documents carry either a
  // valid block or an explicit null (no trades, or no history to price the null against).
  if (value.edge === undefined) {
    if (value.version >= 3) throw new Error('The resample analysis is missing its random-entry null block.');
  } else if (value.edge !== null) {
    const edge = value.edge as Record<string, unknown>;
    const paths = edge.paths, skipped = edge.skippedTrades, p = edge.pValue;
    const edgeDec = ['realizedTotal', 'nullP05', 'nullMedian', 'nullP95', 'nullMean', 'pValue'] as const;
    const count = edge.nullsAtOrAbove;
    if (!Number.isInteger(paths) || (paths as number) <= 0 || !edgeDec.every(k => dec(edge[k]))
      || !Number.isInteger(skipped) || (skipped as number) < 0
      || !(Number(p) >= 0 && Number(p) <= 1)
      || (value.version >= 4 && (!Number.isInteger(count) || (count as number) < 0 || (count as number) > (paths as number)))
      || !Array.isArray(edge.notes) || !edge.notes.every((n: unknown) => typeof n === 'string')) {
      throw new Error('The resample analysis has an invalid random-entry null block.');
    }
  }
  if (!Array.isArray(value.warnings) || !value.warnings.every((w: unknown) => typeof w === 'string')) throw new Error('The resample analysis has invalid warnings.');
  if (!Array.isArray(value.invariants)) throw new Error('The resample analysis has no invariants.');
  for (const item of value.invariants as unknown[]) {
    if (!record(item) || typeof item.id !== 'string' || typeof item.status !== 'string' || !['pass', 'fail', 'skip'].includes(item.status) || typeof item.detail !== 'string') throw new Error('The resample analysis has an invalid invariant.');
  }
  return value as unknown as ResampleBlock;
}

/**
 *  The bounded execution path, read from the server that would run it. The capability answer is
 *  config-only — no network, no key: it says whether this deployment can place an order at all
 *  (`available`, true only locally) and the operator's opt-in settings. The public deployment
 *  answers available:false, so the panel renders a read-only note instead of an order form. The
 *  key itself never appears here; `hasKey` is only whether one is configured.
 */
export type ExecutionCapability = {
  available: boolean;
  mode: 'local' | 'serverless';
  enabled: boolean;
  dryRun: boolean;
  hasKey: boolean;
  maxNotional: string;
};

export function parseExecutionCapability(value: unknown): ExecutionCapability | null {
  if (!record(value)) return null;
  if (typeof value.available !== 'boolean' || typeof value.enabled !== 'boolean' || typeof value.dryRun !== 'boolean' || typeof value.hasKey !== 'boolean') return null;
  if (value.mode !== 'local' && value.mode !== 'serverless') return null;
  if (!dec(value.maxNotional)) return null;
  return { available: value.available, mode: value.mode, enabled: value.enabled, dryRun: value.dryRun, hasKey: value.hasKey, maxNotional: value.maxNotional };
}

/** The capability, or null. A failed read must not leave an order form on screen from a guess. */
export async function fetchExecution(): Promise<ExecutionCapability | null> {
  try {
    const response = await fetch('/api/execution', { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return parseExecutionCapability(await response.json());
  } catch {
    return null;
  }
}

export type ExecuteCheckDTO = { id: string; verdict: 'pass' | 'fail' | 'warn'; detail: string };
/** The display fields of the order proposal — decimal strings and gate verdicts, never raw units. */
export type OrderProposalDTO = {
  symbol: string; quoteSymbol: string; side: 'long' | 'short'; orderType: 'limit' | 'market';
  size: string; price: string; markPrice: string; notional: string; lock: string; initialMargin: string;
  liquidationPrice: string | null; cash: string; cap: string;
  underCap: boolean; placeable: boolean; binding: string | null; aligned: boolean; requestedSize: string;
  checks: ExecuteCheckDTO[];
};
export type ExecuteCallDTO = { to: string; data: string; value: string; description: string };
export type ExecutePreviewDTO = { action: 'preview'; reason: string; proposal: OrderProposalDTO; calls: ExecuteCallDTO[] };
export type ExecuteSendDTO = { action: 'send'; proposal: OrderProposalDTO; hash: string; depositHash?: string; orderId?: string };
export type ExecuteResultDTO = ExecutePreviewDTO | ExecuteSendDTO;

const addressHex = /^0x[0-9a-fA-F]{40}$/;
const txHashHex = /^0x[0-9a-fA-F]{64}$/;
const calldataHex = /^0x[0-9a-fA-F]*$/;

function validateOrderProposal(value: unknown): OrderProposalDTO {
  if (!record(value)) throw new Error('The order result is missing its proposal.');
  if (typeof value.symbol !== 'string' || typeof value.quoteSymbol !== 'string') throw new Error('The order proposal has invalid market metadata.');
  if (value.side !== 'long' && value.side !== 'short') throw new Error('The order proposal has an invalid side.');
  if (value.orderType !== 'limit' && value.orderType !== 'market') throw new Error('The order proposal has an invalid order type.');
  for (const key of ['size', 'price', 'markPrice', 'notional', 'lock', 'initialMargin', 'cash', 'cap', 'requestedSize'] as const) if (!dec(value[key])) throw new Error('The order proposal contains an invalid amount.');
  if (value.liquidationPrice !== null && !dec(value.liquidationPrice)) throw new Error('The order proposal contains an invalid liquidation price.');
  for (const key of ['underCap', 'placeable', 'aligned'] as const) if (typeof value[key] !== 'boolean') throw new Error('The order proposal contains an invalid flag.');
  if (value.binding !== null && typeof value.binding !== 'string') throw new Error('The order proposal contains an invalid binding gate.');
  if (!Array.isArray(value.checks)) throw new Error('The order proposal has no gate checks.');
  for (const c of value.checks as unknown[]) {
    if (!record(c) || typeof c.id !== 'string' || typeof c.detail !== 'string' || (c.verdict !== 'pass' && c.verdict !== 'fail' && c.verdict !== 'warn')) throw new Error('The order proposal has an invalid gate check.');
  }
  return value as unknown as OrderProposalDTO;
}

/** Validate the place-or-preview response before it enters UI state. A send must carry a real hash. */
export function validateExecuteResult(value: unknown): ExecuteResultDTO {
  if (!record(value)) throw new Error('The server returned an unexpected order result.');
  const proposal = validateOrderProposal(value.proposal);
  if (value.action === 'preview') {
    if (typeof value.reason !== 'string') throw new Error('The order preview is missing its reason.');
    if (!Array.isArray(value.calls)) throw new Error('The order preview has no calldata.');
    for (const call of value.calls as unknown[]) {
      if (!record(call) || typeof call.to !== 'string' || !addressHex.test(call.to) || typeof call.data !== 'string' || !calldataHex.test(call.data) || !dec(call.value) || typeof call.description !== 'string') throw new Error('The order preview contains an invalid call.');
    }
    return { action: 'preview', reason: value.reason, proposal, calls: value.calls as ExecuteCallDTO[] };
  }
  if (value.action === 'send') {
    if (typeof value.hash !== 'string' || !txHashHex.test(value.hash)) throw new Error('The send result is missing a valid transaction hash.');
    if (value.depositHash !== undefined && (typeof value.depositHash !== 'string' || !txHashHex.test(value.depositHash))) throw new Error('The send result has an invalid deposit hash.');
    if (value.orderId !== undefined && !dec(value.orderId)) throw new Error('The send result has an invalid order id.');
    return { action: 'send', proposal, hash: value.hash, depositHash: value.depositHash as string | undefined, orderId: value.orderId as string | undefined };
  }
  throw new Error('The server returned an unknown order action.');
}

export const date = (t: number) => new Date(t * 1000).toLocaleString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC';
export const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
export const amount = (value: unknown) => {
  const [whole, fraction] = String(value).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
};
export const number = (value: unknown, digits = 2) => value === null || value === undefined ? '—' : Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function describeModel(model: NonNullable<Result['model']>) {
  if (model.fillModel === 'tape') return `Modelled fill: each order matches the pool's recorded trades inside a ${model.windowSec}s window opening ${model.latencySec}s after the decision, capped by the ${model.profile} profile. This is not an executed order.`;
  return 'Settlement-mark model: each order is priced at the next settlement mark. This is not a book fill.';
}
