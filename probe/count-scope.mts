/**
 *  Two questions the fill-coverage code has to answer with measurement, not assumption.
 *
 *  1. Does the Hideki indexer serve `<Table>_aggregate` to the anonymous role? If it does, the
 *     SDK's `countUserFills` returns an exact number and the COUNT_FALLBACK_CAP never binds.
 *     If it does not, every count is a bounded row scan that returns exactly 10000 for "10000
 *     or more" — and the coverage stamp's "at least" is load-bearing.
 *  2. Does a perp `pool` address ever carry a non-PERP fill? `countUserFills` takes no
 *     `marketType` in the SDK's declared FillsScope, so the coverage count is scoped by pool
 *     alone. That is only the same population as the page read if the pool implies the kind.
 *
 *  Read-only against the public indexer; prints counts and column values, no account addresses.
 */
const url = process.env.INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<{ data?: any; errors?: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return await res.json().catch(() => ({ errors: [{ message: `non-JSON response (HTTP ${res.status})` }] }));
}

const first = await gql(`query { Fill_aggregate { aggregate { count } } }`);
console.log("A. anonymous Fill_aggregate:", first.errors ? `REJECTED — ${first.errors[0].message.slice(0, 110)}` : `OK, whole Fill table = ${first.data.Fill_aggregate.aggregate.count} rows`);

const perps = await gql(`query { rows: Fill(where: { marketType: { _eq: "PERP" } }, limit: 4000, order_by: { timestamp: desc }) { pool marketType taker maker } }`);
if (perps.errors) {
  console.log("B. could not read perp fills:", perps.errors[0].message.slice(0, 140));
  process.exit(1);
}
const pools = new Map<string, number>();
for (const r of perps.data.rows) pools.set(String(r.pool).toLowerCase(), (pools.get(String(r.pool).toLowerCase()) ?? 0) + 1);
const busiest = [...pools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`B. distinct perp pools in the newest ${perps.data.rows.length} perp fills: ${pools.size}`);

const kinds = await gql(`query($p: String!) { rows: Fill(where: { pool: { _eq: $p } }, limit: 2000, order_by: { timestamp: desc }) { marketType } }`, { p: busiest[0]?.[0] });
const kindTally = new Map<string, number>();
for (const r of kinds.data?.rows ?? []) kindTally.set(String(r.marketType), (kindTally.get(String(r.marketType)) ?? 0) + 1);
console.log(`C. marketTypes on the busiest perp pool (any kind, newest 2000 rows): ${[...kindTally.entries()].map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`);

// Every perp pool this chain has, not just the busy ones: one non-PERP row on any of them and a
// pool-only count is a different population from the marketType-filtered page read.
const allPerpPools = await gql(`query { rows: Fill(where: { marketType: { _eq: "PERP" } }, limit: 8000, order_by: { timestamp: desc }) { pool } }`);
const everyPool = [...new Set((allPerpPools.data?.rows ?? []).map((r: any) => String(r.pool).toLowerCase()))];
console.log(`D. pool ⇒ PERP? scanning ${everyPool.length} perp pools for any non-PERP fill row…`);
let contaminated = 0;
for (const pool of everyPool) {
  const other = await gql(`query($p: String!) { rows: Fill(where: { pool: { _eq: $p }, marketType: { _neq: "PERP" } }, limit: 1) { marketType } }`, { p: pool });
  if (other.errors) { console.log("   read rejected:", other.errors[0].message.slice(0, 120)); break; }
  if ((other.data?.rows ?? []).length > 0) {
    contaminated += 1;
    console.log(`   ${pool.slice(0, 12)}… ALSO carries ${other.data.rows[0].marketType}`);
  }
}
console.log(`D. ${contaminated === 0 ? "NO perp pool carries a non-PERP fill — a pool-only count is the same population" : `${contaminated} pool(s) carry other kinds — a pool-only count over-states`}`);

// E. the cost of the advisory count. `countUserFills` cannot reach Fill_aggregate for this role,
// so the SDK always runs its bounded row scan: one row per fill up to COUNT_FALLBACK_CAP + 1.
const { SomniaMarkets } = await import("@somnia-chain/markets-sdk");
const { hidekiTestnet } = await import("@somnia-chain/markets-sdk/chains");
const sdk: any = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: url }).client;
const seats = new Map<string, number>();
for (const r of perps.data.rows) for (const a of [r.taker, r.maker]) if (a) seats.set(String(a).toLowerCase(), (seats.get(String(a).toLowerCase()) ?? 0) + 1);
const busiestAccount = [...seats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const to = Math.floor(Date.now() / 1000);
if (!busiestAccount) console.log("E. no account in the sample; skipped");
else {
  for (const [label, window] of [["30d", 30 * 86_400], ["7d", 7 * 86_400]] as [string, number][]) {
    const t0 = Date.now();
    const n = await sdk.countUserFills(busiestAccount, { pool: busiest[0]?.[0], since: to - window, until: to });
    console.log(`E. countUserFills on the busiest sampled account, ${label}: ${n}${n >= 10_000 ? " == COUNT_FALLBACK_CAP, so a LOWER BOUND, not a total" : ""} in ${Date.now() - t0}ms`);
  }
}
