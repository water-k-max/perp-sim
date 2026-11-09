import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { EDGE_PATHS, nullTradeNet, runEdgeTest } from "./edge.js";
import type { TradeList, TradeRecord } from "./inputs.js";
import { deriveStream, nextIndex } from "./rng.js";
import {
  analyticRuinLimit, exactQuantile, latticeLaw, uniformityReport, wilsonInterval,
} from "./calibration.js";
import { simulatePaths, type PathTrade } from "./path.js";
import { quantileNum } from "./stats.js";

const SCALE = 1_000_000n;
/** A trade list of exactly `wins` whole-unit gains and `losses` whole-unit losses. */
const pool = (wins: number, losses: number): PathTrade[] => [
  ...Array.from({ length: wins }, () => ({ pnl: SCALE })),
  ...Array.from({ length: losses }, () => ({ pnl: -SCALE })),
];

const walk = (startUnits: number, winProbability: number, horizon: number) => ({
  startUnits, winUnits: 1, loseUnits: 1, winProbability, horizon,
});

test("the lattice DP reaches the classic ruin limit from below, and the limit is not the DP's own construction", () => {
  // P(ruin, infinite horizon) = ((1−p)/p)^a for p > 1−p is a theorem about the walk, computed
  // here by a formula that shares no code with the DP. A DP that lost or double-counted mass
  // would converge to the wrong number, or fail to be monotone in the horizon.
  const p = 0.55;
  const a = 3;
  const limit = analyticRuinLimit(a, p);
  assert.ok(Math.abs(limit - (0.45 / 0.55) ** 3) < 1e-15);

  let previous = 0;
  for (const horizon of [50, 100, 200, 400, 600]) {
    const law = latticeLaw(walk(a, p, horizon));
    assert.ok(law.ruinProbability > previous, `ruin must grow with the horizon (it fell at ${horizon})`);
    assert.ok(law.ruinProbability <= limit + 1e-12, `a finite horizon cannot be more ruinous than the limit (H=${horizon})`);
    previous = law.ruinProbability;
  }
  const near = latticeLaw(walk(a, p, 600));
  assert.ok(limit - near.ruinProbability < 1e-3, `H=600 should be within 0.001 of the limit, gap was ${limit - near.ruinProbability}`);
  // Fair game: ruin is certain eventually, so the finite-horizon answer only approaches 1.
  const fair = [50, 200, 800].map((h) => latticeLaw(walk(5, 0.5, h)).ruinProbability);
  assert.ok(fair[2]! > fair[0]! && fair[2]! < 1, `p=0.5 must creep toward certainty: ${fair}`);
});

