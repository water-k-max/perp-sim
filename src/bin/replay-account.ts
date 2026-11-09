import { createClient } from "../client.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { fromRaw, utc } from "../units.js";
import { reconcileAccount } from "../verify/replay-account.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const account = arg("account", process.env.WALLET_ADDRESS ?? "");
if (!/^0x[0-9a-fA-F]{40}$/.test(account)) {
  console.error("usage: pnpm replay-account --account 0x… [--market BTC] [--days 7 | --from ISO --to ISO]");
  console.error("a public address only. this command never signs, sends or needs a key.");
  process.exit(1);
}

const symbol = arg("market", "BTC");
const days = Number(arg("days", "7"));
const to = arg("to", "") ? Math.floor(new Date(arg("to", "")).getTime() / 1000) : Math.floor(Date.now() / 1000);
const from = arg("from", "") ? Math.floor(new Date(arg("from", "")).getTime() / 1000) : to - days * 86_400;

const client = createClient().client;
const cfg = await resolveConfig(client, selectMarket(await listPerps(client), symbol));

const report = await reconcileAccount({ client, cfg, account, fromSec: from, toSec: to });

console.log(`${report.market}/${cfg.quoteSymbol}  pool ${report.pool}`);
console.log(`account ${report.account}`);
console.log(`window  ${utc(report.fromSec)} -> ${utc(report.toSec)}`);
console.log(`read    ${report.fills} fills, ${report.changes} indexed position updates, ${report.unmatched} unmatched`);

console.log(`\nfees  expected ${fromRaw(report.fees.expected, cfg.quoteDecimals)}  recorded ${fromRaw(report.fees.actual, cfg.quoteDecimals)}  diff ${fromRaw(report.fees.diff, cfg.quoteDecimals)}  (${report.fees.rows} fill-fee rows)`);
console.log(`      ${report.fees.leg === "vacuous-zero-rate"
  ? `VACUOUS: taker ${report.fees.rates.takerBpsTimes1k} / maker ${report.fees.rates.makerBpsTimes1k} bpsx1k — the venue charges no fill fee, so 0 == 0 here proves nothing`
  : `informative at taker ${report.fees.rates.takerBpsTimes1k} / maker ${report.fees.rates.makerBpsTimes1k} bpsx1k`}`);
if (report.fees.liquidation.rows > 0) {
  console.log(`      liquidation rail: ${report.fees.liquidation.rows} record(s), ${fromRaw(report.fees.liquidation.total, cfg.quoteDecimals)} ${cfg.quoteSymbol} — excluded above, this check does not model it`);
}
if (report.fees.unknown.rows > 0) {
  console.log(`      unrecognised kinds: ${report.fees.unknown.kinds.join(", ")} (${report.fees.unknown.rows} record(s)) — failing closed`);
}
if (report.fees.byKind.length > 0) {
  console.log(`      by kind: ${report.fees.byKind.map((k) => `${k.kind}/${k.rail}=${k.rows}(${k.total})`).join(" ")}`);
}

const shown = report.rows.slice(0, 20);
if (shown.length > 0) {
  console.log("\nper-fill replay  (sizeAfter | closedSize | realizedPnl)");
  for (const row of shown) {
    const mark = row.diffs.length === 0 ? "ok  " : "DIFF";
    console.log(
      `  ${mark} ${utc(row.t)} ${String(row.kind ?? "-").padEnd(8)} size ${row.actual.sizeAfter} (want ${row.expected.sizeAfter ?? "-"})  closed ${row.actual.closedSize} (want ${row.expected.closedSize ?? "-"})  pnl ${row.actual.realizedPnl} (want ${row.expected.realizedPnl ?? "-"})`,
    );
    for (const diff of row.diffs) console.log(`        ${diff}`);
  }
  if (report.rows.length > shown.length) console.log(`  … ${report.rows.length - shown.length} more rows`);
}

for (const warning of report.warnings) console.log(`note  ${warning}`);
console.log(`\n${report.ok ? "reconciled" : "NOT reconciled"}: ${report.mismatches} mismatched fill(s) of ${report.rows.length} checked`);
process.exit(report.ok ? 0 : 2);
