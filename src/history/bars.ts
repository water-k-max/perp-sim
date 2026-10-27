import type { Candle, FundingRateUpdate } from "@somnia-chain/markets-sdk";

/**
 *  One settlement boundary turned into something a position can be marked against.
 *  Pure transform over rows already in settlement order — no I/O, so it can be asserted
 *  against fixtures without a network.
 */
export type Bar = {
  /** Settlement time, unix seconds. */
  t: number;
  /**
   *  The price the position is marked at. A null `markPrice` is the contract's sentinel
   *  for a stale or reverting feed, NOT a price of zero, so it falls back to the index.
   */
  mark: bigint;
  markSource: "mark" | "index";
  indexPrice: bigint;
  /** Cumulative funding index after this settlement, 1e18-scaled quote per whole base. */
  cum: bigint;
  /**
   *  `cum - previous cum`. This is the accrual, not `rate x intervals`: the deployed
   *  catch-up horizon can forgive part of a settlement's span, and the index delta is
   *  the only quantity that already accounts for that.
   */
  fundingDelta: bigint;
  rate: bigint;
  fundingWindowSec: number;
  fundingIntervalSec: number;
  intervalsSettled: number;
  intervalsAccrued: number;
  forgivenIntervals: number;
  anchorResynced: boolean;
  /** Seconds since the previous settlement; 0 on the first bar. */
  gapSec: number;
  /** Settlement intervals with no row at all inside this gap. */
  missedIntervals: number;
  /** Worst fill price for a long inside the bar, from the candles it covers. */
  low: bigint | null;
  /** Worst fill price for a short inside the bar. */
  high: bigint | null;
  candles: number;
};

export type Coverage = {
  bars: number;
  from: number | null;
  to: number | null;
  spanSec: number;
  /** Settlements that would have existed at this cadence over the span. */
  expectedSettlements: number;
  missingSettlements: number;
  markFromIndex: number;
  anchorResynced: number;
  forgivenIntervals: number;
  /** Gaps wider than one interval at the cadence in force, i.e. funding time nobody emitted. */
  gaps: number;
};

export function buildBars(rows: readonly FundingRateUpdate[]): Bar[] {
  const bars: Bar[] = [];
  let prev: FundingRateUpdate | null = null;
  for (const row of rows) {
    const t = Number(row.timestamp);
    const markSource = row.markPrice === null ? "index" : "mark";
    const mark = row.markPrice === null ? BigInt(row.indexPrice) : BigInt(row.markPrice);
    const cum = BigInt(row.cumulativeFundingPerUnit);
    const prevCum = prev === null ? cum : BigInt(prev.cumulativeFundingPerUnit);
    const settled = Number(row.intervalsSettled);
    const accrued = Number(row.intervalsAccrued);
    const intervalSec = row.fundingIntervalSec;
    const gapSec = prev === null ? 0 : t - Number(prev.timestamp);
    bars.push({
      t,
      mark,
      markSource,
      indexPrice: BigInt(row.indexPrice),
      cum,
      fundingDelta: cum - prevCum,
      rate: BigInt(row.fundingRate),
      fundingWindowSec: row.fundingWindowSec,
      fundingIntervalSec: intervalSec,
      intervalsSettled: settled,
      intervalsAccrued: accrued,
      forgivenIntervals: Math.max(0, settled - accrued),
      anchorResynced: row.anchorResynced,
      gapSec,
      missedIntervals: prev === null ? 0 : Math.max(0, Math.round(gapSec / intervalSec) - 1),
      low: null,
      high: null,
      candles: 0,
    });
    prev = row;
  }
  return bars;
}

/**
 *  Fold each bar's fill extremes in from candles, so a touch inside a bar can be
 *  detected instead of only a close-to-one price. A candle belongs to the bar whose
 *  settlement closes it.
 *
 *  These are FILL prices, not oracle marks: they approximate where the mark went inside
 *  the bar, and the approximation must be disclosed rather than presented as a replay of
 *  the feed.
 */
export function withIntraBarPath(bars: Bar[], candles: readonly Candle[]): Bar[] {
  if (bars.length === 0) return bars;
  const out = bars.map((b) => ({ ...b }));
  let bar = 0;
  for (const candle of candles) {
    const bucket = Number(candle.bucketStart);
    while (bar < out.length - 1 && bucket > out[bar].t) bar += 1;
    if (bucket > out[bar].t) continue;
    const cur = out[bar];
    const high = BigInt(candle.high);
    const low = BigInt(candle.low);
    cur.high = cur.high === null ? high : high > cur.high ? high : cur.high;
    cur.low = cur.low === null ? low : low < cur.low ? low : cur.low;
    cur.candles += 1;
  }
  return out;
}

export function coverage(bars: readonly Bar[]): Coverage {
  if (bars.length === 0) {
    return {
      bars: 0,
      from: null,
      to: null,
      spanSec: 0,
      expectedSettlements: 0,
      missingSettlements: 0,
      markFromIndex: 0,
      anchorResynced: 0,
      forgivenIntervals: 0,
      gaps: 0,
    };
  }
  const from = bars[0].t;
  const to = bars[bars.length - 1].t;
  const spanSec = to - from;
  const cadence = bars[bars.length - 1].fundingIntervalSec;
  const expected = cadence > 0 ? Math.floor(spanSec / cadence) + 1 : bars.length;
  return {
    bars: bars.length,
    from,
    to,
    spanSec,
    expectedSettlements: expected,
    missingSettlements: Math.max(0, expected - bars.length),
    markFromIndex: bars.filter((b) => b.markSource === "index").length,
    anchorResynced: bars.filter((b) => b.anchorResynced).length,
    forgivenIntervals: bars.reduce((sum, b) => sum + b.forgivenIntervals, 0),
    gaps: bars.filter((b) => b.missedIntervals > 0).length,
  };
}
