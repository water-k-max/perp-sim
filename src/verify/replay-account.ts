import type { FillRow, PerpFeeRecord, PerpPositionChange, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { fillFee, PositionBook } from "../engine/portfolio.js";
import { feeBps, type MarketConfig } from "../history/market.js";
import { retryRead } from "../retry.js";
import type { FillReadCoverage } from "./fill-coverage.js";

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

/**
 *  Which rail a recorded perp fee belongs to.
 *
 *  The chain writes one `PerpFee` row per charge and the kinds do not share a meaning: `Fee`,
 *  `Rebate` and `BuilderFee` are the cost of a fill, while `LiquidationFee` is a penalty on a
 *  forced close routed wholly to an Insurance Fund tier and `LiquidationFeeSkipped` records the
 *  penalty the rate cap waived. Adding the second group to the first would make every liquidated
 *  account read as an accounting failure, so the rails are compared separately and an
 *  unrecognised kind fails the report closed rather than being silently assigned somewhere.
 */
export type FeeRail = "trade" | "liquidation" | "unknown";

const TRADE_KINDS = new Set(["fee", "rebate", "builderfee"]);
const LIQUIDATION_KINDS = new Set(["liquidationfee", "liquidationfeeskipped"]);

export function feeRail(kind: string): FeeRail {
  const key = kind.toLowerCase();
  if (TRADE_KINDS.has(key)) return "trade";
  if (LIQUIDATION_KINDS.has(key)) return "liquidation";
  return "unknown";
}

export type FeeRailTotal = { rows: number; total: bigint };

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
  /**
   *  Fills whose position update this run could not obtain *at all* — the read was refused even
   *  after retries, so no answer came back. These are inside `unmatched` too; the count is broken
   *  out because a shortfall of this kind means the ground-truth leg is incomplete by our side of
   *  the wire, not because the chain failed to record an update, and it must not be read as one.
   */
  changesUnread: { fills: number; reason: string | null };
  coverage: FillReadCoverage;
  rows: RowReconcile[];
  mismatches: number;
  fees: {
    /** Fill fees recomputed from the fills at the market's live rates. */
    expected: bigint;
    /** Recorded trade-rail fees in the window, signed as a cost. */
    actual: bigint;
    diff: bigint;
    /** Trade-rail rows in the window. */
    rows: number;
    /**
     *  Whether `expected === actual` says anything. On a venue whose taker and maker rates are
     *  both zero with no fill-fee rows, both sides are zero by construction and the comparison
     *  cannot fail — `vacuous-zero-rate` is the label that keeps that pass from being read as
     *  verified fee accounting.
     */
    leg: "informative" | "vacuous-zero-rate";
    /** The market's live fee rates, in bps×1000, as the read reported them. */
    rates: { takerBpsTimes1k: bigint; makerBpsTimes1k: bigint };
    /** Liquidation penalties in the window: real, non-zero, and not a fill fee. */
    liquidation: FeeRailTotal;
    /** Rows whose kind belongs to no rail this check knows; their presence makes `ok` false. */
    unknown: FeeRailTotal & { kinds: string[] };
    /** Every kind seen in the window with its row count and signed total — the evidence behind the rails. */
    byKind: { kind: string; rail: FeeRail; rows: number; total: bigint }[];
  };
  ok: boolean;
  warnings: string[];
};

/** One literal raw unit of tolerance, for entry-price averaging on a partial close. */
const PNL_TOLERANCE = 1n;

/**
 *  The ceiling on the indexer's fill count (SDK `indexerRead.d.ts:120` `COUNT_FALLBACK_CAP` —
 *  not re-exported from the package root, so the number is restated rather than imported).
 *  `countUserFills` asks for one row more than this and, past it, hands back this exact number
 *  with the truncation flag dropped, so a count that equals the ceiling means "at least".
 *  Measured on Hideki 2026-11-09 (`probe/count-scope.mts`): `Fill_aggregate` is rejected for the
 *  anonymous role, so the bounded scan is the only path here and every 10,000 is a lower bound,
 *  never an exact total. Reaching it is the signature of a bot-driven account.
 */
