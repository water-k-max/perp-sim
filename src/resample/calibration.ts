/**
 *  Calibration: the resampler measured against processes whose answers are known exactly.
 *
 *  Everything else in this directory proves the estimator is *reproducible*. Nothing there proves
 *  it is *correct*, and reproducibility is compatible with being wrong in the same way every time.
 *  This module supplies the missing authority: a process that is small enough to solve exactly,
 *  with no simulation in the solving, so that `bankruptcyRate`, the tail quantiles and the p-value
 *  can be compared to something that does not share their assumptions.
 *
 *  Three claims are checked, and each against an object that can see it:
 *
 *  1. `latticeLaw` — the exact distribution of the biased random walk `walkPath` implements:
 *     +winUnits with probability p, −loseUnits with probability 1−p, capital 0 absorbing and
 *     frozen, over a fixed horizon. It is computed by dynamic programming on the lattice, so the
 *     ruin probability needs no Monte Carlo and no asymptotics. The classic infinite-horizon closed
 *     form P(ruin) = ((1−p)/p)^a for p > 1/2 is a separate check *on the DP itself*, and a biased
 *     DP would show up as the finite-horizon answer converging to the wrong limit.
 *  2. `wilsonInterval` — the interval a counted rate actually carries. Calibration asserts
 *     *containment*, not equality: a Monte Carlo estimate that lands inside a Wilson interval built
 *     from its own n is evidence the estimator is unbiased, and a claim of exact equality would be
 *     a claim about sampling noise the estimator does not control.
 *  3. `uniformityReport` — under a true null, a p-value is uniform on [0, 1], so a random-entry
 *     test whose null is constructed correctly must produce p-values that are. Three views in one
 *     object (Kolmogorov–Smirnov, decile counts as χ², and the 0.05 exceedance rate) because each
 *     is blind to a different kind of misbehaviour: KS to a shifted-but-flat distribution, the
 *     binned count to a smooth distortion KS can miss at small n, and the exceedance rate to
 *     anything that breaks only in the tail.
 *
 *  The float arithmetic here is deliberate. Probabilities are not money: exact bigint is required
 *  at the ledger and buys nothing at a lattice of a few thousand states, where double rounding
 *  error is ~1e-16 and the Monte Carlo error it is compared against is ~1e-2.
 */

export type LatticeSpec = {
  /** Capital at step 0, in whole units above zero. Must be at least 1. */
  startUnits: number;
  /** Capital gained by one winning trade, in units. Must be a positive integer. */
  winUnits: number;
  /** Capital lost by one losing trade, in units. Must be a positive integer. */
  loseUnits: number;
  /** Probability of a winning trade, strictly between 0 and 1. */
  winProbability: number;
  /** Trades walked per path. Must be a positive integer. */
  horizon: number;
};

export type LatticePoint = { units: number; probability: number; atOrBelow: number };

export type LatticeLaw = {
  spec: LatticeSpec;
  /**
   *  P(capital reaches 0 at or before `horizon`). The same event `walkPath` records as
   *  `bankruptcy: true`, including its absorbing rule: once wiped, the walk stays wiped.
   */
  ruinProbability: number;
  /** Exact final-capital distribution, ascending, the absorbed mass first at 0. */
  final: LatticePoint[];
  /** Sum of the DP's mass, which must be 1 up to float error; `1` minus it is the drift. */
  mass: number;
};

const assertPositiveInt = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
};

/**
 *  The exact law of the resampled walk, by dynamic programming over reachable capital.
 *
 *  State space is bounded by `startUnits + horizon × winUnits` — the most capital a path can hold
 *  at any step — so the DP is O(horizon² × winUnits) and cheap: a 200-step walk over a 400-state
 *  lattice is 80,000 additions, not a simulation.
 */
export function latticeLaw(spec: LatticeSpec): LatticeLaw {
  assertPositiveInt("startUnits", spec.startUnits);
  assertPositiveInt("winUnits", spec.winUnits);
  assertPositiveInt("loseUnits", spec.loseUnits);
  assertPositiveInt("horizon", spec.horizon);
  if (!(spec.winProbability > 0 && spec.winProbability < 1)) throw new Error(`winProbability must be in (0,1), got ${spec.winProbability}`);

  const { startUnits, winUnits, loseUnits, horizon } = spec;
  const pUp = spec.winProbability;
  const pDown = 1 - pUp;
  const top = startUnits + horizon * winUnits;

  let live = new Float64Array(top + 1);
  live[startUnits] = 1;
  let ruined = 0;

  for (let step = 0; step < horizon; step += 1) {
    const next = new Float64Array(top + 1);
    let absorbed = 0;
    // Capital below winUnits·(step+1) cannot be reached yet, above it cannot still be standing;
    // the loop bounds follow the walk rather than the array.
    const low = Math.max(1, startUnits - loseUnits * (step + 1));
    const high = Math.min(top, startUnits + winUnits * step);
    for (let k = low; k <= high; k += 1) {
      const mass = live[k]!;
      if (mass === 0) continue;
      const up = k + winUnits;
      const down = k - loseUnits;
      if (up <= top) next[up]! += mass * pUp;
      if (down <= 0) absorbed += mass * pDown;
      else next[down]! += mass * pDown;
    }
    ruined += absorbed;
    live = next;
  }

  const final: LatticePoint[] = [];
  let cumulative = 0;
  if (ruined > 0) {
    cumulative = ruined;
    final.push({ units: 0, probability: ruined, atOrBelow: ruined });
  }
  for (let k = 1; k <= top; k += 1) {
    const probability = live[k]!;
    if (probability === 0) continue;
    cumulative += probability;
    final.push({ units: k, probability, atOrBelow: cumulative });
  }
  return { spec, ruinProbability: ruined, final, mass: cumulative };
}

