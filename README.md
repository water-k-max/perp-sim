# perp-sim · NOVA Backtest Lab

A **read-only** trader-intelligence and backtest lab for dreamDEX perpetuals on the Somnia **Hideki testnet (chain 50383)**. It reads the venue's real on-chain history. It never signs, never sends a transaction, and never needs a private key or a funded wallet.

**Live:** <https://perp-sim.vercel.app> — deployed by CI (`.github/workflows/ci.yml`), read-only, holds no credential.

## What it does

Four lenses, one read-only engine:

1. **Discover by net (the leaderboard).** Rank every account that closed a perp position in the window by what it actually kept: **net realized = gross realized − funding paid − trade fees**. Liquidation penalties are listed separately, never deducted from net. A read that stops early is labelled, not presented as a complete census.
2. **Verify & analyse a wallet (the default).** Paste any public address, or click / mirror a leaderboard row. It reads that account's actual fills across **all 40 markets** (`market=ALL`), books them through the same position book the chain uses, reconciles row-by-row against the indexer, and resamples the realized PnL into an equity distribution — bankruptcy rate, drawdown, percentiles. A **per-market breakdown** ranks where the account earns, and a descriptive **tempo / style** note reads its cadence. **Mirror** copy-sims a trader's realized closes in-sample against your starting cash.
3. **Import a trade list.** Resample your own CSV / JSON fills through the same seeded engine.
4. **Hypothesis mode.** Simulate one hypothetical position (fixed size or SMA crossover) — the original single-position backtest — against the venue's history, with a tape-fill or settlement-mark execution model.

## How it works

```
indexer reads -> position book (chain's avg-entry math) -> reconcile vs PerpPositionChange / FeeRecord
 settlements, candles, tape, param epochs                        |
                                                                 v
                                              closed-trade PnL list -> seeded Monte Carlo
                                                                        (shuffle / bootstrap)
```

- **Exact money.** bigint internally, decimal strings at the API edge.
- **Deterministic.** Same address / window / seed gives a bit-identical result and event hash (splitmix64 -> xoshiro256**; no `Math.random()` in the resample path).
- **Honest coverage.** Every read reports the window it actually covered; a truncated read is labelled, never shown as whole.
- **Reproducible identity.** Each run carries `runId`, `dataVersion`, `configHash`, `codeCommit`, so two runs that disagree can be told apart.

## Setup

Node >= 22, pnpm >= 12.

```bash
pnpm install
pnpm probe:markets     # read-only sanity check against the live indexer
pnpm dev               # builds the UI, serves http://localhost:3000 (loopback)
```

`PORT` overrides the port. The server binds `127.0.0.1`, caps request bodies and lookbacks, and serves only the frontend plus the read-only API.

CLI:

```bash
pnpm backtest --market BTC --days 14 --size 0.01 --cash 1000 --model tape
pnpm replay-account --account <PUBLIC_ADDRESS> --market BTC --days 3
pnpm preflight --market ETH --side short --size 0.05 --cash 500
pnpm validate --account <MARGIN_OWNER_ADDRESS>
```

Never put private keys in config, examples or recordings — only public addresses are ever read.

## Verify

```bash
pnpm gate         # typecheck + every suite + site build, fully offline
pnpm test:guards  # mutation harness for the UI render guards (slow, not in gate)
```

CI runs the same `gate` on every push/PR, a read-only live-chain job, and — when the repo variable `VERCEL_DEPLOY_ENABLED=true` — the Vercel deploy. Deployment evidence: `docs/deployment-vercel.md`.

## Honest limits

- **Wallet lens is gross; the leaderboard is net.** The wallet resample reports the chain's *gross realized* trade PnL — funding and fees are not deducted on that lens. The leaderboard ranks *net* (gross − funding paid − trade fees). On Hideki, taker/maker fees are 0 by venue policy, so the wallet fee check is labelled `vacuous-zero-rate`, not "verified".
- **In-sample, not a forecast.** The copy-sim mirrors a trader's *past* realized closes; the tempo/style note is a descriptive heuristic over one window, not a skill verdict or a prediction.
- **Modelled, not executed.** A tape fill estimates what a small taker could have got; the distribution is a model of trade-order risk, **not a forecast**. No order-book depth, no liquidation fill price, gas is a constant.
- **One position at a time** in hypothesis mode; cross-market margin, ADL and insurance funds are out of scope.
- A read-only research tool, not financial advice. Hideki testnet only — do not repoint it at mainnet.

## Layout

```
src/engine/    position book, fill model, replay loop
src/data/      GraphQL reads, content-addressed cache, tape, parameter epochs
src/resample/  seeded Monte Carlo, sizing, optimism audit, out-of-sample
src/verify/    invariants + account reconciliation (incl. cross-market)
src/server/    one route table, two transports (loopback / serverless)
src/web/       NOVA React UI (hand-rolled SVG charts)
api/           per-route Vercel functions -> the shared handler
```

Constraints and phase plan: `AGENTS.md`. Resampling design: `docs/resampling-design.md`. Calibration and invariant detail live in the module sources and their tests.
