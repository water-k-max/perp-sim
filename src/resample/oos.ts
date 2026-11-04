/**
 *  Out-of-sample module (spec §7): the backtest audits itself.
 *
 *  The tail of the trade list (holdback fraction) is held back. The fit trades are
 *  resampled with replacement at fixed size and the 95th percentile of the fit path
 *  finals becomes the boundary — one healthy strategy in twenty crosses a 5% boundary by
 *  chance. The held-back trades then replay chronologically, as if they were the first
 *  live ones, and the verdict compares the held final against the boundary.
 *
 *  Verdict framing, kept verbatim in spirit: staying inside is *not* proof of an edge;
 *  crossing is a reason to investigate what changed before money is at risk. Both halves
 *  come from the same run, so both inherit its biases.
 *
 *  No look-ahead is structural: the fit half is a prefix slice of the trade list, so held
 *  trades cannot influence fit statistics. The `fitSeqs`/`heldSeqs` records let the
 *  `oos-no-lookahead` invariant re-verify that from the persisted JSON.
 */

import type { TradeRecord } from "./inputs.js";
import { simulatePaths } from "./path.js";
import { quantileNum } from "./stats.js";

export type OosOptions = {
  /** Chronological trade list. */
  trades: readonly TradeRecord[];
  /** Fraction of the tail to hold back, in (0, 1). */
  holdbackFraction: number;
  seed: string | number | bigint;
  paths: number;
  start: bigint;
  /** Fit-path length in trades; defaults to the fit trade count. */
  horizon?: number;
  quoteScale: bigint;
};

export type OosResult = {
  holdbackFraction: number;
  fitCount: number;
  heldCount: number;
  /** The 95th percentile of fit path finals, decimal quote units. */
  boundary: number;
  /** Every fit path's final, path order — raw material for the calibration check. */
  fitFinals: bigint[];
  /** Cumulative equity of the held-back replay, starting at `start`. */
  heldCurve: bigint[];
  heldFinalMinusStart: bigint;
  /** True when the held final lands above the boundary: an investigation trigger, not a verdict. */
  crossed: boolean;
  /** Trade seqs per half, for the no-lookahead invariant. */
  fitSeqs: number[];
  heldSeqs: number[];
  notes: string[];
};

function dec(value: bigint, quoteScale: bigint): number {
  return Number(value) / Number(quoteScale);
}

export function splitHoldback(trades: readonly TradeRecord[], fraction: number): { fit: readonly TradeRecord[]; held: readonly TradeRecord[] } {
  if (trades.length < 2) throw new Error("out-of-sample needs at least two trades");
  if (!(fraction > 0 && fraction < 1)) throw new Error("holdback fraction must be in (0, 1)");
  const heldCount = Math.max(1, Math.floor(trades.length * fraction));
  const fitCount = trades.length - heldCount;
  if (fitCount < 1) throw new Error("holdback fraction leaves no fit trades");
  return { fit: trades.slice(0, fitCount), held: trades.slice(fitCount) };
}

export function runOos(opts: OosOptions): OosResult {
  const { fit, held } = splitHoldback(opts.trades, opts.holdbackFraction);
  const horizon = opts.horizon ?? fit.length;

  // Fit half: bootstrap with replacement, static sizing — spec §7 step 2.
  const fitPaths = simulatePaths({
    trades: fit.map((t) => ({ pnl: t.pnl })),
    mode: "bootstrap_with_replacement",
    sizing: "static",
    paths: opts.paths,
    horizon,
    start: opts.start,
    seed: opts.seed,
  });
  const fitFinals = fitPaths.map((p) => p.finalEquity);
  const boundary = quantileNum(fitFinals.map((v) => dec(v, opts.quoteScale)).sort((a, b) => a - b), 0.95);

  // Held-back replay: chronological, cumulative, exact.
  const heldCurve: bigint[] = [opts.start];
  let equity = opts.start;
  for (const trade of held) {
    equity += trade.pnl;
    heldCurve.push(equity);
  }

  const heldFinalDec = dec(equity, opts.quoteScale);
  return {
    holdbackFraction: opts.holdbackFraction,
    fitCount: fit.length,
    heldCount: held.length,
    boundary,
    fitFinals,
    heldCurve,
    heldFinalMinusStart: equity - opts.start,
    crossed: heldFinalDec > boundary,
    fitSeqs: fit.map((t) => t.seq),
    heldSeqs: held.map((t) => t.seq),
    notes: [
      "Staying inside the boundary is not proof of an edge; crossing it is a reason to investigate what changed, not a verdict.",
      "Both halves come from the same run, so both inherit its biases.",
    ],
  };
}
