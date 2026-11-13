/**
 *  Diagnose the venue-wide closing-update read: is "database query error" a scope refusal,
 *  a window-size/load problem, or transient? Compares account-scoped vs venue-wide, several
 *  window sizes, and the getFillsPage discovery feed. Read-only.
 */
import { createClient } from "../src/client.js";

const client = createClient().client;
const to = Math.floor(Date.now() / 1000);
const CLOSING = ["REDUCE", "CLOSE", "FLIP"] as const;
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);

async function attempt(label: string, fn: () => Promise<unknown>): Promise<number | null> {
  for (let i = 1; i <= 3; i++) {
    try {
      const rows = (await fn()) as unknown[];
      console.log(`OK   ${label}: ${rows.length} rows${i > 1 ? ` (attempt ${i})` : ""}`);
      return rows.length;
    } catch (e) {
      console.log(`FAIL ${label} attempt ${i}: ${firstLine(e)}`);
    }
  }
  return null;
}

// Discover one active account from the whole-venue feed (block-bounded).
const head = await client.getLatestFillBlock("PERP");
const toBlock = head ? BigInt(head.blockNumber) : 0n;
const page = await client.getFillsPage({ marketType: "PERP", sinceBlock: toBlock > 200_000n ? toBlock - 200_000n : 0n, toBlock, limit: 500 });
const who = (page.fills[0]?.taker ?? page.fills[0]?.maker ?? "").toLowerCase();
console.log(`feed page: ${page.fills.length} fills, cursor ${page.nextCursor ? "present" : "null"}, sample account ${who}`);
const feedAccounts = new Set<string>();
for (const f of page.fills) { if (f.taker) feedAccounts.add(f.taker.toLowerCase()); if (f.maker) feedAccounts.add(f.maker.toLowerCase()); }
console.log(`distinct accounts in one feed page: ${feedAccounts.size}`);

console.log("\n--- account-scoped closing changes (the documented path) ---");
await attempt("account 7d kinds asc", () => client.listPerpPositionChanges({ account: who, kinds: CLOSING, from: to - 7 * 86400, to, order: "asc", limit: 500 }));
await attempt("account 7d no kinds", () => client.listPerpPositionChanges({ account: who, from: to - 7 * 86400, to, limit: 50 }));

console.log("\n--- venue-wide closing changes (no account) ---");
await attempt("venue 1d kinds asc limit50", () => client.listPerpPositionChanges({ kinds: CLOSING, from: to - 86400, to, order: "asc", limit: 50 }));
await attempt("venue 7d kinds asc limit500", () => client.listPerpPositionChanges({ kinds: CLOSING, from: to - 7 * 86400, to, order: "asc", limit: 500 }));
await attempt("venue 7d kinds desc limit50", () => client.listPerpPositionChanges({ kinds: CLOSING, from: to - 7 * 86400, to, order: "desc", limit: 50 }));
await attempt("venue no-window no-kinds limit10", () => client.listPerpPositionChanges({ limit: 10 }));
await attempt("venue 1d no-kinds limit10", () => client.listPerpPositionChanges({ from: to - 86400, to, limit: 10 }));

console.log("\n--- legs for the sample account ---");
await attempt("getFundingPayments", () => client.getFundingPayments(who, { limit: 1000 }));
await attempt("listPerpFees", () => client.listPerpFees({ account: who, limit: 1000 }));