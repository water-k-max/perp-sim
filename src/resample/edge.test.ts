import assert from "node:assert/strict";
import { test } from "node:test";
import { nullTradeNet, runEdgeTest, EDGE_PATHS, type EdgeInputs } from "./edge.js";
import { buildResampleAnalysis, parseResampleRequest, type AnalysisInputs, type ResampleAnalysis } from "./analysis.js";
import { checkResample } from "../verify/invariants.js";
import { PositionBook } from "../engine/portfolio.js";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import type { TradeList, TradeRecord } from "./inputs.js";

const Q6 = 10n ** 6n;

const CFG: MarketConfig = {
  symbol: "TEST", quoteSymbol: "USDso", pool: "0x" + "1".repeat(40), marginBank: "0x" + "2".repeat(40),
  stopRegistry: null, baseDecimals: 6, quoteDecimals: 6, oneBase: Q6, tickSize: 10n, lotSize: 10n,
  minQuantity: 10n, imBps: 5000n, mmBps: 2500n, closeOutBps: 1250n, effectiveImfBps: 5000n,
  maxPositionSize: Q6, maxOpenInterest: 1000n * Q6, takerFeeBpsTimes1k: 500n, makerFeeBpsTimes1k: 100n,
  fundingWindowSec: 3600, fundingIntervalSec: 3600, imBpsMismatch: false,
};

function bar(t: number, mark: bigint, cum: bigint): Bar {
  return {
    t, block: 1, logIndex: 0, mark, markSource: "mark", indexPrice: mark,
    cum, fundingDelta: 0n, rate: 0n, fundingWindowSec: 3600, fundingIntervalSec: 3600,
    intervalsSettled: 1, intervalsAccrued: 1, forgivenIntervals: 0, anchorResynced: false,
    gapSec: 3600, missedIntervals: 0, low: null, high: null, candles: 0,
  };
}

/** Rising marks, flat funding index: null trades are priced purely by mark movement and fees. */
const BARS = [bar(0, 100n * Q6, 0n), bar(3600, 101n * Q6, 0n), bar(7200, 102n * Q6, 0n), bar(10800, 103n * Q6, 0n)];

function trade(partial: Partial<TradeRecord>): TradeRecord {
  return {
    entryTs: 0, exitTs: 3600, pnl: 0n, direction: "long", barsHeld: 1, sameBar: false,
    mae: null, mfe: null, worstPrice: null, bestPrice: null, excursionSource: "none",
    size: Q6, entryPrice: 0n, exitPrice: 0n, funding: 0n, fee: 0n, gas: 0n, seq: 1,
    ...partial,
  };
}

function list(trades: TradeRecord[]): TradeList {
  return { trades, sameBarCount: 0, withoutExcursionCount: 0, window: { from: 0, to: 3600 } };
}

function edgeInputs(trades: TradeRecord[], bars: readonly Bar[] = BARS, seed = "edge-fixture"): EdgeInputs {
  return { seed, list: list(trades), bars, cfg: CFG, quoteScale: Q6 };
}

test("a null trade is exactly the engine's own round trip: kernel funding, floored gross, closing-leg fee", () => {
  // Long held across two settlements with real funding movement.
  const moving = [
    bar(0, 100n * Q6, 1n << 62n),
    bar(3600, 102n * Q6, 3n << 62n),
    bar(7200, 99n * Q6, 8n << 62n),
  ];
  const cases: { side: "long" | "short"; entryIdx: number; holding: number; size: bigint }[] = [
    { side: "long", entryIdx: 0, holding: 2, size: 2n * Q6 },
    { side: "short", entryIdx: 0, holding: 2, size: 2n * Q6 },
    { side: "long", entryIdx: 1, holding: 1, size: Q6 },
    { side: "short", entryIdx: 1, holding: 1, size: Q6 },
    { side: "long", entryIdx: 2, holding: 0, size: 3n * Q6 },
    { side: "short", entryIdx: 0, holding: 0, size: Q6 },
  ];
  for (const c of cases) {
    const rec = trade({ direction: c.side, size: c.size });
    const nt = nullTradeNet(moving, c.entryIdx, c.holding, rec, CFG);

    const book = new PositionBook(CFG, 10_000n * Q6);
    const buy = c.side === "long";
    book.execute(buy ? "buy" : "sell", c.size, {
      t: moving[c.entryIdx]!.t, price: moving[c.entryIdx]!.mark, role: "taker", cum: moving[c.entryIdx]!.cum,
    });
    book.execute(buy ? "sell" : "buy", c.size, {
      t: moving[c.entryIdx + c.holding]!.t, price: moving[c.entryIdx + c.holding]!.mark, role: "taker", cum: moving[c.entryIdx + c.holding]!.cum,
    });
    const closed = book.trades[0]!;
    assert.equal(closed.size, c.size);
    assert.equal(nt.gross, closed.grossPnl, `${c.side} holding ${c.holding}: gross`);
    assert.equal(nt.funding, closed.funding, `${c.side} holding ${c.holding}: funding`);
    assert.equal(nt.fee, closed.fee, `${c.side} holding ${c.holding}: fee`);
    assert.equal(nt.net, closed.netPnl, `${c.side} holding ${c.holding}: net`);
  }
});

test("the null trades stay inside the bar range by construction", () => {
  for (let entryIdx = 0; entryIdx < BARS.length; entryIdx += 1) {
    for (let holding = 0; holding + entryIdx < BARS.length; holding += 1) {
      const nt = nullTradeNet(BARS, entryIdx, holding, trade({}), CFG);
      assert.ok(nt.exitIdx <= BARS.length - 1);
    }
  }
  assert.throws(() => nullTradeNet(BARS, 3, 1, trade({}), CFG), /out of the bar range/);
});

