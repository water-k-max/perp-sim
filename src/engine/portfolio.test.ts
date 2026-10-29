import assert from "node:assert/strict";
import test from "node:test";
import type { Bar } from "../history/bars.js";
import type { MarketConfig } from "../history/market.js";
import { PositionBook } from "./portfolio.js";

const E18 = 10n ** 18n;
const oneBase = 10n ** 8n;

const cfg: MarketConfig = {
  symbol: "BTC",
  quoteSymbol: "USDso",
  pool: "0xpool",
  marginBank: "0xbank",
  stopRegistry: null,
  baseDecimals: 8,
  quoteDecimals: 18,
  oneBase,
  tickSize: 1n,
  lotSize: 1n,
  minQuantity: 1n,
  imBps: 500n,
  mmBps: 250n,
  closeOutBps: 125n,
  effectiveImfBps: 500n,
  maxPositionSize: 10n ** 30n,
  maxOpenInterest: 10n ** 30n,
  // 10 bps both ways, in the chain's bps x 1000 scale.
  takerFeeBpsTimes1k: 10_000n,
  makerFeeBpsTimes1k: 10_000n,
  fundingWindowSec: 3600,
  fundingIntervalSec: 3600,
  imBpsMismatch: false,
};

const bar = (mark: bigint, cum: bigint, t = 1_000): Bar => ({
  t,
  mark,
  markSource: "mark",
  indexPrice: mark,
  cum,
  fundingDelta: cum,
  rate: 0n,
  fundingWindowSec: 3600,
  fundingIntervalSec: 3600,
  intervalsSettled: 1,
  intervalsAccrued: 1,
  forgivenIntervals: 0,
  anchorResynced: false,
  gapSec: 3600,
  missedIntervals: 0,
  low: null,
  high: null,
  candles: 0,
});

const price = (whole: bigint) => whole * E18;

test("a fill charges its fee once, and a close realises price PnL net of funding", () => {
  const book = new PositionBook(cfg, 1_000n * E18);
  const open = book.execute("buy", oneBase, { t: 1, price: price(100n), role: "taker", cum: 0n });
  assert.equal(open.fee, (100n * E18 * 10_000n) / 10_000_000n);
  assert.equal(book.cash, 1_000n * E18 - open.fee);
  assert.equal(book.size, oneBase);

  const b = bar(price(110n), 10n ** 36n);
  assert.equal(book.mark(b).unrealized, 10n * E18, "1 base up 10 quote");
  assert.equal(book.mark(b).accrued, E18, "cum delta 1e36 over one base is 1 quote");

  const close = book.execute("sell", oneBase, { t: 2, price: price(110n), role: "taker", cum: 10n ** 36n });
  assert.equal(close.closed.length, 1);
  assert.equal(close.closed[0]!.grossPnl, 10n * E18);
  assert.equal(close.closed[0]!.funding, E18);
  assert.equal(close.closed[0]!.fee, (110n * E18 * 10_000n) / 10_000_000n);
  assert.equal(close.closed[0]!.netPnl, 10n * E18 - E18 - close.closed[0]!.fee);
  assert.equal(book.realizedPnl, 10n * E18);
  assert.equal(book.fundingSettled, E18);
  assert.equal(book.size, 0n);
  assert.equal(book.isFlat, true);
});

test("cash after a flat open/close round trip is the identity, exactly", () => {
  const start = 1_000n * E18;
  const book = new PositionBook(cfg, start);
  book.execute("buy", 3n * oneBase, { t: 1, price: price(100n), role: "taker", cum: 0n });
  const b = bar(price(97n), 2n * 10n ** 36n);
  book.execute("sell", 3n * oneBase, { t: 2, price: price(97n), role: "taker", cum: 2n * 10n ** 36n });
  const expected = start + book.realizedPnl - book.fundingSettled - book.feesPaid - book.gasPaid;
  assert.equal(book.cash, expected);
  assert.equal(book.cash < start, true, "the round trip lost money on price, funding and fees");
});

