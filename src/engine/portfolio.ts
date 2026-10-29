import { perpLiquidationPrice, perpPositionAnalytics } from "@somnia-chain/markets-sdk";
import type { Bar } from "../history/bars.js";
import { feeBps, type MarketConfig } from "../history/market.js";

export type Side = "long" | "short";
export type FillRole = "taker" | "maker";

/**
 *  The open position. At most one exists: MarginBank books a perp position as a fungible
 *  size and one volume-weighted average entry, so a second entry re-averages this one
 *  rather than sitting beside it. Splitting into lots would realize a different price PnL
 *  on a partial close than the chain does, which the account reconciliation catches.
 */
export type Lot = { price: bigint; size: bigint; entryFundingIndex: bigint; openedAt?: number };

export type Marked = {
  size: bigint;
  notional: bigint;
  unrealized: bigint;
  accrued: bigint;
  equity: bigint;
  mmReq: bigint;
  imReq: bigint;
};

const BPS = 10_000n;
const FEE_SCALE = BPS * 1_000n;

/** Notional x the pool's fee for a fill, in the `bps x 1000` scale the chain stores. */
export function fillFee(cfg: MarketConfig, role: FillRole, notional: bigint): bigint {
  return (notional * feeBps(cfg, role)) / FEE_SCALE;
}

/** The taker fee, kept under its original name for the pre-trade gate and the legacy oracle. */
export function takerFee(cfg: MarketConfig, notional: bigint): bigint {
  return fillFee(cfg, "taker", notional);
}

/** Mark every open lot at one price, in one pass, with the protocol's own per-position kernel. */
export function markLots(
  cfg: MarketConfig,
  lots: readonly Lot[],
  cash: bigint,
  bar: Bar,
  price: bigint,
): Marked {
  let size = 0n;
  let notional = 0n;
  let unrealized = 0n;
  let accrued = 0n;
  let contribution = 0n;
  let mmReq = 0n;
  let imReq = 0n;
  for (const lot of lots) {
    const signed = lot.size;
    const m = perpPositionAnalytics({
      size: signed,
      avgEntryPrice: lot.price,
      entryFundingIndex: lot.entryFundingIndex,
      markPrice: price,
      projectedCumulativeFunding: bar.cum,
      oneBase: cfg.oneBase,
      effectiveImfBps: cfg.effectiveImfBps,
      maintenanceMarginBps: cfg.mmBps,
      closeOutMarginBps: cfg.closeOutBps,
    });
    size += signed;
    notional += m.notional;
    unrealized += m.unrealizedPnl;
    accrued += m.accruedFunding;
    contribution += m.equityContribution;
    mmReq += m.maintenanceMarginRequirement;
    imReq += m.initialMarginRequirement;
  }
  return { size, notional, unrealized, accrued, equity: cash + contribution, mmReq, imReq };
}

/** Everything one order did: what it closed, what it opened, what it cost. */
export type Execution = {
  side: "buy" | "sell";
  /** Raw base units the order asked for. */
  size: bigint;
  price: bigint;
  role: FillRole;
  t: number;
  cum: bigint;
  /** Fee on the whole fill notional (negative for a maker rebate). */
  fee: bigint;
  gas: bigint;
  closed: ClosedTrade[];
  /** Signed base units left open by this order; zero for a pure close. */
  opened: bigint;
};

export type ClosedTrade = {
  /** Index of the execution that closed it. */
  seq: number;
  t: number;
  side: Side;
  size: bigint;
  /** Weighted average entry across the lots consumed. */
  entryPrice: bigint;
  exitPrice: bigint;
  /** Price PnL only, before funding and fees. */
  grossPnl: bigint;
  /** Funding the closed lots had accrued since entry, as a cost. */
  funding: bigint;
  /** The part of the close's fill fee attributable to this size. */
  fee: bigint;
  gas: bigint;
  /** grossPnl - funding - fee - gas. */
  netPnl: bigint;
  /** Wall-clock seconds the oldest consumed lot was held. */
  heldSec: number;
  fillId: string | null;
};

export type FillSpec = {
  t: number;
  price: bigint;
  role: FillRole;
  /** Cumulative funding index in force when the fill happens. */
  cum: bigint;
  /** Native gas for the transaction, in raw quote units. Defaults to zero. */
  gas?: bigint;
  fillId?: string;
};

