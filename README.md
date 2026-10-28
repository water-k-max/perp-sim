# perp-sim

Funding-aware replay, owner-aware preflight and an opt-in human-approved test-order CLI for dreamDEX perpetuals on Somnia Tokyo (Hideki), chain **50383**.

For a trader choosing a side and size, the useful loop is: **choose → replay funding → check the margin owner → approve a test order → compare receipt and position → separately close → repeat**. Funding and adverse entry-to-mark margin can change whether an apparently affordable idea is worth testing.

## What this build does

- **Funding-aware backtest:** fetches historical settlements from the live Tokyo indexer and replays a hypothetical fixed position using the SDK's arithmetic. Reports price PnL, funding, fees, equity and modeled maintenance breaches.
- **Owner-aware preflight:** compares a proposed position with market rules and, when supplied, the margin owner's contract previews.
- **Delegated IOC test-order CLI:** checks live state, simulates an order, and optionally sends one separately confirmed transaction with durable receipt and position evidence.

**Status:** no live Tokyo trade has been executed. Backtest and preflight are read-only; `trade` defaults to read-only simulation. Actual execution requires `--execute`, an explicit local signer file and full typed interactive confirmation. A live-data backtest is not a live trade: its collateral and position are hypothetical, and it neither consumes a voucher nor needs a funded wallet. Mainnet is unsupported; Shannon transactions are not evidence for this Tokyo build.

## Quick start: read-only

Run from the repository root with Node.js and pnpm (recorded environment: Node.js 22.23.4).

```bash
pnpm install
pnpm probe:markets
pnpm backtest --market BTC --days 14 --side long --size 0.01 --cash 1000
pnpm preflight --market ETH --side short --size 0.05 --cash 500
pnpm validate --account '<MARGIN_OWNER_ADDRESS>'
pnpm trade --help
```

Replace quoted placeholders before use. Read-only commands use the configured Tokyo endpoints; no signer is needed. Do not put secrets in examples, recordings or the submission package.

## The repeatable workflow

### 1. Run a backtest against live Tokyo history

From the repository root, run this complete example (no wallet or private key required):

```bash
pnpm backtest --market BTC --days 14 --side long --size 0.01 --cash 1000 --interval 3600
```

This fetches the preceding 14 days at invocation time, models a 0.01 BTC long with 1,000 hypothetical USDso, and uses hourly candle extremes for intra-bar maintenance checks. It is an illustrative replay, not an order recommendation; its size is not constrained by the trade CLI's 25 USDso opening cap.

To compare the opposite side with the same assumptions:

```bash
pnpm backtest --market BTC --days 14 --side short --size 0.01 --cash 1000 --interval 3600
```

To check settlement marks only, without fetching candle extremes:

```bash
pnpm backtest --market BTC --days 14 --side long --size 0.01 --cash 1000 --no-intrabar
```

Run `pnpm probe:markets` to discover available symbols and pools. Changing `--cash` changes only simulated starting collateral; it does not read, deposit, move or spend your USDso voucher. The window ends at the current time, so separate runs can differ as history changes. There are no fixed start/end-date or live-trading flags for `backtest`.

`pnpm backtest` replays a fixed position through indexed settlements using the SDK's exported arithmetic and cumulative funding-index changes. This avoids assuming funding scales with elapsed time when the protocol forgives catch-up intervals. Market decimals and risk parameters are resolved at runtime.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--market` | `BTC` | Symbol, pair or pool address |
| `--days` | `14` | Look-back window |
| `--side` | `long` | `long` or `short` |
| `--size` | `0.01` | Whole base units, aligned down to lot grid |
| `--cash` | `1000` | Hypothetical USDso collateral |
| `--interval` | `3600` | Candle resolution in seconds; use a resolution supported by the indexer |
| `--no-intrabar` | off | Check settlement marks only |

Output includes PnL, funding, fees, equity, maintenance health and history coverage: settlements found versus expected, gaps, index resyncs and forgiven intervals.

Read the output in this order:

1. **Market configuration:** confirm pool, decimals, lot size, minimum size and risk parameters. The replay aligns size down to the lot grid; inspect the printed position size.
2. **History coverage:** check dates, pagination completeness, missing settlements, gaps and candle coverage. If fewer than three settlements are returned, widen `--days`; network/indexer failures are not strategy results.
3. **Position:** entry is assumed at the second returned settlement mark, not a book fill. Inspect any below-minimum or above-cap warnings.
4. **Result and equity:** `pnl + funding + fees` are signed contributions to the change in equity; negative funding means a cost. Amounts retain full precision, while displayed percentages are rounded.
5. **Thinnest bars:** health is equity divided by maintenance requirement. A modeled maintenance breach is not an actual liquidation transaction.

Testnet history, incomplete coverage and mark-based fills limit what this replay proves. Do not treat its output as profitability evidence or proof that the position can be opened.

### 2. Check the margin owner

