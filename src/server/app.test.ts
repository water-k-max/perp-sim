import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import { LaneBusy, WorkLanes } from "../bin/work-lanes.js";
import { parsePublicOrigin } from "../bin/http-kit.js";
import { handle } from "./app.js";
import { nodeRequest, nodeResponse } from "./node-transport.js";
import { serve } from "./web-transport.js";
import type { RouteContext } from "./contract.js";

/**
 *  One route table, two transports.
 *
 *  The deployment entry exists only because the routes stopped being `node:http`-shaped, so these
 *  tests are what stands between that refactor and a second, quietly different answer set: the same
 *  probes go to a real loopback server and to the Web handler, and status and body must match.
 *  Nothing here reaches the network — the indexer-bound and disk-bound routes are deliberately not
 *  in the shared set, only answers decided before any data is read (refusals, caps, parse errors,
 *  404s). Where the two transports are *supposed* to disagree, that is asserted as a difference.
 */

const DEPLOYMENT_ORIGIN = "https://lab.example";
const VALID_ADDRESS = `0x${"0".repeat(40)}`;

const webCtx: RouteContext = {
  deployment: { mode: "serverless" },
  publicOrigin: parsePublicOrigin(DEPLOYMENT_ORIGIN),
  lanes: new WorkLanes({ concurrency: 2, queueLimit: 4 }),
};

let localServer: Server | null = null;
async function localPort(): Promise<number> {
  if (localServer) return (localServer.address() as AddressInfo).port;
  // Port 0, so no test can collide with a lab already running on a fixed port; the lanes are the
  // local server's own policy.
  localServer = createServer((req, res) => {
    // The host check needs the port, and the port is only known after listen(), so the context is
    // taken from the socket that is actually answering.
    const port = (localServer?.address() as AddressInfo).port;
    void handle({ deployment: { mode: "local", port }, publicOrigin: null, lanes: new WorkLanes({ concurrency: 2, queueLimit: 4 }) }, nodeRequest(req), nodeResponse(res));
  });
  await new Promise<void>((resolve) => localServer?.listen(0, "127.0.0.1", resolve));
  return (localServer.address() as AddressInfo).port;
}

after(() => new Promise<void>((resolve, reject) => localServer?.close((error) => (error ? reject(error) : resolve()))));

type Probe = { label: string; method?: string; body?: string; contentType?: string; secFetchSite?: string };

/** The same probe, addressed to each transport the way a real caller would address it. */
async function both(probe: Probe): Promise<{ local: { status: number; text: string }; web: { status: number; text: string } }> {
  const port = await localPort();
  const headers: Record<string, string> = {};
  if (probe.contentType) headers["content-type"] = probe.contentType;
  if (probe.secFetchSite) headers["sec-fetch-site"] = probe.secFetchSite;
  const init = { method: probe.method ?? "GET", headers, body: probe.body };

  const localResponse = await fetch(`http://127.0.0.1:${port}${probe.label}`, init);
  const webResponse = await serve(webCtx, new Request(`${DEPLOYMENT_ORIGIN}${probe.label}`, init));
  return {
    local: { status: localResponse.status, text: await localResponse.text() },
    web: { status: webResponse.status, text: await webResponse.text() },
  };
}

const SHARED: Probe[] = [
  { label: "/api/chain" },
  { label: "/api/no-such-route" },
  // Rejected by its own parameters, before a lane is asked for — which is the point: every probe in
  // this list is answered without a network read and without a job, on either transport.
  { label: `/api/accounts/${VALID_ADDRESS}/resample?paths=5` },
  { label: `/api/accounts/${VALID_ADDRESS}/resample?paths=1000&cash=-5` },
  { label: `/api/accounts/${VALID_ADDRESS}/resample?paths=1000&cash=1e3` },
  { label: "/api/accounts/not-an-address/reconcile" },
  { label: "/api/backtest", method: "POST", body: "{}" },
  { label: "/api/backtest", method: "POST", body: "5", contentType: "application/json" },
  { label: "/api/backtest", method: "POST", body: "not json at all", contentType: "application/json" },
  { label: "/api/backtest", method: "POST", body: "x".repeat(20_000), contentType: "application/json" },
  { label: "/api/trades/resample", method: "POST", body: "{}", contentType: "application/json" },
  { label: "/api/chain", secFetchSite: "cross-site" },
  { label: "/api/backtest", method: "POST", body: "{}", contentType: "application/json", secFetchSite: "cross-site" },
];

