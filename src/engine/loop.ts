import { perpLiquidationPrice } from "@somnia-chain/markets-sdk";
import { canonical, sha256 } from "../data/store.js";
import { applyParams, type ParameterTimeline } from "../data/params.js";
import type { TapeSource } from "../data/tape.js";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { feeBps } from "../history/market.js";
import type { ModeledFill, OrderRequest, Strategy, StrategyContext } from "../strategy/types.js";
import { EventQueue } from "./clock.js";
import { PROFILES, type FillProfile } from "./fills.js";
import type { TapeFill } from "../data/types.js";
import type { ChainPosition } from "./clock.js";
import { PositionBook, type ClosedTrade } from "./portfolio.js";
import type { BarTrail } from "./simulate.js";

export type FillModel = "settlement-mark" | "tape";

export type RunInput = {
  /** Live config. Only fields no epoch carries are taken from it unchanged. */
  cfg: MarketConfig;
  bars: Bar[];
  cash: bigint;
  strategy: Strategy;
  fillModel: FillModel;
  fillProfile?: FillProfile;
  /** Seconds between a bar-close decision and the order reaching the market. Defaults to 1 s. */
  latencySec?: number;
  /** Native gas per executed order, in raw quote units. Defaults to zero. */
  gasPerTx?: bigint;
  /** Required when `fillModel` is `tape`. */
  tape?: TapeSource;
  /** Per-block risk/fee parameters. Without it every bar uses `cfg`. */
  params?: ParameterTimeline;
  /** Close any open position at `untilBar`'s mark. Defaults to true. */
  closeAtEnd?: boolean;
  untilBar?: number;
};

export type OrderOutcome = {
  id: string;
  side: "buy" | "sell";
  requested: bigint;
  limit: bigint | null;
  reduceOnly: boolean;
  tag: string | null;
  decidedAt: number;
  /** Chain cursor observed when the strategy submitted this order, when available. */
  decidedBlock?: number;
  decidedLogIndex?: number;
  eligibleAt: number;
  status: "filled" | "partial" | "rejected";
  filled: bigint;
  price: bigint | null;
  reason: string | null;
};

export type RunModel = {
  fillModel: FillModel;
  profile: FillProfile | null;
  latencySec: number;
  windowSec: number | null;
  gasPerTx: bigint;
  /** v2: causal per-print participation, shared tape capacity, event-position epochs. */
  revision?: number;
};

export type RunResult = {
  strategy: { id: string; params: Record<string, string | number | boolean> };
  status: "open" | "closed" | "liquidated";
  bars: number;
  barsHeld: number;
  equityStart: bigint;
  equityEnd: bigint;
  realizedPnl: bigint;
  fundingSettled: bigint;
  fundingOpen: bigint;
  feesTaker: bigint;
  feesMaker: bigint;
  gasPaid: bigint;
  roiBps: bigint | null;
  minEquity: bigint;
  minEquityBar: number | null;
  liquidatedAtBar: number | null;
  liquidatedAtPrice: bigint | null;
  closedAtBar: number | null;
  trail: BarTrail[];
  fills: ModeledFill[];
  orders: OrderOutcome[];
  trades: ClosedTrade[];
  logs: string[];
  model: RunModel;
  /** Hashes everything the run did, so two identical replays can be compared. */
  eventHash: string;
};

type Pending = {
  outcome: OrderOutcome;
  req: OrderRequest;
  index: number;
  /** Exact sum of executed price * quantity, before VWAP division. */
  priceQuantity: bigint;
  /** The settlement bar whose mark prices this order, for the settlement-mark model. */
  refBar: Bar | null;
};

type Work = { kind: "bar"; index: number } | { kind: "order"; pending: Pending }
  | { kind: "fill"; pending: Pending; print: TapeFill };

const chainPosition = (row: { block?: number; logIndex?: number }): ChainPosition | undefined =>
  row.block === undefined ? undefined : { block: row.block, logIndex: row.logIndex ?? Number.MAX_SAFE_INTEGER };

const BPS = 10_000n;

/**
 *  Replay a strategy over settlement bars, booking every fill through one position book.
 *
 *  The loop is event-driven rather than a bar loop with a strategy hook bolted on, because
 *  the order of a single second decides the result: an order submitted at a bar's close is
 *  filled before that bar is marked under the tape model only if it lands earlier, and the
 *  queue is what makes that ordering explicit and hashable.
 */
