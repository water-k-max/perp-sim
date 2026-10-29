import { BacktestInputError, parseRunRequest, runModel, runReplay } from "../backtest-api.js";
import { fromRaw, utc } from "../units.js";
import { attributionView } from "../analytics/attribution.js";
import { markouts, metricsView } from "../analytics/metrics.js";
import { invariantsOk } from "../verify/invariants.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const symbol = arg("market", "BTC");
const side = arg("side", "long") === "short" ? ("short" as const) : ("long" as const);
const cashArg = arg("cash", "1000");
const sizeArg = arg("size", "0.01");
const intrabar = !flag("no-intrabar");
const from = arg("from", "");
const to = arg("to", "");
const days = Number(arg("days", "14"));
const strategyId = arg("strategy", "fixed");
const fillModel = arg("model", "settlement-mark");
const fillProfile = arg("profile", "realistic");

const config: Record<string, unknown> = {
  market: symbol,
  days,
  side,
  size: sizeArg,
  cash: cashArg,
  intrabar,
  fillModel,
  fillProfile,
  latencySec: Number(arg("latency", "1")),
  gasPerTx: arg("gas", "0"),
  strategy:
    strategyId === "sma"
      ? { id: "sma", params: { fast: Number(arg("fast", "6")), slow: Number(arg("slow", "24")), side: arg("strategy-side", "both") } }
      : { id: "fixed", params: { side, size: sizeArg, atBar: Number(arg("at-bar", "1")) } },
};
if (from) config.from = from;
if (to) config.to = to;

let parsed;
try {
  parsed = parseRunRequest(config);
} catch (error) {
  console.error(error instanceof Error ? error.message : "invalid arguments");
  process.exit(1);
}
if (parsed.kind !== "model") throw new Error("this CLI always runs the model path");

if (flag("json")) {
  console.log(JSON.stringify(await runModel(parsed.request), null, 2));
  process.exit(0);
}

let replay;
try {
  replay = await runReplay(parsed.request);
} catch (error) {
  console.error(error instanceof BacktestInputError ? error.message : error instanceof Error ? error.message : "replay failed");
  process.exit(1);
}
const { cfg, data, cov, result, metrics, attribution, invariants, manifest, priceAt, size, cash } = replay;
const money = (n: bigint) => fromRaw(n, cfg.quoteDecimals);

console.log(`${cfg.symbol}/${cfg.quoteSymbol}  pool ${cfg.pool}`);
console.log(
  `baseDecimals ${cfg.baseDecimals} (oneBase 1e${cfg.baseDecimals})  im ${cfg.imBps}bps  mm ${cfg.mmBps}bps  closeOut ${cfg.closeOutBps}bps  effectiveImf ${cfg.effectiveImfBps}bps`,
);
console.log(
  `funding settles every ${cfg.fundingIntervalSec}s over a ${cfg.fundingWindowSec}s window (n=${cfg.fundingWindowSec / cfg.fundingIntervalSec})  taker ${cfg.takerFeeBpsTimes1k} maker ${cfg.makerFeeBpsTimes1k} x1e-3bps`,
);
console.log(
  `lot ${fromRaw(cfg.lotSize, cfg.baseDecimals)}  minQty ${fromRaw(cfg.minQuantity, cfg.baseDecimals)}  maxPositionSize ${fromRaw(cfg.maxPositionSize, cfg.baseDecimals)} ${cfg.symbol}`,
);
if (cfg.imBpsMismatch) console.log("NOTE the indexer's initialMarginBps disagrees with the chain's risk params");

console.log(`\nmodel  ${result.model.fillModel}${result.model.profile === null ? "" : ` / ${result.model.profile}`}`);
if (result.model.fillModel === "tape") {
  console.log(
    `  fills match the tape in a ${result.model.windowSec}s window opening ${result.model.latencySec}s after the decision; this is a modelled fill, not an executed order`,
  );
} else {
  console.log("  fills are priced at the next settlement mark; a real taker fill pays the book, not the mark");
}
console.log(`  gas ${money(result.model.gasPerTx)} per order  strategy ${result.strategy.id} ${JSON.stringify(result.strategy.params)}`);

console.log(
  `\nhistory  ${cov.bars} settlements, ${utc(cov.from ?? 0)} -> ${utc(cov.to ?? 0)}  (complete ${data.complete})`,
);
console.log(
  `  expected ${cov.expectedSettlements} at this cadence, missing ${cov.missingSettlements}, gap bars ${cov.gaps}, anchor resyncs ${cov.anchorResynced}, forgiven intervals ${cov.forgivenIntervals}`,
);
console.log(`  mark feed sentinel fell back to index on ${cov.markFromIndex} bar(s); ${data.epochs.length} parameter epoch(s)`);
const covered = replay.bars.filter((b) => b.low !== null).length;
console.log(`  intra-bar path ${intrabar ? `${covered}/${replay.bars.length} bars covered by hourly candles` : "disabled (--no-intrabar)"}`);

