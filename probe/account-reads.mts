import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { defineChain, hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
const to = Math.floor(Date.now() / 1000), from = to - 7 * 86_400;
const targets: [number, string, string][] = [
  [50383, "https://hideki-dev.smk.somnia.host/v1/graphql", "hideki-dev"],
  [50321, "https://tokyo-prd.smk.somnia.host/v1/graphql", "tokyo-prd"],
];
for (const [id, url, label] of targets) {
  const chain = id === 50383 ? hidekiTestnet : defineChain({ id, name: `tokyo ${id}`, nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.somnia.network"] } } });
  const sdk: any = new SomniaMarkets({ chain: chain as never, indexerUrl: url }).client;
  const latest: any = await sdk.getLatestFillBlock("PERP");
  const toBlock = BigInt(latest.blockNumber);
  const page = await sdk.getFillsPage({ marketType: "PERP", sinceBlock: toBlock > 60_000n ? toBlock - 60_000n : 0n, toBlock, limit: 500 });
  const who = (page.fills[0] as any).taker ?? (page.fills[0] as any).maker;
  const pool = (page.fills[0] as any).pool;
  console.log(`\n=== ${label}  account ${who}  pool ${pool}`);
  const user = await sdk.getUserFillsPage(who, { marketType: "PERP", since: from, until: to, limit: 500 });
  const perPool = user.fills.filter((f: any) => String(f.pool).toLowerCase() === String(pool).toLowerCase());
  console.log(`  getUserFillsPage (all pools, 7d): ${user.fills.length} fills, cursor ${user.nextCursor ? "present" : "null"}`);
  console.log(`  of which this pool: ${perPool.length}`);
  for (const [name, call] of [
    ["listPerpOrderHistory", () => sdk.listPerpOrderHistory(who, { pool, limit: 20 })],
    ["listPerpPositions", () => sdk.listPerpPositions(who, { limit: 50 })],
    ["listPerpPositionChanges", () => sdk.listPerpPositionChanges({ account: who, pool, limit: 20 })],
    ["getFundingPayments", () => sdk.getFundingPayments({ account: who, from, to, limit: 20 })],
    ["getMarginEvents", () => sdk.getMarginEvents({ account: who, from, to, limit: 20 })],
    ["listPerpFees(no pool)", () => sdk.listPerpFees({ account: who, limit: 20 })],
    ["countUserFills", () => sdk.countUserFills(who, { marketType: "PERP" })],
    ["getTradeContext", () => sdk.getTradeContext(String(page.fills[0].id))],
  ] as [string, () => Promise<any>][]) {
    try {
      const out = await call();
      const shape = Array.isArray(out) ? `array(${out.length})` : out === null ? "null" : typeof out === "object" ? `keys[${Object.keys(out).slice(0, 8).join(",")}]` : String(out);
      console.log(`  ${name}: OK ${shape}`);
      if (Array.isArray(out) && out.length) console.log(`     sample: ${JSON.stringify(out[0]).slice(0, 240)}`);
    } catch (error) {
      console.log(`  ${name}: ERR ${(error as Error).message.slice(0, 180)}`);
    }
  }
}
