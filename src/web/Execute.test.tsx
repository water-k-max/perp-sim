import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutePanel, ExecutionUnavailable, OrderResult } from "./Execute.js";
import { parseExecutionCapability, validateExecuteResult, type ExecuteResultDTO, type ExecutionCapability, type OrderProposalDTO } from "./dto.js";

/**
 *  The bounded execution lens, rendered. Its job is honesty about a real-money path: the public
 *  deployment must say it is read-only and keyless (never a form), a dry-run must badge itself DRY RUN
 *  and offer only a preview, a live send must require an explicit confirm and a key, and a sent order's
 *  receipt must carry the transaction hash as evidence and link it to the REAL Somnia Tokyo explorer
 *  (Hideki = Tokyo) — a link to any other host would be a fabricated destination. Fixtures are test
 *  data, not live figures or real hashes.
 */
const ADDR = `0x${"1".repeat(40)}`;
const HASH = `0x${"a".repeat(64)}`;
const DEPOSIT_HASH = `0x${"b".repeat(64)}`;

const baseProposal: OrderProposalDTO = {
  symbol: "BTC", quoteSymbol: "USDso", side: "long", orderType: "limit",
  size: "0.01", price: "50000", markPrice: "50000", notional: "500", lock: "50", initialMargin: "50",
  liquidationPrice: "45000", cash: "1000", cap: "1000",
  underCap: true, placeable: true, binding: null, aligned: false, requestedSize: "0.01",
  checks: [{ id: "collateral", verdict: "pass", detail: "lock 50 + fee 0 vs collateral 1000" }],
};
const proposal = (over: Partial<OrderProposalDTO> = {}): OrderProposalDTO => ({ ...baseProposal, ...over });
const preview = (over: Partial<OrderProposalDTO> = {}): ExecuteResultDTO => ({
  action: "preview", reason: "DRY_RUN is true — previewing the order, not sending it.", proposal: proposal(over),
  calls: [{ to: ADDR, data: "0xdeadbeef", value: "0", description: "placeOrder buy/long qty 1 price 50000 type 0" }],
});
const send = (over: Partial<OrderProposalDTO> = {}): ExecuteResultDTO => ({ action: "send", proposal: proposal(over), hash: HASH, depositHash: DEPOSIT_HASH, orderId: "42" });

const dryCap: ExecutionCapability = { available: true, mode: "local", enabled: false, dryRun: true, hasKey: false, maxNotional: "100" };
const liveCap: ExecutionCapability = { available: true, mode: "local", enabled: true, dryRun: false, hasKey: true, maxNotional: "100" };
const liveNoKey: ExecutionCapability = { ...liveCap, hasKey: false };
const render = (cap: ExecutionCapability) => renderToStaticMarkup(<ExecutePanel capability={cap} />);

test("the public deployment says read-only and keyless, and renders no order form", () => {
  const m = renderToStaticMarkup(<ExecutionUnavailable />);
  assert.ok(m.includes("local-only"), "names the local-only boundary");
  assert.ok(m.includes("read-only"), "says the deployment is read-only");
  assert.ok(m.includes("holds no key"), "says it holds no key");
  assert.ok(!m.includes("exec-size"), "no size input on the public deployment");
  assert.ok(!m.includes("<button"), "no place/preview button on the public deployment");
});

test("a dry-run capability badges DRY RUN and offers only a preview, with no confirm gate", () => {
  const m = render(dryCap);
  assert.ok(m.includes("DRY RUN"), "the dry-run badge is present");
  assert.ok(m.includes("Preview order"), "the button previews, not sends");
  assert.ok(!m.includes("LIVE · TESTNET"), "no live badge in dry-run");
  assert.ok(!m.includes("exec-confirm"), "no confirm checkbox when nothing can be sent");
  assert.ok(m.includes("no transaction is sent"), "the safety note says nothing is sent");
});

test("a live capability badges LIVE · TESTNET, names the chain and cap, and requires a confirm", () => {
  const m = render(liveCap);
  assert.ok(m.includes("LIVE · TESTNET"), "the live badge is present");
  assert.ok(m.includes("50383"), "names the testnet chain id");
  assert.ok(m.includes("exec-confirm"), "the per-request confirm checkbox is present");
  assert.ok(m.includes("Place testnet order"), "the button places, not previews");
  assert.ok(m.includes("real order"), "the safety note says it is a real order");
});

test("CANARY: a live capability with no key cannot send and says so", () => {
  const m = render(liveNoKey);
  assert.ok(m.includes("NO KEY"), "the keyless badge is present");
  assert.ok(m.includes("No PRIVATE_KEY is configured"), "it states no key is configured");
  assert.ok(m.includes("nothing can be signed"), "it says nothing can be signed");
});

