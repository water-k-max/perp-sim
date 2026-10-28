import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse } from "dotenv";
import { createPublicClient, encodeFunctionData, http, parseAbi, zeroAddress, type Address, type PrivateKeyAccount, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { contractErrorsAbi, ORDER_TYPE, SELF_MATCHING_OPTION } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { assertCanonical, assertFresh, captureBlock, checkGenesis, readPlacement } from "./reader.js";
import { staticGates } from "../pretrade/gates.js";
import { address, CHAIN_ID, decimal, requireSafe, type Options } from "./input.js";
import { print, type Ports, type Snapshot } from "./workflow.js";

export const operatorAbi = [...parseAbi([
  "function placeOrderFor(address owner,bool isBid,uint64 userData,uint256 price,uint256 quantity,uint64 expireTimestampNs,uint8 orderType,uint8 selfMatchingOption,address builder,uint96 builderFeeBpsTimes1k) payable returns(bool success,uint128 orderId)",
  "function cancelOrderFor(address owner,uint128 orderId)",
  "function isOperatorAuthorized(address owner,address operator,bytes4 selector) view returns(bool)",
]), ...contractErrorsAbi] as const;
export const PLACE_SELECTOR = "0x80054449";
export const CANCEL_SELECTOR = "0xe37b444b";

// Exact fragments from markets-sdk 0.32.1 src/readsAbi.ts (internal, not exported).
export const stateAbi = parseAbi([
  "function getSystemConfig() view returns ((address marginBank, address collateralToken, address perpPoolFactory, address liquidationEngine, address insuranceFund, address feeRecipient, uint16 maxLeverageLimit, bool fullyWired))",
  "function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getOwnOpenOrders() view returns (uint128[])",
  "function getStopOrderRegistry(address perpPool) view returns (address stopOrderRegistry)",
]);
const stopTriggerSafety = "No currently authorized registry triggers at the checked block; pending stops may exist. No guarantee beyond that block; execution requires explicit acknowledgment of no simultaneous owner trading, signer nonce use, grant changes or stop changes outside this process. No grants or stops changed.";
export async function assertStopsCannotExecute(rpc: Pick<PublicClient, "readContract">, pool: Address, bank: Address, owner: Address, blockNumber: bigint): Promise<bigint[]> {
  const system = await rpc.readContract({ address: bank, abi: stateAbi, functionName: "getSystemConfig", blockNumber });
  requireSafe(system.perpPoolFactory !== zeroAddress, "Cannot establish stop registry factory");
  const registry = await rpc.readContract({ address: system.perpPoolFactory, abi: stateAbi, functionName: "getStopOrderRegistry", args: [pool], blockNumber });
  if (registry !== zeroAddress) {
    // SDK src/perp/stops.ts:352-355: triggers use placeOrderFor; SYSTEM admits only MarginBank, so registry needs owner approval.
    const authorized = await rpc.readContract({ address: pool, abi: operatorAbi, functionName: "isOperatorAuthorized", args: [owner, registry, PLACE_SELECTOR], blockNumber });
    requireSafe(authorized === false, "Cannot rule out currently authorized registry triggers at checked block; no grants or stops will be changed");
  }
  // Compatibility sentinel, NOT an enumeration or proof of no pending stops; valid only at blockNumber.
  return [];
}
export async function receiptState(rpc: Pick<PublicClient, "readContract" | "getBlock">, o: Options, s: Snapshot, receipt: TransactionReceipt) {
  const blockNumber = receipt.blockNumber;
  const verify = async () => requireSafe((await rpc.getBlock({ blockNumber })).hash === receipt.blockHash, "Receipt block hash mismatch/reorg; journal retained");
  await verify();
  const [position, orders, stops] = await Promise.all([
    rpc.readContract({ address: s.marginBank, abi: stateAbi, functionName: "getPosition", args: [o.owner, o.pool], blockNumber }),
    rpc.readContract({ address: o.pool, abi: stateAbi, functionName: "getOwnOpenOrders", account: o.owner, blockNumber }),
    assertStopsCannotExecute(rpc, o.pool, s.marginBank, o.owner, blockNumber),
  ]);
  await verify();
  return { position: position.size, orders: [...orders], stops, stopTriggerSafety, stopTriggerBlock: blockNumber };
}
export async function preflight(rpc: PublicClient, o: Options, operator: Address): Promise<Snapshot> {
  const identity = await captureBlock(rpc);
  const { blockNumber } = identity;
  await assertCanonical(rpc, identity);
  const reads = await readPlacement(rpc, o.pool, o.owner, blockNumber);
  const { cfg, position } = reads;
  const quantity = decimal(o.qty, cfg.baseDecimals), price = decimal(o.price, cfg.quoteDecimals);
  const authorized = (selector: `0x${string}`) => rpc.readContract({ address: o.pool, abi: operatorAbi, functionName: "isOperatorAuthorized", args: [o.owner, operator, selector], blockNumber });
  const [orders, place, cancel, stops] = await Promise.all([
    rpc.readContract({ address: o.pool, abi: stateAbi, functionName: "getOwnOpenOrders", account: o.owner, blockNumber }),
    authorized(PLACE_SELECTOR), authorized(CANCEL_SELECTOR), assertStopsCannotExecute(rpc, o.pool, address(cfg.marginBank), o.owner, blockNumber),
  ]);
  requireSafe(stops.length === 0, "Cannot rule out currently authorized registry triggers at checked block; no automatic cancellation");
  requireSafe(place && cancel, "Pool operator must already hold placement and cancel grants");
  requireSafe(orders.length === 0, "Owner has existing orders on selected pool");
  requireSafe(cfg.lotSize > 0n && cfg.tickSize > 0n, "Invalid market grid");
  requireSafe(quantity % cfg.lotSize === 0n && price % cfg.tickSize === 0n, "Quantity/price must exactly match grid");
  requireSafe(quantity >= cfg.minQuantity && (o.close || quantity <= cfg.maxPositionSize), "Quantity outside min/max bounds");
  if (o.close) {
    requireSafe(position.size !== 0n, "No position to close");
    requireSafe((position.size > 0n ? "short" : "long") === o.side && quantity === (position.size < 0n ? -position.size : position.size), "Close must oppose and exactly match fresh signed position");
  } else requireSafe(position.size === 0n, "Opening workflow requires owner flat on selected pool");
  const margin = reads.quote(o.side === "long", price, quantity);
  const maximum = reads.maximum(o.side === "long", price);
  requireSafe(margin.priceable && margin.sufficient, "Actual owner margin preview unpriceable or insufficient");
  requireSafe(maximum.priceable && maximum.placeable && quantity <= maximum.maxQuantity, "Max placeable gate failed");
  requireSafe(maximum.positionSize === position.size, "Position changed across preflight reads");
  const cap = 25n * 10n ** BigInt(cfg.quoteDecimals) * cfg.oneBase;
  if (!o.close) requireSafe(quantity * price <= cap && quantity * margin.markPrice <= cap, "Opening intent notional exceeds 25 USDso at limit or current mark");
  let closePreview: unknown;
  let staticReport: unknown;
  if (o.close) {
    requireSafe(margin.increasingQuantity === 0n && margin.reducingQuantity === quantity && maximum.reducingQuantity >= quantity, "Close exceeds reducing capacity");
    const preview = reads.close(quantity, price);
    requireSafe(preview.priceable && preview.placeable && preview.closedQuantity === quantity && preview.fullClose, "Close preview cannot close exact size");
    closePreview = preview;
  } else {
    const gates = staticGates(cfg, { side: o.side, size: quantity, price }, { cash: margin.unlockedCollateral, markPrice: margin.markPrice, openInterest: reads.openInterest });
    requireSafe(gates.placeable, `Static gate failed: ${gates.binding}`);
    staticReport = gates;
  }
  await assertCanonical(rpc, identity);
  return { ...identity, quantity, price, position: position.size, marginBank: address(cfg.marginBank), baseDecimals: cfg.baseDecimals, report: { margin, maximum, staticReport, closePreview, stopTriggerSafety, notionalAtLimit: quantity * price / cfg.oneBase } };
}

export function createPorts(rpc: PublicClient = createPublicClient({ chain: hidekiTestnet, cacheTime: 0, transport: http("https://api.hideki2.infra.testnet.somnia.network", { retryCount: 0 }) })): { ports: Ports; close(): Promise<void> } {
  requireSafe(hidekiTestnet.id === CHAIN_ID, "SDK chain identity changed");
  let signer: PrivateKeyAccount | undefined;
  const ports: Ports = {
    chainId: () => rpc.getChainId(),
    initialize: () => checkGenesis(rpc),
    assertFresh: (s) => assertFresh(rpc, s),
    loadSigner: async (path) => {
      requireSafe(isAbsolute(path) && basename(path) === ".env", "Signer file must be an explicit absolute path with filename exactly .env");
      const stat = statSync(path);
      requireSafe(stat.isFile() && stat.size <= 16_384, "Invalid signer file");
      const parsed = parse(readFileSync(path));
      requireSafe(typeof parsed.PRIVATE_KEY === "string" && /^0x[0-9a-fA-F]{64}$/.test(parsed.PRIVATE_KEY), "Signer file must contain PRIVATE_KEY");
      signer = privateKeyToAccount(parsed.PRIVATE_KEY as `0x${string}`);
      return address(signer.address);
    },
    preflight: (o, operator) => preflight(rpc, o, operator),
    simulate: async (o, operator, s) => {
      await assertCanonical(rpc, s);
      const args = [o.owner, o.side === "long", 0n, s.price, s.quantity, (s.blockTimestamp + 120n) * 1_000_000_000n, ORDER_TYPE.MARKET, SELF_MATCHING_OPTION.CANCEL_TAKER, zeroAddress, 0n] as const;
      const simulation = await rpc.simulateContract({ address: o.pool, abi: operatorAbi, functionName: "placeOrderFor", args, account: operator, gas: o.gas, value: 0n, blockNumber: s.blockNumber });
      await assertCanonical(rpc, s);
      requireSafe(simulation.result[0], "Contract simulation returned unsuccessful placement");
      return encodeFunctionData({ abi: operatorAbi, functionName: "placeOrderFor", args });
    },
    gasPrice: () => rpc.getGasPrice(),
    balance: (operator) => rpc.getBalance({ address: operator }),
    nonce: (operator, blockTag) => rpc.getTransactionCount({ address: operator, blockTag }),
    sign: async (tx) => { requireSafe(signer, "No signer loaded"); return signer.signTransaction({ ...tx, type: "legacy" }); },
    send: (raw) => rpc.sendRawTransaction({ serializedTransaction: raw }),
    receipt: (hash) => rpc.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000, retryCount: 0 }),
    state: (o, s, receipt) => receiptState(rpc, o, s, receipt),
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (intent) => {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try { return await terminal.question(`Type this entire line to authorize one transaction:\n${intent}\n> `); } finally { terminal.close(); }
    },
    output: print,
  };
  return { ports, close: async () => {} };
}
