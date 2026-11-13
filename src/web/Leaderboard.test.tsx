import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FundingPayment, PerpFeeRecord } from "@somnia-chain/markets-sdk";
import { netAccount, netLegs, rankLeaderboard } from "../verify/leaderboard.js";
import { BoardView, LeaderboardPanel, parse, type Board } from "./Leaderboard.js";

/**
 *  The leaderboard panel, rendered. Its job is to caveat itself: rank by net and not gross, keep the
 *  liquidation penalty out of net, call a truncated read partial, list a `review` row's reasons, and
 *  never let the vacuous-zero netting pass unlabelled. The board below is built through the real
 *  `netAccount`/`rankLeaderboard`, so the shapes are the server's and a divergence breaks the render
 *  test rather than the user's confidence.
 */
const FROM = 100;
const TO = 200;
const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const C = `0x${"c".repeat(40)}`;
const D = `0x${"d".repeat(40)}`;

const funding = (amount: bigint, t: number): FundingPayment => ({
  id: `fp${t}`, chainId: 50383, account: A, pool: "0xpool", amount: amount.toString(), timestamp: t.toString(), txHash: "0x",
});
const fee = (kind: string, amount: bigint, t: number): PerpFeeRecord => ({
  id: `fee${t}`, account: A, pool: "0xpool", amount: amount.toString(), isRebate: false, kind,
  insurancePortion: null, tier: null, fillNotional: null, builder: null, timestamp: t.toString(), txHash: "0x",
});
const g = (account: string, gross: bigint, closes: number, pools: string[]) => ({ account, gross, closes, pools: new Set(pools) });

/** A gross winner (A) that heavy funding drops to net last; B keeps the most net; C carries a liquidation penalty. */
function board(): Board {
  const a = netAccount({ gross: g(A, 100_000000n, 3, ["0xp1", "0xp2"]), legs: netLegs([funding(90_000000n, 110)], [], FROM, TO), fundingTruncated: false, feesTruncated: false });
  const b = netAccount({ gross: g(B, 50_000000n, 2, ["0xp1"]), legs: netLegs([], [], FROM, TO), fundingTruncated: false, feesTruncated: false });
  const c = netAccount({ gross: g(C, 30_000000n, 1, ["0xp1"]), legs: netLegs([], [fee("LiquidationFee", 5_000000n, 111)], FROM, TO), fundingTruncated: false, feesTruncated: false });
  const rows = rankLeaderboard([a, b, c], 6);
  return {
    fromSec: FROM, toSec: TO, quoteSymbol: "USDso", quoteDecimals: 6, discovered: 3, netted: 3, maxAccounts: 50,
    discovery: { rowsScanned: 6, rowsInWindow: 6, pages: 1, truncated: false, firstChangeSec: 110, lastChangeSec: 130 },
    rows, warnings: [],
  };
}
const wire = () => JSON.parse(JSON.stringify(board())) as unknown;
const rowOf = (markup: string, addr: string) => markup.split("<tr").find((s) => s.includes(addr)) ?? "";

test("parse accepts a well-formed board round-tripped through JSON", () => {
  const parsed = parse(wire());
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.quoteSymbol, "USDso");
  assert.equal(parsed.rows[0]!.account, B, "the real ranking put the net winner first");
});

test("parse rejects malformed wire before it can enter UI state", () => {
  const mutations: ((b: Record<string, unknown>) => void)[] = [
    (b) => { (b.rows as Record<string, unknown>[])[0]!.net = "not-a-decimal"; },
    (b) => { (b.rows as Record<string, unknown>[])[0]!.account = "0x123"; },
    (b) => { (b.rows as Record<string, unknown>[])[0]!.rank = 1.5; },
    (b) => { (b.rows as Record<string, unknown>[])[0]!.ok = "yes"; },
    (b) => { b.discovery = undefined; },
    (b) => { b.warnings = [1]; },
    (b) => { b.rows = "nope"; },
    (b) => { b.quoteDecimals = "6"; },
    (b) => { b.netted = -1; },
  ];
  for (const mutate of mutations) {
    const b = wire() as Record<string, unknown>;
    mutate(b);
    assert.throws(() => parse(b), /Unexpected response/);
  }
});

test("the board ranks by NET, not gross: funding drops the gross winner to last", () => {
  const markup = renderToStaticMarkup(<BoardView board={board()} />);
  const ia = markup.indexOf(A), ib = markup.indexOf(B), ic = markup.indexOf(C);
  assert.ok(ib < ic && ic < ia, "net order is B (50) > C (30) > A (10); a gross-only board would put A first");
  const rowA = rowOf(markup, A);
  assert.ok(rowA.includes(">10.000000<"), "A's net cell shows 10, not its 100 gross");
  assert.ok(rowA.includes(">100.000000<"), "A's gross cell still shows 100");
  assert.ok(rowA.indexOf(">10.000000<") < rowA.indexOf(">100.000000<"), "the net column precedes the gross column");
});

