import { useEffect, useRef, useState } from 'react';
import { Configuration } from './Configuration.js';
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
    setActivity(result ? 'Running a new simulation. Showing previous results below.' : 'Fetching historical data and calculating the replay…');
    setBadge(result ? 'PREVIOUS RESULT' : 'RUNNING');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch('/api/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
      let data: unknown;
      try { data = await response.json(); } catch { throw new Error(`The server returned an unreadable response (HTTP ${response.status}). Please retry.`); }
      if (!response.ok) {
        throw new Error(record(data) && typeof data.error === 'string' ? data.error : record(data) && typeof data.message === 'string' ? data.message : `Request failed (HTTP ${response.status}). Please retry.`);
      }
      const next = validateResponse(data);
      setResult(next); setHistory(rememberRun(next)); setExportReady(true);
      const noFill = (next.orders || []).some(o => o.status === 'rejected' && o.tag === 'entry') && (next.fills || []).length === 0;
      setBadge(noFill ? 'NO FILL' : next.complete ? 'RUN COMPLETE' : 'PARTIAL RESULT');
      setActivity(next.complete ? 'Simulation finished. Results are ready.' : 'Simulation returned partial results. Review data coverage.');
      if (window.matchMedia('(max-width: 650px)').matches) navigateSetup(false);
    } catch (error) {
      setSetupOpen(true);
      setError(error instanceof Error && error.name === 'AbortError' ? 'The request timed out after three minutes. Please retry.' : error instanceof TypeError ? 'Could not reach the backtest service. Check your connection and retry.' : error instanceof Error ? error.message : String(error));
      setActivity(result ? 'The new run failed. Previous results remain below; they do not reflect the current setup.' : 'No results yet. Resolve the error or retry your request.');
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
  return <>
    <a className="skip-link" href="#main">Skip to workspace</a>
    <aside className="sidebar">
      <div className="brand"><span className="brand-shield" aria-hidden="true" /><span>NOVA<small>PROTOCOL</small></span></div>
      <div className="nav-label">RESEARCH WORKSPACE</div>
      <nav aria-label="Workspace"><a className="active" href="#main" aria-current="page"><span aria-hidden="true">▥</span> Backtest Lab <span className="nav-dot" /></a></nav>
      <div className="sidebar-note"><span className="eyebrow">BUILT FOR PERSPECTIVE</span><p>Less guesswork.<br />More understanding.</p><small>Historical simulation.<br />Not a promise of performance.</small></div>
      <div className="sidebar-footer">NOVA / RESEARCH TOOLS</div>
    </aside>
    <main id="main">
      <header className="topbar"><div>Research <span>/</span> <strong>Backtest Lab</strong></div><div className="region"><i aria-hidden="true" /> Tokyo <span>Read-only region</span></div></header>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy"><p className="eyebrow">IDEAS IN. INSIGHT OUT.</p><h1 id="hero-title">Test the idea.<br /><span>Understand the cost.</span></h1><p>Explore a perpetual position through historical markets.<br className="desktop-break" /> See what price, funding, and fees do to the outcome.</p><div className="hero-tags"><span>Historical data</span><span>Transparent assumptions</span></div></div>
        <div className="hero-art" role="img" aria-label="NOVA cyan and violet shield" />
      </section>
      <div className="workspace-heading"><h2>Your experiment</h2><span>01 / CONFIGURE &amp; SIMULATE</span></div>
      <div className="workspace">
        <Configuration mobile={mobile} open={setupOpen} hasResults={!!result} onEdit={() => navigateSetup(true)} onShowResults={() => navigateSetup(false)} busy={busy} error={error} onError={setError} onRun={request => { void run(request); }} onRetry={() => { if (lastRequest.current) void run(lastRequest.current); }} />
        <Results onEdit={() => navigateSetup(true)} data={result} busy={busy} badge={badge} activity={activity} exportReady={exportReady} onExport={exportResult} history={history} onClear={() => { clearHistory(); setHistory([]); }} />
      </div>
      <details className="panel methodology"><summary>Know what you’re measuring <span>Methodology &amp; assumptions</span></summary><div><p>This is a historical replay of a declared strategy, not a live trade. Starting cash and base-asset size are independent inputs; the market determines the quote currency.</p><p>With the trade-tape model, each order is filled against the pool’s own recorded trades inside a window that opens after the decision plus latency, capped by a share of the volume traded in that window. Nothing is executed and no order book depth is replayed, so fills are modelled, not simulated queue positions.</p><p>Ending equity reflects price PnL, signed funding, taker and maker fees, and gas. Attribution must sum to the equity change exactly; a non-zero residual is reported as a failed invariant, never rounded away. Check settlement gaps, index-derived marks and candle coverage before interpreting results.</p></div></details>
      <footer className="main-footer"><span>NOVA PROTOCOL <span className="muted">/ Backtest Lab</span></span><span>Research, not financial advice.</span></footer>
    </main>
  </>;
}
