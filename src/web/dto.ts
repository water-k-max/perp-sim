import type { listMarkets, runModel, runBacktest, RunRequest } from '../backtest-api.js';
import type { metricsView } from '../analytics/metrics.js';

type ModelResult = Awaited<ReturnType<typeof runModel>>;
type LegacyResult = Awaited<ReturnType<typeof runBacktest>>;
export type Result = Omit<LegacyResult, 'entryPrice' | 'from' | 'to'> & {
  entryPrice: string | null; from: number; to: number;
  analytics?: ReturnType<typeof metricsView> & ModelResult['analytics'];
} & Partial<Omit<ModelResult, keyof LegacyResult | 'analytics'>>;
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
  return data as Result;
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
