import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, keccak256, toFunctionSelector, type TransactionReceipt } from "viem";
import { orderBookEventsAbi } from "@somnia-chain/markets-sdk";
import { assertFresh } from "./reader.js";
import { readerFixture } from "./reader.fixture.js";
import { address, ARENA, decimal, parseArgs, type Options } from "./input.js";
import { Journal } from "./journal.js";
import { runTrade, type Ports, type Snapshot } from "./workflow.js";
import { preflight as checkedPreflight, assertStopsCannotExecute, receiptState, PLACE_SELECTOR, CANCEL_SELECTOR } from "./adapter.js";
const preflight = (rpc: Parameters<typeof checkedPreflight>[0], o: Options) => checkedPreflight(rpc, o, operator);

const owner = address("0x1111111111111111111111111111111111111111");
const operator = address("0x2222222222222222222222222222222222222222");
const pool = address("0x3333333333333333333333333333333333333333");
const bank = address("0x4444444444444444444444444444444444444444");
const baseArgs = ["--owner", owner, "--operator", operator, "--pool", pool, "--side", "long", "--qty", "1", "--price", "1", "--gas", "100000", "--max-gas-spend", "0.1"];
const options = (): Options => parseArgs(baseArgs);
const raw = "0x1234" as const;
const hash = keccak256(raw);
const snapshot: Snapshot = { quantity: 100n, price: 100n, position: 0n, marginBank: bank, baseDecimals: 2, report: {}, blockNumber: 5n, blockHash: hash, blockTimestamp: 1000n, capturedAt: Date.now() };
function fixture(t: { after(fn: () => void): void }, overrides: Partial<Ports> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "perp-sim-trade-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let loads = 0, signs = 0, sends = 0, checks = 0;
  const outputs: unknown[] = [];
  const journal = new Journal(dir);
  const receipt = { transactionHash: hash, status: "success", logs: [], gasUsed: 20n, effectiveGasPrice: 1n, blockNumber: 5n, blockHash: hash } as unknown as TransactionReceipt;
  const ports: Ports = {
    chainId: async () => 50383, initialize: async () => {}, assertFresh: async () => {},
    loadSigner: async () => { loads++; return operator; },
    preflight: async () => { checks++; return snapshot; }, simulate: async () => "0x1234",
    gasPrice: async () => 1n, balance: async () => 10n ** 18n, nonce: async () => 0,
    sign: async () => { signs++; return raw; },
    send: async () => { sends++; const record = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")); assert.equal(record.hash, hash); assert.equal(record.nonce, 0); assert.ok(!JSON.stringify(record).includes('"raw"')); return hash; },
    receipt: async () => receipt, state: async () => ({ position: 0n, orders: [], stops: [] }),
    tty: true, confirm: async (intent) => intent, output: (v) => outputs.push(v), ...overrides,
  };
  return { dir, journal, ports, outputs, receipt, counts: () => ({ loads, signs, sends, checks }) };
}
const execution = (): Options => ({ ...options(), execute: true, envFile: "/not-read-by-mocked-transport/.env" });

test("strict inputs and explicit owner; no coercion, rounding, Arena or mainnet", () => {
  for (const value of ["-1", "0", "1e2", "1x", "1.001", ".1", "01", " 1", "NaN"]) assert.throws(() => decimal(value, 2));
  for (const extra of [["--chain", "1"], ["--side", "short"], ["--yes"], ["--env-file", "/any.env"], ["--execute"]]) assert.throws(() => parseArgs([...baseArgs, ...extra]));
  assert.throws(() => parseArgs(baseArgs.slice(2)));
  assert.throws(() => address(ARENA));
  assert.throws(() => parseArgs(baseArgs.map((s) => s === "100000" ? "30000001" : s)));
  assert.equal(decimal("1.25", 2), 125n);
});
test("official delegated selectors", () => {
  assert.equal(toFunctionSelector("placeOrderFor(address,bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)"), PLACE_SELECTOR);
  assert.equal(toFunctionSelector("cancelOrderFor(address,uint128)"), CANCEL_SELECTOR);
});
test("dry-run never loads key, signs, prompts or broadcasts", async (t) => {
  const f = fixture(t, { confirm: async () => { throw Error("no prompt"); } });
  await runTrade(options(), f.ports, f.journal);
  assert.deepEqual(f.counts(), { loads: 0, signs: 0, sends: 0, checks: 1 });
  assert.ok(!existsSync(join(f.dir, "pending.json")));
});
for (const [name, override] of [
  ["wrong HTTP chain", { chainId: async () => 1 }],
  ["retired SDK genesis", { initialize: async () => { throw Error("retired"); } }],
  ["noninteractive execute", { tty: false }],
  ["wrong confirmation", { confirm: async () => "yes" }],
  ["preflight refusal", { preflight: async () => { throw Error("insufficient"); } }],
  ["simulation refusal", { simulate: async () => { throw Error("revert"); } }],
  ["pending nonce", { nonce: async (_: unknown, tag: string) => tag === "pending" ? 1 : 0 }],
  ["gas spend cap", { gasPrice: async () => 10n ** 18n }],
  ["owner is signer", { loadSigner: async () => owner }],
] as [string, Partial<Ports>][]) test(`${name} blocks signing and sending`, async (t) => {
  const f = fixture(t, override);
  await assert.rejects(runTrade(execution(), f.ports, f.journal));
  assert.equal(f.counts().signs, 0); assert.equal(f.counts().sends, 0);
});
test("successful execution persists hash before one broadcast, compares state, saves safe evidence", async (t) => {
  const f = fixture(t);
  await runTrade(execution(), f.ports, f.journal);
  assert.deepEqual(f.counts(), { loads: 1, signs: 1, sends: 1, checks: 2 });
  const saved = JSON.parse(readFileSync(join(f.dir, `${hash}.json`), "utf8"));
  assert.equal(saved.positionMatchesFills, true);
  assert.equal(saved.fullFill, false);
  assert.equal(saved.gasCost, "20");
  assert.deepEqual(saved.decoded.fills, []);
  assert.ok(!existsSync(join(f.dir, "lock")));
});
test("ambiguous broadcast retains known hash and exclusive lock, never retries", async (t) => {
  let sends = 0;
  const f = fixture(t, { send: async () => { sends++; throw Error("timeout raw secret suppressed"); } });
  await assert.rejects(runTrade(execution(), f.ports, f.journal));
  assert.equal(sends, 1);
  assert.ok(existsSync(join(f.dir, "lock")));
  assert.equal(JSON.parse(readFileSync(join(f.dir, "pending.json"), "utf8")).hash, hash);
  await assert.rejects(runTrade(execution(), f.ports, new Journal(f.dir)), /Unresolved/);
  assert.equal(f.counts().loads, 1); assert.equal(sends, 1);
});
test("exclusive lock blocks parallel processes", (t) => {
  const f = fixture(t); f.journal.acquire();
  assert.throws(() => new Journal(f.dir).acquire()); f.journal.release();
});
test("confirmation names complete intent; fresh changed position blocks send", async (t) => {
  let checks = 0;
  const f = fixture(t, {
    preflight: async () => ({ ...snapshot, position: checks++ === 0 ? 0n : 1n }),
    confirm: async (intent) => {
      const parsed = JSON.parse(intent.slice("CONFIRM ".length));
      for (const key of ["owner", "operator", "pool", "side", "qty", "absoluteLimitPrice", "chain", "gas", "gasPriceWei", "maxGasSpendWei", "cleanup"]) assert.ok(key in parsed);
      assert.match(parsed.cleanup, /NONE/); return intent;
    },
  });
  await assert.rejects(runTrade(execution(), f.ports, f.journal), /changed/);
  assert.equal(f.counts().signs, 0);
});
test("receipt timeout or post-receipt read failure retains journal", async (t) => {
  for (const override of [{ receipt: async () => { throw Error("timeout"); } }, { state: async () => { throw Error("RPC unavailable"); } }]) {
    const f = fixture(t, override); await assert.rejects(runTrade(execution(), f.ports, f.journal));
    assert.equal(f.counts().sends, 1); assert.ok(existsSync(join(f.dir, "pending.json")));
  }
});
test("reverted receipt saved without retry", async (t) => {
  const f = fixture(t); f.receipt.status = "reverted";
  await assert.rejects(runTrade(execution(), f.ports, f.journal), /reverted/);
  assert.equal(f.counts().sends, 1);
  assert.equal(JSON.parse(readFileSync(join(f.dir, `${hash}.json`), "utf8")).status, "reverted");
});
test("partial IOC reports exposure and explicit close command without automatic writes", async (t) => {
  const f = fixture(t, { state: async () => ({ position: 40n, orders: [], stops: [] }) });
  f.receipt.logs = [{ address: pool, topics: encodeEventTopics({ abi: orderBookEventsAbi, eventName: "OrderFilled", args: { takerOrderId: 1n, makerOrderId: 2n } }), data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [40n, 60n, 0n, 100n]) }] as TransactionReceipt["logs"];
  await runTrade(execution(), f.ports, f.journal);
  const saved = JSON.parse(readFileSync(join(f.dir, `${hash}.json`), "utf8"));
  assert.equal(saved.filledQuantity, "40"); assert.equal(saved.fullFill, false);
  assert.equal(saved.realizedNotionalRaw, "40");
  assert.equal(f.counts().sends, 1);
  assert.ok(f.outputs.some((o) => JSON.stringify(o, (_, v) => typeof v === "bigint" ? String(v) : v).includes("--qty 0.40")));
  assert.equal(JSON.parse(readFileSync(join(f.dir, `${hash}.json`), "utf8")).fullPositionDelta, false);
});
test("partial close leaves exposure; no close loop", async (t) => {
  const f = fixture(t, { preflight: async () => ({ ...snapshot, position: 100n }), state: async () => ({ position: 40n, orders: [], stops: [] }) });
  f.receipt.logs = [{ address: pool, topics: encodeEventTopics({ abi: orderBookEventsAbi, eventName: "OrderFilled", args: { takerOrderId: 1n, makerOrderId: 2n } }), data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [60n, 40n, 0n, 100n]) }] as TransactionReceipt["logs"];
  await runTrade({ ...execution(), close: true, side: "short" }, f.ports, f.journal);
  assert.equal(f.counts().sends, 1);
  assert.equal(JSON.parse(readFileSync(join(f.dir, `${hash}.json`), "utf8")).expectedPosition, "40");
  assert.ok(!existsSync(join(f.dir, "pending.json")));
});