```bash
pnpm preflight --market '<POOL_ADDRESS>' --side long --size '<BASE_QUANTITY>' --price '<ABSOLUTE_LIMIT_PRICE>' --cash '<HYPOTHETICAL_USDso>' --account '<MARGIN_OWNER_ADDRESS>'
```

Preflight checks min quantity, lot/tick grid, position and open-interest caps, collateral lock and adverse gap; it also prints current-rate carry context. `--account` means the **margin owner, not the delegated bot/operator**. `--cash` is hypothetical collateral, not a deposit or a balance override.

With `--account`, contract previews (`previewPerpOrderMargin`, `getMaxPerpOrderSize` and the contextual `meetsPerpImForFill`) appear alongside local calculations. The final CLI **PASS remains a hypothetical static verdict**, even if an account preview fails or is unavailable. It is not account authorization, proof of funded margin or permission to send. The IM-only probe does not include the full adverse-gap reserve. Read every owner preview, not just PASS.

Backtest, preflight and trade are separate commands. Backtest does not enforce placement gates or automatically feed results into trade; the user manually carries the chosen intent forward. Preflight rounds to grids; trade instead rejects off-grid values.

### 3. Simulate a delegated Tokyo IOC

```bash
pnpm trade --owner '<MARGIN_OWNER_ADDRESS>' --operator '<DELEGATED_OPERATOR_ADDRESS>' --pool '<POOL_ADDRESS>' --side long --qty '<BASE_QUANTITY>' --price '<ABSOLUTE_LIMIT_PRICE>' --gas '<GAS_UNITS>' --max-gas-spend '<STT_CAP>'
```

All shown value flags are required for dry-run. `--qty` is a positive plain decimal in base units; `--price` is an absolute limit, not a slippage percentage. The gas flag is a positive integer, capped at 30,000,000; total gas price × gas must fit the user's STT (Tokyo native gas) cap and the operator's native balance. The CLI only accepts chain 50383 (`--chain 50383` is optional).

The owner and operator must differ. The operator must already have placement **and cancel** grants on the selected pool; the owner must have sufficient actual margin, no existing orders there and be flat there for opening. The CLI checks USDso collateral, grids, minimum quantity, opening position cap, owner margin, max placeable size and contract simulation. Opening intent notional is capped at 25 USDso at both limit and current mark (not reducing closes); favorable sell fills can exceed that realized notional. A market minimum can make this cap impossible to satisfy: stop rather than bypass it.

The stop gate requires the resolved registry to be absent or not authorized by the pool for this owner's placement selector at the checked block. An authorized registry blocks even if empty; read failures block. This does not prove no pending stops. No stops are cancelled or grants revoked. Execution requires explicit acknowledgment of no simultaneous owner trading, signer nonce use, grant changes or stop changes outside this process while the intent executes; this acknowledgment cannot enforce external coordination.

Dry-run never loads a signer, signs or broadcasts, and rejects `--env-file`. Neither dry-run nor a successful simulation guarantees a fill. There is no automatic funding, linking, grant creation or collateral auto-pull.

### 4. Human-approved test order; compare evidence

Bounty funding eligibility is separate from technical checks. The published bounty guidance requires build wallets outside Perps Arena and prohibits moving bounty USDso into Arena. An automatic DreamDEX voucher label alone does not establish its program eligibility; clarify uncertain funding with the team. The CLI checks on-chain voucher restrictions, market allowance, leverage and margin, but cannot determine organizer approval and has no off-chain approval flag.

Only after independently resolving owner identity, delegation, margin and gas, an authorized operator may add `--execute --env-file '/absolute/path/.env'` to the reviewed dry-run command. The path must be absolute with basename exactly `.env`. The file is local signer material, not part of the package. Never display its contents. This documentation does not authorize a send.

Execution requires interactive stdin and stdout and an exact match of the entire displayed `CONFIRM {...}` line, including owner, operator, chain, pool, action, side, quantity, absolute limit, gas envelope and the concurrency acknowledgment. A simple `yes` is insufficient. Every trade preflight captures an uncached execution-HTTP head and pins all safety reads (including onchain metadata, cross-market owner health, grants and stops) and simulation to that block; canonical hashes are checked before and after reads and simulation. Trade uses no SDK WebSocket or indexer. The HTTP initialization preserves the SDK's retired Hideki v1 block-1 denylist check, not an invented current-genesis allowlist.

After confirmation, a new snapshot and simulation are required. Immediately after initial journal preparation and before signing, an uncached HTTP head must still have exactly the snapshot number and hash, and elapsed snapshot age must be between zero and **5,000 ms**. Advancement, regression, hash changes, expiry or RPC failure stop execution without signing/sending; there are no automatic retries or relaxed checks. This deliberately strict policy can reject on a fast-moving chain. It cannot prevent state changes between the final check and mining and is not a fill or execution guarantee.

