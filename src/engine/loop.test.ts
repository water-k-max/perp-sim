import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { run, hashRun } from "./loop.js";
import { ParameterTimeline } from "../data/params.js";
import type { EpochRow } from "../data/types.js";
import { simulate } from "./simulate.js";
import { fixedPosition } from "../strategy/fixed.js";
import type { TapeFill } from "../data/types.js";
import type { TapeSource } from "../data/tape.js";

type Row = Record<string, string | number | boolean | null>;
type Fixture = {
  cfg: Record<string, string | number | boolean>;
  cash: string;
  entry: { bar: number; side: "long" | "short"; size: string; price: string };
  bars: Row[];
};

const fixture = JSON.parse(
  readFileSync(new URL("../../test/fixtures/btc-14d.json", import.meta.url), "utf8"),
) as Fixture;

const BIG_CFG = [
  "oneBase", "tickSize", "lotSize", "minQuantity", "imBps", "mmBps", "closeOutBps",
  "effectiveImfBps", "maxPositionSize", "maxOpenInterest", "takerFeeBpsTimes1k", "makerFeeBpsTimes1k",
] as const;
const BIG_BAR = ["mark", "indexPrice", "cum", "fundingDelta", "rate", "low", "high"] as const;

function load() {
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

test("the loop reproduces the legacy settlement-mark result bit for bit", async () => {
  const { cfg, bars, cash, entry } = load();
  const legacy = simulate({ cfg, bars, cash, entries: [entry] });
  const out = await run({
    cfg,
    bars,
    cash,
    strategy: fixedPosition({ side: entry.side, size: entry.size, atBar: entry.bar }),
    fillModel: "settlement-mark",
    untilBar: bars.length - 1,
  });

  assert.equal(out.status, legacy.status);
  assert.equal(out.equityEnd, legacy.equityEnd);
  assert.equal(out.realizedPnl, legacy.realizedPnl);
  assert.equal(out.fundingSettled, legacy.fundingSettled);
  assert.equal(out.fundingOpen, legacy.fundingOpen);
  assert.equal(out.feesTaker, legacy.feesPaid);
  assert.equal(out.gasPaid, 0n);
  assert.equal(out.minEquity, legacy.minEquity);
  assert.equal(out.minEquityBar, legacy.minEquityBar);
  assert.equal(out.roiBps, legacy.roiBps);
  assert.equal(out.liquidatedAtBar, legacy.liquidatedAtBar);
  assert.equal(out.closedAtBar, legacy.closedAtBar);
  assert.equal(out.barsHeld, legacy.barsHeld);

  // The loop trails the flat bar 0 that the legacy loop skips, then tracks it one for one.
  assert.equal(out.trail.length, legacy.trail.length + 1);
  for (let i = 0; i < legacy.trail.length; i += 1) {
    const a = out.trail[i + 1]!;
    const b = legacy.trail[i]!;
    assert.equal(a.t, b.t, `bar ${i} time`);
    assert.equal(a.size, b.size, `bar ${i} size`);
    assert.equal(a.equityAtMark, b.equityAtMark, `bar ${i} equity at mark`);
    // Cumulative funding agrees; the legacy `fundingThisBar` is structurally zero because it
    // subtracts a figure measured at the same bar, so it is compared through its total.
    assert.equal(a.fundingAccrued, b.fundingAccrued, `bar ${i} funding`);
    assert.equal(a.maintenanceMargin, b.maintenanceMargin, `bar ${i} maintenance margin`);
  }
});

test("the same run twice yields the same event hash", async () => {
  const { cfg, bars, cash, entry } = load();
  const once = () =>
    run({
      cfg,
      bars,
      cash,
      strategy: fixedPosition({ side: entry.side, size: entry.size, atBar: entry.bar }),
      fillModel: "settlement-mark" as const,
    });
  const a = await once();
  const b = await once();
  assert.equal(a.eventHash, b.eventHash);
});

test("the loop's own books balance: price - funding - fees - gas = delta equity", async () => {
  const { cfg, bars, cash, entry } = load();
  const out = await run({
    cfg,
    bars,
    cash,
    strategy: fixedPosition({ side: entry.side, size: entry.size, atBar: entry.bar }),
    fillModel: "settlement-mark",
  });
  const funding = out.fundingSettled + out.fundingOpen;
  assert.equal(out.realizedPnl - funding - out.feesTaker - out.feesMaker - out.gasPaid, out.equityEnd - out.equityStart);
});

const syntheticBars = (): Bar[] => {
  const out: Bar[] = [];
  for (let i = 0; i < 5; i += 1) {
    const mark = (100n + BigInt(i)) * 10n ** 18n;
    out.push({
      t: 1_000 + i * 3_600,
      mark,
      markSource: "mark",
      indexPrice: mark,
      cum: 0n,
      fundingDelta: 0n,
      rate: 0n,
      fundingWindowSec: 3600,
      fundingIntervalSec: 3600,
      intervalsSettled: 1,
      intervalsAccrued: 1,
      forgivenIntervals: 0,
      anchorResynced: false,
      gapSec: 3600,
      missedIntervals: 0,
      low: mark,
      high: mark,
      candles: 1,
    });
  }
  return out;
};

const fakeTape = (fills: TapeFill[]): TapeSource => ({
  async slice(fromSec, toSec) {
    return {
      key: "fake",
      fromSec,
      toSec,
      fills: fills.filter((f) => f.t >= fromSec && f.t < toSec),
      complete: true,
      pages: 1,
      truncated: false,
    };
  },
  consumed: () => [],
  digest: () => "fake",
});

const tapePrint = (id: string, t: number, whole: bigint, sizeBase: number): TapeFill => ({
  id,
  block: 1,
  logIndex: Number(id),
  t,
  price: whole * 10n ** 18n,
  size: BigInt(sizeBase) * 10n ** 8n,
  quote: 0n,
  takerIsBid: true,
  maker: null,
  taker: null,
  txHash: "0x",
});

test("a tape fill prices at the trade-tape VWAP, not the settlement mark", async () => {
  const { cfg } = load();
  const bars = syntheticBars();
  const tape = fakeTape([tapePrint("1", 1_002, 101n, 1), tapePrint("2", 1_003, 102n, 1)]);
  const out = await run({
    cfg,
    bars,
    cash: 1_000n * 10n ** 18n,
    strategy: fixedPosition({ side: "long", size: 2n * 10n ** 8n, atBar: 1 }),
    fillModel: "tape",
    tape,
    latencySec: 1,
    fillProfile: "optimistic",
  });
  assert.equal(out.fills.length, 3);
  assert.deepEqual(out.fills.slice(0, 2).map(f => f.t), [1002, 1003]);
  assert.equal(out.orders[0]!.price, 101n * 10n ** 18n + 5n * 10n ** 17n, "half of 101 and 102");
  assert.deepEqual(out.fills.slice(0, 2).flatMap(f => f.consumedFillIds), ["1", "2"]);
  assert.equal(out.orders[0]!.status, "filled");
  assert.equal(out.fills[2]!.tag, "terminal-close");
  assert.equal(out.fills[2]!.t, bars.at(-1)!.t);
  assert.equal(out.fills[2]!.price, bars.at(-1)!.mark);
  assert.deepEqual(out.fills[2]!.consumedFillIds, []);
});

test("no tape in the window is a rejected order, never a synthetic mark fill", async () => {
  const { cfg } = load();
  const out = await run({
    cfg,
    bars: syntheticBars(),
    cash: 1_000n * 10n ** 18n,
    strategy: fixedPosition({ side: "long", size: 10n ** 8n, atBar: 1 }),
    fillModel: "tape",
    tape: fakeTape([]),
    latencySec: 1,
  });
  assert.equal(out.fills.length, 0);
  assert.equal(out.orders[0]!.status, "rejected");
  assert.match(out.orders[0]!.reason ?? "", /no eligible tape/);
  assert.equal(out.equityEnd, 1_000n * 10n ** 18n);
});

test("future prints cross settlement causally; callbacks submit at execution time", async () => {
  const { cfg } = load();
  const bars = syntheticBars().slice(0, 3).map((b, i) => ({ ...b, t: 1000 + i * 10 }));
  const observations: number[] = [];
  const out = await run({ cfg, bars, cash: 1000n * 10n ** 18n, fillModel: "tape", fillProfile: "realistic",
    tape: fakeTape([tapePrint("1", 1012, 100n, 4)]), strategy: {
      id: "timing", params: {},
      onBar(ctx) { if (ctx.index === 0) ctx.submit({ side: "buy", size: cfg.oneBase }); },
      onFill(ctx) { observations.push(ctx.now, ctx.bar.t); ctx.submit({ side: "buy", size: cfg.oneBase }); },
    },
  });
  assert.equal(out.trail[1]!.size, 0n);
  assert.deepEqual(observations, [1012, 1010]);
  assert.equal(out.orders[1]!.decidedAt, 1012);
  assert.equal(out.orders[1]!.eligibleAt, 1013);
});

test("participation is per print, shared across overlapping orders, bounded by horizon", async () => {
  const { cfg } = load();
  const bars = syntheticBars().slice(0, 2).map((b, i) => ({ ...b, t: 1000 + i * 10 }));
  const bounds: number[] = [];
  const tape = fakeTape([]);
  tape.slice = async (fromSec, toSec) => {
    bounds.push(toSec);
    return { key: "fake", fromSec, toSec, complete: true, truncated: false, pages: 1,
      fills: [tapePrint("1", 1002, 100n, 4), tapePrint("2", 1011, 100n, 100)] };
  };
  const out = await run({ cfg, bars, cash: 1000n * 10n ** 18n, fillModel: "tape", tape, closeAtEnd: false,
    strategy: { id: "overlap", params: {}, onBar(ctx) {
      if (ctx.index === 0) for (let i = 0; i < 2; i++) ctx.submit({ side: "buy", size: 2n * cfg.oneBase });
    } },
  });
  assert.deepEqual(bounds, [1010, 1010]);
  assert.equal(out.fills.length, 1);
  assert.equal(out.fills[0]!.size, cfg.oneBase);
  assert.equal(out.orders[0]!.status, "partial");
  assert.equal(out.orders[1]!.filled, 0n);
});

const epoch = (logIndex: number, fee: bigint): EpochRow => ({
  blockNumber: 2, logIndex, timestamp: 1002, initialMarginBps: null, maintenanceMarginBps: null,
  closeOutMarginBps: null, takerFeeBpsTimes1k: fee, makerFeeBpsTimes1k: null,
  maxPositionSize: null, maxOpenInterest: null, insuranceFundShareBps: null, source: "test",
});

test("onStart resolves the first bar's historical parameters before strategy initialization", async () => {
  const { cfg } = load();
  const params = new ParameterTimeline([epoch(1, 1000n), epoch(5, 2000n)], cfg);
  for (const positioned of [true, false]) {
    const bars = syntheticBars().map((b, i) => ({ ...b, t: 1002 + i * 10,
      ...(positioned ? { block: 2 + i, logIndex: 4 } : {}) }));
    let initial: MarketConfig | undefined;
    await run({ cfg, bars, params, cash: 1000n * 10n ** 18n, fillModel: "settlement-mark",
      strategy: { id: "start-epochs", params: {},
        onStart(ctx) { initial = ctx.cfg; },
        onBar(ctx) {
          if (ctx.index === 0) assert.deepEqual(ctx.cfg, initial);
        },
      },
    });
    assert.equal(initial!.takerFeeBpsTimes1k, positioned ? 1000n : 2000n);
    assert.equal(initial!.lotSize, cfg.lotSize, "non-epoch fields retain live values");
  }
});

test("tape VWAP retains exact price-quantity remainders across three fills", async () => {
  const { cfg } = load();
  const base = 100n * 10n ** 18n;
  const prints = [0n, 1n, 2n].map((offset, i) => ({
    ...tapePrint(String(i + 1), 1002 + i, 100n, 1), price: base + offset,
  }));
  const observed: bigint[] = [];
  const out = await run({ cfg, bars: syntheticBars(), cash: 1000n * 10n ** 18n,
    fillModel: "tape", fillProfile: "optimistic", closeAtEnd: false, tape: fakeTape(prints),
    strategy: { id: "exact-vwap", params: {},
      onBar(ctx) { if (ctx.index === 0) ctx.submit({ side: "buy", size: 3n * cfg.oneBase }); },
      onFill(_ctx, fill) { observed.push(fill.price); },
    },
  });
  assert.deepEqual(observed, prints.map(f => f.price));
  assert.equal(out.orders[0]!.filled, 3n * cfg.oneBase);
  assert.equal(out.orders[0]!.price, base + 1n);
});

test("execution epochs resolve by block/log, including two changes in one block", async () => {
  const { cfg } = load();
  const bars = syntheticBars().slice(0, 3).map((b, i) => ({ ...b, t: 1000 + i * 2, block: i + 1, logIndex: 4 }));
  const prints = [tapePrint("1", 1002, 100n, 1), tapePrint("2", 1002, 100n, 1)]
    .map((f, i) => ({ ...f, block: 2, logIndex: i === 0 ? 2 : 6 }));
  const params = new ParameterTimeline([epoch(1, 1000n), epoch(5, 2000n)], cfg);
  const out = await run({ cfg, bars, params, cash: 1000n * 10n ** 18n, fillModel: "tape", fillProfile: "optimistic",
    tape: fakeTape(prints), strategy: { id: "epochs", params: {}, onBar(ctx) {
      if (ctx.index === 0) ctx.submit({ side: "buy", size: 2n * cfg.oneBase });
    } },
  });
  assert.equal(out.orders[0]!.decidedBlock, 1);
  assert.equal(out.orders[0]!.decidedLogIndex, 4);
  assert.deepEqual(out.fills.slice(0, 2).map(f => f.feeBps), [1000n, 2000n]);
  assert.equal(out.trail[1]!.size, cfg.oneBase, "settlement sits between the two prints");
  const settlement = await run({ cfg, bars, params, cash: 1000n * 10n ** 18n, fillModel: "settlement-mark",
    strategy: fixedPosition({ side: "long", size: cfg.oneBase, atBar: 1 }),
  });
  assert.equal(settlement.fills[0]!.feeBps, 1000n);
});

test("liquidation cancels queued later prints without booking them", async () => {
  const { cfg } = load();
  const bars = syntheticBars().slice(0, 5).map((b, i) => ({ ...b, t: 1000 + i * 3, low: i === 2 ? 0n : b.low }));
  const out = await run({ cfg, bars, cash: 10n * 10n ** 18n, fillModel: "tape", fillProfile: "realistic",
    tape: fakeTape([tapePrint("1", 1002, 100n, 4), tapePrint("2", 1008, 100n, 4), tapePrint("3", 1011, 100n, 4)]),
    strategy: { id: "liquidate", params: {}, onBar(ctx) {
      if (ctx.index === 0) ctx.submit({ side: "buy", size: 2n * cfg.oneBase });
    } },
  });
  assert.equal(out.status, "liquidated");
  assert.equal(out.liquidatedAtBar, 2);
  assert.equal(out.fills.length, 1);
  assert.equal(out.fills[0]!.t, 1002);
  assert.equal(out.orders[0]!.status, "partial");
});

test("a mid-interval entry is not stressed by extremes that preceded it", async () => {
  const { cfg } = load();
  const cash = 200n * 10n ** 18n;
  const size = 10n * cfg.oneBase;
  // One interval with a deep low; the only question is whether the position existed for it.
  const bars = syntheticBars().slice(0, 3).map((b, i) => ({ ...b, t: 1000 + i * 3, low: i === 1 ? 80n * 10n ** 18n : b.low }));

  const tapeEntry = await run({ cfg, bars, cash, fillModel: "tape", fillProfile: "optimistic",
    tape: fakeTape([tapePrint("1", 1002, 100n, 10)]),
    strategy: { id: "mid-entry", params: {}, onBar(ctx) { if (ctx.index === 0) ctx.submit({ side: "buy", size }); } },
  });
  assert.deepEqual(tapeEntry.relaxedStressBars, [1]);
  assert.equal(tapeEntry.liquidatedAtBar, null);
  assert.equal(tapeEntry.status, "closed");
  assert.equal(tapeEntry.fills[0]!.t, 1002);

  // Same extreme, but the position predates the interval: the full low applies.
  const markEntry = await run({ cfg, bars, cash, fillModel: "settlement-mark",
    strategy: fixedPosition({ side: "long", size, atBar: 1 }),
  });
  assert.equal(markEntry.status, "liquidated");
  assert.equal(markEntry.liquidatedAtBar, 1);
  assert.deepEqual(markEntry.relaxedStressBars, []);
});

test("zero-latency callback cannot reuse its observed print", async () => {
  const { cfg } = load();
  const out = await run({ cfg, bars: syntheticBars(), cash: 1000n * 10n ** 18n,
    fillModel: "tape", fillProfile: "optimistic", latencySec: 0, closeAtEnd: false,
    tape: fakeTape([tapePrint("1", 1002, 100n, 4)]), strategy: {
      id: "zero", params: {}, onBar(ctx) { if (ctx.index === 0) ctx.submit({ side: "buy", size: cfg.oneBase }); },
      onFill(ctx) { ctx.submit({ side: "buy", size: cfg.oneBase }); },
    },
  });
  assert.equal(out.fills.length, 1);
  assert.equal(out.orders[1]!.decidedAt, 1002);
  assert.equal(out.orders[1]!.decidedBlock, 1);
  assert.equal(out.orders[1]!.decidedLogIndex, 1);
});

test("hash covers finalized result fields and onEnd logs", async () => {
  const { cfg } = load();
  const out = await run({ cfg, bars: syntheticBars(), cash: 1000n * 10n ** 18n, fillModel: "settlement-mark",
    strategy: { id: "hash", params: {}, onBar() {}, onEnd(ctx) { ctx.log("ended"); } },
  });
  assert.deepEqual(out.logs, ["ended"]);
  assert.equal(hashRun(out), out.eventHash);
  for (const patch of [{ logs: ["changed"] }, { model: { ...out.model, gasPerTx: 1n } },
    { minEquity: out.minEquity + 1n }, { fundingOpen: 1n }]) {
    assert.notEqual(hashRun({ ...out, ...patch }), out.eventHash);
  }
});
