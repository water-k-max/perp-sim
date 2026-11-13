import assert from "node:assert/strict";
import { test } from "node:test";

/**
 *  The one thing the deployment entry has to get right is not a route — it is its own export shape.
 *
 *  `@vercel/node` loads the entry and decides how to call it by looking at what came out: an export
 *  carrying a `fetch` or an HTTP-method function is invoked as a Web handler, everything else — a bare
 *  default-exported function included — is invoked as the legacy `(req, res)` pair, which hands it
 *  `node:http`'s message and throws away the `Response` it returns. Getting that wrong is invisible at
 *  the build step and shows up as every route holding its slot until the invocation timeout, so the
 *  shape is asserted here, against the platform's own rule, rather than left to a deployment.
 */

// The methods the runtime will route to a handler, copied from the loader it ships.
const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"] as const;

/** `@vercel/node`'s `unwrapDefaults` + web-handler test, applied to a module namespace object. */
function isWebHandler(mod: unknown): boolean {
  let listener = mod as Record<string, unknown>;
  for (let i = 0; i < 5 && listener && listener.default; i++) listener = listener.default as Record<string, unknown>;
  return HTTP_METHODS.some(method => typeof listener[method] === "function") || typeof listener.fetch === "function";
}

test("the deployment entry is exported in the shape the platform invokes as a Web handler", async () => {
  const entry = await import("../../api/[...all].js");
  assert.equal(isWebHandler(entry), true, "the entry must carry a `fetch`, or the runtime calls it with (req, res)");

  // The same rule has to reject what this file used to export, or the assertion above is won by a
  // checker that accepts anything.
  assert.equal(isWebHandler({ default: async () => new Response() }), false);
  assert.equal(isWebHandler({ default: { get: async () => new Response() } }), false);
});
