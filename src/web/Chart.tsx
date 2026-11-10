import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { amount, date, number, type Result } from './dto.js';
import { axisTicks } from './fan.js';

/** Index of the sample closest in time to `t`. `points` must be sorted by `t`. */
export function nearestSample(points: readonly { t: number }[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(points[lo]!.t - t) > Math.abs(points[lo - 1]!.t - t) ? lo - 1 : lo;
}

/**
 *  What the pointer readout may claim. A cursor that has not moved, or that sits past the end of
 *  the trail, names no sample and no number of closes — the rest state has to be silent, because
 *  "0 trades closed here" over a bar nobody hovered is a fact the run never established.
 */
export function cursorReadout(cursor: number | null, points: readonly { t: number; equity: string }[], closes: ReadonlyMap<number, number>): { point: { t: number; equity: string } | null; closed: number } {
  const point = cursor === null ? null : points[cursor] ?? null;
  const closed = point === null || cursor === null ? 0 : closes.get(cursor) ?? 0;
  return { point, closed };
}

export function Chart({ data }: { data: Result | null }) {
  const container = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(300);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth) setWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const points = useMemo(() => [...(data?.trail ?? [])].sort((a, b) => a.t - b.t), [data]);
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => { setCursor(null); }, [data]);
  const trades = data?.trades ?? [];
  // How many closes land on each sample, for the readout. Counts only — money is never summed here.
  const closes = useMemo(() => {
    const out = new Map<number, number>();
    if (!points.length) return out;
    for (const trade of trades) {
      const index = nearestSample(points, Number(trade.t));
      out.set(index, (out.get(index) ?? 0) + 1);
    }
    return out;
  }, [points, trades]);
  const summary = !data ? '' : points.length ? `${points.length} equity samples, from ${date(points[0].t)} to ${date(points[points.length - 1].t)}. Equity starts at ${amount(points[0].equity)} and ends at ${amount(points[points.length - 1].equity)} ${data.quoteSymbol}. Reported maximum drawdown: ${data.maxDrawdownPct}%.` : 'The engine returned no equity samples. Summary metrics are available, but no curve can be drawn.';
  let low = Infinity, high = -Infinity;
  for (const point of points) { low = Math.min(low, Number(point.equity)); high = Math.max(high, Number(point.equity)); }
  if (!points.length) { low = 0; high = 1; }
  const pad = (high - low) * .12 || Math.max(Math.abs(low) * .01, 1);
  low -= pad; high += pad;
  const ticks = axisTicks(low, high, 5);
  const tickFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  // Bound the axis gutter even for very large balances; exact values remain in the summary.
  const labels = ticks.map(value => {
    const label = tickFormat.format(value);
    return label.length <= 10 ? label : value.toExponential(2);
  });
  const left = Math.max(48, Math.max(...labels.map(label => label.length)) * 7 + 12);
  const right = width - 12, top = 18, bottom = 238, height = 276;
  const start = points[0]?.t ?? 0, end = points[points.length - 1]?.t ?? 0;
  const x = useCallback((t: number) => start === end ? (left + right) / 2 : left + (t - start) / (end - start) * (right - left), [start, end, left, right]);
  const y = (value: string | number) => bottom - (Number(value) - low) / (high - low) * (bottom - top);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(p.equity).toFixed(2)}`).join(' ');
  const last = points[points.length - 1];
  const shortDate = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const clampX = useCallback((value: number) => Math.min(right, Math.max(left, value)), [left, right]);
  const { point: at, closed: shown } = cursorReadout(cursor, points, closes);
  // Built once per geometry, not per pointer move: a busy run closes hundreds of trades.
  const markers = useMemo(() => trades.map((trade, i) => {
    const px = clampX(x(Number(trade.t)));
    return <line key={i} className={Number(trade.netPnl) >= 0 ? 'rug rug-win' : 'rug rug-loss'} x1={px} x2={px} y1={bottom - 10} y2={bottom} vectorEffect="non-scaling-stroke" />;
  }), [trades, x, clampX]);

  function track(event: ReactPointerEvent<SVGSVGElement>) {
    const box = svg.current?.getBoundingClientRect();
    if (!box?.width || !points.length) return;
    // The viewBox is authored at the measured width, but CSS can still scale it.
    const px = clampX((event.clientX - box.left) * (width / box.width));
    setCursor(nearestSample(points, start === end ? start : start + ((px - left) / (right - left)) * (end - start)));
  }

  function browse(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (!points.length) return;
    const inside = (index: number) => Math.min(points.length - 1, Math.max(0, index));
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const forward = event.key === 'ArrowRight';
      setCursor(cursor === null ? (forward ? 0 : points.length - 1) : inside(cursor + (forward ? 1 : -1)));
    } else if (event.key === 'Home') { event.preventDefault(); setCursor(0); }
    else if (event.key === 'End') { event.preventDefault(); setCursor(points.length - 1); }
    else if (event.key === 'Escape') setCursor(null);
  }

  return <div ref={container} id="chart-wrap" hidden={!data}>
    <div className="chart-legend"><span><i /> Equity{trades.length > 0 && <> · <b className="tick tick-win" />win<b className="tick tick-loss" />loss closes marked on the axis</>}</span><span id="chart-unit">{data && data.quoteSymbol + ' · UTC'}</span></div>
    <svg ref={svg} id="chart" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby="chart-title chart-desc" tabIndex={0} onPointerMove={track} onPointerDown={track} onPointerLeave={() => setCursor(null)} onBlur={() => setCursor(null)} onKeyDown={browse}>
      <title id="chart-title">Historical equity</title><desc id="chart-desc">{summary}</desc>
      {!points.length ? <text x={width / 2} y="135" textAnchor="middle">No equity samples returned</text> : <>
        {ticks.map((value, i) => {
          const yy = y(value);
          return <Fragment key={i}><line x1={left} x2={right} y1={yy} y2={yy} stroke="#27334a" strokeDasharray="3 5" /><text x={left - 10} y={yy + 4} textAnchor="end">{labels[i]}</text></Fragment>;
        })}
        {points.length > 1 && <><line x1={left} x2={right} y1={y(points[0].equity)} y2={y(points[0].equity)} stroke="#8593b5" strokeDasharray="2 4" /><text x={right} y={y(points[0].equity) - 5} textAnchor="end" fill="#8593b5">start</text></>}
        {points.length > 1 && <><path d={`${path} L${x(end)},${bottom} L${x(start)},${bottom} Z`} fill="#60e2e9" opacity=".07" /><path d={path} fill="none" stroke="#60e2e9" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></>}
        {markers}
        {at && <g className="crosshair" pointerEvents="none"><line x1={x(at.t)} x2={x(at.t)} y1={top} y2={bottom} stroke="#8593b5" strokeDasharray="3 3" /><circle cx={x(at.t)} cy={y(at.equity)} r="4.5" fill="#0b1323" stroke="#60e2e9" strokeWidth="2" /></g>}
        <circle cx={x(last.t)} cy={y(last.equity)} r="4" fill="#60e2e9" />
        {start === end ? <text x={(left + right) / 2} y="264" textAnchor="middle">{shortDate(start)}</text> : <><text x={left} y="264">{shortDate(start)}</text><text x={right} y="264" textAnchor="end">{shortDate(end)}</text></>}
      </>}
    </svg>
    <div id="chart-cursor" className={`chart-cursor${at ? ' on' : ''}`} role="status" aria-live="polite" style={at ? { left: `${clampX(x(at.t))}px`, transform: x(at.t) > (left + right) / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' } : undefined}>{at && <><strong>{number(at.equity)} {data?.quoteSymbol}</strong><span>{date(at.t)}</span>{shown > 0 && <em>{shown} trade{shown === 1 ? '' : 's'} closed here</em>}</>}</div>
    <p id="chart-summary" className="muted chart-summary">{summary}</p>
  </div>;
}
