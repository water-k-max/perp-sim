import { useEffect, useRef, useState } from 'react';
import { Configuration, watchFields, type ConfigFields } from './Configuration.js';
import { WalletPanel } from './Wallet.js';
import { ImportTradesPanel } from './ImportTrades.js';
import { Results } from './Results.js';
import { ChainBadge } from './ChainBadge.js';
import { changedLabels, fetchChain, runBadge, runFailure, validateResponse, type ChainReport, type RequestDTO, type Result, type RunFailure } from './dto.js';
import { clearHistory, rememberRun, type HistoryEntry } from './history.js';

class HttpFailure extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`HTTP ${status}`); }
}

export function App() {
  const [result, setResult] = useState<Result | null>(null);
  const [draft, setDraft] = useState<ConfigFields | null>(null);
  const [ranWith, setRanWith] = useState<ConfigFields | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const lastRequest = useRef<RequestDTO | null>(null);
  const lastFields = useRef<ConfigFields | null>(null);
  const [exportReady, setExportReady] = useState(false);
  const [failure, setFailure] = useState<RunFailure | null>(null);
  const [activity, setActivity] = useState('');
  const [badge, setBadge] = useState('AWAITING RUN');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [setupOpen, setSetupOpen] = useState(true);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 650px)').matches);
  const [network, setNetwork] = useState<ChainReport | null | undefined>(undefined);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 650px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    let mounted = true;
    void fetchChain().then((report) => { if (mounted) setNetwork(report); });
    return () => { mounted = false; };
  }, []);
  function navigateSetup(open: boolean) {
    setSetupOpen(open);
    requestAnimationFrame(() => {
      const target = document.getElementById(open ? 'config-title' : 'results-title');
      target?.focus({ preventScroll: true });
      (target?.closest('.panel') ?? target)?.scrollIntoView({ block: 'start' });
    });
  }

  async function run(request: RequestDTO, fields: ConfigFields) {
    if (running.current) return;
    running.current = true;
    setBusy(true); lastRequest.current = { ...request }; lastFields.current = fields; setExportReady(false); setFailure(null);
    setActivity(result ? 'Running. Previous results stay below.' : 'Running…');
    setBadge(result ? 'PREVIOUS RESULT' : 'RUNNING');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch('/api/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
      let data: unknown;
      try { data = await response.json(); } catch { throw new Error(`Unreadable response (HTTP ${response.status}).`); }
      if (!response.ok) throw new HttpFailure(response.status, data);
      const next = validateResponse(data);
      setResult(next); setHistory(rememberRun(next)); setExportReady(true); setRanWith(fields);
      setBadge(runBadge(next));
      setActivity(next.complete ? 'Done.' : 'Partial result. Check data coverage.');
      if (window.matchMedia('(max-width: 650px)').matches) navigateSetup(false);
    } catch (error) {
      setSetupOpen(true);
      setFailure(error instanceof HttpFailure ? runFailure(null, { status: error.status, body: error.body }) : runFailure(error));
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
  const stale = result && draft && ranWith ? changedLabels(draft, ranWith, watchFields(draft)) : [];
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
      <header className="topbar"><div>Research <span>/</span> <strong>Backtest Lab</strong></div><ChainBadge report={network} /></header>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy"><p className="eyebrow">IDEAS IN. INSIGHT OUT.</p><h1 id="hero-title">Test the idea.<br /><span>Understand the cost.</span></h1><p>Explore a perpetual position through historical markets.<br className="desktop-break" /> See what price, funding, and fees do to the outcome.</p><div className="hero-tags"><span>Historical data</span><span>Transparent assumptions</span></div></div>
        <div className="hero-art" role="img" aria-label="NOVA cyan and violet shield" />
      </section>
      <div className="workspace-heading"><h2>Your experiment</h2><span>01 / CONFIGURE &amp; SIMULATE</span></div>
      <div className="workspace">
        <Configuration mobile={mobile} open={setupOpen} hasResults={!!result} onEdit={() => navigateSetup(true)} onShowResults={() => navigateSetup(false)} busy={busy} error={failure?.message ?? null} onDraft={setDraft} onRun={(request, fields) => { void run(request, fields); }} onRetry={() => { if (lastRequest.current && lastFields.current) void run(lastRequest.current, lastFields.current); }} />
        <Results onEdit={() => navigateSetup(true)} data={result} failure={failure} busy={busy} badge={badge} activity={activity} stale={stale} exportReady={exportReady} onExport={exportResult} history={history} onClear={() => { clearHistory(); setHistory([]); }} />
      </div>
      <WalletPanel />
      <ImportTradesPanel />
      <details className="panel methodology"><summary>Know what you’re measuring <span>Methodology &amp; assumptions</span></summary><div><p>This is a historical replay of a declared strategy, not a live trade. Starting cash and base-asset size are independent inputs; the market determines the quote currency.</p><p>With the trade-tape model, each order is filled against the pool’s own recorded trades inside a window that opens after the decision plus latency, capped by a share of the volume traded in that window. Nothing is executed and no order book depth is replayed, so fills are modelled, not simulated queue positions.</p><p>Ending equity reflects price PnL, signed funding, taker and maker fees, and gas. Attribution must sum to the equity change exactly; a non-zero residual is reported as a failed invariant, never rounded away. On this network the venue’s live taker and maker rates are both 0 bps, so the fee line is zero by venue policy rather than switched off in the code — the rate path is implemented and exercised against a non-zero fixture, and liquidation penalties, which this network does charge, are read and reported but not modelled in a run. Check settlement gaps, index-derived marks and candle coverage before interpreting results.</p></div></details>
      <footer className="main-footer"><span>NOVA PROTOCOL <span className="muted">/ Backtest Lab</span></span><span>Research, not financial advice.</span></footer>
    </main>
  </>;
}