First-use journal creation fsyncs every new directory and its parent entry through the preexisting ancestor before loading the signer; errors stop execution. `tmp/trade-journal/` records intent, nonce and transaction hash before broadcast, then receipt status, gas cost, decoded fills and post-order owner position/open orders. Compare requested quantity with decoded fills and actual exposure: **receipt success does not mean full fill**. Receipt state is read through the same HTTP client at the receipt block, with its hash verified before and after reads. The position delta is compared with decoded actual fills, not requested quantity. This is block-end state, not transaction-level attribution or latest exposure; inspect fresh state before closing. Discrepancies or unexpected open orders retain a durable `review-required` journal. An unresolved journal blocks further sends: independently resolve its hash/nonce; do not delete it or blindly retry.

### 5. Separately close, then repeat

`--close` is another invocation, dry-run by default, with the opposite side and **exact fresh remaining position quantity**. It requires new price/gas choices and a separate full confirmation when executed. For a remaining long position:

```bash
pnpm trade --close --owner '<MARGIN_OWNER_ADDRESS>' --operator '<DELEGATED_OPERATOR_ADDRESS>' --pool '<POOL_ADDRESS>' --side short --qty '<EXACT_REMAINING_BASE_QUANTITY>' --price '<NEW_ABSOLUTE_LIMIT_PRICE>' --gas '<GAS_UNITS>' --max-gas-spend '<STT_CAP>'
```

Use `--side long` for a remaining short. Replace every placeholder with freshly verified values; this command does not execute unless explicitly extended as described above.

No automatic cleanup or cancellation occurs. There is no atomic reduce-only flag; concurrent owner activity can invalidate close checks. Partial fills, dust, grid/minimum rules and liquidity can prevent closing; the 25 USDso opening cap does not apply to reducing closes. An exact full reducing close may exceed a subsequently lowered position cap, but all other close gates and simulation still apply. Inspect remaining exposure and orders before repeating; never describe a partial close as flat.

## Verification

`pnpm validate` compares margin lock, initial-margin portion, adverse-gap portion and projected liquidation-price arithmetic with contract previews at their own block. The October 27, 2026 capture covers BTC, ETH, SOL and ZRO × long/short × four size/price combinations: **32 read-only cases, zero skipped, zero mismatches**, blocks 34,590,061–34,591,366. This is selected-case arithmetic validation, not proof of all behavior, delegated authorization or executed orders. Reusing SDK arithmetic reduces drift; it does not eliminate all modeling or implementation error.

Run local verification:

```bash
pnpm typecheck
pnpm test:units
pnpm test:trade
```

The offline suite covers production pinned-reader gates, USDso identity and 18 decimals, realistic BTC price parsing, actual-decimal precision and uint256 limits, above-cap reducing closes, journal durability, concurrency acknowledgment, mocked HTTP simulation calldata, canonical hashes and pre-sign freshness refusals. These tests are not live execution evidence.

## Limits

- Replay assumes entry at a settlement mark; it does not simulate books, slippage or partial fills. Traded candle extremes are only proxies for oracle marks.
- A position closed at a settlement pays that settlement's funding. Signed funding contributions are costs/credits to equity, not a flat elapsed-time estimate.
- One market/side is modeled; cross-market margin, ADL, insurance and liquidation execution are not simulated. `liquidated` means maintenance was breached in the model.
- Backtest can simulate an impossible-to-place position. Use owner-aware preflight and fresh trade gates separately.
- Historical fee captures were zero; nonzero-fee behavior has not been validated against a charging pool. Synthetic testnet history does not establish strategy performance.
- Indexer/RPC availability and changing state affect results. Read-path retries are distinct from trade's no-write-retry policy.

## Network and layout

Tokyo/Hideki only, chain 50383; indexer `https://hideki-dev.smk.somnia.host/v1/graphql`. Trade pins Tokyo HTTP and SDK network configuration, resolves pool risk/margin configuration, and requires perpetual USDso `0xed7993A74dAe1e6656B704A424DcD8711aAf4F72` with 18 decimals. The SDK's generic `collateral` constant is binary-market tUSDC and is not used as the perps collateral identity. Do not repoint this workflow at mainnet. Shannon is not the bounty network.

```text
src/history/          market configuration, settlement history and bars
src/engine/simulate.ts funding-aware position replay
src/pretrade/gates.ts  static gates and contract cross-checks
src/bin/              probe-markets, backtest, preflight, validate, trade
src/trade/            strict inputs, delegated adapter, confirmation workflow, journal, tests
```

Submission drafts: [SUBMISSION](tmp/dorahacks-submission/SUBMISSION.md), [DEMO](tmp/dorahacks-submission/DEMO.md), [X posts](tmp/dorahacks-submission/X-POSTS.md), [CHECKLIST](tmp/dorahacks-submission/CHECKLIST.md). Before release, the packaging owner must validate source/README consistency, provenance, archive contents and archive-relative links. This documentation update does not certify package synchronization or publish anything.
