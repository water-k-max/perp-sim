import assert from "node:assert/strict";
import { test } from "node:test";
import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { reconcileAccount } from "./replay-account.js";
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
function fakeClient(count: number, pageSize = 500) {
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
    listPerpFees: async () => [],
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
