/**
 *  Net realized leaderboard: discover the accounts that closed perp positions in a window and
 *  rank them by what they actually kept — gross realized minus funding paid minus trade fees.
 *
 *  Why net and not gross: a trader can book a large gross realized PnL and still lose money once
 *  funding is settled against the position. Ranking on gross alone would crown the account that
 *  paid the most funding. The three legs are all collateral-denominated, so they sum in one unit:
 *
 *    net = gross realized − funding paid − trade fees
 *
 *  - gross  : `PerpPositionChange.realizedPnl` over the closing kinds (REDUCE/CLOSE/FLIP). This is
 *             the chain's own price PnL, the same figure the single-account reconcile diffs against.
 *  - funding: `FundingPayment.amount`, signed raw collateral, **positive = paid by the account**.
 *  - fees   : `PerpFeeRecord` on the trade rail (Fee/Rebate/BuilderFee), signed as a cost. The
 *             liquidation rail is a penalty on a forced close routed to an Insurance Fund tier; it
 *             is reported beside net, never folded into it, and `LiquidationFeeSkipped` (a waived
 *             penalty) is not a charge at all. An unrecognised kind fails the row closed.
 *
 *  Discovery is one venue-wide read: `listPerpPositionChanges` with no account filter, windowed in
 *  seconds, returns every account's closing updates and their realized PnL together — so the set of
 *  active accounts and the gross ranking fall out of the same stream, with no per-account fill
 *  replay. Measured on Hideki 2026-11-13 (`probe/leaderboard-order.mts`, warm client, interleaved):
 *  the anonymous role CAN read it venue-wide, but the indexer refuses the ascending shape —
 *  `order: "asc"` with the closing kinds answers `database query error` 3/3 while `order: "desc"`
 *  serves the same window 3/3 in ~2s. Discovery therefore pages newest-first (`desc`); aggregation
 *  and coverage are order-agnostic, so the board is identical. Every page still goes through
 *  `retryRead` for transient load, and a read that stops early is labelled, never presented as a
 *  complete census.
 *
 *  Read-only throughout: no signer, no chain write, no private state.
 */
