/**
 *  The deployment's API entry: one function, all routes, no port.
 *
 *  A serverless invocation is handed one request and expected to return one response; there is no
 *  socket to hold open and no process that survives to be addressed. Everything that decides what an
 *  answer looks like lives in `src/server/app.ts` and is shared with the local lab, so a route
 *  cannot mean one thing on `pnpm dev` and another in production. The provenance of that split is in
 *  `src/server/app.test.ts`, which sends the same probes to both transports and fails if they disagree.
 */
import type { PublicOrigin } from "../src/server/contract.js";

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
 *  Two reasons point the same way. Their modules read the environment assignments above when they
 *  are first evaluated, so those assignments have to run first — which a static import would beat.
 *  And a function entry compiled by the platform cannot carry a top-level `await`, which is what
 *  awaiting them at import time would need. The promise is created inside the handler rather than at
 *  module scope, so a failed load is always attached to an `await` instead of surfacing as an
 *  unhandled rejection that kills the instance before it can answer.
 */
type Route = (request: Request) => Promise<Response>;
let route: Promise<Route> | null = null;

function loadRoute(): Promise<Route> {
  route ??= (async () => {
    const [{ WorkLanes }, { serve }] = await Promise.all([
      import("../src/bin/work-lanes.js"),
      import("../src/server/web-transport.js"),
    ]);
    // Per-instance slots, for the same reasons `src/bin/web.ts` documents. They bound one warm
    // instance, not a fleet.
    const lanes = new WorkLanes({ concurrency: 2, queueLimit: 4 });
    return (request: Request) => serve({ deployment: { mode: "serverless" }, publicOrigin, lanes }, request);
  })();
  return route;
}

export default async function handler(request: Request): Promise<Response> {
  return (await loadRoute())(request);
}
