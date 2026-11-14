import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPLORER_BASE, explorerAddressUrl, explorerTxUrl } from "./explorer.js";

/**
 *  Hideki is the Tokyo testnet (50383) and it has a real public explorer. These pin the one verified
 *  host so an evidence link can never drift to a fabricated or wrong-network destination — the same
 *  intent the UI render guard enforces, checked here at the source of the URL.
 */
const HASH = `0x${"a".repeat(64)}`;
const ADDR = `0x${"1".repeat(40)}`;

test("CANARY: evidence links are built on the real Somnia Tokyo explorer host, not a fabricated one", () => {
  assert.equal(EXPLORER_BASE, "https://explorer.testnet.somnia.network/tokyo");
  const tx = new URL(explorerTxUrl(HASH));
  assert.equal(tx.origin, "https://explorer.testnet.somnia.network", "the tx link uses the verified explorer origin");
  assert.equal(tx.pathname, `/tokyo/tx/${HASH}`, "the tx link is on the Tokyo network path");
  const addr = new URL(explorerAddressUrl(ADDR));
  assert.equal(addr.origin, "https://explorer.testnet.somnia.network", "the address link uses the verified explorer origin");
  assert.equal(addr.pathname, `/tokyo/address/${ADDR}`, "the address link is on the Tokyo network path");
});

test("the tx and address helpers embed the exact hash/address they are given", () => {
  assert.ok(explorerTxUrl(HASH).endsWith(`/tx/${HASH}`));
  assert.ok(explorerAddressUrl(ADDR).endsWith(`/address/${ADDR}`));
});