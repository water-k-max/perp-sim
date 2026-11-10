import type { IncomingMessage, ServerResponse } from "node:http";

/**
 *  The small HTTP surface every route shares. Kept in one place so a new endpoint cannot
 *  forget the origin check or the body cap: those are the only things standing between a
 *  local read-only tool and a page that talks to it.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 *  A deployment may serve this loopback server through exactly one extra origin, such as
 *  an SSH or Cloudflare tunnel. It widens the same-origin definition only: the server
 *  still binds loopback, still serves read-only routes, and still rejects every other
 *  remote Host and Origin.
 */
export type PublicOrigin = { origin: string; hosts: string[] };

export function parsePublicOrigin(value: string | undefined): PublicOrigin | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not an http(s) URL");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("an origin, not a path");
  return {
    origin: url.origin,
    hosts: url.port ? [`${url.hostname}:${url.port}`, url.hostname] : [url.hostname],
  };
}

/** Only the loopback names this server binds to are acceptable Host headers, plus the configured tunnel origin if any. */
export function hostAllowed(req: IncomingMessage, port: number, publicOrigin: PublicOrigin | null = null): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].some((host) => req.headers.host === `${host}:${port}`) ||
    (publicOrigin !== null && publicOrigin.hosts.includes(req.headers.host ?? ""));
}

/** A state-changing POST must come from the page this server served, or from no origin at all. */
export function originAllowed(req: IncomingMessage, port: number, publicOrigin: PublicOrigin | null = null): boolean {
  if (!req.headers.origin) return true;
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, publicOrigin?.origin ?? null].includes(req.headers.origin);
}

/**
 *  Browsers stamp every request with `Sec-Fetch-Site`. A page on another site can trigger
 *  this server's work through tags (no Origin header is sent for an <img>), so API routes
 *  also reject anything the browser itself declares as not same-origin. Non-browser
 *  clients send no header and are unaffected.
 */
export function fetchSiteAllowed(req: IncomingMessage): boolean {
  const raw = req.headers["sec-fetch-site"];
  const site = Array.isArray(raw) ? raw[0] : raw;
  if (site === undefined) return true;
  return site === "same-origin" || site === "none";
}

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > maxBytes) throw new BodyTooLarge();
  }
  return JSON.parse(body);
}

export class BodyTooLarge extends Error {}
