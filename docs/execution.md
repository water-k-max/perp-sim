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
| `src/execute/collateral.ts` | reads the MarginBank's authoritative collateral token (`getPerpSystemConfig`) so the preview's approve names the same token the live writer resolves; the SDK's deployment-address constant is stale on Hideki (tUSDC 6dp vs the USDso 18dp the bank pulls) |
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

## First live placement (evidence)

On **2026-11-14** the lab placed one real perp order on Somnia Hideki/Tokyo testnet (chain **50383**),
end to end through the bounded path above (local CLI, `EXECUTION_ENABLED=true`, `DRY_RUN=false`,
`--live --confirm`, notional under the `100` cap). This is the evidence for MVP requirement (a).

- **Market:** BTC/USDso, pool `0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0`, MarginBank `0x478769e1177c0773c43a593dccc4ad15f15f1394`.
- **Trader:** `0xc89f615F49427FF8Bc6bf6dd0aB127097AEc4483` (the operator's funded testnet wallet; the key never leaves the local process).
- **Order:** long **0.001 BTC**, limit at the mark-aligned price **67063.0 USDso**, notional **67.063 USDso**, initial-margin lock **1.676575 USDso**. All seven pre-trade gates passed; `under cap = true`, `PLACEABLE`.
- **Funding:** 100 USDso approved + deposited into the MarginBank first (the bank's authoritative collateral token is USDso `0xed7993A74dAe1e6656B704A424DcD8711aAf4F72`, 18dp — read via `getPerpSystemConfig`, not the stale deployment constant).

| step | transaction | block | status |
| --- | --- | --- | --- |
| approve + deposit 100 USDso | `0xff8c2cbba1d8ad238408059d380a3695ba948278636f0b209c68fc65122920d1` | `0x2fbd9bf` | `0x1` (success) |
| placeOrder (long 0.001 BTC) | `0xfec34e97ff08727d303ecd852dd367b22b0a6fa4f3dca19ac653a6eecfe5648d` | `0x2fbd9c6` | `0x1` (success) |

- **Order id:** `21564243822166477948182`. The placement receipt carries the pool's `OrderPlaced` event (`isBid=1`, `quantity=100000` raw = 0.001 BTC at 8dp, owner = trader) and the bank's collateral-lock event for `1676575000000000000` raw = 1.676575 USDso.
- **Resulting margin account** (read back from the bank after the send): wallet **400 USDso** (500 − 100 deposited), bank **unlocked 98.323425**, **locked 1.676575**, collateral basis **100**, `activePerpPools = [0x4181dd08…94c0]` — the account now holds a live BTC perp position.

**Re-verify** (no explorer exists for Hideki): `eth_getTransactionReceipt` for each hash against
`https://api.hideki2.infra.testnet.somnia.network` returns `status: "0x1"` with the events above.

**Honest scope.** This is a *placed* limit order resting at the mark-aligned price — placement is what
requirement (a) asks for. The placement tx carries no fill event; whether the order matches is the
venue's book, not a claim made here. It is testnet only, one order, no strategy loop, and no profit is
asserted.

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