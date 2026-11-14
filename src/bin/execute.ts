import { perpMarkForPnl } from "@somnia-chain/markets-sdk";
import { chain, collateralAddress, createClient } from "../client.js";
import { config } from "../config.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { executeOrder, type ExecuteInput } from "../execute/executor.js";
import { ExecutionRefused } from "../execute/policy.js";
import type { OrderRequest } from "../execute/proposal.js";
import { fromRaw } from "../units.js";
import { retryRead } from "../retry.js";

/**
 *  Place (or preview) one real perp order on Somnia Hideki/Tokyo testnet (50383).
 *
 *  Dry-run by default: it reads the live market, prices the order with the same pre-trade gates the
 *  pre-flight check uses, and prints the exact bytes a live placement would broadcast — without a
 *  signer, without a key, without sending. To send, the operator opts in twice in the environment
 *  (EXECUTION_ENABLED=true, DRY_RUN=false), funds the wallet, and passes --live --confirm here. The
 *  public deployment can never reach this path: it is local-only and the route table refuses it.
 *
 *  There is no public block explorer for Hideki, so a live send prints the transaction hash as the
 *  evidence; verify it with eth_getTransactionReceipt against the RPC rather than an explorer link.
 */

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const symbol = arg("market", "BTC") as string;
const side = arg("side", "long") === "short" ? ("short" as const) : ("long" as const);
const size = arg("size", "0.01") as string;
const price = arg("price");
const cash = arg("cash", "1000") as string;
const orderType = arg("order-type", "limit") === "market" ? ("market" as const) : ("limit" as const);
const deposit = arg("deposit", cash) as string;
const live = hasFlag("live");
const confirm = hasFlag("confirm");

const exchange = createClient();
const client = exchange.client;
const collateral = collateralAddress;
if (collateral === undefined) {
  console.error("No collateral address is configured for this chain; cannot encode the margin deposit.");
  process.exit(1);
}
const cfg = await resolveConfig(client, selectMarket(await listPerps(client), symbol));
const state = await retryRead("getPerpState", () => client.getPerpState(cfg.pool as `0x${string}`));
const mark = perpMarkForPnl(state);

console.log(`${cfg.symbol}/${cfg.quoteSymbol}  pool ${cfg.pool}  chain ${chain.id} (${chain.name})`);
console.log(`mark ${fromRaw(mark.price, cfg.quoteDecimals)}${mark.fromIndex ? " (index fallback)" : ""}  OI ${fromRaw(state.openInterest, cfg.baseDecimals)} ${cfg.symbol}`);

const req: OrderRequest = { side, size, price, orderType, cash };
const input: ExecuteInput = {
  cfg,
  req,
  state: { markPrice: mark.price, openInterest: state.openInterest },
  mode: "local",
  // Both flags are required to send: --live is the per-invocation intent, --confirm the acknowledgment.
  confirm: live && confirm,
  enabled: config.execution.enabled,
  dryRun: config.execution.dryRun,
  privateKey: config.execution.privateKey,
  capDecimal: config.execution.maxNotional,
  collateral,
  deposit,
};

const result = await executeOrder(input, {
  createWriter: (privateKey) => client.createTrader({ privateKey }),
}).catch((e: unknown) => {
  if (e instanceof ExecutionRefused) {
    console.log(`\nREFUSED: ${e.message}`);
    process.exit(1);
  }
  throw e;
});

const p = result.proposal;
console.log(`\nintent  ${side} ${p.size} ${cfg.symbol} @ ${p.price}  collateral ${p.cash} ${cfg.quoteSymbol}  type ${orderType}`);
if (p.aligned) console.log(`  size aligned down from ${p.requestedSize} to the lot grid`);
for (const c of p.checks) console.log(`  [${c.verdict.toUpperCase().padEnd(4)}] ${c.id}: ${c.detail}`);
console.log(`\nmargin  notional ${p.notional}  initial ${p.initialMargin}  adverse gap ${fromRaw(p.adverseGapRaw, cfg.quoteDecimals)}  lock ${p.lock} ${cfg.quoteSymbol}`);
console.log(`        liquidation price ${p.liquidationPrice ?? "none"}  cap ${p.cap}  under cap ${p.underCap}`);
console.log(`verdict ${p.placeable ? "PLACEABLE" : `BLOCKED by ${p.binding}`}`);

if (result.action === "preview") {
  console.log(`\nDRY RUN — ${result.reason}`);
  console.log("Nothing was sent. These are the exact calls a live placement would broadcast, in order:");
  for (const call of result.calls) {
    console.log(`  ${call.description}`);
    console.log(`    to ${call.to}  value ${call.value}`);
    console.log(`    data ${call.data}`);
  }
  if (!config.execution.enabled || config.execution.dryRun) {
    console.log("\nTo send for real: fund the wallet, set EXECUTION_ENABLED=true and DRY_RUN=false in .env, then re-run with --live --confirm.");
  } else if (!live || !confirm) {
    console.log("\nLive is enabled in the environment, but this invocation needs both --live and --confirm to send.");
  }
  process.exit(0);
}

console.log("\nSENT one testnet order.");
if (result.depositHash) console.log(`  deposit tx ${result.depositHash}`);
console.log(`  order tx   ${result.hash}`);
if (result.orderId !== undefined) console.log(`  order id   ${result.orderId}`);
console.log("  No public explorer exists for Hideki; verify with eth_getTransactionReceipt against the RPC.");
process.exit(0);