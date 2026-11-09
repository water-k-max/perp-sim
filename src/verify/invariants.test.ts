import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { run, type RunResult } from "../engine/loop.js";
import { fixedPosition } from "../strategy/fixed.js";
import type { TapeFill } from "../data/types.js";
import type { TapeSource } from "../data/tape.js";
import { checkRun, invariantsOk } from "./invariants.js";

const E18 = 10n ** 18n;
const oneBase = 10n ** 8n;

const cfg: MarketConfig = {
  symbol: "BTC", quoteSymbol: "USDso", pool: "0xpool", marginBank: "0xbank", stopRegistry: null,
  baseDecimals: 8, quoteDecimals: 18, oneBase, tickSize: 1n, lotSize: 1n, minQuantity: 1n,
  imBps: 500n, mmBps: 250n, closeOutBps: 125n, effectiveImfBps: 500n,
  maxPositionSize: 10n ** 30n, maxOpenInterest: 10n ** 30n,
  takerFeeBpsTimes1k: 10_000n, makerFeeBpsTimes1k: 0n,
  fundingWindowSec: 3600, fundingIntervalSec: 3600, imBpsMismatch: false,
};

const bars: Bar[] = [100n, 101n, 99n, 103n, 102n, 104n].map((whole, i) => {
  const mark = whole * E18;
  return {
    t: 1_000 + i * 3_600, mark, markSource: "mark", indexPrice: mark,
    cum: BigInt(i) * 10n ** 30n, fundingDelta: 10n ** 30n, rate: 0n,
    fundingWindowSec: 3600, fundingIntervalSec: 3600, intervalsSettled: 1, intervalsAccrued: 1,
    forgivenIntervals: 0, anchorResynced: false, gapSec: 3600, missedIntervals: 0,
    low: mark - E18, high: mark + E18, candles: 1,
  };
});

const clean = async (): Promise<RunResult> =>
  run({ cfg, bars, cash: 1_000n * E18, strategy: fixedPosition({ side: "long", size: oneBase, atBar: 1 }), fillModel: "settlement-mark" });

const failed = (list: ReturnType<typeof checkRun>, id: string) => list.find((i) => i.id === id)?.status === "fail";

test("a clean run passes every check that can be evaluated here", async () => {
  const out = await clean();
  const list = checkRun(out);
  assert.equal(invariantsOk(list), true, JSON.stringify(list.filter((i) => i.status === "fail")));
  assert.equal(list.find((i) => i.id === "equity-identity")?.status, "pass");
  assert.equal(list.find((i) => i.id === "book-not-crossed")?.status, "skip");
  assert.equal(list.find((i) => i.id === "coverage-complete")?.status, "skip");
});

test("a wrong fee is caught by re-deriving it from the fill", async () => {
  const out = await clean();
  out.fills[0] = { ...out.fills[0]!, fee: out.fills[0]!.fee + 1n };
  assert.equal(failed(checkRun(out), "fee-recompute"), true);
});

test("a fill before its own decision is caught as lookahead", async () => {
  const out = await clean();
  out.orders[0] = { ...out.orders[0]!, eligibleAt: out.orders[0]!.decidedAt - 1 };
  assert.equal(failed(checkRun(out), "no-lookahead"), true);
});

test("same-second fills must follow their decision block and log position", async () => {
  for (const [block, logIndex, expectedFailure] of [
    [9, 99, true], [10, 4, true], [10, 5, true], [10, 6, false], [11, 0, false],
  ] as const) {
    const out = await clean();
    const order = out.orders[0]!;
    order.decidedBlock = 10;
    order.decidedLogIndex = 5;
    order.eligibleAt = order.decidedAt;
    out.fills[0] = { ...out.fills[0]!, t: order.decidedAt, block, logIndex };
    assert.equal(failed(checkRun(out), "no-lookahead"), expectedFailure, `${block}:${logIndex}`);
  }
});

test("position checks retain compatibility with orders lacking a decision cursor", async () => {
  const out = await clean();
  const order = out.orders[0]!;
  delete order.decidedBlock;
  delete order.decidedLogIndex;
  order.eligibleAt = order.decidedAt;
  out.fills[0] = { ...out.fills[0]!, t: order.decidedAt, block: 1, logIndex: 0 };
  assert.equal(failed(checkRun(out), "no-lookahead"), false);
});

test("a cash mismatch breaks the equity identity", async () => {
  const out = await clean();
  out.equityEnd += 1n;
  assert.equal(failed(checkRun(out), "equity-identity"), true);
});

test("a quantity mismatch is caught", async () => {
  const out = await clean();
  out.fills[0] = { ...out.fills[0]!, size: out.fills[0]!.size + 1n };
  assert.equal(failed(checkRun(out), "quantity-identity"), true);
});

