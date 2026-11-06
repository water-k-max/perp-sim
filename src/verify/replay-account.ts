import type { FillRow, PerpFeeRecord, PerpPositionChange, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { fillFee, PositionBook } from "../engine/portfolio.js";
import { feeBps, type MarketConfig } from "../history/market.js";
import { retryRead } from "../retry.js";

/**
 *  Ground truth for the accounting: take a real account's fills, push them through the same
 *  `PositionBook` the backtest uses, and diff the result against what the chain recorded in
 *  `PerpPositionChange`.
 *
 *  This is the check that separates a plausible simulator from a correct one. It touches
 *  nothing but public indexer reads: no signer, no chain write, no private state.
 */
export type ReconcileOptions = {
  client: SomniaMarketsClient;
  /** The pool's config. Only decimals, the pool address and the fee rate are used. */
  cfg: MarketConfig;
  account: string;
  fromSec: number;
  toSec: number;
  /** Hard cap on fills read, so a busy account cannot make this unbounded. Defaults to 2,000. */
  maxFills?: number;
};

export type RowReconcile = {
  fillId: string;
  txHash: string;
  t: number;
  kind: string | null;
  expected: {
    sizeAfter: bigint | null;
    closedSize: bigint | null;
    exitPrice: bigint | null;
    realizedPnl: bigint | null;
  };
  actual: { sizeAfter: bigint; closedSize: bigint; exitPrice: bigint | null; realizedPnl: bigint };
  diffs: string[];
};

export type ReconcileReport = {
  account: string;
  pool: string;
  market: string;
  fromSec: number;
  toSec: number;
  fills: number;
  changes: number;
  /** Fills the indexer has no position update for; they cannot be checked against ground truth. */
  unmatched: number;
  rows: RowReconcile[];
  mismatches: number;
  fees: { expected: bigint; actual: bigint; diff: bigint; rows: number };
  ok: boolean;
  warnings: string[];
};

/** One literal raw unit of tolerance, for entry-price averaging on a partial close. */
const PNL_TOLERANCE = 1n;

export async function reconcileAccount(options: ReconcileOptions): Promise<ReconcileReport> {
  const { client, cfg, account, fromSec, toSec } = options;
  const maxFills = options.maxFills ?? 2_000;
  const warnings: string[] = [];
  const who = account.toLowerCase();
  const pool = cfg.pool.toLowerCase();

  const fills = await readAccountFills(client, who, pool, fromSec, toSec, maxFills, warnings);
  // The SDK caps one position-change read at 1,000 fills; chunk to stay under it, keeping
  // the one-to-one order so changes[i] still lines up with fills[i].
  const changes: (PerpPositionChange | null)[] = [];
  for (let at = 0; at < fills.length; at += 1_000) {
    const part = await retryRead(`listPerpPositionChangesForFills ${at}`, () =>
      client.listPerpPositionChangesForFills(who, fills.slice(at, at + 1_000)),
    );
    changes.push(...part);
  }

  const feeRows = await retryRead("listPerpFees", () =>
    client.listPerpFees({ account: who, pool, limit: 1_000 }),
  );
  const feesInWindow = feeRows.filter((f) => Number(f.timestamp) >= fromSec && Number(f.timestamp) <= toSec);

  const book = new PositionBook(cfg, 0n);
  const rows: RowReconcile[] = [];
  let mismatches = 0;
  let unmatched = 0;
  let seeded = false;

  for (let i = 0; i < fills.length; i += 1) {
    const fill = fills[i]!;
    const change = changes[i] ?? null;
    if (!change || fill.takerIsBid === null) {
      // Without an indexed update, or without the aggressor side the indexer sometimes has
      // not bridged yet, the fill cannot be checked against ground truth or even sided.
      unmatched += 1;
      continue;
    }
    if (!seeded) {
      // Start from the position the account held when the first update landed, so a close
      // realizes against the entry the chain used rather than a fresh one.
      if (change.sizeBefore !== 0n && change.entryPriceBefore !== null) {
        book.lots.push({ price: change.entryPriceBefore, size: change.sizeBefore, entryFundingIndex: 0n });
      }
      seeded = true;
    }

    const size = BigInt(fill.quantity);
    const price = BigInt(fill.fillPrice);
    const side = accountSide(fill, who);
    const t = Number(fill.timestamp);
    const exec = book.execute(side, size, {
      t,
      price,
      role: isTaker(fill, who) ? "taker" : "maker",
      cum: 0n,
      fillId: fill.id,
    });
    const closedSize = exec.closed.reduce((sum, trade) => sum + trade.size, 0n);
    const realized = exec.closed.reduce((sum, trade) => sum + trade.grossPnl, 0n);

    const diffs: string[] = [];
    if (book.size !== change.sizeAfter) diffs.push(`sizeAfter ${book.size} != ${change.sizeAfter}`);
    if (closedSize !== change.closedSize) diffs.push(`closedSize ${closedSize} != ${change.closedSize}`);
    if (change.exitPrice !== null && change.exitPrice !== price) diffs.push(`exitPrice ${price} != ${change.exitPrice}`);
    if (abs(realized - change.realizedPnl) > PNL_TOLERANCE) diffs.push(`realizedPnl ${realized} != ${change.realizedPnl}`);
    if (diffs.length > 0) mismatches += 1;

    rows.push({
      fillId: fill.id,
      txHash: fill.txHash,
      t,
      kind: change.kind,
      expected: {
        sizeAfter: change.sizeAfter,
        closedSize: change.closedSize,
        exitPrice: change.exitPrice,
        realizedPnl: change.realizedPnl,
      },
      actual: { sizeAfter: book.size, closedSize, exitPrice: closedSize === 0n ? null : price, realizedPnl: realized },
      diffs,
    });
  }

  const expectedFees = fills.reduce((sum, fill) => {
    const role = isTaker(fill, who) ? "taker" : "maker";
    return sum + fillFee(cfg, role, (BigInt(fill.quantity) * BigInt(fill.fillPrice)) / cfg.oneBase);
  }, 0n);
  const actualFees = feesInWindow.reduce((sum, fee) => sum + signedFee(fee), 0n);

  if (!seeded && fills.length > 0) warnings.push("no position update was returned for any fill; nothing could be seeded");
  if (unmatched > 0) warnings.push(`${unmatched} fills have no indexed position update and were skipped`);
  if (book.lots.length > 0) {
    warnings.push(`${book.lots.length} lot(s) still open at the end of the window; open positions have no realized check`);
  }
  if (actualFees !== expectedFees) {
    warnings.push(
      `fee records total ${actualFees} against ${expectedFees} recomputed at the live ${feeBps(cfg, "taker")} bpsx1k taker rate; a rate change or a maker fill explains the difference`,
    );
  }

  return {
    account: who,
    pool,
    market: cfg.symbol,
    fromSec,
    toSec,
    fills: fills.length,
    changes: changes.filter((c) => c !== null).length,
    unmatched,
    rows,
    mismatches,
    fees: { expected: expectedFees, actual: actualFees, diff: actualFees - expectedFees, rows: feesInWindow.length },
    ok: mismatches === 0 && unmatched === 0 && actualFees === expectedFees,
    warnings,
  };
}

/** Page the account's fills newest-first, keep the window and the pool, return oldest-first. */
async function readAccountFills(
  client: SomniaMarketsClient,
  account: string,
  pool: string,
  fromSec: number,
  toSec: number,
  maxFills: number,
  warnings: string[],
): Promise<FillRow[]> {
  const rows: FillRow[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await retryRead(`getUserFillsPage ${account.slice(0, 10)}`, () =>
      client.getUserFillsPage(account, { marketType: "PERP", pool, since: fromSec, until: toSec, limit: 500, cursor }),
    );
    pages += 1;
    for (const fill of page.fills) {
      if (fill.pool?.toLowerCase() !== pool) continue;
      const t = Number(fill.timestamp);
      if (t < fromSec || t > toSec) continue;
      rows.push(fill);
    }
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
    if (rows.length >= maxFills) {
      warnings.push(`stopped at the ${maxFills}-fill cap; older fills in the window were not read`);
      break;
    }
    if (pages > 40) {
      warnings.push("stopped after 40 pages; the window is larger than this read will cover");
      break;
    }
  }
  rows.sort((a, b) => {
    const ab = Number(a.blockNumber ?? 0) - Number(b.blockNumber ?? 0);
    return ab !== 0 ? ab : (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
  return rows.slice(0, maxFills);
}

/**
 *  Whether the account was the aggressor. `taker` is null until the indexer bridges the
 *  taker's `OrderPlaced`, so a null taker on one of this account's own fills means it made.
 */
function isTaker(fill: FillRow, account: string): boolean {
  return fill.taker?.toLowerCase() === account;
}

/** The account's own side on a fill: the taker's when it took, the mirror when it made. */
function accountSide(fill: FillRow, account: string): "buy" | "sell" {
  const takerBought = fill.takerIsBid === true;
  const accountBought = isTaker(fill, account) ? takerBought : !takerBought;
  return accountBought ? "buy" : "sell";
}

/** A fee row signed as a cost: `Fee` debits, `Rebate` credits. */
function signedFee(fee: PerpFeeRecord): bigint {
  const amount = BigInt(fee.amount);
  return fee.isRebate ? -amount : amount;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
