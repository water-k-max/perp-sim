import assert from "node:assert/strict";
import { test } from "node:test";
import { buildImportedTradeList, parseImport, parseTradeList, resampleImportedTrades, MAX_IMPORT_TRADES } from "./import.js";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";

const Q6 = 10n ** 6n;

const CFG: MarketConfig = {
  symbol: "TEST", quoteSymbol: "USDso", pool: "0x" + "1".repeat(40), marginBank: "0x" + "2".repeat(40),
  stopRegistry: null, baseDecimals: 6, quoteDecimals: 6, oneBase: Q6, tickSize: 10n, lotSize: 10n,
  minQuantity: 10n, imBps: 5000n, mmBps: 2500n, closeOutBps: 1250n, effectiveImfBps: 5000n,
  maxPositionSize: Q6, maxOpenInterest: 1000n * Q6, takerFeeBpsTimes1k: 500n, makerFeeBpsTimes1k: 100n,
  fundingWindowSec: 3600, fundingIntervalSec: 3600, imBpsMismatch: false,
};

const T0 = 3_600_000;
function bar(t: number, low: bigint | null, high: bigint | null): Bar {
  return {
    t, block: 1, logIndex: 0, mark: 100n * Q6, markSource: "mark", indexPrice: 100n * Q6,
    cum: 0n, fundingDelta: 0n, rate: 0n, fundingWindowSec: 3600, fundingIntervalSec: 3600,
    intervalsSettled: 1, intervalsAccrued: 1, forgivenIntervals: 0, anchorResynced: false,
    gapSec: 3600, missedIntervals: 0, low, high, candles: low === null ? 0 : 1,
  };
}

// Three settlements. Bar 0 covers (... T0] with extremes 99/101; bar 1 covers (T0, T0+3600]
// with extremes 99.5/100.5; bar 2 has no candle data at all.
const BARS = [bar(T0, 99n * Q6, 101n * Q6), bar(T0 + 3600, 99_500_000n, 100_500_000n), bar(T0 + 7200, null, null)];

const CSV = [
  "side,entryTime,exitTime,pnl,size,entryPrice,fee,funding",
  `long,${T0 - 100},${T0 + 100},-1.5,2,100,0.1,0.05`,
  `short,${T0 + 100},${T0 + 200},0.5,1,100.25,0.1,-0.02`,
  `long,${T0 + 8000},${T0 + 8100},2,1.5,99.9,0.1,0`,
].join("\n");

test("a minimal CSV parses, fills excursions from candle bars and counts what it cannot see", async () => {
  const parsed = parseImport({ payload: CSV, market: "TEST", startingCash: "1000" });
  assert.equal(parsed.trades.length, 3);
  assert.deepEqual(parsed.trades.map((t) => t.entryTs), [T0 - 100, T0 + 100, T0 + 8000]);
  const outcome = await resampleImportedTrades(parsed, { cfg: CFG, bars: BARS });
  assert.equal(outcome.analysis.input.tradeCount, 3);
  assert.equal(outcome.analysis.input.sameBarCount, 1); // trade 2 opens and closes inside bar 1
  assert.equal(outcome.analysis.input.withoutExcursionCount, 1); // trade 3 lies beyond the last bar
  assert.equal(outcome.analysis.meta.source.kind, "import");
  assert.equal(outcome.analysis.audit.fillBasis, "observed");
  assert.ok(outcome.analysis.audit.notes.some((n) => n.includes("imported")), "imported trades disclose that PnL is taken as recorded");
  assert.ok(outcome.analysis.audit.notes.some((n) => n.includes("1 trade(s) carry no excursion data")), "trades without excursion data are counted");
  assert.ok(outcome.invariants.every((i) => i.status === "pass"), outcome.invariants.map((i) => `${i.id}:${i.status}`).join(","));
});