test("actual executions before eligibility or after termination fail chronology", async () => {
  for (const time of ["before", "after"] as const) {
    const out = await clean();
    out.fills[0]!.t = time === "before" ? out.orders[0]!.eligibleAt - 1 : out.trail.at(-1)!.t + 1;
    assert.equal(failed(checkRun(out), "no-lookahead"), true);
  }
});

test("terminal close is recorded and balances the final flat quantity", async () => {
  const out = await clean();
  assert.equal(out.fills.at(-1)!.tag, "terminal-close");
  assert.equal(out.orders.at(-1)!.tag, "terminal-close");
  assert.equal(failed(checkRun(out), "quantity-identity"), false);
  assert.match(checkRun(out).find(i => i.id === "determinism")!.detail, /not independent proof/);
});

test("a liquidated run books the breach close and passes the quantity and liquidation checks", async () => {
  const liqBars: Bar[] = [100n, 100n, 100n, 100n].map((whole, i) => {
    const mark = whole * E18;
    return {
      t: 1_000 + i * 3_600, mark, markSource: "mark", indexPrice: mark,
      cum: 0n, fundingDelta: 0n, rate: 0n,
      fundingWindowSec: 3600, fundingIntervalSec: 3600, intervalsSettled: 1, intervalsAccrued: 1,
      forgivenIntervals: 0, anchorResynced: false, gapSec: 3600, missedIntervals: 0,
      low: i === 2 ? 50n * E18 : mark, high: mark, candles: 1,
    };
  });
  const out = await run({ cfg, bars: liqBars, cash: 100n * E18,
    strategy: fixedPosition({ side: "long", size: 10n * oneBase, atBar: 1 }), fillModel: "settlement-mark" });
  assert.equal(out.status, "liquidated");
  assert.equal(out.liquidatedAtBar, 2);
  const list = checkRun(out);
  assert.equal(invariantsOk(list), true, JSON.stringify(list.filter((i) => i.status === "fail")));
  assert.equal(list.find((i) => i.id === "quantity-identity")?.status, "pass");
  const liq = list.find((i) => i.id === "liquidation-fill-modelled")!;
  assert.equal(liq.status, "pass");
  assert.match(liq.detail, /closed at the breach price/);
  // Removing the modeled close fill must trip the check, so it is not vacuous.
  out.fills = out.fills.filter((f) => f.tag !== "liquidation");
  assert.equal(failed(checkRun(out), "liquidation-fill-modelled"), true);
});

test("a liquidated tape run exempts the breach close from latency in no-lookahead", async () => {
  const liqBars: Bar[] = [0, 1, 2, 3, 4].map((i) => {
    const mark = 100n * E18;
    return {
      t: 1_000 + i * 3, mark, markSource: "mark", indexPrice: mark,
      cum: 0n, fundingDelta: 0n, rate: 0n,
      fundingWindowSec: 3600, fundingIntervalSec: 3600, intervalsSettled: 1, intervalsAccrued: 1,
      forgivenIntervals: 0, anchorResynced: false, gapSec: 3, missedIntervals: 0,
      low: i === 2 ? 0n : mark, high: mark, candles: 1,
    };
  });
  const print: TapeFill = {
    id: "1", block: 1, logIndex: 1, t: 1002, price: 100n * E18,
    size: 4n * oneBase, quote: 0n, takerIsBid: true, maker: null, taker: null, txHash: "0x",
  };
  const tape: TapeSource = {
    async slice(fromSec, toSec) {
      return { key: "fake", fromSec, toSec, fills: [print].filter((f) => f.t >= fromSec && f.t < toSec), complete: true, pages: 1, truncated: false };
    },
    consumed: () => [], digest: () => "fake",
  };
  const out = await run({ cfg, bars: liqBars, cash: 10n * E18, fillModel: "tape", fillProfile: "realistic", tape,
    strategy: { id: "liq-tape", params: {}, onBar(ctx) { if (ctx.index === 0) ctx.submit({ side: "buy", size: 2n * oneBase }); } },
  });
  assert.equal(out.status, "liquidated");
  // The latency path is genuinely active, so the exemption is what carries the check.
  assert.equal(out.model.fillModel, "tape");
  assert.ok(out.model.latencySec > 0);
  const liqOrder = out.orders.find((o) => o.tag === "liquidation")!;
  assert.equal(liqOrder.reduceOnly, true);
  assert.equal(liqOrder.eligibleAt, liqOrder.decidedAt);
  const list = checkRun(out);
  assert.equal(invariantsOk(list), true, JSON.stringify(list.filter((i) => i.status === "fail")));
  assert.equal(list.find((i) => i.id === "no-lookahead")?.status, "pass");
});

test("a tampered event hash fails determinism", async () => {
  const out = await clean();
  out.eventHash = "00";
  assert.equal(failed(checkRun(out), "determinism"), true);
});
