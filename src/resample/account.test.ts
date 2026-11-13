import assert from "node:assert/strict";
import { test } from "node:test";
import { accountTrades, resampleAccount } from "./account.js";
import type { ReconcileReport } from "../verify/replay-account.js";
import type { FillReadCoverage } from "../verify/fill-coverage.js";

const row = (closed: bigint, pnl: bigint) => ({
  fillId: "f", txHash: "0x", t: 1, kind: null,
  expected: { sizeAfter: null, closedSize: null, exitPrice: null, realizedPnl: null },
  actual: { sizeAfter: 0n, closedSize: closed, exitPrice: null, realizedPnl: pnl }, diffs: [],
});
/** A full read of the four fills the fixture books; the passthrough test mutates it. */
const coverage: FillReadCoverage = {
  firstFillSec: 0, lastFillSec: 1, rowsScanned: 4, rowsInWindow: 4, rowsKept: 4, pages: 1,
  truncated: false, stoppedBy: null, accountFillsInWindow: null, accountFillsAtCeiling: false,
};
const report = (pnls: bigint[]): ReconcileReport => ({
  account: "0xabc", pool: "0xp", market: "BTC", fromSec: 0, toSec: 1, fills: pnls.length + 1, changes: 0, unmatched: 0,
  changesUnread: { fills: 0, reason: null }, coverage,
  rows: [row(0n, 0n), ...pnls.map((p) => row(1n, p))], mismatches: 0,
  fees: {
    expected: 0n, actual: 0n, diff: 0n, rows: 0, leg: "vacuous-zero-rate",
    rates: { takerBpsTimes1k: 0n, makerBpsTimes1k: 0n },
    liquidation: { rows: 0, total: 0n }, unknown: { rows: 0, total: 0n, kinds: [] }, byKind: [],
  }, ok: true, warnings: [],
});
const opts = { paths: 200, seed: "", start: 1_000_000_000n, quoteDecimals: 6, quoteSymbol: "USDso" };

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
test("the fill-read coverage reaches the response, so truncation cannot be dropped on the way out", async () => {
  const full = await resampleAccount(report([5_000_000n, -2_000_000n]), opts);
  assert.deepEqual(full.coverage, coverage);

  const cut = await resampleAccount({
    ...report([5_000_000n, -2_000_000n]),
    coverage: { ...coverage, truncated: true, stoppedBy: "maxFills", rowsKept: 2_000, rowsInWindow: 2_000, accountFillsInWindow: 10_000, accountFillsAtCeiling: true },
  }, opts);
  assert.equal(cut.coverage.stoppedBy, "maxFills");
  assert.equal(cut.coverage.accountFillsAtCeiling, true);
});

test("tempo reaches the response: cadence between closes over the window, not holding time", async () => {
  const r = report([5_000_000n, -2_000_000n, 3_000_000n]);
  r.fromSec = 0; r.toSec = 86_400;
  // The opening fill stays at t=1 and is excluded; the three closes land 100s apart.
  r.rows = [row(0n, 0n), ...[5_000_000n, -2_000_000n, 3_000_000n].map((p, i) => ({ ...row(1n, p), t: 100 + i * 100 }))];
  const out = await resampleAccount(r, opts);
  assert.equal(out.tempo.closes, 3, "only the closing fills count");
  assert.equal(out.tempo.medianGapSec, 100);
  assert.equal(out.tempo.activeSpanSec, 200);
  assert.equal(out.tempo.closesPerDay, 3, "three closes over a one-day window");
});

test("an empty account reports zero closes and no cadence, not a fabricated tempo", async () => {
  const out = await resampleAccount(report([]), opts);
  assert.equal(out.tempo.closes, 0);
  assert.equal(out.tempo.medianGapSec, null);
  assert.equal(out.tempo.activeSpanSec, null);
});
