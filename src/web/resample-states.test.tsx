import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverageNote, DIST_NOTES, EdgeNullView, FanChart, ResamplePanel, ShuffleNote, StaleNote, Stat } from "./Resample.js";
import { Results } from "./Results.js";
import { validateResponse, type ResampleBlock, type Result } from "./dto.js";
import { buildResampleAnalysis, parseResampleRequest, type AnalysisInputs } from "../resample/analysis.js";
import { checkResample, type Invariant } from "../verify/invariants.js";
import type { TradeRecord } from "../resample/inputs.js";
import type { FillReadCoverage } from "../verify/fill-coverage.js";

/**
 *  The resampling panel, rendered.
 *
 *  The panel's job is to caveat itself: a 128-path tail is not a 5,000-path tail, a shuffle at
 *  fixed size cannot move the final equity, an assumed-fill run can be dismissed and an observed
 *  one cannot, and a p-value pinned at its ceiling is evidence *against* the entries. Every one
 *  of those readings used to live only in a browser. The blocks below come from the real
 *  `buildResampleAnalysis`, handed to `validateResponse` as wire JSON, so the shapes are the
 *  server's and a divergence breaks the render test rather than the user's confidence.
 */
const E18 = 10n ** 18n;

const record = (seq: number, pnl: bigint): TradeRecord => ({
  seq, entryTs: seq * 100, exitTs: seq * 100 + 50, pnl, direction: seq % 2 === 0 ? "long" : "short",
  barsHeld: 1, sameBar: false, mae: null, mfe: null, worstPrice: null, bestPrice: null,
  excursionSource: "none", size: E18, entryPrice: 100n * E18, exitPrice: 100n * E18, funding: 0n, fee: 0n, gas: 0n,
});

const spread = (n: number): TradeRecord[] => Array.from({ length: n }, (_, i) => record(i + 1, BigInt(((i * 13) % 9) - 4) * E18 / 10n));

const wire = (overrides: Record<string, unknown> = {}): Result => validateResponse({
  market: "ETH-USDso", quoteSymbol: "USDso", side: "long", size: "1", cash: "1000", entryPrice: "100",
  from: 1_700_000_000, to: 1_700_086_400, status: "closed", equityEnd: "1050", pnl: "50", funding: "0", fees: "0",
  maxDrawdownPct: "3.5", complete: true, warnings: [], coverage: { bars: 240 },
  trail: [{ t: 1_700_000_000, equity: "1000" }, { t: 1_700_086_400, equity: "1050" }],
  ...overrides,
});

type Analysis = Awaited<ReturnType<typeof buildResampleAnalysis>>;
/** The block exactly as `/api/backtest` assembles it: the analysis plus its own invariant report. */
async function analyse(over: Partial<AnalysisInputs> = {}): Promise<Analysis & { invariants: Invariant[] }> {
  const inputs: AnalysisInputs = {
    runId: "f".repeat(64),
    list: { trades: spread(12), sameBarCount: 1, withoutExcursionCount: 2, window: { from: 1_000, to: 9_000 } },
    request: parseResampleRequest({ seed: "ui-fixture", paths: 128, mode: "shuffle_without_replacement" }),
    createdAt: "2026-11-10T00:00:00.000Z",
    start: 100n * E18, quoteDecimals: 18, baseDecimals: 18, quoteScale: E18, oneBase: E18,
    lotSize: E18 / 100n, maxSize: 100n * E18, markPrice: 100n * E18, effectiveImfBps: 1_000n,
    market: "ETH-USDso",
    assumptions: { fillModel: "tape", profile: "optimistic", latencySec: 0, gasPerTx: "0", intrabar: false },
    ...over,
  };
  const analysis = await buildResampleAnalysis(inputs);
  return { ...analysis, invariants: await checkResample(analysis, inputs) };
}

const panel = async (block: Analysis, data?: Result) =>
  renderToStaticMarkup(<ResamplePanel data={wire({ manifest: { runId: "f".repeat(64) }, resample: block, ...((data ?? {}) as object) })} />);

test("a metric states its definition in the card, not in a hover", () => {
  assert.equal(
    renderToStaticMarkup(<Stat label="Sharpe p05 / p95" value="1.2 / 3.4" note="Trade-order confidence interval" />),
    '<article class="panel metric"><h4>Sharpe p05 / p95</h4><strong>1.2 / 3.4</strong><small>Trade-order confidence interval</small></article>',
    "the note has to be printed text — a title attribute is unreachable by keyboard and by touch",
  );
  assert.equal(renderToStaticMarkup(<Stat label="X" value="1" />).includes("<small>"), false, "no note, no empty element");
});

