import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestLike, ResponseLike } from "./contract.js";

/**
 *  The local transport. An `IncomingMessage` already satisfies the request side of the contract —
 *  method, url, headers, and a body that iterates `Buffer`s whose `toString()` is the text — so it
 *  is passed through. A `ServerResponse` is not: `writeHead` carries an extra status-message
 *  overload and `setHeader` returns `this`, neither of which the contract promises, so the three
 *  members the routes call are given away explicitly rather than by an `as` that would let the
 *  compiler stop checking what the routes actually depend on.
 */
export function nodeResponse(res: ServerResponse): ResponseLike {
  return {
    setHeader: (name, value) => { res.setHeader(name, value as string | number | readonly string[]); },
    writeHead: (statusCode, headers) => { res.writeHead(statusCode, headers); },
    end: (chunk) => { res.end(chunk as never); },
  };
}

export function nodeRequest(req: IncomingMessage): RequestLike {
  return req;
}