test("excursion PnL is exact at the trade's own size and side", () => {
  const parsed = parseImport({ payload: CSV, market: "TEST", startingCash: "1000" });
  const list = buildImportedTradeList(parsed.trades, CFG, BARS);
  const long = list.trades[0]!;
  assert.equal(long.direction, "long");
  // The long lives across bars 0-1: worst is the lowest low (99.0), best the highest high (101.0).
  assert.equal(long.worstPrice, 99n * Q6);
  assert.equal(long.bestPrice, 101n * Q6);
  // entry 100, worst 99, size 2: adverse -2.0 quote; best 101: favourable +2.0.
  assert.equal(long.mae, -2_000_000n);
  assert.equal(long.mfe, 2_000_000n);
  const short = list.trades[1]!;
  assert.equal(short.direction, "short");
  assert.equal(short.sameBar, true);
  assert.equal(short.worstPrice, 100_500_000n); // a short's worst is the high of its bar
  assert.equal(short.bestPrice, 99_500_000n);
  // entry 100.25: adverse (100.5 - 100.25) * 1 = -0.25; favourable (100.25 - 99.5) * 1 = +0.75.
  assert.equal(short.mae, -250_000n);
  assert.equal(short.mfe, 750_000n);
});

test("a trade without entryPrice still carries worst/best prices but no excursion PnL", () => {
  const csv = "side,entryTime,exitTime,pnl\n" + `long,${T0 - 100},${T0 + 100},-1.5`;
  const parsed = parseImport({ payload: csv, market: "TEST", startingCash: "1000" });
  const list = buildImportedTradeList(parsed.trades, CFG, BARS);
  const record = list.trades[0]!;
  assert.equal(record.worstPrice, 99n * Q6);
  assert.equal(record.bestPrice, 101n * Q6);
  assert.equal(record.mae, null);
  assert.equal(record.mfe, null);
  assert.equal(record.size, CFG.oneBase);
  assert.equal(record.fee, 0n);
  assert.equal(record.funding, 0n);
});

test("the list is sorted chronologically no matter the input order", () => {
  const csv = [
    "side,entryTime,exitTime,pnl",
    `long,${T0 + 5000},${T0 + 5100},1`,
    `long,${T0 - 500},${T0 - 400},-1`,
    `short,${T0 + 100},${T0 + 200},0.5`,
  ].join("\n");
  const parsed = parseImport({ payload: csv, market: "TEST", startingCash: "1000" });
  assert.deepEqual(parsed.trades.map((t) => t.entryTs), [T0 - 500, T0 + 100, T0 + 5000]);
  const list = buildImportedTradeList(parsed.trades, CFG, BARS);
  assert.deepEqual(list.trades.map((t) => t.seq), [1, 2, 3]);
});

test("CSV and JSON parsing reject malformed input with the offending row named", () => {
  assert.throws(() => parseTradeList("side,entryTime\nlong,1"), /missing the required column/);
  assert.throws(() => parseTradeList(`side,entryTime,exitTime,pnl,mystery\nlong,1,2,3,x`), /unknown column "mystery"/);
  assert.throws(() => parseTradeList(`side,entryTime,exitTime,pnl\nlong,1,2`), /cells for/);
  assert.throws(() => parseTradeList(`side,entryTime,exitTime,pnl\nbackwards,1,2,3`), /side must be long or short/);
  assert.throws(() => parseTradeList(`side,entryTime,exitTime,pnl\nlong,2,1,3`), /exitTime must be after entryTime/);
  assert.throws(() => parseTradeList(`side,entryTime,exitTime,pnl\nlong,x,2,3`), /entryTime/);
  assert.throws(() => parseTradeList(`side,entryTime,exitTime,pnl\nlong,1,2,perhaps`), /pnl/);
  assert.throws(() => parseTradeList(`side,entryTime,exitTime,pnl,size\nlong,1,2,3,-1`), /size/);
  assert.throws(() => parseTradeList(`side,entryTime,exitTime,pnl,funding\nlong,1,2,3`), /cells for/);
  assert.throws(() => parseTradeList("[]"), /empty/);
  assert.throws(() => parseTradeList(JSON.stringify({ nope: 1 })), /JSON array or CSV/);
  assert.throws(() => parseTradeList('[{"side":"long","entryTime":1,"exitTime":2,"pnl":"1","gas":"0"}]'), /unknown field "gas"/);
  assert.throws(() => parseTradeList('[{"side":"long","exitTime":2,"pnl":"1"}]'), /missing entryTime/);
  const big = Array.from({ length: MAX_IMPORT_TRADES + 1 }, () => ({ side: "long", entryTime: 1, exitTime: 2, pnl: "0" }));
  assert.throws(() => parseTradeList(big), /capped at/);
  // Numeric-string and ISO times both parse; the list comes back sorted by time,
  // so the earlier ISO date lands first.
  const times = parseTradeList(`side,entryTime,exitTime,pnl\nlong,1700000000,1700000100,1\nshort,2023-11-14,2023-11-15,1`);
  assert.equal(times[0]!.entryTs, Math.floor(Date.parse("2023-11-14T00:00:00Z") / 1000));
  assert.equal(times[1]!.entryTs, 1_700_000_000);
});

