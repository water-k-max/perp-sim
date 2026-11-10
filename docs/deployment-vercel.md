# Deployment wiring — static UI + one serverless function

Date: 2026-11-10 · Scope: `perp-sim/` working tree at the commit that introduces this file.

**Status in one line: the deployment is wired and unit-proven. Nothing has been published, and no platform behaviour has been observed.**

Every claim below is tagged **measured** (a number from a run on this machine), **observed** (something a tool
showed while this session worked), **code-level** (a fact about this repository, checkable by reading it), or
**unverified** (something the platform must confirm before it can be called true). There is no claim in this file
about what Vercel does, because no invocation has run there.

---

## 1. Why no deployment was fired

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
| Function entry | `api/[...all].ts` | Catch-all: every path arrives at `/api/*`. |
| Static staging | `src/bin/stage-site.ts` | `build:site` = `build:web` + stage `public/*` and `dist/web/app.js` into `dist/site`, checking each staged file against its source size. |
| Platform config | `vercel.json` | Build command, output directory, function budget, CDN headers. |

The two transports are the only duplication, and their equality is a test rather than an assertion:
`src/server/app.test.ts` sends the same probes through a real loopback `node:http` server and through `serve()`
and fails where they disagree — status, body shape, or header policy. **measured** — 18 tests, 18 pass, 0 fail
(10.2 s), inside `pnpm test:server`, which is inside `gate`; the whole gate is green on this tree.

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

**unverified** — no cache hit rate has been observed anywhere; there is no traffic and no platform.

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

`packageManager: "pnpm@12.11.2"` was added here, tested, and then removed again: **measured** — under pnpm 12 the
field makes `pnpm install` append 158 lines to `pnpm-lock.yaml` (`importers.…packageManagerDependencies` plus a
`@pnpm/exe.<os>-<arch>` entry per platform). That is pnpm's own behaviour, not a problem, but it is a lockfile
change of that size landing next to a deploy that has not been run yet, and CI's `--frozen-lockfile` would then be
locking a different file than the one in this commit. The field is worth adding deliberately, in its own commit,
after someone has seen the install write it. Until then: if the first platform build fails on the engines line,
add it. (`tmp/pnpm-lock.with-packageManager.yaml` holds the churned lockfile for comparison.)

---

## 7. To actually publish it

Not done here. The short list, in order:

1. Connect the repository in the Vercel dashboard (or a session where the connector attaches), create the project,
   and confirm the build image runs `pnpm build:site` and uploads `dist/site`. If it fails on the `engines.pnpm`
   guard, that is the §6 item: add `packageManager` and commit the lockfile it writes.
2. Read Project Settings → Functions and **record the plan's real `maxDuration` ceiling**. If it is below 106 s,
   the 4000-path job cannot complete in one invocation, and the fix is to lower the accepted work on deployments —
   not to let the request die at the wall clock.
3. Set `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` as repository secrets, then
   `VERCEL_DEPLOY_ENABLED=true` as a repository variable — or run `vercel deploy --prod` by hand once.
4. On the first deployment, re-measure: `POST /api/backtest` at `paths: 4000`, then `GET /api/chain`,
   `GET /api/markets`, then confirm `POST /api/resample` and `GET /api/runs` return the 501 with its stated reason
   (they must, or the run-store assumption is wrong and this document is out of date).
5. Check the response headers actually carry the CSP from `vercel.json`, and that a request with a foreign `Host`
   is 403. Both are unit-proven here and platform-dependent there.
6. Decide whether the deployment should be public at all. A public URL makes the work ceiling
   (`concurrency × instances`) someone else's problem; the platform's auth layer is where that gets answered.

---

## 8. What is still not true of this deployment

- No invocation has run on the platform; **no measured platform latency, cold start, memory limit or plan cap.**
- The static shell is proven to stage (`build:site` compares every file's size to its source) and proven to be
  reachable *in tests*, not in a browser pointed at a hosted URL.
- Nothing persists between requests on a deployment. The run store is local-only by policy, and the UI hides what
  it cannot do.
- The live cache is a 60-second TTL with no observed hit rate.
- If the platform caps `maxDuration` below the largest legal job, the biggest request is currently unservable on
  the deployment even though the code accepts it — §7.2 exists to find that out before anyone calls the tool
  broken.