import type { FundingPayment, PerpFeeRecord, PerpPositionChange, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { onceLive } from "../data/live-cache.js";
import { listPerps } from "../history/market.js";
import { retryRead } from "../retry.js";
import { feeRail, signedFee } from "./replay-account.js";

/** The position-update kinds that realized PnL. OPEN/INCREASE carry zero and are not closes. */
const CLOSING_KINDS = ["REDUCE", "CLOSE", "FLIP"] as const;

export type LeaderboardOptions = {
  client: SomniaMarketsClient;
  /** Window start, unix seconds, inclusive. */
  fromSec: number;
  /** Window end, unix seconds, EXCLUSIVE — the position-change read's own `to` convention. */
  toSec: number;
  /** Cap on accounts netted. Discovery ranks by gross and nets the top N. Defaults to 50. */
  maxAccounts?: number;
  /** Page budget for the venue-wide discovery read. Defaults to 40 (500 rows/page). */
  discoveryPages?: number;
  /** Page budget per account for each of the funding and fee legs. Defaults to 10 (1000 rows/page). */
  legPages?: number;
  /** Accounts netted at once, bounded to stay polite to a shared indexer. Defaults to 4. */
  concurrency?: number;
};

/** One account's gross realized, aggregated from its closing updates inside the window. */
export type GrossByAccount = {
  account: string;
  gross: bigint;
  closes: number;
  pools: Set<string>;
};

/** The windowed, signed legs that turn gross into net. */
export type NetLegs = {
  /** Positive = paid by the account (a cost subtracted from gross). */
  fundingPaid: bigint;
  fundingRows: number;
  /** Trade-rail fees signed as a cost; a rebate is negative. */
  tradeFees: bigint;
  tradeRows: number;
  /** Liquidation penalties: reported, not netted. Includes waived `LiquidationFeeSkipped` rows. */
  liquidationFees: bigint;
  liquidationRows: number;
  unknownKinds: string[];
  unknownTotal: bigint;
  unknownRows: number;
};

export type AccountNet = {
  account: string;
  gross: bigint;
  closes: number;
  markets: number;
  legs: NetLegs;
  net: bigint;
  fundingTruncated: boolean;
  feesTruncated: boolean;
  /** False when a leg was truncated or a fee kind belonged to no rail — the net cannot be trusted. */
  ok: boolean;
};

export type LeaderboardRow = {
  rank: number;
  account: string;
  net: string;
  gross: string;
  fundingPaid: string;
  tradeFees: string;
  liquidationFees: string;
  closes: number;
  markets: number;
  ok: boolean;
  warnings: string[];
};

export type DiscoveryCoverage = {
  rowsScanned: number;
  rowsInWindow: number;
  pages: number;
  truncated: boolean;
  firstChangeSec: number | null;
  lastChangeSec: number | null;
};

export type Leaderboard = {
  fromSec: number;
  toSec: number;
  quoteSymbol: string;
  quoteDecimals: number;
  /** Accounts with at least one closing update seen in the window. */
  discovered: number;
  /** Accounts actually netted and ranked (<= maxAccounts). */
  netted: number;
  maxAccounts: number;
  discovery: DiscoveryCoverage;
  rows: LeaderboardRow[];
  warnings: string[];
};

/** Half-open window, matching the position-change read's inclusive `from` / exclusive `to`. */
const inWindow = (t: number, fromSec: number, toSec: number): boolean => t >= fromSec && t < toSec;

/**
 *  Aggregate closing updates per account over `[from, to)`. Pure: the discovery stream is collected
 *  first, then summed here, so the aggregation can be tested against fixtures without a chain read.
 */
export function aggregateClosing(rows: readonly PerpPositionChange[], fromSec: number, toSec: number): Map<string, GrossByAccount> {
  const byAccount = new Map<string, GrossByAccount>();
  for (const r of rows) {
    if (!inWindow(Number(r.timestamp), fromSec, toSec)) continue;
    const who = r.account.toLowerCase();
    const entry = byAccount.get(who) ?? { account: who, gross: 0n, closes: 0, pools: new Set<string>() };
    entry.gross += r.realizedPnl;
    entry.closes += 1;
    entry.pools.add(r.pool.toLowerCase());
    byAccount.set(who, entry);
  }
  return byAccount;
}

/**
 *  Sign and rail-split the funding and fee legs over the window. Pure. Funding is passed through
 *  signed (positive = paid); fees are signed as a cost and split by rail, with an unrecognised kind
 *  collected rather than silently assigned — the same fail-closed rule the reconcile applies.
 */
export function netLegs(funding: readonly FundingPayment[], fees: readonly PerpFeeRecord[], fromSec: number, toSec: number): NetLegs {
  let fundingPaid = 0n;
  let fundingRows = 0;
  for (const f of funding) {
    if (!inWindow(Number(f.timestamp), fromSec, toSec)) continue;
    fundingPaid += BigInt(f.amount);
    fundingRows += 1;
  }
  let tradeFees = 0n;
  let tradeRows = 0;
  let liquidationFees = 0n;
  let liquidationRows = 0;
  let unknownTotal = 0n;
  let unknownRows = 0;
  const unknownKinds: string[] = [];
  for (const fee of fees) {
    if (!inWindow(Number(fee.timestamp), fromSec, toSec)) continue;
    const rail = feeRail(fee.kind);
    const amount = signedFee(fee);
    if (rail === "trade") {
      tradeFees += amount;
      tradeRows += 1;
    } else if (rail === "liquidation") {
      liquidationFees += amount;
      liquidationRows += 1;
    } else {
      unknownTotal += amount;
      unknownRows += 1;
      if (!unknownKinds.includes(fee.kind)) unknownKinds.push(fee.kind);
    }
  }
  return { fundingPaid, fundingRows, tradeFees, tradeRows, liquidationFees, liquidationRows, unknownKinds, unknownTotal, unknownRows };
}

/** Net one account. Liquidation penalties are reported beside net, never deducted from it. */
export function netAccount(input: { gross: GrossByAccount; legs: NetLegs; fundingTruncated: boolean; feesTruncated: boolean }): AccountNet {
  const { gross, legs } = input;
  return {
    account: gross.account,
    gross: gross.gross,
    closes: gross.closes,
    markets: gross.pools.size,
    legs,
    net: gross.gross - legs.fundingPaid - legs.tradeFees,
    fundingTruncated: input.fundingTruncated,
    feesTruncated: input.feesTruncated,
    ok: legs.unknownRows === 0 && !input.fundingTruncated && !input.feesTruncated,
  };
}

/** A raw collateral amount as a plain decimal string — the same shape the resampler emits. */
function decimal(value: bigint, quoteDecimals: number): string {
  const scale = 10n ** BigInt(quoteDecimals);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(quoteDecimals, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function accountWarnings(n: AccountNet): string[] {
  const w: string[] = [];
  if (n.legs.unknownRows > 0) w.push(`${n.legs.unknownRows} fee row(s) of unrecognised kind(s) [${n.legs.unknownKinds.join(", ")}] could not be attributed to a rail; this row fails closed`);
  if (n.fundingTruncated) w.push("the funding read hit its page cap inside the window, so funding paid is understated and net is overstated");
  if (n.feesTruncated) w.push("the fee read hit its page cap inside the window, so trade fees are understated and net is overstated");
  if (n.legs.liquidationRows > 0) w.push(`${n.legs.liquidationRows} liquidation-rail record(s) totalling ${n.legs.liquidationFees} are shown separately and not deducted from net`);
  return w;
}

/**
 *  Rank netted accounts by net descending, tie-break by gross descending then address ascending so
 *  the order is deterministic. Pure: the decimal formatting and the per-row warnings live here so
 *  they can be tested without a chain read.
 */
export function rankLeaderboard(nets: readonly AccountNet[], quoteDecimals: number): LeaderboardRow[] {
  const sorted = [...nets].sort((a, b) => {
    if (a.net !== b.net) return a.net > b.net ? -1 : 1;
    if (a.gross !== b.gross) return a.gross > b.gross ? -1 : 1;
    return a.account < b.account ? -1 : a.account > b.account ? 1 : 0;
  });
  return sorted.map((n, i) => ({
    rank: i + 1,
    account: n.account,
    net: decimal(n.net, quoteDecimals),
    gross: decimal(n.gross, quoteDecimals),
    fundingPaid: decimal(n.legs.fundingPaid, quoteDecimals),
    tradeFees: decimal(n.legs.tradeFees, quoteDecimals),
    liquidationFees: decimal(n.legs.liquidationFees, quoteDecimals),
    closes: n.closes,
    markets: n.markets,
    ok: n.ok,
    warnings: accountWarnings(n),
  }));
}

/**
 *  Page the venue-wide closing updates backward over `[from, to)`, newest first (`desc` — the shape
 *  the indexer serves; `asc` is refused, see the module note), deduping by id.
 *
 *  The cursor is the last row's timestamp plus one. `to` is exclusive, so +1 re-includes the boundary
 *  second and the next page re-reads any rows sharing it that did not fit; the id set drops the
 *  overlap. A page that adds no new id means one timestamp holds more rows than a page can carry, so
 *  the walk cannot advance — that is reported as truncation rather than spun on.
 */
export async function discoverClosing(
  client: SomniaMarketsClient,
  fromSec: number,
  toSec: number,
  maxPages: number,
): Promise<{ byAccount: Map<string, GrossByAccount>; coverage: DiscoveryCoverage }> {
  const pageSize = 500;
  const seen = new Set<string>();
  const all: PerpPositionChange[] = [];
  let to = toSec;
  let pages = 0;
  let scanned = 0;
  let truncated = false;
  for (;;) {
    const cursor = to;
    const rows = await retryRead(`leaderboard discovery ${cursor}`, () =>
      client.listPerpPositionChanges({ kinds: CLOSING_KINDS, from: fromSec, to: cursor, order: "desc", limit: pageSize }),
    );
    pages += 1;
    scanned += rows.length;
    if (rows.length === 0) break;
    let fresh = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      all.push(r);
      fresh += 1;
    }
    if (rows.length < pageSize) break;
    if (pages >= maxPages) { truncated = true; break; }
    if (fresh === 0) { truncated = true; break; }
    to = Number(rows[rows.length - 1]!.timestamp) + 1;
  }
  const byAccount = aggregateClosing(all, fromSec, toSec);
  let first: number | null = null;
  let last: number | null = null;
  let inWin = 0;
  for (const r of all) {
    const t = Number(r.timestamp);
    if (!inWindow(t, fromSec, toSec)) continue;
    inWin += 1;
    first = first === null ? t : Math.min(first, t);
    last = last === null ? t : Math.max(last, t);
  }
  return { byAccount, coverage: { rowsScanned: scanned, rowsInWindow: inWin, pages, truncated, firstChangeSec: first, lastChangeSec: last } };
}

/**
 *  Read one account's funding and fee legs newest-first, keeping the window. Each leg pages by offset
 *  until a page reaches past the window start (every later page is older) or the page cap binds; a
 *  cap reached while still inside the window is reported as truncation, so an understated cost cannot
 *  pass as a complete net.
 */
async function readLegs(
  client: SomniaMarketsClient,
  account: string,
  fromSec: number,
  toSec: number,
  maxPages: number,
): Promise<{ funding: FundingPayment[]; fees: PerpFeeRecord[]; fundingTruncated: boolean; feesTruncated: boolean }> {
  const pageSize = 1000;
  async function page<T extends { timestamp: string }>(label: string, read: (offset: number) => Promise<T[]>): Promise<{ rows: T[]; truncated: boolean }> {
    const rows: T[] = [];
    let offset = 0;
    let truncated = false;
    for (let p = 0; p < maxPages; p += 1) {
      const batch = await retryRead(`${label} ${account.slice(0, 10)}`, () => read(offset));
      if (batch.length === 0) break;
      let oldest = Number.POSITIVE_INFINITY;
      for (const r of batch) {
        const t = Number(r.timestamp);
        if (t < oldest) oldest = t;
        if (inWindow(t, fromSec, toSec)) rows.push(r);
      }
      offset += batch.length;
      if (oldest < fromSec) break;
      if (batch.length < pageSize) break;
      if (p === maxPages - 1) truncated = true;
    }
    return { rows, truncated };
  }
  const funding = await page<FundingPayment>("leaderboard funding", (offset) => client.getFundingPayments(account, { limit: pageSize, offset }));
  const fees = await page<PerpFeeRecord>("leaderboard fees", (offset) => client.listPerpFees({ account, limit: pageSize, offset }));
  return { funding: funding.rows, fees: fees.rows, fundingTruncated: funding.truncated, feesTruncated: fees.truncated };
}

/**
 *  Build the net leaderboard: discover, net the top candidates, rank by net. Every limit that can
 *  shorten the answer is surfaced — discovery truncation, the account cap, and per-account leg caps.
 */
export async function buildLeaderboard(options: LeaderboardOptions): Promise<Leaderboard> {
  const { client, fromSec, toSec } = options;
  const maxAccounts = Math.max(1, Math.floor(options.maxAccounts ?? 50));
  const discoveryPages = Math.max(1, Math.floor(options.discoveryPages ?? 40));
  const legPages = Math.max(1, Math.floor(options.legPages ?? 10));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) throw new Error("leaderboard window must be [from, to) with to > from");

  const listed = await onceLive("perp-markets", () => listPerps(client));
  if (listed.length === 0) throw new Error("the venue lists no perp markets to rank");
  // Every leg is collateral-denominated and collateral is venue-wide, so one unit covers the board.
  // Guard that the listed markets agree, rather than silently summing across two quote units.
  const quoteSymbol = listed[0]!.quoteSymbol ?? "USDso";
  const quoteDecimals = listed[0]!.quoteDecimals;
  for (const m of listed) {
    if ((m.quoteSymbol ?? "USDso") !== quoteSymbol || m.quoteDecimals !== quoteDecimals) {
      throw new Error(`perp markets quote in different units (${quoteSymbol}/${quoteDecimals} vs ${m.quoteSymbol}/${m.quoteDecimals}); a cross-market net leaderboard needs one collateral unit`);
    }
  }

  const { byAccount, coverage } = await discoverClosing(client, fromSec, toSec, discoveryPages);
  const discovered = byAccount.size;
  const warnings: string[] = [];
  if (coverage.truncated) {
    warnings.push(
      `the discovery read stopped early (${coverage.pages} pages, ${coverage.rowsScanned} closing updates scanned); accounts whose closes fall past the stop are missing, so this board is a slice of the venue, not a complete census.`,
    );
  }

  // Net the top accounts by gross, then re-rank by net. Netting can reorder — funding can flip a
  // gross winner into a net loser — so the candidate cut is by gross and is labelled when it binds.
  const candidates = [...byAccount.values()]
    .sort((a, b) => (a.gross > b.gross ? -1 : a.gross < b.gross ? 1 : a.account < b.account ? -1 : 1))
    .slice(0, maxAccounts);
  if (discovered > maxAccounts) {
    warnings.push(
      `${discovered} accounts closed positions in the window; netting covered the top ${maxAccounts} by gross realized. An account with low gross but large funding credits could rank higher on net and is not shown.`,
    );
  }

  const nets: AccountNet[] = new Array(candidates.length);
  const errors: unknown[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= candidates.length) return;
      const gross = candidates[i]!;
      try {
        const legs = await readLegs(client, gross.account, fromSec, toSec, legPages);
        nets[i] = netAccount({ gross, legs: netLegs(legs.funding, legs.fees, fromSec, toSec), fundingTruncated: legs.fundingTruncated, feesTruncated: legs.feesTruncated });
      } catch (error) {
        // Drain every worker before surfacing a failure, so a rejected read does not leave siblings
        // running as unhandled rejections. A partial board could misrank, so the first error wins.
        errors.push(error);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  if (errors.length > 0) throw errors[0];

  const rows = rankLeaderboard(nets, quoteDecimals);
  if (rows.length === 0) warnings.push("no account closed a perp position in this window, so there is nothing to rank.");
  // The honesty twin of the reconcile's `vacuous-zero-rate`: when no funding and no trade fees were
  // recorded for any account, net equals gross by construction and the netting leg proved nothing.
  if (nets.length > 0 && nets.every((n) => n.legs.fundingPaid === 0n && n.legs.tradeFees === 0n)) {
    warnings.push(
      "net equals gross for every ranked account: no funding payments or trade fees were recorded in this window, so the netting leg cannot fail here. On Hideki taker/maker fees are 0 by venue policy; this is not evidence that funding and fees were checked.",
    );
  }

  return { fromSec, toSec, quoteSymbol, quoteDecimals, discovered, netted: rows.length, maxAccounts, discovery: coverage, rows, warnings };
}