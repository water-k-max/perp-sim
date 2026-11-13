import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopySimNote, type MirrorContext } from "./Wallet.js";

/**
 *  The copy-sim lens, rendered. Its job is honesty: a "Mirror" click resamples the trader's gross
 *  realized closes through the same engine the wallet always runs, so the banner must say in-sample
 *  (not a forecast), gross-only (not the net that ranked them), and size-matched. The canary that
 *  matters: a funding-driven net rank must surface the gap, or a user could read the copy-sim as
 *  reproducing income the mirror does not replicate. Fixtures are test data, not live figures.
 */
const ADDR = `0x${"8".repeat(40)}`;
const harvester: MirrorContext = { rank: 1, net: "87777.700000", gross: "4789.470000", fundingPaid: "-82988.230000" };
const render = (mirror: MirrorContext, over: { closedTrades?: number; cash?: string } = {}) =>
  renderToStaticMarkup(<CopySimNote mirror={mirror} account={ADDR} closedTrades={over.closedTrades ?? 905} quote="USDso" cash={over.cash ?? "1000"} />);

test("the copy-sim banner names itself in-sample, not a forecast, and cites the net rank", () => {
  const m = render(harvester);
  assert.ok(m.includes("Copy-sim"), "the section is named a copy-sim");
  assert.ok(m.includes("In-sample"), "the lens is named in-sample");
  assert.ok(m.includes("not a forecast"), "it disclaims prediction");
  assert.ok(m.includes("rank #1"), "it cites the net rank it must not be mistaken for");
  assert.ok(m.includes("0x8888"), "it shows the mirrored address");
  assert.ok(m.includes("905"), "it states how many realized closes are resampled");
});

test("the banner mirrors gross only and shows the net, gross and funding figures", () => {
  const m = render(harvester);
  assert.ok(m.includes("gross trade PnL only"), "gross-only is explicit");
  assert.ok(m.includes("4,789.470000"), "the gross figure the copy mirrors");
  assert.ok(m.includes("87,777.700000"), "the net rank figure");
  assert.ok(m.includes("-82,988.230000"), "the funding figure (negative = received)");
  assert.ok(m.includes("does not replicate"), "funding and fees are stated as not replicated");
});

test("CANARY: a funding-driven net rank surfaces the gap a trade copy cannot reproduce", () => {
  const m = render(harvester);
  assert.ok(m.includes("Funding received"), "names funding received as the driver");
  assert.ok(m.includes("would not reproduce that income"), "says mirroring trades cannot reproduce it");
});

test("the gap sentence is absent when net did not come from received funding", () => {
  // Funding paid (positive) drops net below gross: trading, not funding, drove the result.
  const payer: MirrorContext = { rank: 2, net: "10.000000", gross: "100.000000", fundingPaid: "90.000000" };
  assert.ok(!render(payer).includes("would not reproduce that income"), "no funding-income claim when funding was paid");
  // No funding at all: net equals gross.
  const pure: MirrorContext = { rank: 3, net: "50.000000", gross: "50.000000", fundingPaid: "0.000000" };
  assert.ok(!render(pure).includes("would not reproduce that income"), "no funding-income claim when net equals gross");
});

test("the banner states the size-match assumption and the cash buffer behind the bust rate", () => {
  const m = render(harvester, { cash: "2500" });
  assert.ok(m.includes("match their position size"), "the copy assumes matched size");
  assert.ok(m.includes("your PnL per close equals theirs"), "so the per-close PnL is the trader's");
  assert.ok(m.includes("2,500"), "the starting cash the bankruptcy rate is measured against");
  assert.ok(m.includes("bankruptcy rate"), "ties the cash to the bust rate");
});