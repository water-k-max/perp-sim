# Coverage review: what is genuinely validated, and whether real-address trade lookup is usable

Date: 2026-11-09. Review only — **zero production code changed**. Every claim below is either a
file:line reference in this repo or the output of a read-only probe run against the live public
indexers today. Probe sources are kept in `probe/` (outside `src/` and `public/`, so they do not
touch the code identity stamped into each run manifest); they issue public indexer reads only —
no signer, no keys, no chain writes.

---

## Part A — What has genuinely been covered, and what has not

### A.1 "Monte Carlo" is a trade-order resampler, not a price-path simulator

This is the single most important thing to say plainly, because the word is used loosely in the UI
and would be used more loosely still in a pitch.

Every one of the three distribution modes replays **the same set of already-realised per-trade
PnLs** in a different order or a different subset:

| mode | what is randomised | what is held fixed |
|---|---|---|
| `shuffle_without_replacement` | the order of the recorded trades | the trades themselves, their sizes, their PnLs, their prices |
| `bootstrap_with_replacement` | which trades appear, and how often | the same |
| `block_bootstrap_with_replacement` | which contiguous blocks of trades appear | the same |

There is **no stochastic price process anywhere in the repo**. No GBM, no jump diffusion, no
historical simulation of *market* paths, no bootstrap of funding rates, no slippage distribution,
no volatility-of-volatility, no liquidation-cascade simulation. A path in this tool is a permutation
of a realised outcome list, walked arithmetically
([src/resample/path.ts](../src/resample/path.ts)).

Two consequences that a reviewer or a judge will find immediately:

1. **Order-only risk is exactly what the shuffle mode measures, and it is provably zero for a static
   size.** The live run today returned all 1,000 shuffle finals at the identical value
   `999.996191` from `1000` starting cash and three recorded closes. That is arithmetic, not luck:
   addition is commutative, so with fixed absolute PnLs the final equity is order-invariant and
   every percentile collapses onto one number. The UI says so — the `ShuffleNote` gate renders on
   `mode === "shuffle_without_replacement"` — but the panel headline is still "distribution", and a
   glance at a flat ladder invites exactly the wrong reading.
2. **Anything that *would* change under market uncertainty is not modelled at all.** Whether the
   position would have been liquidated on a path it did not actually take, whether funding would
   have been the same, whether the entry would have filled at that price under different book
   depth — none of it is in scope. The C4 absorbing barrier
   ([src/resample/path.ts](../src/resample/path.ts), `bankruptcy is absorbing`) stops a walk at
   zero equity, but only along orderings of realised PnLs; it cannot discover a ruin the recorded
   sequence did not contain.

The two places the tool *does* re-price against market history are narrower than "Monte Carlo" and
worth naming precisely: the random-entry null
([src/resample/edge.ts:73-93](../src/resample/edge.ts)) re-prices the same sides, sizes and holding
times at *different historical settlement bars*, and out-of-sample
([src/resample/oos.ts](../src/resample/oos.ts)) re-runs the engine on a chronologically disjoint
tail. Both are real and both are honest; neither is a price-path simulation.

### A.2 What is statistically validated (measured)

The plumbing is genuinely well tested. `src/resample/` ships 12 test files, and the checks that
exist are the right kind:

- **The RNG is pinned against reference implementations, not against itself**: `splitmix64 matches
  the reference first outputs`, `xoshiro256** matches the reference implementation`
  ([src/resample/rng.test.ts:5,13](../src/resample/rng.test.ts)). Stream independence, bounds and
  replayability are covered too (`rng.test.ts:24,33,43`).
- **Determinism is asserted at every layer**: byte-for-byte edge block under the same inputs and
  seed (`edge.test.ts:131`), bit-identical path sets (`path.test.ts:83`), and an invariant that
  fails if a tampered final equity changes the answer (`invariants.test.ts:68`).
