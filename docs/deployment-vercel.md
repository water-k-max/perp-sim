# Deployment wiring — static UI + one serverless function

Date: 2026-11-10 · Scope: `perp-sim/` working tree at the commit that introduces this file.

**Status in one line: published and serving. `https://perp-sim.vercel.app` answers 200 for the static shell,
`/api/chain` and `/api/markets`, runs a real `POST /api/backtest` against live Hideki data, and still refuses the
two run-store routes with the reason written below — all of it **observed** on 2026-11-13, in §9.**

Every claim below is tagged **measured** (a number from a run on this machine), **observed** (something a tool
showed while this session worked), **code-level** (a fact about this repository, checkable by reading it), or
**unverified** (something the platform must confirm before it can be called true). Sections 1–8 are the pre-publish
record and keep the tags they were written with; §9 is what the platform actually did to that build. Where §9
repairs a claim, the claim is corrected in place and pointed at §9 rather than quietly rewritten.

---

## 1. Why publishing was held back as an opt-in

_(Title as written before the first deploy; §9 records what happened when it was fired.)_

The task was "use the Vercel connector to wire deployment to Vercel". What this session could establish:

| | |
|---|---|
| Plugin installed | **observed** — official Vercel plugin v0.49.1, `runtimeReady: true`. |
| Connector tools | **observed** — zero. `mcp_list` for "vercel" returns nothing, so the OAuth connector never attached to this session. |
| Plugin skills/commands | **observed** — not present in the loaded skill list either. |
| `vercel` CLI on PATH | **observed** — absent. |

Project and organization selection, the region, the framework preset, and the first publish are all things the
connector or the CLI would have answered. Substituting a guessed `npx vercel` call would have needed a token this
repository does not hold, and would have produced a "deployed" claim with nothing behind it. So the repo-side work
was done completely and the publish step was left, deliberately, as the one action that requires the user.

Everything below is the part that could be built and proven without the platform.

---

## 2. Shape, as chosen

One static directory plus **one** function that carries the whole API. No second service, no database, no queue.

| Piece | File | Notes |
|---|---|---|
| Route table | `src/server/app.ts` | **code-level** — the only place any HTTP route is defined. The local lab and the deployment use the same table. |
| Transport contract | `src/server/contract.ts` | `RequestLike` / `ResponseLike` / `Deployment` / `RouteContext`. 12 lines of types, no behaviour. |
| Node transport | `src/server/node-transport.ts` | `node:http` → contract. Used by `src/bin/web.ts`, loopback-bound. |
| Web transport | `src/server/web-transport.ts` | Web `Request`/`Response` → contract. Used by the function entry. |
| Function entry | `api/[...all].ts` | Catch-all: every path arrives at `/api/*`. Exports `{ fetch }`, not a bare function — see below. |
| Static staging | `src/bin/stage-site.ts` | `build:site` = `build:web` + stage `public/*` and `dist/web/app.js` into `dist/site`, checking each staged file against its source size. |
| Platform config | `vercel.json` | Build command, output directory, function budget, CDN headers. |

The two transports are the only duplication, and their equality is a test rather than an assertion:
`src/server/app.test.ts` sends the same probes through a real loopback `node:http` server and through `serve()`
and fails where they disagree — status, body shape, or header policy. **measured** — 22 tests in
`src/server/*.test.ts`, 22 pass, 0 fail (4.4 s), inside `pnpm test:server`, which is inside `gate`; the gate runs
on every push in CI, so "green" there is evidence about this tree, not about the last one.

The entry's **export shape is a platform contract**, and the first live deployment paid for learning it.
`@vercel/node` inspects what the entry exports and chooses the calling convention from that: an export carrying a
`fetch` (or an HTTP-method) function is invoked as a Web handler, while anything else — a default-exported async
function included — is invoked as the legacy `(req, res)` pair. Under the legacy convention the entry receives
`node:http`'s message, whose `headers` is a plain object with no `forEach`, and the `Response` it returns is
discarded instead of sent: no route ever answered, and each invocation held its slot until `maxDuration` ended it
with a 504. `src/server/entry.test.ts` asserts the shape against the loader's own rule and keeps a control showing
that the bare-function export does not satisfy it.

