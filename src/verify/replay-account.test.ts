import assert from "node:assert/strict";
import { test } from "node:test";
import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { feeRail, reconcileAccount } from "./replay-account.js";
import { fillCoverageStamp } from "./fill-coverage.js";
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

/**
 * Taker buys at 100 quote, timestamp `1000 + i` (oldest-first) and a size that cycles 1/2/3 whole
 * base. The varying size is what makes the chunking tests mean something: with every fill the same
 * size, a position-change row misassigned to a neighbouring fill produces the same running total as
 * the correct one, so a dropped or shifted chunk would reconcile cleanly and the test would pass
 * while the alignment was broken.
 */
const qty = (i: number) => 100_000_000n * BigInt(1 + (i % 3));
const fill = (i: number) => ({
  id: `f${i}`, txHash: "0xtx", blockNumber: i + 1, logIndex: 0, timestamp: 1_000 + i,
  pool: POOL, quantity: qty(i).toString(), fillPrice: (100n * E18).toString(),
  taker: WHO, takerIsBid: true,
});

/**
 * The SDK refuses position-change reads over 1,000 fills, so the fake throws exactly like
 * the real client: a reconcile that batches more than 1,000 fills into one read fails here.
 *
 * `fillsCounted` stands in for the advisory `countUserFills` read: it defaults to the number of
 * rows this fake can page through, and `null` makes it fail, which is how a real endpoint that
 * rejects the query behaves. `countCalls` records how many times it was asked, because the real
 * read is a 10,001-row scan and must not be paid for on a read that already covered its window.
 *
 * `changeFails` is the position-change read's own fault injection, keyed by call number: the
 * fills of that chunk come back as an error rather than rows. Use a permanently refused message
 * to keep the test fast, and `changeFlaky` for the transient kind the retry is supposed to eat.
 */
function fakeClient(
  count: number,
  pageSize = 500,
  feeRows: Record<string, string | boolean | null>[] = [],
  fillsCounted: number | null = count,
  changeFails: number[] = [],
  changeFlaky: number[] = [],
) {
  const calls: number[] = [];
  const countCalls: unknown[][] = [];
  let pageAt = 0;
  let position = 0n;
  const flakySeen = new Map<number, number>();
  const client = {
    countUserFills: async (account: string, opts: unknown) => {
      countCalls.push([account, opts]);
      if (fillsCounted === null) throw new Error("count query rejected by this endpoint");
      return fillsCounted;
    },
    getUserFillsPage: async () => {
      const from = pageAt * pageSize;
      const rows = Array.from({ length: Math.min(pageSize, Math.max(0, count - from)) }, (_, k) => fill(from + k));
      pageAt += 1;
      return { fills: rows, nextCursor: from + rows.length < count ? `p${pageAt}` : null };
    },
    listPerpPositionChangesForFills: async (_account: string, fills: { quantity: string }[]) => {
      const nth = calls.length;
      calls.push(fills.length);
      if (fills.length > 1_000) throw new Error("Perp position changes for fills take an array of at most 1000 fills");
      if (changeFails.includes(nth)) throw new Error("indexer PerpPositionChanges failed: table does not exist");
      if (changeFlaky.includes(nth)) {
        const seen = (flakySeen.get(nth) ?? 0) + 1;
        flakySeen.set(nth, seen);
        if (seen < 3) throw new Error("indexer PerpPositionChanges failed: database query error");
      }
      return fills.map((f) => {
        const sizeBefore = position;
        position += BigInt(f.quantity);
        return { sizeBefore, sizeAfter: position, entryPriceBefore: sizeBefore === 0n ? null : 100n * E18, closedSize: 0n, exitPrice: null, realizedPnl: 0n, kind: "Increase" };
      });
    },
    listPerpFees: async () => feeRows,
  } as unknown as SomniaMarketsClient;
  return { client, calls, countCalls };
}

