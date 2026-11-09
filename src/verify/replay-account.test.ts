import assert from "node:assert/strict";
import { test } from "node:test";
import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { feeRail, reconcileAccount } from "./replay-account.js";
import { fillFee } from "../engine/portfolio.js";
import type { MarketConfig } from "../history/market.js";

const E18 = 10n ** 18n;
const WHO = `0x${"ab".repeat(20)}`;
const POOL = "0xpool";

const cfg: MarketConfig = {
  symbol: "TEST", quoteSymbol: "USDso", pool: POOL, marginBank: "0xmargin", stopRegistry: null,
  baseDecimals: 8, quoteDecimals: 6, oneBase: 10n ** 8n, tickSize: 10n ** 16n, lotSize: 1n, minQuantity: 0n,
  imBps: 500n, mmBps: 250n, closeOutBps: 125n, effectiveImfBps: 500n, maxPositionSize: 10n ** 12n, maxOpenInterest: 10n ** 15n,
  takerFeeBpsTimes1k: 0n, makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 28_800, fundingIntervalSec: 3_600, imBpsMismatch: false,
};

/** Taker buys of one whole base at 100 quote; timestamp 1000 + i orders them oldest-first. */
const fill = (i: number) => ({
  id: `f${i}`, txHash: "0xtx", blockNumber: i + 1, logIndex: 0, timestamp: 1_000 + i,
  pool: POOL, quantity: "100000000", fillPrice: (100n * E18).toString(),
  taker: WHO, takerIsBid: true,
});

/**
 * The SDK refuses position-change reads over 1,000 fills, so the fake throws exactly like
 * the real client: a reconcile that batches more than 1,000 fills into one read fails here.
 */
function fakeClient(count: number, pageSize = 500, feeRows: Record<string, string | boolean | null>[] = []) {
  const calls: number[] = [];
  let pageAt = 0;
  let position = 0n;
  const client = {
    getUserFillsPage: async () => {
      const from = pageAt * pageSize;
      const rows = Array.from({ length: Math.min(pageSize, Math.max(0, count - from)) }, (_, k) => fill(from + k));
      pageAt += 1;
      return { fills: rows, nextCursor: from + rows.length < count ? `p${pageAt}` : null };
    },
    listPerpPositionChangesForFills: async (_account: string, fills: { quantity: string }[]) => {
      calls.push(fills.length);
      if (fills.length > 1_000) throw new Error("Perp position changes for fills take an array of at most 1000 fills");
      return fills.map((f) => {
        const sizeBefore = position;
        position += BigInt(f.quantity);
        return { sizeBefore, sizeAfter: position, entryPriceBefore: sizeBefore === 0n ? null : 100n * E18, closedSize: 0n, exitPrice: null, realizedPnl: 0n, kind: "Increase" };
      });
    },
    listPerpFees: async () => feeRows,
  } as unknown as SomniaMarketsClient;
  return { client, calls };
}

test("reconcile chunks position-change reads at the SDK's 1000-fill cap", async () => {
  const { client, calls } = fakeClient(1_200);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(report.fills, 1_200);
  assert.deepEqual(calls, [1_000, 200]);
  assert.equal(report.unmatched, 0);
  assert.equal(report.mismatches, 0);
  assert.equal(report.ok, true);
});

test("small accounts use a single position-change read", async () => {
  const { client, calls } = fakeClient(7);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(report.fills, 7);
  assert.deepEqual(calls, [7]);
  assert.equal(report.ok, true);
});

/** The same market with the fee rates a fee-charging venue would report. */
const feeCfg: MarketConfig = { ...cfg, takerFeeBpsTimes1k: 500n, makerFeeBpsTimes1k: 100n };
/** What the reconciler should recompute for one of the fixture's taker fills. */
const perFillFee = fillFee(feeCfg, "taker", (100_000_000n * (100n * E18)) / feeCfg.oneBase);

const feeRow = (i: number, amount: bigint, kind = "Fee") => ({
  id: `fee${i}`, account: WHO, pool: POOL, amount: amount.toString(), isRebate: false, kind,
  insurancePortion: null, tier: null, fillNotional: null, builder: null,
  timestamp: String(1_000 + i), txHash: "0xtx",
});

