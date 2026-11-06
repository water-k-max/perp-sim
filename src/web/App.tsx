import { useEffect, useRef, useState } from 'react';
import { Configuration } from './Configuration.js';
import { WalletPanel } from './Wallet.js';
import { Results } from './Results.js';
import { record, validateResponse, type RequestDTO, type Result } from './dto.js';
import { clearHistory, rememberRun, type HistoryEntry } from './history.js';

export function App() {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const lastRequest = useRef<RequestDTO | null>(null);
  const [exportReady, setExportReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState('');
  const [badge, setBadge] = useState('AWAITING RUN');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [setupOpen, setSetupOpen] = useState(true);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 650px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 650px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  function navigateSetup(open: boolean) {
    setSetupOpen(open);
    requestAnimationFrame(() => {
      const target = document.getElementById(open ? 'config-title' : 'results-title');
      target?.focus({ preventScroll: true });
      (target?.closest('.panel') ?? target)?.scrollIntoView({ block: 'start' });
    });
  }

  async function run(request: RequestDTO) {
    if (running.current) return;
    running.current = true;
    setBusy(true); lastRequest.current = { ...request }; setExportReady(false); setError(null);
    setActivity(result ? 'Running. Previous results stay below.' : 'Running…');
    setBadge(result ? 'PREVIOUS RESULT' : 'RUNNING');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch('/api/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
      let data: unknown;
      try { data = await response.json(); } catch { throw new Error(`Unreadable response (HTTP ${response.status}).`); }
      if (!response.ok) {
        throw new Error(record(data) && typeof data.error === 'string' ? data.error : record(data) && typeof data.message === 'string' ? data.message : `Request failed (HTTP ${response.status}). Please retry.`);
      }
      const next = validateResponse(data);
      setResult(next); setHistory(rememberRun(next)); setExportReady(true);
      const noFill = (next.orders || []).some(o => o.status === 'rejected' && o.tag === 'entry') && (next.fills || []).length === 0;
      setBadge(noFill ? 'NO FILL' : next.complete ? 'RUN COMPLETE' : 'PARTIAL RESULT');
      setActivity(next.complete ? 'Done.' : 'Partial result. Check data coverage.');
      if (window.matchMedia('(max-width: 650px)').matches) navigateSetup(false);
    } catch (error) {
      setSetupOpen(true);
      setError(error instanceof Error && error.name === 'AbortError' ? 'Timed out after 3 minutes.' : error instanceof TypeError ? 'Cannot reach the backtest service.' : error instanceof Error ? error.message : String(error));
      setActivity(result ? 'Run failed. Results below are from the previous run.' : 'Run failed.');
      setBadge(result ? 'PREVIOUS RESULT' : 'RUN FAILED');
    } finally {
      clearTimeout(timeout); running.current = false; setBusy(false);
    }
  }
  function exportResult() {
    if (!result || !exportReady || running.current || !lastRequest.current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `nova-backtest-${lastRequest.current.market}-${result.to}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const state = /COMPLETE/.test(badge) ? 'ok' : /RUNNING/.test(badge) ? 'run' : /FAIL|NO FILL/.test(badge) ? 'bad' : 'idle';
  return <>
    <a className="skip-link" href="#main">Skip to workspace</a>
    <main id="main">
      <header className="console-bar"><span><span className="prompt">nova@perp-sim</span> <span className="path">~/backtest-lab</span> $<span className="cursor" aria-hidden="true" /></span><span className="console-meta"><span>region <b>tokyo</b></span><span className="opt">mode <b>read-only</b></span></span></header>
      <section className="banner" aria-label="About"><strong>perp-sim console</strong>Replay perpetual strategies on recorded history, then stress the trade order. Deterministic, exact integer accounting. Historical simulation, not a forecast.</section>
      <div className="workspace-heading"><h2>Experiment</h2><span>01 / CONFIGURE + RUN</span></div>
      <div className="workspace">
        <Configuration mobile={mobile} open={setupOpen} hasResults={!!result} onEdit={() => navigateSetup(true)} onShowResults={() => navigateSetup(false)} busy={busy} error={error} onError={setError} onRun={request => { void run(request); }} onRetry={() => { if (lastRequest.current) void run(lastRequest.current); }} />
        <Results onEdit={() => navigateSetup(true)} data={result} busy={busy} badge={badge} activity={activity} exportReady={exportReady} onExport={exportResult} history={history} onClear={() => { clearHistory(); setHistory([]); }} />
      </div>
      <WalletPanel />
      <details className="panel methodology"><summary>Know what you’re measuring <span>Methodology &amp; assumptions</span></summary><div><p>This is a historical replay of a declared strategy, not a live trade. Starting cash and base-asset size are independent inputs; the market determines the quote currency.</p><p>With the trade-tape model, each order is filled against the pool’s own recorded trades inside a window that opens after the decision plus latency, capped by a share of the volume traded in that window. Nothing is executed and no order book depth is replayed, so fills are modelled, not simulated queue positions.</p><p>Ending equity reflects price PnL, signed funding, taker and maker fees, and gas. Attribution must sum to the equity change exactly; a non-zero residual is reported as a failed invariant, never rounded away. Check settlement gaps, index-derived marks and candle coverage before interpreting results.</p></div></details>
    </main>
    <footer className="statusbar" role="status"><span className="state" data-state={state}>{badge}</span><span className="act">{activity || 'Ready.'}</span><span className="meta">research tool · not financial advice</span></footer>
  </>;
}
