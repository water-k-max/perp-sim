import { createClient } from "../client.js";
import { config } from "../config.js";

const markets = createClient();

const dump = (label: string, value: unknown): void => {
  const seen = new Set<object>();
  const json = JSON.stringify(
    value,
    (key, v) => {
      if (typeof v === "bigint") return `${v.toString()} (bigint)`;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
      }
      return v;
    },
    1,
  );
  console.log(`\n=== ${label} ===\n${json ?? String(value)}`);
};

const rows = await markets.client.listPerpMarkets({ limit: 100 });
console.log(`perp markets on chain ${config.chainId}: ${rows.length}`);
for (const r of rows) {
  console.log(
    `${r.baseSymbol ?? "?"} pool=${r.poolAddress} baseDecimals=${r.baseDecimals} oneBase=${10n ** BigInt(r.baseDecimals)} tick=${r.tickSize} lot=${r.lotSize} minQty=${r.minQuantity} imBps=${r.initialMarginBps} fundingIntervalSec=${r.fundingIntervalSec} fundingWindowSec=${r.fundingWindowSec} mark=${r.markPrice} oi=${r.openInterest}`,
  );
}

if (rows.length === 0) {
  console.log("no perp markets; nothing to probe");
  process.exit(0);
}

const pool = rows[0].poolAddress;
const marginBank = rows[0].marginBank;
dump("PerpMarket row[0] full shape", rows[0]);

const calls: Array<[string, () => Promise<unknown>]> = [
  ["getPerpRiskParams", () => markets.client.getPerpRiskParams(pool)],
  ["getPerpState", () => markets.client.getPerpState(pool)],
  ["getEffectiveImfBps", () => markets.client.getEffectiveImfBps(pool)],
  ["getPerpSystemConfig", () => markets.client.getPerpSystemConfig(marginBank)],
];

for (const [name, fn] of calls) {
  try {
    dump(name, await fn());
  } catch (e) {
    console.log(`\n=== ${name} FAILED: ${(e as Error).message.slice(0, 200)}`);
  }
}
process.exit(0);
