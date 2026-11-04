import test from "node:test";
import assert from "node:assert/strict";
import { buildResampleAnalysis, parseResampleRequest, defaultResampleSeed, type AnalysisInputs } from "./analysis.js";
import type { TradeRecord } from "./inputs.js";

const E18 = 10n ** 18n;

function rec(seq: number, pnl: bigint): TradeRecord {
  return {
    seq,
    entryTs: seq * 100,
    exitTs: seq * 100 + 50,
    pnl,
    direction: seq % 2 === 0 ? "long" : "short",
    barsHeld: 1,
    sameBar: false,
    mae: null,
    mfe: null,
    worstPrice: null,
    bestPrice: null,
    excursionSource: "none",
    size: E18,
    entryPrice: 100n * E18,
    exitPrice: 100n * E18,
    funding: 0n,
    fee: 0n,
    gas: 0n,
  };
}

function inputs(overrides: Partial<AnalysisInputs> = {}): AnalysisInputs {
  const trades = Array.from({ length: 12 }, (_, i) => rec(i + 1, BigInt(((i * 13) % 9) - 4) * E18 / 10n));
  return {
    runId: "f".repeat(64),
    list: {
      trades,
      sameBarCount: 1,
      withoutExcursionCount: 2,
      window: { from: 1_000, to: 9_000 },
    },
    request: parseResampleRequest({ seed: "analysis-fixture", paths: 128 }),
    createdAt: "2026-11-01T00:00:00.000Z",
    start: 100n * E18,
    quoteDecimals: 18,
    baseDecimals: 18,
    quoteScale: E18,
    oneBase: E18,
    lotSize: E18 / 100n,
    maxSize: 100n * E18,
    markPrice: 100n * E18,
    effectiveImfBps: 1_000n,
    market: "ETH-USDso",
    assumptions: { fillModel: "tape", profile: "optimistic", latencySec: 0, gasPerTx: "0", intrabar: false },
    ...overrides,
  };
}

test("parseResampleRequest validates and caps", () => {
  const d = parseResampleRequest(undefined);
  assert.equal(d.paths, 1000);
  assert.equal(d.mode, "both");
  assert.throws(() => parseResampleRequest({ paths: 5 }), /\[10, 20000\]/);
  assert.throws(() => parseResampleRequest({ paths: 20001 }), /\[10, 20000\]/);
  assert.throws(() => parseResampleRequest({ mode: "x" }), /mode/);
  assert.throws(() => parseResampleRequest({ holdbackFraction: 1 }), /\(0, 1\)/);
  assert.throws(() => parseResampleRequest({ acceptedLoss: "-1" }), /positive decimal/);
  const full = parseResampleRequest({ seed: "s", paths: 500, mode: "shuffle_without_replacement", sizing: "compound", horizonTrades: 50, acceptedLoss: "10.5", holdbackFraction: 0.25 });
  assert.deepEqual(full, { seed: "s", paths: 500, mode: "shuffle_without_replacement", sizing: "compound", horizonTrades: 50, acceptedLoss: "10.5", holdbackFraction: 0.25, prop: null });
});

test("default seed is a stable hash of the run id", () => {
  const a = defaultResampleSeed("a".repeat(64));
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, defaultResampleSeed("a".repeat(64)));
  assert.notEqual(a, defaultResampleSeed("b".repeat(64)));
});

test("analysis is deterministic for identical inputs", () => {
  const a = buildResampleAnalysis(inputs());
  const b = buildResampleAnalysis(inputs());
  assert.deepEqual(a, b);
  assert.equal(a.meta.seed, "analysis-fixture");
  assert.equal(a.distributions.length, 2);
  assert.equal(a.distributions[0]!.mode, "shuffle_without_replacement");
  assert.equal(a.distributions[1]!.mode, "bootstrap_with_replacement");
  assert.equal(a.input.tradeCount, 12);
  assert.equal(a.sizing.rows.length > 0, true);
  assert.notEqual(a.oos, null);
});

test("default seed derives from the run id, and the block is identical either way", () => {
  const base = inputs({ request: parseResampleRequest({ paths: 128 }) });
  const derived = buildResampleAnalysis(base);
  assert.equal(derived.meta.seed, defaultResampleSeed(base.runId));
  const explicit = buildResampleAnalysis(inputs({ request: parseResampleRequest({ seed: defaultResampleSeed(base.runId), paths: 128 }) }));
  assert.deepEqual(explicit, derived);
});

test("single mode emits one distribution; sizing and oos respect sizing request", () => {
  const a = buildResampleAnalysis(inputs({ request: parseResampleRequest({ seed: "s", paths: 64, mode: "bootstrap_with_replacement" }) }));
  assert.equal(a.distributions.length, 1);
  assert.equal(a.distributions[0]!.mode, "bootstrap_with_replacement");
  const noOos = buildResampleAnalysis(inputs({ request: parseResampleRequest({ seed: "s", paths: 64, holdbackFraction: null }) }));
  assert.equal(noOos.oos, null);
});

test("empty trade list yields an honest, non-crashing document", () => {
  const base = inputs();
  base.list.trades = [];
  base.list.sameBarCount = 0;
  base.list.withoutExcursionCount = 0;
  const a = buildResampleAnalysis(base);
  assert.equal(a.input.tradeCount, 0);
  assert.equal(a.distributions.length, 0);
  assert.equal(a.sizing.rows.length, 0);
  assert.equal(a.oos, null);
  assert.equal(a.audit.dismissed, false);
});

test("warnings carry the modelled-distribution honesty lines", () => {
  const a = buildResampleAnalysis(inputs({ request: parseResampleRequest({ seed: "s", paths: 100 }) }));
  assert.ok(a.warnings.some(w => /not a forecast/.test(w)));
  assert.ok(a.warnings.some(w => /paths is a small sample/.test(w)));
});

const PROP_FORM = { dailyLossLimit: "5", drawdownLimit: "50", phases: [{ profitTarget: "1" }] };

function propInputs(seed: string): AnalysisInputs {
  const base = inputs();
  // Spread the trades across distinct UTC days so evaluations differ per seed.
  base.list = {
    ...base.list,
    trades: base.list.trades.map((t, i) => ({ ...t, entryTs: (i + 1) * 86_400 + 100, exitTs: (i + 1) * 86_400 + 1000 })),
  };
  base.request = parseResampleRequest({ seed, paths: 64, prop: PROP_FORM });
  return base;
}

test("prop block is absent by default and present, deterministic, when requested", () => {
  assert.equal(buildResampleAnalysis(inputs()).prop, null);
  const a = buildResampleAnalysis(propInputs("s"));
  const b = buildResampleAnalysis(propInputs("s"));
  assert.deepEqual(a.prop, b.prop);
  assert.equal(a.prop!.dayCount, 12);
  assert.equal(a.prop!.outcomes.length, 6);
  const shareSum = a.prop!.outcomes.reduce((sum, o) => sum + Number(o.share), 0);
  assert.ok(Math.abs(shareSum - 1) < 0.001);
  assert.ok(a.prop!.notes.some(n => /predicts nothing/.test(n)));
  const seeded = buildResampleAnalysis(propInputs("t"));
  assert.notDeepEqual(seeded.prop, a.prop);
});