test("actual preflight uses owner, no autoPull and both pool grants", async () => {
  const f = readerFixture(owner, operator, pool);
  const s = await preflight(f.rpc, options());
  assert.equal(s.quantity, 100n);
  assert.deepEqual(f.calls.filter(c => c.functionName === "isOperatorAuthorized").map(c => c.args?.[2]), [PLACE_SELECTOR, CANCEL_SELECTOR]);
});
for (const reason of ["orders", "not-flat", "margin", "priceable", "max", "static", "grant", "notional", "grid"]) test(`preflight rejects ${reason}`, async () => {
  const f = readerFixture(owner, operator, pool);
  if (reason === "orders") f.values.getOwnOpenOrders = [1n];
  if (reason === "not-flat") f.values.getPosition.size = 1n;
  if (reason === "margin") f.values.getAccountHealth = [-1n, 1000n, 0n, 0n];
  if (reason === "priceable") f.values.tryGetHealthSnapshot[0] = false;
  if (reason === "max") f.values.getPerpPoolParameters.maxPositionSize = 1n;
  if (reason === "static") f.values.getOpenInterest = 100000n;
  if (reason === "grant") f.values.isOperatorAuthorized = false;
  if (reason === "grid") f.values.getOrderBookParameters.lotSize = 3n;
  await assert.rejects(preflight(f.rpc, { ...options(), ...(reason === "notional" ? { price: "26" } : {}) }));
});
test("close requires exact opposite signed size and purely reducing preview", async () => {
  const f = readerFixture(owner, operator, pool);
  f.values.getPosition.size = 100n;
  f.values.getReducingCapacity.positionSize = 100n;
  f.values.getReducingCapacity.effectiveReducingCapacity = 100n;
  const o = { ...options(), close: true, side: "short" as const };
  await preflight(f.rpc, o);
  await assert.rejects(preflight(f.rpc, { ...o, qty: "0.5" }));
  await assert.rejects(preflight(f.rpc, { ...o, side: "long" }));
  f.values.tryGetHealthSnapshot[1].markPrice = 3000n;
  await preflight(f.rpc, { ...o, price: "30" });
  f.values.getReducingCapacity.effectiveReducingCapacity = 99n;
  await assert.rejects(preflight(f.rpc, o));
});

