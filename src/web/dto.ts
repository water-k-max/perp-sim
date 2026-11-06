import type { listMarkets, runModel, runBacktest, RunRequest } from '../backtest-api.js';
import type { metricsView } from '../analytics/metrics.js';
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
export type RequestDTO = Omit<RunRequest, 'days' | 'from' | 'to'> & { days?: number; from?: string; to?: string };
export const decimal = /^-?\d+(?:\.\d+)?$/;
export const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
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
  // per-path metric confidence intervals and is required for anything produced now.
  if (!record(value) || (value.version !== 1 && value.version !== 2) || !record(value.meta) || !record(value.input)) throw new Error('The result contains an invalid resample analysis.');
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
  if (!Array.isArray(value.warnings) || !value.warnings.every((w: unknown) => typeof w === 'string')) throw new Error('The resample analysis has invalid warnings.');
  if (!Array.isArray(value.invariants)) throw new Error('The resample analysis has no invariants.');
  for (const item of value.invariants as unknown[]) {
    if (!record(item) || typeof item.id !== 'string' || typeof item.status !== 'string' || !['pass', 'fail', 'skip'].includes(item.status) || typeof item.detail !== 'string') throw new Error('The resample analysis has an invalid invariant.');
  }
  return value as unknown as ResampleBlock;
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