test("liquidation is shown in its own column and never folded into net", () => {
  const markup = renderToStaticMarkup(<BoardView board={board()} />);
  const rowC = rowOf(markup, C);
  assert.ok(rowC.includes(">30.000000<"), "C net equals its 30 gross — the 5 liquidation penalty is not deducted");
  assert.ok(rowC.includes(">5.000000<"), "the liquidation penalty appears in its own column");
  assert.ok(rowC.includes(">ok<"), "a known liquidation rail does not fail the row closed");
  assert.ok(markup.includes("shown separately and not deducted from net"), "C's liquidation warning is listed, not hidden in a tooltip");
});

test("a truncated discovery read is called partial, not a complete census", () => {
  const b = board();
  b.discovery = { ...b.discovery, truncated: true };
  const markup = renderToStaticMarkup(<BoardView board={b} />);
  assert.ok(markup.includes("Read stopped early."));
  assert.ok(markup.includes("tone-partial"));
  assert.ok(!markup.includes("Read drained."));
});

test("a review row lists its reasons and is not marked ok", () => {
  const d = netAccount({ gross: g(D, 20_000000n, 1, ["0xp1"]), legs: netLegs([funding(1n, 110)], [], FROM, TO), fundingTruncated: true, feesTruncated: false });
  const b = board();
  b.rows = rankLeaderboard([d], 6);
  b.netted = 1;
  const markup = renderToStaticMarkup(<BoardView board={b} />);
  assert.ok(markup.includes(">review<"), "a truncated leg fails the row closed");
  assert.ok(!markup.includes(">ok<"));
  assert.ok(markup.includes("funding read hit its page cap"), "the reason is rendered as text");
});

test("the global vacuous-zero warning renders when netting proved nothing", () => {
  const b = board();
  b.warnings = ["net equals gross for every ranked account: no funding payments or trade fees were recorded in this window, so the netting leg cannot fail here."];
  const markup = renderToStaticMarkup(<BoardView board={b} />);
  assert.ok(markup.includes("net equals gross for every ranked account"));
  assert.ok(markup.includes("netting leg cannot fail here"));
});

test("an empty board says there is nothing to rank, not a zeroed table", () => {
  const b = board();
  b.rows = [];
  b.netted = 0;
  const markup = renderToStaticMarkup(<BoardView board={b} />);
  assert.ok(markup.includes("nothing to rank"));
  assert.ok(!markup.includes("<table"));
});

test("the panel states the net formula, the separate liquidation rail, and that it is not a forecast", () => {
  const markup = renderToStaticMarkup(<LeaderboardPanel />);
  assert.ok(markup.includes("net realized = gross realized"));
  assert.ok(markup.includes("funding paid"));
  assert.ok(markup.includes("trade fees"));
  assert.ok(markup.includes("Liquidation penalties are listed separately"));
  assert.ok(markup.includes("not a forecast"));
  assert.ok(markup.includes("Rank traders"), "the read runs on an explicit click");
  assert.ok(!markup.includes("<table"), "no heavy venue read fires on mount");
});

test("with onPick wired each account is a Verify button; without it, plain code and no dead button", () => {
  const picked = renderToStaticMarkup(<BoardView board={board()} onPick={() => {}} />);
  assert.equal(picked.split("<button").length - 1, 3, "one clickable account per ranked row");
  assert.ok(picked.includes("lb-pick"), "the account cell is the verify affordance");
  assert.ok(picked.includes(`title="Verify ${A} across all markets over this window"`), "the button says what clicking does");
  assert.ok(rowOf(picked, A).includes(`>${A}</button>`), "the full address is the click target, not a truncated label");
  assert.ok(!picked.includes('<code class="lb-account" title='), "the account cell is a button, not inert code");

  const plain = renderToStaticMarkup(<BoardView board={board()} />);
  assert.ok(plain.includes('<code class="lb-account" title='), "standalone board keeps the address as plain code");
  assert.ok(!plain.includes("lb-pick"), "no verify button when onPick is absent");
  assert.ok(!plain.includes("<button"), "no dead click target without a handler");
});

test("with onMirror each row carries a Mirror button; without it none — and it is independent of Verify", () => {
  const mirrored = renderToStaticMarkup(<BoardView board={board()} onMirror={() => {}} />);
  assert.equal(mirrored.split("lb-mirror").length - 1, 3, "one Mirror button per ranked row");
  assert.ok(mirrored.includes(`title="Mirror ${B}: copy-sim their realized closes against your starting cash"`), "the button says what mirroring does");
  assert.ok(rowOf(mirrored, B).includes(">Mirror</button>"), "the Mirror button sits in the row of the trader it copies");
  assert.ok(mirrored.includes('<code class="lb-account" title='), "onMirror alone keeps the address plain code; Verify is a separate affordance");

  const both = renderToStaticMarkup(<BoardView board={board()} onPick={() => {}} onMirror={() => {}} />);
  assert.equal(both.split("<button").length - 1, 6, "Verify + Mirror per row when both are wired");

  const plain = renderToStaticMarkup(<BoardView board={board()} />);
  assert.ok(!plain.includes("lb-mirror"), "no Mirror button without a handler");
});