import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { amount, number, record, validateResample, type ResampleBlock, type Result } from './dto.js';
import { axisTicks, fanGeometry, histogram, linePath, type Band } from './fan.js';
import { edgeVerdict, pValueResolution } from '../resample/verdict.js';

const CYAN = '#60e2e9';
const VIOLET = '#99b7ff';

export function FanChart({ dist, quote, original }: {
  dist: { paths: number; fan: readonly { step: number; p10: string; p25: string; p50: string; p75: string; p90: string }[] };
  quote: string;
  original: { step: number; value: number }[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth) setWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (dist.fan.length === 0) return <p className="muted">No trades to chart.</p>;
  const fan = dist.fan.map(b => ({ step: b.step, p10: Number(b.p10), p25: Number(b.p25), p50: Number(b.p50), p75: Number(b.p75), p90: Number(b.p90) })) as Band[];
  const height = 240;
  const geometry = fanGeometry(fan, width, height, 44, width - 12, 14, height - 34);
  const last = fan[fan.length - 1]!.step;
  const originalPath = linePath(original.filter(p => p.step <= last).map(p => ({ x: geometry.x(p.step), y: geometry.y(p.value) })));
  const ticks = axisTicks(geometry.low, geometry.high, 5);
  const startY = geometry.y(fan[0]!.p50);
  return <div ref={container}>
    <div className="chart-legend"><span><i style={{ background: CYAN }} /> Resampled paths (p10–p90, p25–p75, median){original.length > 1 && <> · <i style={{ background: VIOLET }} /> this run&apos;s order</>}</span><span>{quote}</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`Equity fan over ${dist.paths} resampled paths in ${quote}, starting at ${number(fan[0]!.p50, 0)} ${quote}`}>
      {ticks.map((value, i) => <Fragment key={i}><line x1={44} x2={width - 12} y1={geometry.y(value)} y2={geometry.y(value)} stroke="#27334a" strokeDasharray="3 5" /><text x={36} y={geometry.y(value) + 4} textAnchor="end">{number(value, 0)}</text></Fragment>)}
      <line x1={44} x2={width - 12} y1={startY} y2={startY} stroke="#8593b5" strokeDasharray="2 4" />
      <text x={width - 12} y={startY - 5} textAnchor="end" fill="#8593b5">start</text>
      <path d={geometry.outerBand} fill={CYAN} opacity=".08" />
      <path d={geometry.innerBand} fill={CYAN} opacity=".14" />
      <path d={geometry.median} fill="none" stroke={CYAN} strokeWidth="2" />
      {original.length > 1 && <path d={originalPath} fill="none" stroke={VIOLET} strokeWidth="1.8" strokeDasharray="5 4" />}
      <text x={44} y={height - 8}>0</text>
      <text x={width - 12} y={height - 8} textAnchor="end">{last} trades</text>
    </svg>
  </div>;
}

