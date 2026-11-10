import { handle } from "./app.js";
import type { RequestLike, ResponseLike, RouteContext } from "./contract.js";

/**
 *  The serverless transport: a Web `Request` in, a Web `Response` out, with the route table in
 *  `src/server/app.ts` doing the deciding.
 *
 *  This is the part a deployment cannot be wired without. `node:http`'s `createServer` callback has
 *  no port to listen on and no socket to keep open here, and a serverless function is handed one
 *  request and expected to return one response before the instance is put back. Everything else —
 *  which route answers what, what a refusal says, how a body is capped — is the same code the local
 *  lab runs, which is the point of the split.
 */

/** Header names are already lower-cased by `fetch`; the contract reads them the way `node:http` does. */
function requestLike(req: Request): RequestLike {
  const headers: Record<string, string | string[] | undefined> = {};
  req.headers.forEach((value, name) => { headers[name] = value; });
  // Which host the request was addressed to. A function receives an absolute URL, and its host is
  // the one the platform routed to, so that is what the route table's host check gets; a client's
  // own `Host` header is not consulted here because it is not what the request was delivered as.
  const addressed = safeHost(req.url);
  if (addressed) headers["host"] = addressed;
  return {
    method: req.method,
    url: `${req.url ?? ""}`,
    headers,
    [Symbol.asyncIterator]: chunks,
  };

  async function* chunks(): AsyncGenerator<{ toString(): string }> {
    if (!req.body) return;
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      // Decoded eagerly and captured: `readJson` calls `toString()` once per chunk, and a closure
      // that decoded on demand would hand back a different string the second time it was asked.
      const text = decoder.decode(value, { stream: true });
      yield { toString: () => text };
    }
  }
}

function safeHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 *  Where `setHeader` / `writeHead` / `end` go on a transport with no socket.
 *
 *  `setHeader` before `writeHead` is the order the lane refusal uses, and on `node:http` the two
 *  merge — `Retry-After` survives the `Content-Type` that follows it. This keeps that, rather than
 *  letting the last call win and quietly dropping the only header a waiting client needs.
 */
class Collector implements ResponseLike {
  private status = 200;
  private readonly headers = new Headers();
  private body: Uint8Array | string | undefined;

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers.set(name, Array.isArray(value) ? value.join(",") : String(value));
  }

  writeHead(statusCode: number, headers?: Record<string, string | number | string[]>): void {
    this.status = statusCode;
    for (const [name, value] of Object.entries(headers ?? {})) this.headers.set(name, Array.isArray(value) ? value.join(",") : String(value));
  }

  end(chunk?: unknown): void {
    if (chunk === undefined || chunk === null) return;
    if (typeof chunk === "string") { this.body = chunk; return; }
    if (chunk instanceof Uint8Array) { this.body = chunk; return; }
    this.body = String(chunk);
  }

  toResponse(): Response {
    // A status that forbids a body would make the constructor throw; nothing in the route table
    // produces one, so the case is closed rather than guessed at.
    const body = this.status === 204 || this.status === 304 ? null : this.body ?? null;
    return new Response(body as BodyInit | null, { status: this.status, headers: this.headers });
  }
}

export async function serve(ctx: RouteContext, req: Request): Promise<Response> {
  const collector = new Collector();
  await handle(ctx, requestLike(req), collector);
  return collector.toResponse();
}