for (const probe of SHARED) {
  test(`${probe.method ?? "GET"} ${probe.label} answers the same over both transports`, async () => {
    const { local, web } = await both(probe);
    assert.equal(web.status, local.status, `${web.status} on the deployment vs ${local.status} locally`);
    assert.equal(web.text, local.text, "one route must not answer with different words on the two transports");
  });
}

test("a starting cash that is not a positive amount is refused, not simulated", async () => {
  // Bankruptcy rate is measured against this number, so a sign or a typo must not reach the
  // walker and come back as a bust rate. Refused by parameter, before a lane or a chain read.
  for (const cash of ["-5", "0", "abc", "1e3", ".5", "5,0"]) {
    const { local, web } = await both({ label: `/api/accounts/${VALID_ADDRESS}/resample?paths=1000&cash=${encodeURIComponent(cash)}` });
    assert.equal(local.status, 400, `cash=${cash} must be refused, got ${local.status}`);
    assert.match(local.text, /cash/, `cash=${cash} refused for the wrong reason: ${local.text}`);
    assert.equal(web.status, 400, `cash=${cash} must be refused on the deployment too`);
  }
});

test("the body cap is enforced while streaming, not after buffering", async () => {
  const { local, web } = await both({ label: "/api/backtest", method: "POST", body: `{"cash":"${"9".repeat(30_000)}"}`, contentType: "application/json" });
  assert.equal(local.status, 413);
  assert.equal(web.status, 413, "the Web transport must refuse an oversized body the same way, from the stream");
});

test("the deployment refuses the two run-store routes, and says why", async () => {
  const refusal = await serve(webCtx, new Request(`${DEPLOYMENT_ORIGIN}/api/resample`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: "f".repeat(64) }),
  }));
  assert.equal(refusal.status, 501);
  assert.match(await refusal.text(), /no durable disk/);

  const list = await serve(webCtx, new Request(`${DEPLOYMENT_ORIGIN}/api/runs`));
  assert.equal(list.status, 501);
  assert.match(await list.text(), /saved-run list/);

  // Locally the same request is not refused: it reaches its own answer. That is what makes the 501
  // above a deployment policy rather than a route that was broken by the refactor.
  const port = await localPort();
  const local = await fetch(`http://127.0.0.1:${port}/api/resample`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: "f".repeat(64), resample: { paths: 100 } }),
  });
  assert.notEqual(local.status, 501);
  assert.match(await local.text(), /No saved run|Local cache|resample|"error"/);
});

test("a static page is not the function's job on a deployment", async () => {
  const port = await localPort();
  const local = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(local.status, 200, "the local server still serves the page itself");
  assert.match(local.headers.get("content-type") ?? "", /text\/html/);

  const web = await serve(webCtx, new Request(`${DEPLOYMENT_ORIGIN}/`));
  assert.equal(web.status, 404, "the CDN serves it; a function that also served it would drift from the build output");
});

test("a deployment with no configured origin answers every request with a refusal", async () => {
  const ctx: RouteContext = { deployment: { mode: "serverless" }, publicOrigin: null, lanes: webCtx.lanes };
  for (const path of ["/api/chain", "/api/markets", `/api/accounts/${VALID_ADDRESS}/reconcile`]) {
    const response = await serve(ctx, new Request(`${DEPLOYMENT_ORIGIN}${path}`));
    assert.equal(response.status, 403, `${path} must not be answered when this deployment cannot name its own host`);
  }
});

test("a request addressed to someone else's host is refused by the deployment", async () => {
  const response = await serve(webCtx, new Request("https://evil.example/api/chain"));
  assert.equal(response.status, 403);
  assert.match(await response.text(), /its own host/);
});

test("a lane refusal keeps Retry-After after the response headers are written", async () => {
  const ctx: RouteContext = {
    deployment: { mode: "serverless" },
    publicOrigin: webCtx.publicOrigin,
    lanes: { submit: async () => { throw new LaneBusy(2, 4, 2, 4); } },
  };
  const response = await serve(ctx, new Request(`${DEPLOYMENT_ORIGIN}/api/accounts/${VALID_ADDRESS}/reconcile`));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "2", "the queue answer is worth nothing if the wait is dropped by the second header write");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.match(await response.text(), /"running":2,"waiting":4,"concurrency":2,"queueLimit":4/);
});

test("every answer carries the security headers, refusals included", async () => {
  const response = await serve(webCtx, new Request("https://evil.example/api/chain"));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
});