- **No-look-ahead is enforced structurally and checked**: moving a held `seq` into the fit half
  breaks `oos-no-lookahead` ([src/resample/invariants.test.ts:76](../src/resample/invariants.test.ts)).
- **The quantile convention is pinned at the endpoints and monotone between them**
  (`stats.test.ts:29-36`) — linear interpolation on `q·(n−1)`
  ([src/resample/stats.ts:62-71](../src/resample/stats.ts)).
- **One real coverage assertion exists**: the out-of-sample boundary is checked to be crossed by
  between 2% and 5% of the *fit* paths
  ([src/resample/oos.test.ts:36-39](../src/resample/oos.test.ts)).
- **The engine's own accounting is pinned** — the null trade is asserted to be exactly the engine's
  round trip (kernel funding, floored gross, closing-leg fee) at `edge.test.ts:50`.

### A.3 What is not validated (the actual gaps)

Ranked by how much they change what you can claim out loud.

1. **No calibration against a generating process.** Nothing anywhere tests that the estimator is
   *correct*, as opposed to reproducible. The missing tests are the standard ones: simulate a known
   process (an i.i.d. or Markov PnL series with a known ruin probability and known tails), run the
   resampler 200 times, and check that the nominal 5% quantile is breached about 5% of the time and
   that the p-value distribution is uniform under a true null. The `oos.test.ts` exceedance check
   (A.2) is *self-consistency on the fit distribution* — a p95 of a sample is crossed by ~5% of that
   same sample almost by construction; it is not out-of-sample calibration and it does not validate
   the interpolation against anything external.
2. **The ruin probability is never compared to the analytic answer.** For a biased random walk on
   equity there is a closed form. `bankruptcyRate` is reported
   ([src/resample/stats.ts:127-128](../src/resample/stats.ts)) and never checked against it. Today's
   live run reported `0.000` in all three modes, which is also a case of a gate won by emptiness —
   nothing in the repo proves the counter can count.
3. **The fee leg is vacuous on the only network this tool reads.** Measured today across all 22 live
   Hideki perp markets: `taker=0 maker=0` bps×1k for every symbol
   (`probe/fee-sweep.mts`), the values taken straight from the on-chain parameter epoch
   ([src/data/params.ts:18-19,51-52](../src/data/params.ts)), not hardcoded. `listPerpFees` returned
   **0 rows** for the busiest accounts on both Hideki and Tokyo. Consequently: the "Fees" metric card
   reports a structurally zero number, and `reconcileAccount`'s fee comparison
   ([src/verify/replay-account.ts:157](../src/verify/replay-account.ts)) passes as `0 == 0`. It is
   `ok: true` today for the same reason — the fee path has never been exercised against a non-zero
   fee. Any claim about realistic cost modelling must be dropped until it runs somewhere fees exist
   (or against a fixture with a forced non-zero rate).
   **Corrected by re-measurement, and fixed.** The `0 rows` reading was an artifact of filtering by
   account+pool: unfiltered, `listPerpFees({limit:200})` returns 200 rows, **171 of them non-zero**,
   spread over 19 of the 22 perp pools (`probe/perp-fee-rows.mts`) — and every one of them is a
   `LiquidationFee` or `LiquidationFeeSkipped` record, not a fill fee. So the venue really does charge
   nothing per fill, and the fee stream is not empty: the two facts were conflated. That made the gap
   worse than "vacuous" — summing all rails against recomputed fill fees meant a liquidated account's
   `actual` was a penalty total (measured `95284492030000000000` raw) against `expected=0`, so a
   perfectly reconciling account could read `ok:false`. Fixed in `replay-account.ts`: `feeRail()`
   classifies `Fee`/`Rebate`/`BuilderFee` as the trade rail (compared), `LiquidationFee`/
   `LiquidationFeeSkipped` as their own rail (reported, never compared) and an unknown kind fails the
   report closed; `fees.leg` labels `vacuous-zero-rate` when both rates are 0, no trade rows exist and
   the recomputed total is 0, and prints the warning that says the pass proves nothing. Four new tests
   in `replay-account.test.ts` cover the informative case (a doubled fee record now breaks `ok`), the
   vacuous label, liquidation isolation and the fail-closed path; mutating either the rail set or the
   label flips its test. Live evidence after the change: `probe/liquidation-reconcile.mts` over two
   liquidated accounts — `fills=15 changes=15 mismatches=0`, `expected=0 actual=0` with
   `leg=vacuous-zero-rate`, and `824505007534266267961` raw on the liquidation rail. 39 of the 40
   newest liquidation rows sit on listed perp markets, so this is reachable data, not a corner.
   **What is still not proved:** no live venue charges a fill fee, so the fill-fee arithmetic is only
   ever exercised against a fixture. The SDK's own note that "no `LiquidationFee` rows exist yet" is
   stale against the deployed Hideki indexer, and `LiquidationFeeSkipped` is not in its documented
   kind list at all.