const INDEXER_COUNT_CEILING = 10_000;

/**
 *  Fills per position-change read. The SDK's own cap is 1,000, but it does not send one query at
 *  that size: it splits the fills into ten 100-transaction-hash chunks and runs them concurrently
 *  (`perp/history.js:565-569`), so a 1,000-fill call is ten concurrent `PerpPositionChanges`
 *  queries against the indexer at once. Measured on Hideki 2026-11-09, the same read over the same
 *  2,000 fills succeeded on one run and failed with `database query error` on the next, so at the
 *  cap the ground-truth leg of this report depended on how loaded a shared testnet endpoint
 *  happened to be.
 *
 *  A quarter of the cap is what this side of the wire can choose; the retry and `changesUnread`
 *  below cover the part it cannot. The size is not sold as a cure: two passes over the same 1,000
 *  bot-driven fills at 1,000, 250 and then 100 per read — 30 calls in all — returned every row and
 *  failed nothing at any size, so nothing there proves 250 makes the error less likely. What the
 *  smaller chunk does buy is bounded: a refusal costs 250 fills instead of 1,000, puts three
 *  concurrent queries at the indexer instead of ten, and on that sample finished the same 1,000
 *  fills sooner (1.5–1.6 s per pass at 250, 2.0–6.4 s at 1,000, 3.9–4.0 s at 100 — a fixed cost
 *  per call is what makes the smallest size the slowest of the three).
 */
const CHANGE_CHUNK = 250;

/** The first line of a failure, without the stack the SDK chains underneath it. */
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);

