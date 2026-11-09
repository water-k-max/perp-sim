import { createClient } from "../src/client.js";
import { listPerps, resolveConfig, feeBps } from "../src/history/market.js";
const { client } = createClient();
const perps = await listPerps(client);
const out: string[] = [];
for (const chosen of perps) {
  try {
    const cfg = await resolveConfig(client, chosen);
    out.push(`${cfg.symbol}: taker=${feeBps(cfg, "taker")} maker=${feeBps(cfg, "maker")} bpsx1k | fundingInterval=${cfg.fundingIntervalSec}s mm=${cfg.mmBps}`);
  } catch (error) { out.push(`${chosen.symbol ?? "?"}: ERR ${(error as Error).message.slice(0, 80)}`); }
}
console.log(out.join("\n"));
console.log("markets with any non-zero fee:", out.filter(l => /taker=[^0]/.test(l) || /maker=[^0]/.test(l)).length, "of", out.length);
