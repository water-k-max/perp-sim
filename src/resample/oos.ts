/**
 *  Out-of-sample check: the trade list tests itself.
 *
 *  The tail of the list (holdback fraction) is held back. The earlier trades are bootstrapped
 *  at fixed size, and the 95th percentile of those path finals becomes the boundary; a sound
 *  strategy still crosses a 5% boundary about one time in twenty. The held-back trades then
 *  replay in order, as if they were the first live ones, and the held final is compared with
 *  the boundary.
 *
 *  Staying inside is not proof of an edge. Crossing is a reason to investigate what changed.
 *  Both halves come from the same run, so both inherit its biases.
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
  // floor(n * fraction) <= n - 1 for fraction < 1, so the fit half is never empty here.
  const fitCount = trades.length - heldCount;
  return { fit: trades.slice(0, fitCount), held: trades.slice(fitCount) };
}

export async function runOos(opts: OosOptions): Promise<OosResult> {
  const { fit, held } = splitHoldback(opts.trades, opts.holdbackFraction);
  const horizon = opts.horizon ?? fit.length;

  // Fit half: bootstrap with replacement, static sizing — design doc step 2.
  const fitPaths = await simulatePaths({
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
