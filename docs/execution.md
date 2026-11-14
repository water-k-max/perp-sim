# Bounded execution (local-only)

Added 2026-11-14, owner-authorized, to satisfy the dreamDEX hackathon MVP requirement
*"Your MVP places real perps orders on Somnia Tokyo testnet."* Somnia Tokyo / Hideki testnet is
chain **50383** (`src/client.ts` is pinned to it; do not repoint at mainnet).

This is the one path in the lab that can sign and send. Everything else — discover, verify, mirror,
simulate — stays read-only. The execution path is **bounded by construction**: the public deployment
cannot reach it, it is off and preview-only by default, it is capped per order, and a live send needs
an explicit per-request confirmation and the operator's own funded key.

## Safety model

A live send happens only when **every** one of these holds:

| bound | where | default |
| --- | --- | --- |
| Local transport | route table refuses `POST /api/execute` on a deployment (`501`); the serverless function holds no key | deployment refuses |
| `EXECUTION_ENABLED` | `src/config.ts` | `false` |
| `DRY_RUN=false` | `src/config.ts` | `true` (preview only) |
| Per-request confirm | CLI `--confirm`, web checkbox | `false` |
| A configured key | `PRIVATE_KEY` in a gitignored `.env` | none |
| Notional under cap | `EXECUTION_MAX_NOTIONAL` (quote units) | `100` |
| Placeable pre-trade verdict | `src/pretrade/gates.ts` | — |

The decision is pure and lives in `src/execute/policy.ts` (`decideExecution`). It never sees the key —
only whether one is configured. Its arms, in order:

1. `mode !== "local"` → refuse. A deployment can never send, regardless of environment.
2. `!enabled || dryRun` → **preview**, with the reason (`EXECUTION_ENABLED is false` or `DRY_RUN is true`).
   Previewing is always safe locally, so an over-cap or unplaceable order still previews — the proposal
   shows the failing gate rather than the kernel hiding it.
3. `notional > maxNotional` → refuse.
4. `!placeable` → refuse (the pool would reject it).
5. `!confirm` → refuse.
6. `!hasKey` → refuse.
7. otherwise → **send** one order.

The key is read in `src/config.ts` (`secretKey` validates a 32-byte hex) and never logged, never
serialised into a response, never committed. `.env` and `.env.*` are gitignored; only `.env.example`
(which carries a **blank** key) is tracked.

## Architecture

| module | role |
| --- | --- |
| `src/config.ts` | reads `EXECUTION_ENABLED`, `DRY_RUN`, `PRIVATE_KEY`, `EXECUTION_MAX_NOTIONAL` with safe defaults |
| `src/execute/policy.ts` | pure send/preview/refuse kernel; `ExecutionRefused` carries a stated reason |
| `src/execute/proposal.ts` | turns a human order into an intent, aligns size **down** to the lot grid and price to the tick grid, prices it with `staticGates`/`lockFor` (no new arithmetic); carries exact raw bigints + decimal strings |
| `src/execute/calldata.ts` | encodes the exact bytes a live placement would broadcast, with the SDK's exported ABIs + `viem`; no signer, no network |
| `src/execute/executor.ts` | the one place an order is previewed or sent; injects the writer (`createTrader`) and builds it **only** on the live arm |
| `src/execute/request.ts` | HTTP-edge DTO parser; validates types/ranges/decimals before any lane or network |
| `src/server/app.ts` | `GET /api/execution` (config-only capability) and `POST /api/execute` (local-only) |
| `src/bin/execute.ts` | CLI: `pnpm execute … [--live --confirm]` |
| `src/web/Execute.tsx` | the local-only panel; the public deployment renders a read-only note instead |

**Exact money.** bigint internally, decimal strings at the edge. The `json` helper serialises bigints
to strings, so the proposal and calldata cross the API without a custom serializer. Size is aligned
down and never silently bumped up: an order below one lot is refused, not resized.

**No new dependencies.** The writer is the venue SDK's own `createTrader` / `placePerpOrder` /
`depositMargin`; calldata uses the SDK's exported ABIs plus `viem`. Both were already dependencies.

**One expiry, shared.** `farFutureExpiryNs` is computed once and passed to both the preview calldata
and the live order, so the two cannot drift.

## Routes

- `GET /api/execution` → `{ available, mode, enabled, dryRun, hasKey, maxNotional }`. Config-only, no
  network, no key. `available` is true only on the local transport. The web panel renders only when
  `available`; otherwise it shows the read-only note.
- `POST /api/execute` → on a deployment, `501` before any market read. Locally: same-origin (`403`),
  JSON content-type (`415`), body cap 8192 (`413`/`400`), parse (`400`), then a keyed work lane reads
  the market and runs the executor. `ExecutionRefused` → `403`; a known bad-input message → `400`;
  an unavailable market/venue → `422`. A success is `{ action: "preview", reason, proposal, calls }`
  or `{ action: "send", proposal, hash, depositHash?, orderId? }`.

## Operator guide

1. **Fund a wallet** on Hideki testnet (the Somnia faucet) and note its address.
2. **Configure a gitignored `.env`** (copy `.env.example`):
   ```bash
   EXECUTION_ENABLED=true
   DRY_RUN=false
   PRIVATE_KEY=0x<your-funded-testnet-key>   # never commit, paste, or record this
   EXECUTION_MAX_NOTIONAL=100
   ```
3. **Preview first** (always safe, no key needed):
   ```bash
   pnpm execute --market BTC --side long --size 0.01 --cash 1000
   ```
   This prints the proposal, every gate verdict, and the exact calldata. Nothing is sent.
4. **Send one order**:
   ```bash
   pnpm execute --market BTC --side long --size 0.01 --cash 1000 --live --confirm
   ```
   Both `--live` and `--confirm` are required, on top of the environment opt-in. Or use the local web
   panel (`pnpm dev`): it badges **DRY RUN** or **LIVE · TESTNET**, shows the proposal and calldata,
   and requires the confirm checkbox before a live send. A live order consumes its confirmation — the
   next send needs a fresh tick.
5. **Verify the evidence.** A live send prints the transaction hash (and the deposit hash and order id
   when present). **There is no public block explorer for Hideki.** Verify with
   `eth_getTransactionReceipt` against the testnet RPC (`https://api.hideki2.infra.testnet.somnia.network`),
   not an explorer link. The UI and CLI never render a fabricated explorer URL.

## Testing

- `pnpm test:execute` (`src/execute/*.test.ts`) covers the policy arms, the proposal's exact money and
  grid alignment, the calldata bytes, the executor's preview-vs-send arms, and the request parser.
- `pnpm test:server` covers the capability answer on both transports (never carrying the key), the
  deployment's `501` refusal before any market read, and the local route's malformed-request refusals.
- `pnpm test:web` covers the panel's render guards and the DTO validators.
- `pnpm test:guards` injects the exact bug each execution guard claims to catch and requires the named
  test to go red: a fabricated explorer link, a send without a valid hash, a live arm that ignores the
  opt-in, a hidden binding gate, and a capability that fails open.

All of these are offline (mocked fetch / injected writer); none sends a transaction or needs a key.

## What this is not

- Not a trading bot: one order per request, no strategy loop, no position management.
- Not mainnet: Hideki testnet only, chain 50383.
- Not a forecast or a backtest result: a placed order is a real testnet transaction that the venue can
  still refuse or liquidate.
- Not reachable from the public deployment: it is read-only and holds no credential.