/**
 *  The exact q-quantile of the lattice law, as a *threshold and the probability it really carries*.
 *
 *  A lattice CDF jumps, so the smallest capital whose cumulative mass reaches q generally covers
 *  more than q. Returning the achieved `atOrBelow` is the point: calibration must compare the
 *  Monte Carlo against the probability the threshold actually has, not against the nominal q the
 *  threshold was chosen for. Comparing against q itself would test the distribution's granularity
 *  rather than the estimator.
 */
export function exactQuantile(law: LatticeLaw, q: number): LatticePoint {
  if (!(q > 0 && q <= 1)) throw new Error(`q must be in (0,1], got ${q}`);
  for (const point of law.final) if (point.atOrBelow >= q - 1e-12) return point;
  return law.final[law.final.length - 1]!;
}

/** The infinite-horizon ruin probability of the same walk: ((1−p)/p)^capital for p > 1−p. */
export function analyticRuinLimit(startUnits: number, winProbability: number): number {
  if (winProbability <= 0.5) return 1;
  return ((1 - winProbability) / winProbability) ** startUnits;
}

export type WilsonInterval = { successes: number, trials: number, low: number, high: number, z: number };

/**
 *  Wilson score interval for a binomial proportion.
 *
 *  Chosen over the normal ("Wald") interval because the thing being bounded can be a rate near 0
 *  or 1 — a ruin probability over a short window, or a p-value below 0.05 — where Wald is known to
 *  mis-cover and can even return a bound below zero. `z = 1.96` is 95%, `z = 3` is the
 *  anything-goes band used when a gate must not be flaky.
 */
export function wilsonInterval(successes: number, trials: number, z = 1.96): WilsonInterval {
  assertPositiveInt("trials", trials);
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) throw new Error(`successes must be an integer in [0,trials], got ${successes}`);
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return { successes, trials, z, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export type UniformityReport = {
  trials: number;
  ks: { statistic: number, critical: number };
  /** Observed counts per decile of [0,1], with the expected count and the χ² statistic. */
  deciles: { counts: number[], expected: number, chi2: number, critical: number };
  /** Share of p-values below 0.05, with the interval its own count supports. */
  below05: { rate: number, interval: WilsonInterval };
  /** Every view passed: this is the sentence a gate asserts on. */
  uniform: boolean;
  detail: string;
};

/**
 *  Three views of "are these p-values uniform".
 *
 *  KS is the standard and the sharpest at large n; its 5% critical value here is the asymptotic
 *  1.36/√n, which is conservative for the small n a runtime test can afford. The decile χ² uses
 *  the df=9 table value 16.919 and catches a flat-but-lumpy distribution. The 0.05 exceedance rate
 *  is what a user of the p-value actually experiences, so it is checked with a Wilson interval
 *  rather than a bare comparison.
 */
export function uniformityReport(pValues: readonly number[]): UniformityReport {
  const n = pValues.length;
  assertPositiveInt("pValues", n);
  for (const p of pValues) {
    if (!(p >= 0 && p <= 1)) throw new Error(`p-values must lie in [0,1], got ${p}`);
  }
  const sorted = pValues.slice().sort((a, b) => a - b);

  let ks = 0;
  for (let i = 0; i < n; i += 1) {
    // Two-sided sup over both adjacent ECDF steps; with ties the step heights repeat and the max
    // still comes out right.
    const below = (i + 1) / n;
    const above = i / n;
    ks = Math.max(ks, Math.abs(below - sorted[i]!), Math.abs(above - sorted[i]!));
  }
  const ksCritical = 1.36 / Math.sqrt(n);

  const counts = new Array<number>(10).fill(0);
  for (const p of pValues) counts[Math.min(9, Math.floor(p * 10))] += 1;
  const expected = n / 10;
  const chi2 = counts.reduce((sum, c) => sum + ((c - expected) ** 2) / expected, 0);
  const chi2Critical = 16.919;

  const below05 = sorted.filter((p) => p < 0.05).length;
  const interval = wilsonInterval(below05, n);

  const uniform = ks <= ksCritical && chi2 <= chi2Critical && interval.low <= 0.05 && 0.05 <= interval.high;
  const detail = `n=${n} KS=${ks.toFixed(4)}<=${ksCritical.toFixed(4)} chi2=${chi2.toFixed(2)}<=${chi2Critical} below05=${below05}/${n} (${(below05 / n).toFixed(3)}) in [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`;
  return { trials: n, ks: { statistic: ks, critical: ksCritical }, deciles: { counts, expected, chi2, critical: chi2Critical }, below05: { rate: below05 / n, interval }, uniform, detail };
}
