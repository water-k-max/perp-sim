import test from "node:test";
import assert from "node:assert/strict";
import { chainLabel, changedLabels, describeModel, fetchChain, parseChainReport, runBadge, runFailure, validateResample, validateResponse, type ChainReport, type ResampleBlock } from "./dto.js";

const hidekiReport: ChainReport = {
  name: "Hideki Testnet", readChainId: "50383", manifestChainId: "50383",
  indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql", testnet: true, agrees: true,
};

test("runFailure maps service, input, network and timeout failures to human copy", () => {
  const storage = runFailure(null, { status: 503, body: { error: "Local cache storage is unavailable.", detail: "EPERM: operation not permitted, rename" } });
  assert.equal(storage.message, "Local cache storage is unavailable.");
  assert.match(storage.raw!, /EPERM/);
  assert.ok(storage.hint.length > 0);
  const input = runFailure(null, { status: 400, body: { error: "Lookback must be 1–90 whole days." } });
  assert.equal(input.message, "Lookback must be 1–90 whole days.");
  assert.equal(input.raw, null);
  // A refusal carries the depth the lane was at, and that sentence is what the user should see;
  // the generic copy is only the fallback for a 429 with no message.
  const busy = runFailure(null, { status: 429, body: { error: "The lab is running 2 heavy job(s) with 4 waiting. Try again in 2 seconds." } });
  assert.equal(busy.message, "The lab is running 2 heavy job(s) with 4 waiting. Try again in 2 seconds.");
  assert.match(busy.hint, /Nothing was started/);
  assert.match(runFailure(null, { status: 429, body: {} }).message, /running other heavy work/);
  const unprocessable = runFailure(null, { status: 422, body: { error: "Data service unavailable. Retry." } });
  assert.equal(unprocessable.message, "Data service unavailable. Retry.");
  assert.match(unprocessable.hint, /server console/);
  const internal = runFailure(null, { status: 500, body: { error: "boom" } });
  assert.match(internal.message, /internal error/);
  assert.equal(internal.raw, "boom");
  // A non-JSON error body must not leak into the headline.
  assert.match(runFailure(null, { status: 502, body: "bad gateway" }).message, /internal error/);
  assert.match(runFailure(Object.assign(new Error("aborted"), { name: "AbortError" })).message, /timed out/);
  assert.match(runFailure(new TypeError("Failed to fetch")).message, /Cannot reach/);
  assert.equal(runFailure(new Error("The result contains an invalid amount.")).message, "The result contains an invalid amount.");
  assert.equal(runFailure("plain string").message, "plain string");
});

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

test("version 4 adds the null tally: required, in range, and old documents still read", () => {
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
  assert.equal(validateResample({ ...v2, version: 3, edge }).edge!.nullsAtOrAbove, undefined, "a stored v3 document is still readable without the tally");
  assert.equal(validateResample({ ...v2, version: 4, edge: { ...edge, nullsAtOrAbove: 37 } }).edge!.nullsAtOrAbove, 37);
  assert.throws(() => validateResample({ ...v2, version: 4, edge }), /random-entry null/);
  for (const bad of [-1, 301, 1.5, "37"]) {
    assert.throws(() => validateResample({ ...v2, version: 4, edge: { ...edge, nullsAtOrAbove: bad } }), /random-entry null/, `tally ${JSON.stringify(bad)} accepted`);
  }
  assert.equal(validateResample({ ...v2, version: 4, edge: { ...edge, nullsAtOrAbove: 300 } }).edge!.nullsAtOrAbove, 300, "the ceiling count is legal");
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

test("parseChainReport takes a chain report only when it says everything", () => {
  assert.deepEqual(parseChainReport(hidekiReport), hidekiReport);
  const { testnet: _gone, ...withoutTestnet } = hidekiReport;
  const bad: unknown[] = [null, undefined, 50383, "Hideki", [], { ...hidekiReport, name: "" }, { ...hidekiReport, readChainId: 50383 },
    { ...hidekiReport, indexerUrl: "   " }, { ...hidekiReport, agrees: "true" }, withoutTestnet];
  for (const value of bad) assert.equal(parseChainReport(value), null, `accepted ${JSON.stringify(value) ?? "undefined"}`);
});

test("chainLabel names the chain in the report, and names both ids when they differ", () => {
  assert.equal(chainLabel(hidekiReport), "Hideki Testnet · 50383");
  assert.equal(chainLabel({ ...hidekiReport, agrees: false, manifestChainId: "50321" }), "Chain mismatch · 50383 ≠ 50321");
  assert.equal(chainLabel(null), "Chain unknown");
  assert.doesNotMatch(chainLabel(hidekiReport), /tokyo/i, "the label must come from the report, not from a remembered network name");
});

test("fetchChain asks the server, and a read that fails is no report at all", async t => {
  const asked: string[] = [];
  let reply: () => Promise<Response> = async () => new Response(JSON.stringify(hidekiReport), { status: 200 });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => { asked.push(String(input)); return reply(); });

  assert.equal((await fetchChain())?.manifestChainId, "50383");
  assert.deepEqual(asked, ["/api/chain"], "the chain must be read from the server that reads it");

  reply = async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 });
  assert.equal(await fetchChain(), null, "a failed status cannot become a chain name");
  reply = async () => new Response("{ not json", { status: 200 });
  assert.equal(await fetchChain(), null, "an unparseable body cannot become a chain name");
  reply = async () => new Response(JSON.stringify({ name: "Hideki Testnet" }), { status: 200 });
  assert.equal(await fetchChain(), null, "a half report is not a report");
  reply = async () => { throw new Error("offline"); };
  assert.equal(chainLabel(await fetchChain()), "Chain unknown");
});

