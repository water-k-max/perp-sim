import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest, parseRunRequest } from "./backtest-api.js";

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

const model = { ...valid, from: 1_780_000_000, to: 1_780_600_000 };

test("a request without the new fields stays on the legacy path", () => {
  const parsed = parseRunRequest(valid);
  assert.equal(parsed.kind, "legacy");
  assert.deepEqual(parsed.kind === "legacy" ? parsed.request : null, valid);
});

test("the model path defaults the fill model, profile and strategy", () => {
  const parsed = parseRunRequest(model);
  assert.equal(parsed.kind, "model");
  if (parsed.kind !== "model") return;
  assert.equal(parsed.request.fillModel, "settlement-mark");
  assert.equal(parsed.request.fillProfile, "realistic");
  assert.equal(parsed.request.latencySec, 1);
  assert.equal(parsed.request.gasPerTx, "0");
  assert.deepEqual(parsed.request.strategy, { id: "fixed", params: { side: "long", size: "0.01", atBar: 1 } });
});

test("an ISO date is accepted as a window edge", () => {
  const parsed = parseRunRequest({ ...valid, from: "2026-10-01", to: "2026-10-08" });
  assert.equal(parsed.kind, "model");
  if (parsed.kind !== "model") return;
  assert.equal(new Date(parsed.request.from! * 1000).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(new Date(parsed.request.to! * 1000).toISOString(), "2026-10-08T00:00:00.000Z");
});

test("the model path rejects bad windows, profiles and strategies", () => {
  for (const patch of [
    { type: "from-to", value: { from: 1_780_600_000, to: 1_780_000_000 } },
    { type: "wide", value: { from: 1_700_000_000, to: 1_700_000_000 + 91 * 86_400 } },
    { type: "future", value: { from: 1, to: Math.floor(Date.now() / 1000) + 86_400 } },
    { type: "profile", value: { fillProfile: "dream" } },
    { type: "model", value: { fillModel: "book" } },
    { type: "latency", value: { latencySec: 301 } },
    { type: "gas", value: { gasPerTx: "-1" } },
    { type: "strategy", value: { strategy: { id: "hft" } } },
    { type: "strategy-params", value: { strategy: { id: "sma", params: { fast: null } } } },
  ]) assert.throws(() => parseRunRequest({ ...model, ...(patch.value as object) }), Error, patch.type);
});

test("strategy parameters stay scalars and fixed defaults keep the requested side", () => {
  const parsed = parseRunRequest({ ...model, side: "short", strategy: { id: "sma", params: { fast: 4, slow: 12, side: "both" } } });
  assert.equal(parsed.kind, "model");
  if (parsed.kind !== "model") return;
  assert.deepEqual(parsed.request.strategy, { id: "sma", params: { fast: 4, slow: 12, side: "both" } });
  const fixed = parseRunRequest({ ...model, side: "short", strategy: { id: "fixed", params: { atBar: 3 } } });
  assert.equal(fixed.kind === "model" ? fixed.request.strategy.params.side : null, "short");
});
