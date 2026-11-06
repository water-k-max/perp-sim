import { useEffect, useMemo, useRef, useState } from 'react';
import { amount, number, record, validateResample, type ResampleBlock, type Result } from './dto.js';
import { fanGeometry, histogram, linePath, type Band } from './fan.js';

const CYAN = '#60e2e9';
const VIOLET = '#99b7ff';

function FanChart({ block, quote, original }: { block: ResampleBlock; quote: string; original: { step: number; value: number }[] }) {
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
  const dist = block.distributions[0];
  if (!dist) return <p className="muted">No trades to chart.</p>;
  const fan = dist.fan.map(b => ({ step: b.step, p10: Number(b.p10), p25: Number(b.p25), p50: Number(b.p50), p75: Number(b.p75), p90: Number(b.p90) })) as Band[];
  const height = 240;
  const geometry = fanGeometry(fan, width, height, 44, width - 12, 14, height - 34);
  const last = fan[fan.length - 1]!.step;
  const originalPath = linePath(original.filter(p => p.step <= last).map(p => ({ x: geometry.x(p.step), y: geometry.y(p.value) })));
  const tick = (geometry.low + (geometry.high - geometry.low) / 2);
  return <div ref={container}>
    <div className="chart-legend"><span><i style={{ background: CYAN }} /> Resampled paths (p10–p90, p25–p75, median)</span><span><i style={{ background: VIOLET }} /> This run&apos;s trade order</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`Equity fan over ${dist.paths} resampled paths in ${quote}`}>
      <line x1={44} x2={width - 12} y1={geometry.y(tick)} y2={geometry.y(tick)} stroke="#27334a" strokeDasharray="3 5" />
      <text x={36} y={geometry.y(tick) + 4} textAnchor="end">{number(tick, 0)}</text>
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
  const width = 260;
  const barWidth = width / bins.length;
  return <figure className="resample-histogram">
    <svg viewBox={`0 0 ${width} 72`} width={width} height={72} role="img" aria-label={`${label} histogram over ${values.length} paths`}>
      {bins.map((bin, i) => <rect key={i} x={i * barWidth + 1} y={72 - bin.count / max * 64} width={Math.max(1, barWidth - 2)} height={bin.count / max * 64} fill={CYAN} opacity=".55" />)}
    </svg>
    <figcaption className="muted">{label}: {number(bins[0]!.from, 0)} … {number(bins[bins.length - 1]!.to, 0)}</figcaption>
  </figure>;
}

export function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return <article className="panel metric"><h4>{label}</h4><strong title={title}>{value}</strong></article>;
}

const tabNames = ['distribution', 'audit', 'sizing', 'oos'] as const;

