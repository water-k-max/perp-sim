import type { Candle, FundingRateUpdate, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { retryRead } from "../retry.js";

/** A windowed read plus the truth about whether it got the whole window. */
export type Window<T> = {
  rows: T[];
  /** False when the page budget ran out before the window did — never render this as full history. */
  complete: boolean;
  pages: number;
};

const PAGE = 500;
const MAX_PAGES = 400;

/**
 *  Funding settlements over `[from, to]`, oldest-first.
 *
 *  Paged forward with an `order: "asc"` cursor, because the default ordering is
 *  newest-first: asking for a month under that order returns the newest 500 rows and
 *  looks like a complete answer.
 */
export async function fundingWindow(
  client: SomniaMarketsClient,
  pool: string,
  from: number,
  to: number,
): Promise<Window<FundingRateUpdate>> {
  const pages: FundingRateUpdate[][] = [];
  const seen = new Set<string>();
  let cursor = from;
  let pagesRead = 0;
  let complete = false;
  for (;;) {
    const page = await retryRead(`listFundingRateHistory ${pool.slice(0, 10)}`, () =>
      client.listFundingRateHistory(pool, { from: cursor, to, order: "asc", limit: PAGE }),
    );
    pagesRead += 1;
    pages.push(page);
    if (page.length < PAGE) {
      complete = true;
      break;
    }
    const last = Number(page[page.length - 1].timestamp);
    if (pagesRead >= MAX_PAGES || last + 1 > to) break;
    cursor = last + 1;
  }
  const rows: FundingRateUpdate[] = [];
  for (const row of pages.flat()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  rows.sort(compareSettlements);
  return { rows, complete, pages: pagesRead };
}

/** The SDK's documented total order: timestamp, then block, then id. */
function compareSettlements(a: FundingRateUpdate, b: FundingRateUpdate): number {
  return (
    Number(a.timestamp) - Number(b.timestamp) ||
    Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 *  OHLCV buckets over `[from, to]`, oldest-first, one row per bucket.
 *
 *  Paged backwards from `to`: `getCandles` sorts oldest-first but applies its `limit`
 *  to the newest rows in range, so the rows that fall off are always the old ones.
 */
export async function candleWindow(
  client: SomniaMarketsClient,
  pool: string,
  intervalSeconds: number,
  from: number,
  to: number,
): Promise<Window<Candle>> {
  const pages: Candle[][] = [];
  let upper = to;
  let pagesRead = 0;
  let complete = false;
  for (;;) {
    const page = await retryRead(`getCandles ${pool.slice(0, 10)}`, () =>
      client.getCandles(pool, intervalSeconds, { from, to: upper, limit: PAGE, market: pool }),
    );
    pagesRead += 1;
    pages.unshift(page);
    if (page.length < PAGE) {
      complete = true;
      break;
    }
    const oldest = Number(page[0].bucketStart);
    if (pagesRead >= MAX_PAGES || oldest - 1 < from) break;
    upper = oldest - 1;
  }
  const byBucket = new Map<string, Candle>();
  for (const row of pages.flat()) byBucket.set(row.bucketStart, row);
  const rows = [...byBucket.values()].sort(
    (a, b) => Number(a.bucketStart) - Number(b.bucketStart),
  );
  return { rows, complete, pages: pagesRead };
}