test("the edge test reports the recorded total exactly and a bounded p-value", () => {
  const outcome = runEdgeTest(edgeInputs([trade({ pnl: 3n * Q6 }), trade({ pnl: -1n * Q6, direction: "short" })]))!;
  assert.equal(outcome.paths, EDGE_PATHS);
  // fromRaw keeps one fraction digit for a whole number: "2.0", not "2".
  assert.equal(outcome.realizedTotal, "2.0");
  assert.equal(outcome.skippedTrades, 0);
  const p = Number(outcome.pValue);
  assert.ok(p >= 0 && p <= 1, `p-value ${outcome.pValue} outside [0, 1]`);
  assert.ok(Number(outcome.nullP05) <= Number(outcome.nullMedian) && Number(outcome.nullMedian) <= Number(outcome.nullP95));
  assert.ok(outcome.notes.some((n) => n.includes("closing-leg taker fee")), "the cost convention is disclosed");
});

test("a recorded total no null can reach pins the p-value at the add-one floor", () => {
  // Every possible null total is ~+1 per trade here (marks rise 1 per bar, size 1, no funding);
  // a recorded total of 500 is unreachable, so zero nulls reach it: p = 1/301.
  const outcome = runEdgeTest(edgeInputs([trade({ pnl: 500n * Q6 })]))!;
  assert.equal(outcome.pValue, (1 / (EDGE_PATHS + 1)).toFixed(4));
});

test("a recorded total every null beats pins the p-value at one", () => {
  const outcome = runEdgeTest(edgeInputs([trade({ pnl: -500n * Q6 })]))!;
  assert.equal(outcome.pValue, "1.0000");
});

test("trades the history is too short to place are counted and contribute nothing", () => {
  const outcome = runEdgeTest(edgeInputs(
    [trade({ pnl: -1500n * Q6, barsHeld: 5 })],
    [bar(0, 100n * Q6, 0n), bar(3600, 101n * Q6, 0n)],
  ))!;
  assert.equal(outcome.skippedTrades, EDGE_PATHS, "one unplaceable trade on every path");
  assert.equal(outcome.nullMedian, "0", "every path total is exactly zero");
  assert.ok(outcome.notes.some((n) => n.includes("could not be placed")));
  assert.equal(outcome.pValue, "1.0000", "zero null totals sit at or above the losing recorded total");
});

test("the same inputs and seed reproduce the edge block byte for byte", () => {
  const trades = [trade({ pnl: 3n * Q6 }), trade({ pnl: -1n * Q6, direction: "short", barsHeld: 2, seq: 2 })];
  const a = runEdgeTest(edgeInputs(trades))!;
  const b = runEdgeTest(edgeInputs(trades))!;
  assert.deepEqual(a, b);
});

test("a null trade outside the bar range is a hard error, never a wrap", () => {
  assert.throws(() => nullTradeNet(BARS, -1, 1, trade({}), CFG), /out of the bar range/);
});

// ---- Analysis wiring ----

function analysisInputs(withEdge: boolean): AnalysisInputs {
  const trades = [trade({ pnl: 3n * Q6 }), trade({ pnl: -1n * Q6, direction: "short", barsHeld: 2, seq: 2 })];
  return {
    runId: "a".repeat(64),
    list: list(trades),
    request: parseResampleRequest({ seed: "s", paths: 128 }),
    createdAt: "2026-01-01T00:00:00.000Z",
    start: 1000n * Q6,
    quoteDecimals: 6,
    baseDecimals: 6,
    quoteScale: Q6,
    oneBase: Q6,
    lotSize: 10n,
    maxSize: Q6,
    markPrice: 103n * Q6,
    effectiveImfBps: 5000n,
    market: "TEST",
    assumptions: { fillModel: "tape", profile: "realistic", latencySec: 1, gasPerTx: "0", intrabar: true },
    edge: withEdge ? { bars: BARS, cfg: CFG } : undefined,
  };
}

test("the analysis carries the edge block when history is supplied and skips it when not", () => {
  const withEdge = buildResampleAnalysis(analysisInputs(true));
  assert.equal(withEdge.edge === null, false);
  assert.equal(withEdge.edge!.paths, EDGE_PATHS);
  assert.equal(withEdge.edge!.realizedTotal, "2.0");
  const withoutEdge = buildResampleAnalysis(analysisInputs(false));
  assert.equal(withoutEdge.edge, null);
});

test("the edge invariant passes on a real block, is skipped without one, and catches a tampered total", () => {
  const inputs = analysisInputs(true);
  const analysis = buildResampleAnalysis(inputs);
  const invariants = checkResample(analysis, inputs);
  const edge = invariants.find((i) => i.id === "edge-realized-total")!;
  assert.equal(edge.status, "pass", invariants.map((i) => `${i.id}:${i.status}`).join(","));

  const without = checkResample(buildResampleAnalysis(analysisInputs(false)), analysisInputs(false));
  assert.equal(without.find((i) => i.id === "edge-realized-total")!.status, "skip");

  const tampered: ResampleAnalysis = { ...analysis, edge: { ...analysis.edge!, realizedTotal: "999" } };
  const caught = checkResample(tampered, inputs).find((i) => i.id === "edge-realized-total")!;
  assert.equal(caught.status, "fail");
});

test("the resample-deterministic invariant still holds with the edge block present", () => {
  const inputs = analysisInputs(true);
  const analysis = buildResampleAnalysis(inputs);
  const invariants = checkResample(analysis, inputs);
  assert.ok(invariants.every((i) => i.status === "pass"), invariants.map((i) => `${i.id}:${i.status}`).join(","));
});
