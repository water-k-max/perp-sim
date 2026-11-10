import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Chart } from "./Chart.js";
import { Results } from "./Results.js";
import { validateResponse, type Result, type RunFailure } from "./dto.js";
import type { HistoryEntry } from "./history.js";
import { markoutHorizonsSec, markoutLadder, markoutView } from "../analytics/metrics.js";
import type { ModeledFill } from "../strategy/types.js";

/**
 *  The results screen, rendered.
 *
 *  Everything here used to be verified by eye in a browser, which proves a state once and then
 *  guards nothing. `renderToStaticMarkup` runs the real component tree — `Results` → `Chart`,
 *  `Details`, `Coverage`, `MarkoutCard`, `StaleNote` — with the effects skipped, so the tests
 *  below are assertions about the markup each branch produces, from a payload that has been
 *  through the real `validateResponse`. A fixture is never typed as a `Result` by hand: it is
 *  wire JSON, so a server shape the UI cannot read fails here rather than in the browser.
 *
 *  Out of reach of this seam, and still hand-checked: the sticky chart height (it is measured by
 *  a `ResizeObserver` in an effect), contrast and hit-target sizes (they live in the stylesheet),
 *  and the cursor readout with a cursor in it (it is set by a pointer handler). What *is* checked
 *  is those states' rest markup, because an un-hovered readout and a pinned panel still render.
 */
const wire = (overrides: Record<string, unknown> = {}): Result => validateResponse({
  market: "ETH-USDso", quoteSymbol: "USDso", side: "long", size: "1", cash: "1000", entryPrice: "2000",
  from: 1_700_000_000, to: 1_700_086_400, status: "closed", equityEnd: "1050", pnl: "50", funding: "-20",
  fees: "12", maxDrawdownPct: "3.5", complete: true, warnings: [],
  coverage: { bars: 240, expectedSettlements: 24, missingSettlements: 0, gaps: false, anchorResynced: false },
  trail: [{ t: 1_700_000_000, equity: "1000" }, { t: 1_700_086_400, equity: "1050" }],
  ...overrides,
});

type Props = Parameters<typeof Results>[0];
const quiet: RunFailure = { message: "Indexer refused the read.", hint: "Retry in a moment.", raw: null };
const props = (over: Partial<Props>): Props => ({
  data: null, failure: null, busy: false, badge: "", activity: "Ready.", stale: [], exportReady: false,
  onExport: () => {}, history: [], onClear: () => {}, onEdit: () => {}, ...over,
});
const render = (over: Partial<Props> = {}) => renderToStaticMarkup(<Results {...props(over)} />);

const entry = (runId: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  runId, market: "ETH-USDso", from: 1_700_000_000, to: 1_700_086_400, fillModel: "tape", profile: "optimistic",
  strategy: "sma-cross", equityEnd: "1050", pnl: "50", status: "closed", at: "2026-11-10T00:00:00.000Z",
  ...over,
});

test("the run headline is the badge the run earned, and only a failure is dressed as one", () => {
  for (const badge of ["RUN COMPLETE", "PARTIAL RESULT", "NO FILL", "PREVIOUS RESULT"]) {
    const html = render({ data: wire(), badge });
    assert.match(html, new RegExp(`id="result-badge" class="pill">${badge}<`), `pill copy changed for ${badge}: ${html}`);
    assert.equal(html.includes('class="pill pill-danger"'), false, `${badge} must not read as a failed run`);
  }
  assert.match(render({ badge: "RUN FAILED" }), /id="result-badge" class="pill pill-danger">RUN FAILED</);
});

