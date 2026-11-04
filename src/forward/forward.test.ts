import test from "node:test";
import assert from "node:assert/strict";
import { buildForwardTest, pickBand, forwardTestJson } from "./forward.js";
import { buildResampleAnalysis, parseResampleRequest, type ResampleAnalysis } from "../resample/analysis.js";
import type { TradeRecord } from "../resample/inputs.js";

const E18 = 10n ** 18n;

function rec(seq: number, pnl: bigint): TradeRecord {
  return {
    seq,
    entryTs: seq * 86_400,
    exitTs: seq * 86_400 + 1_000,
    pnl,
    direction: seq % 2 === 0 ? "long" : "short",
    barsHeld: 1,
    sameBar: false,
    mae: null,
    mfe: null,
    worstPrice: null,
    bestPrice: null,
    excursionSource: "none",
    size: E18,
    entryPrice: 100n * E18,
    exitPrice: 100n * E18,
    funding: 0n,
    fee: 0n,
    gas: 0n,
  };
}

function analysis(): ResampleAnalysis {
  return buildResampleAnalysis({
    runId: "d".repeat(64),
    list: { trades: Array.from({ length: 8 }, (_, i) => rec(i + 1, BigInt(((i * 11) % 7) - 3) * E18)), sameBarCount: 0, withoutExcursionCount: 0, window: { from: 1, to: 9 } },
    request: parseResampleRequest({ seed: "forward-fixture", paths: 64, holdbackFraction: null }),
    createdAt: "2026-11-01T00:00:00.000Z",
    start: 100n * E18,
    quoteDecimals: 18,
    baseDecimals: 18,
    quoteScale: E18,
    oneBase: E18,
    lotSize: E18 / 100n,
    maxSize: 100n * E18,
    markPrice: 100n * E18,
    effectiveImfBps: 1_000n,
    market: "ETH-USDso",
    assumptions: { fillModel: "tape", profile: "realistic", latencySec: 1, gasPerTx: "0", intrabar: false },
  });
}

const ACCOUNT = "0x" + "ab".repeat(20);

test("pickBand prefers the shuffle distribution and expresses it as PnL offsets", () => {
  const a = analysis();
  const band = pickBand(a, 18);
  assert.equal(band.length, a.distributions[0]!.fan.length);
  assert.equal(a.distributions[0]!.mode, "shuffle_without_replacement");
  // Step 0 is exactly at start equity, so its offsets are zero.
  assert.equal(band[0]!.p10, 0n);
  assert.equal(band[0]!.p50, 0n);
  assert.equal(band[0]!.p90, 0n);
  // Monotone ladder survives the offset conversion.
  for (const step of band) assert.ok(step.p10 <= step.p25 && step.p25 <= step.p50 && step.p50 <= step.p75 && step.p75 <= step.p90);
});

test("live fills accumulate exactly and outside/inside counts follow the band", () => {
  const a = analysis();
  const band = pickBand(a, 18);
  // A live path that hugs the median of every step lands inside the inner band.
  const medianFills = band.slice(1).map((step, i) => ({
    fillId: `f${i + 1}`,
    t: 1_800_000_000 + i * 3_600,
    pnl: step.p50 - (band[i]!.p50),
  }));
  const inside = buildForwardTest({ runId: a.meta.source.runId, account: ACCOUNT, analysis: a, quoteDecimals: 18, fills: medianFills });
  assert.equal(inside.fills, medianFills.length);
  assert.equal(inside.outsideP10P90, 0);
  assert.equal(inside.insideP25P75, medianFills.length);
  assert.equal(inside.firstOutsideSeq, null);

  // A live path that rockets past the p90 of every step lands outside.
  const wildFills = band.slice(1).map((step, i) => ({
    fillId: `w${i + 1}`,
    t: 1_800_000_000 + i * 3_600,
    pnl: step.p90 - (band[i]!.p90) + E18,
  }));
  const outside = buildForwardTest({ runId: a.meta.source.runId, account: ACCOUNT, analysis: a, quoteDecimals: 18, fills: wildFills });
  assert.equal(outside.outsideP10P90, wildFills.length);
  assert.equal(outside.firstOutsideSeq, 1);

  // Cumulative PnL is exact bigint at every step.
  let cumulative = 0n;
  outside.points.forEach((p, i) => {
    cumulative += wildFills[i]!.pnl;
    assert.equal(p.cumulativePnl, cumulative);
    assert.equal(p.band!.step, Math.min(i + 1, band.length - 1));
  });
});

test("the JSON edge converts to decimal strings without losing the exact counts", () => {
  const a = analysis();
  const test = buildForwardTest({
    runId: a.meta.source.runId,
    account: ACCOUNT,
    analysis: a,
    quoteDecimals: 18,
    fills: [{ fillId: "x", t: 1_800_000_000, pnl: 5n * E18 }],
    skippedFills: 2,
  });
  const json = forwardTestJson(test);
  assert.equal(json.points[0]!.cumulativePnl, "5.0");
  assert.equal(json.skippedFills, 2);
  assert.equal(json.bandMode, "shuffle_without_replacement");
  assert.ok(json.notes.some((n) => /investigation trigger, not a verdict/.test(n)));
  assert.ok(json.notes.some((n) => /not a forecast/.test(n)));
});

test("an analysis without distributions cannot offer a band", () => {
  const a = analysis();
  a.distributions = [];
  assert.throws(() => pickBand(a, 18), /no distribution/);
});
