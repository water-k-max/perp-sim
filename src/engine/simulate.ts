import { perpLiquidationPrice, perpPositionAnalytics } from "@somnia-chain/markets-sdk";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";

export type Side = "long" | "short";

export type Entry = {
  /** Index into the bar series this lot opens at. */
  bar: number;
  side: Side;
  /** Size in raw base units, positive. */
  size: bigint;
  /** Fill price, raw quote units per whole base. */
  price: bigint;
};

export type SimInput = {
  cfg: MarketConfig;
  bars: Bar[];
  /** Starting collateral, raw quote units. */
  cash: bigint;
  entries: Entry[];
  /** Close the position at the first bar at or after this index. Defaults to the last bar. */
  untilBar?: number;
};

export type BarTrail = {
  bar: number;
  t: number;
  mark: bigint;
  markSource: "mark" | "index";
  /** The intra-bar fill extreme the liquidation check was run at, when it was worse than the mark. */
  worstPrice: bigint | null;
  size: bigint;
  notional: bigint;
  unrealizedPnl: bigint;
  /** Funding accrued by every open lot since its own entry, marked at this bar. */
  fundingAccrued: bigint;
  /** Funding accrued since the previous settlement by the lots that were already open. */
  fundingThisBar: bigint;
  /** Marked at this bar's settlement price. */
  equityAtMark: bigint;
  /** Marked at `worstPrice` when the bar covered a worse fill, else the same as `equityAtMark`. */
  equity: bigint;
  maintenanceMargin: bigint;
  /** `equity x 10000 / mmReq`. Below 10000 the account is liquidatable. */
  healthBps: bigint;
  liquidationPrice: bigint | null;
};

export type Marked = {
  size: bigint;
  notional: bigint;
  unrealized: bigint;
  accrued: bigint;
  equity: bigint;
  mmReq: bigint;
  imReq: bigint;
};

type Lot = { price: bigint; size: bigint; entryFundingIndex: bigint };

const BPS = 10_000n;
const FEE_SCALE = BPS * 1_000n;

