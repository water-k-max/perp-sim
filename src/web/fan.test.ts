import test from "node:test";
import assert from "node:assert/strict";
import { fanGeometry, histogram, linePath, axisTicks } from "./fan.js";

const fan = [
  { step: 0, p10: 90, p25: 95, p50: 100, p75: 105, p90: 110 },
  { step: 1, p10: 85, p25: 94, p50: 102, p75: 111, p90: 120 },
  { step: 2, p10: 80, p25: 93, p50: 104, p75: 117, p90: 130 },
];

test("fan band path strings are pinned for fixed input and viewport", () => {
  const g = fanGeometry(fan, 300, 240, 44, 288, 14, 206);
  assert.equal(g.median, "M44.00,125.48 L166.00,119.29 L288.00,113.10");
  assert.equal(g.outerBand, "M44.00,94.52 L166.00,63.55 L288.00,32.58 L288.00,187.42 L166.00,171.94 L44.00,156.45 Z");
  assert.equal(g.innerBand, "M44.00,110.00 L166.00,91.42 L288.00,72.84 L288.00,147.16 L166.00,144.06 L44.00,140.97 Z");
});

test("fan geometry scales and stays ordered: inner band sits inside outer", () => {
  const g = fanGeometry(fan, 600, 480, 88, 576, 28, 412);
  for (const band of fan) {
    assert.ok(g.y(band.p25) <= g.y(band.p10), "p25 boundary is above p10 at every step");
    assert.ok(g.y(band.p90) <= g.y(band.p75), "p90 boundary is below p75 at every step");
  }
});

test("linePath and histogram are exact", () => {
  assert.equal(linePath([{ x: 0, y: 1 }, { x: 2.5, y: 3 }]), "M0.00,1.00 L2.50,3.00");
  assert.equal(linePath([]), "");
  assert.deepEqual(histogram([], 4), []);
  assert.deepEqual(histogram([5, 5, 5], 3), [{ from: 5, to: 5, count: 3 }]);
  const bins = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
  assert.equal(bins.length, 5);
  assert.equal(bins.reduce((sum, b) => sum + b.count, 0), 10);
  assert.ok(bins.every(b => b.to > b.from));
});

test("axisTicks spans the inclusive bounds with 3–5 ticks and survives a degenerate range", () => {
  const five = axisTicks(100, 200);
  assert.deepEqual(five, [100, 125, 150, 175, 200]);
  assert.equal(five[0], 100);
  assert.equal(five[five.length - 1], 200);
  assert.equal(axisTicks(0, 10, 3).length, 3);
  assert.equal(axisTicks(0, 10, 99).length, 5, "count clamps to five");
  assert.equal(axisTicks(0, 10, 1).length, 3, "count clamps to three");
  assert.deepEqual(axisTicks(5, 5), [5], "a flat range collapses to one tick, never divides by zero");
  assert.deepEqual(axisTicks(Infinity, 1), [Infinity]);
  assert.ok(axisTicks(-50, 50).every(Number.isFinite));
});
