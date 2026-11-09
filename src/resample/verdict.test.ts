import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeVerdict, pValueResolution, EDGE_ALPHA, EDGE_WEAK, EDGE_ANTI_SKILL } from "./verdict.js";

test("the ladder separates real skill from luck at alpha", () => {
  assert.equal(edgeVerdict(EDGE_ALPHA - 0.0001, 300).band, "skill");
  assert.equal(edgeVerdict(EDGE_ALPHA, 300).band, "weak");
  assert.equal(edgeVerdict(EDGE_WEAK - 0.0001, 300).band, "weak");
  assert.equal(edgeVerdict(EDGE_WEAK, 300).band, "luck");
  assert.equal(edgeVerdict(EDGE_ANTI_SKILL - 0.0001, 300).band, "luck");
  assert.equal(edgeVerdict(EDGE_ANTI_SKILL, 300).band, "anti-skill");
});

/**
 *  The regression this module exists for: p = 1.0000 is the share of nulls at or above the
 *  record, so it means every random-entry path beat it. Three-band copy called that
 *  "CONSISTENT WITH LUCK", which is the opposite reading.
 */
test("the p-value ceiling reads as bad timing, never as luck", () => {
  const top = edgeVerdict(1, 300);
  assert.equal(top.band, "anti-skill");
  assert.equal(top.label, "ENTRIES WORSE THAN RANDOM");
  assert.doesNotMatch(top.label.concat(top.note), /consistent with luck/i);
  assert.match(top.note, /Every one of the 300/);
  const justBelow = edgeVerdict(0.9867, 300);
  assert.equal(justBelow.band, "anti-skill");
  assert.doesNotMatch(justBelow.note, /Every one/);
});

test("the resolution is the path count, not the four printed digits", () => {
  const { floor, step } = pValueResolution(300);
  assert.ok(Math.abs(floor - 1 / 301) < 1e-12);
  assert.equal(step, floor);
  assert.equal(pValueResolution(300).floor.toFixed(4), "0.0033");
});

test("verdicts are rejected outside the probability the ladder claims to read", () => {
  for (const bad of [-0.0001, 1.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => edgeVerdict(bad, 300), /p-value must be in \[0, 1\]/);
  }
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => edgeVerdict(0.5, bad), /paths must be a positive integer/);
    assert.throws(() => pValueResolution(bad), /paths must be a positive integer/);
  }
});

test("every band says what its half of the sentence is not", () => {
  assert.match(edgeVerdict(0.001, 300).note, /not proof of skill/);
  assert.match(edgeVerdict(0.5, 300).note, /not proof the entries were bad/);
  assert.match(edgeVerdict(0.1, 300).note, /not enough to quote/);
});