const filledSize = result.fills.filter(fill => fill.tag !== "terminal-close").reduce((sum, fill) => sum + (fill.side === "buy" ? fill.size : -fill.size), 0n);
console.log(
  result.fills.length === 0
    ? `\nposition  no fill — the requested ${side} ${fromRaw(size, cfg.baseDecimals)} ${cfg.symbol} never traded; collateral ${money(cash)} ${cfg.quoteSymbol}`
    : `\nposition  requested ${side} ${fromRaw(size, cfg.baseDecimals)} ${cfg.symbol}, filled ${fromRaw(filledSize < 0n ? -filledSize : filledSize, cfg.baseDecimals)}${filledSize < 0n ? " short" : filledSize > 0n ? " long" : ""} on ${utc(result.fills[0]!.t)}  collateral ${money(cash)} ${cfg.quoteSymbol}`,
);
if (size < cfg.minQuantity) console.log("  WARNING below this market's minQuantity — a real order would be rejected");
if (size > cfg.maxPositionSize) console.log("  WARNING above this market's maxPositionSize — a real order would be rejected");

console.log(
  `\nresult  ${result.status}` +
    (result.liquidatedAtBar !== null
      ? ` at bar ${result.liquidatedAtBar} on ${utc(replay.bars[result.liquidatedAtBar]!.t)} at ${money(result.liquidatedAtPrice ?? 0n)}`
      : ""),
);
console.log(`  equity ${money(result.equityStart)} -> ${money(result.equityEnd)}  roi ${result.roiBps === null ? "n/a" : `${(Number(result.roiBps) / 100).toFixed(2)}%`}`);
console.log(`  min equity ${money(result.minEquity)} at bar ${result.minEquityBar ?? "-"}  bars held ${result.barsHeld}/${result.bars}`);

const attr = attributionView(attribution);
console.log("\nattribution  (each signed, as a contribution to equity)");
console.log(
  `  price ${money(attribution.price)}  funding ${money(-attribution.funding)}  taker fees ${money(-attribution.feesTaker)}  maker fees ${money(-attribution.feesMaker)}  gas ${money(-attribution.gas)}`,
);
console.log(`  = ${money(attribution.delta)} ${cfg.quoteSymbol}   residual ${attribution.residual === 0n ? "0 (exact)" : `${attr.residual} — BOOKS DO NOT BALANCE`}`);

const view = metricsView(metrics);
console.log("\nanalytics");
console.log(
  `  return ${view.totalReturnBps}bps  max dd ${view.maxDrawdownBps}bps  sharpe ${view.sharpe ?? "n/a"}  sortino ${view.sortino ?? "n/a"}  turnover ${view.turnoverBps}bps`,
);
console.log(
  `  trades ${view.trades} (${view.wins}W/${view.losses}L, win ${view.winRateBps ?? "n/a"}bps)  expectancy ${view.expectancy === null ? "n/a" : money(BigInt(view.expectancy))}  avg hold ${view.avgHoldSec ?? "-"}s`,
);
const markout = markouts(result.fills, priceAt, 3600);
console.log(`  markout 1h ${markout === null ? "n/a" : `${markout}bps`}  (${result.fills.length} fill(s))`);

if (result.fills.length > 0) {
  console.log("\nfills  (modelled, not executed)");
  for (const fill of result.fills) {
    const consumed = fill.consumedFillIds.length;
    console.log(
      `  ${utc(fill.t)}  ${fill.side.padEnd(4)} ${fromRaw(fill.size, cfg.baseDecimals)} @ ${money(fill.price)}  fee ${money(fill.fee)}` +
        (result.model.fillModel === "tape" ? `  from ${consumed} tape print(s)` : ""),
    );
  }
}

const worst = [...result.trail].sort((a, b) => Number(a.healthBps - b.healthBps)).slice(0, 5);
console.log("\nfive thinnest bars  (health = equity / maintenance requirement)");
for (const t of worst) {
  console.log(
    `  bar ${String(t.bar).padStart(3)} ${utc(t.t)}  mark ${money(t.mark)}  equity ${money(t.equity)}  mm ${money(t.maintenanceMargin)}  health ${(Number(t.healthBps) / 100).toFixed(1)}%  liq ${t.liquidationPrice === null ? "-" : money(t.liquidationPrice)}`,
  );
}

console.log("\ninvariants");
for (const item of invariants) {
  console.log(`  [${item.status.toUpperCase()}] ${item.id}${item.status === "skip" ? ` — ${item.detail}` : ""}`);
}
if (!invariantsOk(invariants)) console.log("  one or more invariants FAILED; do not trust this result");

const warnings = [
  ...data.warnings,
  ...result.orders
    .filter((order) => order.status === "rejected")
    .map((order) => `order ${order.id} (${order.side} ${fromRaw(order.requested, cfg.baseDecimals)}) did not fill: ${order.reason ?? "unknown"}`),
  ...(result.model.fillModel === "tape" && result.fills.some((fill) => fill.consumedFillIds.length === 0)
    ? ["the end-of-run close is priced at the final settlement mark, not matched against the tape"]
    : []),
];
if (warnings.length > 0) {
  console.log("\nwarnings");
  for (const warning of warnings) console.log(`  ${warning}`);
}

console.log("\nrun");
console.log(`  id ${manifest.runId}  data ${manifest.dataVersion.slice(0, 16)}…  config ${manifest.configHash.slice(0, 16)}…  commit ${manifest.codeCommit}`);
console.log(`  event hash ${result.eventHash.slice(0, 16)}…${manifest.tapeSlices.length > 0 ? `  tape slices ${manifest.tapeSlices.length}` : ""}`);
process.exit(invariantsOk(invariants) ? 0 : 2);
