# perp-sim

A read-only backtester for dreamDEX perpetuals on the Somnia Hideki testnet, chain **50383**.

It replays a strategy against the venue's own history — settlement bars, the recorded trade tape, hourly candles and per-epoch parameter changes — and reports equity, signed attribution, risk statistics and a set of mechanical invariants. It does not sign transactions, place orders, move collateral or close positions, and it never needs a private key or a funded wallet.

Any of the indexed perp markets works, over any window the indexer covers (up to 90 days per run), with an entry size aligned to that market's live lot grid.

## What this build does

- **Tape fill model.** An order is matched against the pool's recorded trades inside a declared window after the decision, with a participation cap per realism profile. A window with no eligible flow reports *no fill*; it never substitutes the settlement mark.
- **Settlement-mark oracle.** The same strategy can be replayed at the next settlement mark. This is the legacy, conservative path and it reproduces the committed golden run bit for bit.
- **Per-epoch parameters.** Initial/maintenance margin, close-out, fees and position caps are resolved at each fill's own block from `PerpPoolParametersEpoch`, falling back to current chain parameters only when an epoch is missing.
- **Real accounting.** Average-entry positions (the chain's own convention), taker and maker fees by role, funding by cumulative index, gas per transaction, side flips, and an exact cash identity.
- **Analytics.** Sharpe, Sortino, drawdown, turnover, win rate, expectancy, holding time, a markout ladder read at 1, 4 and 24 settlement intervals, and a signed attribution whose residual must be zero.
- **Invariants.** Equity identity, quantity identity, fee recomputation, no lookahead, determinism, coverage completeness and more — each either passes, fails, or is explicitly skipped with a reason.
- **Account reconciliation.** Replays a public account's own fills through the same position book and diffs the result against the indexer's `PerpPositionChange` and `PerpFeeRecord` rows.
- **Reproducible identity.** Every run carries a `runId`, a `dataVersion` (hash of the dataset), a `configHash` (parameters + model + strategy) and a `codeCommit`, so two runs that disagree can be told apart.

**Status: verified against live Hideki history.** The committed golden fixture replays 14 days of BTC into 336 settlements with 0 missing settlements and 0 gaps: 1,000 hypothetical USDso end at **946.750111830475226055**, with price PnL −11.54664041438527 and funding paid 41.703247755139503945. The same fixture replayed twice produces the identical event hash. These are historical replay results, not executed trades or profitability guarantees. The live indexer keeps growing, so a rerun over a different window has different coverage and different numbers.

## Quick start

Node.js >= 22 and pnpm >= 12 (recorded environment: Node.js 22.23.4, pnpm 12.9.1).

```bash
pnpm install
pnpm probe:markets
pnpm dev                                   # http://localhost:3000
```

CLI:

```bash
pnpm backtest --market BTC --days 14 --size 0.01 --cash 1000 --model tape
pnpm backtest --market ZRO --days 7 --size 6 --profile conservative --model tape
pnpm preflight --market ETH --side short --size 0.05 --cash 500
pnpm replay-account --account <PUBLIC_ADDRESS> --market BTC --days 3
pnpm validate --account <MARGIN_OWNER_ADDRESS>
```

Do not add private keys to configuration, examples or recordings. `.env` is ignored; only public addresses are ever read.

## Browser interface

Open `http://localhost:3000` for the NOVA Protocol Backtest Lab.

- Market, direction, base size and hypothetical cash, with the lot grid and market minimum read live from the indexer.
- Window as a lookback in days or an explicit UTC date range.
- **Execution model** panel: tape fill model with optimistic/realistic/conservative profile, decision latency, gas per order, and the strategy (fixed position or SMA crossover).
- Results: equity curve, signed price/funding/fee attribution, Sharpe/Sortino/turnover/win rate/markout ladder, and tabs for closed trades, fills (with the modelled-fill notice), invariants and the run's identity (where the ladder's observed counts are printed).
- A permanent **MODELLED FILL** badge when the tape model is used, and **NO FILL** when an entry never traded.
- A run comparison list kept in browser storage, and a JSON export of the full response.

