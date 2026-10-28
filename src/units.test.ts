import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { fromRaw } from "./units.js";

test("formats small WBTC quantities and their exact notional", () => {
  assert.equal(fromRaw(11000n, 8), "0.00011");
  assert.equal(fromRaw(1n, 8), "0.00000001");
  assert.equal(fromRaw(8827599000000000000n, 18), "8.827599");
});

test("retains every raw unit across market decimal scales and signs", () => {
  for (const decimals of [0, 6, 7, 8, 9, 18, 24]) {
    for (const raw of [0n, 1n, -1n, 10n ** BigInt(decimals), 123456789012345678901234567890n, -123456789012345678901234567890n]) {
      assert.equal(parseUnits(fromRaw(raw, decimals), decimals), raw);
    }
  }
});

test("omits insignificant trailing zeroes without losing fractional units", () => {
  assert.equal(fromRaw(0n, 18), "0.0");
  assert.equal(fromRaw(100000000n, 8), "1.0");
  assert.equal(fromRaw(-125000000n, 8), "-1.25");
  assert.equal(fromRaw(1000000000000000001n, 18), "1.000000000000000001");
});

test("displayed PnL funding fees and equity reconcile exactly", () => {
  const decimals = 18;
  const start = parseUnits("1000", decimals);
  const pnl = parseUnits("-25.3918454", decimals);
  const funding = parseUnits("-37.0654507", decimals);
  for (const direction of [1n, -1n]) {
    for (const fees of [0n, parseUnits("-0.000000000000000001", decimals)]) {
      const contributions = [pnl * direction, funding * direction, fees];
      const total = contributions.reduce((sum, amount) => sum + amount, 0n);
      const displayed = (amount: bigint) => parseUnits(fromRaw(amount, decimals), decimals);
      assert.equal(contributions.map(displayed).reduce((sum, amount) => sum + amount, 0n), displayed(total));
      assert.equal(displayed(start) + displayed(total), displayed(start + total));
    }
  }
});
