/**
 *  The deployment's API handler: one Web handler, all routes, no port.
 *
 *  A serverless invocation is handed one request and expected to return one response; there is no
 *  socket to hold open and no process that survives to be addressed. Everything that decides what an
 *  answer looks like lives in `src/server/app.ts` and is shared with the local lab, so a route
 *  cannot mean one thing on `pnpm dev` and another in production. The provenance of that split is in
 *  `src/server/app.test.ts`, which sends the same probes to both transports and fails if they disagree.
 *
 *  This module is the single implementation behind every file in `api/`. The catch-all
 *  `api/[...all].ts` re-exports it, and so does one thin file per deep route
 *  (`api/accounts/[account]/resample.ts` and its siblings). The deep files exist because the
 *  deployed catch-all was measured to match only a single path segment: every `/api/<a>/<b>/<c>`
 *  request drew the platform's own edge 404 (`X-Vercel-Error: NOT_FOUND`, a body shape this repo
 *  never writes) while `/api/chain` answered. A static-plus-one-parameter route is the most basic
 *  shape the platform compiles, so giving each deep route its own file removes the dependence on
 *  catch-all expansion without changing a single URL the browser calls.
 */
import type { PublicOrigin } from "./contract.js";

// The cache and the run store are read off `process.env.PERP_SIM_CACHE` when their modules are
// first evaluated, which happens inside the dynamic import in `loadRoute` below — so the value has
// to be in place before that runs. `/tmp` is the only writable path on the platform, and it does not
// outlive the instance: that is exactly why the run-store routes answer 501 rather than pretending.
process.env.PERP_SIM_CACHE ??= "/tmp/perp-sim-cache";

// The dataset cache above is keyed by history window, so it never covers the market list or a pool's
// live risk parameters — those are read again on every invocation. A warm instance can answer them
// from one read per minute instead of one per request, which is what this line buys; the reason it is
// a deployment-only setting is in `src/data/live-cache.ts`.
process.env.PERP_SIM_LIVE_CACHE_SEC ??= "60";

/**
 *  Which hosts this deployment answers.
 *
 *  `VERCEL_URL` is the per-push URL, but real traffic arrives at the production alias and preview
 *  requests arrive at the preview alias, so a guard built from `VERCEL_URL` alone refuses the host
 *  the site is actually used at. Every host the platform names for this deployment is therefore
 *  accepted, while the origin used for the same-origin POST check is the stable one — the alias —
 *  because that is what the browser stamps on its requests.
 */
function deploymentOrigins(): PublicOrigin | null {
  const bare = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    try {
      const url = new URL(value.startsWith("http") ? value : `https://${value}`);
      return url.pathname === "/" || url.pathname === "" ? url.host : undefined;
    } catch {
      return undefined;
    }
  };
  const configured = bare(process.env.PERP_SIM_PUBLIC_ORIGIN);
  const hosts = [...new Set([
    configured,
    bare(process.env.VERCEL_URL),
    bare(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  ].filter((host): host is string => Boolean(host)))];
  if (hosts.length === 0) return null;
  // A custom origin wins, then the alias: the page and the API must share the origin a browser sees.
  const origin = configured ?? hosts.find((host) => host === bare(process.env.VERCEL_PROJECT_PRODUCTION_URL)) ?? hosts[0];
  return { origin: `https://${origin}`, hosts };
}

const publicOrigin = deploymentOrigins();

/**
 *  The route modules load on the first invocation rather than at import time.
 *
 *  They read the environment assignments above when they are first evaluated, so those assignments
 *  have to run first — which a static import would beat. The promise is then created inside the
 *  handler rather than at module scope so that a failed load is always attached to an `await`: an
 *  import-time rejection in this graph surfaces as an unhandled error that kills the instance before
 *  it can answer, which is exactly how one deployment served 500 on every route.
 */
type Route = (request: Request) => Promise<Response>;
let route: Promise<Route> | null = null;

function loadRoute(): Promise<Route> {
  route ??= (async () => {
    const [{ WorkLanes }, { serve }] = await Promise.all([
      import("../bin/work-lanes.js"),
      import("./web-transport.js"),
    ]);
    // Per-instance slots, for the same reasons `src/bin/web.ts` documents. They bound one warm
    // instance, not a fleet. Each `api/` file is its own function with its own instance pool, so
    // these lanes bound one route's instances rather than the whole deployment.
    const lanes = new WorkLanes({ concurrency: 2, queueLimit: 4 });
    return (request: Request) => serve({ deployment: { mode: "serverless" }, publicOrigin, lanes }, request);
  })();
  return route;
}

/**
 *  Why this exports an object with a `fetch` method rather than a bare function.
 *
 *  The runtime reads what the entry exports and picks the calling convention from it: an export that
 *  carries a `fetch` (or an HTTP-method) function is invoked as a Web handler — a real `Request` in, the
 *  returned `Response` written to the socket. Anything else, a default-exported async function included,
 *  is invoked the legacy way as `(req, res)`, which hands it `node:http`'s message — whose `headers` is a
 *  plain object with no `forEach` — and discards the `Response` handed back. Nothing is then ever
 *  written, so each route holds its slot until `maxDuration` ends it with a 504: the build that looked
 *  alive and dead at once. `fetch` also covers every method, where each named method would have to be
 *  declared separately. `src/server/entry.test.ts` asserts this shape for every file in `api/`.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await (await loadRoute())(request);
    } catch (error) {
      // A deployment that cannot answer a request still has to say why. Rejecting out of the handler is
      // how one build answered every path with the platform's own `FUNCTION_INVOCATION_FAILED` and no
      // explanation of its own; the message is the diagnosis, and it is all the platform keeps.
      console.error("request failed", error);
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return Response.json({ error: "This deployment failed to handle the request.", detail }, { status: 500 });
    }
  },
};