The server binds to local loopback, caps request bodies and lookbacks, sets security headers and serves only frontend assets plus the read-only API. It never serves `.env` or cache files. This is a local research interface, not a hardened public deployment. No wallet connection or transaction execution is included.

Heavy work runs on two lanes with a four-place queue (`src/bin/work-lanes.ts`). A request whose exact job is already in flight joins that job instead of starting a copy, so eight tabs asking for the same analysis cost one read and eight answers; requests past the two lanes wait in arrival order; only a request that finds the queue full is refused, with a `Retry-After` and the depth the server saw. A request the router can reject — a malformed run digest, a non-JSON body, a path count outside the work budget — is answered before a lane is asked for, so it cannot spend a slot or push somebody else's job past the limit. The lanes overlap the indexer-bound reads, which is what a wallet panel and an unrelated backtest need; they do not parallelise path simulation, which is single-threaded CPU — measured twice with the 600-path × 500-trade resample, two jobs started together cost 2.2–2.5× what one job alone cost (`probe/lane-contention.mts`), so the queue is what turns a busy server into a delay rather than a second machine. What the lanes do buy regardless of the thread is coalescing: five concurrent wallet requests against the live indexer are five answers and no refusals, and two identical ones are one job (`probe/lane-live.mts`).

The NOVA artwork is supplied by the project owner in `public/nova-storyboard.png`.

## Resampling a real account

`GET /api/accounts/<ADDRESS>/resample?market=BTC&days=14&paths=1000&cash=1000&seed=` replays the account's fills through the position book, takes each closing fill's realized PnL as one trade, and runs shuffle and bootstrap Monte Carlo over that list. It is read-only and deterministic: the same account, window and seed give the same distributions. PnL is the chain's gross realized figure, so fees and funding are not deducted, and fewer than 30 closed trades is flagged as unstable. The "Analyse a wallet" panel in the UI calls it.

Every response carries a `coverage` block — the window the fill read actually covered, how many pages it took, which bound stopped it and what the indexer counts in that window — and the panel prints it as one sentence above the distributions, in a `full window read`, `partial window` or `no fills` tone. A truncated read is never presented as a whole one, and the CLI prints the identical sentence. On this venue bot-scale accounts routinely sit on the indexer's `10,000`-row count ceiling, and that number is a lower bound, so the sentence says "at least". The count that provides it is only read when the fill read fell short: a read that ended because its page cursor ran out has already proved its own coverage, and the count is a bounded 10,001-row scan rather than an aggregate on this endpoint.

### Calibration

`pnpm test:calibration` (`src/resample/calibration.ts`, also run by `test:resample`) is what lets the word "Monte Carlo" be used without a caveat. The estimator is aimed at a process that is solved exactly rather than sampled: a finite-horizon gambler's-ruin dynamic program on a `+win/−lose` lattice with an absorbing barrier at zero — the same freeze `walkPath` applies — cross-checked against the closed form `((1−p)/p)^a`, which shares no code with it. Bootstrapping a pool of 55 whole-unit wins and 45 losses with replacement *is* an i.i.d. ±1 walk at p = 0.55, so the two sides are one process, one solved and one sampled, and containment is a real test rather than a tautology.

Achieved, 2,000 paths per line and fixed seeds: exact 5% quantile 14 units at coverage 0.0771, sampled 0.0780 inside a 99.7% Wilson band of [0.0618, 0.0979]; median 0.5498 exact against 0.5535 sampled; ruin 0.0609 exact against 127/2,000 sampled, and 0.4791 against 0.4920 for the shallower account. The random-entry p-value is calibrated on the shipped test: 600 `runEdgeTest` runs over a null that is null by construction (recorded entries drawn from `perp-sim/resample/v1`, null paths from `perp-sim/edge/v1`, so independent hash domains) give KS 0.0383 against the 0.0555 critical value, decile χ² 8.47 against 16.919, 5% exceedance 4.33% with the band holding 5%, and both ends of the 1/301 ladder reached. Breaking the code breaks the gate: swapping the lattice's win and loss steps fails three tests, and moving the absorbing barrier from `<= 0n` to `< 0n` fails the bankruptcy containment.

