// Is there ANY real perp fee record on Hideki? Six candidate reads, measured.
// Read-only public indexer calls; no signer, no key, no transaction.
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet, defineChain } from "@somnia-chain/markets-sdk/chains";
const url = process.env.INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const chain = url.includes("tokyo")
  ? defineChain({ id: 50321, name: "tokyo", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.somnia.network"] } } })
  : hidekiTestnet;
const sdk: any = new SomniaMarkets({ chain, indexerUrl: url }).client;

const perpMarkets: any[] = await sdk.listPerpMarkets({ limit: 80 });
const perpPools = new Set(perpMarkets.map((m: any) => String(m.pool ?? m.marketId ?? "").toLowerCase()));
const latest: any = await sdk.getLatestFillBlock("PERP");
const toBlock = BigInt(latest.blockNumber);
const page = await sdk.getFillsPage({ marketType: "PERP", sinceBlock: toBlock - 200_000n, toBlock, limit: 1000 });
const byPool = new Map<string, { pool: string; marketId: string; fills: any[] }>();
for (const f of page.fills) {
  const key = String(f.pool).toLowerCase();
  const entry = byPool.get(key) ?? { pool: key, marketId: String(f.marketId ?? f.market ?? "").toLowerCase(), fills: [] };
  entry.fills.push(f);
  byPool.set(key, entry);
}
const busiest = [...byPool.values()].sort((a, b) => b.fills.length - a.fills.length).slice(0, 4);
console.log(`perp markets listed=${perpMarkets.length} perp pools=${perpPools.size} fills scanned=${page.fills.length}`);

const report: string[] = [];
for (const b of busiest) {
  const head = `${b.pool.slice(0, 12)} fills=${b.fills.length}`;
  const fees = await tryRead(`getMarketFees ${b.marketId.slice(0, 10)}`, () => sdk.getMarketFees(b.marketId));
  const rates = fees ? `taker=${fees.takerFeeBps} maker=${fees.makerFeeBps} builder=${fees.maxBuilderFeeBps} routing=${fees.routingFeeBps} settle=${fees.settlementFeeBps} collected=${fees.settlementFeesCollected}` : "null";
  const proto = await tryRead(`listProtocolFees(pool)`, () => sdk.listProtocolFees({ pool: b.pool, limit: 10 }));
  const settle = await tryRead(`listSettlementFees(market)`, () => sdk.listSettlementFees({ market: b.marketId, limit: 10 }));
  const ctx = await tryRead(`getTradeContext(${b.fills[0]?.id})`, () => sdk.getTradeContext(String(b.fills[0].id)));
  const ctxFees = ctx ? `protocol=${ctx.protocolFees.length} builder=${ctx.builderFees.length} amounts=[${[...ctx.protocolFees, ...ctx.builderFees].map((r: any) => r.amount).join(",")}] takerOrder=${ctx.takerOrder?.id ?? "null"}` : "null";
  report.push(`${head} | ${rates}\n    listProtocolFees({pool}) rows=${proto?.length ?? "ERR"} nonzero=${(proto ?? []).filter((r: any) => BigInt(r.amount) !== 0n).length}\n    listSettlementFees({market}) rows=${settle?.length ?? "ERR"}\n    getTradeContext(f busiest fill) ${ctxFees}`);
}
console.log(report.join("\n"));

const unfiltered = await tryRead("listProtocolFees() any market", () => sdk.listProtocolFees({ limit: 25 }));
if (unfiltered) {
  const pools = [...new Set(unfiltered.map((r: any) => String(r.pool).toLowerCase()))];
  const onPerp = pools.filter((p) => perpPools.has(p));
  console.log(`listProtocolFees() newest 25: rows=${unfiltered.length} distinctPools=${pools.length} perpPoolsAmongThem=${onPerp.length} nonzeroAmounts=${unfiltered.filter((r: any) => BigInt(r.amount) !== 0n).length}`);
  console.log(`  sample: ${unfiltered.slice(0, 3).map((r: any) => `${String(r.pool).slice(0, 10)}:${r.amount}(taker=${r.isTakerSide})`).join(" ")}`);
} else console.log("listProtocolFees() unfiltered: ERR");

const builder = await tryRead("listBuilderFees() any", () => sdk.listBuilderFees({ limit: 25 }));
if (builder) {
  const onPerp = builder.filter((r: any) => perpPools.has(String(r.pool ?? r.market ?? "").toLowerCase()));
  console.log(`listBuilderFees() newest 25: rows=${builder.length} perpRows=${onPerp.length} nonzero=${builder.filter((r: any) => BigInt(r.amount) !== 0n).length}`);
} else console.log("listBuilderFees() unfiltered: ERR");

const allSettle = await tryRead("listSettlementFees() any", () => sdk.listSettlementFees({ limit: 25 }));
console.log(`listSettlementFees() newest 25: rows=${allSettle?.length ?? "ERR"}`);

// Does a perp fill row itself carry a fee field the reconcile could read?
const sample = busiest[0]?.fills[0];
console.log(`fill row keys: ${Object.keys(sample ?? {}).join(",")}`);
console.log(`fee-shaped fields on the fill: ${Object.keys(sample ?? {}).filter((k) => /fee|cost/i.test(k)).join(",") || "none"}`);

async function tryRead(label: string, fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (error) {
    console.log(`  ! ${label}: ${(error as Error).message.slice(0, 110)}`);
    return null;
  }
}
