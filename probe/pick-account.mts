import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet, defineChain } from "@somnia-chain/markets-sdk/chains";
const url = process.env.INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const chain = url.includes("tokyo") ? defineChain({ id: 50321, name: "tokyo", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.somnia.network"] } } }) : hidekiTestnet;
const sdk: any = new SomniaMarkets({ chain, indexerUrl: url }).client;
const markets = await sdk.listPerpMarkets({ limit: 60 });
console.log("row keys:", Object.keys(markets[0] ?? {}).join(","));
console.log(JSON.stringify(markets[0], (k, v) => typeof v === "bigint" ? String(v) : v).slice(0, 400));
const to = Math.floor(Date.now() / 1000), from = to - 7 * 86_400;
const latest: any = await sdk.getLatestFillBlock("PERP");
const toBlock = BigInt(latest.blockNumber);
const page = await sdk.getFillsPage({ marketType: "PERP", sinceBlock: toBlock - 200_000n, toBlock, limit: 1000 });
const byPool = new Map<string, number>();
for (const f of page.fills) byPool.set(String(f.pool).toLowerCase(), (byPool.get(String(f.pool).toLowerCase()) ?? 0) + 1);
const btc = markets.find((m: any) => /BTC/i.test(JSON.stringify(m)));
console.log("busiest pools:", [...byPool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `${p.slice(0, 12)}=${n}`).join(" "));
if (btc) console.log("BTC market row:", JSON.stringify(btc, (k, v) => typeof v === "bigint" ? String(v) : v).slice(0, 300));
// rank accounts by 7d perp fill count, look for a human-scale trader (10-300 fills)
const accounts = new Map<string, number>();
for (const f of page.fills) for (const a of [f.taker, f.maker]) if (a) accounts.set(String(a).toLowerCase(), (accounts.get(String(a).toLowerCase()) ?? 0) + 1);
const ranked = [...accounts.keys()].slice(0, 24);
const rows: [string, number][] = [];
for (const who of ranked) { try { rows.push([who, await sdk.countUserFills(who, { marketType: "PERP", since: from, until: to })]); } catch (e) { rows.push([who, -1]); } }
rows.sort((a, b) => a[1] - b[1]);
console.log("7d perp fill counts (ascending):", rows.map(([a, n]) => `${a.slice(0, 10)}=${n}`).join(" "));
const mid = rows.filter(([, n]) => n >= 8 && n <= 400);
console.log("CANDIDATE", mid[0] ? mid[0][0] : "none");