4. **The edge-null verdict copy is wrong at one end.** The p-value is defined as the share of null
   totals **at or above** the recorded total, add-one corrected
   ([src/resample/edge.ts:120-121](../src/resample/edge.ts)), so its ceiling is not benign: an
   entry record worse than *every* random-timing path gives `p = 301/301 = 1.0000`. The UI ladder is
   `p < 0.05 → UNLIKELY TO BE LUCK`, `p < 0.2 → WEAK SEPARATION`, else
   `CONSISTENT WITH LUCK` ([src/web/Resample.tsx:102-103](../src/web/Resample.tsx)). "Consistent with
   luck" is the label for `p = 1.0000`, which is the *opposite* — it is evidence of systematically bad
   timing. The module docstring is careful and correct; the three-line label is not. (The module's own
   tests do pin both extremes — `edge.test.ts:108` and `:115` — so this is presentation, not maths.)
5. **300 null paths, and it shows.** `EDGE_PATHS = 300`
   ([src/resample/edge.ts:28](../src/resample/edge.ts)) puts the resolution floor at 1/301 ≈ 0.0033
   and the coarsest achievable "not significant" band at 0.2. Fine as a screen, not fine enough to
   quote as a number; there is no note saying so, unlike the <5,000-path tail note.
6. **No CI check runs against real chain data.** `src/verify/replay-account.test.ts` builds a
   `fakeClient` (`:31+`) that mimics the SDK's 1,000-fill rejection, and a grep for `fetch(`/`hideki`/
   `smk.somnia` across every `*.test.ts` returns nothing. The ground-truth reconciler — the most
   valuable object in this repo — has never been gated against the chain. **It did pass live today**,
   manually, and I have the numbers (A.4) — but "passed once, by hand, today" is not a gate.
7. **`/api/forward` is orphaned.** It is registered at
   [src/bin/web.ts:158](../src/bin/web.ts) and appears nowhere else in the repository; there is no
   caller in `src/web/`. The forward-test code and its tests exist, but the product never runs it, so
   the one feature that would answer "does the model still hold after you pressed the button" is dark
   to every user of the UI.
8. **UI has no automated coverage.** `src/web/` contains two test files, `dto.test.ts` and
   `fan.test.ts`. Every design change from this sprint — the failure banner, the sticky chart,
   contrast, hit targets, the cursor readout, the Stat notes — is verified by hand in the browser,
   which is how I verified it, but is not regression protection.
9. **The whole app serialises behind one lock.** `SingleFlight` guards `/api/backtest`,
   `/api/resample`, `/api/trades/resample`, `/api/forward`, and both account endpoints
   ([src/bin/web.ts](../src/bin/web.ts)). A 44-second run observed earlier in this session blocks
   every other request, with no queue, no position, no progress stream and no cancel. For a demo that
   is a stall; for a tool two people are using at once it is a hang.