test("the preview renders the reason, the proposal money and the calldata, with no hash", () => {
  const m = renderToStaticMarkup(<OrderResult result={preview()} />);
  assert.ok(m.includes("Preview"), "it is labelled a preview");
  assert.ok(m.includes("DRY_RUN is true"), "the policy reason is shown");
  assert.ok(m.includes("Notional"), "the proposal metrics render");
  assert.ok(m.includes("never sent"), "the calldata is marked never sent");
  assert.ok(m.includes("0xdeadbeef"), "the exact calldata is shown");
  assert.ok(!m.includes(HASH), "a preview carries no transaction hash");
});

test("CANARY: a sent order links its hash to the real Somnia Tokyo explorer, never a fabricated host", () => {
  const m = renderToStaticMarkup(<OrderResult result={send()} />);
  assert.ok(m.includes("Order sent on testnet"), "it is labelled a send");
  assert.ok(m.includes(HASH), "the transaction hash is the evidence");
  assert.ok(m.includes(DEPOSIT_HASH), "the deposit hash is shown when present");
  assert.ok(m.includes("42"), "the order id is shown");
  assert.ok(m.includes(`https://explorer.testnet.somnia.network/tokyo/tx/${HASH}`), "the tx hash links to the real Somnia Tokyo explorer");
  assert.ok(m.includes(`https://explorer.testnet.somnia.network/tokyo/tx/${DEPOSIT_HASH}`), "the deposit hash links to the real explorer too");
  assert.ok(m.includes("eth_getTransactionReceipt"), "it still names the keyless RPC verification");
  assert.ok(!m.includes("explorer.example"), "no fabricated explorer host is rendered");
});

test("a not-placeable proposal surfaces the binding gate, and an over-cap one says so", () => {
  const blocked = renderToStaticMarkup(<OrderResult result={preview({ placeable: false, binding: "collateral" })} />);
  assert.ok(blocked.includes("Binding gate"), "the failing gate is named");
  assert.ok(blocked.includes("collateral"), "the binding check id is shown");
  const overCap = renderToStaticMarkup(<OrderResult result={preview({ underCap: false })} />);
  assert.ok(overCap.includes("Over the notional cap"), "the cap breach is stated");
});

test("an aligned-down size says what was requested versus what will be placed", () => {
  const m = renderToStaticMarkup(<OrderResult result={preview({ aligned: true, requestedSize: "0.015", size: "0.01" })} />);
  assert.ok(m.includes("aligned down"), "the alignment is disclosed");
  assert.ok(m.includes("0.015"), "the requested size is shown");
});

test("parseExecutionCapability accepts a config answer and rejects anything malformed", () => {
  assert.deepEqual(parseExecutionCapability(dryCap), dryCap);
  assert.deepEqual(parseExecutionCapability({ ...liveCap, mode: "serverless", available: false }), { ...liveCap, mode: "serverless", available: false });
  assert.equal(parseExecutionCapability(null), null);
  assert.equal(parseExecutionCapability({ ...dryCap, available: "yes" }), null);
  assert.equal(parseExecutionCapability({ ...dryCap, mode: "remote" }), null);
  assert.equal(parseExecutionCapability({ ...dryCap, maxNotional: "abc" }), null);
  assert.equal(parseExecutionCapability({ ...dryCap, hasKey: 1 }), null);
});

test("validateExecuteResult accepts a preview and a send, and round-trips the proposal", () => {
  const p = validateExecuteResult(preview());
  assert.equal(p.action, "preview");
  const s = validateExecuteResult(send());
  assert.equal(s.action, "send");
  assert.equal(s.action === "send" && s.hash, HASH);
});

test("CANARY: a send result without a valid hash is refused — no evidence, no send", () => {
  assert.throws(() => validateExecuteResult({ action: "send", proposal: baseProposal }), /transaction hash/);
  assert.throws(() => validateExecuteResult({ action: "send", proposal: baseProposal, hash: "0x123" }), /transaction hash/);
  assert.throws(() => validateExecuteResult({ action: "send", proposal: baseProposal, hash: HASH, depositHash: "nope" }), /deposit hash/);
});

test("validateExecuteResult refuses a malformed proposal, call or action", () => {
  assert.throws(() => validateExecuteResult(null), /unexpected order result/);
  assert.throws(() => validateExecuteResult({ action: "teleport", proposal: baseProposal }), /unknown order action/);
  assert.throws(() => validateExecuteResult({ action: "preview", reason: "x", proposal: { ...baseProposal, notional: "lots" }, calls: [] }), /invalid amount/);
  assert.throws(() => validateExecuteResult({ action: "preview", reason: "x", proposal: { ...baseProposal, checks: [{ id: "c", verdict: "maybe", detail: "d" }] }, calls: [] }), /invalid gate check/);
  assert.throws(() => validateExecuteResult({ action: "preview", reason: "x", proposal: baseProposal, calls: [{ to: "0xshort", data: "0x00", value: "0", description: "d" }] }), /invalid call/);
  assert.throws(() => validateExecuteResult({ action: "preview", proposal: baseProposal, calls: [] }), /missing its reason/);
});