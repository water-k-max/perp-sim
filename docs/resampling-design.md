# Resampling design

Plain-language design for `src/resample/`. It describes what each module computes and what it refuses to claim.

## Input: the trade list
Every analysis starts from closed trades: net PnL, entry and exit time, side, and the worst and best price seen while open. Excursions come from tape prints inside the exact holding window; hourly candles are the coarser fallback. Quantities are exact integers (bigint) until the JSON edge.

## Distribution
Two resampling modes run over the same list, with a seeded generator so a run reproduces exactly:
- **Shuffle**: the same trades in a random order. Total PnL never changes; only the path does.
- **Bootstrap**: trades drawn with replacement, so totals vary too.

Each path reports final equity, max drawdown, longest losing streak and whether equity hit zero. Summaries give median, p05, p95, CVaR 95, bankruptcy rate and a percentile fan. These describe trade-order risk on the recorded trades. They are not forecasts.

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
A public address's closing fills (chain-reported gross realized PnL) become the trade list, then shuffle and bootstrap run as above. Fees and funding are not deducted, and fewer than 30 trades is flagged as unstable. Each distribution carries the same per-step fan bands as the run panel, so the wallet panel draws the p10–p90 equity fan over trades.

## Honesty rules
- Every result states what it cannot see.
- Fewer than 30 trades, or fewer than 1000 paths, is warned about.
- Same inputs and seed give byte-identical output.
