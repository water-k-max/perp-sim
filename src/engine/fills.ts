import type { MarketConfig } from "../history/market.js";
import type { TapeFill } from "../data/types.js";

/**
 *  How much of the tape a modelled market order is allowed to take.
 *
 *  These are not tuning knobs, they are statements about how a taker order behaves on this
 *  venue. `optimistic` assumes the whole eligible flow in five seconds is available;
 *  `realistic` assumes a quarter of it over thirty seconds; `conservative` assumes a
 *  twentieth over two minutes, which is roughly what a small, slow, price-insensitive
 *  participant gets when others are also taking.
 */
export type FillProfile = "optimistic" | "realistic" | "conservative";

export const PROFILES: Record<FillProfile, { windowSec: number; participation: bigint }> = {
  optimistic: { windowSec: 5, participation: 100n },
  realistic: { windowSec: 30, participation: 25n },
  conservative: { windowSec: 120, participation: 5n },
};

export type MatchRequest = {
  side: "buy" | "sell";
  /** Desired size, raw base units. */
  size: bigint;
  /** Worst acceptable price, raw quote per whole base. Null means no limit. */
  limit: bigint | null;
  /** Decision time plus latency: the first second the order can be in the market. */
  eligibleAt: number;
};

export type MatchResult = {
  filled: bigint;
  /** Raw quote paid/received for `filled`, from the consumed rows. */
  quote: bigint;
  /** Size-weighted average price, raw quote per whole base, floored to a tick. */
  vwap: bigint | null;
  /** Timestamp of the last print consumed; null when nothing filled. */
  filledAt: number | null;
  reason: "filled" | "partial" | "no-liquidity";
  consumedFillIds: string[];
  /** Eligible tape volume in the window, before the participation fraction. */
  windowVolume: bigint;
  /** The most this order was allowed to take. */
  volumeCap: bigint;
  windowSec: number;
  fromSec: number;
  toSec: number;
  profile: FillProfile;
};

/**
 *  Match one market order against the trade tape.
 *
 *  A buy taker consumes resting asks, so the prints that prove ask liquidity existed are the
 *  ones where the aggressor was also a bid (`takerIsBid === true`); a sell taker is the
 *  mirror. Using the opposite side would price a buy at the bid — the maker's price — which
 *  is systematically too favourable and is the single easiest way to fake a backtest.
 *  Fills are consumed in tape order, skipping any print outside the limit, which is how a
 *  limit order behaves when the market crosses its price only briefly.
 *
 *  There is no substitute for missing flow: a window with no eligible prints returns
 *  `no-liquidity` rather than the mark, because a backtest that silently fills at the mark
 *  is reporting a trade that never existed.
 */
export function matchAgainstTape(
  tape: readonly TapeFill[],
  req: MatchRequest,
  profile: FillProfile,
  cfg: MarketConfig,
): MatchResult {
  const { windowSec, participation } = PROFILES[profile];
  const fromSec = req.eligibleAt;
  const toSec = req.eligibleAt + windowSec;
  const aggressorIsBid = req.side === "buy";

  const eligible = tape.filter(
    (f) => f.t >= fromSec && f.t < toSec && f.takerIsBid === aggressorIsBid,
  );
  const windowVolume = eligible.reduce((sum, f) => sum + f.size, 0n);
  const volumeCap = (windowVolume * participation) / 100n;

  const target = req.size < volumeCap ? req.size : volumeCap;
  let filled = 0n;
  let quote = 0n;
  let filledAt: number | null = null;
  const consumed: string[] = [];
  if (target > 0n) {
    for (const f of eligible) {
      if (filled >= target) break;
      if (req.limit !== null) {
        if (req.side === "buy" ? f.price > req.limit : f.price < req.limit) continue;
      }
      let take = f.size;
      const room = target - filled;
      if (take > room) take = room;
      const lot = cfg.lotSize;
      take = (take / lot) * lot;
      if (take === 0n) continue;
      filled += take;
      quote += (take * f.price) / cfg.oneBase;
      filledAt = f.t;
      consumed.push(f.id);
    }
  }

  const vwap = filled === 0n ? null : roundToTick((quote * cfg.oneBase) / filled, cfg.tickSize);
  return {
    filled,
    quote,
    vwap,
    filledAt,
    reason: filled === 0n ? "no-liquidity" : filled < req.size ? "partial" : "filled",
    consumedFillIds: consumed,
    windowVolume,
    volumeCap,
    windowSec,
    fromSec,
    toSec,
    profile,
  };
}

function roundToTick(price: bigint, tick: bigint): bigint {
  if (tick <= 1n) return price;
  const rem = price % tick;
  return rem * 2n >= tick ? price + (tick - rem) : price - rem;
}
