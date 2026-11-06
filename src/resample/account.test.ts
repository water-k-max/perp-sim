import assert from "node:assert/strict";
import { test } from "node:test";
import { accountTrades, resampleAccount } from "./account.js";
import type { ReconcileReport } from "../verify/replay-account.js";

const row = (closed: bigint, pnl: bigint) => ({
  fillId: "f", txHash: "0x", t: 1, kind: null,
  expected: { sizeAfter: null, closedSize: null, exitPrice: null, realizedPnl: null },
  actual: { sizeAfter: 0n, closedSize: closed, exitPrice: null, realizedPnl: pnl }, diffs: [],
});
const report = (pnls: bigint[]): ReconcileReport => ({
  account: "0xabc", pool: "0xp", market: "BTC", fromSec: 0, toSec: 1, fills: pnls.length + 1, changes: 0, unmatched: 0,
  rows: [row(0n, 0n), ...pnls.map((p) => row(1n, p))], mismatches: 0,
  fees: { expected: 0n, actual: 0n, diff: 0n, rows: 0 }, ok: true, warnings: [],
});
const opts = { paths: 200, seed: "", start: 1_000_000_000n, quoteDecimals: 6 };

test("opening fills are excluded from the trade list", () => {
  assert.equal(accountTrades(report([5n, -3n])).length, 2);
});
test("same account and window give identical output", () => {
  const r = report([5_000_000n, -2_000_000n, 3_000_000n, -1_000_000n]);
  assert.deepEqual(resampleAccount(r, opts), resampleAccount(r, opts));
});
test("empty account yields no distributions and a warning", () => {
  const out = resampleAccount(report([]), opts);
  assert.equal(out.distributions.length, 0);
  assert.ok(out.warnings.some((w) => w.includes("Only 0")));
});
test("shuffle preserves the realized total on every path", () => {
  const out = resampleAccount(report([5_000_000n, -2_000_000n, 3_000_000n]), opts);
  assert.equal(out.realizedTotal, "6.000000");
});
