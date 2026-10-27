import "dotenv/config";

type Hex = `0x${string}`;

function address(value: string | undefined): Hex | undefined {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Hex) : undefined;
}

/**
 *  Everything here is a read. Nothing in this project signs or sends a transaction, so
 *  there is no private key to configure — `WALLET_ADDRESS` is public and only names the
 *  account whose margin the pre-flight check reads.
 */
export const config = {
  chainId: Number(process.env.CHAIN_ID ?? 50383),
  rpcUrl: process.env.RPC_URL ?? "https://api.hideki2.infra.testnet.somnia.network",
  wsUrl: process.env.WS_URL ?? "wss://api.hideki2.infra.testnet.somnia.network/ws",
  indexerUrl: process.env.INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql",
  walletAddress: address(process.env.WALLET_ADDRESS),
};
