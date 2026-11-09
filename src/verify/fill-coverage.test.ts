import assert from "node:assert/strict";
import { test } from "node:test";
import { fillCoverageStamp, parseCoverage, type FillReadCoverage } from "./fill-coverage.js";

/** A complete 7-fill read over one page, which every case below mutates. */
const base: FillReadCoverage = {
  firstFillSec: 1_700_000_000,
  lastFillSec: 1_700_000_060,
  rowsScanned: 7,
  rowsInWindow: 7,
  rowsKept: 7,
  pages: 1,
  truncated: false,
  stoppedBy: null,
  accountFillsInWindow: null,
  accountFillsAtCeiling: false,
};

const stamp = (over: Partial<FillReadCoverage>) => fillCoverageStamp({ ...base, ...over });

test("a read that ran to the end of the cursor reports a full window and names its evidence", () => {
  const s = stamp({});
  assert.equal(s.tone, "complete");
  assert.match(s.text, /Read every fill in the window: 7 fills across 1 page/);
  assert.match(s.text, /2023-11-14 22:13 → 2023-11-14 22:14 UTC/);
  assert.match(s.text, /page cursor ran out, which is what "every" rests on/);
  assert.doesNotMatch(s.text, /the indexer counts here/, "a full read is not the path that pays for a count scan");
});

test("flipping truncated changes the sentence, so the stamp is derived and not a constant", () => {
  const full = stamp({});
  const cut = stamp({ truncated: true, stoppedBy: "maxFills", rowsKept: 500, rowsInWindow: 500, rowsScanned: 500, accountFillsInWindow: 1_200 });
  assert.equal(full.tone, "complete");
  assert.equal(cut.tone, "partial");
  assert.notEqual(full.label, cut.label);
  assert.notEqual(full.text, cut.text);
  assert.match(cut.text, /Booked 500 of 1,200 fills the indexer counts here across 1 page/);
  assert.match(cut.text, /the fill cap bound the read/);
  assert.match(cut.text, /sub-window, so every total here describes that slice only/);
});

test("each stop reason names itself, and an unlabelled early stop is still called partial", () => {
  assert.match(stamp({ truncated: true, stoppedBy: "page-bound", pages: 24 }).text, /the read stopped at its 24-page bound/);
  assert.match(stamp({ truncated: true, stoppedBy: null }).text, /the read stopped before the start of the window/);
});

test("a truncated read whose count read failed says what it does and does not know", () => {
  const s = stamp({ truncated: true, stoppedBy: null, rowsKept: 500, rowsInWindow: 500, rowsScanned: 500 });
  assert.match(s.text, /500 of 500 fills the read itself returned/);
  assert.doesNotMatch(s.text, /the indexer counts/, "the stamp invented a population the server never reported");
});

test("a count at the indexer ceiling is read as a lower bound", () => {
  const s = stamp({
    truncated: true, stoppedBy: "maxFills", rowsKept: 2_000, rowsInWindow: 2_000, rowsScanned: 2_000, pages: 4,
    accountFillsInWindow: 10_000, accountFillsAtCeiling: true,
  });
  assert.equal(s.tone, "partial");
  assert.match(s.text, /Booked 2,000 of at least 10,000 fills/);
  assert.match(s.text, /across 4 pages/);
});

test("an empty read distinguishes a cursor that ran out from a read that never got there", () => {
  const done = stamp({ rowsKept: 0, rowsInWindow: 0, rowsScanned: 0, firstFillSec: null, lastFillSec: null });
  assert.equal(done.tone, "empty");
  assert.match(done.text, /ran to the end of the indexer's page cursor/);
  assert.match(done.text, /That is the answer, not a short read/);
  assert.doesNotMatch(done.text, /cannot say/);

  const short = stamp({
    rowsKept: 0, rowsInWindow: 0, rowsScanned: 500, pages: 24, firstFillSec: null, lastFillSec: null,
    accountFillsInWindow: 900, truncated: true, stoppedBy: "page-bound",
  });
  assert.equal(short.tone, "empty");
  assert.match(short.text, /cannot say the window is empty/);
  assert.doesNotMatch(short.text, /That is the answer/);
});

test("parseCoverage accepts the shape the server sends", () => {
  assert.deepEqual(parseCoverage({ ...base }), base);
  const counted = { ...base, truncated: true, stoppedBy: "maxFills" as const, accountFillsInWindow: 10_000, accountFillsAtCeiling: true };
  assert.deepEqual(parseCoverage(counted), counted);
  assert.deepEqual(parseCoverage({ ...base, rowsKept: 0, rowsInWindow: 0, firstFillSec: null, lastFillSec: null }), {
    ...base, rowsKept: 0, rowsInWindow: 0, firstFillSec: null, lastFillSec: null,
  });
});

test("parseCoverage refuses every way a coverage block can arrive wrong", () => {
  const broken: Record<string, unknown> = {
    "no object": undefined,
    "null": null,
    "a string": "everything",
    "no rowsKept": { ...base, rowsKept: undefined },
    "a fractional row count": { ...base, rowsKept: 2.5 },
    "a numeric string": { ...base, rowsKept: "7" },
    "negative kept": { ...base, rowsKept: -1 },
    "zero pages": { ...base, pages: 0 },
    "truncated as a string": { ...base, truncated: "yes" },
    "an invented stop reason": { ...base, truncated: true, stoppedBy: "deadline" },
    "a missing stop reason": { ...base, stoppedBy: undefined },
    "a negative count": { ...base, accountFillsInWindow: -7 },
    "a timestamp that is not a second": { ...base, firstFillSec: 1.5 },
  };
  for (const [label, value] of Object.entries(broken)) {
    assert.throws(() => parseCoverage(value), /Unexpected response/, label);
  }
});

test("a coverage block that parseCoverage refuses never reaches the stamp through the parser", () => {
  // The stamp trusts its input, so the pair has to hold: anything parseCoverage returns is stampable.
  const accepted = [base, { ...base, truncated: true, stoppedBy: "page-bound", pages: 40 }] as FillReadCoverage[];
  for (const value of accepted) assert.doesNotThrow(() => fillCoverageStamp(parseCoverage(value)));
});