test("every distribution metric keeps the wording its note promises", async () => {
  const block = await analyse();
  const html = await panel(block);
  const paths = block.distributions[0]!.paths;
  const promised = [
    DIST_NOTES.medianFinal(paths, "USDso"), DIST_NOTES.p05p95, DIST_NOTES.cvar95, DIST_NOTES.bankruptcy,
    DIST_NOTES.drawdown, DIST_NOTES.streak, DIST_NOTES.winRate, DIST_NOTES.sharpe,
  ];
  for (const note of promised) assert.ok(html.includes(note), `a metric lost its definition: ${note}`);
  assert.equal(promised.length, 8, "the panel prints eight distribution metrics");
  // The heading carries the seed, the path count and the sizing the block was actually built with.
  assert.match(html, /Seed <code>ui-fixture…<\/code> · 128 paths · shuffle without replacement · static sizing/);
});

test("the modelled-tail warning fires on both of its mechanisms below 5,000 paths and on neither above", async () => {
  // No trades: the warning is a property of the path count, and an empty list keeps the check cheap.
  const none = { trades: [], sameBarCount: 0, withoutExcursionCount: 0, window: { from: null, to: null } };
  const few = await panel(await analyse({ list: none, request: parseResampleRequest({ seed: "ui-few", paths: 4_999, mode: "shuffle_without_replacement" }) }));
  assert.match(few, /<span class="pill">MODELLED DISTRIBUTION<\/span>/);
  assert.match(few, /With fewer than 5,000 paths the tail figures move noticeably with the seed/);

  const many = await panel(await analyse({ list: none, request: parseResampleRequest({ seed: "ui-many", paths: 5_000, mode: "shuffle_without_replacement" }) }));
  assert.match(many, /<span class="pill" hidden="">MODELLED DISTRIBUTION<\/span>/, "React hides it, the copy stays in the tree");
  assert.equal(many.includes("tail figures move noticeably"), false);
  assert.match(many, /· 5000 paths ·/, "and the heading must still report how many paths it really ran");
});

test("the fixed-size shuffle explains a flat fan, and nothing else", () => {
  const note = (over: { mode: string; p05: string; p95: string; sizing?: string }) => renderToStaticMarkup(<ShuffleNote {...over} />);
  const flat = /every path ends at the same final equity and p05 equals p95/;
  assert.match(note({ mode: "shuffle_without_replacement", p05: "100", p95: "100", sizing: "static" }), flat);
  assert.match(note({ mode: "shuffle_without_replacement", p05: "100", p95: "100" }), flat, "an absent sizing is the static default, so it still reads");
  // Three separate reasons the note must stay silent — each one has to be its own guard.
  assert.equal(note({ mode: "bootstrap_with_replacement", p05: "100", p95: "100", sizing: "static" }), "", "a bootstrap really can vary its finals");
  assert.equal(note({ mode: "shuffle_without_replacement", p05: "90", p95: "110", sizing: "static" }), "", "a spread is not a pinned distribution");
  assert.equal(note({ mode: "shuffle_without_replacement", p05: "100", p95: "100", sizing: "compound" }), "", "compounding reorders change the final equity");
});

test("the stale banner lists what moved, and is absent when nothing did", () => {
  assert.equal(renderToStaticMarkup(<StaleNote fields={[]} />), "");
  assert.match(renderToStaticMarkup(<StaleNote fields={["Size"]} />), /<strong>Stale result\.<\/strong> Size changed after this read/);
  assert.match(renderToStaticMarkup(<StaleNote fields={["Size", "Side"]} />), /<strong>Stale result\.<\/strong> Size, Side changed after this read/);
});

