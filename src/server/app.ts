import { readFile } from "node:fs/promises";
import { BacktestInputError, BacktestStorageError, listMarkets, parseRunRequest, runRequest } from "../backtest-api.js";
import { chainReport, createClient } from "../client.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { loadMarketData } from "../data/ingest.js";
import { onceLive } from "../data/live-cache.js";
import { canonical, listDatasets, sha256 } from "../data/store.js";
import { listRuns, loadRun } from "../runs/store.js";
import { reconcileAccount } from "../verify/replay-account.js";
import { replayAccountAllMarkets } from "../verify/replay-account-all.js";
import { buildLeaderboard } from "../verify/leaderboard.js";
import { resampleStoredRun } from "../resample/service.js";
import { resampleAccount } from "../resample/account.js";
import { parseResampleRequest } from "../resample/analysis.js";
import { parseImport, type ParsedImport } from "../resample/import.js";
import { runImportFlow } from "../resample/import-flow.js";
import { toRaw } from "../units.js";
import {
  BodyTooLarge,
  deploymentHostAllowed,
  deploymentOriginAllowed,
  fetchSiteAllowed,
  firstHeader,
  hostAllowed,
  json,
  originAllowed,
  readJson,
  SECURITY_HEADERS,
} from "../bin/http-kit.js";
import { LaneBusy } from "../bin/work-lanes.js";
import type { Answer, RequestLike, ResponseLike, RouteContext } from "./contract.js";

/**
 *  The whole route table, once.
 *
 *  This used to live inside the `createServer` callback in `src/bin/web.ts`, which meant it could
 *  only ever be spoken to through `node:http`. It is here so that the same answers — the same refusals,
 *  the same body caps, the same lane keys and the same error mapping — are what a serverless function
 *  returns, instead of a second table that quietly disagrees with the first.
 */

/** Files the local server reads off disk. A deployment serves these from its CDN and never calls them here. */
const assets: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["../dist/web/app.js", "text/javascript; charset=utf-8"],
  "/nova-storyboard.png": ["nova-storyboard.png", "image/png"],
};

/** The route plus its own validated request parameters, so "same key" means "the same request". */
const laneKey = (route: string, inputs: Record<string, unknown>): string => `${route}:${sha256(canonical(inputs))}`;

/**
 *  Run the work on the lane, then write what it answered to *this* connection.
 *
 *  Writing the response stays outside the shared work on purpose. Two callers whose keys match share
 *  one run, and a run that wrote its answer into the socket that happened to start it would leave
 *  the second caller connected and silent — so the work returns an `Answer` and every caller writes
 *  its own. Returns false only for a refusal, which is already answered here with a `Retry-After`.
 */
