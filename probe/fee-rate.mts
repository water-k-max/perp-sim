import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet, defineChain } from "@somnia-chain/markets-sdk/chains";
const BTC = "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0";
const TOKYO_POOL = "0x143ebd385cc90bd178086a8f432c9084f889ef30";
const cfgs: [string, any, string][] = [
  ["hideki BTC", hidekiTestnet, "https://hideki-dev.smk.somnia.host/v1/graphql"],
  ["tokyo", defineChain({ id: 50321, name: "tokyo", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.somnia.network"] } } }), "https://tokyo-prd.smk.somnia.host/v1/graphql"],
];
for (const [label, chain, url] of cfgs) {
  const sdk: any = new SomniaMarkets({ chain, indexerUrl: url }).client;
  const pool = label === "tokyo" ? TOKYO_POOL : BTC;
  console.log(`\n=== ${label} pool ${pool}`);
  try { console.log("  getMarketFees:", JSON.stringify(await sdk.getMarketFees(pool), (k, v) => typeof v === "bigint" ? String(v) : v)?.slice(0, 300)); }
  catch (e) { console.log("  getMarketFees ERR:", (e as Error).message.slice(0, 160)); }
  try {
    const fills = await sdk.getFillsPage({ marketType: "PERP", sinceBlock: 0n, toBlock: (await sdk.getLatestFillBlock("PERP")).blockNumber, limit: 5 });
    for (const f of fills.slice(0, 3)) {
      const ctx = await sdk.getTradeContext(String(f.id));
      console.log(`  fill ${f.id.slice(0, 20)}… fees:`, JSON.stringify({ protocol: ctx?.protocolFees, builder: ctx?.builderFees }, (k, v) => typeof v === "bigint" ? String(v) : v)?.slice(0, 260));
    }
  } catch (e) { console.log("  trade context ERR:", (e as Error).message.slice(0, 200)); }
}
