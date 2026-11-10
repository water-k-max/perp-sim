import test from "node:test";
import assert from "node:assert/strict";
import { cursorReadout, nearestSample } from "./Chart.js";

/**
 *  The two decisions behind the chart's pointer readout, tested as the pure functions they are.
 *
 *  `renderToStaticMarkup` cannot move a cursor: the hover readout only exists inside a `useState`
 *  the server never updates, so the rendered rest state proves the *empty* markup and nothing
 *  else — an injection into the branch that names a sample stays invisible to it. Pulling the
 *  decision out is the only way this readout can be guarded at all.
 */
const trail = [{ t: 1_000, equity: "100" }, { t: 2_000, equity: "110" }, { t: 3_000, equity: "105" }];

test("nearestSample lands every time on the closest sample, including outside the window", () => {
  assert.deepEqual([0, 500, 1_000, 1_499, 1_500, 2_000, 2_499, 2_501, 3_000, 9_000].map(t => nearestSample(trail, t)), [0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
  // The search is a lower bound, and it steps back only when the earlier sample is *strictly*
  // closer: an exact tie between two settlements reads as the later one, never both.
  assert.equal(nearestSample(trail, 1_500), 1);
  assert.equal(nearestSample(trail, 2_500), 2);
  assert.equal(nearestSample(trail, 1_501), 1, "1499 vs 1501 either side of the tie must not agree");
  assert.equal(nearestSample(trail, 500), 0, "a trade before the first sample still has to land on a bar");
});

test("the readout claims nothing until a cursor names a sample that exists", () => {
  const closes = new Map([[1, 3]]);
  assert.deepEqual(cursorReadout(null, trail, closes), { point: null, closed: 0 }, "no pointer, so no claim");
  assert.deepEqual(cursorReadout(1, trail, closes), { point: trail[1], closed: 3 });
  assert.deepEqual(cursorReadout(0, trail, closes), { point: trail[0], closed: 0 }, "a bar with no closes reports none, not a missing key");
  assert.deepEqual(cursorReadout(9, trail, closes), { point: null, closed: 0 }, "a cursor past the end of a short trail is not a sample");
  assert.deepEqual(cursorReadout(1, [], closes), { point: null, closed: 0 });
});
