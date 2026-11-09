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
test("same account and window give identical output", async () => {
  const r = report([5_000_000n, -2_000_000n, 3_000_000n, -1_000_000n]);
  assert.deepEqual(await resampleAccount(r, opts), await resampleAccount(r, opts));
});
test("empty account yields no distributions and a warning", async () => {
  const out = await resampleAccount(report([]), opts);
  assert.equal(out.distributions.length, 0);
  assert.ok(out.warnings.some((w) => w.includes("Only 0")));
});
test("shuffle preserves the realized total on every path", async () => {
  const out = await resampleAccount(report([5_000_000n, -2_000_000n, 3_000_000n]), opts);
  assert.equal(out.realizedTotal, "6.000000");
});
test("distributions carry fan bands one step per trade", async () => {
  const out = await resampleAccount(report([5_000_000n, -2_000_000n, 3_000_000n]), opts);
  for (const dist of out.distributions) {
    assert.equal(dist.fan.length, 4);
    assert.equal(dist.fan[0]!.step, 0);
    const last = dist.fan[dist.fan.length - 1]!;
    assert.equal(last.step, 3);
    for (const band of dist.fan) {
      for (const key of ["p10", "p25", "p50", "p75", "p90"] as const) assert.ok(Number.isFinite(Number(band[key])));
      assert.ok(Number(band.p10) <= Number(band.p25) && Number(band.p25) <= Number(band.p50)
        && Number(band.p50) <= Number(band.p75) && Number(band.p75) <= Number(band.p90));
    }
  }
});
