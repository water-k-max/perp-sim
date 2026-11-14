import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { config } from "./config.js";

// The chain object comes from the SDK rather than being hand-written: a hand-written
// definition keeps stale endpoints when a network moves, as Hideki did at its
// 2026-09-17 regenesis.
export const chain = hidekiTestnet;

export function createClient(): SomniaMarkets {
  return new SomniaMarkets({
    chain,
    indexerUrl: config.indexerUrl,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  });
}

export const chainId = chain.id;

// No collateral-address constant is exported: SOMNIA_HIDEKI_TESTNET_ADDRESSES.collateral names a
// stale tUSDC (6dp) on Hideki, while the MarginBank actually pulls USDso (18dp). Execution reads the
// bank's authoritative token via getPerpSystemConfig (see execute/collateral.ts), so the preview's
// approve and the live deposit cannot name different tokens.

/**
 *  What this process is actually reading, in the words the interface has to show.
 *
 *  There are two chain identities in this tool and they are set apart: `chain.id` is the one the
 *  SDK client signs its queries against, while `config.chainId` is the one written into every
 *  dataset manifest and cache key. Nothing stopped them disagreeing — `CHAIN_ID=50321` in the
 *  environment labels Hideki data as Tokyo, and the UI, which had no way to know, could only name
 *  one of them from a literal typed into a component. This is the one place both are read, so a
 *  surface can state them together or say they conflict; no component is allowed to name a network
 *  it has not asked about.
 */
export type ChainReport = {
  name: string;
  readChainId: string;
  manifestChainId: string;
  indexerUrl: string;
  testnet: boolean;
  agrees: boolean;
};

export function chainReport(): ChainReport {
  const readChainId = String(chain.id);
  const manifestChainId = String(config.chainId);
  return {
    name: chain.name,
    readChainId,
    manifestChainId,
    indexerUrl: config.indexerUrl,
    testnet: chain.testnet === true,
    agrees: readChainId === manifestChainId,
  };
}