export function ResamplePanel({ data }: { data: Result }) {
  const runId = data.manifest?.runId;
  const [override, setOverride] = useState<ResampleBlock | null>(null);
  const [active, setActive] = useState<(typeof tabNames)[number]>('distribution');
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
    <div className="panel-heading"><div><h3>Trade-order resampling</h3><p className="muted">Seed <code>{block.meta.seed.slice(0, 16)}…</code> · {block.meta.paths} paths · {block.meta.mode === 'both' ? 'shuffle + bootstrap' : block.meta.mode.replace(/_/g, ' ')} · {block.meta.sizing} sizing · horizon {block.meta.horizonTrades} trades</p></div><div className="badges"><span className="pill" hidden={block.meta.paths >= 5000} title="With fewer than 5,000 paths the tail figures move noticeably with the seed.">MODELLED DISTRIBUTION</span><span className="pill">SEEDED</span></div></div>
    <p className="muted">Trade-order risk on the recorded trades. Not a forecast.</p>
    <div className="resample-controls">
      <label htmlFor="resample-rerun-seed">Re-run with a new seed</label>
      <input id="resample-rerun-seed" type="text" value={seed} onChange={e => setSeed(e.target.value)} placeholder="leave blank to derive from the run id" />
      <button type="button" className="secondary" disabled={busy || !runId} onClick={() => void rerun()}>{busy ? 'Resampling…' : 'Re-run'}</button>
    </div>
    <p className="error" role="alert" hidden={error === null}>{error}</p>
    <div className="tablist" role="tablist" aria-label="Resampling views">{tabNames.map(name => <button key={name} type="button" role="tab" aria-selected={active === name} data-tab={name} onClick={() => setActive(name)}>{({ distribution: 'Distribution', audit: 'Fill check', sizing: 'Sizing', oos: 'Out-of-sample' } as const)[name]}</button>)}</div>

    <div role="tabpanel" hidden={active !== 'distribution'}>
      {dists.length > 1 && <div className="segmented resample-mode">{dists.map(d => <label key={d.mode}><input type="radio" name="resample-mode" checked={mode === d.mode} onChange={() => setMode(d.mode)} /><span>{d.mode === 'shuffle_without_replacement' ? 'Shuffle (no replacement)' : 'Bootstrap (with replacement)'}</span></label>)}</div>}
      {dist && <>
        <FanChart block={{ ...block, distributions: [dist] }} quote={data.quoteSymbol} original={original} />
        <div className="metrics">
          <Stat label="Median final" value={amount(dist.median)} title={`${dist.median} ${data.quoteSymbol}`} />
          <Stat label="p05 / p95" value={`${amount(dist.p05)} / ${amount(dist.p95)}`} />
          <Stat label="CVaR 95" value={amount(dist.cvar95)} title="Mean of the worst 5% of finals" />
          <Stat label="Bankruptcy rate" value={`${(Number(dist.bankruptcyRate) * 100).toFixed(1)}%`} />
          <Stat label="Median max drawdown" value={`${number(dist.medianMaxDrawdownBps / 100, 1)}%`} />
          <Stat label="Median losing streak" value={String(dist.medianMaxLosingStreak)} />
        </div>
        <div className="resample-histograms">
          <Histogram values={dist.finalEquities.map(Number)} label={`Final equity (${data.quoteSymbol})`} />
        </div>
      </>}
    </div>

    <div role="tabpanel" hidden={active !== 'audit'}>
      <div className="metrics">
        <Stat label="Same-bar share" value={`${number(block.audit.sameBarShareBps / 100, 1)}%`} title={`${block.input.sameBarCount} of ${block.input.tradeCount} trades entered and exited inside one settlement bar`} />
        <Stat label="Verdict" value={block.audit.fillBasis === 'observed' ? 'N/A · OBSERVED FILLS' : block.audit.dismissed ? 'TOO MANY SAME-BAR TRADES' : 'WITHIN THRESHOLD'} />
        <Stat label="Stress-priced trades" value={block.audit.fillBasis === 'observed' ? '—' : String(block.audit.repricedCount)} />
        <Stat label="Median delta" value={block.audit.fillBasis === 'observed' ? '—' : `${number(block.audit.repricedMedianDeltaBps / 100, 1)}%`} title="Median final equity change after adverse re-pricing, in percent" />
      </div>
      <h4>Assumptions in this run</h4>
      <ul className="warnings">{block.assumptions.length ? block.assumptions.map((line, i) => <li key={i}>{line}</li>) : <li>None of the tracked flatterers applied: the run carries latency, gas, a non-optimistic profile and intrabar marking.</li>}</ul>
      <h4>Limits of this check</h4>
      <ul className="warnings">{block.audit.notes.map((line, i) => <li key={i}>{line}</li>)}</ul>
      {block.audit.repricedFinalEquities.length > 0 && <p className="muted">Re-priced distribution finals are stored with the analysis; the median moved {number(block.audit.repricedMedianDeltaBps / 100, 1)}%.</p>}
    </div>

    <div role="tabpanel" hidden={active !== 'sizing'}>
      <p className="muted">Odds describe resampled paths, not the future. Accepted loss: {amount(block.sizing.acceptedLoss)} {data.quoteSymbol} within the first {block.sizing.horizonTrades} trades.</p>
      <div className="table-wrap"><table>
        <thead><tr><th scope="col">Size ({data.market})</th><th scope="col">Loss probability</th><th scope="col">Median PnL</th><th scope="col">p05 PnL</th></tr></thead>
        <tbody>{block.sizing.rows.map((row, i) => <tr key={i}><td>{amount(row.sizeBase)}</td><td>{(Number(row.lossProbability) * 100).toFixed(1)}%</td><td className="num">{amount(row.medianPnl)}</td><td className="num">{amount(row.p05Pnl)}</td></tr>)}</tbody>
      </table></div>
      {block.sizing.rows.length === 0 && <p className="muted">No trades to size.</p>}
      {block.sizing.note && <p className="muted">{block.sizing.note}</p>}
    </div>

    <div role="tabpanel" hidden={active !== 'oos'}>
      {block.oos === null ? <p className="muted">Out-of-sample needs at least two trades in the list.</p> : <>
        <div className="metrics">
          <Stat label="Boundary (fit p95)" value={amount(block.oos.boundary)} title={`95th percentile of ${block.meta.paths} bootstrap paths over the first ${block.oos.fitCount} trades`} />
          <Stat label="Held final" value={heldFinal === null ? '—' : amount(heldFinal.toFixed(6))} />
          <Stat label="Verdict" value={block.oos.crossed ? 'CROSSED — INVESTIGATE' : 'INSIDE BOUNDARY'} title={block.oos.crossed ? 'Crossing the boundary is an investigation trigger, not a verdict.' : 'Staying inside is not proof of an edge.'} />
          <Stat label="Split" value={`${block.oos.fitCount} fit / ${block.oos.heldCount} held`} title={`Holdback fraction ${block.oos.holdbackFraction}`} />
        </div>
        {oosGeometry && <svg viewBox="0 0 280 110" width="280" height="110" role="img" aria-label={`Held-back replay curve${block.oos.crossed ? ' above' : ' at or below'} the fit boundary`}>
          <line x1={40} x2={264} y1={oosGeometry.boundaryY} y2={oosGeometry.boundaryY} stroke={VIOLET} strokeDasharray="4 4" />
          <text x={36} y={oosGeometry.boundaryY + 3} textAnchor="end">p95</text>
          <path d={linePath(oosGeometry.curve.map((v, i) => ({ x: oosGeometry.x(i), y: oosGeometry.y(v) })))} fill="none" stroke={CYAN} strokeWidth="2" />
        </svg>}
        <ul className="warnings">{block.oos.notes.map((line, i) => <li key={i}>{line}</li>)}</ul>
      </>}
    </div>


    {block.warnings.length > 0 && <ul className="warnings" aria-label="Resampling warnings">{block.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
  </section>;
}