test("the modelled-fill badge explains itself only when fills really were modelled", () => {
  const tape = render({ data: wire({ model: { fillModel: "tape", profile: "optimistic", latencySec: 2, windowSec: 30, gasPerTx: "0" } }) });
  assert.match(tape, /id="fill-badge" class="pill" title="Modelled fill: each order matches/);
  assert.match(tape, /This is not an executed order\."/);

  const mark = render({ data: wire({ model: { fillModel: "settlement-mark", profile: "conservative", latencySec: 0, windowSec: null, gasPerTx: "0" } }) });
  assert.match(mark, /id="fill-badge" class="pill" hidden=""/, "a settlement-mark run has no modelled fill to flag");
  assert.equal(mark.includes('id="fill-badge" class="pill" hidden="" title'), false, "a hidden badge must not keep a tooltip");

  // No model at all (a legacy run) must not crash, and must not claim a fill model it never read.
  const bare = render({ data: wire() });
  assert.match(bare, /id="fill-badge" class="pill" hidden=""/);
});

test("a failed run keeps its previous results on screen and says so", () => {
  const html = render({ data: wire(), failure: { ...quiet, raw: "EPERM: operation not permitted, rename" }, badge: "PREVIOUS RESULT" });
  assert.match(html, /class="error"><p>Run failed — the results below are from the previous run\. Indexer refused the read\./);
  assert.match(html, /<details class="failure-raw"><summary>Technical detail<\/summary><code>EPERM/, "the raw is what makes a report reproducible");
  assert.match(html, /class="activity activity-danger"/, "the status line and the banner must fail together");
  // The empty pane is still there for the a11y tree to ignore, but only as hidden.
  assert.match(html, /id="empty" class="empty" hidden=""/);
  assert.equal(html.includes("empty-failed"), false, "a screen with results on it is not an empty screen");
});

test("with nothing behind it, the failure replaces the empty prompt instead of stacking on it", () => {
  const prompt = render();
  assert.match(prompt, /<div id="empty" class="empty"><div class="empty-icon"[^>]*>⌁<\/div><h4>A hypothesis needs a test\./);
  assert.match(prompt, /Run a backtest to reveal its historical equity curve/);
  assert.doesNotMatch(prompt, /Run failed/);
  assert.equal(prompt.includes('id="empty" class="empty" hidden'), false, "the prompt has to be the visible thing");

  const failed = render({ failure: quiet });
  assert.match(failed, /id="empty" class="empty empty-failed"/);
  assert.match(failed, /<h4>Run failed<\/h4><p>Indexer refused the read\.<br\/><span class="muted">Retry in a moment\./);
  assert.doesNotMatch(failed, /A hypothesis needs a test/, "one pane or the other, never both");
  // The previous-run banner needs a previous run: with no result behind the message, "the results
  // below" points at nothing and the page would stack two error blocks over one failure.
  assert.doesNotMatch(failed, /the results below are from the previous run/);
  assert.equal(failed.match(/<div class="error">/g)?.length ?? 0, 0, "one failure on screen is one failure surface, not a banner over a pane");
  // A raw with nothing behind it renders no disclosure — an empty <details> is a dead control.
  assert.equal(failed.includes("failure-raw"), false);
  assert.match(render({ failure: { ...quiet, raw: "boom" } }), /<code>boom<\/code>/);
});

test("a stale result names the inputs that moved, and only while it is on screen", () => {
  assert.match(render({ data: wire(), stale: ["Size", "Lookback"] }), /<p class="stale-note" role="status"><strong>Stale result\.<\/strong> Size, Lookback changed after this read/);
  assert.equal(render({ data: wire(), stale: [] }).includes("stale-note"), false, "nothing moved, so nothing may be called stale");
  // Mid-run the previous result is about to be replaced; nagging over the top of it is noise.
  assert.equal(render({ data: wire(), stale: ["Size"], busy: true }).includes("stale-note"), false);
  assert.equal(render({ stale: ["Size"] }).includes("stale-note"), false, "there is no stale empty screen");
});

test("the data-coverage pill has four tones and picks them from the read, not from the run's status", () => {
  const tone = (over: Record<string, unknown>) => render({ data: wire(over) }).match(/id="coverage-badge" class="pill">([^<]*)</)?.[1];
  assert.equal(render().match(/id="coverage-badge" class="pill">([^<]*)</)?.[1], "NOT CHECKED");
  assert.equal(tone({}), "COMPLETE");
  assert.equal(tone({ complete: false }), "REVIEW COVERAGE");
  assert.equal(tone({ coverage: { bars: 1, missingSettlements: 2, gaps: false, anchorResynced: false } }), "REVIEW COVERAGE");
  assert.equal(tone({ coverage: { bars: 1, missingSettlements: 0, gaps: true, anchorResynced: false } }), "REVIEW COVERAGE");
  assert.equal(tone({ coverage: { bars: 1, missingSettlements: 0, gaps: false, anchorResynced: true } }), "REVIEW COVERAGE");
  // A candle read that fell short is a coverage hole even when the settlement read was whole.
  assert.equal(tone({ candleCoverage: { bars: 100, covered: 99, complete: true } }), "REVIEW COVERAGE");
  assert.equal(tone({ candleCoverage: { bars: 100, covered: 100, complete: false } }), "REVIEW COVERAGE");
  assert.equal(tone({ candleCoverage: { bars: 100, covered: 100, complete: true } }), "COMPLETE");
  // A broken invariant outranks an otherwise clean read — green over a failed check is the lie.
  assert.equal(tone({ invariants: [{ id: "fees", status: "fail", severity: "high", detail: "residual" }] }), "INVARIANT FAILED");
  assert.equal(tone({ complete: false, invariants: [{ id: "fees", status: "fail", severity: "high", detail: "residual" }] }), "INVARIANT FAILED");
  assert.equal(tone({ invariants: [{ id: "fees", status: "skip", severity: "low", detail: "no fee leg" }] }), "COMPLETE", "a skipped check is not a failed one");
});

test("the coverage panel withholds its facts until there is a run to report on", () => {
  const empty = render();
  assert.match(empty, /id="coverage-empty" class="muted"/);
  assert.match(empty, /id="coverage-list" hidden=""/);
  assert.match(empty, /id="warnings" class="warnings" hidden=""/);
  const full = render({ data: wire() });
  assert.match(full, /id="coverage-empty" class="muted" hidden=""/);
  assert.match(full, /<dt>Missing settlements<\/dt><dd>0<\/dd>/);
  assert.match(full, /<dt>Candle coverage<\/dt><dd>Not available<\/dd>/, "an unread candle series is not a full one");
  // An incomplete run must state it among the warnings, not merely fail to earn the green pill.
  assert.match(render({ data: wire({ complete: false, warnings: ["Indexer paginated twice."] }) }),
    /<li>This run is incomplete\. Treat the returned figures as partial results\.<\/li><li>Indexer paginated twice\.<\/li>/);
});

test("money keeps its sign and a cost never borrows a profit's colour", () => {
  const html = render({ data: wire() });
  assert.match(html, /<strong id="pnl" title="50 USDso" class="positive">/);
  assert.match(html, /<strong id="funding" title="-20 USDso" class="negative">/);
  // Fees carry the unit but no sign colour: they are a magnitude, and +12 in green reads as earned.
  assert.match(html, /<strong id="fees" title="12 USDso">/);
  assert.equal(html.includes('id="fees" title="12 USDso" class="positive"'), false);
  // Ending equity is unsigned for the same reason, and says which unit it is in.
  assert.match(html, /<strong id="equity" title="1050"/);
  assert.match(html, /id="equity-note">USDso · Starting cash 1,000</);
  assert.match(render(), /<strong id="pnl"[^>]*>—<\/strong>/, "an unrun metric is an em dash, not a zero");
  // Three states, three readings: no run, a run that never computed the metric, and a number.
  assert.match(html, /<strong id="sharpe">n\/a<\/strong>/, "an uncomputed Sharpe is not a zero Sharpe");
  assert.match(render(), /<strong id="sharpe">—<\/strong>/);
  assert.match(render({ data: wire({ analytics: { sharpe: 1.25 } }) }), /<strong id="sharpe">1\.25<\/strong>/);
});

test("the curve is only visible when there is a curve, and a single point is not drawn as one", () => {
  const none = render();
  assert.match(none, /id="chart-wrap" hidden=""/);
  assert.match(none, /id="chart-summary" class="muted chart-summary"><\/p>/, "a summary of nothing would be invented copy");

  const one = renderToStaticMarkup(<Chart data={wire({ trail: [{ t: 1_700_000_000, equity: "1000" }] })} />);
  assert.match(one, /id="chart-wrap"/);
  assert.doesNotMatch(one, /stroke-linejoin/, "one sample cannot support a line — drawing it would invent a slope");
  assert.equal(one.includes(">start</text>"), false, "a baseline needs two points to be against");
  assert.match(one, /<desc id="chart-desc">1 equity samples, from/);
  assert.match(one, /Equity starts at 1,000 and ends at 1,000/);

  const empty = renderToStaticMarkup(<Chart data={wire({ trail: [] })} />);
  assert.match(empty, /No equity samples returned/);
  assert.match(empty, /The engine returned no equity samples\. Summary metrics are available, but no curve can be drawn\./);
  // Two points do draw the curve — the guard above is a conditional, not an absent feature.
  assert.match(render({ data: wire() }), /<path d="M[\d.]+,[\d.]+ L[\d.]+,[\d.]+" fill="none"[^>]*stroke-linejoin="round"/);
});

test("a close on the axis is coloured by its own sign", () => {
  const html = renderToStaticMarkup(<Chart data={wire({ trades: [
    { t: 1_700_000_000, netPnl: "10" }, { t: 1_700_043_200, netPnl: "0" }, { t: 1_700_086_400, netPnl: "-10" },
  ] })} />);
  const count = (re: RegExp) => (html.match(re) || []).length;
  assert.equal(count(/class="rug rug-win"/g), 2, "a break-even close is not a loss");
  assert.equal(count(/class="rug rug-loss"/g), 1);
  assert.match(html, /win<b class="tick tick-loss"><\/b>loss closes marked on the axis/);
  assert.equal(renderToStaticMarkup(<Chart data={wire()} />).includes("tick-win"), false, "the legend cannot promise markers that are not there");
});

test("the rest state of the cursor readout claims nothing, since no pointer has moved", () => {
  const html = renderToStaticMarkup(<Chart data={wire()} />);
  assert.match(html, /id="chart-cursor" class="chart-cursor" role="status" aria-live="polite"><\/div>/);
  assert.equal(html.includes("closed here"), false);
});

test("the markout ladder reaches the card through the wire, not just through a fixture", () => {
  // Built by the modules that publish it, serialised by the function the API calls, then read
  // back through the browser's own validator: `bps: null` has to survive all three hops.
  const E18 = 10n ** 18n;
  const fill = (id: string, side: "buy" | "sell", t: number): ModeledFill => ({
    id, orderId: `${id}o`, side, size: E18, price: 2000n * E18, quote: 2000n * E18, t,
    role: "taker", fee: 0n, feeBps: 0n, consumedFillIds: [], tag: side === "buy" ? "entry" : "exit",
  });
  const fills = [fill("f1", "buy", 0), fill("f2", "buy", 3_600)];
  // Settlement prints hourly and stops 4 h in, so the 24 h rung has nothing left to read and the
  // 4 h rung is a mean over one surviving fill — both counts have to reach the screen.
  const priceAt = (t: number) => (t <= 14_400 ? (t === 0 ? 2000n * E18 : 2002n * E18) : null);
  const rungs = markoutView(markoutLadder(fills, priceAt, markoutHorizonsSec(3_600))).rungs;
  assert.deepEqual(rungs.map(r => [r.label, r.bps, r.observed, r.total]), [["1 h", "10", 2, 2], ["4 h", "10", 1, 2], ["24 h", null, 0, 2]]);

  const html = render({ data: wire({ analytics: { markout: { rungs } } }) });
  assert.match(html, /<h4>Markout · 1 h<\/h4>/);
  assert.match(html, /id="markout">10\.0 bps</);
  assert.match(html, /1 h 10\.0 bps · 4 h 10\.0 bps · 24 h no mark/, "an unobserved horizon must not flatten to zero");
  assert.equal(html.includes("24 h 0.0 bps"), false);
  // The card shows the mean; the table under it is what carries the counts the mean was taken over.
  assert.match(html, /<td>4 h<\/td><td class="num">10<\/td><td>1 of 2<\/td>/);
  assert.match(html, /<td>24 h<\/td><td class="num">no mark observed<\/td><td>0 of 2<\/td>/);
});

test("run comparison needs two runs to compare and marks the one on screen", () => {
  const runId = "a".repeat(64);
  const data = wire({ manifest: { runId, dataVersion: "v3", configHash: "c", codeCommit: "d", tapeSlices: [] } });
  assert.match(render({ data, history: [entry(runId)] }), /id="compare" class="panel compare" hidden=""/);
  const html = render({ data, history: [entry(runId), entry("b".repeat(64))] });
  assert.match(html, /<section id="compare" class="panel compare"><div class="panel-heading">/);
  assert.match(html, /<li class="current">/);
  assert.equal((html.match(/<li[ >]/g) || []).length, 2, "both runs are listed");
  assert.match(html, /ETH-USDso · sma-cross · tape\/optimistic/);
  assert.match(render(), /id="compare" class="panel compare" hidden=""/);
});

test("export is inert until there is a result to export and while a run is in flight", () => {
  assert.match(render({ data: wire(), exportReady: false }), /id="export"[^>]*disabled=""/);
  assert.match(render({ data: wire(), exportReady: true, busy: true }), /id="export"[^>]*disabled=""/);
  assert.doesNotMatch(render({ data: wire(), exportReady: true }), /id="export"[^>]*disabled/);
  // The heading and context line are what a screen reader announces first; both must exist empty.
  assert.match(render(), /id="result-context" class="muted">Your results will appear here</);
  assert.match(render({ data: wire() }), /ETH-USDso \/ USDso · LONG · 1 ETH-USDso · /);
});
