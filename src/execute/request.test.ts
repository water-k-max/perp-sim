import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExecuteRequest } from "./request.js";

/**
 *  The order DTO is the last thing standing between a stray HTTP body and a real testnet transaction,
 *  so every refusal here is a canary: it must fail if the validation it checks is loosened. None of
 *  these reach a market or a lane — the parser is pure and refuses before any network is asked for.
 */

const VALID = { market: "BTC", side: "long", size: "0.01", cash: "1000" };

test("a minimal order parses with the documented defaults", () => {
  const parsed = parseExecuteRequest(VALID);
  assert.equal(parsed.market, "BTC");
  assert.deepEqual(parsed.order, { side: "long", size: "0.01", price: undefined, orderType: "limit", cash: "1000" });
  assert.equal(parsed.confirm, false, "confirm must default to false — a live send is never the default");
  assert.equal(parsed.deposit, undefined);
});

test("a full order carries every field through unchanged", () => {
  const parsed = parseExecuteRequest({ ...VALID, side: "short", price: "67000.5", orderType: "market", deposit: "250", confirm: true });
  assert.deepEqual(parsed.order, { side: "short", size: "0.01", price: "67000.5", orderType: "market", cash: "1000" });
  assert.equal(parsed.deposit, "250");
  assert.equal(parsed.confirm, true);
});

test("market defaults to BTC and is trimmed, but must be a sane symbol string", () => {
  assert.equal(parseExecuteRequest({ side: "long", size: "0.01", cash: "1000" }).market, "BTC");
  assert.equal(parseExecuteRequest({ ...VALID, market: "  eth  " }).market, "eth");
  for (const market of ["", "   ", 5, "x".repeat(33)]) {
    assert.throws(() => parseExecuteRequest({ ...VALID, market }), /market must be a symbol string/);
  }
});

test("side must be long or short — an order's direction is never guessed", () => {
  for (const side of ["buy", "sell", "LONG", "", 1, undefined, null]) {
    assert.throws(() => parseExecuteRequest({ ...VALID, side }), /side must be long or short/);
  }
});

test("orderType must be limit or market", () => {
  assert.equal(parseExecuteRequest({ ...VALID, orderType: "market" }).order.orderType, "market");
  assert.equal(parseExecuteRequest({ ...VALID, orderType: null }).order.orderType, "limit", "null falls back to the limit default");
  for (const orderType of ["ioc", "gtc", "LIMIT", 2]) {
    assert.throws(() => parseExecuteRequest({ ...VALID, orderType }), /orderType must be limit or market/);
  }
});

test("size and cash must be positive decimals, not signs, exponents or bare fractions", () => {
  for (const field of ["size", "cash"]) {
    for (const bad of ["0", "-5", "abc", "1e3", ".5", "5,0", "", 5, undefined, null]) {
      assert.throws(() => parseExecuteRequest({ ...VALID, [field]: bad }), new RegExp(`${field} must be a positive decimal`));
    }
  }
});

test("price is optional: blank or absent means the mark, but a present price must be positive", () => {
  assert.equal(parseExecuteRequest(VALID).order.price, undefined);
  assert.equal(parseExecuteRequest({ ...VALID, price: "" }).order.price, undefined);
  assert.equal(parseExecuteRequest({ ...VALID, price: "   " }).order.price, undefined);
  assert.equal(parseExecuteRequest({ ...VALID, price: "67000.5" }).order.price, "67000.5");
  for (const price of ["0", "-1", "abc", "1e3", 5]) {
    assert.throws(() => parseExecuteRequest({ ...VALID, price }), /price must be a positive decimal/);
  }
});

test("deposit is optional and may be zero, but never negative or malformed", () => {
  assert.equal(parseExecuteRequest(VALID).deposit, undefined);
  assert.equal(parseExecuteRequest({ ...VALID, deposit: "" }).deposit, undefined);
  assert.equal(parseExecuteRequest({ ...VALID, deposit: "0" }).deposit, "0", "a zero deposit is allowed and skips the deposit leg");
  assert.equal(parseExecuteRequest({ ...VALID, deposit: "250.5" }).deposit, "250.5");
  for (const deposit of ["-1", "abc", "1e3", 5]) {
    assert.throws(() => parseExecuteRequest({ ...VALID, deposit }), /deposit must be a non-negative decimal/);
  }
});

test("confirm must be a real boolean, not a truthy string or number", () => {
  assert.equal(parseExecuteRequest({ ...VALID, confirm: true }).confirm, true);
  assert.equal(parseExecuteRequest({ ...VALID, confirm: false }).confirm, false);
  assert.equal(parseExecuteRequest({ ...VALID, confirm: null }).confirm, false, "null falls back to the safe false default");
  for (const confirm of ["true", "yes", 1, 0]) {
    assert.throws(() => parseExecuteRequest({ ...VALID, confirm }), /confirm must be a boolean/);
  }
});

test("a non-object body is refused before any field is read", () => {
  for (const body of [null, undefined, [], "order", 5, true]) {
    assert.throws(() => parseExecuteRequest(body), /Expected an order configuration/);
  }
});