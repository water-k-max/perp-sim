import { createClient } from "../client.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { candleWindow, fundingWindow } from "../history/indexer.js";
import { buildBars, coverage, withIntraBarPath } from "../history/bars.js";
import { simulate } from "../engine/simulate.js";
import { fromRaw, toRaw, utc } from "../units.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const symbol = arg("market", "BTC");
const days = Number(arg("days", "14"));
const side = arg("side", "long") === "short" ? ("short" as const) : ("long" as const);
const cash = toRaw(arg("cash", "1000"), 18);
const sizeArg = arg("size", "0.01");
const intrabar = !process.argv.includes("--no-intrabar");
const candleInterval = Number(arg("interval", "3600"));

const markets = createClient();
const client = markets.client;
const cfg = await resolveConfig(client, selectMarket(await listPerps(client), symbol));

const to = Math.floor(Date.now() / 1000);
const from = to - days * 86_400;

const found = await fundingWindow(client, cfg.pool, from, to);
let bars = buildBars(found.rows);
let candleInfo = "disabled (--no-intrabar): settlement marks only";
if (intrabar && bars.length > 1) {
  const candles = await candleWindow(client, cfg.pool, candleInterval, bars[0].t, to);
  bars = withIntraBarPath(bars, candles.rows);
  const covered = bars.filter((b) => b.low !== null).length;
  candleInfo = `${covered}/${bars.length} bars covered by ${candleInterval}s candles (pages ${candles.pages}, complete ${candles.complete})`;
}

if (bars.length < 3) {
  console.log(`only ${bars.length} settlement(s) in the window; widen --days`);
  process.exit(1);
}

let size = toRaw(sizeArg, cfg.baseDecimals);
size -= size % cfg.lotSize;
const entryBar = 1;
const entry = { bar: entryBar, side, size, price: bars[entryBar].mark };
const cov = coverage(bars);
const out = simulate({ cfg, bars, cash, entries: [entry] });

console.log(`${cfg.symbol}/${cfg.quoteSymbol}  pool ${cfg.pool}`);
console.log(
  `baseDecimals ${cfg.baseDecimals} (oneBase 1e${cfg.baseDecimals})  im ${cfg.imBps}bps  mm ${cfg.mmBps}bps  closeOut ${cfg.closeOutBps}bps  effectiveImf ${cfg.effectiveImfBps}bps`,
);
console.log(
  `funding settles every ${cfg.fundingIntervalSec}s over a ${cfg.fundingWindowSec}s window (n=${cfg.fundingWindowSec / cfg.fundingIntervalSec})  taker fee ${cfg.takerFeeBpsTimes1k} x1e-3bps`,
);
console.log(
  `lot ${fromRaw(cfg.lotSize, cfg.baseDecimals)}  minQty ${fromRaw(cfg.minQuantity, cfg.baseDecimals)}  maxPositionSize ${fromRaw(cfg.maxPositionSize, cfg.baseDecimals)} ${cfg.symbol}`,
);
if (cfg.imBpsMismatch) console.log("NOTE the indexer's initialMarginBps disagrees with the chain's risk params");

console.log(
  `\nhistory  ${cov.bars} settlements, ${utc(cov.from ?? 0)} -> ${utc(cov.to ?? 0)}  (pages ${found.pages}, complete ${found.complete})`,
);
console.log(
  `  expected ${cov.expectedSettlements} at this cadence, missing ${cov.missingSettlements}, gap bars ${cov.gaps}, anchor resyncs ${cov.anchorResynced}, forgiven intervals ${cov.forgivenIntervals}`,
);
console.log(`  mark feed sentinel fell back to index on ${cov.markFromIndex} bar(s)`);
console.log(`  intra-bar path ${candleInfo}`);

console.log(
  `\nposition  ${side} ${fromRaw(size, cfg.baseDecimals)} ${cfg.symbol} @ ${fromRaw(entry.price, cfg.quoteDecimals)} on ${utc(bars[entryBar].t)}  collateral ${fromRaw(cash, cfg.quoteDecimals)} ${cfg.quoteSymbol}`,
);
console.log("  entry assumed at the settlement mark: a real taker fill pays the book, not the mark");
if (size < cfg.minQuantity) console.log("  WARNING below this market's minQuantity — a real order would be rejected");
if (size > cfg.maxPositionSize) console.log("  WARNING above this market's maxPositionSize — a real order would be rejected");

console.log(
  `\nresult  ${out.status}` +
    (out.liquidatedAtBar !== null
      ? ` at bar ${out.liquidatedAtBar} on ${utc(bars[out.liquidatedAtBar].t)} at ${fromRaw(out.liquidatedAtPrice ?? 0n, cfg.quoteDecimals)}`
      : ""),
);
console.log(
  `  equity ${fromRaw(out.equityStart, cfg.quoteDecimals)} -> ${fromRaw(out.equityEnd, cfg.quoteDecimals)}  roi ${out.roiBps === null ? "n/a" : `${(Number(out.roiBps) / 100).toFixed(2)}%`}`,
);
const fundingTotal = out.fundingSettled + out.fundingOpen;
console.log(
  `  to equity, each signed:  pnl ${fromRaw(out.realizedPnl, cfg.quoteDecimals)}` +
    `  funding ${fromRaw(-fundingTotal, cfg.quoteDecimals)}` +
    `  fees ${fromRaw(-out.feesPaid, cfg.quoteDecimals)}` +
    `  = ${fromRaw(out.realizedPnl - fundingTotal - out.feesPaid, cfg.quoteDecimals)} ${cfg.quoteSymbol}`,
);
console.log(
  `      each line is a contribution to equity, so negative funding means the position paid it` +
    ` (the kernel's accruedFunding is a cost, which is why it is negated here)`,
);
console.log(`  min equity ${fromRaw(out.minEquity, cfg.quoteDecimals)} at bar ${out.minEquityBar ?? "-"}`);

const worst = [...out.trail].sort((a, b) => Number(a.healthBps - b.healthBps)).slice(0, 5);
console.log("\nfive thinnest bars  (health = equity / maintenance requirement)");
for (const t of worst) {
  console.log(
    `  bar ${String(t.bar).padStart(3)} ${utc(t.t)}  mark ${fromRaw(t.mark, cfg.quoteDecimals)}  equity ${fromRaw(t.equity, cfg.quoteDecimals)}  mm ${fromRaw(t.maintenanceMargin, cfg.quoteDecimals)}  health ${(Number(t.healthBps) / 100).toFixed(1)}%  liq ${t.liquidationPrice === null ? "-" : fromRaw(t.liquidationPrice, cfg.quoteDecimals)}`,
  );
}
process.exit(0);
