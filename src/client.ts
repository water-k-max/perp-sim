import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { config } from "./config.js";

// The chain object comes from the SDK rather than being hand-written: a hand-written
// definition keeps stale endpoints when a network moves, as Hideki did at its
// 2026-09-17 regenesis.
export function createClient(): SomniaMarkets {
  return new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: config.indexerUrl,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  });
}

export const chainId = hidekiTestnet.id;
export const collateralAddress = SOMNIA_HIDEKI_TESTNET_ADDRESSES.collateral;
