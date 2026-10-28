import { basename, isAbsolute } from "node:path";
import { getAddress, parseUnits, zeroAddress, type Address } from "viem";

export class SafetyError extends Error {}
export function requireSafe(ok: unknown, message: string): asserts ok {
  if (!ok) throw new SafetyError(message);
}
export const CHAIN_ID = 50383;
export const GAS_CAP = 30_000_000n;
export const ARENA = "0xfd8a91ccd9494c7bf73145dc7d727a85fe46fa62";
export function address(text: string): Address {
  requireSafe(/^0x[0-9a-fA-F]{40}$/.test(text), "Invalid public address");
  const value = getAddress(text);
  requireSafe(value !== zeroAddress && value.toLowerCase() !== ARENA, "Zero/Arena address forbidden");
  return value;
}
export function decimal(text: string, decimals: number): bigint {
  requireSafe(text.length <= 80 && /^(0|[1-9]\d*)(\.\d+)?$/.test(text), "Use a positive plain decimal");
  requireSafe((text.split(".")[1]?.length ?? 0) <= decimals, "Excess decimal precision; no rounding allowed");
  const value = parseUnits(text, decimals);
  requireSafe(value > 0n && value < 2n ** 256n, "Amount outside positive uint256 range");
  return value;
}
export type Options = {
  owner: Address; operator?: Address; pool: Address; side: "long" | "short";
  qty: string; price: string; gas: bigint; maxGasSpend: bigint;
  execute: boolean; close: boolean; envFile?: string;
};
export function parseArgs(args: string[]): Options {
  const flags = new Set(["execute", "close"]);
  const values = new Set(["owner", "operator", "pool", "side", "qty", "price", "gas", "max-gas-spend", "env-file", "chain"]);
  const found = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith("--") ? args[i].slice(2) : "";
    requireSafe((flags.has(key) || values.has(key)) && !found.has(key), "Unknown or duplicate argument");
    const value = flags.has(key) ? "true" : args[++i];
    requireSafe(value !== undefined && !value.startsWith("--"), "Missing argument value");
    found.set(key, value);
  }
  const need = (key: string) => { const v = found.get(key); requireSafe(v !== undefined, `Required --${key}`); return v; };
  requireSafe(!found.has("chain") || found.get("chain") === String(CHAIN_ID), "Only Hideki chain 50383 allowed");
  const side = need("side");
  requireSafe(side === "long" || side === "short", "Side must be long or short");
  const gasText = need("gas");
  requireSafe(/^[1-9]\d{0,7}$/.test(gasText), "Gas must be a positive integer");
  const gas = BigInt(gasText);
  requireSafe(gas <= GAS_CAP, "Gas exceeds 30M hard cap");
  const execute = found.has("execute");
  requireSafe(execute || !found.has("env-file"), "Dry run never accepts a signer file");
  requireSafe(!execute || found.has("env-file"), "Execute requires explicit --env-file");
  if (execute) requireSafe(isAbsolute(need("env-file")) && basename(need("env-file")) === ".env", "Signer filename must be exactly .env under an explicit absolute path");
  const qty = need("qty"), price = need("price");
  decimal(qty, 77); decimal(price, 77);
  const out: Options = {
    owner: address(need("owner")), pool: address(need("pool")), side, qty, price, gas,
    maxGasSpend: decimal(need("max-gas-spend"), 18), execute, close: found.has("close"),
    operator: found.has("operator") ? address(need("operator")) : undefined,
    envFile: found.get("env-file"),
  };
  requireSafe(execute || out.operator, "Dry run requires --operator public address");
  return out;
}
export const HELP = `Testnet delegated IOC only; default is read-only simulation.
pnpm trade --owner ADDRESS --operator ADDRESS --pool ADDRESS --side long|short --qty DECIMAL --price ABSOLUTE_LIMIT --gas INTEGER --max-gas-spend STT
Add --execute --env-file /absolute/path/.env for a TTY-confirmed send.
Add --close with the opposite side and exact current position quantity for a separate confirmed close.
Only chain 50383. Opening intent notional <=25 USDso at limit AND mark; favorable sell fills can exceed this realized notional.
No funding, linking, grants, automatic cleanup or write retries. No atomic reduce-only flag; external concurrent owner activity can invalidate close checks.
A successful receipt does not guarantee any fill. Unresolved tmp/trade-journal blocks all further sends; do not delete it or retry without independently resolving its hash/nonce.`;