---

## 3. What the deployment refuses, and why that is the honest answer

Two routes read the run store, which lives on the machine's disk (`cacheRoot()` = `process.env.PERP_SIM_CACHE`
or `.cache/perp-sim/`, read at module scope):

| Route | Local | Deployment |
|---|---|---|
| `POST /api/resample` (re-resample a saved run) | works | **501** — "A deployment has no durable disk" |
| `GET /api/runs`, `GET /api/runs/:id` | works | **501** — same reason, named for the run list |
| `/`, `/favicon.svg`, `/app.css`, `/app.js`, `/nova-storyboard.png` | served from disk | **404** from the function — the browser gets them from the CDN instead, so the function is never the right place to serve them |
| `POST /api/backtest`, `GET /api/markets`, `GET /api/chain`, account reconcile, account resample, import | works | works — no durable state needed |

**code-level** — a 404 would blame the user for our storage. The 501 body says which machine's disk it wanted and
why the request cannot be served from elsewhere. The web UI's re-resample control therefore only appears in the
local lab; on a deployment those two routes are not part of the product. This is the "show what fully works" rule
applied to a route table: three routes were cut rather than made flaky.

`/api/backtest` remains the full product on both transports: window, strategy, fill profile, latency, funding,
invariants, and the resample of *that* run in the same response.

---

## 4. What was measured, and what the numbers decide

### 4.1 Lane contention (`src/bin/web.ts` header, `probe/lane-contention.mts`)

**measured** on this machine, direct to the service, no HTTP: one job alone 12.2 s / 8.8 s; two distinct jobs
started together 30.5 s / 19.8 s (2.49× and 2.24× the solo time); three jobs 3.54× / 3.05×. `simulatePaths` is
synchronous CPU, so two lanes buy queueing — nobody is refused — not throughput. **code-level** — that is why the
function entry keeps `concurrency: 2, queueLimit: 4` but the comment states plainly that the cap bounds *one warm
instance*, not a fleet: N instances × 2 slots is the real ceiling, and N is the platform's choice.

### 4.2 Function budget (`probe/function-budget.mts`, frozen fixture, offline, temp cache)

The bound that matters is not a wall clock but `RESAMPLE_WORK_MAX = 2,000,000` steps
(**code-level** — `src/resample/path.ts:28`, `assertWorkBudget` at `:32`), where steps = paths × horizonTrades.
The route cap of `paths ≤ 5000` is therefore unreachable at the default horizon: **measured**, 5000 paths is
refused before any work — `resample work budget exceeded: paths × horizonTrades = 2500000 is above the 2000000
step ceiling`.

| paths | steps | wall | peak RSS |
|---|---|---|---|
| 600 | 300,000 | 23.1 s | 381 MiB |
| 1,500 | 750,000 | 35.7 s | 534 MiB |
| 3,000 | 1,500,000 | 72.9 s | 680 MiB |
| **4,000** | **2,000,000** (the ceiling) | **105.3 s** | **863 MiB** |

Marginal cost is ~48–53 ms per 1k steps once the first job has paid warm-up (77 ms at 600 paths is warm-up, not
rate). RSS is sampled after each job, so it is a high-water observation, not a maximum.

**Decisions these numbers force:**

- `maxDuration: 300` (**code-level** — `vercel.json`). The largest job the code accepts takes 105.3 s *here*.
  A 60-second ceiling would kill the biggest legal request in the middle of the work, which is exactly the
  half-works outcome that was ruled out. 300 s leaves ~3× headroom for queueing behind the second lane slot and
  for the platform's own CPU being different from this machine's.
- `memory: 2048` (**code-level**). 1024 MB against a measured 863 MiB leaves 161 MiB for the runtime, the parsed
  request and the response body. That is thin enough to fail under a slightly different fixture.
- Both numbers describe this machine (Windows, Node v24.19.0, one process). **unverified** — treat 105.3 s as an
  order-of-magnitude floor for the platform's Linux image, not a prediction. The first real deployment must
  re-measure it with the 4000-path job and adjust.

### 4.3 Indexer reads

