import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { BacktestInputError, listMarkets, parseRequest, runBacktest } from "../backtest-api.js";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("NOVA Backtest Lab requires Node.js 22 or newer. Update the Node runtime on PATH before running pnpm dev.");
const port = Number(process.env.PORT ?? 3000);
const assets: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/nova-storyboard.png": ["nova-storyboard.png", "image/png"],
};
let busy = false;
createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data, (_, v) => typeof v === "bigint" ? v.toString() : v));
  };
  if (!["127.0.0.1", "localhost", "[::1]"].some(host => req.headers.host === `${host}:${port}`)) { json(403, { error: "Local access only." }); return; }
  if (req.method === "POST" && req.url === "/api/backtest") {
    if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) { json(403, { error: "Cross-origin requests are not allowed." }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { json(415, { error: "Send JSON configuration." }); return; }
    if (busy) { json(429, { error: "A replay is already running. Please wait and try again." }); return; }
    busy = true;
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 4096) { json(413, { error: "Configuration is too large." }); return; }
      }
      let input;
      try { input = parseRequest(JSON.parse(body)); }
      catch (error) { json(400, { error: error instanceof Error ? error.message : "Invalid configuration." }); return; }
      try { json(200, await runBacktest(input)); }
      catch (error) {
        if (error instanceof BacktestInputError) { json(400, { error: error.message }); return; }
        console.error("Replay failed:", error instanceof Error ? error.message : "Unknown error");
        json(422, { error: "Replay unavailable. Retry when the Tokyo data service is available. Details are in the local server terminal." });
      }
    } catch { if (!res.headersSent) json(400, { error: "Could not read request." }); }
    finally { busy = false; }
    return;
  }
  if (req.method === "GET" && req.url === "/api/markets") {
    try { json(200, await listMarkets()); }
    catch (error) { console.error("Market discovery failed:", error instanceof Error ? error.message : "Unknown error"); json(502, { error: "Market list unavailable. The static market choices remain usable. Details are in the local server terminal." }); }
    return;
  }
  const asset = assets[req.url ?? ""];
  if (req.method !== "GET" || !asset) { json(404, { error: "Not found." }); return; }
  try {
    const contents = await readFile(new URL(`../../public/${asset[0]}`, import.meta.url));
    res.writeHead(200, { "Content-Type": asset[1] }); res.end(contents);
  } catch { json(500, { error: "Frontend asset unavailable." }); }
}).listen(port, "127.0.0.1", () => console.log(`NOVA Backtest Lab: http://localhost:${port} (read-only, local access)`));