test("the DP conserves probability mass, including the absorbed atom at zero", () => {
  for (const spec of [walk(3, 0.55, 200), walk(10, 0.55, 60), walk(5, 0.5, 120), { ...walk(6, 0.5, 60), winUnits: 2 }]) {
    const law = latticeLaw(spec);
    assert.ok(Math.abs(law.mass - 1) < 1e-9, `mass ${law.mass} for ${JSON.stringify(spec)}`);
    const total = law.final.reduce((s, f) => s + f.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    const zero = law.final.find((f) => f.units === 0);
    assert.ok(Math.abs((zero?.probability ?? 0) - law.ruinProbability) < 1e-12, "the mass sitting at zero IS the ruin probability");
    assert.ok(law.final.every((f) => f.probability > 0), "no atom with zero probability may be listed");
    // Monotone everywhere, strictly increasing over the support that carries distinguishable
    // mass: a state holding less than double resolution next to a total of 1 (≈1e-16) is added
    // without moving the cumulative, and that is float arithmetic, not a broken CDF.
    assert.ok(law.final.every((f, i) => i === 0 || f.atOrBelow >= law.final[i - 1]!.atOrBelow), "CDF must not decrease");
    assert.ok(law.final.every((f, i) => i === 0 || f.probability <= 1e-12 || f.atOrBelow > law.final[i - 1]!.atOrBelow), "CDF must be strictly increasing over the real support");
  }
});

test("an uneven step is not silently treated as an even one", () => {
  // +2/−1 from 6 units is a different walk than +1/−1 and must give a different answer; a DP that
  // ignored winUnits would report the same ruin probability for both.
  const uneven = latticeLaw({ startUnits: 6, winUnits: 2, loseUnits: 1, winProbability: 0.5, horizon: 60 });
  const even = latticeLaw({ startUnits: 6, winUnits: 1, loseUnits: 1, winProbability: 0.5, horizon: 60 });
  assert.notEqual(uneven.ruinProbability, even.ruinProbability);
  assert.ok(uneven.ruinProbability < even.ruinProbability, "+2 gains should be safer than +1 at the same win rate");
});

/**
 * The estimator against the law: same process, one solved and one sampled.
 *
 * `bootstrap_with_replacement` over a pool of exactly W wins and L losses draws i.i.d. ±1 steps
 * with p = W/(W+L) — literally the lattice process — so the agreement below is a calibration test
 * of `walkPath` + `summarizePaths`, not a consistency check between two views of the same numbers.
 * The seeds are fixed, so a pass here is reproducible rather than lucky: `z = 3` widens the band to
 * a 99.7% interval so the gate is about bias, never about one unlucky stream.
 */
async function sampled(startUnits: number, wins: number, losses: number, horizon: number, paths: number, seed: string) {
  const law = latticeLaw(walk(startUnits, wins / (wins + losses), horizon));
  const outcomes = await simulatePaths({
    trades: pool(wins, losses), mode: "bootstrap_with_replacement", sizing: "static",
    paths, horizon, start: BigInt(startUnits) * SCALE, seed,
  });
  return { law, outcomes, paths };
}

test("the Monte Carlo bankruptcy rate contains the exact ruin probability", async () => {
  const { law, outcomes, paths } = await sampled(10, 55, 45, 60, 2_000, "calibration-ruin");
  const bankrupt = outcomes.filter((o) => o.bankruptcy).length;
  const interval = wilsonInterval(bankrupt, paths, 3);
  assert.ok(
    interval.low <= law.ruinProbability && law.ruinProbability <= interval.high,
    `exact ruin ${law.ruinProbability.toFixed(4)} outside MC 99.7% band [${interval.low.toFixed(4)}, ${interval.high.toFixed(4)}] from ${bankrupt}/${paths}`,
  );
  // Non-vacuity: a counter permanently stuck at zero, or one that fires on every path, would pass
  // nothing here — the truth being aimed at sits well away from both ends, and the band is tight
  // enough to be a real constraint.
  assert.ok(law.ruinProbability > 0.05 && law.ruinProbability < 0.95, `calibration target degenerate: ${law.ruinProbability}`);
  assert.ok(bankrupt > 0 && bankrupt < paths, `the estimator reported ${bankrupt}/${paths}`);
  assert.ok(interval.high - interval.low < 0.05, `band is too wide to mean anything: ${interval.high - interval.low}`);
  assert.ok(outcomes.filter((o) => o.finalEquity === 0n).length === bankrupt, "frozen-at-zero final equity must agree with the bankruptcy flag");
});

test("a shallower account is ruinous enough for the difference to be visible", async () => {
  // The same estimator on a spec whose true rate is much higher: if the harness could not tell
  // these apart, the containment above would be evidence of nothing.
  const shallow = await sampled(3, 55, 45, 60, 2_000, "calibration-ruin-shallow");
  const deep = await sampled(10, 55, 45, 60, 2_000, "calibration-ruin");
  assert.ok(shallow.law.ruinProbability > deep.law.ruinProbability + 0.2, "starting capital must move the true rate");
  const shallowRate = shallow.outcomes.filter((o) => o.bankruptcy).length / shallow.paths;
  const deepRate = deep.outcomes.filter((o) => o.bankruptcy).length / deep.paths;
  assert.ok(shallowRate > deepRate + 0.1, `the estimator must see the difference too: ${shallowRate} vs ${deepRate}`);
});

test("the nominal 5% and 95% quantiles are breached at the rate the exact law says", async () => {
  const { law, outcomes, paths } = await sampled(20, 55, 45, 60, 2_000, "calibration-quantile");
  const finals = outcomes.map((o) => Number(o.finalEquity) / Number(SCALE)).sort((a, b) => a - b);
  for (const q of [0.05, 0.5, 0.95]) {
    const threshold = exactQuantile(law, q);
    // Breach means "at or below" on a lattice: the atom sits exactly on the threshold.
    const breaches = finals.filter((v) => v <= threshold.units + 1e-9).length;
    const interval = wilsonInterval(breaches, paths, 3);
    assert.ok(
      interval.low <= threshold.atOrBelow && threshold.atOrBelow <= interval.high,
      `q=${q}: exact coverage ${threshold.atOrBelow.toFixed(4)} at ${threshold.units} outside [${interval.low.toFixed(4)}, ${interval.high.toFixed(4)}]`,
    );
  }
  // The p05 check above must not have collapsed into the ruin check: on this spec the 5% quantile
  // is a positive capital, not the absorbed atom at zero.
  assert.ok(exactQuantile(law, 0.05).units > 0, "p05 fell on the bankruptcy atom, so this tested the ruin rate again");
  // And the estimator's own interpolated quantile should be near the same lattice point.
  assert.ok(Math.abs(quantileNum(finals, 0.05) - exactQuantile(law, 0.05).units) <= 2, "the reported p05 drifted from the exact threshold");
});

test("the shuffle mode is a different process and is not calibrated against the i.i.d. law", async () => {
  // A permutation of a fixed pool cannot have an i.i.d. step distribution: with horizon equal to
  // the pool, every path ends at the same total, while the lattice says otherwise. Pinning the
  // disagreement is what keeps the calibration honest about its own scope.
  const wins = 55, losses = 45;
  const outcomes = await simulatePaths({
    trades: pool(wins, losses), mode: "shuffle_without_replacement", sizing: "static",
    paths: 200, horizon: wins + losses, start: 10n * SCALE, seed: "calibration-shuffle",
  });
  const survived = outcomes.filter((o) => !o.bankruptcy);
  const finals = new Set(survived.map((o) => o.finalEquity));
  assert.equal(finals.size, 1, "every non-ruined permutation realizes the same total");
  assert.equal([...finals][0], 10n * SCALE + BigInt(wins - losses) * SCALE);
  assert.ok(outcomes.some((o) => o.bankruptcy) && survived.length > 0, "a full permutation must be able to go both ways here");
  assert.ok(outcomes.filter((o) => o.bankruptcy).every((o) => o.finalEquity === 0n), "a ruined path freezes at zero and never recovers the pool total");
  const law = latticeLaw(walk(10, wins / (wins + losses), wins + losses));
  assert.ok(law.final.length > 2, "the i.i.d. law spreads over many capitals, which is the whole difference");
});

test("Wilson bands behave at the ends where the naive interval breaks", () => {
  const none = wilsonInterval(0, 400);
  assert.equal(none.low, 0, "a proportion of zero must not get a negative lower bound");
  assert.ok(none.high > 0 && none.high < 0.02, `0/400 should bound above by ~1%, got ${none.high}`);
  const all = wilsonInterval(400, 400);
  assert.equal(all.high, 1);
  assert.ok(all.low > 0.98);
  const mid = wilsonInterval(200, 400);
  assert.ok(mid.low < 0.5 && mid.high > 0.5);
  assert.ok(wilsonInterval(200, 400, 3).high - wilsonInterval(200, 400, 3).low > mid.high - mid.low, "a wider z must widen the band");
});

test("a uniform sample passes every view of the uniformity report", () => {
  // A deterministic, explicitly uniform sequence — (i + 0.5)/n — not a random one, so the check of
  // the checker is itself reproducible.
  const n = 1_000;
  const uniform = Array.from({ length: n }, (_, i) => (i + 0.5) / n);
  const report = uniformityReport(uniform);
  assert.ok(report.uniform, report.detail);
  assert.ok(report.ks.statistic < 0.01, `KS on an exactly uniform grid should be tiny, got ${report.ks.statistic}`);
  assert.ok(report.deciles.chi2 < 0.01, `chi2 on a flat grid should be ~0, got ${report.deciles.chi2}`);
});

test("the uniformity report can fail: skewed, lumped and tail-heavy p-values are all caught", () => {
  const n = 1_000;
  const skewed = Array.from({ length: n }, (_, i) => (i / n) ** 2); // piles up near 1
  assert.equal(uniformityReport(skewed).uniform, false, "a distribution biased toward p=1 passed");
  const lumped = Array.from({ length: n }, (_, i) => Math.floor((i % 100) / 10) / 10 + 0.01); // two deciles only
  assert.equal(uniformityReport(lumped).uniform, false, "a two-bin distribution passed");
  const tailHeavy = Array.from({ length: n }, (_, i) => (i < 200 ? i / 4_000 : 0.2 + (i - 200) / (n - 200) * 0.8)); // 20% below 0.05
  const report = uniformityReport(tailHeavy);
  assert.equal(report.uniform, false, "an 8× inflated 5% exceedance rate passed");
  assert.ok(report.below05.interval.low > 0.05, `the exceedance band should sit above 0.05, got ${JSON.stringify(report.below05)}`);
  assert.throws(() => uniformityReport([]), /positive integer/);
  assert.throws(() => uniformityReport([0.5, 1.4]), /\[0,1\]/);
});

/**
 *  The shipped random-entry test, against a null that is null by construction.
 *
 *  The trade list's own entries are drawn from `deriveStream` (domain `perp-sim/resample/v1`) while
 *  the null paths use `deriveEdgeStream` (domain `perp-sim/edge/v1`) — different hash domains, so
 *  the recorded total is an independent draw from the same distribution as the 300 null totals it
 *  is ranked against. Its rank is therefore uniform, and any bias in the p-value — a mislabelled
 *  direction, a one-off in the add-one correction, an entry index drawn off by one, funding signed
 *  the wrong way on one leg — moves that rank. This is the only part of the calibration that tests
 *  `edge.ts` itself rather than the walk.
 */
test("the edge p-value is uniform under a true null, on the shipped test", async () => {
  const { nullList, BARS, Q6, CFG } = edgeFixture();
  const pValues: number[] = [];
  for (let i = 0; i < 600; i += 1) {
    const seed = `calibration-edge-${i}`;
    const block = runEdgeTest({ seed, list: nullList(seed, 4), bars: BARS, cfg: CFG, quoteScale: Q6 });
    assert.ok(block, `seed ${seed} produced no edge block`);
    pValues.push(Number(block.pValue));
  }
  const report = uniformityReport(pValues);
  assert.ok(report.uniform, `the random-entry p-value is not uniform: ${report.detail}`);
  // The lattice the note describes: p moves in steps of 1/(EDGE_PATHS+1) and cannot leave
  // [1/301, 1]. Both extremes are pinned by name in `edge.test.ts`; what this run adds is that
  // 600 independent tests spread across the whole ladder rather than clustering somewhere.
  const step = 1 / (EDGE_PATHS + 1);
  for (const p of pValues) {
    assert.ok(p >= step - 1e-4 && p <= 1 + 1e-4, `p=${p} outside the achievable [${step}, 1]`);
    // `pValue` crosses the API as a four-decimal string, so the nearest lattice point can be up to
    // 5e-5 away — half a hundredth of a step. Anything coarser than that is not a count over 300.
    const rank = p / step;
    assert.ok(Math.abs(rank - Math.round(rank)) < 0.02, `p=${p} is not a count over ${EDGE_PATHS} paths (rank ${rank})`);
  }
  assert.ok(Math.min(...pValues) <= 4 * step, `600 tests never got near the floor: min=${Math.min(...pValues)}`);
  assert.ok(Math.max(...pValues) >= 1 - 4 * step, `600 tests never got near the ceiling: max=${Math.max(...pValues)}`);
});

function edgeFixture() {
  const Q6 = 1_000_000n;
  const CFG: MarketConfig = {
    symbol: "TEST", quoteSymbol: "USDso", pool: `0x${"1".repeat(40)}`, marginBank: `0x${"2".repeat(40)}`,
    stopRegistry: null, baseDecimals: 6, quoteDecimals: 6, oneBase: Q6, tickSize: 10n, lotSize: 10n,
    minQuantity: 10n, imBps: 5_000n, mmBps: 2_500n, closeOutBps: 1_250n, effectiveImfBps: 5_000n,
    maxPositionSize: Q6, maxOpenInterest: 1_000n * Q6, takerFeeBpsTimes1k: 500n, makerFeeBpsTimes1k: 100n,
    fundingWindowSec: 3_600, fundingIntervalSec: 3_600, imBpsMismatch: false,
  };
  const bar = (t: number, mark: bigint, cum: bigint): Bar => ({
    t, block: 1, logIndex: 0, mark, markSource: "mark", indexPrice: mark, cum, fundingDelta: 0n, rate: 0n,
    fundingWindowSec: 3_600, fundingIntervalSec: 3_600, intervalsSettled: 1, intervalsAccrued: 1,
    forgivenIntervals: 0, anchorResynced: false, gapSec: 3_600, missedIntervals: 0, low: null, high: null, candles: 0,
  });
  // Marks wander and the funding index climbs: a null trade prices both legs against movement that
  // has nothing to do with when it entered.
  const marks = deriveStream("calibration-bars", 0);
  let mark = 100n * Q6;
  const BARS: Bar[] = [];
  for (let i = 0; i < 60; i += 1) {
    mark += ((marks() % 200n) - 100n) * (Q6 / 100n);
    BARS.push(bar(i * 3_600, mark, (1n << 62n) + BigInt(i) * (1n << 40n)));
  }
  const base = (partial: Partial<TradeRecord>): TradeRecord => ({
    entryTs: 0, exitTs: 3_600, pnl: 0n, direction: "long", barsHeld: 1, sameBar: false,
    mae: null, mfe: null, worstPrice: null, bestPrice: null, excursionSource: "none",
    size: Q6, entryPrice: 0n, exitPrice: 0n, funding: 0n, fee: 0n, gas: 0n, seq: 1, ...partial,
  });
  function nullList(seed: string, count: number): TradeList {
    const rng = deriveStream(`${seed}|list`, 0);
    const trades: TradeRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      const holding = 1 + nextIndex(rng, 3);
      const entryIdx = nextIndex(rng, BARS.length - holding);
      const record = base({
        direction: i % 2 === 0 ? "long" : "short", barsHeld: holding, seq: i + 1,
        entryTs: BARS[entryIdx]!.t, exitTs: BARS[entryIdx + holding]!.t,
      });
      // The recorded PnL is the same object the null prices, at that entry: identical arithmetic,
      // so the only difference between record and null is which entry each drew.
      trades.push({ ...record, pnl: nullTradeNet(BARS, entryIdx, holding, record, CFG).net });
    }
    return { trades, sameBarCount: 0, withoutExcursionCount: 0, window: { from: BARS[0]!.t, to: BARS[BARS.length - 1]!.t } };
  }
  return { BARS, CFG, Q6, nullList };
}
