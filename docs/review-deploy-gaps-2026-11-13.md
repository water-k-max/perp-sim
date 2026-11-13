# Gaps in the backtest tool, as deployed — 2026-11-13

A review, not a work order. **Zero code was changed to produce the diagnosis below (G1–G7).** Every
claim there names the instrument that saw it: a `curl` probe against the live alias, the same request
against the local lab transport, an independent SDK read of the indexer, or a quoted line of code.
Where something is a hypothesis rather than a measurement, it is labelled as one.

The **Resolution** section at the end records the fixes subsequently authorised ("For G2, aggregate
across markets. Identify strategy pick a fix for G1") and implemented, with the live and browser
evidence for each. The diagnosis is kept verbatim as the historical record of what was measured before
any code moved.

Trigger: the deployed wallet panel answered `Request failed (HTTP 404).` for
`0x8b6e2b53480dde92b37e03e2810abe7c808594f8` (BTC · USDso, 7 days, 1000 cash) — an address whose
public trader page at `app.testnet.dreamdex.io/trader/…` shows BTC, LINK and WLD closes on Nov 09.

Instruments used:

- **Live alias probes**, `https://perp-sim.vercel.app`, 2026-11-13 ~09:03Z, `curl -w` statuses and headers.
- **Local differential**: `PORT=3456 pnpm dev` (the ambient `PORT=3100` belongs to an unrelated process
  and was left untouched), then the *identical* wallet request against `127.0.0.1:3456`.
- **Independent indexer count**: a scratch SDK script paginating `getUserFillsPage` for the address
  across all pools, window `1793956128`–`1794560928` (Nov 06 09:08:48Z → Nov 13 09:08:48Z), joined to
  symbols through `listPerpMarkets`. Run twice; identical both times.
- **Code**: line references verified by reading the file, not by recall.

---

## G1 — P0 · The product's default action has no route on the deployment

**Measured.** The deployed function answers only paths with exactly one segment after `/api`:

| path | status | who answered |
|---|---|---|
| `/api/chain`, `/api/markets`, `/api/runs`, `/api/backtest`, `/api/resample` | 200 / 501 | the function (our JSON) |
| `/api/zzz` | 404 `{"error":"Not found."}` | the function's own fallthrough ([src/server/app.ts:281](../src/server/app.ts#L281)) |
| `/api/chain/x` | 404 | **the edge**, `X-Vercel-Error: NOT_FOUND` |
| `/api/a/b`, `/api/a/b/c` | 404 | the edge |
| `/api/accounts/<addr>/resample` | 404 | the edge |
| `/api/accounts/<addr>/reconcile` | 404 | the edge |
| `/api/trades/resample` | 404 | the edge |

The edge body is `{"error":{"code":"404","message":"The page could not be found"}}` — a shape that
exists nowhere in this repository, which is how we know the request never reached our code.

**Differential.** The identical wallet request on the local transport: **200 in 8.13 s**, 176 closed
trades, 272 fills reconciled 272/272 with zero mismatches. Same code, same address, same window. The
engine and the data path are fine; the deployment's route table is not.

**Blast radius.** Everything the route table serves at depth ≥ 3 is dead in production: the wallet
panel (the default action since the prominence inversion), its reconcile sibling, and trade-import
resampling. The manual hypothesis backtest is depth 2, so it works — **which is exactly why the
earlier "live and stable" verification passed: it probed only depth-2 routes and therefore never
exercised the product's default action.** That claim was true of the subset it measured and false as
a statement about the product; this document is the correction.

**Mechanism — measured part:** the deployed routing behaves as `/api/<one segment>`, i.e. the
catch-all in [api/[...all].ts](../api/[...all].ts) did not survive as a catch-all. **Hypothesis, not
yet proven:** the `...` marker is lost when the prebuilt Build Output route table is derived from the
bracketed entry name. A local `vercel build` of a minimal scratch project could not settle it
(`BUILD_PROJECT_SETTINGS_REQUIRED` — the CLI wants project settings from the API, and deployment
credentials deliberately do not exist on this machine).

**The one-line confirmation**, to add to the deploy job when a fix is authorised:
`cat .vercel/output/config.json` immediately after `vercel build`. That file is the route table the
edge actually runs; it will show the single-segment pattern directly.

**Fix candidates, in increasing blast radius (decisions, not implemented):**

1. Depth-2 aliases in the route table (`/api/account-resample?account=…`) plus `rewrites` from the
   deep paths — works regardless of how brackets are compiled, keeps one function.
2. Per-route function files for the three deep routes — more entries, same shared handler.
3. A CLI/version change — only if `config.json` proves a CLI regression, and only after reading it.

Whatever is chosen, the regression guard must be a **deployed** probe of a depth-3 path, not a unit
test: [src/server/entry.test.ts](../src/server/entry.test.ts) guards the export shape and passed
through this fault untouched, because the fault is in routing, which no local test can see.

---

## G2 — P0 · One market per wallet run, while the address trades thirteen

**Measured, independently.** In the 7-day window the address has **671 fills across 13 pools**, over
2 indexer pages: BTC 272, ETH 76, HYPE 72, SOL 65, LIT 43, BNB 30, AVAX 29, ZRO 27, VVV 16, LINK 13,
SUI 12, WLD 10, NEAR 6. First fill 2026-11-06T15:43:55Z, last 2026-11-09T09:34:22Z — the Nov 09
10:34:22 local prints on the trader page are this same activity.

The wallet path reads **one pool**: the `market` query param
([src/server/app.ts:232](../src/server/app.ts#L232), [:244](../src/server/app.ts#L244)) becomes a
`pool` predicate on the fills query
([src/verify/replay-account.ts:400](../src/verify/replay-account.ts#L400)) and a hard skip
([:405](../src/verify/replay-account.ts#L405)). With BTC selected, **399 of 671 fills (59.5%) are
discarded before any statistic is computed**, including every LINK and WLD close the trader page
shows.

**The wording gap.** The market filter is visible in the form, so nothing is hidden — but the
headline note overstates its scope: *"Closing fills the chain recorded for this address in the
window"* ([src/web/Wallet.tsx:92](../src/web/Wallet.tsx#L92)). It is the closes of *one market* in the
window. Win rate 11.93%, replayed total −4343.4772 USDso and the 100% bankruptcy rate all describe
the BTC sleeve, not the wallet. There is no cross-market aggregate anywhere in the tool, so the
number a user compares against the trader page's all-market record is not like-for-like even when
G1 is fixed.

---

## G3 — P1 · Wallet economics are gross; funding is never read on this path

- The replayed total is the chain's **gross** realized PnL per closing fill, and the UI says so
  ([src/web/Wallet.tsx:94](../src/web/Wallet.tsx#L94),
  [src/resample/account.ts:58](../src/resample/account.ts#L58)). Honest, but there is no net figure.
- **Fees on this venue are genuinely zero** (indexer probe, same window): the BTC pool's latest
  parameter epoch carries taker/maker `FeeBpsTimes1k = 0`, and `PerpFeeRecord` has 0 rows for this
  address on every pool (the pool does carry `LiquidationFee` rows for others). The reconcile labels
  this `vacuous-zero-rate` ([src/verify/replay-account.ts:280](../src/verify/replay-account.ts#L280))
  so a zero-fee pass cannot be read as evidence of fee accounting. On Hideki, gross ≈ net-of-fees
  today; that is a property of the venue, not of the tool.
- **Funding is not read at all on the wallet path.** `FundingPayment` exists (indexer probe: 3 BTC
  rows all-time, 0 in this window; 5 in-window rows on other pools), and `getFundingPayments` is
  available, but nothing in `replay-account.ts` calls it. For a wallet that holds positions across
  funding intervals, the gross figure omits a real cost leg. This is the same ledger work tasks
  #31–#33 own.
- The trader page's PnL column basis is unknown (realized-only? net of funding?). Until it is
  established, tool-vs-venue comparisons are apples to oranges in both directions.

---

## G4 — P1 · The failure text blames the user's inputs for a platform fault

[src/web/Wallet.tsx:61](../src/web/Wallet.tsx#L61) reads `payload.error` only when it is a **string**.
The edge's 404 carries an object, so it is discarded and the user sees
`Request failed (HTTP 404).` — and the shared hint says *"Adjust the inputs and run again."*
([src/web/dto.ts:115](../src/web/dto.ts#L115)). For G1 the inputs were valid; the message misdirects
the only person who could act on it. The same fallback cannot distinguish "the platform has no route"
from "the app has no saved run", which are different failures with different owners.

---

## G5 — P2 · Ceilings that would bind on a busier wallet — disclosed, none binding here

- `maxFills` default 2 000 ([replay-account.ts:152](../src/verify/replay-account.ts#L152), slice at
  [:425](../src/verify/replay-account.ts#L425)); page limit 500 with a page bound
  ([:392-393](../src/verify/replay-account.ts#L392)); fee read capped at 1 000 rows with **no offset
  paging**, warned when reached ([:181](../src/verify/replay-account.ts#L181),
  [:184](../src/verify/replay-account.ts#L184)); indexer count ceiling 10 000
  ([:125](../src/verify/replay-account.ts#L125)); wallet window capped at 30 days
  ([app.ts:233](../src/server/app.ts#L233)) while the manual backtest accepts 90.
- At 272 fills / 7 days **none of these bind** (`pages: 1`, `truncated: false`).
- Truncation is *not* hidden when it happens: the coverage wording distinguishes "stopped early"
  from "ran to the end of the cursor" and names the ceiling
  ([src/verify/fill-coverage.ts:88-96](../src/verify/fill-coverage.ts#L88)). The residual gap is only
  that a >2 000-fill wallet's headline stats rest on a slice whose existence lives in the coverage
  note rather than beside the totals.

---

## G6 — P2 · What the deployment refuses by policy (intentional, listed for completeness)

`GET /api/runs` and `POST /api/resample` answer 501 with their documented sentences: the run store is
local-disk by policy and `/tmp` does not outlive an instance. Not a gap to fix silently; a product
decision already disclosed in [docs/deployment-vercel.md](deployment-vercel.md) §3.

## G7 — P2 · Bankruptcy is measured against an assumed balance, never the wallet's real one

At the default 1000 USDso cash, every shuffle and bootstrap path busts (bankruptcy rate 1.000; block
bootstrap 0.998) because the BTC sleeve's gross realized total is −4343.48. That is a real answer to
the question asked, and the field help discloses the assumption. The tool never reads the account's
actual collateral balance (the trader page's Balances tab has it), so "bankruptcy rate" cannot say
whether this wallet *actually* busted — only whether it would have at the assumed cash.

---

## What is not a gap (verified working today)

- Reconcile integrity on the live read: 272/272 position changes matched, 0 mismatches, 0 unmatched.
- Coverage honesty: `rowsScanned/pages/truncated/stoppedBy/accountFillsAtCeiling` all present and
  worded correctly, including the empty-window case (200 with `distributions: []` and a "No fills"
  stamp, not an error).
- Deterministic replay and the depth-2 API surface on the deployment (see
  [docs/deployment-vercel.md](deployment-vercel.md) §9, including three byte-identical backtests).
- The local transport serves every route, deep ones included — G1 is deployment-only.

## Suggested order, for decision

1. **G1** — confirm with `config.json`, then pick a fix; add a deployed depth-3 probe to CI so this
   class of fault cannot pass a green pipeline again.
2. **G2** — decide whether the wallet panel aggregates across markets or keeps one sleeve and says
   so in every headline note; the second is cheaper and honest, the first is the product the trader
   page implies.
3. **G4** — surface object-shaped and edge errors verbatim; stop hinting "adjust the inputs" for
   failures the inputs did not cause.
4. **G3** — read funding on the wallet path and publish a net figure beside the gross one (tasks
   #31–#33).
5. G5/G7 — wording and optional balance read; neither changes a number today.

---

## Resolution — 2026-11-13 (authorised, implemented, verified)

The diagnosis above was a review with no code moved. The user then authorised three things: aggregate
G2 across markets, identify the wallet's strategy, and pick a fix for G1. All three are done. This
section records what shipped and the instrument that proved each claim.

### G1 — fix chosen: option 2, per-route function files (implemented)

Of the three candidates, **option 2** was chosen: each deep route gets its own thin function file that
re-exports one shared handler, [src/server/serverless-entry.ts](../src/server/serverless-entry.ts).
Option 1 (depth-2 aliases + `rewrites`) was rejected because it keeps the deep paths dependent on the
catch-all surviving bracket compilation — the exact mechanism G1 measured as broken. A literal
bracketed file name compiles to its own literal route in the Build Output table, so depth ≥ 3 no longer
rests on the catch-all at all.

New entries, each a Web-handler re-export of the shared handler:

- [api/accounts/[account]/resample.ts](../api/accounts/[account]/resample.ts) — the wallet panel's default action.
- [api/accounts/[account]/reconcile.ts](../api/accounts/[account]/reconcile.ts) — its reconcile sibling.
- [api/trades/resample.ts](../api/trades/resample.ts) — trade-import resampling.
- [api/runs/[id].ts](../api/runs/[id].ts) — saved-run read.
- [api/[...all].ts](../api/[...all].ts) — kept for the depth-2 surface.

One route table ([src/server/app.ts](../src/server/app.ts)) still sits behind both transports; the five
files are entry points, not five copies of the logic. [src/server/entry.test.ts](../src/server/entry.test.ts)
guards that all five export the `{ fetch }` Web-handler shape (a bare default fn is the legacy
`(req,res)` shape whose returned Response the runtime discards — the earlier hang).

**CI guards added** ([.github/workflows/ci.yml](../.github/workflows/ci.yml), deploy job):

1. `cat .vercel/output/config.json` right after `vercel build` — the one-line confirmation G1 asked for;
   it dumps the route table the edge actually runs.
2. A **deployed** probe of a depth-4 and a depth-3 path, both answered before any chain read, both
   expecting an app `400` (parameter/address refusal) and **not** the edge `404`. This is the regression
   guard G1 insisted on: a unit test cannot see routing, so the guard runs against the live alias.

### Deployed verification (2026-11-13, production alias)

The first CI run of the fix (`43409446553`) built and deployed green, but the new probe step failed: it
curled the **per-deployment URL** (`perp-5xb1iqcl6-…vercel.app`), which sits behind Vercel Authentication
and answers `302` to an unauthenticated request, so the probe never reached the app. The deployment
itself was fine. The probe was corrected to target the **public production alias**
`https://perp-sim.vercel.app`, which `vercel deploy --prod` assigns to the new deployment, with a short
retry for edge propagation. Re-run locally against the alias before pushing: both probes return app
`400` on the first attempt, exit 0.

**The route table** (`cat .vercel/output/config.json`, deploy job) confirms the mechanism — each
bracketed file compiled to its own literal route with a dynamic `([^/]+)` segment:

- `^/api/accounts/([^/]+)/(resample/|resample|resample\.ts)$` → `/api/accounts/[account]/resample`
- `^/api/accounts/([^/]+)/(reconcile/|reconcile|reconcile\.ts)$` → `/api/accounts/[account]/reconcile`
- `^/api/runs/([^/]+)$` → `/api/runs/[id]`
- `^/api/([^/]+)$` → `/api/[...all]` (the catch-all, now only depth-2)

`api/trades/resample.ts` is a static path, so it is served from the function manifest rather than the
`routes` array; probed live, `POST /api/trades/resample` reaches the handler (app `400`).

**Live probes against the alias** (all reach the handler, none edge-404):

| path | status | meaning |
|---|---|---|
| `GET /api/accounts/0x000…0/resample?paths=5` | 400 | depth-4 wallet route reached the app (was edge 404) |
| `GET /api/accounts/not-an-address/reconcile` | 400 | depth-3 reconcile reached the app |
| `POST /api/trades/resample` `{}` | 400 | depth-3 trade import reached the app |
| `GET /api/runs/xyz` | 501 | depth-3 run read reached the app (local-disk policy) |
| `GET /api/chain` | 200 | depth-2 catch-all still works |

**The product's default action, end to end on production:**
`GET https://perp-sim.vercel.app/api/accounts/0x8b6e…94f8/resample?market=ALL&days=7&paths=1000&cash=1000`
→ **HTTP 200 in 17.2 s**, byte-identical to the local read: `marketsRead 40`, `marketsWithFills 13`,
`closedTrades 417`, `realizedTotal "20868.461459000000062130"`, `fillsRead 671`, `changesReconciled 671`,
`reconcileOk true`, 13 breakdown rows with BTC `-4343.477192000000000034`. The route that returned
`Request failed (HTTP 404)` in the trigger screenshot now serves the cross-market aggregate.

**CI green, guard included** (`43410709046`, commit `56f4c5f`, 2026-11-13 ~10:42Z): all three jobs
passed — offline gate 1m41s, live read-only chain check 25s, vercel deploy 1m20s. The deploy aliased
`perp-262n67tf5-…vercel.app` → `https://perp-sim.vercel.app` (`▲ Aliased` in the deploy log), and the
**probe step itself** then returned app `400` on the first attempt for both deep routes
(`resample?paths=5` → `{"error":"paths must be a whole number from 100 to 5000."}`;
`not-an-address/reconcile` → `{"error":"A 0x-prefixed 20-byte account address is required."}`). The G1
regression guard now passes *inside CI*, not only in the local pre-push check.

**Deployed UI, driven end to end in the browser** (production alias, not localhost): filled
`0x8b6e…94f8`, left "All markets", set Window 7 days / cash 1000, clicked Resample. The accessibility
snapshot shows the integrity banner ("Reconcile passed **across all markets**: 671 changes across 671
fills, no disagreements"), the full-window coverage note (671 fills across 13 pages, 2026-11-06 15:43 →
2026-11-09 09:34 UTC), the **Per-market breakdown** table with all 13 ranked rows (ZRO +14,330.049 …
BTC −4,343.477), closed trades 417, win rate 28.8%, replayed total **20,868.461459000000062130**,
bankruptcy 0.2% — every value matching the curl read. The panel that showed `Request failed (HTTP 404)`
in the trigger screenshot now renders the cross-market aggregate on the live site. *Same limitation as
the local run:* the pixel screenshot was blocked (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`), so styling was
not eyeballed; the structural snapshot is the evidence.

### G2 — implemented: cross-market aggregation

`replayAccountAllMarkets` ([src/verify/replay-account-all.ts](../src/verify/replay-account-all.ts)) fans
the verified `reconcileAccount` out across every listed pool (concurrency 4; a 60 s TTL cache on the
deployment), then a **pure** `combineMarketReports` does the quote-unit guard, the chronological row
merge, the coverage/integrity summation, and a per-market breakdown ranked by gross realized descending.
The route is `market=ALL`; the UI defaults to "All markets" and renders the breakdown table with
scope-named headline notes. The single-market path is unchanged.

**Live ALL read** (local transport, `days=7&paths=100`, 2026-11-13): HTTP **200 in 38.9 s**,
`marketsRead 40`, `marketsWithFills 13`, `closedTrades 417`, `winRateBps 2878`,
`realizedTotal "20868.461459000000062130"`, `fillsRead 671`, `changesReconciled 671`, `reconcileOk true`,
0 mismatches / 0 unmatched. Breakdown, largest gross realized first: ZRO +14330.049 (18 closes, 100%),
LIT +8335.54 (41, 100%), VVV +2030.298 (15, 100%), SOL +1362.57 (44, 45.5%), HYPE +286.84 (31, 9.7%),
NEAR −10.12, SUI −39.39, WLD −57.68, BNB −75.60, LINK −123.95, AVAX −257.82, ETH −568.78 (43, 4.7%),
BTC −4343.477 (176, 11.9%).

**Four aggregation invariants, all true** (asserted against the live payload, not assumed):

1. The BTC breakdown row is byte-identical to the single-market BTC total (`-4343.477192000000000034`).
2. `sum(breakdown realizedTotal) === ALL total` to the raw bigint (`20868461459000000062130`).
3. `sum(breakdown closedTrades) === 417`.
4. `sum(breakdown fills) === 671`.

The BTC sleeve alone (−4343) **inverts the sign** of the whole account (+20868): aggregation is not a
convenience, it is the difference between "this wallet loses" and "this wallet earns". 13 unit tests in
[src/verify/replay-account-all.test.ts](../src/verify/replay-account-all.test.ts) cover the merge, the
quote guard (refuses mixed `quoteSymbol`/`quoteDecimals` among markets *with fills*), coverage
combination, ranking and the empty cases.

**Browser verification** (localhost:3456, the new panel): filled the address, set "All markets" / 7 days
/ 1000 cash, ran it. The accessibility snapshot shows the integrity banner ("Reconcile passed **across
all markets**: 671 changes across 671 fills"), the coverage note, the **Per-market breakdown** table with
all 13 ranked rows and every value matching the API read, the scope-named closed-trades/win-rate/total
notes, and the fan chart + histogram over 1000 paths. The win-rate note carries the scale-out caveat.
*Limitation, stated honestly:* the pixel screenshot was blocked (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`,
the in-app browser surface was hidden), so the visual styling was not eyeballed; the structural snapshot
is the evidence that the table renders with the right content.

### Strategy of the analysed wallet (task #43, identified)

`0x8b6e2b53480dde92b37e03e2810abe7c808594f8` is **automated ask-side premium harvesting** — wide passive
asks lifted by naive takers, then an identical-size taker cover — plus a spread-paying IOC overlay. It is
**not** two-sided market making, latency arbitrage, momentum, liquidation sniping, or manual trading.
671 fills across 13 pools, 96% taker, 73% against one MM counterparty (`0x47537e3a…`), median hold 109 s,
ends flat; +20,868.46 gross over 417 closes at a 28.8% win rate.

Deciders: on ZRO/LIT/VVV the ask quantity equals the cover quantity exactly (45,075.2 / 14,392.4 /
661.44), ask VWAP sits over cover VWAP by +2005 / +1909 / +1512 bps, and all 74 such closes win; the
bands are fixed machine constants (sell limit / avgFill ≈ 0.988, buy ≈ R×1.02). The 16 identical-size IOC
round trips are all losers (−803.47) — the spread-paying overlay. Falsifiers checked and absent: asks at
mid with high maker share, covers preceding asks, profitable same-size round trips, liquidation/funding-
driven wins (0 liquidation rows, funding −0.85), hours-long holds.

**Honest scope:** this is gross, on a zero-fee testnet, against a dominant MM counterparty. It is a
description of what the address did, **not** evidence of a mainnet-viable edge. Evidence:
`C:\Users\USER\AppData\Local\Temp\perpsim-verify\strategy-8b6e\` (fills, changes, orders, trade contexts).

### Still open (not authorised by this round)

G3 (funding leg / net figure), G4 (verbatim edge-error surfacing), G5/G7 (ceiling wording, real balance)
remain as diagnosed. Tasks #31–#33 own the funding/fee ledger work.