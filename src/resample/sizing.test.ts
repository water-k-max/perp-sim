import assert from "node:assert/strict";
import { test } from "node:test";
import { sizeLadder, simulateSizing } from "./sizing.js";

const E18 = 10n ** 18n;
const oneBase = 10n ** 8n;
const start = 100n * E18;

const trade = (pnl: bigint, size: bigint = oneBase) => ({ pnl, size });

const baseOpts = {
  seed: "sizing",
  paths: 64,
  horizonTrades: 20,
  acceptedLossQuote: 10n * E18,
  start,
  mode: "shuffle_without_replacement" as const,
  sizing: "static" as const,
  lotSize: oneBase,
  maxSize: 100n * oneBase,
  markPrice: 100n * E18,
  oneBase,
  effectiveImfBps: 500n,
  quoteScale: E18,
};

test("sizeLadder is lot-aligned, capped, and includes the run's own size", () => {
  const ladder = sizeLadder(oneBase, 20n * oneBase, [3n * oneBase]);
  assert.deepEqual(ladder, [1n, 2n, 3n, 4n, 8n, 16n].map((k) => k * oneBase));
  assert.deepEqual(sizeLadder(oneBase, 0n, []), []);
});

test("loss probabilities stay in [0, 1] and the table stops at even-money odds", async () => {
  const mixed = [trade(5n * E18), trade(-4n * E18), trade(3n * E18), trade(-2n * E18)];
  const result = await simulateSizing({ ...baseOpts, trades: mixed });
  assert.ok(result.rows.length > 0);
  for (const row of result.rows) {
    assert.ok(row.lossProbability >= 0 && row.lossProbability <= 0.5, `lossProbability ${row.lossProbability} out of bounds`);
  }
  // All-losing trades deeper than the accepted loss: every size is past even money.
  const losing = [trade(-50n * E18), trade(-60n * E18)];
  const busted = await simulateSizing({ ...baseOpts, trades: losing });
  assert.equal(busted.rows.length, 0);
});

test("loss probability is non-decreasing across the ladder", async () => {
  const mixed = [trade(8n * E18), trade(-9n * E18), trade(2n * E18), trade(-6n * E18), trade(1n * E18)];
  const result = await simulateSizing({ ...baseOpts, trades: mixed });
  for (let i = 1; i < result.rows.length; i += 1) {
    assert.ok(result.rows[i]!.lossProbability >= result.rows[i - 1]!.lossProbability);
  }
});

test("sizing output is deterministic under the seed", async () => {
  const mixed = [trade(5n * E18), trade(-4n * E18), trade(3n * E18)];
  const a = await simulateSizing({ ...baseOpts, trades: mixed });
  const b = await simulateSizing({ ...baseOpts, trades: mixed });
  assert.deepEqual(a, b);
});

test("a row beyond the IMF leverage bound produces a sanity note", async () => {
  // markPrice 100, start 100 quote: 1 base = 100 notional = 1x. IMF 5% permits 20x;
  // the 32x-lot (32 base) and 64x-lot rows exceed it, so a note names them.
  const result = await simulateSizing({ ...baseOpts, trades: [trade(1n * E18)] });
  assert.ok(result.note !== null, "expected a leverage sanity note");
  assert.ok(result.note!.includes("initial-margin"));
});

test("sizing rejects a non-positive accepted loss and an empty trade list", async () => {
  await assert.rejects(simulateSizing({ ...baseOpts, trades: [trade(1n * E18)], acceptedLossQuote: 0n }), /positive/);
  await assert.rejects(simulateSizing({ ...baseOpts, trades: [] }), /empty/);
});
