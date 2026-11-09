import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { BacktestInputError, BacktestStorageError, listMarkets, parseRunRequest, runRequest } from "../backtest-api.js";
import { createClient } from "../client.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { loadMarketData } from "../data/ingest.js";
import { listDatasets } from "../data/store.js";
import { listRuns, loadRun } from "../runs/store.js";
import { reconcileAccount } from "../verify/replay-account.js";
import { forwardStoredRun, forwardTestJson } from "../forward/forward.js";
import { resampleStoredRun } from "../resample/service.js";
import { resampleAccount } from "../resample/account.js";
import { parseImport, type ParsedImport } from "../resample/import.js";
import { runImportFlow } from "../resample/import-flow.js";
import { toRaw } from "../units.js";
import { BodyTooLarge, SingleFlight, fetchSiteAllowed, hostAllowed, json, originAllowed, parsePublicOrigin, readJson, SECURITY_HEADERS } from "./http-kit.js";

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

const flight = new SingleFlight();

createServer(async (req, res) => {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (!hostAllowed(req, port, publicOrigin)) { json(res, 403, { error: "Local access only." }); return; }
  if (url.pathname.startsWith("/api/") && !fetchSiteAllowed(req)) { json(res, 403, { error: "Cross-site requests are not allowed." }); return; }

  if (req.method === "POST" && url.pathname === "/api/backtest") {
    if (!originAllowed(req, port, publicOrigin)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
    if (!flight.tryAcquire()) { json(res, 429, { error: "A replay is already running. Please wait and try again." }); return; }
    try {
      let body: unknown;
      try { body = await readJson(req, 8192); }
      catch (error) {
        json(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "Configuration is too large." : "Could not read request." });
        return;
      }
      let parsed;
      try { parsed = parseRunRequest(body); }
      catch (error) { json(res, 400, { error: error instanceof Error ? error.message : "Invalid configuration." }); return; }
      try {
        const result = await runRequest(parsed);
        json(res, 200, result);
      } catch (error) {
        if (error instanceof BacktestInputError) { json(res, 400, { error: error.message }); return; }
        if (error instanceof BacktestStorageError) {
          console.error("Storage fault:", error.message);
          json(res, 503, { error: "Local cache storage is unavailable. Check disk space and permissions, then retry.", detail: error.message });
          return;
        }
        console.error("Replay failed:", error instanceof Error ? error.message : "Unknown error");
        json(res, 422, { error: "Data service unavailable. Retry." });
      }
    } finally {
      flight.release();
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resample") {
    if (!originAllowed(req, port, publicOrigin)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
    if (!flight.tryAcquire()) { json(res, 429, { error: "A replay is already running. Please wait and try again." }); return; }
    try {
      let body: unknown;
      try { body = await readJson(req, 8192); }
      catch (error) {
        json(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "Configuration is too large." : "Could not read request." });
        return;
      }
      const runId = body && typeof body === "object" ? (body as Record<string, unknown>).runId : undefined;
      if (typeof runId !== "string" || !/^[a-f0-9]{64}$/.test(runId)) { json(res, 400, { error: "A full run digest is required." }); return; }
      try {
        const outcome = await resampleStoredRun(runId, (body as Record<string, unknown>).resample);
        json(res, 200, { runId, resample: { ...outcome.analysis, invariants: outcome.invariants } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Resampling failed.";
        json(res, /No saved run/.test(message) ? 404 : 400, { error: message });
      }
    } finally {
      flight.release();
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/trades/resample") {
    if (!originAllowed(req, port, publicOrigin)) { json(res, 403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { json(res, 415, { error: "Send JSON configuration." }); return; }
    if (!flight.tryAcquire()) { json(res, 429, { error: "A replay is already running. Please wait and try again." }); return; }
    try {
      let body: unknown;
      try { body = await readJson(req, 2_000_000); }
      catch (error) {
        json(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "The import is too large." : "Could not read request." });
        return;
      }
      let parsed: ParsedImport;
      try { parsed = parseImport(body); }
      catch (error) { json(res, 400, { error: error instanceof Error ? error.message : "Invalid import." }); return; }
      try {
        json(res, 200, await runImportFlow(parsed, { createClient, listPerps, selectMarket, resolveConfig, loadMarketData }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Import failed.";
        if (/no perp market matching|has no baseDecimals/.test(message)) { json(res, 400, { error: message }); return; }
        console.error("Import resample failed:", message);
        json(res, 422, { error: "Import resampling failed." });
      }
    } finally {
      flight.release();
    }
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
    if (!flight.tryAcquire()) { json(res, 429, { error: "A replay is already running. Please wait and try again." }); return; }
    try {
      const result = await forwardStoredRun({ client: createClient().client, account, runId, fromSec: from, toSec: to });
      json(res, 200, forwardTestJson(result));
    } catch (error) {
      if (error instanceof Error && error.message === "No saved run with that id.") { json(res, 404, { error: "No saved run with that id." }); return; }
      console.error("Forward test failed:", error instanceof Error ? error.message : "Unknown error");
      json(res, 422, { error: "Forward test failed." });
    } finally {
      flight.release();
    }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/resample")) {
    let account: string;
    try { account = decodeURIComponent(url.pathname.slice("/api/accounts/".length, -"/resample".length)); }
    catch { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(account)) { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    const paths = Number(url.searchParams.get("paths") ?? 1000);
    if (!Number.isInteger(paths) || paths < 100 || paths > 5000) { json(res, 400, { error: "paths must be a whole number from 100 to 5000." }); return; }
    if (!flight.tryAcquire()) { json(res, 429, { error: "A replay is already running. Please wait and try again." }); return; }
    try {
      const client = createClient().client;
      const market = await resolveConfig(client, selectMarket(await listPerps(client), url.searchParams.get("market") ?? "BTC"));
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 14)));
      const to = Math.floor(Date.now() / 1000);
      const report = await reconcileAccount({ client, cfg: market, account, fromSec: to - days * 86_400, toSec: to });
      json(res, 200, await resampleAccount(report, { paths, seed: url.searchParams.get("seed") ?? "", start: toRaw(url.searchParams.get("cash") ?? "1000", market.quoteDecimals), quoteDecimals: market.quoteDecimals }));
    } catch (error) {
      console.error("Account resample failed:", error instanceof Error ? error.message : "Unknown error");
      json(res, 422, { error: "Account resample failed." });
    } finally {
      flight.release();
    }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/reconcile")) {
    let account: string;
    try { account = decodeURIComponent(url.pathname.slice("/api/accounts/".length, -"/reconcile".length)); }
    catch { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(account)) { json(res, 400, { error: "A 0x-prefixed 20-byte account address is required." }); return; }
    if (!flight.tryAcquire()) { json(res, 429, { error: "A replay is already running. Please wait and try again." }); return; }
    try {
      const client = createClient().client;
      const market = await resolveConfig(client, selectMarket(await listPerps(client), url.searchParams.get("market") ?? "BTC"));
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
      const to = Math.floor(Date.now() / 1000);
      const report = await reconcileAccount({ client, cfg: market, account, fromSec: to - days * 86_400, toSec: to });
      json(res, 200, report);
    } catch (error) {
      console.error("Reconciliation failed:", error instanceof Error ? error.message : "Unknown error");
      json(res, 422, { error: "Reconciliation failed." });
    } finally {
      flight.release();
    }
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