10. **C5's horizon is one mark wide by construction.** Settlement is hourly
    (`fundingIntervalSec 3600`, measured on the live config), and the markout is the *first settlement
    bar at or after `t + 1 h`* ([src/resample/analysis.ts](../src/resample/analysis.ts)), so "1 h
    markout" ≈ "next bar", and there is no 5-minute/1-hour/1-day curve to say whether the edge decays
    or persists.
11. **Sample sizes in the real-address path are tiny, and nothing in the UI prepares you.** Today's
    live BTC window gave 6 fills → 3 closes for a genuinely active account. The wallet panel warns at
    fewer than 30 closed trades — correctly — but the *reason* it will usually warn is worth knowing:
    bot-scale accounts hit `countUserFills`' hard `10000` cap (measured), and `reconcileAccount`
    stops at `maxFills = 2_000` and 40 pages
    ([src/verify/replay-account.ts:62,204-217](../src/verify/replay-account.ts)), so the accounts with
    the most data are the ones truncated hardest, while the human-scale accounts have too few closes
    to distribute.

### A.4 What genuinely *is* proven, live, today

So the gaps above sit against real credit, here is the live read-only run on a real third-party
testnet trader (`0xe10d7593…`, chosen by a public tape scan, never authenticated, no keys):

```
/api/accounts/0xe10d7593…/reconcile?market=BTC&days=7   → http 200 in 6.25 s
  fills 6 · changes 6 · unmatched 0 · mismatches 0 · ok true · warnings []
  kinds {OPEN:3, CLOSE:3} · realised (raw) -3809000000000000
/api/accounts/0xe10d7593…/resample?market=BTC&days=14&paths=1000&cash=1000 → http 200 in 5.36 s
  closedTrades 3 · openingFills 3 · winRateBps 0 · realised -0.003809
  shuffle  p05 … p95 all 999.996191            (order-invariant, as designed)
  bootstrap p05 999.995775 → p95 999.996607 · cvar95 999.995545
  block    p05 999.995775 → p95 999.996607 · cvar95 999.995775
  warnings: gross-PnL note · not-a-forecast note · "Only 3 closed trades" note
```

That is the accounting ground truth holding on real chain data with zero diffs, and it is the strongest
true claim available: *the simulator's arithmetic agrees with the chain's own records on a live
account.* Two honest qualifiers ride with it — the fee leg was `0 vs 0` (A.3.3), and three closes is
not a distribution.

---

## Part B — Real address lookup: what actually exists, measured today

You asked whether address-level lookup of real dreamDEX perps trades is usable through the SDK or an
API, without going through Somnia Tokyo. The answer is a map, and the map has one sharp corner:
**there is nowhere else to get perps trades from today.**

### B.1 The endpoint/chain map (probed 2026-11-09, all reads public and unauthenticated)

The SDK refuses an indexer whose `IndexedChains` does not include the configured chain, and its error
prints the truth — that is how these pairings were established rather than assumed:

| indexer | chain | PERP fills indexed | perp markets | volume observed in one page |
|---|---|---|---|---|
| `hideki-dev.smk.somnia.host` | **50383** (current) | yes — newest 2026-11-09T20:27:12Z, block 46,020,052 | 22 | 500 fills in ~9 minutes; 8 counterparties |
| `tokyo-prd.smk.somnia.host` | **50321** | yes — newest 2026-11-09T15:20:55Z, block 9,415,275 | 16 | 17 fills across 60,000 blocks; 4 counterparties |
| `prd.smk.somnia.host` | **5031** (Somnia mainnet) | **`getLatestFillBlock(PERP)` → null** | **0** | no perps at all |
| `dev.smk.somnia.host` | **50312** (Somnia testnet) | yes — newest 2026-11-09T07:58:03Z | 24 | 1 fill across 60,000 blocks |
| `hideki-prd.smk.somnia.host` | — | host does not resolve (`fetch failed`) | — | — |

Two facts fall out of this table, and they matter more than any integration choice:

