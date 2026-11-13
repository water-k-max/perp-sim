/**
 *  Clean asc-vs-desc isolation on a WARM client: bootstrap first, then interleave asc/desc
 *  venue-wide kinds queries so cold-start fetch failures cannot masquerade as an asc refusal.
 *  Read-only.
 */
import { createClient } from "../src/client.js";

const client = createClient().client;
const to = Math.floor(Date.now() / 1000);
const CLOSING = ["REDUCE", "CLOSE", "FLIP"] as const;
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 130);

async function attempt(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const rows = (await fn()) as unknown[];
    console.log(`OK   ${label}: ${rows.length} rows in ${Date.now() - t0}ms`);
    return true;
  } catch (e) {
    console.log(`FAIL ${label} (${Date.now() - t0}ms): ${firstLine(e)}`);
    return false;
  }
}

// Warm the client (bootstrap IndexedChains) with a cheap desc read.
await attempt("warmup desc limit5", () => client.listPerpPositionChanges({ kinds: CLOSING, from: to - 86400, to, order: "desc", limit: 5 }));

let ascOk = 0, descOk = 0;
for (let i = 1; i <= 3; i++) {
  if (await attempt(`round${i} venue 1d kinds ASC  limit50`, () => client.listPerpPositionChanges({ kinds: CLOSING, from: to - 86400, to, order: "asc", limit: 50 }))) ascOk++;
  if (await attempt(`round${i} venue 1d kinds DESC limit50`, () => client.listPerpPositionChanges({ kinds: CLOSING, from: to - 86400, to, order: "desc", limit: 50 }))) descOk++;
}
console.log(`SUMMARY asc ${ascOk}/3 ok, desc ${descOk}/3 ok`);
console.log("ORDER_PROBE_DONE");