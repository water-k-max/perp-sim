// Does today's fee leg mis-book real LiquidationFee records? Read-only, public data.
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { reconcileAccount } from "../src/verify/replay-account.js";
import { listPerps, resolveConfig, selectMarket } from "../src/history/market.js";
import { fromRaw } from "../src/units.js";

const sdk = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql" }).client;
const perps = await listPerps(sdk as never);
const byPool = new Map<string, (typeof perps)[number]>();
for (const p of perps) byPool.set(String(p.poolAddress ?? "").toLowerCase(), p);

const fees: any[] = await sdk.listPerpFees({ kind: "LiquidationFee", limit: 40 });
console.log(`liquidation fee rows read: ${fees.length}`);
const targets = new Map<string, { account: string; pool: string; ts: number }>();
for (const f of fees) {
  const key = `${String(f.account).toLowerCase()}|${String(f.pool).toLowerCase()}`;
  if (!targets.has(key) && byPool.has(String(f.pool).toLowerCase())) targets.set(key, { account: String(f.account).toLowerCase(), pool: String(f.pool).toLowerCase(), ts: Number(f.timestamp) });
}
console.log(`accounts+pools with a liquidation fee on a listed perp market: ${targets.size}`);

for (const t of [...targets.values()].slice(0, Number(process.env.TARGETS ?? 3))) {
  const chosen = byPool.get(t.pool)!;
  const cfg = await resolveConfig(sdk as never, chosen);
  const to = t.ts + 3_600;
  const from = t.ts - 6 * 3_600;
  const report = await reconcileAccount({ client: sdk as never, cfg, account: t.account, fromSec: from, toSec: to, maxFills: 500 });
  console.log(`\n--- ${cfg.symbol}/${cfg.quoteSymbol} window around a liquidation ---`);
  console.log(`fills=${report.fills} changes=${report.changes} unmatched=${report.unmatched} mismatches=${report.mismatches} ok=${report.ok}`);
  console.log(`fees: expected=${report.fees.expected} actual=${report.fees.actual} diff=${report.fees.diff} rows=${report.fees.rows} (${fromRaw(report.fees.actual, cfg.quoteDecimals)} ${cfg.quoteSymbol})`);
  for (const w of report.warnings) console.log(`warn: ${w}`);
  const kinds = new Map<string, number>();
  for (const row of report.rows) kinds.set(String(row.kind), (kinds.get(String(row.kind)) ?? 0) + 1);
  console.log(`row kinds: ${[...kinds.entries()].map(([k, n]) => `${k}=${n}`).join(" ")}`);
  const bad = report.rows.filter((r) => r.diffs.length > 0).slice(0, 3);
  for (const r of bad) console.log(`  DIFF ${r.kind}: ${r.diffs.join(" | ")}`);
}