test("reconcile keeps position-change reads under the SDK's 1000-fill cap", async () => {
  const { client, calls } = fakeClient(1_200);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(report.fills, 1_200);
  assert.deepEqual(calls, [250, 250, 250, 250, 200]);
  assert.ok(calls.every((n) => n <= 1_000), "no read may exceed the cap the SDK enforces");
  assert.equal(report.unmatched, 0);
  assert.equal(report.changesUnread.fills, 0);
  assert.equal(report.mismatches, 0);
  assert.equal(report.ok, true);
});

test("a refused position-change read degrades the report instead of aborting it", async () => {
  const { client, calls } = fakeClient(1_200, 500, [], 1_200, [1]);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.deepEqual(calls, [250, 250, 250, 250, 200], "the failed chunk keeps its place, so every later chunk still reads its own fills");
  assert.equal(report.changesUnread.fills, 250);
  assert.match(report.changesUnread.reason!, /table does not exist/);
  // The 250 unread fills are unmatched, and the other 950 are still checked and still agree.
  assert.equal(report.unmatched, 250);
  assert.equal(report.mismatches, 0, "a chunk that never answered must not corrupt the neighbours it is aligned against");
  assert.equal(report.ok, false, "an incomplete ground-truth leg cannot be reported as a pass");
  assert.match(
    report.warnings.find((w) => w.includes("could not be paired")) ?? "",
    /250 fill\(s\) could not be paired[\s\S]*checked 950 of 1200 fills[\s\S]*not a complete ground-truth check/,
  );
  assert.ok(!report.warnings.some((w) => /250 fills have no indexed position update/.test(w)), "the read failure is not also blamed on the indexer");
  assert.equal(report.warnings.filter((w) => /fills have no indexed position update/.test(w)).length, 0);
});

test("a transient position-change failure is eaten by the retry and leaves no shortfall", async () => {
  const { client } = fakeClient(300, 500, [], 300, [], [0]);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(report.changesUnread.fills, 0, "`database query error` is retryable, and the retry is what this call site is for");
  assert.equal(report.unmatched, 0);
  assert.equal(report.ok, true);
});

test("a small account is one position-change read, not five", async () => {
  const { client, calls } = fakeClient(7);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(report.fills, 7);
  assert.deepEqual(calls, [7]);
  assert.equal(report.ok, true);
});

test("a read that covered its window is complete, and costs no count scan", async () => {
  const { client, countCalls } = fakeClient(1_200);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.deepEqual(report.coverage, {
    firstFillSec: 1_000, lastFillSec: 2_199, rowsScanned: 1_200, rowsInWindow: 1_200, rowsKept: 1_200,
    pages: 3, truncated: false, stoppedBy: null, accountFillsInWindow: null, accountFillsAtCeiling: false,
  });
  assert.equal(fillCoverageStamp(report.coverage).tone, "complete");
  assert.equal(countCalls.length, 0, "a complete read should not pay for the indexer's 10,001-row count scan");
});

test("the fill cap is reported as truncation, with the population the indexer counts", async () => {
  const { client, countCalls } = fakeClient(1_200, 500, [], 1_200);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000, maxFills: 500 });
  assert.equal(report.fills, 500);
  assert.equal(report.coverage.truncated, true);
  assert.equal(report.coverage.stoppedBy, "maxFills");
  assert.equal(report.coverage.rowsKept, 500);
  assert.equal(report.coverage.rowsScanned, 500);
  assert.equal(report.coverage.accountFillsInWindow, 1_200);
  // The count is scoped the way the page read is, so "500 of 1,200" compares like with like.
  assert.deepEqual(countCalls, [[WHO.toLowerCase(), { pool: POOL, since: 0, until: 10_000 }]]);
  const stamp = fillCoverageStamp(report.coverage);
  assert.equal(stamp.tone, "partial");
  assert.match(stamp.text, /Booked 500 of 1,200 fills the indexer counts here across 1 page/);
  assert.match(stamp.text, /the fill cap bound the read/);
  // The span named is the booked sub-window, not the requested one.
  const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ");
  assert.match(stamp.text, new RegExp(`run ${iso(1_000)} → ${iso(1_499)} UTC — a sub-window`));
});

