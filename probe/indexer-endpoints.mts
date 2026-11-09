// Read-only probe of the public Somnia markets indexers: which endpoints index PERP fills,
// how deep, and whether an address-scoped trade lookup actually returns rows.
// Nothing here signs, writes, or reads private state.
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

const TARGETS = [
  ["hideki-dev (current perp-sim endpoint)", "https://hideki-dev.smk.somnia.host/v1/graphql"],
  ["tokyo-prd", "https://tokyo-prd.smk.somnia.host/v1/graphql"],
  ["prd (mainnet markets)", "https://prd.smk.somnia.host/v1/graphql"],
  ["dev (testnet 50312 markets)", "https://dev.smk.somnia.host/v1/graphql"],
  ["hideki-prd", "https://hideki-prd.smk.somnia.host/v1/graphql"],
];

function client(indexerUrl: string): SomniaMarkets {
  return new SomniaMarkets({ chain: hidekiTestnet, indexerUrl }).client as unknown as SomniaMarkets;
}

const to = Math.floor(Date.now() / 1000);
const from = to - 7 * 86_400;

for (const [label, url] of TARGETS) {
  const mark = (message: string): void => console.log(`  ${message}`);
  console.log(`\n=== ${label}  ${url}`);
  let sdk: SomniaMarkets;
  try {
    sdk = client(url);
  } catch (error) {
    mark(`client construction failed: ${String(error).slice(0, 160)}`);
    continue;
  }
  try {
    const latest = await sdk.getLatestFillBlock("PERP");
    mark(`latest PERP fill indexed: ${latest ? `block ${latest.blockNumber} at ${new Date(Number(latest.timestamp) * 1000).toISOString()}` : "null"}`);
  } catch (error) {
    mark(`getLatestFillBlock(PERP) failed: ${(error as Error).message.slice(0, 220)}`);
  }
  try {
    const spot = await sdk.getLatestFillBlock("SPOT");
    mark(`latest SPOT fill indexed: ${spot ? `block ${spot.blockNumber} at ${new Date(Number(spot.timestamp) * 1000).toISOString()}` : "null"}`);
  } catch (error) {
    mark(`getLatestFillBlock(SPOT) failed: ${(error as Error).message.slice(0, 220)}`);
  }
  try {
    const markets = await sdk.listPerpMarkets({ limit: 50 });
    mark(`listPerpMarkets: ${markets.length} perp markets${markets.length ? ` (${markets.slice(0, 6).map((m) => m.symbol ?? m.marketId ?? "?").join(", ")})` : ""}`);
  } catch (error) {
    mark(`listPerpMarkets failed: ${(error as Error).message.slice(0, 200)}`);
  }
}

// Tape depth on the endpoint that answers, then one address round trip through the exact
// call path reconcileAccount uses.
const url = process.argv[2];
if (url) {
  const sdk = client(url);
  console.log(`\n=== tape probe ${url}`);
  try {
    const latest = await sdk.getLatestFillBlock("PERP");
    if (!latest) throw new Error("no PERP fill indexed on this endpoint");
    const toBlock = latest.blockNumber;
    const sinceBlock = toBlock > 30_000n ? toBlock - 30_000n : 0n;
    const page = await sdk.getFillsPage({ marketType: "PERP", sinceBlock, toBlock, limit: 500 });
    const accounts = new Map<string, number>();
    for (const fill of page.fills) {
      for (const who of [fill.taker, fill.maker]) {
        if (!who) continue;
        accounts.set(who.toLowerCase(), (accounts.get(who.toLowerCase()) ?? 0) + 1);
      }
    }
    console.log(`  rows ${page.fills.length}, first ${page.fills[0] ? new Date(Number(page.fills[0].timestamp) * 1000).toISOString() : "-"}, nextCursor ${page.nextCursor ? "present" : "null"}`);
    const top = [...accounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [who, count] of top) console.log(`  ${who.slice(0, 10)}… fills ${count}`);
    if (top[0]) {
      const who = top[0][0];
      const fills = await sdk.getUserFillsPage(who, { marketType: "PERP", since: from, until: to, limit: 500 });
      console.log(`  getUserFillsPage(${who.slice(0, 10)}…) -> ${fills.fills.length} fills in 7d`);
      const changes = await sdk.listPerpPositionChangesForFills(who, fills.fills.slice(0, 20));
      console.log(`  listPerpPositionChangesForFills -> ${changes.filter((c) => c !== null).length}/${Math.min(20, fills.fills.length)} matched position changes`);
      const fees = await sdk.listPerpFees({ account: who, limit: 100 });
      console.log(`  listPerpFees -> ${fees.length} rows`);
    }
  } catch (error) {
    console.log(`  tape probe failed: ${(error as Error).message.slice(0, 300)}`);
  }
}