test("absolute signer path must end in exactly .env", () => {
  for (const path of [".env", "/tmp/signer.env", "/tmp/.env.local"]) assert.throws(() => parseArgs([...baseArgs, "--execute", "--env-file", path]));
  assert.equal(parseArgs([...baseArgs, "--execute", "--env-file", "/explicit/path/.env"]).envFile, "/explicit/path/.env");
});
test("potential registry triggers and unavailable proof refuse preflight", async () => {
  const f = readerFixture(owner, operator, pool);
  f.values.getStopOrderRegistry = operator;
  await assert.rejects(preflight(f.rpc, options()), /registry triggers/);
  delete f.values.getStopOrderRegistry;
  await assert.rejects(preflight(f.rpc, options()));
});
for (const [name, after] of [
  ["unexplained position", { position: 100n, orders: [], stops: [] }],
  ["unexpected orders", { position: 0n, orders: [1n], stops: [] }],
  ["unexpected stops", { position: 0n, orders: [], stops: [1n] }],
] as const) test(`${name} persists review-required block`, async (t) => {
  const f = fixture(t, { state: async () => ({ position: after.position, orders: [...after.orders], stops: [...after.stops] }) });
  await assert.rejects(runTrade(execution(), f.ports, f.journal), /Review required/);
  assert.equal(JSON.parse(readFileSync(join(f.dir, "pending.json"), "utf8")).status, "review-required");
  await assert.rejects(runTrade(execution(), f.ports, new Journal(f.dir)), /Unresolved/);
  assert.equal(f.counts().sends, 1);
});

