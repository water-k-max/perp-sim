import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { BacktestInputError, BacktestStorageError, listMarkets, parseRunRequest, runRequest } from "../backtest-api.js";
import { createClient } from "../client.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { loadMarketData } from "../data/ingest.js";
import { canonical, listDatasets, sha256 } from "../data/store.js";
import { listRuns, loadRun } from "../runs/store.js";
import { reconcileAccount } from "../verify/replay-account.js";
import { forwardStoredRun, forwardTestJson } from "../forward/forward.js";
import { resampleStoredRun } from "../resample/service.js";
import { resampleAccount } from "../resample/account.js";
import { parseResampleRequest } from "../resample/analysis.js";
import { parseImport, type ParsedImport } from "../resample/import.js";
import { runImportFlow } from "../resample/import-flow.js";
import { toRaw } from "../units.js";
import { BodyTooLarge, fetchSiteAllowed, hostAllowed, json, originAllowed, parsePublicOrigin, readJson, SECURITY_HEADERS } from "./http-kit.js";
import { LaneBusy, WorkLanes } from "./work-lanes.js";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("NOVA Backtest Lab requires Node.js 22 or newer. Update the Node runtime on PATH before running pnpm dev.");
const port = Number(process.env.PORT ?? 3000);
let publicOrigin;
try {
  publicOrigin = parsePublicOrigin(process.env.PERP_SIM_PUBLIC_ORIGIN);
} catch {
  throw new Error("PERP_SIM_PUBLIC_ORIGIN must be a bare http(s) origin, e.g. https://example.trycloudflare.com.");
}
const assets: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["../dist/web/app.js", "text/javascript; charset=utf-8"],
  "/nova-storyboard.png": ["nova-storyboard.png", "image/png"],
};

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
 *  reconcile, account resample and forward test are indexer-bound, and their wall clock is network
 *  waits that do overlap — and for the queue and the coalescing, which are pure wins. The number
 *  that does not depend on the thread is coalescing: eight identical resamples cost one job.
 */
const lanes = new WorkLanes({ concurrency: 2, queueLimit: 4 });

type Answer = { status: number; body: unknown };

/** The route plus its own validated request parameters, so "same key" means "the same request". */
const laneKey = (route: string, inputs: Record<string, unknown>): string => `${route}:${sha256(canonical(inputs))}`;

/**
 *  Run the work on the lane, then write what it answered to *this* socket.
 *
 *  Writing the response stays outside the shared work on purpose. Two callers whose keys match share
 *  one run, and a run that wrote its answer into the socket that happened to start it would leave
 *  the second caller connected and silent — so the work returns an `Answer` and every caller writes
 *  its own. Returns false only for a refusal, which is already answered here with a `Retry-After`.
 */
