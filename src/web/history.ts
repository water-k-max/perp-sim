import { record, type Result } from './dto.js';
const HISTORY_KEY = 'nova-run-history';
export type HistoryEntry = { runId: string; market: string; from: number; to: number; fillModel: string; profile: string | null; strategy: string; equityEnd: string; pnl: string; status: string; at: string };
function history(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? (parsed as unknown[]).filter((r): r is HistoryEntry => record(r) && typeof r.runId === 'string') : [];
  } catch { return []; }
}
export function rememberRun(data: Result): HistoryEntry[] {
  if (!data.manifest?.runId) return [];
  const entry: HistoryEntry = {
    runId: data.manifest.runId, market: data.market, from: data.from, to: data.to,
    fillModel: data.model ? data.model.fillModel : 'settlement-mark', profile: data.model ? data.model.profile : null,
    strategy: data.strategy ? data.strategy.id : 'fixed', equityEnd: data.equityEnd, pnl: data.pnl, status: data.status, at: new Date().toISOString(),
  };
  const list = history().filter(r => r.runId !== entry.runId);
  list.unshift(entry);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* Comparison is a convenience when storage is available. */ }
  return history();
}
export function clearHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* Storage can be blocked. */ }
}
