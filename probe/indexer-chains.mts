// Read-only probe, second pass: address each indexer with the chain it actually indexes,
// then run the exact call path reconcileAccount uses (fills -> position changes -> fees).
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { ChainId, defineChain, hidekiTestnet, somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";

const TARGETS: [string, number, string][] = [
  ["hideki-testnet 50383 (current)", 50383, "https://hideki-dev.smk.somnia.host/v1/graphql"],
  ["tokyo 50321", 50321, "https://tokyo-prd.smk.somnia.host/v1/graphql"],
  ["mainnet 5031", 5031, "https://prd.smk.somnia.host/v1/graphql"],
  ["testnet 50312", 50312, "https://dev.smk.somnia.host/v1/graphql"],
];

const known: Record<number, unknown> = { 50383: hidekiTestnet, 5031: somniaMainnet, 50312: somniaShannon };
function read(url: string, chainId: number): any {
  const chain = known[chainId] ?? defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [`https://rpc.somnia.network/${chainId}`] } } });
  return new SomniaMarkets({ chain: chain as never, indexerUrl: url }).client;
}

const to = Math.floor(Date.now() / 1000);
const from = to - 7 * 86_400;

for (const [label, chainId, url] of TARGETS) {
  console.log(`\n=== ${label}  ${url}  (ChainId has it: ${Object.values(ChainId).includes(chainId as never)})`);
  let sdk: any;
  try {
    sdk = read(url, chainId);
  } catch (error) {
    console.log(`  client refused: ${(error as Error).message.slice(0, 200)}`);
    continue;
  }
  let latest: any = null;
  try {
    latest = await sdk.getLatestFillBlock("PERP");
    console.log(`  latest PERP fill: ${latest ? `block ${latest.blockNumber} at ${new Date(Number(latest.timestamp) * 1000).toISOString()}` : "null"}`);
  } catch (error) {
    console.log(`  getLatestFillBlock(PERP): ${(error as Error).message.slice(0, 240)}`);
    continue;
  }
  try {
    const markets = await sdk.listPerpMarkets({ limit: 60 });
    console.log(`  listPerpMarkets -> ${markets.length} rows; symbols: ${(markets as any[]).slice(0, 12).map((m) => m.symbol ?? m.baseSymbol ?? "?").join(",")}`);
  } catch (error) {
    console.log(`  listPerpMarkets: ${(error as Error).message.slice(0, 200)}`);
  }
  if (!latest) continue;
  let fills: any[] = [];
  try {
    const toBlock = BigInt(latest.blockNumber);
    const page = await sdk.getFillsPage({ marketType: "PERP", sinceBlock: toBlock > 60_000n ? toBlock - 60_000n : 0n, toBlock, limit: 500 });
    fills = page.fills;
    console.log(`  tape page -> ${fills.length} perp fills, newest ${fills.length ? new Date(Number(fills[fills.length - 1].timestamp) * 1000).toISOString() : "-"}, oldest ${fills.length ? new Date(Number(fills[0].timestamp) * 1000).toISOString() : "-"}`);
  } catch (error) {
    console.log(`  getFillsPage: ${(error as Error).message.slice(0, 240)}`);
    continue;
  }
  const counts = new Map<string, number>();
  for (const fill of fills) {
    for (const who of [fill.taker, fill.maker]) {
      if (!who) continue;
      const key = who.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  distinct counterparties on this page: ${ranked.length}`);
  for (const [who, count] of ranked.slice(0, 3)) console.log(`    ${who} -> ${count} legs`);
  const pool = fills[0]?.pool;
  const who = ranked[0]?.[0];
  if (!who || !pool) continue;
  try {
    const page = await sdk.getUserFillsPage(who, { marketType: "PERP", pool, since: from, until: to, limit: 500 });
    console.log(`  getUserFillsPage(7d, this pool) -> ${page.fills.length} fills, nextCursor ${page.nextCursor ? "present" : "null"}`);
    const changes = await sdk.listPerpPositionChangesForFills(who, page.fills.slice(0, 25));
    const matched = changes.filter((c: any) => c !== null).length;
    console.log(`  listPerpPositionChangesForFills -> ${matched}/${Math.min(25, page.fills.length)} fills have a chain position change`);
    if (changes[0]) {
      const c = changes.find((x: any) => x) as any;
      console.log(`  sample change: kind=${c.kind} sizeAfter=${c.sizeAfter} closedSize=${c.closedSize} realizedPnl=${c.realizedPnl} exitPrice=${c.exitPrice} entryPriceBefore=${c.entryPriceBefore}`);
    }
    const fees = await sdk.listPerpFees({ account: who, pool, limit: 50 });
    console.log(`  listPerpFees -> ${fees.length} rows`);
    const orders = await sdk.listPerpOrderHistory({ account: who, pool, limit: 20 }).catch((error: any) => {
      console.log(`  listPerpOrderHistory: ${(error as Error).message.slice(0, 160)}`);
      return null;
    });
    if (orders) console.log(`  listPerpOrderHistory -> ${(orders as any[]).length} rows`);
    const positions = await sdk.listPerpPositions({ account: who, limit: 20 }).catch((error: any) => {
      console.log(`  listPerpPositions: ${(error as Error).message.slice(0, 160)}`);
      return null;
    });
    if (positions) console.log(`  listPerpPositions -> ${(positions as any[]).length} open rows`);
  } catch (error) {
    console.log(`  account round trip: ${(error as Error).message.slice(0, 300)}`);
  }
}
