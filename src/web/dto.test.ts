import test from "node:test";
import assert from "node:assert/strict";
import { validateResample, validateResponse, type ResampleBlock } from "./dto.js";

/** A stored v1-shaped bundle, exactly as old run files carry it: the validator must keep accepting these. */
function blockV1(): Record<string, unknown> {
  return {
    version: 1,
    meta: { seed: "s".repeat(64), paths: 128, horizonTrades: 16, mode: "both", sizing: "static", source: { kind: "run", runId: "r".repeat(64) }, createdAt: "2026-11-01T00:00:00.000Z" },
    input: { market: "BTC", tradeCount: 16, sameBarCount: 1, withoutExcursionCount: 0, sameBarShareBps: 625, dismissed: false, window: { from: 1, to: 2 }, startEquity: "1000" },
    assumptions: ["Fill profile is optimistic."],
    distributions: [{
      mode: "shuffle_without_replacement", paths: 128,
      finalEquities: ["900", "1000", "1100"],
      median: "1000", p05: "900", p10: "920", p25: "960", p50: "1000", p75: "1040", p90: "1080", p95: "1100",
      cvar95: "890", bankruptcyRate: "0.000",
      medianMaxDrawdownBps: 1500, p95MaxDrawdownBps: 3200, medianMaxLosingStreak: 3, p95MaxLosingStreak: 5,
      fan: [{ step: 0, p10: "1000", p25: "1000", p50: "1000", p75: "1000", p90: "1000" }],
    }],
    audit: { sameBarShareBps: 625, dismissed: false, fillBasis: "assumed", repricedCount: 1, repricedFinalEquities: ["899", "1000"], repricedMedianDeltaBps: -100, notes: ["The same-bar count is what can be counted, not a bound."] },
    sizing: { acceptedLoss: "100", horizonTrades: 16, rows: [{ sizeBase: "0.01", lossProbability: "0.250", medianPnl: "12.5", p05Pnl: "-30" }], note: null },
    oos: { holdbackFraction: 0.25, fitCount: 12, heldCount: 4, boundary: "1050", heldCurve: ["1000", "1010", "1005", "1020", "1030"], heldFinalMinusStart: "30", crossed: false, fitSeqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], heldSeqs: [13, 14, 15, 16], notes: ["Not proof of an edge."] },
    warnings: ["Distributions model trade-order risk, not a forecast."],
    invariants: [
      { id: "resample-deterministic", status: "pass", severity: "error", detail: "analysis digest reproduced" },
      { id: "resample-bounds", status: "pass", severity: "error", detail: "ordering holds" },
      { id: "oos-no-lookahead", status: "pass", severity: "error", detail: "fit precedes held" },
    ],
  };
}

/** The same bundle typed for mutation tests. */
function block(): ResampleBlock {
  return blockV1() as unknown as ResampleBlock;
}

test("validateResample accepts a well-formed block", () => {
  const validated = validateResample(blockV1());
  assert.equal(validated.meta.paths, 128);
  assert.equal(validated.oos?.fitSeqs.length, 12);
});

test("validateResample accepts version 2 with metric intervals and rejects it missing them", () => {
  const v2 = {
    ...blockV1(),
    version: 2,
    distributions: [{
      ...(blockV1().distributions as Record<string, unknown>[])[0]!,
      p05WinRateBps: 2500, medianWinRateBps: 4375, p95WinRateBps: 6875,
      p05SharpeX1e4: -1200, medianSharpeX1e4: 900, p95SharpeX1e4: 3100,
    }],
  };
  assert.equal(validateResample(v2).distributions[0]!.medianWinRateBps, 4375);
  const missing = (key: string) => {
    const b = structuredClone(v2) as unknown as Record<string, unknown>;
    const dist = (b.distributions as Record<string, unknown>[])[0]!;
    delete dist[key];
    assert.throws(() => validateResample(b), Error);
  };
  for (const key of ["p05WinRateBps", "medianWinRateBps", "p95WinRateBps", "p05SharpeX1e4", "medianSharpeX1e4", "p95SharpeX1e4"]) missing(key);
});

test("validateResample rejects tampered or malformed blocks", () => {
  const tamper = (mutate: (b: ResampleBlock) => void) => {
    const b = block();
    mutate(b);
    assert.throws(() => validateResample(b), Error);
  };
  // Version 2 demands the metric intervals, so a v1-shaped block relabelled v2 fails.
  tamper(b => { (b as { version: number }).version = 2; });
  tamper(b => { b.meta.paths = 12.5; });
  tamper(b => { b.distributions[0]!.cvar95 = "NaNish"; });
  tamper(b => { b.distributions[0]!.fan[0]!.p50 = "not-a-number"; });
  tamper(b => { b.sizing.rows[0]!.lossProbability = "likely"; });
  tamper(b => { b.oos = { ...(b.oos!), boundary: "x" } as never; });
  tamper(b => { b.invariants[0]!.status = "maybe" as never; });
  tamper(b => { (b.audit as Record<string, unknown>).notes = "nope"; });
});

test("validateResample accepts version 3 with the edge block, rejects it missing or malformed", () => {
  // Version 3 documents carry everything version 2 demands plus the edge block.
  const v2 = validateResample({
    ...blockV1(),
    version: 2,
    distributions: [{
      ...(blockV1().distributions as Record<string, unknown>[])[0]!,
      p05WinRateBps: 2500, medianWinRateBps: 4375, p95WinRateBps: 6875,
      p05SharpeX1e4: -1200, medianSharpeX1e4: 900, p95SharpeX1e4: 3100,
    }],
  });
  const edge = { paths: 300, realizedTotal: "2.0", nullP05: "-8.5", nullMedian: "1.0", nullP95: "9.5", nullMean: "0.5", pValue: "0.1234", skippedTrades: 0, notes: ["One-sided."] };
  const v3 = { ...v2, version: 3, edge };
  assert.equal(validateResample(v3).edge!.paths, 300);
  // An explicit null edge (no trades or no history) is valid on a v3 document.
  assert.equal(validateResample({ ...v2, version: 3, edge: null }).edge, null);
  // Version 3 demands the key: a v2-shaped document relabelled v3 fails closed.
  const noEdge = { ...v2, version: 3 } as Record<string, unknown>;
  assert.throws(() => validateResample(noEdge), /random-entry null/);
  const tamper = (mutate: (e: Record<string, unknown>) => void) => {
    const e = structuredClone(edge);
    mutate(e);
    assert.throws(() => validateResample({ ...v2, version: 3, edge: e }), Error);
  };
  tamper(e => { e.paths = 0; });
  tamper(e => { e.realizedTotal = "two"; });
  tamper(e => { e.pValue = "1.5"; });
  tamper(e => { e.skippedTrades = -1; });
  tamper(e => { e.notes = "one-sided"; });
});

test("validateResponse validates an optional resample block on a model result", () => {
  const base = {
    market: "BTC", quoteSymbol: "USDso", side: "long", size: "0.01", cash: "1000", entryPrice: null,
    from: 1_700_000_000, to: 1_700_100_000, status: "closed", equityEnd: "1000", pnl: "0", funding: "0", fees: "0",
    maxDrawdownPct: "0", coverage: { bars: 2 }, complete: true, trail: [{ t: 1_700_000_000, equity: "1000" }], warnings: [],
    resample: block(),
  };
  assert.equal(validateResponse(base).resample?.meta.seed, "s".repeat(64));
  assert.throws(() => validateResponse({ ...base, resample: { nope: true } }), /resample/);
});