test("a fill larger than the position closes it and opens the rest as a flip", () => {
  const book = new PositionBook(cfg, 1_000n * E18);
  book.execute("buy", oneBase, { t: 1, price: price(100n), role: "taker", cum: 0n });
  const flip = book.execute("sell", 2n * oneBase, { t: 2, price: price(105n), role: "taker", cum: 0n });
  assert.equal(flip.closed.length, 1);
  assert.equal(flip.closed[0]!.size, oneBase);
  assert.equal(flip.opened, -oneBase);
  assert.equal(book.size, -oneBase);
  assert.equal(flip.closed[0]!.fee, flip.fee / 2n, "fee is split pro rata across the two legs");

  // Flatten at the same price: the short's own PnL is zero, only fees remain.
  const entryCash = book.cash;
  book.execute("buy", oneBase, { t: 3, price: price(105n), role: "taker", cum: 0n });
  assert.equal(book.size, 0n);
  assert.ok(book.cash < entryCash);
});

test("a maker fill pays the maker rate, including a rebate", () => {
  const rebate = { ...cfg, makerFeeBpsTimes1k: -2_000n };
  const book = new PositionBook(rebate, 1_000n * E18);
  const fill = book.execute("buy", oneBase, { t: 1, price: price(100n), role: "maker", cum: 0n });
  assert.equal(fill.fee, -2n * E18 / 100n, "2 bps rebate on 100 quote");
  assert.equal(book.cash, 1_000n * E18 - fill.fee);
  assert.equal(book.feesMaker, fill.fee);
  assert.equal(book.feesTaker, 0n);
});

test("opening reduces equity by exactly the fee, and the identity stays zero", () => {
  const book = new PositionBook(cfg, 1_000n * E18);
  const b = bar(price(100n), 0n);
  book.execute("buy", 2n * oneBase, { t: 1, price: price(100n), role: "taker", cum: 0n, gas: 5n * 10n ** 12n });
  const marked = book.mark(b);
  assert.equal(marked.equity, 1_000n * E18 - book.feesPaid - book.gasPaid);
  assert.equal(book.identityError(b), 0n);
  assert.equal(book.identityError(bar(price(120n), 10n ** 36n)), 0n, "and it holds at another price");
});

// The four tests below pin the position semantics against values the chain itself produced
// for a real account (BTC, 2026-10-24). FIFO lots realized a different PnL on the partial
// close and failed reconciliation by 1.5e14 raw units.

test("a second entry re-averages the position instead of opening a second lot", () => {
  const book = new PositionBook(cfg, 1_000n * E18);
  book.execute("buy", 19_000n, { t: 1, price: price(80_990n), role: "taker", cum: 0n });
  book.execute("buy", 329_000n, { t: 1, price: price(80_996n) + 7n * 10n ** 17n, role: "taker", cum: 0n });
  assert.equal(book.lots.length, 1);
  assert.equal(book.size, 348_000n);
  assert.equal(book.lots[0]!.price, 80_996_334_195_402_298_850_574n, "truncated volume-weighted average");
});

test("a partial close realizes against the average entry and leaves it untouched", () => {
  const book = new PositionBook(cfg, 1_000n * E18);
  book.execute("buy", 19_000n, { t: 1, price: price(80_990n), role: "taker", cum: 0n });
  book.execute("buy", 329_000n, { t: 1, price: price(80_996n) + 7n * 10n ** 17n, role: "taker", cum: 0n });
  const avg = book.lots[0]!.price;
  const partial = book.execute("sell", 306_000n, { t: 2, price: price(80_990n) + 7n * 10n ** 17n, role: "taker", cum: 0n });
  assert.equal(partial.closed[0]!.entryPrice, avg);
  assert.equal(partial.closed[0]!.grossPnl, -17_240_637_931_034_483n, "floored, as the chain divides");
  assert.equal(book.size, 42_000n);
  assert.equal(book.lots[0]!.price, avg, "the average entry survives a reduce");

  const rest = book.execute("sell", 42_000n, { t: 2, price: price(80_990n) + 6n * 10n ** 17n, role: "taker", cum: 0n });
  assert.equal(rest.closed[0]!.grossPnl, -2_408_362_068_965_518n);
  assert.equal(book.size, 0n);
  assert.equal(book.realizedPnl, -19_649_000_000_000_001n, "the two closes sum to the chain's total");
});

test("a losing close divides rounding down, never toward zero", () => {
  const book = new PositionBook({ ...cfg, oneBase: 3n }, 1_000n * E18);
  book.execute("buy", 1n, { t: 1, price: 10n, role: "taker", cum: 0n });
  const close = book.execute("sell", 1n, { t: 2, price: 9n, role: "taker", cum: 0n });
  assert.equal(close.closed[0]!.grossPnl, -1n, "(-1 * 1) / 3 floors to -1, truncation would give 0");
});
