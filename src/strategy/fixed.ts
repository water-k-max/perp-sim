import type { Strategy, StrategyContext } from "./types.js";
import { paramBigInt, paramNumber } from "./types.js";

/**
 *  The legacy backtest as a strategy: one fixed lot, opened at a chosen bar, held to the end.
 *
 *  With `fillModel: "settlement-mark"` this must reproduce the old `simulate()` result bit for
 *  bit, which is what the golden test asserts — the strategy interface is only trusted once
 *  the old answer can be rebuilt through it.
 */
export type FixedParams = {
  side: "long" | "short";
  /** Raw base units. */
  size: bigint;
  /** Bar index to open at. Defaults to 1, matching the legacy entry. */
  atBar: number;
};

export const fixedParams = (p: Strategy["params"]): FixedParams => ({
  side: p.side === "short" ? "short" : "long",
  size: paramBigInt(p, "size", 0n),
  atBar: paramNumber(p, "atBar", 1),
});

export function fixedPosition(params: FixedParams): Strategy {
  const meta = { side: params.side, size: params.size.toString(), atBar: params.atBar };
  let done = false;
  return {
    id: "fixed",
    params: meta,
    onBar(ctx: StrategyContext) {
      // A decision on bar i fills on bar i + 1 under the settlement-mark model, so the
      // order is submitted one bar early to open on `atBar` itself.
      if (done || ctx.index + 1 !== params.atBar) return;
      if (params.size <= 0n) {
        ctx.log("fixed strategy has no size; nothing to do");
        done = true;
        return;
      }
      ctx.submit({ side: params.side === "long" ? "buy" : "sell", size: params.size, tag: "entry" });
      done = true;
    },
  };
}