- **Somnia mainnet (5031) has no perpetuals deployed.** That is not an indexing gap:
  `SOMNIA_MAINNET_ADDRESSES` in the installed SDK has no `marginBank` and no `perpPoolFactory`, while
  the testnet and Hideki sets both do ([node_modules/…/addresses.js:36-56](../../node_modules/@somnia-chain/markets-sdk/dist/addresses.js)).
  So a "real trades on dreamDEX perps, on mainnet" integration cannot be built today, by anyone.
- **The only endpoint with meaningful perp flow is Hideki 50383 — the one perp-sim already uses** — and
  its flow is machine-scale: 500 fills in nine minutes across eight counterparties, seven accounts at
  the `countUserFills` ceiling of 10,000. The production-grade perps net (Tokyo 50321) is thin: 17
  fills per 60,000 blocks. Choosing "not Somnia Tokyo" therefore buys volume that is bot-generated and
  fees that are switched off, and choosing Tokyo buys a real market with almost no prints.

So the useful framing for the hackathon is not *which network* but *which kind of truth*: Hideki gives
a high-activity venue to validate accounting against, and the SDK makes it a two-line config change to
switch.

### B.2 The lookup already works — it is the same call path `reconcileAccount` uses

Address-scoped perps lookup does not need to be built. It is already in the repo at
[src/verify/replay-account.ts](../src/verify/replay-account.ts), and today I confirmed the wider
surface around it by calling each method directly against both live endpoints:

| SDK call | line in perp-sim | Hideki 50383 | Tokyo 50321 |
|---|---|---|---|
| `getUserFillsPage(acct,{marketType:'PERP',pool,since,until,limit:500,cursor})` | `:193` | OK — 500 rows, cursor present | OK — 14 rows, cursor null |
| `listPerpPositionChangesForFills(acct,fills)` | `:73` | OK — **25/25** fills matched | OK — **25/25** matched |
| `listPerpPositionChanges({account,pool,limit})` | — | OK — 20 rows | OK — 14 rows |
| `listPerpFees({account,pool})` | `:79` | OK — **0 rows**, and that filter is the reason A.3.3 read the stream as empty | OK — 14 rows of fills, 0 fee rows |
| `listPerpFees({limit:200})` unfiltered | — | **200 rows, 171 non-zero**, all `LiquidationFee`/`LiquidationFeeSkipped`, over 19 pools | not re-run |
| `listPerpOrderHistory(acct,{pool,limit})` | — | OK — 20 rows | OK — 4 rows |
| `listPerpPositions(acct,{limit})` | — | OK — 16 open positions | OK — 1 |
| `countUserFills(acct,{marketType:'PERP'})` | — | OK — 10,000 (cap) | OK — 14 |
| `getTradeContext(fillId)` | — | OK — `fill, market, makerOrder, takerOrder, siblings, protocolFees, builderFees` | OK — same |
| `getFundingPayments` / `getMarginEvents` | — | exist; take `(account, opts)` positionally (`somniaMarketsClient.d.ts:2508,2534`) — my object call was wrong, not the SDK | same |

`getTradeContext` returns the maker and taker *orders* and the sibling fills of the same order, which
makes it the right read for order-level forensics. It is **not** a route to perp cost data, and the
paragraph I wrote here earlier claimed it was: measured over the four busiest perp pools
(`probe/perp-fee-sources.mts`), `protocolFees` and `builderFees` came back **0 rows for every fill**,
which is what the SDK type documents — "Protocol fees charged in the same transaction. BINARY only".
The unfiltered `listProtocolFees` stream does have rows (25 newest, 11 distinct pools) but none of them
sit on a perp pool and every `amount` is `0`; `listBuilderFees` and `listSettlementFees` are 0 rows.
The perp cost rail that does exist is `listPerpFees`, and on this venue it carries liquidation
penalties rather than fill fees — see the corrected A.3.3.

### B.3 dreamDEX's own REST API — measured, and it does not answer this question

Probing `api.dreamdex.io/v0` today:

