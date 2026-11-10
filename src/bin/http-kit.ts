import type { PublicOrigin, RequestLike, ResponseLike } from "../server/contract.js";

/**
 *  The small HTTP surface every route shares. Kept in one place so a new endpoint cannot
 *  forget the origin check or the body cap: those are the only things standing between a
 *  local read-only tool and a page that talks to it.
 *
 *  The predicates are typed against `src/server/contract.ts` rather than `node:http` because the
 *  same answers have to hold when a serverless function receives a Web `Request`. `IncomingMessage`
 *  and `ServerResponse` satisfy both shapes, so the local server passes its own objects straight in.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/**
 *  A header the sender repeated arrives as an array; every policy here reads one value, so the
 *  first is used and no comparison silently runs against `undefined`.
 */
export function firstHeader(req: RequestLike, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function json(res: ResponseLike, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 *  A deployment may serve this loopback server through exactly one extra origin, such as
 *  an SSH or Cloudflare tunnel. It widens the same-origin definition only: the server
 *  still binds loopback, still serves read-only routes, and still rejects every other
 *  remote Host and Origin.
 */
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
export function hostAllowed(req: RequestLike, port: number, publicOrigin: PublicOrigin | null = null): boolean {
  const host = firstHeader(req, "host");
  return ["127.0.0.1", "localhost", "[::1]"].some((name) => host === `${name}:${port}`) ||
    (publicOrigin !== null && publicOrigin.hosts.includes(host ?? ""));
}

/**
 *  A deployment has no loopback interface to bind and no socket the Host header could have come
 *  from, so the Host is the only thing tying a request to this project. It is therefore checked
 *  against the configured public origin and nothing else: an unset origin answers every request
 *  with a refusal rather than guessing which host is ours.
 */
export function deploymentHostAllowed(req: RequestLike, publicOrigin: PublicOrigin | null): boolean {
  return publicOrigin !== null && publicOrigin.hosts.includes(firstHeader(req, "host") ?? "");
}

/** A state-changing POST must come from the page this server served, or from no origin at all. */
export function originAllowed(req: RequestLike, port: number, publicOrigin: PublicOrigin | null = null): boolean {
  const origin = firstHeader(req, "origin");
  if (!origin) return true;
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, publicOrigin?.origin ?? null].includes(origin);
}

/** The same rule on a deployment: the page and the API share one origin, so any other Origin is cross-site. */
export function deploymentOriginAllowed(req: RequestLike, publicOrigin: PublicOrigin | null): boolean {
  const origin = firstHeader(req, "origin");
  if (!origin) return true;
  return publicOrigin !== null && origin === publicOrigin.origin;
}

/**
 *  Browsers stamp every request with `Sec-Fetch-Site`. A page on another site can trigger
 *  this server's work through tags (no Origin header is sent for an <img>), so API routes
 *  also reject anything the browser itself declares as not same-origin. Non-browser
 *  clients send no header and are unaffected.
 */
export function fetchSiteAllowed(req: RequestLike): boolean {
  const site = firstHeader(req, "sec-fetch-site");
  if (site === undefined) return true;
  return site === "same-origin" || site === "none";
}

export async function readJson(req: RequestLike, maxBytes: number): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > maxBytes) throw new BodyTooLarge();
  }
  return JSON.parse(body);
}

export class BodyTooLarge extends Error {}