**code-level** — history was already cached on disk at two layers: `loadMarketData` (keyed by chain, indexer,
pool and window; `src/data/ingest.ts:52`) and each tape slice (`src/data/tape.ts:75`). Neither cache covers the
reads every request repeats before the window is even known: `listPerps`, `getPerpRiskParams`,
`getEffectiveImfBps` (three per replay, at `src/backtest-api.ts:141`, `:192`, `:199`, `:521`, `:525` and the two
account routes in `src/server/app.ts`).

Those now go through `onceLive` (`src/data/live-cache.ts`), a keyed TTL memo with in-flight coalescing, driven by
`PERP_SIM_LIVE_CACHE_SEC`. **code-level** — unset locally, which means the local lab still asks the venue on every
request; `api/[...all].ts` sets 60 for the deployment only. Three properties are tested, not asserted
(**measured** — 7 tests, 7 pass, in `test:data`): a disabled cache never counts and never remembers; a failed read
is dropped immediately so one indexer hiccup cannot answer for a minute; two pools never share one risk parameter.

The reason it is opt-in is a correctness argument, not a preference: `imBps` and `effectiveImfBps` decide when a
simulated position dies, so a remembered read prices a run by parameters the chain may no longer enforce — and a
test that says "no network, no run" (`src/backtest-repro.test.ts` mocks `fetch` to throw) would start passing from
memory instead of failing. Locally that trade is not worth taking. On a warm instance that pays three reads per
request, 60 seconds is.

**unverified** — no cache hit rate has been measured. §9 put a handful of requests through the live function, which
is traffic but not a hit rate; the TTL's effect is still a number nobody has read.

---

## 5. Host policy, because the local rule cannot travel

Local: bind `127.0.0.1`, refuse any `Host` that is not loopback (`hostAllowed`). **code-level** — the binding is
unchanged, and a deployment does not weaken the read-only rule: there is still no signer, no key, no transaction
and no wallet connection anywhere in the request path.

What does change is *who can ask the tool to work*. Loopback meant "only this machine". A public host cannot use
that, so the deployment answers its own host and refuses everything else
(`deploymentHostAllowed`, `deploymentOriginAllowed`, `fetchSiteAllowed`), including:

- a request with no `Origin` from a host we do not recognise → **403** (tested, not assumed);
- an `Origin` that is not this deployment's → **403**;
- the security headers and CSP are the same values as local, applied twice on purpose: once by the CDN
  (`vercel.json` `headers`, one entry per static file it serves) and once by the function, so a response that
  bypasses one still carries the other.

The host is derived per invocation: `PERP_SIM_PUBLIC_ORIGIN` if set, otherwise `https://${VERCEL_URL}`
(**code-level** — `api/[...all].ts`). Preview URLs are minted per push, so a static allow-list would silently 403
every preview — the failure mode would look like an authorization bug, not a config bug.

**unverified** — whether the platform's own `Dependent Deployment` / Vercel Authentication layers sit in front of
this is a dashboard setting nobody in this session could read. If the tool should not be world-readable, that is
the switch to pull, and it is a platform setting, not a code one.

**observed** (§9), and the answer is the plain one: the production alias answers an unauthenticated request from
outside with 200, while the per-push deployment URLs 302 to Vercel Authentication. So the tool *is* world-readable
today, and §7.6 remains a decision somebody has to make on purpose rather than one the code already made.

---

## 6. CI/CD

`.github/workflows/ci.yml` now has three jobs:

| Job | Runs | Holds a credential | Blocks a PR |
|---|---|---|---|
| `gate` | every push and PR | no | yes |
| `live` | schedule, `main`, `workflow_dispatch` | no (read-only chain commands) | no |
| `deploy` | push, or PR **from this repository**, and only while `vars.VERCEL_DEPLOY_ENABLED == 'true'` | yes: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | after `gate` |

**code-level** — the publish needs both a repository *variable* and three *secrets*, because a job-level `if`
cannot read `secrets`: `vars.VERCEL_DEPLOY_ENABLED` is the switch, the secrets are the keys. **observed** —
GitHub's context-availability table lists `github, needs, vars, inputs` for `jobs.<job_id>.if` and not `secrets`
(<https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability>); the variable
is what the condition can see, so it is what the condition uses. With the variable unset — its state in this
repository right now — the job is skipped on every event, so the workflow is inert by construction and adding it
changed nothing about what a push does. The variable, not the code, is the approval.

