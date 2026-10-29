# perp-sim

A read-only, funding-aware backtesting tool for dreamDEX perpetuals on Somnia Tokyo (Hideki), chain **50383**.

Compare a hypothetical long or short position against historical price moves and funding costs, then inspect market constraints with optional read-only preflight analysis. No private key or funded wallet is needed for backtesting. The tool does not sign transactions, place orders, move collateral or close positions.

## What this build does

- **Funding-aware backtest:** fetches historical settlements from the Tokyo indexer and replays a hypothetical fixed position using the SDK's arithmetic. Reports price PnL, funding, fees, equity and modeled maintenance breaches.
- **Owner-aware preflight:** compares a proposed position with market rules and, optionally, the margin owner's contract previews.
- **Arithmetic validation:** compares local margin and liquidation-price calculations with read-only contract previews.

**Status: backtesting verified against live Tokyo history.** The retained October 28, 2026 BTC replay covered **336 settlements, 0 missing settlements, 0 gap bars, 0 anchor resyncs and 0 forgiven intervals**. Starting with 1,000 hypothetical USDso, it ended at 958.785673940097159948; funding contributed −39.968530053144290052 and price PnL −1.24579600675855. These are historical replay results, not executed trades or profitability guarantees. Captures are local release evidence, not tracked GitHub files. The replay window ends at invocation time, so later runs have different windows, coverage and results.

## Browser interface

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` for the NOVA Protocol Backtest Lab. Configure market, direction, base size, hypothetical cash and lookback, then run the replay. The market list and each market's lot size and minimum quantity are read live from the indexer, so the form defaults to a size the market's grid can actually accept and a below-grid size is reported as a sizing problem rather than a data failure. Results include equity, signed price/funding/fee contributions, settlement-mark maximum drawdown, coverage warnings and a JSON export. Intrabar mode uses hourly candles for modeled maintenance checks. The initial screen contains no invented results.

The server binds to local loopback, accepts one replay at a time and limits lookbacks to 1–90 days. It serves only the frontend assets and the read-only backtest API; it never serves local environment files. This is a local research interface, not a hardened public hosting deployment. No wallet connection or transaction execution is included.

The NOVA artwork is supplied by the project owner in `public/nova-storyboard.png`.

## Quick start

Use Node.js >=22 and pnpm >=12 (recorded environment: Node.js 22.23.4, pnpm 12.9.1). The workspace config uses pnpm 12's `allowBuilds` setting.

```bash
pnpm install
pnpm probe:markets
pnpm backtest --market BTC --days 14 --side long --size 0.01 --cash 1000
pnpm preflight --market ETH --side short --size 0.05 --cash 500
pnpm validate --account '<MARGIN_OWNER_ADDRESS>'
```

Replace quoted placeholders before use. Optional endpoint and public account configuration is documented in `.env.example`. Do not add private keys to configuration, examples or recordings.

## Backtest against Tokyo history

```bash
pnpm backtest --market BTC --days 14 --side long --size 0.01 --cash 1000 --interval 3600
```

This fetches the preceding 14 days, models a 0.01 BTC long with 1,000 hypothetical USDso, and uses hourly candle extremes for intra-bar maintenance checks. It is an illustrative replay, not an order recommendation.

Compare the opposite side:

```bash
pnpm backtest --market BTC --days 14 --side short --size 0.01 --cash 1000 --interval 3600
```

To check settlement marks only, without fetching candle extremes:

```bash
pnpm backtest --market BTC --days 14 --side long --size 0.01 --cash 1000 --no-intrabar
```

Run `pnpm probe:markets` to discover symbols and pools. Changing `--cash` changes only simulated collateral; it does not read, deposit, move or spend a voucher. There are no fixed start/end-date or live-trading flags.

The replay uses SDK arithmetic and cumulative funding-index changes rather than assuming funding scales with elapsed time when the protocol forgives catch-up intervals. Market decimals and risk parameters are resolved at runtime.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--market` | `BTC` | Symbol, pair or pool address |
| `--days` | `14` | Look-back window |
| `--side` | `long` | `long` or `short` |
| `--size` | `0.01` | Whole base units, aligned down to lot grid |
| `--cash` | `1000` | Hypothetical USDso collateral |
| `--interval` | `3600` | Candle resolution in seconds; use an indexer-supported resolution |
| `--no-intrabar` | off | Check settlement marks only |