export async function run(input: RunInput): Promise<RunResult> {
  const { bars, cfg, strategy, fillModel } = input;
  if (bars.length === 0) throw new Error("no bars to replay");
  if (fillModel === "tape" && !input.tape) throw new Error("the tape fill model needs a tape source");
  const profile = fillModel === "tape" ? (input.fillProfile ?? "realistic") : null;
  const latencySec = input.latencySec ?? 1;
  const gasPerTx = input.gasPerTx ?? 0n;
  const windowSec = profile ? PROFILES[profile].windowSec : null;
  if (!Number.isFinite(latencySec) || latencySec < 0) throw new Error("invalid latency");
  const model: RunModel = { fillModel, profile, latencySec, windowSec, gasPerTx, revision: 2 };

  const book = new PositionBook(cfg, input.cash);
  const trail: BarTrail[] = [];
  const fills: ModeledFill[] = [];
  const orders: OrderOutcome[] = [];
  const logs: string[] = [];
  const untilBar = Math.min(input.untilBar ?? bars.length - 1, bars.length - 1);

  const queue = new EventQueue<Work>();
  for (let i = 0; i <= untilBar; i += 1) queue.push(bars[i]!.t, "bar", { kind: "bar", index: i }, chainPosition(bars[i]!));
  const horizon = bars[untilBar]!.t;
  const used = new Map<string, bigint>();
  let now = bars[0]!.t;
  let cursor: ChainPosition | undefined;
  const resolve = (t: number, pos?: ChainPosition): void => {
    if (input.params) book.cfg = applyParams(cfg, pos ? input.params.atPosition(pos.block, pos.logIndex) : input.params.at(t));
  };

  let liquidatedAtBar: number | null = null;
  let liquidatedAtPrice: bigint | null = null;
  let closedAtBar: number | null = null;
  let minEquity = input.cash;
  let minEquityBar: number | null = null;
  let barsHeld = 0;
  let prevCum = bars[0]!.cum;
  let currentBar = 0;
  let orderCounter = 0;
  let done = false;

  const position = () => {
    const bar = bars[currentBar]!;
    const at = book.mark(bar);
    const entryPrice =
      book.lots.length === 0
        ? null
        : book.lots.reduce((sum, lot) => sum + lot.price * abs(lot.size), 0n) /
          book.lots.reduce((sum, lot) => sum + abs(lot.size), 0n);
    return { size: at.size, entryPrice, unrealized: at.unrealized, accruedFunding: at.accrued, equity: at.equity };
  };

  const ctxFor = (index: number): StrategyContext => {
    const bar = bars[index]!;
    return {
      now,
      index,
      bar,
      cfg: book.cfg,
      book,
      position,
      equity: () => book.mark(bar).equity,
      submit: (req) => submit(index, req),
      close: (tag) => {
        if (book.isFlat) return;
        submit(index, {
          side: book.size > 0n ? "sell" : "buy",
          size: abs(book.size),
          reduceOnly: true,
          tag: tag ?? "close",
        });
      },
      log: (message) => logs.push(`${now} ${message}`),
    };
  };

  const submit = (index: number, req: OrderRequest): void => {
    if (req.size <= 0n) return;
    orderCounter += 1;
    const id = `${strategy.id}-${orderCounter}`;
    const decidedAt = now;
    const next = index + 1 <= untilBar ? bars[index + 1]! : null;
    const outcome: OrderOutcome = {
      id,
      side: req.side,
      requested: req.size,
      limit: req.limit ?? null,
      reduceOnly: req.reduceOnly === true,
      tag: req.tag ?? null,
      decidedAt,
      ...(cursor ? { decidedBlock: cursor.block, decidedLogIndex: cursor.logIndex } : {}),
      eligibleAt: fillModel === "tape" ? decidedAt + latencySec : (next?.t ?? decidedAt),
      status: "rejected",
      filled: 0n,
      price: null,
      reason: null,
    };
    if (fillModel === "settlement-mark" && !next) {
      outcome.reason = "no later bar to fill against";
      orders.push(outcome);
      return;
    }
    orders.push(outcome);
    const pending: Pending = { outcome, req, index, priceQuantity: 0n, refBar: fillModel === "settlement-mark" ? next : null };
    const at = fillModel === "settlement-mark" ? next!.t : decidedAt + latencySec;
    queue.push(at, fillModel === "tape" ? "order" : "fill", { kind: "order", pending }, next && fillModel === "settlement-mark" ? chainPosition(next) : undefined);
  };

  /** Size after reduce-only clamping, and why a reduce-only order is impossible. */
  const clamp = (req: OrderRequest): { size: bigint; reason: string | null } => {
    if (!req.reduceOnly) return { size: req.size, reason: null };
    const size = book.size;
    if (size === 0n) return { size: 0n, reason: "reduce-only on a flat position" };
    if ((size > 0n && req.side === "buy") || (size < 0n && req.side === "sell")) {
      return { size: 0n, reason: "reduce-only order would increase the position" };
    }
    const room = abs(size);
    return { size: req.size < room ? req.size : room, reason: null };
  };

  const bookFill = (pending: Pending, price: bigint, size: bigint, quote: bigint, t: number, consumed: string[], pos?: ChainPosition): ModeledFill => {
    const bar = bars[currentBar]!;
    const execution = book.execute(pending.req.side, size, {
      t,
      price,
      role: "taker",
      cum: bar.cum,
      gas: pending.outcome.filled === 0n ? gasPerTx : 0n,
    });
    const fill: ModeledFill = {
      id: `${pending.outcome.id}#fill-${fills.length + 1}`,
      ...pos,
      orderId: pending.outcome.id,
      side: pending.req.side,
      size,
      price,
      quote,
      t,
      role: "taker",
      fee: execution.fee,
      feeBps: feeBps(book.cfg, "taker"),
      consumedFillIds: consumed,
      tag: pending.req.tag ?? null,
    };
    fills.push(fill);
    return fill;
  };

  const fillSettlement = (pending: Pending): void => {
    const ref = pending.refBar!;
    resolve(ref.t, chainPosition(ref));
    const { size, reason } = clamp(pending.req);
    if (size === 0n) {
      pending.outcome.reason = reason;
      return;
    }
    if (pending.req.limit !== undefined) {
      const limit = pending.req.limit;
      const breaches = pending.req.side === "buy" ? ref.mark > limit : ref.mark < limit;
      if (breaches) {
        pending.outcome.reason = "settlement mark outside the limit";
        return;
      }
    }
    const price = ref.mark;
    const quote = (size * price) / book.cfg.oneBase;
    const refIndex = pending.index + 1;
    currentBar = refIndex;
    const fill = bookFill(pending, price, size, quote, ref.t, [], chainPosition(ref));
    pending.outcome.status = "filled";
    pending.outcome.filled = size;
    pending.outcome.price = price;
    strategy.onFill?.(ctxFor(refIndex), fill);
  };

  const fillTape = async (pending: Pending): Promise<void> => {
    const eligibleAt = pending.outcome.eligibleAt;
    if (eligibleAt > horizon) return;
    const end = eligibleAt + PROFILES[profile!].windowSec;
    const slice = await input.tape!.slice(eligibleAt, Math.min(end, horizon));
    if (!slice.complete || slice.truncated) {
      logs.push(`${eligibleAt} tape slice incomplete (${slice.fills.length} rows, ${slice.pages} pages)`);
    }
    pending.outcome.reason = `no eligible tape in ${PROFILES[profile!].windowSec}s window`;
    for (const print of slice.fills) {
      if (print.t < eligibleAt || print.t >= end || print.t > horizon) continue;
      // A zero-latency callback cannot consume a print already observed at this second.
      if (print.t === now && cursor && (print.block < cursor.block ||
        (print.block === cursor.block && print.logIndex <= cursor.logIndex))) continue;
      queue.push(print.t, "fill", { kind: "fill", pending, print }, chainPosition(print));
    }
  };

  const executePrint = (pending: Pending, print: TapeFill): void => {
    const outcome = pending.outcome;
    if (outcome.filled >= pending.req.size || print.takerIsBid !== (pending.req.side === "buy")) return;
    const limit = pending.req.limit;
    if (limit !== undefined && (pending.req.side === "buy" ? print.price > limit : print.price < limit)) return;
    resolve(print.t, chainPosition(print));
    const room = clamp({ ...pending.req, size: pending.req.size - outcome.filled });
    const capacity = print.size * PROFILES[profile!].participation / 100n - (used.get(print.id) ?? 0n);
    let size = room.size < capacity ? room.size : capacity;
    size = size / book.cfg.lotSize * book.cfg.lotSize;
    if (size <= 0n) return;
    const fill = bookFill(pending, print.price, size, size * print.price / book.cfg.oneBase, print.t, [print.id], chainPosition(print));
    used.set(print.id, (used.get(print.id) ?? 0n) + size);
    pending.priceQuantity += print.price * size;
    outcome.filled += size;
    outcome.price = pending.priceQuantity / outcome.filled;
    outcome.status = outcome.filled < outcome.requested ? "partial" : "filled";
    outcome.reason = outcome.status === "partial" ? "unfilled remainder cancelled at window expiry or run end" : null;
    strategy.onFill?.(ctxFor(currentBar), fill);
  };

  const onBar = (index: number): void => {
    currentBar = index;
    const bar = bars[index]!;
    resolve(bar.t, chainPosition(bar));

    const at = book.mark(bar);
    const fundingThisBar = book.accruedBetween(bar, prevCum);
    const flat = book.isFlat;
    if (!flat) barsHeld += 1;

    // The adverse extreme only matters when the position is open; a flat book has no risk.
    const signed = at.size;
    const worst = signed > 0n ? bar.low : bar.high;
    const adverse = !flat && worst !== null && (signed > 0n ? worst < bar.mark : worst > bar.mark);
    const stressed = adverse ? book.mark(bar, worst!) : null;
    const equity = stressed?.equity ?? at.equity;
    const mmReq = stressed?.mmReq ?? at.mmReq;

    trail.push({
      bar: index,
      t: bar.t,
      mark: bar.mark,
      markSource: bar.markSource,
      worstPrice: adverse ? worst : null,
      size: at.size,
      notional: at.notional,
      unrealizedPnl: at.unrealized,
      fundingAccrued: at.accrued,
      fundingThisBar,
      equityAtMark: at.equity,
      equity,
      maintenanceMargin: mmReq,
      healthBps: mmReq === 0n ? BPS * 100n : (equity * BPS) / mmReq,
      liquidationPrice: flat
        ? null
        : perpLiquidationPrice({
            equity: at.equity,
            mmReq: at.mmReq,
            size: at.size,
            markPrice: bar.mark,
            maintenanceMarginBps: book.cfg.mmBps,
            oneBase: book.cfg.oneBase,
          }),
    });

    if (minEquityBar === null || equity < minEquity) {
      minEquity = equity;
      minEquityBar = index;
    }

    if (!flat && equity < mmReq) {
      liquidatedAtBar = index;
      liquidatedAtPrice = adverse ? worst : bar.mark;
      done = true;
      return;
    }

    strategy.onBar(ctxFor(index));

    if (index === untilBar) {
      if ((input.closeAtEnd ?? true) && !book.isFlat) {
        const req: OrderRequest = { side: book.size > 0n ? "sell" : "buy", size: abs(book.size), reduceOnly: true, tag: "terminal-close" };
        const outcome: OrderOutcome = {
          id: `${strategy.id}-${++orderCounter}`, side: req.side, requested: req.size,
          limit: null, reduceOnly: true, tag: "terminal-close", decidedAt: bar.t, eligibleAt: bar.t,
          status: "filled", filled: 0n, price: bar.mark, reason: null,
        };
        orders.push(outcome);
        bookFill({ outcome, req, index, priceQuantity: 0n, refBar: bar }, bar.mark, req.size,
          req.size * bar.mark / book.cfg.oneBase, bar.t, [], chainPosition(bar));
        outcome.filled = req.size;
        closedAtBar = index;
      }
      done = true;
    }
    prevCum = bar.cum;
  };

  resolve(bars[0]!.t, chainPosition(bars[0]!));
  strategy.onStart?.({ now: bars[0]!.t, cfg: book.cfg, log: (m) => logs.push(m) });

  while (!done) {
    const event = queue.shift();
    if (!event || event.t > horizon) break;
    if (event.t !== now) cursor = undefined;
    now = event.t;
    if (event.position) cursor = event.position;
    else if (event.payload.kind === "bar") cursor = { block: Number.MAX_SAFE_INTEGER, logIndex: Number.MAX_SAFE_INTEGER };
    if (event.payload.kind === "bar") onBar(event.payload.index);
    else if (event.payload.kind === "fill") executePrint(event.payload.pending, event.payload.print);
    else if (fillModel === "tape") await fillTape(event.payload.pending);
    else fillSettlement(event.payload.pending);
  }
  queue.clear();

  for (const order of orders) {
    if (order.status === "rejected" && order.reason === null) {
      order.reason = "run ended before the order could fill";
    }
  }

  const last = trail[trail.length - 1];
  const equityEnd = book.isFlat ? book.cash : (last?.equityAtMark ?? book.cash);
  const status = liquidatedAtBar !== null ? "liquidated" : book.isFlat ? "closed" : "open";
  const result: RunResult = {
    strategy: { id: strategy.id, params: { ...strategy.params } },
    status,
    bars: bars.length,
    barsHeld,
    equityStart: input.cash,
    equityEnd,
    realizedPnl: book.realizedPnl,
    fundingSettled: book.fundingSettled,
    fundingOpen: book.isFlat ? 0n : (last?.fundingAccrued ?? 0n),
    feesTaker: book.feesTaker,
    feesMaker: book.feesMaker,
    gasPaid: book.gasPaid,
    roiBps: input.cash === 0n ? null : ((equityEnd - input.cash) * BPS) / input.cash,
    minEquity,
    minEquityBar,
    liquidatedAtBar,
    liquidatedAtPrice,
    closedAtBar,
    trail,
    fills,
    orders,
    trades: book.trades,
    logs,
    model,
    eventHash: "",
  };
  strategy.onEnd?.({ now, book, equity: equityEnd, log: (m) => logs.push(m) });
  result.eventHash = hashRun(result);
  return result;
}

/** A stable digest of everything the replay decided. Equal hashes mean equal runs. */
export function hashRun(result: RunResult): string {
  const { eventHash: _eventHash, ...finalized } = result;
  return sha256(canonical(finalized));
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