The steps are the platform's own three-step build: `vercel pull --yes --environment=<development|production>` →
`vercel build [--prod]` → `vercel deploy --prebuilt [--prod]`, with the returned URL written to the job summary.
`gate` is a `needs:` dependency, so a red suite never publishes. Fork PRs get neither secrets nor a publish.

**unverified, and the one open build risk** — which package manager the build image uses, and which version.
`package.json` declares `engines.pnpm: ">=12"` but no `packageManager` field. Pinging `pnpm build:site` from the
platform's image with a pnpm older than 12 will trip that engines guard and fail the build.

**Answered, and it went the other way** — §9: `vercel build` in CI reported `Using pnpm@10.x based on project
creation date`, printed the `engines.pnpm`-without-corepack warning, and built anyway: the guard is an *install*-time
check, and on this path the install is the CI job's `pnpm install --frozen-lockfile`, not the platform's. The risk
therefore still exists for anyone who lets the platform install — the warning is the platform saying so on every
build — but it is no longer an open question about the pipeline that runs today.

`packageManager: "pnpm@12.11.2"` was added here, tested, and then removed again: **measured** — under pnpm 12 the
field makes `pnpm install` append 158 lines to `pnpm-lock.yaml` (`importers.…packageManagerDependencies` plus a
`@pnpm/exe.<os>-<arch>` entry per platform). That is pnpm's own behaviour, not a problem, but it is a lockfile
change of that size landing next to a deploy that has not been run yet, and CI's `--frozen-lockfile` would then be
locking a different file than the one in this commit. The field is worth adding deliberately, in its own commit,
after someone has seen the install write it. Until then: if the first platform build fails on the engines line,
add it. (`tmp/pnpm-lock.with-packageManager.yaml` holds the churned lockfile for comparison.)

---

## 7. To actually publish it

Written as a to-do list; §9 is what happened when it was executed. Each item keeps its status rather than being
deleted, because the list is the procedure for the *next* deployment too.

1. **done** — the repository is connected and CI runs `vercel pull` → `vercel build` → `vercel deploy --prebuilt`; the
   build image ran `pnpm build:site` and uploaded `dist/site` without tripping the `engines.pnpm` guard (§6).
2. **answered from the other side** — a wedged invocation was killed at exactly 300 s (§9), so this plan honours the
   configured `maxDuration`. The heavier worry is smaller than it looks: the `paths: 4000` resample is one of the two
   run-store routes the *deployment* refuses with a 501, so it cannot collide with the wall clock there at all. The
   route that can is `POST /api/backtest`, whose accepted work is bounded by `days ≤ 90` — measured at 1 day and
   2.44 s (§9), never at 90.
3. **done** — the three secrets and `VERCEL_DEPLOY_ENABLED=true` are set as repository values, by hand, in the UI.
4. **partly** — `GET /api/chain`, `GET /api/markets` and a real 1-day `POST /api/backtest` were re-measured on the
   live host, and both 501s arrived with their stated reason. The `paths: 4000` number was not: it belongs to a route
   that refuses on a deployment, which is why item 2's ceiling question needs a different place to be answered.
5. **done for the headers, honest about the host** — CSP, `nosniff`, `Referrer-Policy` and HSTS are on the live
   responses (§9). A foreign `Host` is 403 in the function's own tests; from outside, the CDN decides the host and
   rewrites `x-forwarded-host`, so forging it from a client returns 200 instead. The guard is real, and what enforces
   it for public traffic is the edge.
6. **still open** — whether the alias should be world-readable at all. §9 confirms it currently is. A public URL makes
   the work ceiling (`concurrency × instances`) someone else's problem; the platform's auth layer is where that gets
   answered, and no code change substitutes for it.

---

## 8. What is still not true of this deployment

Written before §9; the two bullets §9 answered are marked as such rather than deleted, because the reasoning that
put them there is the reasoning a reader needs next time.

- ~~No invocation has run on the platform.~~ §9 has platform latency for four routes and one real backtest.
  **Still missing: cold start, memory headroom, behaviour under concurrent load, and the plan's instance ceiling** —
  none of that is measurable from one request at a time.
