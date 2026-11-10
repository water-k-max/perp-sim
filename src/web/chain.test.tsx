import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainBadge } from "./ChainBadge.js";
import type { ChainReport } from "./dto.js";

/**
 *  The topbar chain badge, rendered.
 *
 *  The gap this closes was a network name typed into a component ("Tokyo") while every read went to
 *  Hideki, so the only defence is that no chain name can reach the page except through a report the
 *  server produced. Each case below is rendered and searched for the words that must and must not be
 *  there; the `Tokyo` sweep on every state is the canary, because that literal is what the fix removed.
 */
const hideki: ChainReport = {
  name: "Hideki Testnet",
  readChainId: "50383",
  manifestChainId: "50383",
  indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql",
  testnet: true,
  agrees: true,
};
const drifted: ChainReport = { ...hideki, manifestChainId: "50321", agrees: false };

test("the badge names the chain in the report and never a chain it was not given", () => {
  const html = renderToStaticMarkup(ChainBadge({ report: hideki }));
  assert.match(html, /Hideki Testnet · 50383/);
  assert.match(html, /data-state="live"/);
  assert.doesNotMatch(html, /tokyo/i);
});

test("a manifest id that differs from the chain being read is shown as a mismatch", () => {
  const html = renderToStaticMarkup(ChainBadge({ report: drifted }));
  assert.match(html, /data-state="mismatch"/);
  assert.match(html, /Chain mismatch · 50383 ≠ 50321/);
  assert.match(html, /Reads and labels differ/);
  assert.doesNotMatch(html, /tokyo/i);
});

test("an unread chain says it is unread instead of borrowing a name", () => {
  const pending = renderToStaticMarkup(ChainBadge({ report: undefined }));
  assert.match(pending, /data-state="pending"/);
  assert.match(pending, /Checking chain/);
  assert.doesNotMatch(pending, /50383|50321|Hideki|tokyo/i);

  const failed = renderToStaticMarkup(ChainBadge({ report: null }));
  assert.match(failed, /data-state="unknown"/);
  assert.match(failed, /Chain unknown/);
  assert.doesNotMatch(failed, /50383|50321|Hideki|tokyo/i);
});

test("the badge is the only region markup the topbar needs, and it stays honest about scope", () => {
  const html = renderToStaticMarkup(ChainBadge({ report: hideki }));
  assert.match(html, /<div class="region"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /Read-only region/);
});
