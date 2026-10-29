import type { IncomingMessage, ServerResponse } from "node:http";

/**
 *  The small HTTP surface every route shares. Kept in one place so a new endpoint cannot
 *  forget the origin check or the body cap: those are the only things standing between a
 *  local read-only tool and a page that talks to it.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Only the loopback names this server binds to are acceptable Host headers. */
export function hostAllowed(req: IncomingMessage, port: number): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].some((host) => req.headers.host === `${host}:${port}`);
}

/** A state-changing POST must come from the page this server served, or from no origin at all. */
export function originAllowed(req: IncomingMessage, port: number): boolean {
  if (!req.headers.origin) return true;
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin);
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

/** One expensive replay at a time, so a busy page cannot stack indexer reads. */
export class SingleFlight {
  private running = false;

  tryAcquire(): boolean {
    if (this.running) return false;
    this.running = true;
    return true;
  }

  release(): void {
    this.running = false;
  }
}
