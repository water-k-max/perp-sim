import { keccak256, type Address, type Hex, type TransactionReceipt } from "viem";
import { decodePlaceOrder } from "@somnia-chain/markets-sdk";
import { CHAIN_ID, requireSafe, type Options } from "./input.js";
import { json, Journal } from "./journal.js";

export type Snapshot = {
  quantity: bigint; price: bigint; position: bigint; marginBank: Address;
  baseDecimals: number; report: unknown;
  blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint; capturedAt: number;
};
export type State = { position: bigint; orders: bigint[]; stops: bigint[] };
export type Transaction = { chainId: number; to: Address; data: Hex; value: bigint; gas: bigint; gasPrice: bigint; nonce: number };
export interface Ports {
  chainId(): Promise<number>;
  initialize(): Promise<void>;
  loadSigner(path: string): Promise<Address>;
  preflight(options: Options, operator: Address): Promise<Snapshot>;
  simulate(options: Options, operator: Address, snapshot: Snapshot): Promise<Hex>;
  gasPrice(): Promise<bigint>;
  balance(operator: Address): Promise<bigint>;
  nonce(operator: Address, blockTag: "pending" | "latest"): Promise<number>;
  assertFresh(snapshot: Snapshot): Promise<void>;
  sign(tx: Transaction): Promise<Hex>;
  send(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<TransactionReceipt>;
  state(options: Options, snapshot: Snapshot, receipt: TransactionReceipt): Promise<State>;
  tty: boolean;
  confirm(intent: string): Promise<string>;
  output(value: unknown): void;
}
export function confirmation(o: Options, operator: Address, s: Snapshot, gasPrice: bigint): string {
  return `CONFIRM ${JSON.stringify({ chain: CHAIN_ID, owner: o.owner, operator, pool: o.pool, action: o.close ? "close" : "open", side: o.side, qty: o.qty, quantityRaw: String(s.quantity), absoluteLimitPrice: o.price, priceRaw: String(s.price), startingSignedPosition: String(s.position), order: "IOC", gas: String(o.gas), gasPriceWei: String(gasPrice), maxGasSpendWei: String(o.maxGasSpend), cleanup: "NONE; this single IOC only; any remaining exposure requires a separately confirmed close" })}`;
}
export async function runTrade(o: Options, p: Ports, journal: Journal): Promise<void> {
  requireSafe(await p.chainId() === CHAIN_ID, "HTTP eth_chainId is not Hideki 50383");
  await p.initialize();
  if (o.execute) {
    requireSafe(p.tty, "Execution requires interactive stdin and stdout TTY");
    journal.acquire();
  }
  try {
    const operator = o.execute ? await p.loadSigner(o.envFile!) : o.operator!;
    requireSafe(!o.operator || operator.toLowerCase() === o.operator.toLowerCase(), "Signer differs from --operator");
    requireSafe(operator.toLowerCase() !== o.owner.toLowerCase(), "Delegated operator must differ from owner; no auto-pull");
    let snapshot = await p.preflight(o, operator);
    let data = await p.simulate(o, operator, snapshot);
    const gasPrice = await p.gasPrice();
    requireSafe(gasPrice > 0n && gasPrice * o.gas <= o.maxGasSpend, "Gas envelope exceeds user total spend cap");
    requireSafe(await p.balance(operator) >= gasPrice * o.gas, "Operator native balance cannot cover gas envelope");
    p.output({ mode: o.execute ? "awaiting-confirmation" : "dry-run", ...snapshot, gasPrice, maximumGasCost: gasPrice * o.gas, disclaimer: "Simulation is not a fill or execution guarantee" });
    if (!o.execute) return;
    const intent = confirmation(o, operator, snapshot, gasPrice);
    requireSafe(await p.confirm(intent) === intent, "Confirmation did not exactly match full intent");
    requireSafe(await p.chainId() === CHAIN_ID, "HTTP chain changed");
    const fresh = await p.preflight(o, operator);
    requireSafe(fresh.blockNumber >= snapshot.blockNumber && (fresh.blockNumber !== snapshot.blockNumber || fresh.blockHash === snapshot.blockHash), "Snapshot head regression or hash changed during confirmation");
    requireSafe(fresh.position === snapshot.position && fresh.quantity === snapshot.quantity && fresh.price === snapshot.price && fresh.marginBank === snapshot.marginBank, "Intent/state changed during confirmation");
    snapshot = fresh;
    data = await p.simulate(o, operator, snapshot);
    requireSafe(await p.balance(operator) >= gasPrice * o.gas, "Gas balance changed");
    const [latest, pending] = await Promise.all([p.nonce(operator, "latest"), p.nonce(operator, "pending")]);
    requireSafe(Number.isSafeInteger(latest) && latest >= 0 && pending === latest, "Pending nonce differs from latest; no parallel sends allowed");
    const tx: Transaction = { chainId: CHAIN_ID, to: o.pool, data, value: 0n, gas: o.gas, gasPrice, nonce: latest };
    const record = { chain: CHAIN_ID, signer: operator, nonce: latest, intent, owner: o.owner, pool: o.pool, marginBank: snapshot.marginBank, before: snapshot, transaction: tx };
    journal.prepare({ ...record, status: "prepared-not-broadcast" });
    await p.assertFresh(snapshot);
    const raw = await p.sign(tx);
    const hash = keccak256(raw);
    journal.prepare({ ...record, status: "broadcast-outcome-unresolved", hash });
    p.output({ hash, journal: journal.directory });
    requireSafe(await p.send(raw) === hash, "Broadcast hash mismatch; journal retained");
    const receipt = await p.receipt(hash);
    requireSafe(receipt.transactionHash === hash, "Receipt hash mismatch");
    const after = await p.state(o, snapshot, receipt);
    const decoded = decodePlaceOrder(receipt, o.pool);
    const filledQuantity = decoded.fills.reduce((sum, fill) => sum + fill.quantityFilled, 0n);
    const realizedNotionalRaw = decoded.fills.reduce((sum, fill) => sum + fill.quantityFilled * fill.fillPrice / (10n ** BigInt(snapshot.baseDecimals)), 0n);
    const signedFill = receipt.status === "success" ? (o.side === "long" ? filledQuantity : -filledQuantity) : 0n;
    const expectedPosition = snapshot.position + signedFill;
    const positionMatchesFills = after.position === expectedPosition;
    const fullPositionDelta = receipt.status === "success" && positionMatchesFills && filledQuantity === snapshot.quantity;
    const reviewRequired = !positionMatchesFills || after.orders.length !== 0 || after.stops.length !== 0 || filledQuantity > snapshot.quantity || (receipt.status === "reverted" && filledQuantity !== 0n);
    const fullFill = receipt.status === "success" && filledQuantity === snapshot.quantity;
    const evidence = {
      ...record, hash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice,
      gasCost: receipt.gasUsed * receipt.effectiveGasPrice, decoded, filledQuantity, realizedNotionalRaw,
      after, expectedPosition, positionMatchesFills, fullPositionDelta, fullFill, reviewRequired,
      warning: "State is authoritative at receipt block end, not transaction-level attribution or current exposure; inspect fresh state before any separate close",
    };
    if (reviewRequired) {
      journal.review(hash, evidence);
      p.output(evidence);
      requireSafe(false, "Review required: position/fill discrepancy or unexpected orders/stops; durable journal blocks further sends");
    }
    journal.complete(hash, evidence);
    p.output(evidence);
    if (after.position !== 0n) {
      p.output({ remainingSignedExposure: after.position, close: `pnpm trade --close --owner ${o.owner} --operator ${operator} --pool ${o.pool} --side ${after.position > 0n ? "short" : "long"} --qty ${humanAbs(after.position, snapshot.baseDecimals)} --price <NEW_ABSOLUTE_LIMIT> --gas ${o.gas} --max-gas-spend <STT_CAP>`, notice: "Dry-run command; inspect fresh state then add --execute --env-file /absolute/path/.env. Dust/grid/minimum or liquidity can prevent closing. No cleanup guarantee." });
    }
    requireSafe(receipt.status === "success", "Transaction reverted; evidence saved, no retry");
    requireSafe(after.orders.length === 0, "Unexpected open orders remain; inspect evidence, no automatic cancellation");
    if (!fullFill) p.output({ outcome: "NO_OR_PARTIAL_FILL", note: "Receipt-block position reconciles with decoded fills; remaining exposure requires a separately confirmed fresh close" });
  } finally { journal.release(); }
}
function humanAbs(size: bigint, decimals: number): string {
  const text = (size < 0n ? -size : size).toString().padStart(decimals + 1, "0");
  return decimals ? `${text.slice(0, -decimals)}.${text.slice(-decimals)}` : text;
}
export function print(value: unknown) { console.log(json(value)); }
