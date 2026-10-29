import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { simulate } from "./simulate.js";

type Row = Record<string, string | number | boolean | null>;
type Fixture = {
  capturedAt: string;
  market: string;
  range: { from: number; to: number };
  complete: boolean;
  coverage: { bars: number; missingSettlements: number; gaps: number };
  cfg: Record<string, string | number | boolean>;
  cash: string;
  entry: { bar: number; side: "long" | "short"; size: string; price: string };
  bars: Row[];
};

const fixture = JSON.parse(
  readFileSync(new URL("../../test/fixtures/btc-14d.json", import.meta.url), "utf8"),
) as Fixture;

const BIG_CFG = [
  "oneBase",
  "tickSize",
  "lotSize",
  "minQuantity",
  "imBps",
  "mmBps",
  "closeOutBps",
  "effectiveImfBps",
  "maxPositionSize",
  "maxOpenInterest",
  "takerFeeBpsTimes1k",
  "makerFeeBpsTimes1k",
] as const;
const BIG_BAR = ["mark", "indexPrice", "cum", "fundingDelta", "rate", "low", "high"] as const;

function load(): { cfg: MarketConfig; bars: Bar[]; cash: bigint; entry: { bar: number; side: "long" | "short"; size: bigint; price: bigint } } {
  const cfg = { ...fixture.cfg } as unknown as MarketConfig;
  for (const key of BIG_CFG) (cfg as unknown as Record<string, bigint>)[key] = BigInt(fixture.cfg[key]);
  const bars = fixture.bars.map((row) => {
    const bar = { ...row } as unknown as Bar;
    for (const key of BIG_BAR) {
      const value = row[key];
      (bar as unknown as Record<string, bigint | null>)[key] = value === null ? null : BigInt(value as string);
    }
    return bar;
  });
  return {
    cfg,
    bars,
    cash: BigInt(fixture.cash),
    entry: { ...fixture.entry, size: BigInt(fixture.entry.size), price: BigInt(fixture.entry.price) },
  };
}

/** The whole run, stringified, so two runs are comparable without float rounding. */
function digest(input: ReturnType<typeof simulate>): string {
  return JSON.stringify(input, (_, value) => (typeof value === "bigint" ? value.toString() : value));
}

test("the committed BTC fixture still replays to the recorded result", () => {
  const { cfg, bars, cash, entry } = load();
  assert.equal(bars.length, 336);
  assert.equal(fixture.coverage.bars, 336);
  assert.equal(fixture.coverage.missingSettlements, 0);
  assert.equal(fixture.coverage.gaps, 0);
  assert.equal(bars[entry.bar].mark, entry.price);

  const out = simulate({ cfg, bars, cash, entries: [entry] });

  assert.equal(out.status, "closed");
  assert.equal(out.equityStart, cash);
  assert.equal(out.equityEnd, 946750111830475226055n);
  assert.equal(out.realizedPnl, -11546640414385270000n);
  assert.equal(out.fundingSettled, 41703247755139503945n);
  assert.equal(out.fundingOpen, 0n);
  assert.equal(out.feesPaid, 0n);
  assert.equal(out.minEquity, 944346376550925050261n);
  assert.equal(out.minEquityBar, 311);
  assert.equal(out.roiBps, -532n);
  // The bar a lot is opened on is the first marked bar, so bar 0 never enters the trail.
  assert.equal(out.trail.length, out.bars - 1);
});

test("the same fixture replays identically, bit for bit", () => {
  const { cfg, bars, cash, entry } = load();
  const first = simulate({ cfg, bars, cash, entries: [entry] });
  const second = simulate({ cfg, bars, cash, entries: [entry] });
  assert.equal(digest(first), digest(second));
});

test("equity is exactly the sum of its signed contributions", () => {
  const { cfg, bars, cash, entry } = load();
  const out = simulate({ cfg, bars, cash, entries: [entry] });
  const funding = out.fundingSettled + out.fundingOpen;
  assert.equal(out.realizedPnl - funding - out.feesPaid, out.equityEnd - out.equityStart);
});
