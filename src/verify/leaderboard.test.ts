import assert from "node:assert/strict";
import { test } from "node:test";
import type { FundingPayment, PerpFeeRecord, PerpPositionChange, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { aggregateClosing, discoverClosing, netAccount, netLegs, rankLeaderboard, type GrossByAccount } from "./leaderboard.js";

/**
 *  The leaderboard is tested as the pure netting and ranking it is: fixture legs in, net out, no
 *  chain read. The orchestration (`buildLeaderboard`) only discovers closing updates and fetches the
 *  funding/fee legs, then hands them here, so every sign, rail split, window filter and ranking rule
 *  is exercised offline. The canary that matters: net must differ from gross once funding is non-zero.
 */

const change = (over: { id?: string; account?: string; pool?: string; t?: number; pnl?: bigint } = {}): PerpPositionChange => ({
  id: over.id ?? `c${over.t ?? 0}_${over.account ?? "0xabc"}`,
  chainId: 50383,
  pool: over.pool ?? "0xpool",
  account: over.account ?? "0xabc",
  kind: "CLOSE",
  sizeBefore: 1n,
  sizeAfter: 0n,
  closedSize: 1n,
  entryPriceBefore: 1n,
  entryPriceAfter: 0n,
  exitPrice: 1n,
  orderId: 1n,
  realizedPnl: over.pnl ?? 0n,
  timestamp: BigInt(over.t ?? 0),
  blockNumber: 0n,
  logIndex: 0,
  txHash: "0x",
});

const funding = (amount: bigint, t: number, over: Partial<FundingPayment> = {}): FundingPayment => ({
  id: `fp${t}_${amount}`,
  chainId: 50383,
  account: "0xabc",
  pool: "0xpool",
  amount: amount.toString(),
  timestamp: t.toString(),
  txHash: "0x",
  ...over,
});

const fee = (kind: string, amount: bigint, t: number, isRebate = false): PerpFeeRecord => ({
  id: `fee${t}_${kind}`,
  account: "0xabc",
  pool: "0xpool",
  amount: amount.toString(),
  isRebate,
  kind,
  insurancePortion: null,
  tier: null,
  fillNotional: null,
  builder: null,
  timestamp: t.toString(),
  txHash: "0x",
});

const gross = (over: Partial<GrossByAccount> = {}): GrossByAccount => ({
  account: "0xabc", gross: 0n, closes: 0, pools: new Set<string>(), ...over,
});

const FROM = 100;
const TO = 200;

test("aggregateClosing sums realized PnL per account and counts closes and distinct pools", () => {
  const map = aggregateClosing([
    change({ account: "0xAAA", pool: "0xP1", t: 110, pnl: 5n }),
    change({ account: "0xAAA", pool: "0xP2", t: 120, pnl: -2n }),
    change({ account: "0xBBB", pool: "0xP1", t: 130, pnl: 7n }),
  ], FROM, TO);
  assert.equal(map.size, 2);
  const a = map.get("0xaaa")!;
  assert.equal(a.gross, 3n);
  assert.equal(a.closes, 2);
  assert.equal(a.pools.size, 2, "two distinct pools count as two markets");
  assert.equal(map.get("0xbbb")!.gross, 7n);
});

test("aggregateClosing lowercases the account and applies the half-open window [from, to)", () => {
  const map = aggregateClosing([
    change({ account: "0xABC", t: FROM, pnl: 1n }),      // inclusive lower bound: kept
    change({ account: "0xABC", t: TO - 1, pnl: 2n }),   // kept
    change({ account: "0xABC", t: TO, pnl: 4n }),       // exclusive upper bound: dropped
    change({ account: "0xABC", t: FROM - 1, pnl: 8n }), // before window: dropped
  ], FROM, TO);
  assert.equal(map.get("0xabc")!.gross, 3n);
  assert.equal(map.get("0xabc")!.closes, 2);
});

test("netLegs signs funding as paid (positive) and received (negative) and filters the window", () => {
  const legs = netLegs([
    funding(30n, 110),   // paid
    funding(-10n, 120),  // received
    funding(99n, TO),    // outside window: dropped
    funding(99n, FROM - 1),
  ], [], FROM, TO);
  assert.equal(legs.fundingPaid, 20n);
  assert.equal(legs.fundingRows, 2);
});

test("netLegs splits fee rails: trade signed as cost, rebate as credit, liquidation separate, unknown collected", () => {
  const legs = netLegs([], [
    fee("Fee", 5n, 110),
    fee("Rebate", 2n, 111, true),
    fee("BuilderFee", 1n, 112),
    fee("LiquidationFee", 40n, 113),
    fee("LiquidationFeeSkipped", 9n, 114),
    fee("MysteryKind", 3n, 115),
  ], FROM, TO);
  assert.equal(legs.tradeFees, 4n, "5 - 2 + 1 = 4 net trade cost");
  assert.equal(legs.tradeRows, 3);
  assert.equal(legs.liquidationFees, 49n, "liquidation rail summed separately, not netted");
  assert.equal(legs.liquidationRows, 2);
  assert.equal(legs.unknownRows, 1);
  assert.deepEqual(legs.unknownKinds, ["MysteryKind"]);
  assert.equal(legs.unknownTotal, 3n);
});

test("CANARY: net differs from gross once funding is non-zero — paid funding reduces net", () => {
  const g = gross({ gross: 1000n, closes: 1, pools: new Set(["0xP1"]) });
  const legs = netLegs([funding(250n, 110)], [], FROM, TO);
  const n = netAccount({ gross: g, legs, fundingTruncated: false, feesTruncated: false });
  assert.equal(n.net, 750n);
  assert.notEqual(n.net, n.gross, "netting must actually subtract funding; a gross-only board fails this");
  assert.ok(n.net < n.gross);
  assert.equal(n.ok, true);
});

test("CANARY: received funding (negative amount) increases net above gross", () => {
  const g = gross({ gross: 1000n });
  const legs = netLegs([funding(-300n, 110)], [], FROM, TO);
  const n = netAccount({ gross: g, legs, fundingTruncated: false, feesTruncated: false });
  assert.equal(n.net, 1300n);
  assert.ok(n.net > n.gross, "a funding credit must raise net, not lower it");
});

test("net subtracts trade fees but never the liquidation rail", () => {
  const g = gross({ gross: 1000n });
  const legs = netLegs([funding(100n, 110)], [fee("Fee", 20n, 111), fee("LiquidationFee", 500n, 112)], FROM, TO);
  const n = netAccount({ gross: g, legs, fundingTruncated: false, feesTruncated: false });
  assert.equal(n.net, 880n, "1000 - 100 funding - 20 trade fee; the 500 liquidation penalty is not deducted");
  assert.equal(n.legs.liquidationFees, 500n);
  assert.ok(n.ok, "a known liquidation rail does not fail the row closed");
});

test("net equals gross only when both legs are zero", () => {
  const g = gross({ gross: 42n });
  const n = netAccount({ gross: g, legs: netLegs([], [], FROM, TO), fundingTruncated: false, feesTruncated: false });
  assert.equal(n.net, 42n);
  assert.equal(n.net, n.gross);
});

test("an unknown fee kind or a truncated leg fails the row closed", () => {
  const g = gross({ gross: 100n });
  const unknown = netAccount({ gross: g, legs: netLegs([], [fee("Weird", 1n, 110)], FROM, TO), fundingTruncated: false, feesTruncated: false });
  assert.equal(unknown.ok, false);
  const truncFunding = netAccount({ gross: g, legs: netLegs([], [], FROM, TO), fundingTruncated: true, feesTruncated: false });
  assert.equal(truncFunding.ok, false);
  const truncFees = netAccount({ gross: g, legs: netLegs([], [], FROM, TO), fundingTruncated: false, feesTruncated: true });
  assert.equal(truncFees.ok, false);
});

test("rankLeaderboard orders by NET, not gross: funding can flip the order", () => {
  // A has the higher gross but pays heavy funding; B keeps more net. A gross-only board would rank A first.
  const a = netAccount({ gross: gross({ account: "0xaaa", gross: 100_000000n }), legs: netLegs([funding(90_000000n, 110)], [], FROM, TO), fundingTruncated: false, feesTruncated: false });
  const b = netAccount({ gross: gross({ account: "0xbbb", gross: 50_000000n }), legs: netLegs([], [], FROM, TO), fundingTruncated: false, feesTruncated: false });
  const rows = rankLeaderboard([a, b], 6);
  assert.deepEqual(rows.map((r) => r.account), ["0xbbb", "0xaaa"]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
  assert.equal(rows[0]!.net, "50.000000");
  assert.equal(rows[1]!.net, "10.000000");
  assert.equal(rows[1]!.gross, "100.000000");
  assert.equal(rows[1]!.fundingPaid, "90.000000");
});

test("rankLeaderboard tie-breaks by gross then address, deterministically", () => {
  const mk = (account: string, g: bigint) => netAccount({ gross: gross({ account, gross: g }), legs: netLegs([], [], FROM, TO), fundingTruncated: false, feesTruncated: false });
  const rows = rankLeaderboard([mk("0xbbb", 10n), mk("0xaaa", 10n), mk("0xccc", 20n)], 6);
  assert.deepEqual(rows.map((r) => r.account), ["0xccc", "0xaaa", "0xbbb"]);
  // Same input in a different order yields the same board.
  const again = rankLeaderboard([mk("0xccc", 20n), mk("0xbbb", 10n), mk("0xaaa", 10n)], 6);
  assert.deepEqual(again.map((r) => r.account), rows.map((r) => r.account));
});

test("rankLeaderboard formats negative and fractional net exactly", () => {
  const n = netAccount({ gross: gross({ account: "0xabc", gross: -1_500000n }), legs: netLegs([funding(250000n, 110)], [], FROM, TO), fundingTruncated: false, feesTruncated: false });
  const rows = rankLeaderboard([n], 6);
  assert.equal(rows[0]!.net, "-1.750000");
  assert.equal(rows[0]!.gross, "-1.500000");
  assert.equal(rows[0]!.fundingPaid, "0.250000");
});

test("per-row warnings name the truncation, the unknown kind and the separate liquidation rail", () => {
  const n = netAccount({
    gross: gross({ account: "0xabc", gross: 100n }),
    legs: netLegs([funding(1n, 110)], [fee("LiquidationFee", 5n, 111), fee("Weird", 1n, 112)], FROM, TO),
    fundingTruncated: true, feesTruncated: false,
  });
  const w = rankLeaderboard([n], 6)[0]!.warnings;
  assert.ok(w.some((x) => x.includes("funding read hit its page cap")));
  assert.ok(w.some((x) => x.includes("unrecognised kind") && x.includes("Weird")));
  assert.ok(w.some((x) => x.includes("liquidation-rail") && x.includes("not deducted")));
});

/**
 *  Discovery pagination, exercised against a faithful mock indexer rather than a chain read. The mock
 *  honours the query contract (inclusive `from`, exclusive `to`, kinds filter, asc/desc sort, limit)
 *  and reproduces the measured refusal: venue-wide `asc` + closing kinds answers `database query error`
 *  (Hideki 2026-11-13, `probe/leaderboard-order.mts`, asc 0/3 vs desc 3/3 on a warm client). So an
 *  implementation that reverts to `asc` cannot pass — `retryRead` exhausts and the walk throws. The
 *  canary that matters: the backward cursor must re-include the boundary second (`to = oldest + 1`),
 *  or rows sharing a page-boundary timestamp are silently dropped and the board understates gross.
 */
type ChangeQuery = { account?: string; kinds?: readonly string[]; from?: number; to?: number; order?: "asc" | "desc"; limit?: number; offset?: number };

function mockIndexer(rows: readonly PerpPositionChange[]): { client: SomniaMarketsClient; orders: string[] } {
  const orders: string[] = [];
  const client = {
    listPerpPositionChanges(q: ChangeQuery): Promise<PerpPositionChange[]> {
      const order = q.order ?? "asc";
      orders.push(order);
      if (order === "asc" && !q.account && q.kinds) {
        return Promise.reject(new Error("indexer PerpPositionChanges failed: database query error"));
      }
      const dir = order === "desc" ? -1 : 1;
      const out = rows
        .filter((r) => {
          const t = Number(r.timestamp);
          if (q.from !== undefined && t < q.from) return false;
          if (q.to !== undefined && t >= q.to) return false;
          if (q.account && r.account.toLowerCase() !== q.account.toLowerCase()) return false;
          if (q.kinds && !q.kinds.includes(r.kind)) return false;
          return true;
        })
        .sort((a, b) => {
          const ta = Number(a.timestamp);
          const tb = Number(b.timestamp);
          if (ta !== tb) return (ta - tb) * dir;
          return a.id < b.id ? -dir : a.id > b.id ? dir : 0;
        });
      const offset = q.offset ?? 0;
      return Promise.resolve(out.slice(offset, offset + (q.limit ?? out.length)));
    },
  };
  return { client: client as unknown as SomniaMarketsClient, orders };
}

test("discoverClosing requests the served desc shape and drains a sub-page window newest-first", async () => {
  const { client, orders } = mockIndexer([
    change({ id: "a", account: "0xAAA", t: 150, pnl: 5n }),
    change({ id: "b", account: "0xAAA", t: 120, pnl: 3n }),
    change({ id: "c", account: "0xBBB", t: 110, pnl: 7n }),
  ]);
  const { byAccount, coverage } = await discoverClosing(client, 100, 200, 40);
  assert.deepEqual(orders, ["desc"], "the indexer refuses asc; discovery must request desc");
  assert.equal(coverage.pages, 1);
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.rowsScanned, 3);
  assert.equal(coverage.rowsInWindow, 3);
  assert.equal(coverage.firstChangeSec, 110);
  assert.equal(coverage.lastChangeSec, 150);
  assert.equal(byAccount.get("0xaaa")!.gross, 8n);
  assert.equal(byAccount.get("0xbbb")!.gross, 7n);
});

test("discoverClosing reports an empty window without truncation", async () => {
  const { client } = mockIndexer([]);
  const { byAccount, coverage } = await discoverClosing(client, 100, 200, 40);
  assert.equal(byAccount.size, 0);
  assert.equal(coverage.pages, 1);
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.rowsInWindow, 0);
  assert.equal(coverage.firstChangeSec, null);
  assert.equal(coverage.lastChangeSec, null);
});