/** Notional x the taker fee read from the pool. Zero where the pool charges none. */
export function takerFee(cfg: MarketConfig, notional: bigint): bigint {
  return (notional * cfg.takerFeeBpsTimes1k) / FEE_SCALE;
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

/**
 *  Walk real settlement bars with a position book and report what happened.
 *
 *  Funding is the cumulative index the chain actually moved, so intervals the catch-up
 *  horizon forgave cost nothing here — the bar's rate is never multiplied by elapsed time.
 *  Each bar is tested at the worst fill price it covered, not only at the settlement print,
 *  so an intra-bar touch counts.
 *
 *  One market, one side. Cross-margin interaction between markets is a different
 *  simulation, and this does not claim to be it.
 */
export function simulate(input: SimInput): Outcome {
  const { cfg, bars, entries } = input;
  if (bars.length === 0) throw new Error("no bars to simulate");
  if (entries.length === 0) throw new Error("no entries to simulate");
  const sides = new Set(entries.map((e) => e.side));
  if (sides.size > 1) throw new Error("one side per run: longs and shorts on one market do not net");

  const signed = sides.has("long") ? 1n : -1n;
  const untilBar = Math.min(input.untilBar ?? bars.length - 1, bars.length - 1);
  const opening = new Map<number, Entry[]>();
  for (const e of entries) {
    const list = opening.get(e.bar) ?? [];
    list.push(e);
    opening.set(e.bar, list);
  }

  let cash = input.cash;
  const lots: Lot[] = [];
  const trail: BarTrail[] = [];
  let realizedPnl = 0n;
  let fundingSettled = 0n;
  let feesPaid = 0n;
  let minEquity = input.cash;
  let minEquityBar: number | null = null;
  let barsHeld = 0;
  let liquidatedAtBar: number | null = null;
  let liquidatedAtPrice: bigint | null = null;
  let closedAtBar: number | null = null;

  for (let i = 0; i <= untilBar; i += 1) {
    const bar = bars[i];
    // Funding settles at the boundary; a lot opened at this bar owes nothing for it, so
    // the per-bar figure is measured against the same lots marked before they were added.
    const accruedBefore = lots.length > 0 ? markLots(cfg, lots, cash, bar, bar.mark).accrued : 0n;
    for (const e of opening.get(i) ?? []) {
      const fee = takerFee(cfg, (e.size * e.price) / cfg.oneBase);
      cash -= fee;
      feesPaid += fee;
      lots.push({ price: e.price, size: e.size * signed, entryFundingIndex: bar.cum });
    }
    if (lots.length === 0) continue;
    barsHeld += 1;

    const at = markLots(cfg, lots, cash, bar, bar.mark);
    const worst = signed > 0n ? bar.low : bar.high;
    // Only a price that hurts the position is a stress test. Candle extremes are fill
    // prices and the mark is an EMA, so a bar's low can legitimately sit above the mark;
    // marking a long there would report risk that does not exist.
    const adverse =
      worst !== null && (signed > 0n ? worst < bar.mark : worst > bar.mark);
    const stressPrice = adverse ? worst : null;
    const stressed = stressPrice !== null ? markLots(cfg, lots, cash, bar, stressPrice) : null;
    const equity = stressed?.equity ?? at.equity;
    const mmReq = stressed?.mmReq ?? at.mmReq;
    const priceChecked = stressPrice ?? bar.mark;

    const liquidationPrice = perpLiquidationPrice({
      equity: at.equity,
      mmReq: at.mmReq,
      size: at.size,
      markPrice: bar.mark,
      maintenanceMarginBps: cfg.mmBps,
      oneBase: cfg.oneBase,
    });

    if (minEquityBar === null || equity < minEquity) {
      minEquity = equity;
      minEquityBar = i;
    }

    trail.push({
      bar: i,
      t: bar.t,
      mark: bar.mark,
      markSource: bar.markSource,
      worstPrice: stressPrice,
      size: at.size,
      notional: at.notional,
      unrealizedPnl: at.unrealized,
      fundingAccrued: at.accrued,
      fundingThisBar: at.accrued - accruedBefore,
      equityAtMark: at.equity,
      equity,
      maintenanceMargin: mmReq,
      healthBps: mmReq === 0n ? BPS * 100n : (equity * BPS) / mmReq,
      liquidationPrice,
    });

    if (equity < mmReq) {
      liquidatedAtBar = i;
      liquidatedAtPrice = priceChecked;
      break;
    }

    if (i >= untilBar) {
      const exitPrice = bar.mark;
      for (const lot of lots) {
        const m = perpPositionAnalytics({
          size: lot.size,
          avgEntryPrice: lot.price,
          entryFundingIndex: lot.entryFundingIndex,
          markPrice: exitPrice,
          projectedCumulativeFunding: bar.cum,
          oneBase: cfg.oneBase,
          effectiveImfBps: cfg.effectiveImfBps,
          maintenanceMarginBps: cfg.mmBps,
          closeOutMarginBps: cfg.closeOutBps,
        });
        const fee = takerFee(cfg, m.notional);
        cash += m.unrealizedPnl - m.accruedFunding - fee;
        realizedPnl += m.unrealizedPnl;
        fundingSettled += m.accruedFunding;
        feesPaid += fee;
      }
      lots.length = 0;
      closedAtBar = i;
      break;
    }
  }

  const last = trail[trail.length - 1];
  const equityEnd = lots.length > 0 ? (last?.equityAtMark ?? cash) : cash;
  return {
    status: liquidatedAtBar !== null ? "liquidated" : lots.length > 0 ? "open" : "closed",
    liquidatedAtBar,
    liquidatedAtPrice,
    closedAtBar,
    barsHeld,
    bars: bars.length,
    equityStart: input.cash,
    equityEnd,
    realizedPnl,
    fundingSettled,
    fundingOpen: lots.length > 0 ? (last?.fundingAccrued ?? 0n) : 0n,
    feesPaid,
    roiBps: input.cash === 0n ? null : ((equityEnd - input.cash) * BPS) / input.cash,
    minEquity,
    minEquityBar,
    trail,
  };
}

export type Outcome = {
  status: "open" | "closed" | "liquidated";
  liquidatedAtBar: number | null;
  liquidatedAtPrice: bigint | null;
  closedAtBar: number | null;
  barsHeld: number;
  bars: number;
  equityStart: bigint;
  equityEnd: bigint;
  /** Gross price PnL realised by closes that actually happened. */
  realizedPnl: bigint;
  /** Funding that settled into collateral across realised closes. */
  fundingSettled: bigint;
  /** Funding accrued on a position still open at the end of the run. */
  fundingOpen: bigint;
  feesPaid: bigint;
  roiBps: bigint | null;
  minEquity: bigint;
  minEquityBar: number | null;
  trail: BarTrail[];
};