export function Histogram({ values, label }: { values: number[]; label: string }) {
  const bins = useMemo(() => histogram(values, 12), [values]);
  if (!bins.length) return null;
  const max = Math.max(...bins.map(b => b.count));
  const width = 280, height = 96, left = 34, right = width - 8, top = 8, bottom = 72;
  const barWidth = (right - left) / bins.length;
  const from = bins[0]!.from, to = bins[bins.length - 1]!.to;
  return <figure className="resample-histogram">
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${label} histogram over ${values.length} paths, from ${number(from, 0)} to ${number(to, 0)}, tallest bin ${max} paths`}>
      <line x1={left} x2={right} y1={top} y2={top} stroke="#27334a" strokeDasharray="3 5" />
      <text x={left - 6} y={top + 4} textAnchor="end">{max}</text>
      <line x1={left} x2={right} y1={bottom} y2={bottom} stroke="#3a4a68" />
      <text x={left - 6} y={bottom + 4} textAnchor="end">0</text>
      {bins.map((bin, i) => { const h = bin.count / max * (bottom - top); return <rect key={i} x={left + i * barWidth + 1} y={bottom - h} width={Math.max(1, barWidth - 2)} height={h} fill={CYAN} opacity=".55" />; })}
      <text x={left} y={bottom + 16}>{number(from, 0)}</text>
      <text x={right} y={bottom + 16} textAnchor="end">{number(to, 0)}</text>
    </svg>
    <figcaption className="muted">{label}</figcaption>
  </figure>;
}

/** A metric card. `note` is the definition, printed under the value rather than hidden in a tooltip. */
export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return <article className="panel metric"><h4>{label}</h4><strong>{value}</strong>{note && <small>{note}</small>}</article>;
}

/** The distribution metrics mean the same thing in all three panels, so they read the same way. */
export const DIST_NOTES = {
  medianFinal: (paths: number, quote: string) => `Half of the ${paths} paths finish below this, in ${quote}`,
  p05p95: '1 in 20 paths ends below the first; 1 in 20 above the second',
  cvar95: 'Mean of the worst 5% of finals',
  bankruptcy: 'Paths that reach zero equity, where the walk stops',
  drawdown: 'Median depth below starting cash along a path',
  streak: 'Median longest run of consecutive losses',
  winRate: 'Trade-order confidence interval for the win rate',
  sharpe: 'Trade-order confidence interval for per-trade Sharpe',
} as const;

/** Static-size shuffling reorders the same trades, so finals are order-invariant (p05 = p95). */
export function ShuffleNote({ mode, p05, p95, sizing }: { mode: string; p05: string; p95: string; sizing?: string }) {
  if (mode !== 'shuffle_without_replacement' || p05 !== p95) return null;
  if (sizing !== undefined && sizing !== 'static') return null;
  return <p className="muted shuffle-note">Fixed size per trade: shuffling only reorders the same trades, so every path ends at the same final equity and p05 equals p95. The fan, drawdown and losing streaks still move with order — only the finals are pinned. A bootstrap draw or compound sizing varies the finals.</p>;
}

/** The result on screen answers the inputs it was read with, not the ones now in the form. */
export function StaleNote({ fields }: { fields: string[] }) {
  if (!fields.length) return null;
  return <p className="stale-note" role="status"><strong>Stale result.</strong> {fields.join(', ')} changed after this read, so everything below still answers the previous inputs. Run it again to refresh.</p>;
}

/** The random-entry null: how likely the recorded total is under uninformed timing. */
export function EdgeNullView({ edge, quote }: { edge: ResampleBlock['edge']; quote: string }) {
  if (!edge) return <p className="muted">The random-entry null needs trades and market history to price entries against; it is not part of this analysis.</p>;
  const p = Number(edge.pValue);
  const verdict = edgeVerdict(p, edge.paths);
  const { floor } = pValueResolution(edge.paths);
  return <>
    <div className="metrics">
      <Stat label="Random-entry p-value" value={edge.pValue} note={`${edge.nullsAtOrAbove} of ${edge.paths} random-entry null totals reached the recorded one, add-one corrected. Counted over ${edge.paths} paths, so it resolves no finer than ${floor.toFixed(4)} — a screen, not a figure to quote.`} />
      <Stat label="Verdict" value={verdict.label} note={verdict.note} />
      <Stat label="Recorded total" value={amount(edge.realizedTotal)} note={`Sum of recorded net PnL, ${quote}`} />
      <Stat label="Null p05 / p95" value={`${amount(edge.nullP05)} / ${amount(edge.nullP95)}`} note="5th and 95th percentile of the random-entry totals" />
      <Stat label="Null mean" value={amount(edge.nullMean)} note={`Mean of ${edge.paths} random-entry totals`} />
    </div>
    {verdict.band === 'anti-skill' && <p className="muted shuffle-note">Read the ceiling, not the floor: at this p-value the random-entry paths did as well as or better than the recorded entries everywhere. That is evidence about timing quality pointing the other way, and it is not a neutral result.</p>}
    {edge.skippedTrades > 0 && <p className="muted">{edge.skippedTrades} null trade(s) could not be placed: the market history is shorter than the holding time.</p>}
    <ul className="warnings">{edge.notes.map((line, i) => <li key={i}>{line}</li>)}</ul>
  </>;
}

const tabNames = ['distribution', 'audit', 'sizing', 'oos', 'edge'] as const;

export function ResamplePanel({ data }: { data: Result }) {
  const runId = data.manifest?.runId;
  const [override, setOverride] = useState<ResampleBlock | null>(null);
  const [active, setActive] = useState<(typeof tabNames)[number]>('distribution');
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOverride(null); setActive('distribution'); setSeed(''); setError(null); }, [runId]);
  const block = override ?? data.resample;
  if (!block) return null;

  async function rerun() {
    if (!runId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/resample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ runId, resample: { seed: seed.trim() || undefined, paths: block!.meta.paths, mode: block!.meta.mode, sizing: block!.meta.sizing } }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !record(payload) || payload.resample === undefined) {
        throw new Error(record(payload) && typeof payload.error === 'string' ? payload.error : `Request failed (HTTP ${response.status}).`);
      }
      setOverride(validateResample(payload.resample));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const dists = block.distributions;
  const [mode, setMode] = useState<string>(dists[0]?.mode ?? 'shuffle_without_replacement');
  const dist = dists.find(d => d.mode === mode) ?? dists[0];
  const start = Number(block.input.startEquity);
  const original = useMemo(() => {
    const points = [{ step: 0, value: start }];
    let equity = start;
    (data.trades || []).forEach((trade, i) => {
      equity += Number(trade.netPnl);
      points.push({ step: i + 1, value: equity });
    });
    return points;
  }, [data.trades, start]);
  const heldFinal = block.oos ? start + Number(block.oos.heldFinalMinusStart) : null;
  const oosGeometry = useMemo(() => {
    if (!block.oos) return null;
    const curve = block.oos.heldCurve.map(Number);
    const low = Math.min(...curve, Number(block.oos.boundary));
    const high = Math.max(...curve, Number(block.oos.boundary));
    const pad = (high - low) * 0.15 || 1;
    const x = (i: number) => 44 + (curve.length <= 1 ? 0 : i / (curve.length - 1) * 216);
    const y = (v: number) => 96 - (v - low + pad) / (high - low + 2 * pad) * 78;
    return { curve, low, high, x, y, boundaryY: y(Number(block.oos.boundary)) };
  }, [block.oos]);

  return <section id="resample-panel" className="panel resample" aria-label="Trade-order resampling">
    <div className="panel-heading"><div><h3>Trade-order resampling</h3><p className="muted">Seed <code>{block.meta.seed.slice(0, 16)}…</code> · {block.meta.paths} paths · {block.meta.mode === 'both' ? 'shuffle + bootstrap' : block.meta.mode.replace(/_/g, ' ')} · {block.meta.sizing} sizing · horizon {block.meta.horizonTrades} trades</p></div><div className="badges"><span className="pill" hidden={block.meta.paths >= 5000}>MODELLED DISTRIBUTION</span><span className="pill">SEEDED</span></div></div>
    {block.meta.paths < 5000 && <p className="muted">With fewer than 5,000 paths the tail figures move noticeably with the seed.</p>}
    <p className="muted">Trade-order risk on the recorded trades. Not a forecast.</p>
    <div className="resample-controls">
      <label htmlFor="resample-rerun-seed">Re-run with a new seed</label>
      <input id="resample-rerun-seed" type="text" value={seed} onChange={e => setSeed(e.target.value)} placeholder="leave blank to derive from the run id" />
      <button type="button" className="secondary" disabled={busy || !runId} onClick={() => void rerun()}>{busy ? 'Resampling…' : 'Re-run'}</button>
    </div>
    <p className="error" role="alert" hidden={error === null}>{error}</p>
    <div className="tablist" role="tablist" aria-label="Resampling views">{tabNames.map((name, index) => <button key={name} ref={el => { tabButtons.current[index] = el; }} id={`resample-tab-button-${name}`} type="button" role="tab" aria-selected={active === name} aria-controls={`resample-tab-${name}`} data-tab={name} tabIndex={active === name ? 0 : -1} onClick={() => setActive(name)} onKeyDown={event => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = (index + (event.key === 'ArrowRight' ? 1 : tabNames.length - 1)) % tabNames.length;
      tabButtons.current[next]?.focus();
      setActive(tabNames[next]);
    }}>{({ distribution: 'Distribution', audit: 'Fill check', sizing: 'Sizing', oos: 'Out-of-sample', edge: 'Null test' } as const)[name]}</button>)}</div>

    <div id="resample-tab-distribution" role="tabpanel" aria-labelledby="resample-tab-button-distribution" tabIndex={0} hidden={active !== 'distribution'}>
      {dists.length > 1 && <div className="segmented resample-mode">{dists.map(d => <label key={d.mode}><input type="radio" name="resample-mode" checked={mode === d.mode} onChange={() => setMode(d.mode)} /><span>{d.mode === 'shuffle_without_replacement' ? 'Shuffle (no replacement)' : d.mode === 'block_bootstrap_with_replacement' ? 'Block bootstrap (streaks)' : 'Bootstrap (with replacement)'}</span></label>)}</div>}
      {dist && <>
        <FanChart dist={dist} quote={data.quoteSymbol} original={original} />
        <ShuffleNote mode={dist.mode} p05={dist.p05} p95={dist.p95} sizing={block.meta.sizing} />
        <div className="metrics">
          <Stat label="Median final" value={amount(dist.median)} note={DIST_NOTES.medianFinal(dist.paths, data.quoteSymbol)} />
          <Stat label="p05 / p95" value={`${amount(dist.p05)} / ${amount(dist.p95)}`} note={DIST_NOTES.p05p95} />
          <Stat label="CVaR 95" value={amount(dist.cvar95)} note={DIST_NOTES.cvar95} />
          <Stat label="Bankruptcy rate" value={`${(Number(dist.bankruptcyRate) * 100).toFixed(1)}%`} note={DIST_NOTES.bankruptcy} />
          <Stat label="Median max drawdown" value={`${number(dist.medianMaxDrawdownBps / 100, 1)}%`} note={DIST_NOTES.drawdown} />
          <Stat label="Median losing streak" value={String(dist.medianMaxLosingStreak)} note={DIST_NOTES.streak} />
          <Stat label="Win rate p05 / p95" value={`${number(dist.p05WinRateBps / 100, 1)}% / ${number(dist.p95WinRateBps / 100, 1)}%`} note={DIST_NOTES.winRate} />
          <Stat label="Sharpe p05 / p95" value={dist.p05SharpeX1e4 === null || dist.medianSharpeX1e4 === null || dist.p95SharpeX1e4 === null ? '—' : `${number(dist.p05SharpeX1e4 / 10_000, 2)} / ${number(dist.p95SharpeX1e4 / 10_000, 2)}`} note={DIST_NOTES.sharpe} />
        </div>
        <div className="resample-histograms">
          <Histogram values={dist.finalEquities.map(Number)} label={`Final equity (${data.quoteSymbol})`} />
        </div>
      </>}
    </div>

    <div id="resample-tab-audit" role="tabpanel" aria-labelledby="resample-tab-button-audit" tabIndex={0} hidden={active !== 'audit'}>
      <div className="metrics">
        <Stat label="Same-bar share" value={`${number(block.audit.sameBarShareBps / 100, 1)}%`} note={`${block.input.sameBarCount} of ${block.input.tradeCount} trades entered and exited inside one settlement bar`} />
        <Stat label="Verdict" value={block.audit.fillBasis === 'observed' ? 'N/A · OBSERVED FILLS' : block.audit.dismissed ? 'TOO MANY SAME-BAR TRADES' : 'WITHIN THRESHOLD'} note="Whether the same-bar share is small enough to trust: a settlement-mark run past the dismissal threshold is rejected outright, while tape fills are priced on recorded prints and are never dismissed." />
        <Stat label="Stress-priced trades" value={block.audit.fillBasis === 'observed' ? '—' : String(block.audit.repricedCount)} note="Same-bar trades that provably went against the position, moved to the worst price they observed." />
        <Stat label="Median delta" value={block.audit.fillBasis === 'observed' ? '—' : `${number(block.audit.repricedMedianDeltaBps / 100, 1)}%`} note="Median final equity change after adverse re-pricing, in percent" />
      </div>
      <h4>Assumptions in this run</h4>
      <ul className="warnings">{block.assumptions.length ? block.assumptions.map((line, i) => <li key={i}>{line}</li>) : <li>None of the tracked flatterers applied: the run carries latency, gas, a non-optimistic profile and intrabar marking.</li>}</ul>
      <h4>Limits of this check</h4>
      <ul className="warnings">{block.audit.notes.map((line, i) => <li key={i}>{line}</li>)}</ul>
      {block.audit.repricedFinalEquities.length > 0 && <p className="muted">Re-priced distribution finals are stored with the analysis; the median moved {number(block.audit.repricedMedianDeltaBps / 100, 1)}%.</p>}
    </div>

    <div id="resample-tab-sizing" role="tabpanel" aria-labelledby="resample-tab-button-sizing" tabIndex={0} hidden={active !== 'sizing'}>
      <p className="muted">Odds describe resampled paths, not the future. Accepted loss: {amount(block.sizing.acceptedLoss)} {data.quoteSymbol} within the first {block.sizing.horizonTrades} trades.</p>
      <div className="table-wrap"><table>
        <thead><tr><th scope="col">Size ({data.market})</th><th scope="col">Loss probability</th><th scope="col">Median PnL</th><th scope="col">p05 PnL</th></tr></thead>
        <tbody>{block.sizing.rows.map((row, i) => <tr key={i}><td>{amount(row.sizeBase)}</td><td>{(Number(row.lossProbability) * 100).toFixed(1)}%</td><td className="num">{amount(row.medianPnl)}</td><td className="num">{amount(row.p05Pnl)}</td></tr>)}</tbody>
      </table></div>
      {block.sizing.rows.length === 0 && <p className="muted">No trades to size.</p>}
      {block.sizing.note && <p className="muted">{block.sizing.note}</p>}
    </div>

    <div id="resample-tab-oos" role="tabpanel" aria-labelledby="resample-tab-button-oos" tabIndex={0} hidden={active !== 'oos'}>
      {block.oos === null ? <p className="muted">Out-of-sample needs at least two trades in the list.</p> : <>
        <div className="metrics">
          <Stat label="Boundary (fit p95)" value={amount(block.oos.boundary)} note={`95th percentile of ${block.meta.paths} bootstrap paths over the first ${block.oos.fitCount} trades`} />
          <Stat label="Held final" value={heldFinal === null ? '—' : amount(heldFinal.toFixed(6))} note="Where the held-back tail ends, replayed in chronological order from the starting cash — comparable with the boundary above." />
          <Stat label="Verdict" value={block.oos.crossed ? 'CROSSED — INVESTIGATE' : 'INSIDE BOUNDARY'} note={block.oos.crossed ? 'Crossing the boundary is an investigation trigger, not a verdict.' : 'Staying inside is not proof of an edge.'} />
          <Stat label="Split" value={`${block.oos.fitCount} fit / ${block.oos.heldCount} held`} note={`Holdback fraction ${block.oos.holdbackFraction}`} />
        </div>
        {oosGeometry && <svg viewBox="0 0 280 110" width="280" height="110" role="img" aria-label={`Held-back replay curve${block.oos.crossed ? ' above' : ' at or below'} the fit boundary`}>
          <line x1={40} x2={264} y1={oosGeometry.boundaryY} y2={oosGeometry.boundaryY} stroke={VIOLET} strokeDasharray="4 4" />
          <text x={36} y={oosGeometry.boundaryY + 3} textAnchor="end">p95</text>
          <path d={linePath(oosGeometry.curve.map((v, i) => ({ x: oosGeometry.x(i), y: oosGeometry.y(v) })))} fill="none" stroke={CYAN} strokeWidth="2" />
        </svg>}
        <ul className="warnings">{block.oos.notes.map((line, i) => <li key={i}>{line}</li>)}</ul>
      </>}
    </div>

    <div id="resample-tab-edge" role="tabpanel" aria-labelledby="resample-tab-button-edge" tabIndex={0} hidden={active !== 'edge'}>
      <p className="muted">Random entries, same holding times, same costs — how likely is the recorded total under uninformed timing?</p>
      <EdgeNullView edge={block.edge ?? null} quote={data.quoteSymbol} />
    </div>


    {block.warnings.length > 0 && <ul className="warnings" aria-label="Resampling warnings">{block.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
  </section>;
}