Read the output in this order:

1. **Market configuration:** pool, decimals, lot/minimum sizes and risk parameters. Inspect the size after lot-grid alignment.
2. **History coverage:** dates, settlements found versus expected, gaps, index resyncs, forgiven intervals and candle coverage. If fewer than three settlements are returned, widen `--days`; network failures are not strategy results.
3. **Position:** entry is assumed at the second settlement mark, not a book fill. Inspect below-minimum or above-cap warnings.
4. **Equity:** `pnl + funding + fees` are signed contributions; negative funding is a cost. Amounts retain full precision; percentages are rounded.
5. **Thinnest bars:** health is equity divided by maintenance requirement. A modeled breach is not an actual liquidation transaction.

## Optional read-only preflight

```bash
pnpm preflight --market '<POOL_ADDRESS>' --side long --size '<BASE_QUANTITY>' --price '<ABSOLUTE_LIMIT_PRICE>' --cash '<HYPOTHETICAL_USDso>' --account '<MARGIN_OWNER_ADDRESS>'
```

Preflight checks minimum quantity, lot/tick grids, position and open-interest caps, collateral lock and adverse gap; it also prints current-rate carry context. `--account` means the **margin owner**, not a delegated operator. `--cash` is hypothetical collateral, not a deposit or balance override.

With `--account`, contract previews (`previewPerpOrderMargin`, `getMaxPerpOrderSize` and contextual `meetsPerpImForFill`) appear alongside local calculations. The final **PASS is a hypothetical static verdict**, even if an account preview fails or is unavailable. It does not prove funded margin or that an order can execute. The IM-only probe excludes the full adverse-gap reserve; read every owner preview, not just PASS.

Backtest and preflight are independent commands. Backtest does not enforce placement gates or automatically feed results into preflight. Preflight rounds inputs to grids.

## Verification

```bash
pnpm typecheck
pnpm test:units
pnpm test:web
pnpm validate --account '<MARGIN_OWNER_ADDRESS>'
```

Typechecking and unit tests run locally. The unit suite covers decimal conversion and formatting, not the entire replay engine. `validate` requires live read-only access and compares margin lock, initial margin, adverse gap and projected liquidation-price arithmetic with contract previews at their own block.

The retained October 27, 2026 validation capture covers BTC, ETH, SOL and ZRO × long/short × four size/price combinations: **32 cases, zero skipped, zero mismatches**, blocks 34,590,061–34,591,366. This is selected-case arithmetic validation, not proof of all behavior. Reusing SDK arithmetic reduces drift but does not eliminate modeling or implementation error.

## Limits

- Replay assumes settlement-mark entry; it does not simulate books, slippage or partial fills. Candle extremes are only proxies for oracle marks.
- A position closed at a settlement pays that settlement's funding. Funding is not a flat elapsed-time estimate.
- One market/side is modeled; cross-market margin, ADL, insurance and liquidation execution are not simulated. `liquidated` means a modeled maintenance breach.
- Backtest can model impossible-to-place positions. Optional preflight provides context, not execution guarantees.
- Historical fee captures were zero; nonzero fees have not been validated against a charging pool. Synthetic testnet history does not establish strategy performance.
- Indexer/RPC availability, incomplete history and changing state affect results.
- The frontend is local-only. Public deployment and refreshed submission packaging remain separate release tasks.

## Network and layout

Tokyo/Hideki testnet only, chain 50383; default indexer `https://hideki-dev.smk.somnia.host/v1/graphql`. Do not repoint this workflow at mainnet. Shannon is not the bounty network.

```text
src/history/          market configuration, settlement history and bars
src/engine/simulate.ts funding-aware position replay
src/pretrade/gates.ts  static gates and contract cross-checks
src/bin/              probe-markets, backtest, preflight, validate
```

The former trade CLI, signer loading, transaction broadcasting, confirmation flow and journal implementation have been removed. Historical journals and old submission archives are not part of the active source and must not be treated as a current release. Removing code does not resolve any historical transaction or close any external position.

Submission drafts and captures are local-only and gitignored. Existing packages predate this refactor; rebuild and verify their source, narrative, provenance and archive contents before submission.
