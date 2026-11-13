import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCadence, classifyStyle, fmtGap, tempoOf, type Tempo } from "./tempo.js";

/**
 *  The descriptive tempo/style module. Tempo is inter-close cadence, not holding time, and every
 *  label is a heuristic. The canaries that matter: the median gap uses the even-length average (a
 *  revert to a naive pick changes it), the cadence thresholds are pinned at their boundaries, and the
 *  funding-driven style label is two-sided — present only when the netting showed received funding,
 *  never assumed on a manual read where funding is unknown.
 */
const DAY = 86_400;

test("tempoOf counts closes, divides by the window span, and takes the median inter-close gap", () => {
  const t = tempoOf([100, 110, 130], 0, DAY);
  assert.equal(t.closes, 3);
  assert.equal(t.closesPerDay, 3, "three closes over one day is three per day");
  assert.equal(t.medianGapSec, 15, "gaps [10,20] average to 15 at even length");
  assert.equal(t.activeSpanSec, 30, "first close 100 to last 130");
});

test("CANARY: the median gap averages the middle two at even length, not a naive pick", () => {
  // gaps [10, 20, 30, 40] -> middle two 20 and 30 -> 25. A naive lower/upper pick would give 20 or 30.
  const t = tempoOf([0, 10, 30, 60, 100], 0, DAY);
  assert.equal(t.medianGapSec, 25);
  // odd length takes the true middle: gaps [10,20,30] -> 20.
  assert.equal(tempoOf([0, 10, 30, 60], 0, DAY).medianGapSec, 20);
});

test("tempoOf is order-agnostic and reports nulls below two closes", () => {
  assert.deepEqual(tempoOf([130, 100, 110], 0, DAY), tempoOf([100, 110, 130], 0, DAY), "sorted internally");
  const one = tempoOf([100], 0, DAY);
  assert.equal(one.closes, 1);
  assert.equal(one.medianGapSec, null);
  assert.equal(one.activeSpanSec, null);
  const none = tempoOf([], 0, DAY);
  assert.equal(none.closes, 0);
  assert.equal(none.closesPerDay, 0);
  assert.equal(none.medianGapSec, null);
});

test("closesPerDay is null when the window has no span, not a divide-by-zero", () => {
  assert.equal(tempoOf([100, 110], 5, 5).closesPerDay, null);
  assert.equal(tempoOf([100, 110], 10, 5).closesPerDay, null, "a reversed window has no positive span");
});

test("fmtGap reads as whole seconds, minutes, hours, days — never a bare float", () => {
  assert.equal(fmtGap(45), "45s");
  assert.equal(fmtGap(120), "2m");
  assert.equal(fmtGap(7200), "2.0h");
  assert.equal(fmtGap(172800), "2.0d");
});

const tempo = (medianGapSec: number, closes = 10): Tempo => ({ closes, closesPerDay: closes, medianGapSec, activeSpanSec: medianGapSec * closes });

test("classifyCadence buckets by the median gap and names the empty/single cases", () => {
  assert.equal(classifyCadence(tempoOf([], 0, DAY)).label, "No closes");
  assert.equal(classifyCadence(tempoOf([100], 0, DAY)).label, "Single close");
  assert.equal(classifyCadence(tempo(60)).label, "High-frequency");
  assert.equal(classifyCadence(tempo(1800)).label, "Intraday");
  assert.equal(classifyCadence(tempo(7200)).label, "Daily");
  assert.equal(classifyCadence(tempo(2 * DAY)).label, "Sparse");
});

test("CANARY: the cadence thresholds are strict at their boundaries, so a revert moves a label", () => {
  assert.equal(classifyCadence(tempo(299)).label, "High-frequency");
  assert.equal(classifyCadence(tempo(300)).label, "Intraday", "exactly 5m is no longer high-frequency");
  assert.equal(classifyCadence(tempo(3599)).label, "Intraday");
  assert.equal(classifyCadence(tempo(3600)).label, "Daily", "exactly 1h is no longer intraday");
  assert.equal(classifyCadence(tempo(DAY - 1)).label, "Daily");
  assert.equal(classifyCadence(tempo(DAY)).label, "Sparse", "exactly 1d is sparse");
});

test("the cadence reason cites the evidence: median gap, per-day rate and close count", () => {
  const c = classifyCadence(tempo(60, 25));
  assert.match(c.reason, /median 1m between closes/);
  assert.match(c.reason, /25\.0\/day over 25 closes/);
});

const styleInput = (over: Partial<Parameters<typeof classifyStyle>[0]> = {}) => ({
  fundingDriven: null as boolean | null, grossPositive: true, winRateBps: 5000, cadence: classifyCadence(tempo(60)), closes: 100, ...over,
});

test("CANARY: the funding-driven label is two-sided — only when the netting showed received funding", () => {
  const driven = classifyStyle(styleInput({ fundingDriven: true }));
  assert.equal(driven.label, "Funding-driven");
  assert.ok(driven.reasons.some((r) => r.includes("received funding")), "names funding as the driver");
  assert.ok(driven.reasons.some((r) => r.includes("would not reproduce")), "says a trade copy cannot reproduce it");
  // Not driven (funding paid or zero): the cadence label stands, no funding-income claim.
  const paid = classifyStyle(styleInput({ fundingDriven: false }));
  assert.notEqual(paid.label, "Funding-driven");
  assert.ok(!paid.reasons.some((r) => r.includes("received funding")));
  // Unknown (manual read): the cadence label stands and the funding is declared unknown, not zero.
  const unknown = classifyStyle(styleInput({ fundingDriven: null }));
  assert.notEqual(unknown.label, "Funding-driven");
  assert.ok(unknown.reasons.some((r) => r.includes("funding is not read")), "a manual read says funding is unknown");
  assert.ok(!paid.reasons.some((r) => r.includes("funding is not read")), "a netted read does not call funding unknown");
});

test("classifyStyle adds the win-rate character and the gross sign, but only with closes", () => {
  assert.ok(classifyStyle(styleInput({ winRateBps: 9000 })).reasons.some((r) => r.includes("high win rate: 90%")));
  assert.ok(classifyStyle(styleInput({ winRateBps: 2000 })).reasons.some((r) => r.includes("low win rate: 20%")));
  assert.ok(classifyStyle(styleInput({ winRateBps: 5000 })).reasons.some((r) => r.includes("mixed win rate: 50%")));
  assert.ok(classifyStyle(styleInput({ grossPositive: false })).reasons.some((r) => r.includes("not positive")));
  const empty = classifyStyle(styleInput({ closes: 0, cadence: classifyCadence(tempoOf([], 0, DAY)) }));
  assert.equal(empty.label, "No closes");
  assert.ok(!empty.reasons.some((r) => r.includes("gross realized")), "no gross-sign noise on an empty account");
  assert.ok(!empty.reasons.some((r) => r.includes("win rate")), "no win-rate claim with no closes");
});