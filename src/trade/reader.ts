import { BlockNotFoundError, parseAbi, type Address, type PublicClient } from "viem";
import { perpOrderMarginQuote, SOMNIA_HIDEKI_TESTNET_ADDRESSES as deployment } from "@somnia-chain/markets-sdk";
import type { MarketConfig } from "../history/market.js";
import { requireSafe } from "./input.js";
import type { Snapshot } from "./workflow.js";

// Minimal fragments transcribed from SDK 0.32.1 readsAbi.ts; no private imports.
export const tradeReadAbi = parseAbi([
  "function marginBank() view returns (address)",
  "function decimals() view returns (uint8)",
  "function getOpenInterest() view returns (uint256 openInterest)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function getPerpPoolParameters() view returns ((uint256 initialMarginBps, uint256 maintenanceMarginBps, uint256 closeOutMarginBps, uint256 maxOpenInterest, uint256 maxPositionSize, uint256 takerFeeBpsTimes1k, int256 makerFeeBpsTimes1k, uint256 insuranceFundShareBps))",
  "function tryGetHealthSnapshot() view returns (bool ok, (uint256 oneBase, uint256 markPrice, int256 projectedCumulativeFunding, uint256 effectiveIMFBps, uint256 maintenanceMarginBps, uint256 closeOutMarginBps) snapshot)",
  "function getReducingCapacity(address account) view returns ((int128 positionSize, uint256 pendingBidQuantity, uint256 pendingAskQuantity, uint256 pendingOppositeQuantity, uint256 effectiveReducingCapacity) capacity)",
  "function isRestricted() view returns (bool)",
  "function isDeployedByFactory(address perpPool) view returns (bool)",
  "function isPerpPoolRegistered(address perpPool) view returns (bool)",
  "function getSystemConfig() view returns ((address marginBank, address collateralToken, address perpPoolFactory, address liquidationEngine, address insuranceFund, address feeRecipient, uint16 maxLeverageLimit, bool fullyWired))",
  "function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getAccountState(address account) view returns ((int256 unlockedCollateralBalance, uint256 lockedCollateral, address[] activePerpPools))",
  "function getAccountHealth(address account) view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)",
  "function isolationAllowsMarket(address account, address market) view returns (bool)",
  "function getMaxLeverage(address account, address perpPool) view returns (uint16)",
  "function getMaxLeverageLimit() view returns (uint16)",
  "function getCreditFloor(address account) view returns (uint256)",
  "function getVoucherLeverageCap() view returns (uint16)",
  "function isVoucherMarketAllowed(address perpPool) view returns (bool)",
]);
export type BlockIdentity = Pick<Snapshot, "blockNumber" | "blockHash" | "blockTimestamp" | "capturedAt">;
export const MAX_SNAPSHOT_AGE_MS = 5_000;
export async function checkGenesis(rpc: Pick<PublicClient, "getBlock">) {
  // SDK client.ts uses a block-1 denylist, NOT an expected current-genesis hash.
  try {
    const block = await rpc.getBlock({ blockNumber: 1n });
    requireSafe(block.hash !== "0x0ddf6446070d043158fd7aa80d3c835a9e446efdc05601f9ad67eebc9864a4ae", "Retired Hideki v1 genesis");
  } catch (error) { if (!(error instanceof BlockNotFoundError)) throw error; }
}
export async function captureBlock(rpc: Pick<PublicClient, "getBlock" | "getBlockNumber">): Promise<BlockIdentity> {
  const capturedAt = Date.now();
  const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 });
  const block = await rpc.getBlock({ blockNumber });
  requireSafe(block.number === blockNumber && block.hash !== null, "Missing snapshot block identity");
  return { blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp, capturedAt };
}
export async function assertCanonical(rpc: Pick<PublicClient, "getBlock">, s: BlockIdentity) {
  const block = await rpc.getBlock({ blockNumber: s.blockNumber });
  requireSafe(block.number === s.blockNumber && block.hash === s.blockHash, "Snapshot canonical hash mismatch");
}
export async function assertFresh(rpc: Pick<PublicClient, "getBlock" | "getBlockNumber">, s: BlockIdentity) {
  const head = await captureBlock(rpc);
  requireSafe(head.blockNumber >= s.blockNumber, "Execution head regression");
  requireSafe(head.blockNumber === s.blockNumber && head.blockHash === s.blockHash, "Execution head changed since snapshot");
  const elapsed = Date.now() - s.capturedAt;
  requireSafe(elapsed >= 0 && elapsed <= MAX_SNAPSHOT_AGE_MS, "Snapshot elapsed age expired");
}
const abs = (x: bigint) => x < 0n ? -x : x;
const same = (a: Address, b: Address | undefined) => b !== undefined && a.toLowerCase() === b.toLowerCase();
export async function readPlacement(rpc: Pick<PublicClient, "readContract">, poolAddress: Address, owner: Address, blockNumber: bigint) {
  const pool = { address: poolAddress, abi: tradeReadAbi, blockNumber } as const;
  const marginBank = await rpc.readContract({ ...pool, functionName: "marginBank" });
  requireSafe(same(marginBank, deployment.marginBank), "Unexpected margin bank");
  const bank = { address: marginBank, abi: tradeReadAbi, blockNumber } as const;
  const system = await rpc.readContract({ ...bank, functionName: "getSystemConfig" });
  // SDK deployment.collateral identifies binary tUSDC, not perpetual USDso.
  requireSafe(same(system.marginBank, marginBank) && same(system.collateralToken, "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72") && same(system.perpPoolFactory, deployment.perpPoolFactory) && system.fullyWired, "Unexpected margin bank/collateral/factory or unwired system");
  const [deployed, registered, quoteDecimals] = await Promise.all([
    rpc.readContract({ address: system.perpPoolFactory, abi: tradeReadAbi, blockNumber, functionName: "isDeployedByFactory", args: [poolAddress] }),
    rpc.readContract({ ...bank, functionName: "isPerpPoolRegistered", args: [poolAddress] }),
    rpc.readContract({ address: system.collateralToken, abi: tradeReadAbi, blockNumber, functionName: "decimals" }),
  ]);
  requireSafe(deployed && registered, "Pool not deployed/registered");
  requireSafe(quoteDecimals === 18, "Unexpected USDso collateral decimals");
  const [ok, snap] = await rpc.readContract({ ...pool, functionName: "tryGetHealthSnapshot" });
  requireSafe(ok && snap.markPrice > 0n && snap.oneBase > 0n, "Actual owner margin preview unpriceable");
  const baseDecimals = snap.oneBase.toString().length - 1;
  requireSafe(baseDecimals <= 77 && 10n ** BigInt(baseDecimals) === snap.oneBase, "Invalid onchain oneBase");
  const [book, params, capacity, position, state, health, leverage, leverageLimit, creditFloor, voucherCap, voucherAllowed, restricted, isolationAllowed, openInterest] = await Promise.all([
    rpc.readContract({ ...pool, functionName: "getOrderBookParameters" }),
    rpc.readContract({ ...pool, functionName: "getPerpPoolParameters" }),
    rpc.readContract({ ...pool, functionName: "getReducingCapacity", args: [owner] }),
    rpc.readContract({ ...bank, functionName: "getPosition", args: [owner, poolAddress] }),
    rpc.readContract({ ...bank, functionName: "getAccountState", args: [owner] }),
    rpc.readContract({ ...bank, functionName: "getAccountHealth", args: [owner] }),
    rpc.readContract({ ...bank, functionName: "getMaxLeverage", args: [owner, poolAddress] }),
    rpc.readContract({ ...bank, functionName: "getMaxLeverageLimit" }),
    rpc.readContract({ ...bank, functionName: "getCreditFloor", args: [owner] }),
    rpc.readContract({ ...bank, functionName: "getVoucherLeverageCap" }),
    rpc.readContract({ ...bank, functionName: "isVoucherMarketAllowed", args: [poolAddress] }),
    rpc.readContract({ ...pool, functionName: "isRestricted" }),
    rpc.readContract({ ...bank, functionName: "isolationAllowsMarket", args: [owner, poolAddress] }),
    rpc.readContract({ ...pool, functionName: "getOpenInterest" }),
  ]);
  requireSafe(capacity.positionSize === position.size, "Position changed across preflight reads");
  const cfg: MarketConfig = { symbol: poolAddress, quoteSymbol: "USDso", pool: poolAddress, marginBank, stopRegistry: null,
    baseDecimals, quoteDecimals, oneBase: snap.oneBase, ...book, imBps: params.initialMarginBps, mmBps: params.maintenanceMarginBps,
    closeOutBps: params.closeOutMarginBps, effectiveImfBps: snap.effectiveIMFBps, maxPositionSize: params.maxPositionSize,
    maxOpenInterest: params.maxOpenInterest, takerFeeBpsTimes1k: params.takerFeeBpsTimes1k, makerFeeBpsTimes1k: params.makerFeeBpsTimes1k,
    fundingWindowSec: 0, fundingIntervalSec: 0, imBpsMismatch: false };
  const inputs = { oneBase: snap.oneBase, markPrice: snap.markPrice, effectiveImfBps: snap.effectiveIMFBps,
    positionSize: capacity.positionSize, effectiveReducingCapacity: capacity.effectiveReducingCapacity,
    equity: health[0], imRequirement: health[1], unlockedCollateral: state.unlockedCollateralBalance,
    accountMaxLeverageX: leverage, protocolMaxLeverageX: leverageLimit, creditFloor, voucherLeverageCapX: voucherCap,
    voucherMarketAllowed: voucherAllowed, restricted, isolationAllowsMarket: isolationAllowed,
    takerFeeBpsTimes1k: params.takerFeeBpsTimes1k, makerFeeBpsTimes1k: params.makerFeeBpsTimes1k };
  const quote = (isBid: boolean, price: bigint, quantity: bigint) => ({ priceable: true, asOfBlock: blockNumber, ...inputs,
    ...perpOrderMarginQuote({ ...inputs, isBid, price, quantity, builderFeeBpsTimes1k: 0n }) });
  function maximum(isBid: boolean, price: bigint) {
    // SDK no-autoPull branch: without wallet inputs top-up is always zero; fits is monotone.
    const fits = (q: bigint) => {
      const newAbs = abs(position.size + (isBid ? q : -q));
      const at = quote(isBid, price, q);
      return (newAbs <= params.maxPositionSize || newAbs <= abs(position.size)) && at.topUpRequired === 0n && at.sufficient;
    };
    let lo = 0n, hi = params.maxPositionSize + abs(position.size) + 1n;
    while (hi - lo > 1n) { const mid = lo + (hi - lo) / 2n; if (fits(mid)) lo = mid; else hi = mid; }
    const maxQuantity = lo / book.lotSize * book.lotSize;
    return { ...quote(isBid, price, maxQuantity), maxQuantity, placeable: maxQuantity > 0n && maxQuantity >= book.minQuantity };
  }
  function close(quantity: bigint, price: bigint) {
    const closedQuantity = (quantity > abs(position.size) ? abs(position.size) : quantity) / book.lotSize * book.lotSize;
    const signed = position.size > 0n ? 1n : -1n;
    const numerator = (price - position.avgEntryPrice) * signed * closedQuantity;
    const realizedPnl = numerator / snap.oneBase - (numerator < 0n && numerator % snap.oneBase !== 0n ? 1n : 0n);
    const funding = position.size * (snap.projectedCumulativeFunding - position.entryFundingIndex);
    const denominator = 10n ** 18n * snap.oneBase;
    const fundingSettled = funding / denominator + (funding > 0n && funding % denominator !== 0n ? 1n : 0n);
    const fee = (closedQuantity * price / snap.oneBase) * params.takerFeeBpsTimes1k / 10_000_000n;
    const remainingSize = position.size - signed * closedQuantity;
    return { priceable: true, asOfBlock: blockNumber, closedQuantity, remainingSize, fullClose: position.size !== 0n && remainingSize === 0n,
      realizedPnl, fundingSettled, fee, netProceeds: realizedPnl - fundingSettled - fee, placeable: closedQuantity > 0n && closedQuantity >= book.minQuantity };
  }
  return { cfg, position, openInterest, quote, maximum, close };
}
