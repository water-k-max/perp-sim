# perp-sim

A backtester and pre-trade simulator for dreamDEX perpetuals on Somnia's Hideki (Tokyo)
testnet, built on the protocol's **own exported arithmetic** rather than a re-derivation of
it.

That choice is the whole project. `@somnia-chain/markets-sdk` exports the pure functions the
MarginBank's health math is ported from — `perpLiquidationPrice`, `perpPositionAnalytics`,
`perpMarkForPnl`, `fundingRatePerInterval`, `realizedFundingPerBase`. A simulator built on
them cannot quietly disagree with the contract, and this repository proves it does not:
`pnpm validate` asserts the shipped kernel against the live contract's own previews across
a grid of markets, sides, sizes and prices (see [Verification](#verification)).

Everything here is **read-only**. No private key is read or accepted; there is no writer,
no order placement, no signing.

## Why this is worth having

Three things make a perp backtest silently wrong, and each is easy to do by accident:

1. **Funding scale.** A rate is quoted per *calculation window* (28 800 s on every live
   pool), not per settlement interval and not annualised. Hideki settles hourly, so the
   window is 8 intervals — and the same rate figure means a different cost per hour the
   moment the cadence changes. `oneBase` is worse: the 21 live pools carry
   `baseDecimals` from **6 to 24**, so `1e18` — the obvious constant — misprices 12 of
   them. Both figures, for all 21 pools, are what `pnpm probe:markets` prints.
2. **Funding forgiveness.** A settlement can span more intervals than it charges: the
   deployed catch-up horizon forgives the excess at zero. `intervalsSettled - intervalsAccrued`
   is not derivable from the cadence, so `rate x elapsed_time` over-reports what was owed.
   This project accrues funding from the **cumulative index delta**, which already accounts
   for it: realised funding over any range is exactly `cumEnd - cumStart`.
3. **The adverse gap.** A position opens at the order price but is marked at the current
   mark, so entering on the unfavourable side of the mark reserves that gap *on top of*
   initial margin. A size chosen as `notional x IMF` gets rejected for it.

The first two are why a price-only backtest flatters a strategy. A real run, from
`pnpm backtest --market BTC --days 14 --side long --size 0.01 --cash 1000` on 2026-10-27:

```text
result  closed
  equity 1000.0 -> 935.142306  roi -6.48%
  to equity, each signed:  pnl -28.589159  funding -36.268534  fees 0.0  = -64.857693 USDso
      each line is a contribution to equity, so negative funding means the position paid it (the kernel's accruedFunding is a cost, which is why it is negated here)
  min equity 928.325394 at bar 330
```

The position lost 64.86 USDso, and **36.27 of it — 56% — was funding**, which a price-only model
does not contain at all. The share moves with the entry bar — the second settlement in whatever
window `--days` selects — so re-run it and read your own number; what does not move is that
every term is printed as a signed contribution to equity, so the three sum to the delta on the line
above.

## Quick start

```bash
pnpm install
cp .env.example .env          # no keys; only endpoints and an optional public address
pnpm probe:markets            # baseline: 21 perp pools, chain-resolved risk params
pnpm backtest --market BTC --days 14 --side long --size 0.01 --cash 1000
pnpm preflight --market ETH --side short --size 0.05 --cash 500
pnpm validate --account 0x…   # kernel vs contract, asserts they agree to the wei
```

## Commands

### `pnpm backtest`

Replays a position over real settlement history.

| flag | default | meaning |
| --- | --- | --- |
| `--market` | `BTC` | base symbol, pair, or pool address |
| `--days` | `14` | look-back |
| `--side` | `long` | `long` or `short` |
| `--size` | `0.01` | whole base units (aligned down to the lot grid) |
| `--cash` | `1000` | starting collateral, whole USDso |
| `--interval` | `3600` | candle resolution for the intra-bar path |
| `--no-intrabar` | off | test settlement marks only |

It prints the market's chain-resolved config, the **coverage of the history it actually got**
(settlements found vs expected at that cadence, gaps, anchor resyncs, forgiven intervals,
bars where the mark feed was at its sentinel and the index was used instead), then the
position's equity, funding, fees, liquidation price and its five thinnest bars.

As of `--days 34` on BTC, the whole window the testnet has, that line is not decorative:

```text
history  807 settlements, 2026-09-23T16:11 -> 2026-10-27T15:11  (pages 2, complete true)
  expected 816 at this cadence, missing 9, gap bars 1, anchor resyncs 0, forgiven intervals 9
```

`missing 9` comes from the timestamps between the rows the indexer returned; `forgiven intervals 9`
is the protocol's own `intervalsSettled - intervalsAccrued` summed over those rows — nine intervals
of funding index that elapsed and were charged nothing. Both are 9 here, which is what you would
expect of one outage seen from the two sides, but they are measured independently and a run where
they disagree is exactly as reportable. Over 34 days, `rate x elapsed_time` would have billed those
nine intervals anyway.

The same run closes the loop on the arithmetic: `pnl -35.899726 funding -41.906587 fees 0.0` sums to
`-77.806314` against an equity move of `1000.0 -> 922.193685`. The last digit is one off because
both figures are printed by **truncating** to six decimals — `floor(a + b)` is not
`floor(a) + floor(b)` — not because anything is lost; the identity is exact in `bigint` before
display.

### `pnpm preflight`

Answers "would this order work, and what would it cost me to hold?" before anything is sent.
Static gates (min quantity, lot grid, tick grid, max position size, open-interest headroom,
collateral against the lock, adverse gap), then the carry cost at the current rate, then —
if given `--account` — the same question asked of the contract
(`previewPerpOrderMargin`, `getMaxPerpOrderSize`, `meetsPerpImForFill`) with the two verdicts
side by side.

`meetsPerpImForFill` is printed as context, not as a verdict. Its own doc calls it "the closest
single contract call to a pre-trade gate" and then says it "does not model the lock's adverse
mark-to-entry reserve; `previewPerpOrderMargin` is the accurate gate". A `true` from it can still be
an order the pool will not fund, which is why the row carries the quote. Both cross-checked runs —
a BTC long and an ETH short — answered `false`, next to `sufficient false` and `placeable false`,
for an account whose margin bank reports `unlocked 0`, so the three reads agreed there.

### `pnpm validate`

The correctness harness. See below.

## Verification

`pnpm validate` sweeps BTC, ETH, SOL and ZRO x long and short x four size/price combinations,
and for every order asserts four identities against the live contract at the contract's own
block:

```
lockAmount              = ceil(notional x effectiveIMF / 10000) + adverseGap
initialMarginPortion    = ceil(notional x effectiveIMF / 10000)
adverseGapPortion       = max(0, unfavourable (price - mark)) x size / oneBase
projectedLiquidationPrice = perpLiquidationPrice(projectedEquity, projectedMmReq, ...)
```

### Run

`pnpm validate --account <public address>` on 2026-10-27: **32 orders asserted, 0 skipped, 0
mismatches**, on contract blocks 34 590 061 - 34 591 366, and its log carries no retry line. The
kernel is exact against the live pool on both sides, including every row that carried a non-zero
adverse gap.

### What the harness caught before that run

The first full sweep passed all 16 longs and failed all 16 shorts. The shorts were this
repository's bug, not the protocol's: the harness handed `previewPerpOrderMargin` a **signed**
quantity — negative for a sell — because that is how an order builder usually spells size.
Direction belongs in `isBid`; the pool's own view is
`meetsIMForFill(address, address, uint256 additionalSize, uint256 orderPrice)`. The preview's
`quantity` is documented as "Order quantity, raw base units" with no sign statement — while its
sibling input `positionSize` is explicitly marked *SIGNED* — and it is not validated, whereas
`previewPerpLiquidationPrice` throws `quantity must be > 0` on the same value.

The consequence is not a sign-flipped right answer. One sell, quoted twice at the same account:

```
quantity unsigned   lock 0.537843   im 0.520105   adverse 0.017738   hasCollateralForLock false   meetsInitialMargin false   sufficient false
quantity negative   lock -0.537843  im -0.520105  adverse -0.017738  hasCollateralForLock true    meetsInitialMargin true    sufficient true
```

`lockAmount` is documented as "total collateral the pool will lock", and both gates go green for
an order the unsigned call says cannot be funded — `hasCollateralForLock` compares against a lock
that is now below zero, and `meetsInitialMargin` subtracts it, which adds margin. `pnpm validate`
prints that pair after every sweep, so the trap stays in the output rather than in a commit
message. `src/pretrade/gates.ts` passes unsigned and reads direction from `isBid` alone.

## Limits

Read these before trusting a number. The tool prints most of them in its own output.

- **Entry is assumed to fill at the settlement mark.** No book, no slippage, no partial
  fills. A real taker pays the ask; a backtest that ignores that overstates every entry.
- **Intra-bar extremes are fill prices, not oracle marks.** When `--interval` candles cover a
  bar, the liquidation check is run at the worst price that *traded* in it, which
  approximates where the mark went. It is a stricter test than bar-to-bar, not a replay of
  the feed.
- **A position closed at bar k pays the settlement at bar k.** Funding is the index delta
  across the holding period; the boundary convention is stated because it changes results.
- **One market, one side.** Longs and shorts in the same pool do not net, and cross-margin
  interaction *between* markets is not simulated. The liquidation solve is the protocol's
  single-market solve, which is exactly "the price at which this market's move alone trips
  maintenance".
- **`backtest` applies no placement gates.** It simulates the size and collateral you give it,
  even when the pool would never accept the order. `--market BTC --days 7 --side long --size
  0.002 --cash 2` opens 165.37 USDso of notional against 2.00 USDso, where initial margin alone
  is 8.27 — the position starts at 47.9% health, so the run reports `liquidated at bar 1` with
  every delta zero. That is an impossible position, not a strategy result. Ask `pnpm preflight`
  whether an order can be placed at all; ask `backtest` what it would have cost to hold.
- **No liquidation-engine behaviour.** Nothing models close-out at `closeOutMarginBps`, ADL,
  the insurance fund, or who actually executes the liquidation. `liquidated` means "equity
  fell below the maintenance requirement", which is where the contract would begin.
- **Fees are untested against non-zero.** Every pool this project has read reports
  `takerFeeBpsTimes1k = 0` — ZRO in the `pnpm probe:markets` dump, and BTC, ETH and SOL in line 3
  of the header `pnpm backtest` prints (`taker fee 0 x1e-3bps`), which between them covers all
  four markets `pnpm validate` sweeps. The fee path executes on every run, but has never been
  checked against a pool that charges.
- **34 days of testnet history on synthetic markets** is the entire dataset — the oldest
  settlement `--days 34` returns on BTC is 2026-09-23T16:11. It is enough to validate
  arithmetic and not enough to validate a strategy.
- The RPC is flaky: the SDK sends every chain read over a single WebSocket, and that transport's
  4 s connect budget is a module constant with no option in front of it — the documented `signal`
  config explicitly does not cover it ("Chain reads go over the WebSocket transport, which is
  bounded by its own request timeout instead"). So `src/retry.ts` bounds and reports retries, and
  a run that retried says so. None of the runs whose output is quoted above printed a retry line,
  which says nothing about tomorrow: a handshake that exceeds 4 s fails a read that a 6 s patience
  would have served.

## Network

Somnia Hideki / Tokyo testnet only: chain id `50383`, indexer
`https://hideki-dev.smk.somnia.host/v1/graphql`. Every address the tool uses is resolved
from the market row or `getPerpSystemConfig` at run time — none are hardcoded.

## Layout

```
src/client.ts          read-only SomniaMarkets factory
src/config.ts          env endpoints
src/units.ts           decimal <-> raw, no float on a protocol quantity
src/retry.ts           bounded retry for the flaky WS read path
src/history/market.ts  chain-resolved market config (oneBase derived from baseDecimals)
src/history/indexer.ts windowed paged reads with truncation reported
src/history/bars.ts    settlements -> bars, intra-bar path, coverage
src/engine/simulate.ts position book walked over bars, kernel-marked
src/pretrade/gates.ts  static gates + contract cross-check
src/bin/               probe-markets, backtest, preflight, validate
```
