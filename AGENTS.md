# perp-sim — Agent Instructions

Read-only backtester and pre-trade simulator for dreamDEX perps on the Somnia Hideki
testnet, chain 50383, built on the venue SDK's own exported arithmetic. This is the bounty MVP
repository. Nothing from the feedback repository (`~/dreamdex-perps-bounty`) belongs here.

## Prime directive for this upgrade

The resampling features are described in [`docs/resampling-design.md`](docs/resampling-design.md):
a seeded trade-list resampler (Monte Carlo over trade order), a fill check, a sizing
module, an out-of-sample boundary module, distribution analytics and the UI that presents
them, all driven by our own replay output or a wallet's real fills. Keep behaviour
consistent with that doc and update it when behaviour changes.

## Non-negotiable constraints

1. **Read-only.** No signer, no keys, no transactions, no wallet connection. The server
   binds loopback and serves only frontend assets plus the read-only API. Never weaken this.
2. **Exact money.** bigint internally, decimal strings at the API edge. Path equity is an
   integer-unit accumulation of exact trade PnLs; only percentile interpolation is float,
   and it happens on decimals at the edge.
3. **Determinism.** Same seed ⇒ bit-identical result and identical event hash. The seed is
   part of `configHash`. Use a fixed, documented PRNG (splitmix64 seeding a xoshiro256**
   stream, one stream per path, derived as `hash(seed, pathIndex)`) — no `Math.random()`
   anywhere in the resample path, pinned by a test.
4. **No new runtime dependencies** without justification in this file. Charts stay in the
   existing hand-rolled SVG component (`src/web/Chart.tsx`). No Plotly, no chart libs.
5. **Tests alongside code.** Every module gets `node:test` coverage; every new invariant
   gets a canary that must fail when the thing it checks is broken.
6. **No look-ahead** in resampling either: held-back trades never influence fit-half
   statistics; audit re-pricing uses only each trade's own excursion data.
7. Node >= 22, pnpm >= 12. Keep `pnpm typecheck` and every test suite green at each phase
   boundary. Commit per phase.

## Where things live today

| area | files |
| --- | --- |
| Engine, fills, portfolio, replay loop | `src/engine/*` |
| Data: tape, candles, params, store | `src/data/*` |
| Analytics (metrics, attribution, decimals) | `src/analytics/*` |
| Run identity, store, manifest | `src/runs/*` |
| Invariants | `src/verify/invariants.ts` |
| Web (React, esbuild bundle) | `src/web/*`, `public/*` |
| HTTP API | `src/bin/web.ts`, `src/backtest-api.ts` |
| CLI | `src/bin/backtest.ts` |

## Phase plan

Each phase: implement, test, typecheck, commit. Do not start a phase before the previous
one is committed and green.

### Phase 1 — resampling core (`src/resample/`)
`rng.ts` (splitmix64/xoshiro256** + stream derivation), `sample.ts` (the two modes from the
the design doc: `shuffle_without_replacement`, `bootstrap_with_replacement`), `path.ts` (equity
walker with static and compound sizing, per-path final/drawdown/streak/bankruptcy
tracking), `stats.ts` (percentiles p05/p10/p25/p50/p75/p90/p95, median, bankruptcy rate,
CVaR-95, fan bands per step, drawdown and streak distributions).
Tests: seeded determinism (same seed ⇒ identical JSON, different seed ⇒ different order),
mode properties (shuffle preserves the trade multiset; bootstrap may not), percentile
monotonicity, CVaR ≤ VaR, golden fixture for a 10-trade hand-written list with a pinned seed.

### Phase 2 — trade-list extraction (`src/resample/inputs.ts`)
Map a completed run's closed trades into the design doc trade records (§2): pnl (exact),
entry/exit timestamps, direction, barsHeld (settlement bars), and **observed** MAE/MFE
computed from hourly candles over the holding window (fall back to tape slice extremes
inside the fill windows; record which source was used per trade). Tests: MAE/MFE against a
hand-computed fixture window; a run with one trade yields one record with zero barsHeld
flagged same-bar.

### Phase 3 — optimism audit (`src/resample/audit.ts`)
Same-bar share, `withoutExcursion` count, dismissal threshold, and the "gone the other
way" re-pricing re-run the design doc: move each same-bar adverse trade to its worst observed
price, re-run the distribution, report both curves side by side. Generate the assumptions
lines from the run's own config (profile optimistic, latency 0, gas 0, settlement-mark
model, no intrabar marking) — each line states its live-fill consequence. Disclose the
unbounded case (stop+target in one final bar) the design doc.
Tests: share math, re-pricing only touches same-bar adverse trades, threshold verdict.

