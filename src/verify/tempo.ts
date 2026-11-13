/**
 *  Descriptive tempo and style of a trader, from the closing fills the reconcile recorded.
 *
 *  Tempo is the CADENCE BETWEEN CLOSES — how often the trader realizes a position — not how long
 *  each position was held. The account read carries fills, not matched opens→closes, so a holding
 *  time is not derivable here and is not claimed. Every label is a heuristic over one window's
 *  closes: descriptive, not a forecast, and not a verdict on skill. The money legs that decide the
 *  funding-driven label are compared by sign and ratio for bucketing only; nothing here is exact
 *  accounting, and the displayed figures stay with the resampler and the leaderboard.
 */

/** Seconds in a day, for the closes-per-day frequency. */
const DAY_SEC = 86_400;

export type Tempo = {
  /** Closing fills in the window (the rows with a realized close). */
  closes: number;
  /** Closes per day over `[from, to)`; null when the window has no span to divide by. */
  closesPerDay: number | null;
  /** Median seconds between consecutive closes; null with fewer than two closes. */
  medianGapSec: number | null;
  /** Seconds from the first close to the last; null with fewer than two closes. */
  activeSpanSec: number | null;
};

/** Median of an already-sorted list, the same even-length averaging the analytics metrics use. */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 *  Tempo from the closing-fill timestamps. Pure and order-agnostic: the times are sorted here, so a
 *  caller may pass them in any order. `closesPerDay` divides by the window span, not the active span,
 *  so a trader who closed twice in one second of a seven-day window reads as sparse, not frantic.
 */
export function tempoOf(times: readonly number[], fromSec: number, toSec: number): Tempo {
  const closes = times.length;
  const span = toSec - fromSec;
  const closesPerDay = span > 0 ? closes / (span / DAY_SEC) : null;
  if (closes < 2) return { closes, closesPerDay, medianGapSec: null, activeSpanSec: null };
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) gaps.push(sorted[i]! - sorted[i - 1]!);
  gaps.sort((a, b) => a - b);
  return { closes, closesPerDay, medianGapSec: median(gaps), activeSpanSec: sorted[sorted.length - 1]! - sorted[0]! };
}

/** A human gap: whole seconds under a minute, then minutes, hours, days — never a bare float. */
export function fmtGap(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < DAY_SEC) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / DAY_SEC).toFixed(1)}d`;
}

export type Cadence = { label: string; reason: string };

/**
 *  Bucket the cadence by the median inter-close gap. The thresholds are descriptive conventions, not
 *  venue rules: under five minutes is high-frequency, under an hour intraday, under a day daily, and
 *  a day or more sparse. With fewer than two closes there is no gap to measure, and the label says so
 *  rather than inventing a cadence from one observation.
 */
export function classifyCadence(t: Tempo): Cadence {
  if (t.closes === 0) return { label: "No closes", reason: "no closing fill in the window, so there is no cadence to describe" };
  if (t.closes === 1 || t.medianGapSec === null) return { label: "Single close", reason: "one closing fill: a cadence needs at least two" };
  const gap = t.medianGapSec;
  const perDay = t.closesPerDay === null ? "unknown" : t.closesPerDay.toFixed(1);
  const evidence = `median ${fmtGap(gap)} between closes, ${perDay}/day over ${t.closes} closes`;
  if (gap < 300) return { label: "High-frequency", reason: evidence };
  if (gap < 3600) return { label: "Intraday", reason: evidence };
  if (gap < DAY_SEC) return { label: "Daily", reason: evidence };
  return { label: "Sparse", reason: evidence };
}

export type Style = { label: string; reasons: string[] };

/**
 *  A descriptive style label. `fundingDriven` is true only when the leaderboard netting showed
 *  received funding lifting net above gross (the mirror path carries it); null means the funding leg
 *  was not read on this path, so the label falls back to cadence and win-rate character and says the
 *  funding is unknown rather than assuming it away. The win-rate and gross-sign reasons are context,
 *  not a skill verdict: a high win rate over few closes is still few closes.
 */
export function classifyStyle(input: {
  fundingDriven: boolean | null;
  grossPositive: boolean;
  winRateBps: number;
  cadence: Cadence;
  closes: number;
}): Style {
  const reasons: string[] = [];
  let label: string;
  if (input.fundingDriven === true) {
    label = "Funding-driven";
    reasons.push("received funding — not trading — lifted net above gross; mirroring the trades would not reproduce that income");
  } else {
    label = input.cadence.label;
    if (input.fundingDriven === null) reasons.push("funding is not read on this path, so the style is from gross closes only; the leaderboard nets funding and fees");
  }
  if (input.closes >= 2) {
    const pct = (input.winRateBps / 100).toFixed(0);
    if (input.winRateBps >= 7000) reasons.push(`high win rate: ${pct}% of closes green`);
    else if (input.winRateBps <= 3000) reasons.push(`low win rate: ${pct}% of closes green`);
    else reasons.push(`mixed win rate: ${pct}% of closes green`);
  }
  if (input.closes > 0) reasons.push(input.grossPositive ? "gross realized over the window is positive" : "gross realized over the window is not positive");
  return { label, reasons };
}