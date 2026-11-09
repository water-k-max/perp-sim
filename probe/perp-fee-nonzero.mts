// Follow-up: is a non-zero fee record anywhere in the readable streams, and what does
// each perp market's frozen fee config actually say? Read-only public indexer calls.
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet, defineChain } from "@somnia-chain/markets-sdk/chains";
const url = process.env.INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const chain = url.includes("tokyo")
  ? defineChain({ id: 50321, name: "tokyo", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.somnia.network"] } } })
  : hidekiTestnet;
const sdk: any = new SomniaMarkets({ chain, indexerUrl: url }).client;

const perps: any[] = await sdk.listPerpMarkets({ limit: 80 });
console.log(`perp market row keys: ${Object.keys(perps[0] ?? {}).join(",")}`);
const ids = perps.slice(0, 6).map((m: any) => ({ id: String(m.id ?? m.marketId ?? "").toLowerCase(), pool: String(m.pool ?? "").toLowerCase(), symbol: m.symbol ?? m.baseSymbol ?? "?" }));
for (const m of ids) {
  const fees = await tryRead(`getMarketFees ${m.symbol}`, () => sdk.getMarketFees(m.id || m.pool));
  console.log(`${m.symbol} id=${m.id.slice(0, 10) || "none"} pool=${m.pool.slice(0, 10)}: ${fees ? `taker=${fees.takerFeeBps} maker=${fees.makerFeeBps} builderCap=${fees.maxBuilderFeeBps} routing=${fees.routingFeeBps} settlement=${fees.settlementFeeBps} collected=${fees.settlementFeesCollected}` : "null (no attribution)"}`);
}

// Sweep the protocol-fee stream for any non-zero record.
let scanned = 0, nonzero = 0, perpRows = 0;
const perpPoolSet = new Set(perps.map((m: any) => String(m.pool ?? "").toLowerCase()).filter((p: string) => p !== ""));
for (let offset = 0; offset < 600; offset += 50) {
  const rows = await tryRead(`listProtocolFees offset ${offset}`, () => sdk.listProtocolFees({ limit: 50, offset }));
  if (!rows) break;
  scanned += rows.length;
  nonzero += rows.filter((r: any) => BigInt(r.amount) !== 0n).length;
  perpRows += rows.filter((r: any) => perpPoolSet.has(String(r.pool).toLowerCase())).length;
  if (rows.length < 50) break;
}
console.log(`protocol-fee stream: scanned=${scanned} nonZero=${nonzero} onPerpPools=${perpRows} perpPoolsKnown=${perpPoolSet.size}`);

const perpFeesAny = await tryRead("listPerpFees() unfiltered", () => sdk.listPerpFees({ limit: 50 }));
console.log(`listPerpFees() unfiltered newest 50: rows=${perpFeesAny?.length ?? "ERR"}`);
const perpFeeStreams = await tryRead("listPerpFeeTotals()", () => sdk.listPerpFeeTotals?.());
console.log(`listPerpFeeTotals(): ${perpFeeStreams === undefined ? "not a method" : JSON.stringify(perpFeeStreams).slice(0, 200)}`);

async function tryRead(label: string, fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (error) {
    console.log(`  ! ${label}: ${(error as Error).message.slice(0, 110)}`);
    return null;
  }
}
