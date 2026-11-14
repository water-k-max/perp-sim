import type { Address } from "viem";
import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { retryRead } from "../retry.js";

/**
 *  The MarginBank's authoritative collateral token, read from the bank itself rather than taken
 *  from the SDK's deployment-address constant. On Hideki the constant names a stale tUSDC (6dp)
 *  while the bank actually pulls USDso (18dp): approving the constant would approve a token the
 *  bank never draws, and the deposit would revert for want of allowance on the real one.
 *
 *  The live writer resolves this same token through `getSystemConfig` (writer.bankCollateral), so
 *  the preview's approve must name it too — the bytes a dry-run shows and the bytes a live send
 *  broadcasts cannot drift. Resolved here in the wiring layer (CLI / server), never inside the
 *  executor: a dry-run must not add a chain read of its own.
 */
export async function resolveBankCollateral(client: SomniaMarketsClient, marginBank: Address): Promise<Address> {
  const sys = await retryRead(`getPerpSystemConfig ${marginBank}`, () => client.getPerpSystemConfig(marginBank));
  return sys.collateralToken;
}