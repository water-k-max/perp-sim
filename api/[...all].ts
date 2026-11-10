/**
 *  The deployment's API entry: one function, all routes, no port.
 *
 *  A serverless invocation is handed one request and expected to return one response; there is no
 *  socket to hold open and no process that survives to be addressed. Everything that decides what an
 *  answer looks like lives in `src/server/app.ts` and is shared with the local lab, so a route
 *  cannot mean one thing on `pnpm dev` and another in production. The provenance of that split is in
 *  `src/server/app.test.ts`, which sends the same probes to both transports and fails if they disagree.
 *
 *  Nothing here has been executed on the platform. It is wired and unit-proven, not deployed.
 */
import type { PublicOrigin } from "../src/server/contract.js";

// The cache and the run store are read off `process.env.PERP_SIM_CACHE` when their modules are
// first evaluated, which happens inside the dynamic imports below — so the value has to be in place
// before those lines run. Static imports would be hoisted ahead of it, which is why this file
// imports dynamically. `/tmp` is the only writable path on the platform, and it does not outlive
// the instance: that is exactly why the run-store routes answer 501 rather than pretending.
process.env.PERP_SIM_CACHE ??= "/tmp/perp-sim-cache";

// The dataset cache above is keyed by history window, so it never covers the market list or a pool's
// live risk parameters — those are read again on every invocation. A warm instance can answer them
// from one read per minute instead of one per request, which is what this line buys; the reason it is
// a deployment-only setting is in `src/data/live-cache.ts`.
process.env.PERP_SIM_LIVE_CACHE_SEC ??= "60";

const { parsePublicOrigin } = await import("../src/bin/http-kit.js");
const { WorkLanes } = await import("../src/bin/work-lanes.js");
const { serve } = await import("../src/server/web-transport.js");

/**
 *  Which host this deployment is addressed as. Preview URLs are minted per push, so a value someone
 *  would have to remember to update is a value that silently 403s every preview: the platform
 *  already says which host it served this invocation from, and that is what is used. An explicit
 *  `PERP_SIM_PUBLIC_ORIGIN` still wins, for a custom domain or a tunnel.
 */
function deploymentOrigin(): string | undefined {
  const configured = process.env.PERP_SIM_PUBLIC_ORIGIN;
  if (configured) return configured;
  const host = process.env.VERCEL_URL;
  return host ? `https://${host}` : undefined;
}

let publicOrigin: PublicOrigin | null;
try {
  publicOrigin = parsePublicOrigin(deploymentOrigin());
} catch {
  throw new Error("PERP_SIM_PUBLIC_ORIGIN must be a bare https origin, e.g. https://lab.example.vercel.app.");
}

/** Per-instance slots, for the same reasons `src/bin/web.ts` documents. They bound one warm instance, not a fleet. */
const lanes = new WorkLanes({ concurrency: 2, queueLimit: 4 });

export default async function handler(request: Request): Promise<Response> {
  return serve({ deployment: { mode: "serverless" }, publicOrigin, lanes }, request);
}