- ~~The static shell is proven reachable in tests, not in a browser pointed at a hosted URL.~~ It is served; a
  browser driven against the live alias is the remaining half.
- Nothing persists between requests on a deployment. The run store is local-only by policy, and the UI hides what
  it cannot do. **observed** — the two 501s say so in those words on the live host.
- The live cache is a 60-second TTL with no observed hit rate. Two invocations of a route ten seconds apart is not
  a hit rate, and §9 does not pretend it is.
- If the platform caps `maxDuration` below the largest legal job, the biggest request is unservable even though the
  code accepts it. §9 saw 300 s honoured, so the ceiling is not the surprise — but the largest legal job
  (`paths: 4000` resample) has never been run there, and that is the number that would actually collide with it.

---

## 9. What the platform actually did (2026-11-13)

Published from `main` by CI (`gate` → `live` → `deploy`, run `43390282156`, commit `f928717`). Everything below is
**observed** on the live alias `https://perp-sim.vercel.app`, and it is what the first two published builds had to be
fixed for.

**It serves.** `/` returns 200 carrying the CSP, `nosniff`, `Referrer-Policy` and HSTS that `vercel.json` asks for;
`/app.js` 200 at 311497 B, `/app.css` 200 at 25966 B, `/favicon.svg` 200 at 562 B. `/api/chain` 200 in 0.34 s,
`/api/markets` 200 in 0.90 s and 40 pools — BTC, ETH, SOL, HYPE, the equity symbols and the metals, all quoted in
`USDso`. A real `POST /api/backtest` (`BTC/USDso`, 1 day, long, 0.01, 10000 cash, intrabar) answered 200 in 2.44 s
with `status=closed`, `complete=true`, entry `73329.209833269153`, end equity `9956.766…`, `pnl=-41.529`,
`funding=-1.7049`, `fees=0.0`, `maxDrawdownPct=0.59`, 24 bars at `missingSettlements=0` and `gaps=0`, candle
coverage 24/24, a 23-point trail, and the warning the model actually deserves: *Hypothetical fixed-position replay;
settlement-mark entry is not a book fill.*

**The refusals travel.** `GET /api/runs` and `POST /api/resample` both answer 501 on the deployment with exactly the
sentence §3 writes for them. A cross-origin `POST /api/backtest` is refused 403.

**Two lessons cost a production deploy each, because neither is visible from a unit test.**

1. A module-scope `await getCodeIdentity()` in `src/backtest-api.ts` rejected with `ENOENT` on a file the built tree
   does not carry. The promise was not attached to an `await`, so the rejection surfaced during *import*, the
   instance exited before the handler existed, and every route answered the platform's own
   `FUNCTION_INVOCATION_FAILED`. Fixed in `src/runs/manifest.ts` by identifying code from the running artifact when
   the source read cannot finish, with a test covering both bundle layouts.
2. The entry exported a bare async function, so the runtime chose the legacy `(req, res)` convention for it (§2) and
   threw away the `Response`. Nothing was written, so each route held its slot until `maxDuration` killed it with a
   504 — while the log showed our own error two seconds in, which is exactly how a dead deployment looks alive.
   Fixed by `export default { fetch }`.

Both are asserted by tests that need no platform; the CI probe step that found them is deleted.

**Four incidental facts worth having down.** `maxDuration: 300` was honoured — a wedged invocation was killed at 300 s
and not sooner. Hobby retains runtime logs for well under an hour, so `vercel logs --since 1h` is rejected and the
default window is what works. Scoping logs to one deployment id misses the request the alias just served, because the
alias can be answered by a deployment other than the newest. And a client-supplied `x-forwarded-host:
evil.example.com` returned **200, not 403**: the CDN rewrites that header before the function sees it, so which host
a request is addressed to is platform-supplied, not client-chosen. The function's own host guard is proven by
`src/server/app.test.ts`; the edge is what makes it untestable from outside by header forgery, and saying otherwise
would credit the deployment with a property it was never the one enforcing. Whether the alias should stay
world-readable is still a decision: per-push URLs sit behind Vercel Authentication (302) while the production alias
does not.
