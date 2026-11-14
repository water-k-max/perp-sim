# perp-sim · NOVA Backtest Lab

A trader-intelligence and backtest lab for dreamDEX perpetuals on the Somnia **Hideki testnet (chain 50383)**. Its four research lenses read the venue's real on-chain history and **never sign, never send a transaction, and never need a private key**. A separate, **bounded execution path** can place one real testnet order — but only from the local lab with the operator's own funded key. The public deployment is read-only and holds no credential.

**Live:** <https://perp-sim.vercel.app> — deployed by CI (`.github/workflows/ci.yml`), read-only, holds no credential.

**Who it's for:** perp traders and researchers on Somnia who want to see what a strategy or a trader actually kept before risking capital — and, locally, to place a single bounded testnet order to prove the execution path end-to-end.

## What it does

Four lenses, one read-only engine:

1. **Discover by net (the leaderboard).** Rank every account that closed a perp position in the window by what it actually kept: **net realized = gross realized − funding paid − trade fees**. Liquidation penalties are listed separately, never deducted from net. A read that stops early is labelled, not presented as a complete census.
2. **Verify & analyse a wallet (the default).** Paste any public address, or click / mirror a leaderboard row. It reads that account's actual fills across **all 40 markets** (`market=ALL`), books them through the same position book the chain uses, reconciles row-by-row against the indexer, and resamples the realized PnL into an equity distribution — bankruptcy rate, drawdown, percentiles. A **per-market breakdown** ranks where the account earns, and a descriptive **tempo / style** note reads its cadence. **Mirror** copy-sims a trader's realized closes in-sample against your starting cash.
3. **Import a trade list.** Resample your own CSV / JSON fills through the same seeded engine.
4. **Hypothesis mode.** Simulate one hypothetical position (fixed size or SMA crossover) — the original single-position backtest — against the venue's history, with a tape-fill or settlement-mark execution model.
5. **Place a testnet order (local-only).** A bounded execution path prices one order with the same pre-trade gates, then either previews the exact calldata (dry-run, the default) or places it on Hideki testnet. Off by default, capped per order, confirm-gated, and refused on the public deployment. See [Execution](#execution-local-only).

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

`PORT` overrides the port. The server binds `127.0.0.1`, caps request bodies and lookbacks, and serves the frontend plus the read-only API. The bounded execution route is local-only and refused on any deployment.

CLI:

```bash
pnpm backtest --market BTC --days 14 --size 0.01 --cash 1000 --model tape
pnpm replay-account --account <PUBLIC_ADDRESS> --market BTC --days 3
pnpm preflight --market ETH --side short --size 0.05 --cash 500
pnpm validate --account <MARGIN_OWNER_ADDRESS>
pnpm execute --market BTC --side long --size 0.01 --cash 1000   # dry-run preview (default; nothing sent)
```

The research lenses read only public addresses. The optional execution path reads a funded `PRIVATE_KEY` from a gitignored `.env` — never commit it, paste it into a report, or put it in an example or recording.

## Execution (local-only)

The execution path places **one real perp order on Somnia Hideki testnet (50383)**. It is bounded by construction, and the public deployment can never reach it.

**Safety model**

- **Local-only.** `POST /api/execute` is refused with `501` on any deployment; the serverless function holds no key. Only the loopback lab can send.
- **Off by default.** `EXECUTION_ENABLED=false`. With it false, every request is a preview.
- **Preview-only by default.** `DRY_RUN=true`. A dry-run reads the live market, prices the order with the same pre-trade gates the pre-flight check uses, and prints the exact calldata a live placement would broadcast — no signer, no key, no send.
- **Capped per order.** `EXECUTION_MAX_NOTIONAL` (quote units, default `100`). The policy kernel refuses to send over it.
- **Confirm-gated.** A live send needs an explicit per-request confirm (`--confirm` on the CLI, a checkbox in the web panel) *and* a configured key *and* an under-cap, placeable pre-trade verdict. All of: local + enabled + `DRY_RUN=false` + confirm + key + under cap + placeable.
- **No new arithmetic, no new deps.** It reuses `src/pretrade/gates.ts` for the exact notional, margin, lock and liquidation price, and writes through the venue SDK's own `createTrader` / `placePerpOrder` / `depositMargin`.

**Place a real testnet order**

1. Fund a wallet on Hideki testnet (the Somnia faucet) and put its key in a gitignored `.env`:
   ```bash
   EXECUTION_ENABLED=true
   DRY_RUN=false
   PRIVATE_KEY=0x<your-funded-testnet-key>   # never commit this
   EXECUTION_MAX_NOTIONAL=100
   ```
2. Preview first (always safe), then send:
   ```bash
   pnpm execute --market BTC --side long --size 0.01 --cash 1000            # dry-run preview
   pnpm execute --market BTC --side long --size 0.01 --cash 1000 --live --confirm   # sends one order
   ```
   Or use the local web panel (`pnpm dev`): it shows the proposal and calldata, badges **DRY RUN** or **LIVE · TESTNET**, and requires the confirm checkbox before a live send.
3. **Evidence.** A live send prints the transaction hash. **There is no public block explorer for Hideki** — verify the hash with `eth_getTransactionReceipt` against the testnet RPC, not an explorer link. The first live placement (2026-11-14, a long 0.001 BTC limit order) is recorded with its deposit/order hashes, blocks, order id and resulting margin state in [`docs/execution.md`](docs/execution.md#first-live-placement-evidence).

Full detail: [`docs/execution.md`](docs/execution.md).

## Verify

```bash
pnpm gate         # typecheck + every suite + site build, fully offline
pnpm test:guards  # mutation harness for the UI render guards (slow, not in gate)
```

CI runs the same `gate` on every push/PR, a read-only live-chain job, and — when the repo variable `VERCEL_DEPLOY_ENABLED=true` — the Vercel deploy. Deployment evidence: `docs/deployment-vercel.md`.

## Honest limits

- **Wallet lens is gross; the leaderboard is net.** The wallet resample reports the chain's *gross realized* trade PnL — funding and fees are not deducted on that lens. The leaderboard ranks *net* (gross − funding paid − trade fees). On Hideki, taker/maker fees are 0 by venue policy, so the wallet fee check is labelled `vacuous-zero-rate`, not "verified".
- **In-sample, not a forecast.** The copy-sim mirrors a trader's *past* realized closes; the tempo/style note is a descriptive heuristic over one window, not a skill verdict or a prediction.
- **Modelled, not executed.** A tape fill estimates what a small taker could have got; the distribution is a model of trade-order risk, **not a forecast**. No order-book depth, no liquidation fill price, gas is a constant. The separate execution path places a *real* testnet order — that is not a backtest result and carries real testnet risk.
- **Execution is bounded, not a trading bot.** One order per request, capped, confirm-gated, local-only, testnet-only. It does not run a strategy, manage a position, or promise a fill; a placed order can still be refused or liquidated by the venue.
- **One position at a time** in hypothesis mode; cross-market margin, ADL and insurance funds are out of scope.
- The research lenses are read-only; the execution path is local-only, testnet-only and opt-in. Not financial advice. Hideki testnet only — do not repoint it at mainnet.

## X posts

Real posts about this build, tagging [@DreamDEXSomnia](https://x.com/DreamDEXSomnia), are linked here once published. *(No posts are fabricated — this section is filled with the author's own published links.)*

## Layout

```
src/engine/    position book, fill model, replay loop
src/data/      GraphQL reads, content-addressed cache, tape, parameter epochs
src/resample/  seeded Monte Carlo, sizing, optimism audit, out-of-sample
src/verify/    invariants + account reconciliation (incl. cross-market)
src/execute/   bounded local-only execution: policy, proposal, calldata, executor
src/server/    one route table, two transports (loopback / serverless)
src/web/       NOVA React UI (hand-rolled SVG charts)
api/           per-route Vercel functions -> the shared handler
```

Constraints and phase plan: `AGENTS.md`. Resampling design: `docs/resampling-design.md`. Execution safety model: `docs/execution.md`. Calibration and invariant detail live in the module sources and their tests.