test("the request demands exactly one payload shape and valid scalars", () => {
  const body = { payload: CSV, market: "TEST", startingCash: "1000" };
  assert.throws(() => parseImport({ ...body, trades: [] }), /exactly one/);
  assert.throws(() => parseImport({ market: "TEST", startingCash: "1000" }), /exactly one/);
  assert.throws(() => parseImport({ ...body, market: "BAD!!" }), /market/);
  assert.throws(() => parseImport({ ...body, startingCash: "-1" }), /startingCash/);
  assert.throws(() => parseImport({ ...body, startingCash: "1.2.3" }), /startingCash/);
  assert.throws(() => parseImport({ ...body, resample: { paths: 3 } }), /paths/);
});

test("the same import reproduces byte-identical output and a stable id", async () => {
  const run = () => resampleImportedTrades(parseImport({ payload: CSV, market: "TEST", startingCash: "1000" }), { cfg: CFG, bars: BARS });
  const a = await run();
  const b = await run();
  assert.deepEqual(a.analysis, b.analysis);
  assert.equal(a.importId, b.importId);
  const other = await resampleImportedTrades(parseImport({ payload: CSV, market: "TEST", startingCash: "2000" }), { cfg: CFG, bars: BARS });
  assert.notEqual(a.importId, other.importId);
});

test("missing sizes are disclosed and the analysis still runs the ladder", async () => {
  const csv = "side,entryTime,exitTime,pnl\n" + [
    `long,${T0 - 100},${T0 + 100},-1.5`,
    `short,${T0 + 100},${T0 + 200},0.5`,
    `long,${T0 + 3700},${T0 + 3800},0.75`,
    `long,${T0 + 8000},${T0 + 8100},2`,
  ].join("\n");
  const parsed = parseImport({ payload: csv, market: "TEST", startingCash: "1000" });
  const outcome = await resampleImportedTrades(parsed, { cfg: CFG, bars: BARS });
  assert.ok(outcome.analysis.warnings.some((w) => w.includes("Sizes were not supplied")));
  assert.ok(outcome.analysis.sizing.rows.length > 0);
});

test("a history load failure is disclosed and degrades to no excursion data", async () => {
  const parsed = parseImport({ payload: CSV, market: "TEST", startingCash: "1000" });
  const outcome = await resampleImportedTrades(parsed, {
    cfg: CFG, bars: [],
    historyWarning: "The market history for the trade window could not be loaded; the trades carry no excursion data and the sizing leverage note has no mark price.",
  });
  assert.equal(outcome.analysis.input.withoutExcursionCount, 3);
  assert.ok(outcome.analysis.warnings.some((w) => w.includes("could not be loaded")));
  assert.ok(outcome.analysis.audit.notes.some((n) => n.includes("3 trade(s) carry no excursion data")));
});

test("JSON trade arrays work exactly like CSV", async () => {
  const trades = [
    { side: "long", entryTime: T0 - 100, exitTime: T0 + 100, pnl: "-1.5", size: "2", entryPrice: "100", fee: "0.1", funding: "0.05" },
    { side: "short", entryTime: T0 + 100, exitTime: T0 + 200, pnl: "0.5", size: "1", entryPrice: "100.25", fee: "0.1", funding: "-0.02" },
    { side: "long", entryTime: T0 + 8000, exitTime: T0 + 8100, pnl: "2", size: "1.5", entryPrice: "99.9", fee: "0.1", funding: "0" },
  ];
  const fromCsv = await resampleImportedTrades(parseImport({ payload: CSV, market: "TEST", startingCash: "1000" }), { cfg: CFG, bars: BARS });
  const fromJson = await resampleImportedTrades(parseImport({ trades, market: "TEST", startingCash: "1000" }), { cfg: CFG, bars: BARS });
  assert.deepEqual(fromJson.analysis.distributions, fromCsv.analysis.distributions);
});