/**
 *  One market's collateral, position and realised history.
 *
 *  Every number is a raw integer and every cost is booked exactly once: a fill subtracts its
 *  fee and gas from cash, a close credits price PnL and debits accrued funding, and marking
 *  adds the unrealised contribution. That makes `equity - equityStart = price - funding -
 *  fees - gas` an identity rather than an approximation, which is what the invariant check
 *  asserts.
 *
 *  The position is fungible with one average entry, as `PerpPositionChange` reports it: an
 *  increase re-averages the entry, and a partial close realizes against that average and
 *  leaves it untouched. Realized price PnL is divided rounding down, which is what the
 *  chain's own arithmetic does — verified against real fills by `reconcileAccount`.
 *
 *  A fill larger than the open position closes it and opens the remainder — a flip costs two
 *  fees on one order, as it does on chain, because the whole taker notional pays.
 */
export class PositionBook {
  /** Parameters in force, replaced by the run loop when an epoch changes under the book. */
  cfg: MarketConfig;
  readonly equityStart: bigint;
  cash: bigint;
  readonly lots: Lot[] = [];
  readonly trades: ClosedTrade[] = [];
  realizedPnl = 0n;
  fundingSettled = 0n;
  feesTaker = 0n;
  feesMaker = 0n;
  gasPaid = 0n;
  /** Executions applied so far; also the seq stamped on closed trades. */
  count = 0;

  constructor(cfg: MarketConfig, cash: bigint) {
    this.cfg = cfg;
    this.cash = cash;
    this.equityStart = cash;
  }

  get size(): bigint {
    return this.lots.reduce((sum, lot) => sum + lot.size, 0n);
  }

  get isFlat(): boolean {
    return this.lots.length === 0;
  }

  /** Total fees booked, taker and maker, sign preserved (a rebate reduces the sum). */
  get feesPaid(): bigint {
    return this.feesTaker + this.feesMaker;
  }

  /**
   *  Apply one fill: close against the average entry first, then re-average or open the
   *  remainder. Fees and gas are charged on the whole order, never on the closed slice alone.
   */
  execute(side: "buy" | "sell", size: bigint, fill: FillSpec): Execution {
    if (size <= 0n) throw new Error("fill size must be positive");
    const delta = side === "buy" ? size : -size;
    const deltaSign = delta > 0n;
    const notional = (size * fill.price) / this.cfg.oneBase;
    const fee = fillFee(this.cfg, fill.role, notional);
    const gas = fill.gas ?? 0n;
    this.cash -= fee + gas;
    if (fill.role === "taker") this.feesTaker += fee;
    else this.feesMaker += fee;
    this.gasPaid += gas;
    this.count += 1;

    const closed: ClosedTrade[] = [];
    let remaining = size;
    const cur = this.lots[0];
    if (cur !== undefined && cur.size > 0n !== deltaSign) {
      const take = minAbs(cur.size, remaining);
      closed.push(this.closePosition(cur, take, fill));
      remaining -= take;
      const left = cur.size > 0n ? cur.size - take : cur.size + take;
      if (left === 0n) this.lots.length = 0;
      else cur.size = left;
    }

    let opened = 0n;
    if (remaining > 0n) {
      const signed = deltaSign ? remaining : -remaining;
      const pos = this.lots[0];
      if (pos === undefined) {
        this.lots.push({ price: fill.price, size: signed, entryFundingIndex: fill.cum, openedAt: fill.t });
      } else {
        // Same sign as the fill, or the close above would have emptied the book: re-average.
        const held = pos.size > 0n ? pos.size : -pos.size;
        const total = held + remaining;
        pos.price = avgTrunc(pos.price * held + fill.price * remaining, total);
        pos.entryFundingIndex = avgTrunc(pos.entryFundingIndex * held + fill.cum * remaining, total);
        pos.size = deltaSign ? total : -total;
        pos.openedAt = pos.openedAt === undefined ? fill.t : Math.min(pos.openedAt, fill.t);
      }
      opened = signed;
    }

    // A flip's fee covers both legs; attribute it pro rata so each closed trade's net is honest.
    if (closed.length > 0 && fee !== 0n) {
      const closedSize = closed.reduce((sum, t) => sum + t.size, 0n);
      for (const trade of closed) {
        const share = (fee * trade.size) / size;
        trade.fee = share;
        trade.netPnl -= share;
      }
    }

    return { side, size, price: fill.price, role: fill.role, t: fill.t, cum: fill.cum, fee, gas, closed, opened };
  }

