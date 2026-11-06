import test from "node:test";
import assert from "node:assert/strict";
import { checkResample } from "../verify/invariants.js";
import { buildResampleAnalysis, parseResampleRequest, type AnalysisInputs, type ResampleAnalysis } from "./analysis.js";
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

function fixture(): { analysis: ResampleAnalysis; inputs: AnalysisInputs } {
  const inputs: AnalysisInputs = {
    runId: "c".repeat(64),
    list: { trades: Array.from({ length: 16 }, (_, i) => rec(i + 1, BigInt(((i * 7) % 9) - 4) * E18 / 10n)), sameBarCount: 0, withoutExcursionCount: 0, window: { from: 1, to: 2 } },
    request: parseResampleRequest({ seed: "invariant-fixture", paths: 96 }),
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
    assumptions: { fillModel: "tape", profile: "realistic", latencySec: 1, gasPerTx: "0", intrabar: true },
  };
  return { analysis: buildResampleAnalysis(inputs), inputs };
}

function statuses(list: ReturnType<typeof checkResample>): Record<string, string> {
  return Object.fromEntries(list.map((i) => [i.id, i.status]));
}

test("a fresh analysis passes the resample invariants; the edge null is skipped without history", () => {
  const { analysis, inputs } = fixture();
  const list = checkResample(analysis, inputs);
  assert.deepEqual(statuses(list), {
    "resample-deterministic": "pass",
    "resample-bounds": "pass",
    "oos-no-lookahead": "pass",
    "edge-realized-total": "skip",
  });
});

test("tampering with a final equity breaks resample-deterministic", () => {
  const { analysis, inputs } = fixture();
  analysis.distributions[0]!.finalEquities[0] = "999999";
  const list = checkResample(analysis, inputs);
  assert.equal(statuses(list)["resample-deterministic"], "fail");
  assert.match(list.find((i) => i.id === "resample-deterministic")!.detail, /diverged/);
});

test("moving a held seq into the fit half breaks oos-no-lookahead", () => {
  const { analysis, inputs } = fixture();
  const held = analysis.oos!.heldSeqs[0]!;
  analysis.oos!.fitSeqs.push(held);
  const list = checkResample(analysis, inputs);
  assert.equal(statuses(list)["oos-no-lookahead"], "fail");
});

test("a CVaR above p05 breaks resample-bounds", () => {
  const { analysis, inputs } = fixture();
  const dist = analysis.distributions[0]!;
  dist.cvar95 = String(Number(dist.p05) + 1);
  const list = checkResample(analysis, inputs);
  assert.equal(statuses(list)["resample-bounds"], "fail");
  assert.match(list.find((i) => i.id === "resample-bounds")!.detail, /cvar95/);
});

test("an inverted sizing ladder breaks resample-bounds", () => {
  const { analysis, inputs } = fixture();
  const rows = analysis.sizing.rows;
  if (rows.length >= 2) {
    [rows[0]!.sizeBase, rows[1]!.sizeBase] = [rows[1]!.sizeBase, rows[0]!.sizeBase];
    const list = checkResample(analysis, inputs);
    assert.equal(statuses(list)["resample-bounds"], "fail");
  } else {
    analysis.sizing.rows = [{ sizeBase: "5", lossProbability: "0.000", medianPnl: "0", p05Pnl: "0" }, { sizeBase: "1", lossProbability: "0.000", medianPnl: "0", p05Pnl: "0" }];
    const list = checkResample(analysis, inputs);
    assert.equal(statuses(list)["resample-bounds"], "fail");
  }
});

test("a document without an oos block skips, never fails, the lookahead check", () => {
  const { inputs } = fixture();
  inputs.request = parseResampleRequest({ seed: "invariant-fixture", paths: 96, holdbackFraction: null });
  const analysis = buildResampleAnalysis(inputs);
  assert.equal(analysis.oos, null);
  const list = checkResample(analysis, inputs);
  assert.equal(statuses(list)["oos-no-lookahead"], "skip");
});

