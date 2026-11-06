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

## Forward check
Live fills are accumulated exactly and compared with the resampled band, counting how many fall inside or outside.

## Account resampling
A public address's closing fills (chain-reported gross realized PnL) become the trade list, then shuffle, bootstrap and block bootstrap run as above. Fees and funding are not deducted, and fewer than 30 trades is flagged as unstable. Each distribution carries the same per-step fan bands as the run panel, so the wallet panel draws the p10–p90 equity fan over trades.

## Trade-list import
A CSV or JSON trade list from any source can skip the engine entirely (`POST /api/trades/resample`, the "Import a trade list" panel). Required per trade: `side`, `entryTime`, `exitTime`, `pnl` — the PnL is taken exactly as recorded, net of whatever fees and funding the importer already paid, and never re-derived or re-priced. Optional columns: `size`, `entryPrice`, `fee`, `funding`; times accept unix seconds or ISO dates. Lists are capped at 10,000 trades and the request body at 2 MB, and unknown columns or fields are rejected rather than ignored.

The import names a market and a starting cash. When the market's history covers a trade's holding window, the hourly candles of the settlement bars it lived through fill in the worst and best prices it provably saw (excursion PnL only when an entry price is also supplied); trades outside the available history carry no excursion data and are counted in the warnings, never invented. Missing sizes default to one whole base wherever a trade's own size scales a result, which is disclosed. The list is sorted chronologically before analysis because the block bootstrap's realism depends on real adjacency.

The import id is a hash of the sorted list with its market and starting cash, so re-running the same import with the default seed reproduces byte-identical output. Imports are analyses, not runs: they are not persisted to the run store, and the fill check rides the observed-fills path — nothing is re-priced, with an import-specific note that the same-bar share measures how finely the available history resolves each holding window, not a verdict on the importer's fills.

## Honesty rules
- Every result states what it cannot see.
- Fewer than 30 trades, or fewer than 1000 paths, is warned about.
- Same inputs and seed give byte-identical output. Analysis documents are versioned (currently version 2: adds the win-rate and Sharpe intervals); version 1 bundles stay readable.
