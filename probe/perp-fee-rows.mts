// The perp fee stream is NOT empty unfiltered (50 rows) but empty filtered by account+pool.
// Which is it: venue policy, or a filter that never matches? Read-only public indexer calls.
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
const sdk: any = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: process.env.INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql" }).client;

const rows: any[] = await sdk.listPerpFees({ limit: 200 });
console.log(`rows=${rows.length} keys=${Object.keys(rows[0] ?? {}).join(",")}`);
console.log("sample:", JSON.stringify(rows.slice(0, 3), (k, v) => (typeof v === "bigint" ? String(v) : v)));
const amounts = rows.map((r) => BigInt(String(r.amount)));
console.log(`non-zero amounts: ${amounts.filter((a) => a !== 0n).length} of ${amounts.length}; sum=${amounts.reduce((a, b) => a + b, 0n)}`);
console.log(`rebates: ${rows.filter((r) => r.isRebate).length}; kinds: ${[...new Set(rows.map((r) => String(r.kind ?? r.feeKind ?? "?")))].join(",")}`);
const byPool = new Map<string, number>();
for (const r of rows) byPool.set(String(r.pool ?? r.marketId ?? "?").toLowerCase(), (byPool.get(String(r.pool ?? r.marketId ?? "?")) ?? 0) + 1);
console.log(`pools represented: ${byPool.size} -> ${[...byPool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => `${p.slice(0, 12)}=${n}`).join(" ")}`);

// Do the pools in the fee stream match perp pools the market list reports?
const perps: any[] = await sdk.listPerpMarkets({ limit: 80 });
const perpPoolSet = new Set(perps.map((m) => String(m.poolAddress ?? "").toLowerCase()).filter((p) => p !== ""));
const feePools = [...byPool.keys()];
console.log(`perp poolAddress set size=${perpPoolSet.size}; fee-stream pools inside it=${feePools.filter((p) => perpPoolSet.has(p)).length} of ${feePools.length}`);

// Does a fee record name an account at all, and does that account appear in the perp fills?
const accountFields = Object.keys(rows[0] ?? {}).filter((k) => /account|user|payer|owner|trader|side/i.test(k));
console.log(`account-shaped fields on a fee row: ${accountFields.join(",") || "none"}`);
if (accountFields.length) {
  const who = String(rows[0][accountFields[0]]).toLowerCase();
  console.log(`first fee row account value: ${who.slice(0, 12)}…`);
  for (const field of accountFields) {
    try {
      const filtered = await sdk.listPerpFees({ [field]: who, limit: 5 });
      console.log(`  listPerpFees({${field}: …}) rows=${filtered.length}`);
    } catch (error) {
      console.log(`  listPerpFees({${field}: …}) ERR ${(error as Error).message.slice(0, 80)}`);
    }
  }
}
const poolWithRows = feePools.find((p) => perpPoolSet.has(p)) ?? feePools[0];
try {
  const byPoolOnly = await sdk.listPerpFees({ pool: poolWithPoolSafe(poolWithRows), limit: 5 });
  console.log(`listPerpFees({pool:${poolWithRows.slice(0, 12)}}) rows=${byPoolOnly.length}`);
} catch (error) {
  console.log(`listPerpFees({pool}) ERR ${(error as Error).message.slice(0, 90)}`);
}
function poolWithPoolSafe(p: string) {
  return p;
}
