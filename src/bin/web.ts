import { createServer } from "node:http";
import { parsePublicOrigin } from "./http-kit.js";
import { WorkLanes } from "./work-lanes.js";
import { handle } from "../server/app.js";
import { nodeRequest, nodeResponse } from "../server/node-transport.js";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("NOVA Backtest Lab requires Node.js 22 or newer. Update the Node runtime on PATH before running pnpm dev.");
const port = Number(process.env.PORT ?? 3000);
let publicOrigin;
try {
  publicOrigin = parsePublicOrigin(process.env.PERP_SIM_PUBLIC_ORIGIN);
} catch {
  throw new Error("PERP_SIM_PUBLIC_ORIGIN must be a bare http(s) origin, e.g. https://example.trycloudflare.com.");
}

/**
 *  Two heavy jobs at a time, four allowed to wait. The object this replaces refused *every* heavy
 *  route whenever *any* route was busy, so a wallet analysis and a backtest of an unrelated market
 *  were serialized by each other, and a double-click on the same form got "try again later" instead
 *  of the result it was already waiting for. `src/bin/work-lanes.ts` holds the policy.
 *
 *  What two slots buy, measured by `probe/lane-contention.mts`, which calls the resample service
 *  directly with the 600-path × 500-trade job (so this is the intrinsic cost of running the jobs
 *  together, not the server's schedule — the lane would never run the third at once). Two runs:
 *  one job alone 12.2 s then 8.8 s, two started together 30.5 s then 19.8 s — **2.49× and 2.24×**,
 *  three 3.54× and 3.05×. Path simulation is synchronous CPU on one thread, so the ratio never
 *  approaches 1: concurrency buys that route no throughput at all, and slightly less than
 *  serialising would have. The slots are kept for the routes that made #9 a complaint — account
 *  reconcile and account resample are indexer-bound, and their wall clock is network
 *  waits that do overlap — and for the queue and the coalescing, which are pure wins. The number
 *  that does not depend on the thread is coalescing: eight identical resamples cost one job.
 *
 *  Per-process state either way: these slots bound one server here, and one warm instance on a
 *  deployment. The routes themselves live in `src/server/app.ts`, which the serverless entry shares
 *  so that the two transports cannot disagree about a refusal, a body cap or an error answer.
 */
const lanes = new WorkLanes({ concurrency: 2, queueLimit: 4 });

createServer((req, res) => void handle({ deployment: { mode: "local", port }, publicOrigin, lanes }, nodeRequest(req), nodeResponse(res)))
  .listen(port, "127.0.0.1", () => console.log(`NOVA Backtest Lab: http://localhost:${port} (read-only, local access${publicOrigin ? `, public origin ${publicOrigin.origin}` : ""})`));
