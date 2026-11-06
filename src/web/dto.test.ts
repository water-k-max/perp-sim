import test from "node:test";
import assert from "node:assert/strict";
import { validateResample, validateResponse, type ResampleBlock } from "./dto.js";

function block(): ResampleBlock {
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

test("validateResample accepts a well-formed block", () => {
  const validated = validateResample(block());
  assert.equal(validated.meta.paths, 128);
  assert.equal(validated.oos?.fitSeqs.length, 12);
});

test("validateResample rejects tampered or malformed blocks", () => {
  const tamper = (mutate: (b: ResampleBlock) => void) => {
    const b = block();
    mutate(b);
    assert.throws(() => validateResample(b), Error);
  };
  tamper(b => { (b as { version: number }).version = 2; });
  tamper(b => { b.meta.paths = 12.5; });
  tamper(b => { b.distributions[0]!.cvar95 = "NaNish"; });
  tamper(b => { b.distributions[0]!.fan[0]!.p50 = "not-a-number"; });
  tamper(b => { b.sizing.rows[0]!.lossProbability = "likely"; });
  tamper(b => { b.oos = { ...(b.oos!), boundary: "x" } as never; });
  tamper(b => { b.invariants[0]!.status = "maybe" as never; });
  tamper(b => { (b.audit as Record<string, unknown>).notes = "nope"; });
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