/** A finished run exactly as the wire sends it, so every consumer below gets it through the real validator. */
const wireRun = (overrides: Record<string, unknown> = {}) => validateResponse({
  market: "ETH-USDso", quoteSymbol: "USDso", side: "long", size: "1", cash: "1000", entryPrice: "2000",
  from: 1_700_000_000, to: 1_700_100_000, status: "closed", equityEnd: "1000", pnl: "0", funding: "0", fees: "0",
  maxDrawdownPct: "0", coverage: { bars: 2 }, complete: true, trail: [{ t: 1_700_000_000, equity: "1000" }], warnings: [],
  ...overrides,
});

test("runBadge refuses to call an unopened position a complete run", () => {
  const rejectedEntry = [{ id: "o1", tag: "entry", status: "rejected" }];
  assert.equal(runBadge(wireRun({ orders: rejectedEntry, fills: [] })), "NO FILL");
  // Nothing about the rejection changes once something actually filled: the position exists.
  assert.equal(runBadge(wireRun({ orders: rejectedEntry, fills: [{ id: "f1" }] })), "RUN COMPLETE");
  // And a rejection that is not the entry order says nothing about whether the position opened.
  assert.equal(runBadge(wireRun({ orders: [{ id: "o2", tag: "exit", status: "rejected" }], fills: [] })), "RUN COMPLETE");
  assert.equal(runBadge(wireRun({ orders: [{ id: "o3", tag: "entry", status: "open" }], fills: [] })), "RUN COMPLETE");
  assert.equal(runBadge(wireRun({ orders: [], fills: [] })), "RUN COMPLETE", "a run with no orders reported is not a rejected one");
  // The other two headline only the completeness flag, and NO FILL outranks PARTIAL.
  assert.equal(runBadge(wireRun({ complete: false })), "PARTIAL RESULT");
  assert.equal(runBadge(wireRun({ complete: false, orders: rejectedEntry, fills: [] })), "NO FILL");
});

test("changedLabels names only the watched inputs that moved, in watch-list order", () => {
  const inputs = { size: "Size", side: "Side", days: "Lookback" };
  const ranWith = { size: "1", side: "long", days: 7 };
  assert.deepEqual(changedLabels(ranWith, ranWith, inputs), [], "the same inputs are not stale");
  assert.deepEqual(changedLabels({ ...ranWith, size: "2" }, ranWith, inputs), ["Size"]);
  assert.deepEqual(changedLabels({ size: "2", side: "short", days: 30 }, ranWith, inputs), ["Size", "Side", "Lookback"]);
  // With no recorded inputs there is nothing to compare against, so nothing may be called stale.
  assert.deepEqual(changedLabels({ size: "2", side: "short", days: 30 }, null, inputs), []);
  // A key outside the watch-list is invisible even when it moved — the list is the contract.
  assert.deepEqual(changedLabels({ ...ranWith, quote: "USDC" }, { ...ranWith, quote: "USDso" }, inputs), []);
  // Equality is `!==` on flat primitives, so a value that changed type counts as a change.
  assert.deepEqual(changedLabels({ days: 7 as unknown }, { days: "7" as unknown }, { days: "Lookback" }), ["Lookback"]);
});

test("describeModel tells the two fill models apart and admits neither is an execution", () => {
  const tape = describeModel({ fillModel: "tape", profile: "optimistic", latencySec: 2, windowSec: 30, gasPerTx: "0", requiresFills: true });
  assert.match(tape, /30s window opening 2s after the decision/);
  assert.match(tape, /optimistic profile/);
  assert.match(tape, /not an executed order/i);
  const mark = describeModel({ fillModel: "settlement-mark", profile: "conservative", latencySec: 0, windowSec: null, gasPerTx: "0", requiresFills: false });
  assert.match(mark, /next settlement mark/);
  assert.match(mark, /not a book fill/i);
  assert.equal(tape === mark, false, "one sentence for two different models would misreport the run");
});
