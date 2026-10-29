import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest } from "./backtest-api.js";

const valid = { market: "BTC", days: 14, side: "long", size: "0.01", cash: "1000", intrabar: true };
test("accepts decimal-string configuration and both sides", () => {
  assert.deepEqual(parseRequest(valid), valid);
  assert.equal(parseRequest({ ...valid, side: "short", intrabar: false }).side, "short");
});
test("rejects unbounded lookbacks and invalid side", () => {
  for (const days of [0, -1, 91, 1.5, "14", NaN]) assert.throws(() => parseRequest({ ...valid, days }));
  assert.throws(() => parseRequest({ ...valid, side: "buy" }));
});
test("requires positive bounded exact decimal inputs", () => {
  for (const value of [0, "0", "-1", "1e3", "Infinity", "1.0000000000000000001", "1000000000000", "<script>"]) {
    for (const field of ["cash", "size"]) assert.throws(() => parseRequest({ ...valid, [field]: value }));
  }
});
test("rejects malformed body, market and intrabar", () => {
  for (const value of [null, [], "BTC", {}, { ...valid, market: "../../.env" }, { ...valid, intrabar: "true" }]) assert.throws(() => parseRequest(value));
});