  private closePosition(pos: Lot, take: bigint, fill: FillSpec): ClosedTrade {
    const signedTake = pos.size > 0n ? take : -take;
    const accrued = perpPositionAnalytics({
      size: signedTake,
      avgEntryPrice: pos.price,
      entryFundingIndex: pos.entryFundingIndex,
      markPrice: fill.price,
      projectedCumulativeFunding: fill.cum,
      oneBase: this.cfg.oneBase,
      effectiveImfBps: this.cfg.effectiveImfBps,
      maintenanceMarginBps: this.cfg.mmBps,
      closeOutMarginBps: this.cfg.closeOutBps,
    }).accruedFunding;
    const grossPnl = divFloor((fill.price - pos.price) * signedTake, this.cfg.oneBase);
    this.cash += grossPnl - accrued;
    this.realizedPnl += grossPnl;
    this.fundingSettled += accrued;
    const trade: ClosedTrade = {
      seq: this.count,
      t: fill.t,
      side: pos.size > 0n ? "long" : "short",
      size: take,
      entryPrice: pos.price,
      exitPrice: fill.price,
      grossPnl,
      funding: accrued,
      fee: 0n,
      gas: 0n,
      netPnl: grossPnl - accrued,
      heldSec: pos.openedAt === undefined ? 0 : Math.max(0, fill.t - pos.openedAt),
      fillId: fill.fillId ?? null,
    };
    this.trades.push(trade);
    return trade;
  }

  /** Mark the book at one price on one bar, with the protocol's kernel. */
  mark(bar: Bar, price: bigint = bar.mark): Marked {
    return markLots(this.cfg, this.lots, this.cash, bar, price);
  }

  /** Funding the open lots have accrued at `bar`'s cumulative index, as a cost. */
  fundingOpen(bar: Bar): bigint {
    return this.lots.length === 0 ? 0n : this.mark(bar).accrued;
  }

  /**
   *  Funding the open lots accrued between `fromCum` and `bar`'s cumulative index.
   *
   *  A lot opened after `fromCum` owes nothing before its own entry, so its entry index is
   *  clamped up to `fromCum`. That is what makes the per-bar funding figure additive:
   *  summing it over a run equals the funding a close settles.
   */
  accruedBetween(bar: Bar, fromCum: bigint): bigint {
    let accrued = 0n;
    const lo = fromCum < bar.cum ? fromCum : bar.cum;
    const hi = fromCum < bar.cum ? bar.cum : fromCum;
    for (const lot of this.lots) {
      // Clamping into the interval is what makes a lot that entered mid-bar (or after the
      // index already moved against it) accrue only the part of this bar it was open for.
      const from = lot.entryFundingIndex < lo ? lo : lot.entryFundingIndex > hi ? hi : lot.entryFundingIndex;
      if (bar.cum === from) continue;
      accrued += perpPositionAnalytics({
        size: lot.size,
        avgEntryPrice: lot.price,
        entryFundingIndex: from,
        markPrice: bar.mark,
        projectedCumulativeFunding: bar.cum,
        oneBase: this.cfg.oneBase,
        effectiveImfBps: this.cfg.effectiveImfBps,
        maintenanceMarginBps: this.cfg.mmBps,
        closeOutMarginBps: this.cfg.closeOutBps,
      }).accruedFunding;
    }
    return accrued;
  }

  /** Where the book would be liquidated at this bar's mark, or null when flat/unknowable. */
  liquidationPrice(bar: Bar): bigint | null {
    const at = this.mark(bar);
    if (at.size === 0n) return null;
    return perpLiquidationPrice({
      equity: at.equity,
      mmReq: at.mmReq,
      size: at.size,
      markPrice: bar.mark,
      maintenanceMarginBps: this.cfg.mmBps,
      oneBase: this.cfg.oneBase,
    });
  }

  /** The identity the run must satisfy, as a signed error that should be zero. */
  identityError(bar: Bar, price: bigint = bar.mark): bigint {
    const at = this.mark(bar, price);
    const fundingOpen = at.accrued;
    return at.equity - this.equityStart - (this.realizedPnl + at.unrealized - this.fundingSettled - fundingOpen - this.feesPaid - this.gasPaid);
  }
}

export { BPS as BPS_SCALE };

function minAbs(a: bigint, b: bigint): bigint {
  const aa = a < 0n ? -a : a;
  return aa < b ? aa : b;
}

/** Division toward zero: the chain's truncation when it averages an entry price. */
function avgTrunc(n: bigint, d: bigint): bigint {
  return n / d;
}

/**
 *  Division rounding down. The chain realizes a close against its stored average entry with
 *  this rounding: a loss is one raw unit more negative than truncation would give. Verified
 *  against `PerpPositionChange.realizedPnl` on real fills.
 */
function divFloor(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divisor must be positive");
  const q = n / d;
  return n < 0n && q * d !== n ? q - 1n : q;
}
