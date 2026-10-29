import type { Candle, FillRow, FundingRateUpdate, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { retryRead } from "../retry.js";

/** A windowed read plus the truth about whether it got the whole window. */
export type Window<T> = {
  rows: T[];
  /** False when the page budget ran out before the window did — never render this as full history. */
  complete: boolean;
  pages: number;
  /** True when the read stopped on its row budget rather than on the end of the window. */
  truncated?: boolean;
};

/** How much of a window a read may spend. Every HTTP round trip here is a full page. */
export type PageBudget = { pageSize: number; maxPages: number };

const SETTLEMENTS: PageBudget = { pageSize: 500, maxPages: 400 };
const CANDLES: PageBudget = { pageSize: 500, maxPages: 400 };
const FILLS: PageBudget = { pageSize: 1000, maxPages: 400 };

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
  budget: PageBudget = SETTLEMENTS,
): Promise<Window<FundingRateUpdate>> {
  const pages: FundingRateUpdate[][] = [];
  const seen = new Set<string>();
  let cursor = from;
  let pagesRead = 0;
  let complete = false;
  for (;;) {
    const page = await retryRead(`listFundingRateHistory ${pool.slice(0, 10)}`, () =>
      client.listFundingRateHistory(pool, { from: cursor, to, order: "asc", limit: budget.pageSize }),
    );
    pagesRead += 1;
    pages.push(page);
    if (page.length < budget.pageSize) {
      complete = true;
      break;
    }
    const last = Number(page[page.length - 1].timestamp);
    if (pagesRead >= budget.maxPages || last + 1 > to) break;
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
  budget: PageBudget = CANDLES,
): Promise<Window<Candle>> {
  const pages: Candle[][] = [];
  let upper = to;
  let pagesRead = 0;
  let complete = false;
  for (;;) {
    const page = await retryRead(`getCandles ${pool.slice(0, 10)}`, () =>
      client.getCandles(pool, intervalSeconds, { from, to: upper, limit: budget.pageSize, market: pool }),
    );
    pagesRead += 1;
    pages.unshift(page);
    if (page.length < budget.pageSize) {
      complete = true;
      break;
    }
    const oldest = Number(page[0].bucketStart);
    if (pagesRead >= budget.maxPages || oldest - 1 < from) break;
    upper = oldest - 1;
  }
  const byBucket = new Map<string, Candle>();
  for (const row of pages.flat()) byBucket.set(row.bucketStart, row);
  const rows = [...byBucket.values()].sort(
    (a, b) => Number(a.bucketStart) - Number(b.bucketStart),
  );
  return { rows, complete, pages: pagesRead };
}

/**
 *  The pool's trade tape over an inclusive block range, oldest-first.
 *
 *  Paged by offset rather than by cursor: the range is immutable once its head block is
 *  pinned to a settled settlement, so an offset is stable, and `getFillsPage` cannot be
 *  scoped to one pool. `getFills` serves each page newest-first, so the page order is not
 *  the tape order and the rows are sorted on `(blockNumber, logIndex)` afterwards — the
 *  chain's own total order over fills.
 */
export async function fillWindow(
  client: SomniaMarketsClient,
  pool: string,
  fromBlock: number,
  toBlock: number,
  budget: PageBudget = FILLS,
): Promise<Window<FillRow>> {
  const seen = new Set<string>();
  const rows: FillRow[] = [];
  let offset = 0;
  let pages = 0;
  let complete = false;
  let truncated = false;
  for (;;) {
    const page = await retryRead(`getFills ${pool.slice(0, 10)}`, () =>
      client.getFills(pool, { sinceBlock: fromBlock, toBlock, limit: budget.pageSize, offset }),
    );
    pages += 1;
    for (const row of page) {
      if (row.blockNumber === undefined || row.logIndex === undefined) {
        throw new Error("fill row without a block position; refusing to order the tape on partial data");
      }
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (page.length < budget.pageSize) {
      complete = true;
      break;
    }
    if (pages >= budget.maxPages) {
      truncated = true;
      break;
    }
    offset += page.length;
  }
  rows.sort(compareFills);
  return { rows, complete, pages, truncated };
}

/** `(blockNumber, logIndex)` — the order the chain emitted the fills in. */
export function compareFills(a: FillRow, b: FillRow): number {
  return Number(BigInt(a.blockNumber ?? 0) - BigInt(b.blockNumber ?? 0)) || (a.logIndex ?? 0) - (b.logIndex ?? 0);
}