What the calibration does not cover is stated in the same file: the process is synthetic, no real account's PnL series has a known law, and the shuffle-mode test pins the *disagreement* with the i.i.d. law on purpose. Funding, fees and sizing are not calibrated by any of this.

## Fill models

`--model settlement-mark` (default) prices each order at the next settlement mark. It is simple, fully reproducible, and deliberately labelled as *not* a book fill.

`--model tape` matches the order against the pool's recorded trades:

| Profile | Window | Participation |
| --- | --- | --- |
| `optimistic` | 5 s | 100% of eligible volume |
| `realistic` | 30 s | 25% |
| `conservative` | 120 s | 5% |

- The window opens `--latency` seconds after the decision (default 1 s).
- A **buy taker** consumes prints where the aggressor was also a bid (`takerIsBid = true`), i.e. trades at the ask; a **sell taker** consumes sell-aggressor prints at the bid. Using the opposite side would price a buy at the bid and fake a profit, so this rule is pinned by a test.
- Size is floored to the market lot, capped by the profile's share of window volume, and may therefore fill partially.
- No eligible print in the window → the order is rejected as `no-liquidity`. Thin testnet pools genuinely do this: a 6 ZRO order at one settlement found no counterparty flow inside 30 s. The report says so and never invents a fill.
- Every result records `fillModel`, `profile`, `latencySec`, `windowSec`, the consumed tape slices and the fill's own timestamp.

## Analytics

All money is exact bigint internally and decimal strings at the API edge.

- `totalReturnBps`, `maxDrawdownBps`, `turnoverBps` from marked equity.
- `sharpe` and `sortino` annualised from per-settlement returns, `null` under three bars or zero variance.
- `winRateBps`, `avgTrade`, `expectancy`, `avgHoldSec`, best/worst trade from closed trades.
- `markout.rungs`: the markout ladder — favourable-after-fill price movement in basis points, measured at the first settlement mark at or after `fill.t + horizonSec`, at 1, 4 and 24 settlement intervals (`fundingIntervalSec` is 3600 on the live config, so 1 h / 4 h / 24 h on Hideki). Horizons are multiples of the cadence rather than round hours because the oracle prints once per interval: a shorter horizon would be the next mark wearing a different label. Each rung carries `observed`/`total`, because a horizon running past the window has nothing to read — the frozen fixture's 2-fill run publishes `1 h = 99 bps (1 of 2)` with both longer rungs `null (0 of 2)`. `bps` is a decimal string or `null`, and `null` means unobserved, never flat.
- `attribution`: `Δequity = price − funding − fees − gas`, each signed, with an exact `residual`.

## Invariants

`checkRun` evaluates, and the CLI exits `2` if any fail:

| Check | Severity | Meaning |
| --- | --- | --- |
| `equity-identity` | error | attribution residual is exactly zero |
| `quantity-identity` | error | fills net to the final position |
| `fee-recompute` | error | every fee re-derives from its notional and rate |
| `no-lookahead` | error | every fill is at or after decision + latency |
| `determinism` | error | the recomputed event hash equals the recorded one |
| `coverage-complete` | error | no missing settlements or gaps (when coverage is supplied) |
| `equity-nonnegative` | warn | equity never goes negative un-liquidated |
| `liquidation-fill-modelled` | skip | no liquidation fill price exists in the tape |
| `book-not-crossed` | skip | no historical depth is published, so queue position is not modelled |

Tests inject a wrong fee, a lookahead fill, a cash mismatch, a tampered hash and a broken quantity identity, and each must fail its own check.

## Account reconciliation

```bash
pnpm replay-account --account <PUBLIC_ADDRESS> --market BTC --days 3
```

Read-only. Fetches the account's own fills, books them through the same `PositionBook` at their real prices and recorded fees, and diffs row by row against `PerpPositionChange` (`kind`, closed size, exit price, realized PnL) and `PerpFeeRecord`. Zero tolerance on fees, ±1 raw unit on entry averaging. It refuses anything that would need a signer.

