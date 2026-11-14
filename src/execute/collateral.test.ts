import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import type { SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { resolveBankCollateral } from "./collateral.js";

const BANK: Address = `0x${"22".repeat(20)}`;
// The token the bank actually names, deliberately NOT the deployment-address constant.
const BANK_TOKEN: Address = `0x${"ed".repeat(20)}`;

/** A client that answers getPerpSystemConfig with the bank's own collateral token. */
function fakeClient(collateralToken: Address, failFirst = 0): SomniaMarketsClient {
  let calls = 0;
  return {
    getPerpSystemConfig: async (bank: Address) => {
      assert.equal(bank, BANK, "the read must target the market's margin bank");
      calls += 1;
      if (calls <= failFirst) throw new Error("rpc getBlock failed: genesis check failed");
      return { marginBank: bank, collateralToken, fullyWired: true };
    },
  } as unknown as SomniaMarketsClient;
}

test("resolveBankCollateral returns the bank's authoritative token, not a deployment constant", async () => {
  assert.equal(await resolveBankCollateral(fakeClient(BANK_TOKEN), BANK), BANK_TOKEN);
});

test("resolveBankCollateral rides out a transient RPC drop rather than aborting the order", async () => {
  assert.equal(await resolveBankCollateral(fakeClient(BANK_TOKEN, 1), BANK), BANK_TOKEN);
});

test("resolveBankCollateral surfaces a permanent read failure", async () => {
  const client = {
    getPerpSystemConfig: async () => { throw new Error("execution reverted: not the bank"); },
  } as unknown as SomniaMarketsClient;
  await assert.rejects(() => resolveBankCollateral(client, BANK), /not the bank/);
});