async function viaLane(ctx: RouteContext, res: ResponseLike, key: string, work: () => Promise<Answer>): Promise<boolean> {
  let answer: Answer;
  try {
    answer = await ctx.lanes.submit(key, work);
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

/**
 *  What a deployment refuses and why, in one table, so the refusal is a stated policy rather than
 *  something the caller discovers by trial and error. Both entries are about the same fact: the run
 *  store is a directory on the machine that ran the backtest, and a serverless instance has no
 *  directory that outlives the request that wrote it.
 */
const serverlessRefusal = (route: string): Answer => ({
  status: 501,
  body: {
    error: `${route} reads the run store from this machine's disk. A deployment has no durable disk, so saved runs and the resampling of a saved run belong to the local server.`,
  },
});

export async function handle(ctx: RouteContext, req: RequestLike, res: ResponseLike): Promise<void> {
  const local = ctx.deployment.mode === "local";
  const port = local ? ctx.deployment.port : 0;
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  const url = new URL(req.url ?? "/", local ? `http://127.0.0.1:${port}` : (ctx.publicOrigin?.origin ?? "http://localhost"));
  const hostOk = local ? hostAllowed(req, port, ctx.publicOrigin) : deploymentHostAllowed(req, ctx.publicOrigin);
  if (!hostOk) { json(res, 403, { error: local ? "Local access only." : "This deployment only answers its own host." }); return; }
  if (url.pathname.startsWith("/api/") && !fetchSiteAllowed(req)) { json(res, 403, { error: "Cross-site requests are not allowed." }); return; }

  const sameOrigin = (req: RequestLike): boolean => (local ? originAllowed(req, port, ctx.publicOrigin) : deploymentOriginAllowed(req, ctx.publicOrigin));

  if (req.method === "POST" && url.pathname === "/api/backtest") {
    if (!sameOrigin(req)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!firstHeader(req, "content-type")?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
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
    await viaLane(ctx, res, laneKey("backtest", parsed), async () => {
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
    // A deployment cannot honour this one: `resampleStoredRun` re-opens the saved bundle and verifies
    // its digest, and the bundle was written to the disk of whichever instance ran the backtest.
    // Answering 501 says that plainly; letting it 404 would blame the user for our storage.
    if (!local) { const refusal = serverlessRefusal("Re-resampling a saved run"); json(res, refusal.status, refusal.body); return; }
    if (!sameOrigin(req)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!firstHeader(req, "content-type")?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
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
    await viaLane(ctx, res, laneKey("resample", { runId, request }), async () => {
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
    if (!sameOrigin(req)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!firstHeader(req, "content-type")?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
    let body: unknown;
    try { body = await readJson(req, 2_000_000); }
    catch (error) {
      json(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "The import is too large." : "Could not read request." });
      return;
    }
    let parsed: ParsedImport;
    try { parsed = parseImport(body); }
    catch (error) { json(res, 400, { error: error instanceof Error ? error.message : "Invalid import." }); return; }
    await viaLane(ctx, res, laneKey("trades-resample", parsed), async () => {
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

  // Which network this process reads, from the module that builds the client rather than from a
  // string in a component. No lane and no network: it answers from this process's own config.
  if (req.method === "GET" && url.pathname === "/api/chain") { json(res, 200, chainReport()); return; }

  if (req.method === "GET" && url.pathname === "/api/markets") {
    try { json(res, 200, await listMarkets()); }
    catch (error) { console.error("Market discovery failed:", error instanceof Error ? error.message : "Unknown error"); json(res, 502, { error: "Market list unavailable. The static market choices remain usable. Details are in the server log." }); }
    return;
  }

  // The net realized leaderboard: discover the accounts that closed positions in the window and rank
  // them by gross minus funding minus trade fees. A heavy venue-wide read, so it takes a lane like the
  // wallet paths; the window and the account cap are the request, so two identical URLs share one read.
  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
    const maxAccounts = Math.min(100, Math.max(1, Number(url.searchParams.get("maxAccounts") ?? 50)));
    if (!Number.isInteger(days) || !Number.isInteger(maxAccounts)) { json(res, 400, { error: "days and maxAccounts must be whole numbers." }); return; }
    await viaLane(ctx, res, laneKey("leaderboard", { days, maxAccounts }), async () => {
      try {
        const client = createClient().client;
        const to = Math.floor(Date.now() / 1000);
        const board = await buildLeaderboard({ client, fromSec: to - days * 86_400, toSec: to, maxAccounts });
        return { status: 200, body: board };
      } catch (error) {
        console.error("Leaderboard failed:", error instanceof Error ? error.message : "Unknown error");
        return { status: 422, body: { error: "Leaderboard read failed." } };
      }
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/api/runs" || url.pathname.startsWith("/api/runs/"))) {
    if (!local) { const refusal = serverlessRefusal("The saved-run list"); json(res, refusal.status, refusal.body); return; }
    if (url.pathname === "/api/runs") {
      try { json(res, 200, await listRuns()); }
      catch { json(res, 500, { error: "Saved runs could not be read." }); }
      return;
    }
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
    catch (error) { console.error("Cache listing failed:", error instanceof Error ? error.message : "Unknown error"); json(res, 500, { error: "Cache listing failed. Details are in the server log." }); }
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
    const cash = (url.searchParams.get("cash") ?? "1000").trim();
    // Starting cash is the assumption every bankruptcy rate on this page rests on, so a sign or a
    // typo must not quietly become a path that starts at zero and reports the result as a bust rate.
    if (!/^\d+(?:\.\d+)?$/.test(cash) || Number(cash) <= 0) { json(res, 400, { error: "cash must be a positive decimal amount." }); return; }
    // The key is the request, not the clock: two identical URLs opened seconds apart share one read
    // of a window that moves by seconds, and once the job is done the next one re-reads afresh.
    await viaLane(ctx, res, laneKey("account-resample", { account, marketSymbol, days, paths, seed, cash }), async () => {
      try {
        const client = createClient().client;
        const to = Math.floor(Date.now() / 1000);
        const fromSec = to - days * 86_400;
        // `market=ALL` reconciles every listed market and aggregates; the single-market path below is
        // unchanged. The lane key already carries marketSymbol, so the two never share a run.
        if (marketSymbol.trim().toUpperCase() === "ALL") {
          const portfolio = await replayAccountAllMarkets({ client, account, fromSec, toSec: to });
          const body = await resampleAccount(portfolio.input, { paths, seed, start: toRaw(cash, portfolio.quoteDecimals), quoteDecimals: portfolio.quoteDecimals, quoteSymbol: portfolio.quoteSymbol });
          return { status: 200, body: { ...body, markets: portfolio.markets, marketsRead: portfolio.marketsRead, marketsWithFills: portfolio.marketsWithFills } };
        }
        const selected = selectMarket(await onceLive("perp-markets", () => listPerps(client)), marketSymbol);
        const market = await onceLive(`perp-config:${selected.poolAddress}`, () => resolveConfig(client, selected));
        const report = await reconcileAccount({ client, cfg: market, account, fromSec, toSec: to });
        return { status: 200, body: await resampleAccount(report, { paths, seed, start: toRaw(cash, market.quoteDecimals), quoteDecimals: market.quoteDecimals, quoteSymbol: market.quoteSymbol }) };
      } catch (error) {
        console.error("Account resample failed:", error instanceof Error ? error.message : "Unknown error");
        return { status: 422, body: { error: `Account resample failed: ${error instanceof Error ? error.message : "Unknown error"}` } };
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
    await viaLane(ctx, res, laneKey("account-reconcile", { account, marketSymbol, days }), async () => {
      try {
        const client = createClient().client;
        const selected = selectMarket(await onceLive("perp-markets", () => listPerps(client)), marketSymbol);
        const market = await onceLive(`perp-config:${selected.poolAddress}`, () => resolveConfig(client, selected));
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

  const asset = local ? assets[url.pathname] : undefined;
  if (req.method !== "GET" || !asset) { json(res, 404, { error: "Not found." }); return; }
  try {
    const contents = await readFile(new URL(`../../public/${asset[0]}`, import.meta.url));
    res.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
    res.end(contents);
  } catch {
    json(res, 500, { error: "Frontend asset unavailable." });
  }
}
