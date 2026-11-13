import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
 *
 *  Every file in `api/` is checked, not just the catch-all: the deep routes are their own function
 *  files now (the deployed catch-all matched only one segment), and each one re-exports the shared
 *  handler. A re-export that dropped the `fetch` would reintroduce the legacy-invocation hang on
 *  exactly the routes the split was meant to fix, so the guard walks the whole directory.
 */

// The methods the runtime will route to a handler, copied from the loader it ships.
const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"] as const;

/** `@vercel/node`'s `unwrapDefaults` + web-handler test, applied to a module namespace object. */
function isWebHandler(mod: unknown): boolean {
  let listener = mod as Record<string, unknown>;
  for (let i = 0; i < 5 && listener && listener.default; i++) listener = listener.default as Record<string, unknown>;
  return HTTP_METHODS.some(method => typeof listener[method] === "function") || typeof listener.fetch === "function";
}

const apiDir = fileURLToPath(new URL("../../api/", import.meta.url));
function entryFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...entryFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const entries = entryFiles(apiDir);

test("the api directory has the catch-all and the deep-route files the routing fix added", () => {
  const names = entries.map(f => relative(apiDir, f).replace(/\\/g, "/")).sort();
  assert.ok(names.includes("[...all].ts"), "the catch-all entry must exist");
  for (const expected of ["accounts/[account]/resample.ts", "accounts/[account]/reconcile.ts", "trades/resample.ts", "runs/[id].ts"]) {
    assert.ok(names.includes(expected), `missing deep-route entry ${expected}; the deployed catch-all 404s these paths`);
  }
});

for (const file of entries) {
  const label = relative(apiDir, file).replace(/\\/g, "/");
  test(`api/${label} is exported in the shape the platform invokes as a Web handler`, async () => {
    const entry = await import(pathToFileURL(file).href);
    assert.equal(isWebHandler(entry), true, "the entry must carry a `fetch`, or the runtime calls it with (req, res)");
  });
}

test("the shape rule rejects what a broken entry would export", () => {
  // The same rule has to reject what these files used to export, or the assertions above are won by a
  // checker that accepts anything.
  assert.equal(isWebHandler({ default: async () => new Response() }), false);
  assert.equal(isWebHandler({ default: { get: async () => new Response() } }), false);
});