```
GET /v0/markets                  200  {"markets":[{"base":"0x28f3…","baseDecimals":18,"contract":"0x035De…"}]}
GET /v0/trades?limit=5           401  {"name":"unauthorized","description":"authentication required"}
GET /v0/orders                   401  {"name":"unauthorized","description":"authentication required"}
GET /v0/perps/markets            404  404 page not found
GET /v0/perp/markets             404
GET /v0/fills                    404
GET /v0/analytics/perps          404
GET /openapi.json  /v0/docs      404
```

So: a public API exists and versioned; **trades and orders exist behind an API key**; and there is no
perps route at all. Two independent reasons that path does not solve the ask — the auth endpoints are
scopically *your own* account (which is the wallet-connector story perp-sim deliberately refuses, not a
lookup of arbitrary addresses), and there is nothing perp-shaped on the surface. If a key is
obtainable for the hackathon, it is worth asking what `/v0/trades` filters on, but I would not plan an
integration around it.

No third-party alternative exists either: the perps subgraph is keyed and limited to 50312, and
Somnia's markets indexer repo is not public.

### B.4 The concrete integration, if you want it to be usable rather than impressive

Everything below is config plus one read path; none of it needs new runtime dependencies (AGENTS.md).

1. **Make the network an explicit, visible choice instead of an assumption.** perp-sim pins
   `hidekiTestnet` + `SOMNIA_HIDEKI_TESTNET_ADDRESSES` in
   [src/client.ts:8-17](../src/client.ts) and takes `indexerUrl` from
   `config` ([src/config.ts](../src/config.ts)). Adding a selector means adding an address set and a
   matching `chain`, because the SDK will reject a mismatched pair with an explicit message (measured:
   *"https://tokyo-prd.smk.somnia.host/v1/graphql indexes chains [50321]"*). **Tokyo 50321 is not in
   the installed SDK's `ChainId` enum** — 0.32.1 (2026-10-13) ships mainnet/Shannon/Elwood/Hideki/local
   only, so it needs either the 0.33.0 bump (2026-11-09, which renames the network `somniaTokyo`) or a
   one-object `defineChain`. That is a dependency decision, i.e. your command to run, not mine.
2. **Stamp provenance rather than hiding it.** `chainId` already reaches every run manifest through the
   code/data identity ([src/runs/manifest.ts:86-104](../src/runs/manifest.ts)). A network switch is only
   trustworthy if the UI says which network produced a number; "Hideki testnet · zero fees" under a PnL
   card is the honest version of today's silent assumption.
3. **Add a cheap "is there anything here?" preflight before any reconcile.** `countUserFills` +
   `getLatestFillBlock` are two reads and would tell the user up front: window empty, account is a bot
   (count == 10,000 cap → will be truncated at `maxFills 2_000`), or indexer has no perp data. All three
   conditions are live right now and all three currently surface only as a mid-run warning.
4. **~~Use `getTradeContext` for the fee leg~~ — superseded by measurement.** That read's fee arrays
   are BINARY-only and came back empty for every perp fill (B.2), so it could not have converted
   A.3.3. What was done instead: the perp fee rail is split by `kind` inside `reconcileAccount`
   (`feeRail()`), fill fees are compared on their own, liquidation penalties are reported without
   being compared, unknown kinds fail closed, and the vacuous case is labelled `vacuous-zero-rate`
   with a warning that says the pass proved nothing.
5. **Keep the loopback binding and the read-only posture.** Everything measured here is a public GET/POST
   to a documented indexer; no signer, no key, no transaction. Repointing the *read* endpoint does not
   change that. What it does change is claim scope: testnet prints are not customer trades, and per B.1
   there are no customer trades to show.
6. **One legal note before shipping anything that scrapes at rate**: Somnia's terms (2026-05-25) forbid
   automated scraping of "the Site" without written permission. The GraphQL indexer is a separate,
   documented, key-free read API and my probes were a handful of calls, but a tool that polls addresses
   on demand at volume should get a yes first rather than assume one.
