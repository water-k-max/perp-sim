import type { Strategy, StrategyContext } from "./types.js";
import { paramBigInt, paramNumber } from "./types.js";

/**
 *  A moving-average crossover, there to prove the interface is a real strategy surface and
 *  not a wrapper around the legacy one-shot entry. It is deliberately plain: it holds a
 *  fixed size in the direction of the fast/slow relation and flips when that relation does.
 */
export type SmaParams = {
  fast: number;
  slow: number;
  size: bigint;
  side: "long" | "short" | "both";
};

export const smaParams = (p: Strategy["params"]): SmaParams => ({
  fast: Math.max(1, paramNumber(p, "fast", 6)),
  slow: Math.max(2, paramNumber(p, "slow", 24)),
  size: paramBigInt(p, "size", 0n),
  side: p.side === "short" ? "short" : p.side === "both" ? "both" : "long",
});

const sma = (marks: bigint[], end: number, span: number): bigint | null => {
  if (end + 1 < span) return null;
  let sum = 0n;
  for (let i = end - span + 1; i <= end; i += 1) sum += marks[i]!;
  return sum / BigInt(span);
};

export function smaCross(params: SmaParams): Strategy {
  const slow = Math.max(params.slow, params.fast + 1);
  const marks: bigint[] = [];
  let target = 0n;

  return {
    id: "sma",
    params: { fast: params.fast, slow, size: params.size.toString(), side: params.side },
    onBar(ctx: StrategyContext) {
      marks.push(ctx.bar.mark);
      const i = marks.length - 1;
      const fast = sma(marks, i, params.fast);
      const slowAvg = sma(marks, i, slow);
      if (fast === null || slowAvg === null) return;

      let want = target;
      if (fast > slowAvg) want = 1n;
      else if (fast < slowAvg) want = -1n;

      if (params.side === "long" && want < 0n) want = 0n;
      if (params.side === "short" && want > 0n) want = 0n;
      if (want === target) return;
      target = want;

      const desired = want * params.size;
      const delta = desired - ctx.book.size;
      if (delta === 0n) return;
      ctx.submit({
        side: delta > 0n ? "buy" : "sell",
        size: delta > 0n ? delta : -delta,
        tag: want === 0n ? "flat" : want > 0n ? "long" : "short",
      });
    },
  };
}