test("a non-zero fee rate makes the fill-fee leg able to fail, and a wrong record fails it", async () => {
  const honest = Array.from({ length: 6 }, (_, i) => feeRow(i, perFillFee));
  const clean = await reconcileAccount({ client: fakeClient(6, 500, honest).client, cfg: feeCfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(clean.fees.leg, "informative");
  assert.equal(clean.fees.rows, 6);
  assert.equal(clean.fees.actual, 6n * perFillFee);
  assert.equal(clean.fees.diff, 0n);
  assert.equal(clean.ok, true);

  const doubled = honest.map((row, i) => (i === 3 ? feeRow(i, perFillFee * 2n) : row));
  const wrong = await reconcileAccount({ client: fakeClient(6, 500, doubled).client, cfg: feeCfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(wrong.ok, false, "the report accepted a fee record at twice the recomputed fee");
  assert.equal(wrong.fees.diff, perFillFee);
  assert.ok(wrong.warnings.some((w) => /fill fees total/.test(w)), "the fee mismatch warning did not fire");
});

test("the zero-rate venue labels the fee pass as proving nothing", async () => {
  const report = await reconcileAccount({ client: fakeClient(6).client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(report.fees.leg, "vacuous-zero-rate");
  assert.equal(report.fees.expected, 0n);
  assert.equal(report.fees.actual, 0n);
  assert.equal(report.ok, true, "a vacuous leg is still a passing leg; the label is what stops it being read as proof");
  assert.ok(
    report.warnings.some((w) => /proved nothing/i.test(w) && /by construction/.test(w)),
    `no warning admits the fee leg cannot fail here: ${report.warnings.join(" | ")}`,
  );
});

test("liquidation penalties get their own rail instead of breaking the fill-fee check", async () => {
  // Measured on Hideki: the perp fee stream is dominated by LiquidationFee rows, non-zero,
  // while taker and maker rates are both 0. Adding them to the fill-fee total used to make
  // every liquidated account read as an accounting failure.
  const rows = [feeRow(0, 5_000n, "LiquidationFee"), feeRow(1, 0n, "LiquidationFeeSkipped"), feeRow(2, 7_000n, "LiquidationFee")];
  const report = await reconcileAccount({ client: fakeClient(6, 500, rows).client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(report.fees.rows, 0, "liquidation rows must not count as fill fees");
  assert.equal(report.fees.actual, 0n);
  assert.equal(report.fees.liquidation.rows, 3);
  assert.equal(report.fees.liquidation.total, 12_000n);
  assert.equal(report.ok, true, "a liquidated account is not a mismatched account");
  assert.ok(report.warnings.some((w) => /liquidation/i.test(w) && /excluded/i.test(w)));
  assert.deepEqual(report.fees.byKind.map((k) => k.kind), ["LiquidationFee", "LiquidationFeeSkipped"]);
});

test("an unrecognised fee kind fails closed rather than being assigned to a rail", async () => {
  const report = await reconcileAccount({
    client: fakeClient(6, 500, [feeRow(0, 9_000n, "StakingKickback")]).client, cfg, account: WHO, fromSec: 0, toSec: 10_000,
  });
  assert.equal(report.ok, false, "an unknown rail was silently tolerated");
  assert.deepEqual(report.fees.unknown.kinds, ["StakingKickback"]);
  assert.equal(report.fees.unknown.total, 9_000n);
  assert.ok(report.warnings.some((w) => /unrecognised kind/i.test(w)));
});

test("fee kinds map to rails by name, case-insensitively, with nothing assumed", () => {
  for (const kind of ["Fee", "fee", "Rebate", "BuilderFee"]) assert.equal(feeRail(kind), "trade", kind);
  for (const kind of ["LiquidationFee", "LiquidationFeeSkipped", "liquidationfee"]) assert.equal(feeRail(kind), "liquidation", kind);
  for (const kind of ["", "Fee ", "UnknownFee", "TradeFee", "Liquidation"]) assert.equal(feeRail(kind), "unknown", JSON.stringify(kind));
});
