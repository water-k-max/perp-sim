import "dotenv/config";

type Hex = `0x${string}`;

function address(value: string | undefined): Hex | undefined {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Hex) : undefined;
}

/** A 32-byte private key, or undefined. Never logged, never serialised into a response. */
function secretKey(value: string | undefined): Hex | undefined {
  return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as Hex) : undefined;
}

/** An env flag with a safe default; only an explicit truthy word turns it on. */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 *  The read path needs no credential: `WALLET_ADDRESS` is public and only names the account whose
 *  margin the pre-flight check reads.
 *
 *  The execution path (2026-11-14, owner-authorized) is the one place a key may appear, and it is
 *  bounded: local-only (the route table refuses it on a deployment regardless of these settings),
 *  off by default (`EXECUTION_ENABLED=false`), preview-only by default (`DRY_RUN=true`), and capped
 *  per order (`EXECUTION_MAX_NOTIONAL`). The key is read here but never logged and never leaves this
 *  process; a deployment configures none and cannot send even if one were present.
 */
export const config = {
  chainId: Number(process.env.CHAIN_ID ?? 50383),
  rpcUrl: process.env.RPC_URL ?? "https://api.hideki2.infra.testnet.somnia.network",
  wsUrl: process.env.WS_URL ?? "wss://api.hideki2.infra.testnet.somnia.network/ws",
  indexerUrl: process.env.INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql",
  walletAddress: address(process.env.WALLET_ADDRESS),
  execution: {
    enabled: flag(process.env.EXECUTION_ENABLED, false),
    dryRun: flag(process.env.DRY_RUN, true),
    privateKey: secretKey(process.env.PRIVATE_KEY),
    /** Decimal quote ceiling on one order's notional, converted to raw units at the market's decimals. */
    maxNotional: (process.env.EXECUTION_MAX_NOTIONAL ?? "100").trim(),
  },
};
