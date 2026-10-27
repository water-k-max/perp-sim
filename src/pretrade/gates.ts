import { perpLiquidationPrice, perpPositionAnalytics } from "@somnia-chain/markets-sdk";
import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import type { MarketConfig } from "../history/market.js";
import type { Side } from "../engine/simulate.js";

export type Intent = {
  side: Side;
  /** Raw base units, positive. */
  size: bigint;
  /** Limit price, raw quote units per whole base. */
  price: bigint;
};

export type Verdict = "pass" | "fail" | "warn";

export type Check = {
  id: string;
  verdict: Verdict;
  detail: string;
};

export type GateReport = {
  placeable: boolean;
  /** The first failing check, i.e. the thing to fix. */
  binding: string | null;
  checks: Check[];
  lock: bigint;
  initialMargin: bigint;
  adverseGap: bigint;
  liquidationPrice: bigint | null;
};

const BPS = 10_000n;

export function divCeil(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/**
 *  What the pool would reserve for an increasing order on a flat account: the OI-scaled
 *  initial margin plus the adverse mark-to-entry gap. A `notional x IMF` estimate misses
 *  the second term, and it is the usual reason a sized-to-max order reverts.
 */
export function lockFor(
  cfg: MarketConfig,
  intent: Intent,
  markPrice: bigint,
  imfBps: bigint = cfg.effectiveImfBps,
) {
  const notional = (intent.size * intent.price) / cfg.oneBase;
  const initialMargin = divCeil(notional * imfBps, BPS);
  const gapPerBase = intent.side === "long" ? intent.price - markPrice : markPrice - intent.price;
  const adverseGap =
    gapPerBase > 0n ? (gapPerBase * intent.size) / cfg.oneBase : 0n;
  const fee = (notional * cfg.takerFeeBpsTimes1k) / (BPS * 1_000n);
  return { notional, initialMargin, adverseGap, lock: initialMargin + adverseGap, fee };
}

/**
 *  Every placement gate that can be answered from market config plus one mark, before any
 *  contract preview is consulted.
 *
 *  `previewPerpOrderMargin` is the documented accurate gate, and it is still a statement
 *  about one block: these static checks are grid and ceiling facts that do not move, so
 *  they are worth failing fast on their own.
 */
export function staticGates(
  cfg: MarketConfig,
  intent: Intent,
  ctx: { cash: bigint; markPrice: bigint; openInterest: bigint },
): GateReport {
  const checks: Check[] = [];
  const push = (id: string, ok: boolean, detail: string, warnOnly = false): void => {
    checks.push({ id, verdict: ok ? "pass" : warnOnly ? "warn" : "fail", detail });
  };

  push("minQuantity", intent.size >= cfg.minQuantity, `size ${intent.size} vs min ${cfg.minQuantity}`);
  push("lotSize", intent.size % cfg.lotSize === 0n, `size ${intent.size} mod lot ${cfg.lotSize} = ${intent.size % cfg.lotSize}`);
  push("tickSize", intent.price % cfg.tickSize === 0n, `price ${intent.price} mod tick ${cfg.tickSize} = ${intent.price % cfg.tickSize}`);
  push("maxPositionSize", intent.size <= cfg.maxPositionSize, `size ${intent.size} vs max ${cfg.maxPositionSize}`);

  const notionalBase = (ctx.openInterest + intent.size);
  push(
    "maxOpenInterest",
    notionalBase <= cfg.maxOpenInterest,
    `pool OI + this order ${notionalBase} vs cap ${cfg.maxOpenInterest}`,
  );

  const { notional, initialMargin, adverseGap, lock, fee } = lockFor(cfg, intent, ctx.markPrice);
  push(
    "collateral",
    lock + fee <= ctx.cash,
    `lock ${lock} + fee headroom ${fee} vs collateral ${ctx.cash} (notional ${notional})`,
  );
  push(
    "adverseGap",
    adverseGap === 0n,
    adverseGap === 0n
      ? "entry is on the favourable side of the mark"
      : `entering ${adverseGap} underwater against the mark, reserved on top of initial margin`,
    true,
  );

  const signed = intent.side === "long" ? intent.size : -intent.size;
  // The lock reserves collateral but does not spend it, so equity is the balance plus what
  // the position is worth the instant it fills — which is where the adverse gap reappears.
  const atFill = perpPositionAnalytics({
    size: signed,
    avgEntryPrice: intent.price,
    entryFundingIndex: 0n,
    markPrice: ctx.markPrice,
    projectedCumulativeFunding: 0n,
    oneBase: cfg.oneBase,
    effectiveImfBps: cfg.effectiveImfBps,
    maintenanceMarginBps: cfg.mmBps,
    closeOutMarginBps: cfg.closeOutBps,
  });
  const liquidationPrice = perpLiquidationPrice({
    equity: ctx.cash + atFill.equityContribution,
    mmReq: atFill.maintenanceMarginRequirement,
    size: signed,
    markPrice: ctx.markPrice,
    maintenanceMarginBps: cfg.mmBps,
    oneBase: cfg.oneBase,
  });

  const failed = checks.find((c) => c.verdict === "fail");
  return {
    placeable: failed === undefined,
    binding: failed?.id ?? null,
    checks,
    lock,
    initialMargin,
    adverseGap,
    liquidationPrice,
  };
}

/**
 *  Ask the chain the same question, so a disagreement is visible instead of silent.
 *
 *  `meetsPerpImForFill` is context, not a verdict: its own doc says it "does not model the
 *  lock's adverse mark-to-entry reserve; previewPerpOrderMargin is the accurate gate", so a
 *  true here can still be an order the pool refuses to fund.
 */
export async function contractGates(
  client: SomniaMarketsClient,
  cfg: MarketConfig,
  account: `0x${string}`,
  intent: Intent,
): Promise<{ preview: unknown; maxSize: unknown; coldProbe: boolean }> {
  const base = { pool: cfg.pool as `0x${string}`, marginBank: cfg.marginBank as `0x${string}`, account };
  // Direction travels in `isBid`, never in the sign of the quantity. The pool's own view is
  // `meetsIMForFill(address, address, uint256 additionalSize, uint256 orderPrice)`, and
  // `perpOrderMarginQuote` derives its reducing/increasing split from `isBid` too. A
  // negative quantity is not rejected: `previewPerpOrderMargin` hands back a NEGATIVE
  // `lockAmount` and reports both gates satisfied for an order the unsigned call says
  // cannot be funded. `pnpm validate` prints that pair.
  const [preview, maxSize, coldProbe] = await Promise.all([
    client.previewPerpOrderMargin({ ...base, isBid: intent.side === "long", quantity: intent.size, price: intent.price }),
    client.getMaxPerpOrderSize({ ...base, isBid: intent.side === "long", price: intent.price }),
    client.meetsPerpImForFill({ ...base, additionalSize: intent.size, price: intent.price }),
  ]);
  return { preview, maxSize, coldProbe };
}

/** Mark-to-market of the hypothetical fill, with the same kernel the backtest trail uses. */
export function positionAtFill(
  cfg: MarketConfig,
  intent: Intent,
  markPrice: bigint,
  entryCum: bigint,
  projectedCum: bigint,
) {
  return perpPositionAnalytics({
    size: intent.side === "long" ? intent.size : -intent.size,
    avgEntryPrice: intent.price,
    entryFundingIndex: entryCum,
    markPrice,
    projectedCumulativeFunding: projectedCum,
    oneBase: cfg.oneBase,
    effectiveImfBps: cfg.effectiveImfBps,
    maintenanceMarginBps: cfg.mmBps,
    closeOutMarginBps: cfg.closeOutBps,
  });
}
