import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Chart } from './Chart.js';
import { Details } from './Details.js';
import { ResamplePanel, StaleNote } from './Resample.js';
import { amount, date, day, describeModel, number, type MarkoutRungs, type Result, type RunFailure } from './dto.js';
import type { HistoryEntry } from './history.js';

function Metric({ id, value, signed = false, quote }: { id: string; value: string | undefined; signed?: boolean; quote?: string }) {
  return <strong id={id} title={value === undefined ? undefined : quote ? `${value} ${quote}` : value} className={signed && Number(value) > 0 ? 'positive' : signed && Number(value) < 0 ? 'negative' : undefined}>{number(value)}</strong>;
}
/**
 *  Markout at three horizons, each a whole number of settlement intervals. The headline is the
 *  shortest — the mark the venue prints after the fill — and the line under it is the shape of
 *  the curve, so decay versus persistence is readable without opening another tab.
 *
 *  A rung whose horizon never printed reads "no mark", never a zero: on a short window the long
 *  horizon was not observed, and 0 bps would report a flat outcome that did not happen.
 */
export function MarkoutCard({ rungs }: { rungs: MarkoutRungs }) {
  const head = rungs[0];
  const shape = rungs.map(rung => `${rung.label} ${rung.bps === null ? 'no mark' : `${number(Number(rung.bps), 1)} bps`}`).join(' · ');
  return <article className="panel metric">
    <h4>Markout{head ? ` · ${head.label}` : ''}</h4>
    <strong id="markout">{head?.bps != null ? `${number(Number(head.bps), 1)} bps` : '—'}</strong>
    <small>{shape || 'No horizons published for this run'}</small>
  </article>;
}
function Coverage({ data }: { data: Result | null }) {
  const clean = data && data.complete && !data.coverage.missingSettlements && !data.coverage.gaps && !data.coverage.anchorResynced && (!data.candleCoverage || (data.candleCoverage.complete && data.candleCoverage.covered === data.candleCoverage.bars));
  const failed = data?.invariants?.some(i => i.status === 'fail');
  const facts: [string, unknown][] = [];
  if (data) {
    facts.push(['Engine status', data.status], ['Quote currency', data.quoteSymbol], ['Entry price', data.entryPrice === null ? 'no fill' : amount(data.entryPrice)]);
    const labels = { bars: 'Bars', expectedSettlements: 'Expected settlements', missingSettlements: 'Missing settlements', gaps: 'Gaps', anchorResynced: 'Anchor resynced', forgivenIntervals: 'Forgiven intervals', markFromIndex: 'Mark from index' };
    for (const key of Object.keys(labels) as (keyof typeof labels)[]) facts.push([labels[key], data.coverage[key]]);
    if (data.candleCoverage) facts.push(['Candle bars', data.candleCoverage.bars], ['Candles covered', data.candleCoverage.covered], ['Candle coverage complete', data.candleCoverage.complete]);
    else facts.push(['Candle coverage', 'Not available']);
  }
  const warnings = data ? [...(!data.complete ? ['This run is incomplete. Treat the returned figures as partial results.'] : []), ...data.warnings] : [];
  return <section className="panel coverage"><div className="panel-heading"><h3>Data coverage</h3><span id="coverage-badge" className="pill">{!data ? 'NOT CHECKED' : failed ? 'INVARIANT FAILED' : clean ? 'COMPLETE' : 'REVIEW COVERAGE'}</span></div><p id="coverage-empty" className="muted" hidden={!!data}>Coverage is evaluated for each run. Missing data will be surfaced here.</p><dl id="coverage-list" hidden={!data}>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value == null ? 'Not reported' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</dd></div>)}</dl><ul id="warnings" className="warnings" hidden={!warnings.length}>{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></section>;
}
function FailureDetail({ failure }: { failure: RunFailure }) {
  if (!failure.raw) return null;
  return <details className="failure-raw"><summary>Technical detail</summary><code>{failure.raw}</code></details>;
}
export function Results({ data, failure, busy, badge, activity, stale, exportReady, onExport, history, onClear, onEdit }: {
  data: Result | null; failure: RunFailure | null; busy: boolean; badge: string; activity: string; stale: string[]; exportReady: boolean; onExport: () => void; history: HistoryEntry[]; onClear: () => void; onEdit: () => void;
}) {
  const a = data?.analytics;
  const markout = a?.markout?.rungs ?? [];
  const panel = useRef<HTMLDivElement>(null);
  const [stickyHeight, setStickyHeight] = useState(0);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      const viewport = Math.min(window.innerHeight, window.visualViewport?.height ?? Infinity);
      // Leave a usable reading area below the chart, including on zoomed/short screens.
      setStickyHeight(window.matchMedia('(min-width: 651px)').matches && height + 256 <= viewport ? height : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, []);
  // Sticky is only useful while there is a curve to keep in view; never pin an empty or failed panel.
  const sticky = data && data.trail.length > 1 ? stickyHeight : 0;
  return <section className="results" id="results" aria-labelledby="results-title" aria-busy={busy} style={{ '--chart-clearance': `${sticky ? sticky + 32 : 16}px` } as CSSProperties}>
    <div ref={panel} className={`panel chart-panel${sticky ? ' chart-sticky' : ''}`}><div className="mobile-setup-controls"><button type="button" className="secondary" onClick={onEdit}>Edit setup</button></div><div className="panel-heading"><div><h3 id="results-title" tabIndex={-1}>Performance overview</h3><p id="result-context" className="muted">{data ? `${data.market} / ${data.quoteSymbol} · ${data.side.toUpperCase()} · ${amount(data.size)} ${data.market} · ${date(data.from)} – ${date(data.to)}` : 'Your results will appear here'}</p></div><div className="badges"><span id="fill-badge" className="pill" hidden={data?.model?.fillModel !== 'tape'} title={data?.model?.fillModel === 'tape' ? describeModel(data.model) : undefined}>MODELLED FILL</span><span id="result-badge" className={`pill${badge === 'RUN FAILED' ? ' pill-danger' : ''}`}>{badge}</span></div></div>
      <p id="activity" className={`activity${failure ? ' activity-danger' : ''}`} role="status" aria-live="polite">{activity}</p>
      {data && failure && <div className="error"><p>Run failed — the results below are from the previous run. {failure.message}</p><FailureDetail failure={failure} /></div>}
      {data && !busy && <StaleNote fields={stale} />}
      {!data && failure
        ? <div id="empty" className="empty empty-failed"><div className="empty-icon" aria-hidden="true">!</div><h4>Run failed</h4><p>{failure.message}<br /><span className="muted">{failure.hint}</span></p><FailureDetail failure={failure} /><span>Real-fill resampling below does not need a successful backtest.</span></div>
        : <div id="empty" className="empty" hidden={!!data}><div className="empty-icon" aria-hidden="true">⌁</div><h4>A hypothesis needs a test.</h4><p>Choose a market and set your position.<br />Run a backtest to reveal its historical equity curve.</p><span>No simulated results yet</span></div>}
      <Chart data={data} />
      <div className="chart-footer"><span>PRICE + FUNDING − FEES − GAS</span><button id="export" type="button" className="text-button" disabled={!exportReady || busy} onClick={onExport}>↓ Export JSON</button></div>
    </div>
    <div className="metrics" aria-label="Backtest metrics">
      <article className="panel metric"><h4>Ending equity</h4><Metric id="equity" value={data?.equityEnd} /><small id="equity-note">{data ? `${data.quoteSymbol} · Starting cash ${amount(data.cash)}` : 'Awaiting simulation'}</small></article>
      <article className="panel metric"><h4>Price PnL</h4><Metric id="pnl" value={data?.pnl} signed quote={data?.quoteSymbol} /><small>Price movement only</small></article>
      <article className="panel metric"><h4>Net funding</h4><Metric id="funding" value={data?.funding} signed quote={data?.quoteSymbol} /><small>Signed funding contribution</small></article>
      <article className="panel metric"><h4>Fees</h4><Metric id="fees" value={data?.fees} quote={data?.quoteSymbol} /><small>Reported simulation fees</small></article>
      <article className="panel metric"><h4>Max drawdown</h4><strong id="drawdown">{data ? amount(data.maxDrawdownPct) + '%' : '—'}</strong><small>Peak-to-trough decline</small></article>
    </div>
    <div className="metrics analytics-metrics" aria-label="Risk and activity metrics">
      <article className="panel metric"><h4>Sharpe</h4><strong id="sharpe">{!data ? '—' : a?.sharpe != null ? number(a.sharpe) : 'n/a'}</strong><small>Annualised, per settlement bar</small></article>
      <article className="panel metric"><h4>Sortino</h4><strong id="sortino">{!data ? '—' : a?.sortino != null ? number(a.sortino) : 'n/a'}</strong><small>Downside deviation only</small></article>
      <article className="panel metric"><h4>Turnover</h4><strong id="turnover">{a?.turnoverBps != null ? `${number(Number(a.turnoverBps) / 100, 0)}%` : '—'}</strong><small>Traded notional / mean equity</small></article>
      <article className="panel metric"><h4>Win rate</h4><strong id="winrate">{a?.winRateBps != null ? `${number(Number(a.winRateBps) / 100, 1)}%` : '—'}</strong><small id="trades-note">{a ? `${a.trades} closed · ${a.wins}W / ${a.losses}L` : 'Closed trades'}</small></article>
      <MarkoutCard rungs={markout} />
    </div>
    <Details data={data} />
    {data?.resample && <ResamplePanel data={data} />}
    <section id="compare" className="panel compare" hidden={history.length < 2}><div className="panel-heading"><h3>Run comparison</h3><button id="compare-clear" type="button" className="text-button" onClick={onClear}>Clear history</button></div><p className="muted">Kept in this browser only. Each row is one finished run.</p><ul id="compare-list">{history.map(entry => <li key={entry.runId} className={entry.runId === data?.manifest?.runId ? 'current' : undefined}><span>{`${entry.market} · ${entry.strategy} · ${entry.fillModel}${entry.profile ? `/${entry.profile}` : ''} · ${day(entry.from)}–${day(entry.to)}`}</span><span>{entry.maxDrawdown != null ? `DD ${amount(entry.maxDrawdown)}% · ` : ''}{entry.sharpe != null ? `Sharpe ${number(entry.sharpe)} · ` : ''}{entry.winRate != null ? `Win ${(Number(entry.winRate) * 100).toFixed(1)}% · ` : ''}{`${amount(entry.equityEnd)} (${Number(entry.pnl) >= 0 ? '+' : ''}${amount(entry.pnl)})`}</span></li>)}</ul></section>
    <Coverage data={data} />
  </section>;
}