test("a page bound derived from the cap stops the read and says which bound fired", async () => {
  const oneRow = fakeClient(1_000, 1);
  const report = await reconcileAccount({ client: oneRow.client, cfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(report.coverage.stoppedBy, "page-bound");
  assert.equal(report.coverage.pages, 40);
  assert.equal(report.coverage.truncated, true);
  assert.match(fillCoverageStamp(report.coverage).text, /the read stopped at its 40-page bound/);

  // The bound exists to keep the caller's cap binding, so asking for more fills must allow more pages.
  const wider = fakeClient(1_000, 1);
  const big = await reconcileAccount({ client: wider.client, cfg, account: WHO, fromSec: 0, toSec: 10_000, maxFills: 20_000 });
  assert.equal(big.coverage.pages, 60, "the page bound did not scale with maxFills");
  assert.equal(big.coverage.stoppedBy, "page-bound");
});

test("a count at the indexer ceiling is labelled a lower bound, not a total", async () => {
  const { client } = fakeClient(2_000, 500, [], 10_000);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000, maxFills: 500 });
  assert.equal(report.coverage.accountFillsAtCeiling, true);
  assert.match(fillCoverageStamp(report.coverage).text, /Booked 500 of at least 10,000 fills/);
  assert.ok(
    report.warnings.some((w) => /hard ceiling of 10000/.test(w) && /lower bound/.test(w) && /bot-driven/.test(w)),
    `no bot-account note beside the lower bound: ${report.warnings.join(" | ")}`,
  );
});

test("a failing count read degrades the wording, never the reconcile", async () => {
  const { client } = fakeClient(1_200, 500, [], null);
  const report = await reconcileAccount({ client, cfg, account: WHO, fromSec: 0, toSec: 10_000, maxFills: 500 });
  assert.equal(report.coverage.accountFillsInWindow, null);
  assert.equal(report.coverage.accountFillsAtCeiling, false);
  assert.equal(report.coverage.truncated, true, "truncation is still known from the read itself");
  assert.equal(report.ok, true, "the advisory count is not allowed to fail the report");
  assert.match(fillCoverageStamp(report.coverage).text, /500 of 500 fills the read itself returned/);
});

/** The same market with the fee rates a fee-charging venue would report. */
const feeCfg: MarketConfig = { ...cfg, takerFeeBpsTimes1k: 500n, makerFeeBpsTimes1k: 100n };
/** What the reconciler should recompute for one of the fixture's taker fills. */
const perFillFee = (i: number) => fillFee(feeCfg, "taker", (qty(i) * (100n * E18)) / feeCfg.oneBase);

const feeRow = (i: number, amount: bigint, kind = "Fee") => ({
  id: `fee${i}`, account: WHO, pool: POOL, amount: amount.toString(), isRebate: false, kind,
  insurancePortion: null, tier: null, fillNotional: null, builder: null,
  timestamp: String(1_000 + i), txHash: "0xtx",
});

test("a non-zero fee rate makes the fill-fee leg able to fail, and a wrong record fails it", async () => {
  const honest = Array.from({ length: 6 }, (_, i) => feeRow(i, perFillFee(i)));
  const clean = await reconcileAccount({ client: fakeClient(6, 500, honest).client, cfg: feeCfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(clean.fees.leg, "informative");
  assert.equal(clean.fees.rows, 6);
  assert.equal(clean.fees.actual, Array.from({ length: 6 }, (_, i) => perFillFee(i)).reduce((s, f) => s + f, 0n));
  assert.equal(clean.fees.diff, 0n);
  assert.equal(clean.ok, true);

  const doubled = honest.map((row, i) => (i === 3 ? feeRow(i, perFillFee(i) * 2n) : row));
  const wrong = await reconcileAccount({ client: fakeClient(6, 500, doubled).client, cfg: feeCfg, account: WHO, fromSec: 0, toSec: 10_000 });
  assert.equal(wrong.ok, false, "the report accepted a fee record at twice the recomputed fee");
  assert.equal(wrong.fees.diff, perFillFee(3));
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
