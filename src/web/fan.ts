/**
 *  Pure geometry for the resampling fan chart, kept out of the component so the exact
 *  path strings can be snapshot-pinned for a fixed seed. Bands stack like a Plotly
 *  tonexty fill: the p10–p90 polygon renders first, then p25–p75 on top.
 */

export type Band = { step: number; p10: number; p25: number; p50: number; p75: number; p90: number };

export type FanGeometry = {
  low: number;
  high: number;
  x: (step: number) => number;
  y: (value: number) => number;
  outerBand: string;
  innerBand: string;
  median: string;
};

export function fanGeometry(fan: readonly Band[], width: number, height: number, left: number, right: number, top: number, bottom: number): FanGeometry {
  if (fan.length === 0) throw new Error('cannot chart an empty fan');
  let low = Infinity;
  let high = -Infinity;
  for (const band of fan) {
    low = Math.min(low, band.p10);
    high = Math.max(high, band.p90);
  }
  const pad = (high - low) * 0.12 || Math.max(Math.abs(high) * 0.01, 1);
  low -= pad;
  high += pad;
  const last = fan[fan.length - 1]!.step;
  const x = (step: number) => (last === 0 ? (left + right) / 2 : left + step / last * (right - left));
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  const line = (pick: (band: Band) => number) => fan.map((band, i) => `${i ? 'L' : 'M'}${x(band.step).toFixed(2)},${y(pick(band)).toFixed(2)}`).join(' ');
  const bandPath = (upper: (band: Band) => number, lower: (band: Band) => number) => {
    const up = fan.map((b, i) => `${i ? 'L' : 'M'}${x(b.step).toFixed(2)},${y(upper(b)).toFixed(2)}`).join(' ');
    const down = [...fan].reverse().map(b => `L${x(b.step).toFixed(2)},${y(lower(b)).toFixed(2)}`).join(' ');
    return `${up} ${down} Z`;
  };
  return {
    low, high, x, y,
    outerBand: bandPath(b => b.p90, b => b.p10),
    innerBand: bandPath(b => b.p75, b => b.p25),
    median: line(b => b.p50),
  };
}

/** A simple polyline path (the held-out replay curve, or the median). */
export function linePath(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

/**
 * Evenly spaced axis ticks spanning the inclusive [low, high] bounds, so the first and last
 * tick label the axis min and max. The count is clamped to 3–5; a degenerate or non-finite
 * range collapses to a single tick at `low` rather than dividing by zero.
 */
export function axisTicks(low: number, high: number, target = 5): number[] {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return [low];
  const count = Math.max(3, Math.min(5, Math.round(target)));
  return Array.from({ length: count }, (_, i) => low + (high - low) * i / (count - 1));
}

/** Even-width histogram bins over a numeric sample; returned counts are exact. */
export function histogram(values: readonly number[], bins: number): { from: number; to: number; count: number }[] {
  if (values.length === 0) return [];
  if (bins < 1) throw new Error('histogram needs at least one bin');
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  if (low === high) return [{ from: low, to: high, count: values.length }];
  const width = (high - low) / bins;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.floor((value - low) / width));
    counts[index]! += 1;
  }
  return counts.map((count, i) => ({ from: low + i * width, to: low + (i + 1) * width, count }));
}