test("CANARY: discoverClosing walks backward across pages and keeps rows sharing the boundary second", async () => {
  // 499 rows at t=502..1000, then 3 rows at t=500, then 10 rows at t=490..499 (512 total).
  // Page 1 (500, desc) ends on the FIRST t=500 row; the other two spill. The cursor must become
  // 500+1 so page 2 re-includes t=500; with to=500 (exclusive) the two spillovers would vanish.
  const rows: PerpPositionChange[] = [];
  for (let t = 502; t <= 1000; t++) rows.push(change({ id: `h${t}`, account: "0xAAA", t, pnl: 1n }));
  for (let i = 0; i < 3; i++) rows.push(change({ id: `edge${i}`, account: "0xAAA", t: 500, pnl: 1n }));
  for (let t = 490; t <= 499; t++) rows.push(change({ id: `l${t}`, account: "0xAAA", t, pnl: 1n }));
  const { client, orders } = mockIndexer(rows);
  const { byAccount, coverage } = await discoverClosing(client, 100, 2000, 40);
  assert.ok(orders.every((o) => o === "desc"), "every page uses the served desc shape");
  assert.equal(byAccount.get("0xaaa")!.gross, 512n, "all 512 rows collected; the two boundary spillovers must survive");
  assert.equal(byAccount.get("0xaaa")!.closes, 512);
  assert.equal(coverage.pages, 2);
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.rowsInWindow, 512);
  assert.equal(coverage.rowsScanned, 513, "page 2 re-reads the one boundary row already seen; dedup drops it");
  assert.equal(coverage.firstChangeSec, 490);
  assert.equal(coverage.lastChangeSec, 1000);
});

