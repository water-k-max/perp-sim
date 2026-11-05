import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { fetchSiteAllowed, hostAllowed, originAllowed, parsePublicOrigin } from "./http-kit.js";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("without a public origin, only loopback hosts and localhost origins are allowed", () => {
  assert.equal(hostAllowed(req({ host: "127.0.0.1:3000" }), 3000), true);
  assert.equal(hostAllowed(req({ host: "localhost:3000" }), 3000), true);
  assert.equal(hostAllowed(req({ host: "evil.example" }), 3000), false);
  assert.equal(originAllowed(req({ origin: "http://localhost:3000" }), 3000), true);
  assert.equal(originAllowed(req({ origin: "https://evil.example" }), 3000), false);
  assert.equal(originAllowed(req({}), 3000), true, "non-browser clients send no Origin");
  assert.equal(fetchSiteAllowed(req({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(fetchSiteAllowed(req({ "sec-fetch-site": "same-origin" })), true);
});

test("the configured public origin is the only extra host and origin accepted", () => {
  const publicOrigin = parsePublicOrigin("https://demo.trycloudflare.com");
  assert.ok(publicOrigin);
  assert.equal(publicOrigin.origin, "https://demo.trycloudflare.com");
  assert.deepEqual(publicOrigin.hosts, ["demo.trycloudflare.com"]);

  assert.equal(hostAllowed(req({ host: "demo.trycloudflare.com" }), 3000, publicOrigin), true);
  assert.equal(hostAllowed(req({ host: "other.trycloudflare.com" }), 3000, publicOrigin), false);
  assert.equal(originAllowed(req({ origin: "https://demo.trycloudflare.com" }), 3000, publicOrigin), true);
  assert.equal(originAllowed(req({ origin: "https://other.trycloudflare.com" }), 3000, publicOrigin), false);
  assert.equal(originAllowed(req({ origin: "http://demo.trycloudflare.com" }), 3000, publicOrigin), false, "scheme must match");

  const withPort = parsePublicOrigin("http://tunnel.example:8080");
  assert.ok(withPort);
  assert.deepEqual(withPort.hosts, ["tunnel.example:8080", "tunnel.example"]);
  assert.equal(hostAllowed(req({ host: "tunnel.example" }), 3000, withPort), true);
  assert.equal(hostAllowed(req({ host: "tunnel.example:8080" }), 3000, withPort), true);
});

test("malformed public origins are rejected and undefined means none", () => {
  assert.equal(parsePublicOrigin(undefined), null);
  assert.equal(parsePublicOrigin(""), null);
  assert.throws(() => parsePublicOrigin("ftp://demo.example"), /http\(s\) URL/);
  assert.throws(() => parsePublicOrigin("https://demo.example/path"), /origin, not a path/);
  assert.throws(() => parsePublicOrigin("not a url"), /Invalid URL/);
});