async function viaLane(res: ServerResponse, key: string, work: () => Promise<Answer>): Promise<boolean> {
  let answer: Answer;
  try {
    answer = await lanes.submit(key, work);
  } catch (error) {
    if (!(error instanceof LaneBusy)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    json(res, 429, {
      error: `The lab is running ${error.running} heavy job(s) with ${error.waiting} waiting. Try again in ${error.retryAfterSeconds} seconds.`,
      queue: { running: error.running, waiting: error.waiting, concurrency: error.concurrency, queueLimit: error.queueLimit },
    });
    return false;
  }
  json(res, answer.status, answer.body);
  return true;
}

createServer(async (req, res) => {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (!hostAllowed(req, port, publicOrigin)) { json(res, 403, { error: "Local access only." }); return; }
  if (url.pathname.startsWith("/api/") && !fetchSiteAllowed(req)) { json(res, 403, { error: "Cross-site requests are not allowed." }); return; }

  if (req.method === "POST" && url.pathname === "/api/backtest") {
    if (!originAllowed(req, port, publicOrigin)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
    let body: unknown;
    try { body = await readJson(req, 8192); }
    catch (error) {
      json(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "Configuration is too large." : "Could not read request." });
      return;
    }
    let parsed;
    try { parsed = parseRunRequest(body); }
    catch (error) { json(res, 400, { error: error instanceof Error ? error.message : "Invalid configuration." }); return; }
    // Parsing happens before the lane is asked for, so a request that was never going to run cannot
    // take a slot or fill the queue — and the key is the parsed run, so two clients whose JSON
    // differs only in key order still share one replay.
    await viaLane(res, laneKey("backtest", parsed), async () => {
      try {
        return { status: 200, body: await runRequest(parsed) };
      } catch (error) {
        if (error instanceof BacktestInputError) return { status: 400, body: { error: error.message } };
        if (error instanceof BacktestStorageError) {
          console.error("Storage fault:", error.message);
          return { status: 503, body: { error: "Local cache storage is unavailable. Check disk space and permissions, then retry.", detail: error.message } };
        }
        console.error("Replay failed:", error instanceof Error ? error.message : "Unknown error");
        return { status: 422, body: { error: "Data service unavailable. Retry." } };
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resample") {
    if (!originAllowed(req, port, publicOrigin)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
    let body: unknown;
    try { body = await readJson(req, 8192); }
    catch (error) {
      json(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "Configuration is too large." : "Could not read request." });
      return;
    }
    const runId = body && typeof body === "object" ? (body as Record<string, unknown>).runId : undefined;
    if (typeof runId !== "string" || !/^[a-f0-9]{64}$/.test(runId)) { json(res, 400, { error: "A full run digest is required." }); return; }
    const options = (body as Record<string, unknown>).resample;
    // Parsed before a lane is asked for, for the same reason the backtest body is: a block that can
    // never run is answered with its own 400 rather than spending a slot and a queue place on it.
    // The key is then the *parsed* request, so an omitted `paths` and `paths: 1000` — which the
    // parser resolves to the same job — share one run instead of being counted as two.
    let request: ReturnType<typeof parseResampleRequest>;
    try { request = parseResampleRequest(options); }
    catch (error) { json(res, 400, { error: error instanceof Error ? error.message : "Invalid resample configuration." }); return; }
    await viaLane(res, laneKey("resample", { runId, request }), async () => {
      try {
        const outcome = await resampleStoredRun(runId, options);
        return { status: 200, body: { runId, resample: { ...outcome.analysis, invariants: outcome.invariants } } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Resampling failed.";
        return { status: /No saved run/.test(message) ? 404 : 400, body: { error: message } };
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/trades/resample") {
    if (!originAllowed(req, port, publicOrigin)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
    let body: unknown;
    try { body = await readJson(req, 2_000_000); }
    catch (error) {
      json(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "The import is too large." : "Could not read request." });
      return;
    }
    let parsed: ParsedImport;
    try { parsed = parseImport(body); }
    catch (error) { json(res, 400, { error: error instanceof Error ? error.message : "Invalid import." }); return; }
    await viaLane(res, laneKey("trades-resample", parsed), async () => {
      try {
        return { status: 200, body: await runImportFlow(parsed, { createClient, listPerps, selectMarket, resolveConfig, loadMarketData }) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Import failed.";
        if (/no perp market matching|has no baseDecimals/.test(message)) return { status: 400, body: { error: message } };
        console.error("Import resample failed:", message);
        return { status: 422, body: { error: "Import resampling failed." } };
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/markets") {
    try { json(res, 200, await listMarkets()); }
    catch (error) { console.error("Market discovery failed:", error instanceof Error ? error.message : "Unknown error"); json(res, 502, { error: "Market list unavailable. The static market choices remain usable. Details are in the local server terminal." }); }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/runs") {
    try { json(res, 200, await listRuns()); }
    catch { json(res, 500, { error: "Saved runs could not be read." }); }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
    const id = url.pathname.slice("/api/runs/".length);
    if (!/^[a-f0-9]{64}$/.test(id)) { json(res, 400, { error: "A full run digest is required." }); return; }
    try {
      const entry = await loadRun(id);
      if (!entry) { json(res, 404, { error: "No saved run with that id." }); return; }
      json(res, 200, entry.result);
    } catch { json(res, 500, { error: "Saved run failed integrity verification." }); }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/datasets") {
    try { json(res, 200, { root: "local cache", datasets: await listDatasets(50) }); }
    catch (error) { console.error("Cache listing failed:", error instanceof Error ? error.message : "Unknown error"); json(res, 500, { error: "Cache listing failed. Details are in the local server terminal." }); }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/forward") {
    const runId = url.searchParams.get("runId") ?? "";
    const account = url.searchParams.get("account") ?? "";
    if (!/^[a-f0-9]{64}$/.test(runId)) { json(res, 400, { error: "A full run digest is required." }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(account)) { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    const to = Math.min(Math.floor(Date.now() / 1000), Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000)));
    const from = Number(url.searchParams.get("from") ?? to - 30 * 86_400);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to - from > 35 * 86_400 || from >= to) {
      json(res, 400, { error: "The forward-test window must be at most 35 days and end after it starts." });
      return;
    }
    await viaLane(res, laneKey("forward", { runId, account, from, to }), async () => {
      try {
        const result = await forwardStoredRun({ client: createClient().client, account, runId, fromSec: from, toSec: to });
        return { status: 200, body: forwardTestJson(result) };
      } catch (error) {
        if (error instanceof Error && error.message === "No saved run with that id.") return { status: 404, body: { error: "No saved run with that id." } };
        console.error("Forward test failed:", error instanceof Error ? error.message : "Unknown error");
        return { status: 422, body: { error: "Forward test failed." } };
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/resample")) {
    let account: string;
    try { account = decodeURIComponent(url.pathname.slice("/api/accounts/".length, -"/resample".length)); }
    catch { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(account)) { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    const paths = Number(url.searchParams.get("paths") ?? 1000);
    if (!Number.isInteger(paths) || paths < 100 || paths > 5000) { json(res, 400, { error: "paths must be a whole number from 100 to 5000." }); return; }
    const marketSymbol = url.searchParams.get("market") ?? "BTC";
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 14)));
    const seed = url.searchParams.get("seed") ?? "";
    const cash = url.searchParams.get("cash") ?? "1000";
    // The key is the request, not the clock: two identical URLs opened seconds apart share one read
    // of a window that moves by seconds, and once the job is done the next one re-reads afresh.
    await viaLane(res, laneKey("account-resample", { account, marketSymbol, days, paths, seed, cash }), async () => {
      try {
        const client = createClient().client;
        const market = await resolveConfig(client, selectMarket(await listPerps(client), marketSymbol));
        const to = Math.floor(Date.now() / 1000);
        const report = await reconcileAccount({ client, cfg: market, account, fromSec: to - days * 86_400, toSec: to });
        return { status: 200, body: await resampleAccount(report, { paths, seed, start: toRaw(cash, market.quoteDecimals), quoteDecimals: market.quoteDecimals }) };
      } catch (error) {
        console.error("Account resample failed:", error instanceof Error ? error.message : "Unknown error");
        return { status: 422, body: { error: "Account resample failed." } };
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/reconcile")) {
    let account: string;
    try { account = decodeURIComponent(url.pathname.slice("/api/accounts/".length, -"/reconcile".length)); }
    catch { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(account)) { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    const marketSymbol = url.searchParams.get("market") ?? "BTC";
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
    await viaLane(res, laneKey("account-reconcile", { account, marketSymbol, days }), async () => {
      try {
        const client = createClient().client;
        const market = await resolveConfig(client, selectMarket(await listPerps(client), marketSymbol));
        const to = Math.floor(Date.now() / 1000);
        const report = await reconcileAccount({ client, cfg: market, account, fromSec: to - days * 86_400, toSec: to });
        return { status: 200, body: report };
      } catch (error) {
        console.error("Reconciliation failed:", error instanceof Error ? error.message : "Unknown error");
        return { status: 422, body: { error: "Reconciliation failed." } };
      }
    });
    return;
  }

  const asset = assets[url.pathname];
  if (req.method !== "GET" || !asset) { json(res, 404, { error: "Not found." }); return; }
  try {
    const contents = await readFile(new URL(`../../public/${asset[0]}`, import.meta.url));
    res.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
    res.end(contents);
  } catch {
    json(res, 500, { error: "Frontend asset unavailable." });
  }
}).listen(port, "127.0.0.1", () => console.log(`NOVA Backtest Lab: http://localhost:${port} (read-only, local access${publicOrigin ? `, public origin ${publicOrigin.origin}` : ""})`));
