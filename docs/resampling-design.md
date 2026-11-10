# Resampling design

Plain-language design for `src/resample/`. It describes what each module computes and what it refuses to claim.

## Input: the trade list
Every analysis starts from closed trades: net PnL, entry and exit time, side, and the worst and best price seen while open. Excursions come from tape prints inside the exact holding window; hourly candles are the coarser fallback. Quantities are exact integers (bigint) until the JSON edge.

## Distribution
Three resampling modes run over the same list, with a seeded generator so a run reproduces exactly. The run panel's "both" setting runs shuffle and bootstrap; the block mode is chosen explicitly:
- **Shuffle**: the same trades in a random order. Total PnL never changes; only the path does.
- **Bootstrap**: trades drawn with replacement, so totals vary too.
- **Block bootstrap**: draws of consecutive trades (circular blocks of ⌈n^⅓⌉, wrapping past the end), so streaks and regime clustering survive the resample instead of being erased by i.i.d. draws.

Each path reports final equity, max drawdown, longest losing streak, whether equity hit zero, its own win rate and its own per-trade Sharpe (exact integers, ×10⁴, not annualised; undefined when the deviation is zero or the path holds fewer than three trades). Summaries give median, p05, p95, CVaR 95, bankruptcy rate, a percentile fan, and p05/p50/p95 confidence intervals for the win rate and Sharpe — because a single metric over a couple of dozen trades is itself noisy. These describe trade-order risk on the recorded trades. They are not forecasts.

## Fill check
Settlement-mark runs price fills at a mark nobody traded at, so a trade that opens and closes inside one settlement bar rests on an assumed path. Past a threshold share of such trades the run is flagged as too dependent on that assumption, and a stress re-run moves each adverse same-bar trade to the worst price it observed.

Tape runs use recorded prints, so short holds are real data. The share is shown for context; no verdict is applied and nothing is re-priced. The check also lists the run's own optimistic assumptions (profile, latency, gas, intrabar data).

## Sizing ladder
For a set of position sizes, the share of resampled paths that lose more than an accepted amount within a chosen number of trades, plus median and p05 PnL. Static or compounding sizing.

## Out-of-sample check
The tail of the list is held back. The earlier trades are bootstrapped and the 95th percentile of their finals is the boundary. The held-back trades replay in order and are compared with it. Inside the boundary is not proof of an edge; crossing is a reason to look at what changed.

## Random-entry null
Trade-order resampling answers "how bad could the path have been given these trades"; it cannot say whether the entries themselves are better than chance. The random-entry null (`src/resample/edge.ts`, the "Null test" tab) is the closest thing to an edge test this view can give.

Each of 300 null paths walks the recorded trades in order and, for every one, enters at a uniformly random settlement bar and closes at the settlement mark exactly that trade's holding time later — same sides, same sizes, same holding times, no information. Null trades are priced by the engine's own close arithmetic (floored gross PnL, the protocol kernel's settled funding, one taker fee on the closing leg), so a null trade and a recorded trade are the same object priced the same way; a canary pins that equality against real position round trips. The p-value is the share of null totals at or above the recorded total, add-one corrected so it can never report an impossible zero. It is one-sided: a small p-value says the entries beat random timing on this history — a reason to look closer, not proof of skill. Trades whose holding time exceeds the available history cannot be placed anywhere and are skipped and counted, never invented.

## Forward check — removed (2026-11-10)
A forward test was built (`/api/forward`): poll a public account's fills, accumulate their
chain-reported realized PnL, and count how many landed inside the p10–p90 band of a stored run. It
measured nothing, and the reason is structural rather than a tuning problem. The band is a
distribution over the *order of that run's own trades*, so its x-axis is a trade count and its
amplitude is that run's position size; a live account's series is indexed by *fills* — one trade
arrives as many fills — and sized by whatever the account actually traded. Once the live count
passes the last band step the comparison clamps to that step, where all five quantiles are the same
number, so any live total except that exact value reads "outside". Measured live: an 83-trade SMA
run against 500 real Hideki fills gave 418 zero-width band readings and 480 of 500 flagged outside,
with `firstOutsideSeq` at 21 — a verdict produced by the index arithmetic, not by the market.

The question it was reaching for is answered properly by account resampling below: take the
account's own closing fills as the trade list and shuffle that, so the distribution is generated
from the same population it is testing. That path stays.

## Account resampling
A public address's closing fills (chain-reported gross realized PnL) become the trade list, then shuffle, bootstrap and block bootstrap run as above. Fees and funding are not deducted, and fewer than 30 trades is flagged as unstable. Each distribution carries the same per-step fan bands as the run panel, so the wallet panel draws the p10–p90 equity fan over trades.

## Trade-list import
A CSV or JSON trade list from any source can skip the engine entirely (`POST /api/trades/resample`, the "Import a trade list" panel). Required per trade: `side`, `entryTime`, `exitTime`, `pnl` — the PnL is taken exactly as recorded, net of whatever fees and funding the importer already paid, and never re-derived or re-priced. Optional columns: `size`, `entryPrice`, `fee`, `funding`; times accept unix seconds or ISO dates. Lists are capped at 10,000 trades and the request body at 2 MB, and unknown columns or fields are rejected rather than ignored.

The import names a market and a starting cash. When the market's history covers a trade's holding window, the hourly candles of the settlement bars it lived through fill in the worst and best prices it provably saw (excursion PnL only when an entry price is also supplied); trades outside the available history carry no excursion data and are counted in the warnings, never invented. Missing sizes default to one whole base wherever a trade's own size scales a result, which is disclosed. The list is sorted chronologically before analysis because the block bootstrap's realism depends on real adjacency.

The import id is a hash of the sorted list with its market and starting cash, so re-running the same import with the default seed reproduces byte-identical output. Imports are analyses, not runs: they are not persisted to the run store, and the fill check rides the observed-fills path — nothing is re-priced, with an import-specific note that the same-bar share measures how finely the available history resolves each holding window, not a verdict on the importer's fills.

## Honesty rules
- Every result states what it cannot see.
- Fewer than 30 trades, or fewer than 1000 paths, is warned about.
- Same inputs and seed give byte-identical output. Analysis documents are versioned (currently version 3: adds the random-entry null; version 2 added the win-rate and Sharpe intervals); version 1 and 2 bundles stay readable.