test("receipt state pins all reads and refuses block hash mismatch or mid-read reorg", async (t) => {
  for (const reorgAt of [1, 2, 99]) {
    const f = fixture(t);
    let blocks = 0;
    const reads: string[] = [];
    const rpc = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => { assert.equal(blockNumber, 5n); return { hash: ++blocks >= reorgAt ? keccak256("0xab") : hash }; },
      readContract: async (args: { address: string; blockNumber: bigint; functionName: string; account?: string; args?: unknown[] }) => {
        assert.equal(args.blockNumber, 5n); reads.push(args.functionName);
        if (args.functionName === "getSystemConfig") return { perpPoolFactory: bank };
        if (args.functionName === "getStopOrderRegistry") return operator;
        if (args.functionName === "isOperatorAuthorized") { assert.equal(args.address, pool); assert.deepEqual(args.args, [owner, operator, PLACE_SELECTOR]); return false; }
        if (args.functionName === "getPosition") { assert.deepEqual(args.args, [owner, pool]); return { size: 0n }; }
        assert.equal(args.account, owner); return [];
      },
    } as unknown as Parameters<typeof receiptState>[0];
    f.ports.state = (o, s, r) => receiptState(rpc, o, s, r);
    if (reorgAt < 99) {
      await assert.rejects(runTrade(execution(), f.ports, f.journal), /hash mismatch/);
      assert.ok(existsSync(join(f.dir, "pending.json")));
    } else {
      await runTrade(execution(), f.ports, f.journal);
      assert.equal(reads.length, 5);
    }
  }
});
test("full decoded fill reconciles and partial completion permits separate execution lock", async (t) => {
  for (const quantity of [40n, 100n]) {
    const f = fixture(t, { state: async () => ({ position: quantity, orders: [], stops: [] }) });
    f.receipt.logs = [{ address: pool, topics: encodeEventTopics({ abi: orderBookEventsAbi, eventName: "OrderFilled", args: { takerOrderId: 1n, makerOrderId: 2n } }), data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [quantity, 100n - quantity, 0n, 100n]) }] as TransactionReceipt["logs"];
    await runTrade(execution(), f.ports, f.journal);
    const saved = JSON.parse(readFileSync(join(f.dir, `${hash}.json`), "utf8"));
    assert.equal(saved.positionMatchesFills, true);
    assert.equal(saved.fullFill, quantity === 100n);
    const separate = new Journal(f.dir); separate.acquire(); separate.release();
  }
});
test("reverted receipt with changed position remains review-required", async (t) => {
  const f = fixture(t, { state: async () => ({ position: 1n, orders: [], stops: [] }) });
  f.receipt.status = "reverted";
  await assert.rejects(runTrade(execution(), f.ports, f.journal), /Review required/);
  const pending = JSON.parse(readFileSync(join(f.dir, "pending.json"), "utf8"));
  assert.equal(pending.status, "review-required");
  assert.equal(pending.evidence.expectedPosition, "0");
});
for (const mode of ["absent", "unauthorized", "authorized", "unreadable", "malformed"] as const) test(`registry trigger authorization: ${mode}, pinned owner/pool/selector`, async () => {
  const factory = address("0x5555555555555555555555555555555555555555");
  const registry = address("0x6666666666666666666666666666666666666666");
  const reads: string[] = [];
  const rpc = { readContract: async (request: { address: string; functionName: string; blockNumber: bigint; args?: unknown[] }) => {
    assert.equal(request.blockNumber, 5n);
    reads.push(request.functionName);
    if (request.functionName === "getSystemConfig") { assert.equal(request.address, bank); return { perpPoolFactory: factory }; }
    if (request.functionName === "getStopOrderRegistry") {
      assert.equal(request.address, factory); assert.deepEqual(request.args, [pool]);
      return mode === "absent" ? "0x0000000000000000000000000000000000000000" : registry;
    }
    assert.equal(request.functionName, "isOperatorAuthorized");
    assert.equal(request.address, pool);
    assert.deepEqual(request.args, [owner, registry, "0x80054449"]);
    if (mode === "unreadable") throw Error("operator read unavailable");
    return mode === "malformed" ? undefined : mode === "authorized";
  } } as unknown as Parameters<typeof assertStopsCannotExecute>[0];
  const check = assertStopsCannotExecute(rpc, pool, bank, owner, 5n);
  if (mode === "absent" || mode === "unauthorized") assert.deepEqual(await check, []);
  else await assert.rejects(check, mode === "unreadable" ? /operator read unavailable/ : /currently authorized registry triggers/);
  assert.deepEqual(reads, ["getSystemConfig", "getStopOrderRegistry", ...(mode === "absent" ? [] : ["isOperatorAuthorized"])]);
});
test("preflight passes bank, owner and pool to registry authorization check", async () => {
  const f = readerFixture(owner, operator, pool);
  const result = await preflight(f.rpc, options());
  assert.deepEqual(f.calls.find(c => c.functionName === "getStopOrderRegistry")?.args, [pool]);
  assert.match(JSON.stringify(result.report, (_, value) => typeof value === "bigint" ? String(value) : value), /pending stops may exist/);
});
for (const mode of ["advance", "regress", "hash", "age"] as const) test(`freshness ${mode} after prepare prevents sign/send`, async (t) => {
  const r = readerFixture(owner, operator, pool);
  const f = fixture(t, { preflight: async () => ({ ...snapshot, capturedAt: Date.now() }), assertFresh: async s => {
    assert.ok(existsSync(join(f.dir, "pending.json")));
    r.head = mode === "advance" ? 6n : mode === "regress" ? 4n : 5n;
    r.blockHash = mode === "hash" ? keccak256("0xab") : hash;
    await assertFresh(r.rpc, { ...s, capturedAt: mode === "age" ? Date.now() - 5001 : s.capturedAt });
  } });
  await assert.rejects(runTrade(execution(), f.ports, f.journal));
  assert.equal(f.counts().signs, 0); assert.equal(f.counts().sends, 0);
});
test("second production preflight rejects changed mark cap after confirmation without signing", async (t) => {
  const r = readerFixture(owner, operator, pool);
  const seen: bigint[] = [];
  const f = fixture(t, {
    preflight: async o => { seen.push(r.head); return preflight(r.rpc, o); },
    confirm: async intent => { r.head = 6n; r.values.tryGetHealthSnapshot[1].markPrice = 2600n; return intent; },
  });
  await assert.rejects(runTrade(execution(), f.ports, f.journal), /notional exceeds/);
  assert.deepEqual(seen, [5n, 6n]);
  assert.equal(f.counts().signs, 0); assert.equal(f.counts().sends, 0);
});
test("head regression between confirmation snapshots prevents signing", async (t) => {
  let checks = 0;
  const f = fixture(t, { preflight: async () => ({ ...snapshot, blockNumber: ++checks === 1 ? 5n : 4n }) });
  await assert.rejects(runTrade(execution(), f.ports, f.journal), /regression/);
  assert.equal(f.counts().signs, 0); assert.equal(f.counts().sends, 0);
});
