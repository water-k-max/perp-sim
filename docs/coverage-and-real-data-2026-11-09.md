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
   **Fixed: the estimator is now aimed at a process solved exactly.** `src/resample/calibration.ts`
   is a new, dependency-free module — floats on purpose, because this is the one place the object is a
   probability rather than money — holding a finite-horizon gambler's-ruin DP on a `+winUnits/
   −loseUnits` lattice with an absorbing barrier at zero (the same freeze `walkPath` applies), a Wilson
   score interval, and a uniformity report (KS against `1.36/√n`, decile χ² against 16.919). Eleven
   tests in `src/resample/calibration.test.ts` (run by `pnpm test:resample`, and standalone by
   `pnpm test:calibration`) put the shipped `simulatePaths` next to that law. A pool of exactly 55 wins
   and 45 whole-unit losses bootstrapped with replacement *is* an i.i.d. ±1 walk at p = 0.55, so the
   two sides are the same process, one solved and one sampled. Measured, with 2,000 paths per line and
   fixed seeds:
   - The nominal tails land where the law says. Starting from 20 units over 60 steps, the exact 5%
     quantile is 14 units with coverage 0.0771; the Monte Carlo put 156/2,000 = 0.0780 paths at or
     below it, 99.7% Wilson band [0.0618, 0.0979]. Same shape at the median (0.5498 exact, 0.5535
     sampled) and the 95% (0.9554 exact, 0.9485 sampled, band [0.9316, 0.9614]).
   - Bankruptcy containment at two depths: 10 units → exact 0.0609 against 127/2,000 = 0.0635 in
     [0.0490, 0.0819]; 3 units → exact 0.4791 against 0.4920 in [0.4586, 0.5255]. The second line is
     what makes the first mean something — an estimator that could not tell those apart would be
     asserting nothing.
   - **The shipped random-entry test is calibrated, not just reproducible.** 600 `runEdgeTest` calls
     over a trade list whose entries come from `deriveStream` (`perp-sim/resample/v1`) while the null
     paths come from `deriveEdgeStream` (`perp-sim/edge/v1`) — separate hash domains, so the recorded
     total is an independent draw from the same distribution as the 300 null totals it is ranked
     against, i.e. a true null by construction. Result: KS 0.0383 against the 0.0555 critical value,
     decile χ² 8.47 against 16.919 (counts 55/61/58/64/46/58/67/61/56/74 where 60 is expected), 5%-
     exceedance 4.33% with band [2.97%, 6.27%] holding 5%, and both ends of the achievable ladder
     actually reached — `min = 0.0033 = 1/301` and `max = 1.0000`. Every p-value also lands on a
     multiple of 1/301, which is the add-one correction holding as data rather than as a comment.
   - The gates are not won by emptiness, and were checked by breaking them: swapping `winUnits` for
     `loseUnits` in the DP fails three different tests, and moving the absorbing barrier from
     `equity <= 0n` to `equity < 0n` in `path.ts` fails the bankruptcy-containment test — so a
     one-unit error in the freeze is now visible. Deliberate alternatives (a skewed, a lumped and a
     tail-heavy p-value set) all come back `uniform: false`.
   **What is still not claimed:** the calibrated process is synthetic. Nothing here validates the
   estimator against a *real* account's PnL series — no such series has a known law — and the
   shuffle-mode test pins the *disagreement* on purpose (a permutation of a fixed pool cannot be
   i.i.d., and every surviving path ends at the same total), so this section calibrates the
   bootstrap walk and the edge p-value, not funding, fees or sizing.
2. **The ruin probability is never compared to the analytic answer.** For a biased random walk on
   equity there is a closed form. `bankruptcyRate` is reported
   ([src/resample/stats.ts:127-128](../src/resample/stats.ts)) and never checked against it. Today's
   live run reported `0.000` in all three modes, which is also a case of a gate won by emptiness —
   nothing in the repo proves the counter can count.
   **Fixed on both halves.** The closed form is now in the repo as a *cross-check*, not as the answer
   being tested: `analyticRuinLimit` computes `((1−p)/p)^a` for p > ½ (and 1 otherwise, the fair-game
   case) with no shared code with the DP, and the test asserts the DP climbs toward it from below.
   Measured at p = 0.55, a = 3: limit 0.5477, DP 0.4639 → 0.5120 → 0.5368 → 0.5459 → 0.5473 at
   horizons 50/100/200/400/600 — strictly increasing, never above the limit (a finite horizon cannot
   be more ruinous than the infinite one), and within 1e-3 of it by H = 600. At p = 0.5 the finite
   answer creeps toward 1 without reaching it, which is the other half of the same theorem.
   The counter demonstrably counts: on all 2,000 paths at both depths the number flagged bankrupt
   equals the number whose final equity is exactly `0n` (127 and 984), the lattice's atom at zero
   equals the DP's own ruin probability to 1e-12, and the shallower account is measurably more ruinous
   than the deeper one. What remains true is the caveat that produced this gap: `bankruptcyRate`
   reported `0.000` on a real account because that account genuinely did not go bust in the window —
   a zero is still not evidence the counter works, which is why the working proof is a synthetic
   process with a known answer rather than another live run.
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
   **Fixed: the lock is gone, replaced by keyed lanes, and the routes had to change shape to make
   that honest.** `SingleFlight` is deleted from [src/bin/http-kit.ts](../src/bin/http-kit.ts) with
   no compatibility shim; [src/bin/work-lanes.ts](../src/bin/work-lanes.ts) is the replacement —
   bounded concurrency, identical-request coalescing, a FIFO queue, and a `LaneBusy` refusal that
   carries the depth it saw so the router can answer 429 with a `Retry-After`. Two lanes, four
   waiting ([src/bin/web.ts:53](../src/bin/web.ts#L53)). The four things that had to change in the
   routes, in order of how much they hurt to get wrong:

   - **Validation now happens before admission.** The old `tryAcquire()` sat *above* the body read
     on all three POST routes (`git show 02b2ba2:src/bin/web.ts`, lines 45/48, 78/81, 104/107), so a
     request that was about to be rejected for a malformed body still took the only slot while it
     was being turned away. The GET routes already validated their URL parameters first, which is
     why they are unchanged in that respect. Each heavy route now parses its own body to completion
     and answers its own 400 before a lane is asked for. `parseRunRequest` and `parseImport` were
     already called at the top of their handlers, so what they gained is only the position; the
     resample options were the real move — `parseResampleRequest` is now called in the router
     ([src/bin/web.ts:138](../src/bin/web.ts#L138)) as well as inside `resampleStoredRun`, so a path
     count outside the work budget is a 400 from the router instead of a job that fails.
   - **The key is the parsed request, not the bytes.** `laneKey` is `route:sha256(canonical(parsed))`
     ([src/bin/web.ts:58](../src/bin/web.ts#L58)), reusing the same `canonical`/`sha256` that give run
     digests. So JSON key order, whitespace, and an omitted field against its documented default all
     identify one job — which is the difference between "coalesces when nobody touched the form" and
     coalescing at all.
   - **Response writing moved out of the shared work.** A job returns an `Answer` (`{status, body}`)
     and each caller writes its own socket (`viaLane`,
     [src/bin/web.ts:68](../src/bin/web.ts#L68)). This is not a style preference: the second caller of
     a coalesced pair never runs the work, so a job that wrote straight into the socket that happened
     to start it would leave the other client connected and silent forever. The refusal path returns
     `false` from `viaLane` for the same reason — one writer per response.
   - **There is deliberately no timeout on a queued request.** Dropping a waiter while its job keeps
     running would let a second copy of the same expensive replay start behind it, which is the
     failure coalescing exists to prevent; the queue limit is what bounds the wait, and `Retry-After:
     2` is a floor, not an estimate — the lanes keep no timing history and do not pretend to.

   Evidence. `src/bin/work-lanes.test.ts` (10 tests, 950 ms) pins the policy against deferred
   promises with no clock, no RNG and no network: one job per key however many callers, keys that
   differ in one field are different work, peak in-flight never exceeds the limit, the queue drains
   in FIFO order, a full queue refuses and reports its depth, `queueLimit: 0` means no waiting, a
   throwing job reaches *every* waiter with the same error and the lane still recovers afterwards,
   and an empty key is refused before anything is scheduled.
   `src/backtest-repro.test.ts:205-274` then pins the *wiring* against a real spawned server (ports
   3199-3201, loopback, `fetch` mocked in-process so a frozen replay cannot reach the chain): eight
   distinct-seed resamples of a 600 × 500 job yield only 200s and 429s, never more than six 200s,
   and each 429 carries `Retry-After: 2` with `queue: { concurrency: 2, queueLimit: 4 }` and the
   sentence the client shows (60.1 s); eight byte-identical resamples all return 200 with **one**
   distinct body in 11.0 s, which is the coalescing as data rather than as a description; and with
   the lane demonstrably full — the check races the first response and requires it to be a refusal,
   so that assertion cannot pass vacuously — three bad requests (a digest that is not one, a body
   that is not JSON, a path count outside the budget) come back 400, 415, 400 and never 429 (38.5 s).

   And against the live chain, which is the shape the wallet panel actually uses —
   `probe/lane-live.mts`, five concurrent read-only requests for `0x6e12c589…60691f` on port 3111
   (40 perp fills across all markets in 7 d per `probe/pick-account.mts`; the BTC window this probe
   reads holds 8): one
   `/reconcile`, two `/resample` with different seeds, and two byte-identical copies of the first.
   **Five 200s, zero refusals** — under the lock this exact call would have answered four of them
   with "a replay is already running". The reconcile took 9.0 s, the resample 7.8 s, its two
   identical copies came back *at the same instant with the same 7,800 bytes* (coalescing, visible
   from outside as latency and identity), and the second seed, which had to wait for a lane, landed
   at 32.6 s with a different body. Nothing was cancelled, nothing was refused, and the server was
   still alive at the end.

   **What this does not buy, measured rather than assumed.** Two lanes do *not* run two path
   simulations in parallel: path stepping is synchronous CPU on one thread.
   `probe/lane-contention.mts` calls the resample service directly with the same 600 × 500 job, which
   prices the intrinsic cost of running the jobs together rather than the server's schedule — the lane
   would never start the third at once. Two runs: one job alone **12.2 s** then **8.8 s**, two started
   together **30.5 s** then **19.8 s**, i.e. **2.49×** and **2.24×**, three jobs **3.54×** and
   **3.05×**. The ratio never comes near 1, so on that route two lanes buy slightly *less* total
   throughput than serialising would have. The slots are kept for the routes that made this gap a
   complaint — account reconcile, account resample and forward test are indexer-bound, and their wall
   clock is network waits that genuinely overlap — and for the queue and the coalescing, which are
   pure wins. Worker threads for the CPU-bound path loop remain the open half of the review's upgrade
   direction, and with them cancel, a progress stream, and a queue position told to the client that is
   waiting. None of those three exist; a queued request learns nothing until its answer arrives. The
   lanes are per-process state, so they bound one server, not a fleet.

   A structural fix this work exposed on the way: `test:web` was a hand-written list of files and had
   silently skipped the new `src/bin/work-lanes.test.ts`, so the ten tests above were green in my
   terminal and invisible to the repo. It is now `tsx --test src/bin/*.test.ts` plus the rest, so a
   test in `src/bin/` can no longer be written and never run. The wider form of that problem — no
   gate that every `*.test.ts` in the repository is reachable from some script — belongs to the CI
   item.

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
    **Fixed: the truncation is now typed data, printed identically by both surfaces, and it is
    measured rather than assumed.** Three things were wrong with the old state — the limits were
    described in free-text warnings that a second panel could forget to copy, the population figure
    was fetched on *every* run even when the read had already proved itself complete, and the
    position-change read could abort the whole reconcile on one transient indexer failure. What is
    here now:

    - `src/verify/fill-coverage.ts` (new, dependency-free so the browser bundle and the CLI can both
      import it) defines `FillReadCoverage` — first/last fill timestamps kept, rows scanned, rows in
      window, rows kept, pages, `truncated`, which bound stopped it, the indexer's own count and
      whether that count sat on its ceiling — plus `fillCoverageStamp`, the single function that
      turns it into one sentence. `replay-account.ts` returns the block; the CLI's `cover` line and
      the wallet panel's `CoverageNote` both print that same sentence, so the two cannot disagree.
      The three older free-text warnings that said roughly the same thing in three places are
      deleted, and the `unknown` tone a first draft had was removed too: `parseCoverage` refuses a
      response without the block, so a stamp is never rendered over missing data.
    - The count is now **gated**. It only runs when the read fell short, because a read that ended
      because its page cursor ran out has already proved it covered the window. That matters: the
      SDK's `countUserFills` is not an aggregate query here. Measured 2026-11-09
      (`probe/count-scope.mts`), this endpoint rejects it for the anonymous role —
      `field 'Fill_aggregate' not found in type: 'query_root'` — so every call falls through to a
      bounded scan of `COUNT_FALLBACK_CAP + 1 = 10,001` id-rows, timed at **385 ms over 7 d and
      2,309 ms over 30 d** on the busiest sampled account, and `aggregateCount` drops the
      `truncated` flag when it returns, so a count of exactly `10,000` is a **lower bound and never
      a total**. `INDEXER_COUNT_CEILING` is stated as data and the sentence says "at least".
    - The count is scoped by `pool`, not by market kind, and that is a measured choice rather than a
      workaround: the SDK's `FillsScope` type carries no `marketType` field at all (though
      `applyFillScope` honours one at runtime), while of the 20 perp pools present in the newest
      4,000 perp fills, **none carries a single non-PERP row** (probe sections B–D). A pool-only
      count therefore selects the same population as the `marketType`-filtered page read.
    - The position-change leg no longer takes the report down with it. `retryRead` now treats
      Hasura's `database query error` as the transient it is — the identical read over the same
      2,000 fills returned `unmatched 0` on one run and threw that message on the next with nothing
      changed — and a chunk that still cannot be answered after retries is recorded as
      `changesUnread: { fills, reason }`, left as `null` rows so every later fill keeps its own
      update, warned in the report as "the shortfall is on this side of the wire, not a gap in what
      the chain recorded", and it keeps `ok: false`. Permanent refusals (a field this role may not
      query, an unusable variable, an unindexed table) are still not retried: `src/retry.test.ts`
      pins both directions.
    - Reads are chunked at **250 fills**, and the reason is bounded damage, not a measured cure. The
      same 1,000 bot-driven fills were re-read twice at 1,000 / 250 / 100 fills per call
      (30 calls): **zero failures at every size**, so 250 cannot be claimed to lower the error rate.
      It does mean one refusal costs 250 fills instead of 1,000 and puts three concurrent queries at
      the indexer instead of ten, and on that sample it was also the fastest way through the window
      — 1.5–1.6 s per pass at 250 against 2.0–6.4 s at 1,000 and 3.9–4.0 s at 100, since each call
      carries a fixed cost no matter how few fills it asks for.

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