The report says what it actually read. `coverage` is the fill read's own account — rows scanned, rows kept, pages, the window its fills really span, which bound stopped it, and what the indexer counts in that window — and `fillCoverageStamp` turns it into the single sentence both the CLI and the wallet panel print. Fills whose position updates the indexer would not return are counted in `changesUnread` with the first refusal message: they stay in `unmatched`, keep the row alignment of every later fill, hold `ok` at `false`, and are labelled as a shortfall on this side of the wire rather than a gap in what the chain recorded. One refused chunk no longer aborts a reconcile.

`PerpFeeRecord` rows are split by rail before any comparison, because the kinds do not mean the same thing: `Fee`/`Rebate`/`BuilderFee` are the cost of a fill and are compared against the fees recomputed from the fills; `LiquidationFee`/`LiquidationFeeSkipped` are penalties on forced closes routed to an Insurance Fund tier, reported on their own line and excluded from that comparison — an unrecognised kind fails the report closed instead of being guessed at. The report also labels whether the fill-fee leg carried any information: on Hideki the venue's taker and maker rates are both 0, so `0 == 0` is printed as `vacuous-zero-rate` and is not evidence that fee accounting was checked. Measured on a liquidated account (39 of the 40 newest liquidation rows sit on listed perp markets): `fills=15 changes=15 mismatches=0` with `expected=0 actual=0` on the trade rail and `824505007534266267961` raw on the liquidation rail.

The position book itself matches the chain's semantics, proven against live rows: one volume-weighted average entry per position (truncating), partial closes realize against that average and leave it unchanged, and realized PnL divides rounding down. A live 20-fill BTC account reconciled **20/20 exactly**.

## Data layer

- Reads: funding settlements, hourly candles, `PerpPoolParametersEpoch`, and the trade tape in short slices around each execution.
- Content-addressed cache: gzipped JSON under `.cache/perp-sim/`, keyed by a SHA-256 of the exact request (chain, pool, block/second bounds, kinds). Replaying the same window reads from disk; a parameter sweep reuses it for free.
- `dataVersion` hashes the manifest (chain, pool, bounds, row counts, first/last ids, per-segment hashes, indexer URL, SDK version). `codeCommit` lives in `runId`, so "same data, new code" stays distinguishable.
- Page budgets are explicit; a truncated read propagates `complete: false` to the response, the warnings and the UI badge. A short page on a live table is never read as "end of data".

## CLI reference

| Flag | Default | Meaning |
| --- | --- | --- |
| `--market` | `BTC` | Symbol, pair or pool address |
| `--days` | `14` | Look-back window (1–90) |
| `--from`, `--to` | — | Explicit UTC bounds (ISO date or unix seconds) |
| `--side` | `long` | `long` or `short` |
| `--size` | `0.01` | Whole base units, aligned down to the lot grid |
| `--cash` | `1000` | Hypothetical quote collateral |
| `--model` | `settlement-mark` | `settlement-mark` or `tape` |
| `--profile` | `realistic` | `optimistic`, `realistic` or `conservative` (tape only) |
| `--latency` | `1` | Decision-to-market latency in seconds |
| `--gas` | `0` | Gas per order in quote units |
| `--strategy` | `fixed` | `fixed` or `sma` |
| `--fast`, `--slow` | `6`, `24` | SMA windows in bars |
| `--at-bar` | `1` | Bar at which the fixed strategy enters |
| `--no-intrabar` | off | Mark at settlements only |
| `--json` | off | Print the full API response instead of the report |

The settlement-mark default keeps every old command reproducible; `--model tape` turns on the professional path. Read the report top to bottom: market configuration, model, history coverage, planned versus filled position, result, attribution, analytics, fills, thinnest bars, invariants, warnings and the run identity.

## Verification

```bash
pnpm typecheck
pnpm test:units && pnpm test:web && pnpm test:engine && pnpm test:data && pnpm test:analytics && pnpm test:verify
```

