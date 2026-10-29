import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { amount, date, type Result } from './dto.js';

export function Chart({ data }: { data: Result | null }) {
  const container = useRef<HTMLDivElement>(null);
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
  const points = [...(data?.trail ?? [])].sort((a, b) => a.t - b.t);
  const summary = !data ? '' : points.length ? `${points.length} equity samples, from ${date(points[0].t)} to ${date(points[points.length - 1].t)}. Equity starts at ${amount(points[0].equity)} and ends at ${amount(points[points.length - 1].equity)} ${data.quoteSymbol}. Reported maximum drawdown: ${data.maxDrawdownPct}%.` : 'The engine returned no equity samples. Summary metrics are available, but no curve can be drawn.';
  let low = Infinity, high = -Infinity;
  for (const point of points) { low = Math.min(low, Number(point.equity)); high = Math.max(high, Number(point.equity)); }
  if (!points.length) { low = 0; high = 1; }
  const pad = (high - low) * .12 || Math.max(Math.abs(low) * .01, 1);
  low -= pad; high += pad;
  const ticks = Array.from({ length: 5 }, (_, i) => low + (high - low) * i / 4);
  const tickFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  // Bound the axis gutter even for very large balances; exact values remain in the summary.
  const labels = ticks.map(value => {
    const label = tickFormat.format(value);
    return label.length <= 10 ? label : value.toExponential(2);
  });
  const left = Math.max(48, Math.max(...labels.map(label => label.length)) * 7 + 12);
  const right = width - 12, top = 18, bottom = 238, height = 276;
  const start = points[0]?.t ?? 0, end = points[points.length - 1]?.t ?? 0;
  const x = (t: number) => start === end ? (left + right) / 2 : left + (t - start) / (end - start) * (right - left);
  const y = (value: string | number) => bottom - (Number(value) - low) / (high - low) * (bottom - top);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(p.equity).toFixed(2)}`).join(' ');
  const last = points[points.length - 1];
  const shortDate = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return <div ref={container} id="chart-wrap" hidden={!data}>
    <div className="chart-legend"><span><i /> Equity</span><span id="chart-unit">{data && data.quoteSymbol + ' · UTC'}</span></div>
    <svg id="chart" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby="chart-title chart-desc">
      <title id="chart-title">Historical equity</title><desc id="chart-desc">{summary}</desc>
      {!points.length ? <text x={width / 2} y="135" textAnchor="middle">No equity samples returned</text> : <>
        {ticks.map((value, i) => {
          const yy = y(value);
          return <Fragment key={i}><line x1={left} x2={right} y1={yy} y2={yy} stroke="#27334a" strokeDasharray="3 5" /><text x={left - 10} y={yy + 4} textAnchor="end">{labels[i]}</text></Fragment>;
        })}
        {points.length > 1 && <><path d={`${path} L${x(end)},${bottom} L${x(start)},${bottom} Z`} fill="#60e2e9" opacity=".07" /><path d={path} fill="none" stroke="#60e2e9" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></>}
        <circle cx={x(last.t)} cy={y(last.equity)} r="4" fill="#60e2e9" />
        {start === end ? <text x={(left + right) / 2} y="264" textAnchor="middle">{shortDate(start)}</text> : <><text x={left} y="264">{shortDate(start)}</text><text x={right} y="264" textAnchor="end">{shortDate(end)}</text></>}
      </>}
    </svg><p id="chart-summary" className="muted chart-summary">{summary}</p>
  </div>;
}