test("the fill-read coverage stamp cannot dress a truncated window as a whole one", () => {
  const base: FillReadCoverage = {
    firstFillSec: 1_700_000_000, lastFillSec: 1_700_086_400, rowsScanned: 500, rowsInWindow: 400,
    rowsKept: 400, pages: 4, truncated: false, stoppedBy: null, accountFillsInWindow: null, accountFillsAtCeiling: false,
  };
  const read = (over: Partial<FillReadCoverage>) => renderToStaticMarkup(<CoverageNote coverage={{ ...base, ...over }} />);
  const whole = read({});
  assert.match(whole, /class="coverage-note tone-complete" role="status" data-tone="complete"><strong>Full window read\.<\/strong>/);
  assert.match(whole, /The indexer&#x27;s page cursor ran out, which is what &quot;every&quot; rests on\./);

  // A kept-zero read is the case most likely to be reported as "empty account" by mistake.
  const none = read({ rowsKept: 0, truncated: false });
  assert.match(none, /tone-empty" role="status" data-tone="empty"><strong>No fills\.<\/strong>/);
  assert.match(none, /That is the answer, not a short read/);
  assert.doesNotMatch(none, /cannot say the window is empty/);
  const stopped = read({ rowsKept: 0, truncated: true });
  assert.match(stopped, /so it cannot say the window is empty/);

  // Truncation, by cap and by page bound, each with its own reason in the sentence.
  const capped = read({ rowsKept: 200, truncated: true, stoppedBy: "maxFills", accountFillsInWindow: 640 });
  assert.match(capped, /tone-partial" role="status" data-tone="partial"><strong>Partial window\.<\/strong>/);
  assert.match(capped, /Booked 200 of 640 fills the indexer counts here across 4 pages; the fill cap bound the read/);
  assert.match(capped, /a sub-window, so every total here describes that slice only/);
  assert.match(read({ rowsKept: 200, truncated: true, stoppedBy: "page-bound", pages: 10 }), /stopped at its 10-page bound/);
  // A refused count must not become an error, and a ceilinged one must not be quoted as exact.
  assert.match(read({ rowsKept: 200, truncated: true, stoppedBy: null, accountFillsInWindow: null }), /Booked 200 of 400 fills the read itself returned/);
  assert.match(read({ rowsKept: 200, truncated: true, accountFillsInWindow: 10_001, accountFillsAtCeiling: true }), /Booked 200 of at least 10,001 fills/);
  assert.match(read({ rowsKept: 1, truncated: true, accountFillsInWindow: 1 }), /Booked 1 of 1 fill the indexer counts here/, "one row stays singular in the population count");
});

const edge = (over: Record<string, unknown> = {}): NonNullable<ResampleBlock["edge"]> => ({
  paths: 300, nullsAtOrAbove: 37, realizedTotal: "2.0", nullP05: "-8.5", nullMedian: "1.0", nullP95: "9.5",
  nullMean: "0.5", pValue: "0.1234", skippedTrades: 0, notes: ["One-sided test."], ...over,
}) as NonNullable<ResampleBlock["edge"]>;

test("the null test renders all four verdicts, and the ceiling gets its own warning", () => {
  const view = (over: Record<string, unknown> = {}) => renderToStaticMarkup(<EdgeNullView edge={edge(over)} quote="USDso" />);
  assert.match(view({ pValue: "0.001", nullsAtOrAbove: 0 }), /<strong>UNLIKELY TO BE LUCK<\/strong>/);
  assert.match(view({ pValue: "0.12" }), /<strong>WEAK SEPARATION<\/strong>/);
  assert.match(view({ pValue: "0.60" }), /<strong>CONSISTENT WITH LUCK<\/strong>/);
  const anti = view({ pValue: "0.999", nullsAtOrAbove: 300 });
  assert.match(anti, /<strong>ENTRIES WORSE THAN RANDOM<\/strong>/);
  assert.match(anti, /Read the ceiling, not the floor/, "the ceiling of the p-value is not a neutral result");
  assert.match(anti, /Every one of the 300 random-entry paths/);
  assert.equal(view({ pValue: "0.60" }).includes("Read the ceiling"), false, "only the anti-skill band may say it");

  // The resolution sentence is what stops a 300-path p-value being quoted to four decimals.
  assert.match(view(), /it resolves no finer than 0\.0033 — a screen, not a figure to quote/);
  assert.match(view({ skippedTrades: 5 }), /5 null trade\(s\) could not be placed: the market history is shorter than the holding time/);
  assert.match(view(), /<ul class="warnings"><li>One-sided test\.<\/li><\/ul>/);

  const missing = renderToStaticMarkup(<EdgeNullView edge={null} quote="USDso" />);
  assert.match(missing, /The random-entry null needs trades and market history to price entries against/);
  assert.equal(missing.includes("p-value"), false, "no null, no statistic");
});

test("the fill-check verdict is decided by the basis of the fills, not by the same-bar share alone", async () => {
  const allSameBar = { trades: spread(12).map(t => ({ ...t, sameBar: true })), sameBarCount: 12, withoutExcursionCount: 0, window: { from: 1_000, to: 9_000 } };
  const verdict = async (fillModel: "tape" | "settlement-mark") => {
    const html = await panel(await analyse({
      list: allSameBar,
      assumptions: { fillModel, profile: "optimistic", latencySec: 0, gasPerTx: "0", intrabar: false },
    }));
    return html.match(/<h4>Verdict<\/h4><strong>([^<]*)<\/strong>/)?.[1];
  };
  const observed = await verdict("tape");
  const assumed = await verdict("settlement-mark");
  assert.equal(observed, "N/A · OBSERVED FILLS", "a tape-priced run cannot be dismissed for its same-bar share");
  assert.equal(assumed, "TOO MANY SAME-BAR TRADES", "the same trades on settlement marks are not trustworthy");
  assert.notEqual(observed, assumed, "one verdict for two incompatible bases would be the bug this guards");
  // An observed run has nothing to stress-price, so those metrics must not print a fabricated zero.
  const tapeHtml = await panel(await analyse({
    list: { trades: spread(12), sameBarCount: 0, withoutExcursionCount: 0, window: { from: 1_000, to: 9_000 } },
  }));
  assert.match(tapeHtml, /<h4>Stress-priced trades<\/h4><strong>—<\/strong>/);
  assert.match(tapeHtml, /<h4>Median delta<\/h4><strong>—<\/strong>/);
});

test("an empty trade list reports the absence in every tab rather than charting nothing", async () => {
  const empty = await panel(await analyse({ list: { trades: [], sameBarCount: 0, withoutExcursionCount: 0, window: { from: null, to: null } } }));
  assert.match(empty, /No trades to size\./);
  assert.match(empty, /Out-of-sample needs at least two trades in the list\./);
  assert.equal(empty.includes("Resampled paths"), false, "a fan with no paths behind it is a drawing, not a result");
  assert.equal(empty.includes('<h4>Median final</h4>'), false);

  const one = await panel(await analyse({ list: { trades: spread(1), sameBarCount: 0, withoutExcursionCount: 0, window: { from: 1_000, to: 1_100 } } }));
  assert.match(one, /Out-of-sample needs at least two trades in the list\./);
  assert.match(one, /<h4>Median final<\/h4>/, "one trade is enough to describe, though not to hold back");

  // FanChart's own empty guard cannot be reached through the panel — a run with no trades carries
  // no distribution at all, so `{dist && …}` never mounts it. Rendered directly, both arms: the
  // message for no bands, the drawing for a real one.
  const band = (step: number): { step: number; p10: string; p25: string; p50: string; p75: string; p90: string } =>
    ({ step, p10: `${900 + step}`, p25: `${950 + step}`, p50: `${1000 + step}`, p75: `${1050 + step}`, p90: `${1100 + step}` });
  assert.match(renderToStaticMarkup(<FanChart dist={{ paths: 0, fan: [] }} quote="USDso" original={[]} />), /<p class="muted">No trades to chart\.<\/p>/);
  assert.match(renderToStaticMarkup(<FanChart dist={{ paths: 64, fan: [band(0), band(1)] }} quote="USDso" original={[{ step: 0, value: 1000 }, { step: 1, value: 1010 }]} />), /<svg viewBox=/);
});

test("the out-of-sample band reads its verdict from the flag it is given", async () => {
  const crossed = await panel(await analyse({ request: parseResampleRequest({ seed: "ui-oos", paths: 256, mode: "shuffle_without_replacement", holdbackFraction: 0.5 }) }));
  assert.match(crossed, /<h4>Split<\/h4><strong>6 fit \/ 6 held<\/strong>/);
  assert.match(crossed, /Holdback fraction 0\.5/);
  assert.match(crossed, /<h4>Verdict<\/h4><strong>(CROSSED — INVESTIGATE|INSIDE BOUNDARY)<\/strong>/);
  assert.match(crossed, /95th percentile of 256 bootstrap paths over the first 6 trades/);
});

test("the panel is mounted only by a run that actually carries a resample block", async () => {
  const block = await analyse();
  const withBlock = renderToStaticMarkup(<Results data={wire({ manifest: { runId: "f".repeat(64) }, resample: block as ResampleBlock })} failure={null} busy={false} badge="RUN COMPLETE" activity="Done." stale={[]} exportReady onExport={() => {}} history={[]} onClear={() => {}} onEdit={() => {}} />);
  assert.match(withBlock, /<section id="resample-panel" class="panel resample" aria-label="Trade-order resampling">/);
  assert.match(withBlock, /<div class="tablist" role="tablist" aria-label="Resampling views">/);
  // Every tab is in the tree from the start and only hidden: a keyboard user must be able to reach them.
  for (const name of ["distribution", "audit", "sizing", "oos", "edge"]) {
    assert.ok(withBlock.includes(`id="resample-tab-${name}" role="tabpanel"`), `the ${name} panel is not mounted at all`);
  }
  assert.equal(renderToStaticMarkup(<Results data={wire()} failure={null} busy={false} badge="RUN COMPLETE" activity="Done." stale={[]} exportReady onExport={() => {}} history={[]} onClear={() => {}} onEdit={() => {}} />)
    .includes("resample-panel"), false, "a run with no resample block must not open an empty panel");
});