test("discoverClosing labels truncation when one timestamp holds more rows than a page", async () => {
  const rows: PerpPositionChange[] = [];
  for (let i = 0; i < 600; i++) rows.push(change({ id: `s${i}`, account: "0xAAA", t: 500, pnl: 1n }));
  const { client } = mockIndexer(rows);
  const { byAccount, coverage } = await discoverClosing(client, 100, 2000, 40);
  assert.equal(coverage.truncated, true);
  assert.equal(coverage.pages, 2, "page 2 re-reads the same 500 ids, adds none, and stops");
  assert.equal(byAccount.get("0xaaa")!.closes, 500);
  assert.equal(coverage.rowsInWindow, 500);
});

test("discoverClosing labels truncation when the page cap binds mid-window", async () => {
  const rows: PerpPositionChange[] = [];
  for (let t = 1000; t < 2500; t++) rows.push(change({ id: `m${t}`, account: "0xAAA", t, pnl: 1n }));
  const { client } = mockIndexer(rows);
  const { coverage } = await discoverClosing(client, 100, 3000, 2);
  assert.equal(coverage.truncated, true);
  assert.equal(coverage.pages, 2);
  assert.equal(coverage.rowsScanned, 1000, "two full pages scanned before the cap stopped the walk");
  assert.equal(coverage.rowsInWindow, 999, "page 2 re-reads the boundary row t=2000; dedup drops it, so 999 unique");
});