export async function reconcileAccount(options: ReconcileOptions): Promise<ReconcileReport> {
  const { client, cfg, account, fromSec, toSec } = options;
  const maxFills = options.maxFills ?? 2_000;
  const warnings: string[] = [];
  const who = account.toLowerCase();
  const pool = cfg.pool.toLowerCase();

  const read = await readAccountFills(client, who, pool, fromSec, toSec, maxFills);
  const fills = read.rows;
  // The SDK caps one position-change read at 1,000 fills, and inside that cap it fans the request
  // out into ten 100-hash GraphQL queries run at once (`perp/history.js` CHANGE_READ_TX_CHUNK).
  // We hand it fewer fills so one read asks the indexer for less at a time, and we keep the
  // one-to-one order so changes[i] still lines up with fills[i].
  const changes: (PerpPositionChange | null)[] = [];
  let changeReadFailed = 0;
  let changeReadError: string | null = null;
  for (let at = 0; at < fills.length; at += CHANGE_CHUNK) {
    const part = fills.slice(at, at + CHANGE_CHUNK);
    try {
      changes.push(...(await retryRead(`listPerpPositionChangesForFills ${at}`, () => client.listPerpPositionChangesForFills(who, part))));
    } catch (error) {
      // Retries are spent and the indexer still would not answer. Blank the chunk rather than
      // abort: those fills take their place as `null`, so every later fill keeps its own update,
      // and the shortfall is reported as a count with the reason instead of a stack trace.
      changes.push(...part.map(() => null));
      changeReadFailed += part.length;
      if (changeReadError === null) changeReadError = firstLine(error);
    }
  }

  const feeRows = await retryRead("listPerpFees", () =>
    client.listPerpFees({ account: who, pool, limit: 1_000 }),
  );
  const feesInWindow = feeRows.filter((f) => Number(f.timestamp) >= fromSec && Number(f.timestamp) <= toSec);
  if (feeRows.length >= 1_000) warnings.push("the fee read is capped at 1,000 rows and reached it: fee records older than the newest 1,000 for this account and pool were not compared");

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
  const byKind = new Map<string, { rail: FeeRail; rows: number; total: bigint }>();
  const unknownKinds: string[] = [];
  let tradeFees = 0n;
  let tradeRows = 0;
  let liquidationFees = 0n;
  let liquidationRows = 0;
  let unknownFees = 0n;
  let unknownRows = 0;
  for (const row of feesInWindow) {
    const rail = feeRail(row.kind);
    const amount = signedFee(row);
    const seen = byKind.get(row.kind) ?? { rail, rows: 0, total: 0n };
    seen.rows += 1;
    seen.total += amount;
    byKind.set(row.kind, seen);
    if (rail === "trade") {
      tradeFees += amount;
      tradeRows += 1;
    } else if (rail === "liquidation") {
      liquidationFees += amount;
      liquidationRows += 1;
    } else {
      unknownFees += amount;
      unknownRows += 1;
      if (!unknownKinds.includes(row.kind)) unknownKinds.push(row.kind);
    }
  }
  const rates = { takerBpsTimes1k: feeBps(cfg, "taker"), makerBpsTimes1k: feeBps(cfg, "maker") };
  const zeroRateVenue = rates.takerBpsTimes1k === 0n && rates.makerBpsTimes1k === 0n;
  const feeLeg = zeroRateVenue && tradeRows === 0 && expectedFees === 0n ? "vacuous-zero-rate" : "informative";

  if (!seeded && fills.length > 0) warnings.push("no position update was returned for any fill; nothing could be seeded");
  if (changeReadFailed > 0) {
    warnings.push(
      `${changeReadFailed} fill(s) could not be paired with an indexed position update because the indexer refused that read even after retries (${changeReadError}). They are counted as unmatched, so this leg checked ${fills.length - unmatched} of ${fills.length} fills: the shortfall is on this side of the wire, not a gap in what the chain recorded, and the run is not a complete ground-truth check.`,
    );
  }
  if (unmatched - changeReadFailed > 0) warnings.push(`${unmatched - changeReadFailed} fills have no indexed position update and were skipped`);
  if (book.lots.length > 0) {
    warnings.push(`${book.lots.length} lot(s) still open at the end of the window; open positions have no realized check`);
  }
  if (tradeFees !== expectedFees) {
    warnings.push(
      `recorded fill fees total ${tradeFees} against ${expectedFees} recomputed at the live ${rates.takerBpsTimes1k}/${rates.makerBpsTimes1k} bpsx1k taker/maker rates; a rate change or a maker fill explains the difference`,
    );
  }
  if (feeLeg === "vacuous-zero-rate") {
    warnings.push(
      `the fill-fee comparison proved nothing: this market charges ${rates.takerBpsTimes1k} taker and ${rates.makerBpsTimes1k} maker bpsx1k, so both sides are zero by construction and this leg cannot fail. It is not evidence that fee accounting was checked.`,
    );
  }
  if (liquidationRows > 0) {
    warnings.push(
      `${liquidationRows} liquidation-rail record(s) totalling ${liquidationFees} are excluded from the fill-fee comparison: a liquidation penalty is charged on a forced close and routed to an Insurance Fund tier, and this check does not model it.`,
    );
  }
  if (unknownRows > 0) {
    warnings.push(
      `${unknownRows} fee record(s) of unrecognised kind(s) [${unknownKinds.join(", ")}] could not be attributed to a rail; the report fails closed`,
    );
  }

  const firstFillSec = fills.length > 0 ? Number(fills[0]!.timestamp) : null;
  const lastFillSec = fills.length > 0 ? Number(fills[fills.length - 1]!.timestamp) : null;
  const truncated = read.stoppedBy !== null || fills.length < read.inWindow;
  // The population figure only earns an extra read when the read fell short: a full read is
  // already proved by the page cursor running out, and the count is a 10,001-row scan
  // (0.4–2.3s live — see INDEXER_COUNT_CEILING). It is scoped by `pool` rather than market kind
  // because the SDK's `FillsScope` takes no `marketType`, and every perp pool on this chain was
  // measured to carry PERP fills only, so the pool already selects the page read's population.
  const counted = truncated
    ? await retryRead("countUserFills", () => client.countUserFills(who, { pool, since: fromSec, until: toSec })).catch(() => null)
    : null;
  const coverage: FillReadCoverage = {
    firstFillSec,
    lastFillSec,
    rowsScanned: read.scanned,
    rowsInWindow: read.inWindow,
    rowsKept: fills.length,
    pages: read.pages,
    truncated,
    stoppedBy: read.stoppedBy,
    accountFillsInWindow: counted,
    accountFillsAtCeiling: counted !== null && counted >= INDEXER_COUNT_CEILING,
  };
  // What the read covered is the `coverage` block's job, and `fillCoverageStamp` is the one
  // sentence both this report's surfaces print — repeating it here would only risk the two
  // disagreeing. This note is the one thing the shape cannot say: what the ceiling implies.
  if (coverage.accountFillsAtCeiling) {
    warnings.push(
      `the indexer's fill count reached its hard ceiling of ${INDEXER_COUNT_CEILING} rows and is only a lower bound, so this looks like a bot-driven account and the population in the coverage block is understated.`,
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
    changesUnread: { fills: changeReadFailed, reason: changeReadError },
    coverage,
    rows,
    mismatches,
    fees: {
      expected: expectedFees,
      actual: tradeFees,
      diff: tradeFees - expectedFees,
      rows: tradeRows,
      leg: feeLeg,
      rates,
      liquidation: { rows: liquidationRows, total: liquidationFees },
      unknown: { rows: unknownRows, total: unknownFees, kinds: unknownKinds },
      byKind: [...byKind.entries()].map(([kind, v]) => ({ kind, rail: v.rail, rows: v.rows, total: v.total })),
    },
    ok: mismatches === 0 && unmatched === 0 && tradeFees === expectedFees && unknownRows === 0,
    warnings,
  };
}

/**
 *  Page the account's fills newest-first, keep the window and the pool, return oldest-first.
 *
 *  Every limit that can end this read early is reported instead of silently applied: the
 *  `maxFills` cap, the page bound, and the row counts on both sides of the filters. A caller
 *  that raises `maxFills` gets its page bound raised with it (at least 20 pages of headroom),
 *  so the cap the caller chose stays the binding limit rather than a hidden 40-page ceiling
 *  deciding what was reconciled.
 */
async function readAccountFills(
  client: SomniaMarketsClient,
  account: string,
  pool: string,
  fromSec: number,
  toSec: number,
  maxFills: number,
): Promise<{ rows: FillRow[]; inWindow: number; scanned: number; pages: number; stoppedBy: "maxFills" | "page-bound" | null }> {
  const rows: FillRow[] = [];
  const pageLimit = 500;
  const pageBound = Math.max(40, Math.ceil(maxFills / pageLimit) + 20);
  let cursor: string | undefined;
  let pages = 0;
  let scanned = 0;
  let stoppedBy: "maxFills" | "page-bound" | null = null;
  for (;;) {
    const page = await retryRead(`getUserFillsPage ${account.slice(0, 10)}`, () =>
      client.getUserFillsPage(account, { marketType: "PERP", pool, since: fromSec, until: toSec, limit: pageLimit, cursor }),
    );
    pages += 1;
    scanned += page.fills.length;
    for (const fill of page.fills) {
      if (fill.pool?.toLowerCase() !== pool) continue;
      const t = Number(fill.timestamp);
      if (t < fromSec || t > toSec) continue;
      rows.push(fill);
    }
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
    if (rows.length >= maxFills) {
      stoppedBy = "maxFills";
      break;
    }
    if (pages >= pageBound) {
      stoppedBy = "page-bound";
      break;
    }
  }
  rows.sort((a, b) => {
    const ab = Number(a.blockNumber ?? 0) - Number(b.blockNumber ?? 0);
    return ab !== 0 ? ab : (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
  const kept = rows.slice(0, maxFills);
  return { rows: kept, inWindow: rows.length, scanned, pages, stoppedBy };
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