### Phase 4 — sizing module (`src/resample/sizing.ts`)
Accepted-loss input; per-size loss probability over the first `horizonTrades` of each path
at static sizing; median/p05 pnl per size; drop rows past even-money odds the design doc.
Sizes are base units aligned to the market lot grid; include a leverage sanity note from
the run's IMF. Tests: probability bounds [0,1], monotone in size, deterministic under seed.

### Phase 5 — out-of-sample module (`src/resample/oos.ts`)
Holdback fraction, fit-half boundary (95th percentile of fit finals), held-back replay
curve, `crossed` verdict the design doc. Enforce no-lookahead: held trades excluded from fit
stats. Tests: boundary calibration (≈5% of fit paths cross it), crossed flag on a
constructed crossing fixture, no-lookahead canary.

### Phase 6 — API + persistence
Extend `POST /api/backtest`'s response with the `resample` block only when the request
asks for it (`resample: { seed?, paths?, mode?, sizing?, horizonTrades?, acceptedLoss?,
holdbackFraction? }`; default seed = hash of `runId` so runs are reproducible without a
frontend change). Add `POST /api/resample` to re-run resampling over a cached/stored run
without refetching chain data (it must accept `runId` + seed and reuse the run store).
Results persist through `src/runs/store.ts` keyed by `runId + resampleSeed`; store the
full the design doc JSON. Respect the existing body-size caps and loopback binding.
Tests: replay two identical requests ⇒ identical hashes; `api/resample` round-trips a
stored run; oversized bodies rejected as today.

### Phase 7 — web UI
Tabs under Results: **Distribution** (fan chart with p10–p90 and p25–p75 bands, median
line, the original single path overlaid; finals/drawdown/streak histograms), **Audit**
(same-bar share header with dismissal verdict, assumptions list, side-by-side
repriced-vs-exported curves), **Sizing** (accepted-loss input, table), **OOS** (boundary,
held curve, verdict). Seed + path count + mode shown beside every analysis; a
"re-run with a new seed" control; mode toggle shuffle/bootstrap and both-views compare;
run-comparison table gains the the design doc metrics rows. Extend the existing SVG chart
component for bands (`tonexty`-style stacked areas). Keep the MODELLED FILL / NO FILL
badges; add a MODELLED DISTRIBUTION note when paths < 5,000.
Tests: `src/backtest-api.test.ts` style — UI contract via the API DTO validator
(`src/web/dto.ts`), snapshot of the fan-band path strings for a pinned seed.

### Phase 9 — forward-test analog: built, measured, removed (2026-11-10)
Polling a public account's fills and landing them on a stored run's band was implemented and run
live, then deleted. It cannot be made correct: the band's x-axis is the run's *trade* count while a
live account's x-axis is its *fill* count (one trade, many fills), and the two populations have
different sizes, so past the last band step every live point is compared against a clamped,
zero-width quantile. Measured on a 83-trade SMA run against 500 live Hideki fills: 418 of the 500
band readings had `p10 === p90`, and 480 read "outside". The sound version of the same question —
resample an account's *own* trade list — is `POST /api/accounts/:addr/resample` and the wallet
panel; keep that. Do not rebuild this comparison against another run's band.

## Verification gate (every phase)

```bash
pnpm typecheck
pnpm test:units && pnpm test:engine && pnpm test:data && pnpm test:analytics && pnpm test:verify && pnpm test:runs && pnpm test:web
```

Add `pnpm test:resample` (`tsx --test src/resample/*.test.ts`) at Phase 1 and add it to the
gate. `src/verify/invariants.ts` gains: `resample-deterministic` (re-run same seed ⇒ equal
hash; error level), `resample-bounds` (probabilities in [0,1], CVaR ≤ VaR, percentile
ladder ordered; error), `oos-no-lookahead` (held trades absent from fit inputs; error).
Each must fail if the mechanism it checks is broken — extend the existing tamper tests.

## Honesty rules (product-level, enforced in UI copy)

- Distribution output is a model of trade-order risk, not a forecast.
- The audit's same-bar count is what can be counted, never presented as a bound.
- Sizing odds describe resampled paths, not the future.
- OOS crossing is an investigation trigger, not a verdict.
Keep the existing MODELLED FILL badge discipline: every modelled quantity is labelled as
modelled where it is displayed.
