import assert from "node:assert/strict";
import { keccak256, zeroAddress, type Address, type PublicClient } from "viem";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES as d } from "@somnia-chain/markets-sdk";
export type ReadRequest = { address: Address; functionName: string; blockNumber: bigint; account?: Address; args?: readonly unknown[] };
export function readerFixture(owner: Address, operator: Address, pool: Address) {
  // Deliberately mutable RPC responses for regression fault injection.
  const values: Record<string, any> = {
    marginBank: d.marginBank, decimals: 18,
    getSystemConfig: { marginBank: d.marginBank, collateralToken: "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72", perpPoolFactory: d.perpPoolFactory, liquidationEngine: zeroAddress, insuranceFund: zeroAddress, feeRecipient: zeroAddress, maxLeverageLimit: 100, fullyWired: true },
    isDeployedByFactory: true, isPerpPoolRegistered: true,
    tryGetHealthSnapshot: [true, { oneBase: 100n, markPrice: 10n ** 18n, projectedCumulativeFunding: 0n, effectiveIMFBps: 1000n, maintenanceMarginBps: 500n, closeOutMarginBps: 200n }],
    getOrderBookParameters: { tickSize: 1n, lotSize: 1n, minQuantity: 1n },
    getPerpPoolParameters: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, closeOutMarginBps: 200n, maxPositionSize: 10000n, maxOpenInterest: 100000n, takerFeeBpsTimes1k: 1000n, makerFeeBpsTimes1k: 0n, insuranceFundShareBps: 0n },
    getReducingCapacity: { positionSize: 0n, pendingBidQuantity: 0n, pendingAskQuantity: 0n, pendingOppositeQuantity: 0n, effectiveReducingCapacity: 0n },
    getPosition: { size: 0n, avgEntryPrice: 10n ** 18n, entryFundingIndex: 0n, lastUpdatedTimestampNs: 0n },
    getAccountState: { unlockedCollateralBalance: 1000n * 10n ** 18n, lockedCollateral: 0n, activePerpPools: [pool, operator] },
    getAccountHealth: [1000n * 10n ** 18n, 0n, 0n, 0n], getMaxLeverage: 0, getMaxLeverageLimit: 100,
    getCreditFloor: 0n, getVoucherLeverageCap: 10, isVoucherMarketAllowed: true, isRestricted: false, isolationAllowsMarket: true,
    getOpenInterest: 0n, getOwnOpenOrders: [], isOperatorAuthorized: true, getStopOrderRegistry: zeroAddress,
  };
  const calls: ReadRequest[] = [];
  const f = { values, calls, head: 5n, blockHash: keccak256("0x1234"), blocks: 0, mismatchAt: Infinity,
    rpc: undefined as unknown as PublicClient };
  f.rpc = {
    getBlockNumber: async (args: { cacheTime: number }) => { assert.equal(args.cacheTime, 0); return f.head; },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: ++f.blocks >= f.mismatchAt ? keccak256("0xab") : f.blockHash, timestamp: 1000n }),
    readContract: async (r: ReadRequest) => {
      assert.equal(r.blockNumber, f.head); calls.push(r);
      if (r.functionName === "getOwnOpenOrders") assert.equal(r.account, owner);
      if (["getPosition", "getAccountState", "getAccountHealth", "getReducingCapacity", "getMaxLeverage", "getCreditFloor", "isolationAllowsMarket"].includes(r.functionName)) assert.equal(r.args?.[0], owner);
      assert.ok(r.functionName in values, `Unexpected RPC ${r.functionName}`);
      return values[r.functionName];
    },
  } as unknown as PublicClient;
  return f;
}