- The engine suite pins the chain's average-entry and floor-division semantics with real values, replays the committed BTC 14-day fixture bit for bit, and checks that the loop's books balance.
- The web suite covers request parsing (legacy path unchanged, new fields, rejections), and the analytics suite covers the metric edge cases.
- Browser harnesses (local, not part of the repo) exercise the empty state, loading, a live run, error/retry with a 429, JSON export, the model panel, window switching, tabs, invariants, run comparison and mobile layout with no console errors.
- Live read-only checks used in development: contract previews via `pnpm validate`, and account reconciliation via `pnpm replay-account`.

## Limits

- **No order-book replay.** The venue publishes historical trades, not depth, so queue position and book impact are not modelled. The result never claims otherwise: the `book-not-crossed` invariant skips with that reason rather than passing.
- **No liquidation fill price or liquidation fee.** A maintenance breach ends the run at the adverse extreme and is labelled as a modelled breach, not a liquidation transaction. Real liquidation penalties are on chain and are read — the reconcile reports them on their own rail — but the simulator does not charge one.
- **Gas is a constant** (`--gas`), not a measured cost.
- **No markout below one settlement interval, and none past the window.** The oracle marks hourly on Hideki, so a 1 m or 5 m markout would be the next hourly mark given a different name; the ladder starts at one interval. The longest rung (24 intervals) is unobserved on a window shorter than a day plus the fills' own spread, and the ladder prints `no mark` with the fill count rather than a zero.
- **Fills are modelled, not executed.** A tape fill estimates what a small taker could have got; it is not a record of a real order. The forced end-of-run close is priced at the final settlement mark (the fills table marks it `tape prints: mark`) and the result says so in its warnings.
- **One position at a time.** Cross-market margin, ADL, insurance funds, and multi-leg portfolios are out of scope, as are parameter sweeps and walk-forward. Monte Carlo trade-order resampling is implemented (`src/resample/`).
- **Fill fees are zero by venue policy, not by omission.** All 22 live Hideki perp markets report `taker=0 maker=0` bps×1k, so every simulated run's fee attribution is structurally zero and the reconcile's fill-fee leg cannot fail here — it now says so (`vacuous-zero-rate`). Non-zero rates are implemented and are exercised by a fixture with a forced non-zero rate, which catches a wrong fee record. The perp fee stream itself is not empty: it is dominated by non-zero `LiquidationFee` rows, which are penalties on forced closes and are reported separately.
- Indexer/RPC availability, incomplete history and changing chain state affect results; a truncated read is surfaced rather than hidden.
- The frontend is local-only. Public deployment and refreshed submission packaging remain separate release tasks.

## Network and layout

Hideki testnet only, chain 50383; default indexer `https://hideki-dev.smk.somnia.host/v1/graphql`. Do not repoint this workflow at mainnet. Shannon is not the bounty network.

The chain identity a run belongs to is never a string typed into the interface. `src/client.ts` holds the two ids that exist — the SDK chain object every read goes through, and `CHAIN_ID`, which only labels the datasets this tool writes and caches — and `chainReport()` compares them. `GET /api/chain` serves that report, and the topbar labels itself from it: `Hideki Testnet · 50383` when the two agree, `Chain mismatch · 50383 ≠ 50321` when `CHAIN_ID` has been pointed somewhere else, and `Chain unknown` if the read fails. `src/client.test.ts` pins the mismatch case by running the module with a drifted `CHAIN_ID`.

```text
src/history/        market config, settlements, candles and bars
src/data/           types, GraphQL reads, content-addressed cache, tape, parameter epochs
src/engine/         event queue, position book, fill model, replay loop, legacy simulate oracle
src/strategy/       strategy interface, fixed and SMA strategies
src/analytics/      metrics, markouts and attribution
src/verify/         invariants and account reconciliation
src/runs/           run identity (runId, dataVersion, configHash, codeCommit)
src/pretrade/       static gates and read-only contract cross-checks
src/bin/            probe-markets, backtest, preflight, validate, replay-account, web
public/             NOVA browser interface
```

The former trade CLI, signer loading, transaction broadcasting, confirmation flow and journal implementation have been removed. Historical journals and old submission archives are not part of the active source and must not be treated as a current release. Removing code does not resolve any historical transaction or close any external position.

Submission drafts and captures are local-only and gitignored. Rebuild and verify their narrative, provenance and archive contents against this source before submission.
