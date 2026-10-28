import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockNotFoundError, createPublicClient, decodeFunctionData, encodeFunctionResult, http, keccak256, zeroAddress, type PublicClient } from "viem";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { ORDER_TYPE, SELF_MATCHING_OPTION } from "@somnia-chain/markets-sdk";
import { createPorts, operatorAbi, preflight, stateAbi } from "./adapter.js";
import { assertFresh, checkGenesis, MAX_SNAPSHOT_AGE_MS, readPlacement, tradeReadAbi } from "./reader.js";
import { readerFixture } from "./reader.fixture.js";
import { address, parseArgs } from "./input.js";
const owner = address("0x1111111111111111111111111111111111111111");
const operator = address("0x2222222222222222222222222222222222222222");
const pool = address("0x3333333333333333333333333333333333333333");
const options = () => parseArgs(["--owner", owner, "--operator", operator, "--pool", pool, "--side", "long", "--qty", "1", "--price", "1", "--gas", "100000", "--max-gas-spend", "0.1"]);

test("production reader pins every safety read, resolves onchain metadata and never requests wallet funding", async () => {
  const f = readerFixture(owner, operator, pool);
  const s = await preflight(f.rpc, options(), operator);
  assert.equal(s.blockNumber, 5n); assert.equal(s.blockHash, f.blockHash); assert.equal(s.blockTimestamp, 1000n);
  const expected = [...tradeReadAbi.map(a => a.name), "getOwnOpenOrders", "isOperatorAuthorized", "getStopOrderRegistry"];
  assert.deepEqual([...new Set(f.calls.map(c => c.functionName))].sort(), expected.sort());
  for (const call of f.calls) assert.equal(call.blockNumber, s.blockNumber);
  const report = s.report as { margin: Record<string, unknown> };
  assert.equal("wallet" in report.margin, false); assert.equal("mainWalletCapacity" in report.margin, false);
  assert.equal(f.calls.find(c => c.functionName === "getOwnOpenOrders")?.account, owner);
  const next = await preflight(Object.assign(f.rpc, { getBlockNumber: async ({ cacheTime }: { cacheTime: number }) => { assert.equal(cacheTime, 0); f.head = 6n; return f.head; } }), options(), operator);
  assert.equal(next.blockNumber, 6n);
});

for (const reorgAt of [2, 3]) test(`preflight canonical mismatch ${reorgAt === 2 ? "before" : "after"} safety reads refuses`, async () => {
  const f = readerFixture(owner, operator, pool); f.mismatchAt = reorgAt;
  await assert.rejects(preflight(f.rpc, options(), operator), /canonical hash mismatch/);
  assert.equal(f.calls.length === 0, reorgAt === 2);
});

test("fresh HTTP mark above cap rejects even with passing stale SDK/indexer metadata", async () => {
  const f = readerFixture(owner, operator, pool);
  await preflight(f.rpc, options(), operator);
  Object.assign(f.rpc, {
    listPerpMarkets: async () => { throw Error("Indexer must never be consulted"); },
    previewPerpOrderMargin: async () => { throw Error("SDK WS must never be consulted"); },
  });
  f.values.tryGetHealthSnapshot[1].markPrice = 2600n;
  await assert.rejects(preflight(f.rpc, options(), operator), /notional exceeds/);
});
for (const field of ["bank", "collateral", "factory", "registration", "deployed", "oneBase", "grid", "risk", "cross-health", "voucher", "leverage", "isolation", "restriction"] as const) test(`onchain ${field} cannot be overridden by stale metadata`, async () => {
  const f = readerFixture(owner, operator, pool);
  if (field === "bank") f.values.marginBank = owner;
  if (field === "collateral") f.values.getSystemConfig.collateralToken = owner;
  if (field === "factory") f.values.getSystemConfig.perpPoolFactory = owner;
  if (field === "registration") f.values.isPerpPoolRegistered = false;
  if (field === "deployed") f.values.isDeployedByFactory = false;
  if (field === "oneBase") f.values.tryGetHealthSnapshot[1].oneBase = 99n;
  if (field === "grid") f.values.getOrderBookParameters.tickSize = 3n;
  if (field === "risk") f.values.getPerpPoolParameters.maxPositionSize = 99n;
  if (field === "cross-health") f.values.getAccountHealth = [100n, 101n, 0n, 0n];
  if (field === "voucher") { f.values.getCreditFloor = 1n; f.values.isVoucherMarketAllowed = false; }
  if (field === "leverage") { f.values.getMaxLeverage = 1; f.values.getAccountHealth = [1n, 0n, 0n, 0n]; }
  if (field === "isolation") f.values.isolationAllowsMarket = false;
  if (field === "restriction") f.values.isRestricted = true;
  await assert.rejects(preflight(f.rpc, options(), operator));
});

test("no-autoPull max agrees with exhaustive SDK pure quotes on lot grid", async () => {
  for (const position of [0n, 100n, -100n]) for (const bid of [true, false]) {
    const f = readerFixture(owner, operator, pool);
    f.values.getPosition.size = position; f.values.getReducingCapacity.positionSize = position;
    f.values.getReducingCapacity.effectiveReducingCapacity = position < 0n ? -position : position;
    f.values.getPerpPoolParameters.maxPositionSize = 200n;
    f.values.getAccountState.unlockedCollateralBalance = 12n;
    f.values.getAccountHealth = [100n, 0n, 0n, 0n];
    f.values.getOrderBookParameters.lotSize = 5n;
    const r = await readPlacement(f.rpc, pool, owner, 5n);
    let max = 0n;
    for (let q = 5n; q <= 300n; q += 5n) {
      const newSize = position + (bid ? q : -q);
      if (newSize >= -200n && newSize <= 200n && r.quote(bid, 100n, q).sufficient) max = q;
    }
    assert.equal(r.maximum(bid, 100n).maxQuantity, max);
  }
});

test("close uses SDK floor PnL and signed-ceil funding arithmetic", async () => {
  const f = readerFixture(owner, operator, pool);
  f.values.getPosition.size = 3n; f.values.getPosition.avgEntryPrice = 101n;
  f.values.getReducingCapacity.positionSize = 3n;
  f.values.tryGetHealthSnapshot[1].projectedCumulativeFunding = 1n;
  const r = await readPlacement(f.rpc, pool, owner, 5n);
  const close = r.close(3n, 100n);
  assert.equal(close.realizedPnl, -1n); assert.equal(close.fundingSettled, 1n);
  assert.equal(close.fullClose, true);
});

for (const reorgAt of [1, 2, Infinity]) test(`simulation canonical checks ${reorgAt} and exact pinned calldata over mocked HTTP`, async () => {
  const f = readerFixture(owner, operator, pool);
  const s = await preflight(f.rpc, options(), operator);
  let blocks = 0, simulations = 0;
  const rpc = createPublicClient({ chain: hidekiTestnet, cacheTime: 0, transport: http("http://offline.invalid", { retryCount: 0,
    fetchFn: async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      let result: unknown;
      if (req.method === "eth_getBlockByNumber") {
        assert.deepEqual(req.params, ["0x5", false]);
        result = { number: "0x5", hash: ++blocks >= reorgAt ? keccak256("0xab") : s.blockHash, timestamp: "0x3e8", transactions: [] };
      } else {
        assert.equal(req.method, "eth_call"); simulations++;
        assert.equal(req.params[1], "0x5");
        assert.equal(req.params[0].from.toLowerCase(), operator.toLowerCase());
        assert.equal(req.params[0].to.toLowerCase(), pool.toLowerCase());
        const decoded = decodeFunctionData({ abi: operatorAbi, data: req.params[0].data });
        assert.equal(decoded.functionName, "placeOrderFor");
        assert.deepEqual(decoded.args, [owner, true, 0n, 100n, 100n, 1120n * 1_000_000_000n, ORDER_TYPE.MARKET, SELF_MATCHING_OPTION.CANCEL_TAKER, zeroAddress, 0n]);
        result = encodeFunctionResult({ abi: operatorAbi, functionName: "placeOrderFor", result: [true, 1n] });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { headers: { "Content-Type": "application/json" } });
    } }) });
  const ports = createPorts(rpc).ports;
  if (reorgAt < Infinity) await assert.rejects(ports.simulate(options(), operator, s), /canonical hash mismatch/);
  else {
    const data = await ports.simulate(options(), operator, s);
    assert.equal(decodeFunctionData({ abi: operatorAbi, data }).functionName, "placeOrderFor");
  }
  assert.equal(simulations, reorgAt === 1 ? 0 : 1);
});

test("entire production preflight travels only through injected HTTP with every eth_call pinned", async () => {
  const f = readerFixture(owner, operator, pool);
  const abi = [...tradeReadAbi, ...stateAbi, ...operatorAbi] as const;
  const calls: string[] = [];
  const rpc = createPublicClient({ chain: hidekiTestnet, cacheTime: 0, transport: http("http://offline.invalid", { retryCount: 0,
    fetchFn: async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      let result: unknown;
      if (req.method === "eth_blockNumber") result = "0x5";
      else if (req.method === "eth_getBlockByNumber") {
        assert.deepEqual(req.params, ["0x5", false]);
        result = { number: "0x5", hash: f.blockHash, timestamp: "0x3e8", transactions: [] };
      } else {
        assert.equal(req.method, "eth_call"); assert.equal(req.params[1], "0x5");
        const decoded = decodeFunctionData({ abi, data: req.params[0].data });
        calls.push(decoded.functionName);
        if (decoded.functionName === "getOwnOpenOrders") assert.equal(req.params[0].from.toLowerCase(), owner.toLowerCase());
        assert.ok(decoded.functionName in f.values);
        result = encodeFunctionResult({ abi, functionName: decoded.functionName, result: f.values[decoded.functionName] });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { headers: { "Content-Type": "application/json" } });
    } }) });
  const s = await createPorts(rpc).ports.preflight(options(), operator);
  assert.equal(s.blockNumber, 5n); assert.equal(s.quantity, 100n);
  assert.deepEqual([...new Set(calls)].sort(), [...tradeReadAbi.map(a => a.name), "getOwnOpenOrders", "isOperatorAuthorized", "getStopOrderRegistry"].sort());
});

test("HTTP genesis matches SDK retired block-1 denylist and propagates failures", async () => {
  const rpc = (getBlock: unknown) => ({ getBlock }) as Pick<PublicClient, "getBlock">;
  await assert.rejects(checkGenesis(rpc(async ({ blockNumber }: { blockNumber: bigint }) => {
    assert.equal(blockNumber, 1n); return { hash: "0x0ddf6446070d043158fd7aa80d3c835a9e446efdc05601f9ad67eebc9864a4ae" };
  })), /Retired/);
  await checkGenesis(rpc(async () => ({ hash: keccak256("0xab") })));
  await checkGenesis(rpc(async () => { throw new BlockNotFoundError({ blockNumber: 1n }); }));
  await assert.rejects(checkGenesis(rpc(async () => { throw Error("offline"); })), /offline/);
});

for (const age of [0, MAX_SNAPSHOT_AGE_MS - 1, MAX_SNAPSHOT_AGE_MS, MAX_SNAPSHOT_AGE_MS + 1, -1]) {
  test(`freshness age boundary ${age}ms is deterministic`, async (t) => {
    t.mock.method(Date, "now", () => 10_000);
    const f = readerFixture(owner, operator, pool);
    const s = { blockNumber: f.head, blockHash: f.blockHash, blockTimestamp: 1000n, capturedAt: 10_000 - age };
    if (age >= 0 && age <= MAX_SNAPSHOT_AGE_MS) await assertFresh(f.rpc, s);
    else await assert.rejects(assertFresh(f.rpc, s), /Snapshot elapsed age expired/);
    assert.equal(s.capturedAt, 10_000 - age);
  });
}

test("freshness reads an uncached head every time and does not renew snapshot age", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const f = readerFixture(owner, operator, pool);
  const s = { blockNumber: f.head, blockHash: f.blockHash, blockTimestamp: 1000n, capturedAt: now };
  const headRead = t.mock.method(f.rpc, "getBlockNumber", async (args: { cacheTime: number }) => {
    assert.deepEqual(args, { cacheTime: 0 });
    return f.head;
  });
  await assertFresh(f.rpc, s);
  now += MAX_SNAPSHOT_AGE_MS;
  await assertFresh(f.rpc, s);
  now++;
  await assert.rejects(assertFresh(f.rpc, s), /Snapshot elapsed age expired/);
  assert.equal(headRead.mock.callCount(), 3);
  assert.equal(s.capturedAt, 10_000);
});

test("freshness counts time spent awaiting the RPC header", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const f = readerFixture(owner, operator, pool);
  const s = { blockNumber: f.head, blockHash: f.blockHash, blockTimestamp: 1000n, capturedAt: now };
  t.mock.method(f.rpc, "getBlock", async () => {
    now += MAX_SNAPSHOT_AGE_MS + 1;
    return { number: f.head, hash: f.blockHash, timestamp: 1000n } as Awaited<ReturnType<PublicClient["getBlock"]>>;
  });
  await assert.rejects(assertFresh(f.rpc, s), /Snapshot elapsed age expired/);
});

for (const fault of ["advance", "regress", "hash", "missing-hash", "wrong-number", "head-error", "header-error"] as const) {
  test(`freshness fails closed on ${fault}`, async (t) => {
    t.mock.method(Date, "now", () => 10_000);
    const f = readerFixture(owner, operator, pool);
    const s = { blockNumber: f.head, blockHash: f.blockHash, blockTimestamp: 1000n, capturedAt: 10_000 };
    let headCalls = 0, headerCalls = 0;
    const failure = new Error("RPC unavailable");
    const rpc = {
      getBlockNumber: async (args: { cacheTime: number }) => {
        headCalls++;
        assert.deepEqual(args, { cacheTime: 0 });
        if (fault === "head-error") throw failure;
        return fault === "advance" ? 6n : fault === "regress" ? 4n : 5n;
      },
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        headerCalls++;
        if (fault === "header-error") throw failure;
        return { number: fault === "wrong-number" ? blockNumber + 1n : blockNumber,
          hash: fault === "missing-hash" ? null : fault === "hash" ? keccak256("0xab") : s.blockHash, timestamp: 1000n };
      },
    } as unknown as Pick<PublicClient, "getBlockNumber" | "getBlock">;
    const expected = fault === "head-error" || fault === "header-error" ? failure
      : fault === "missing-hash" || fault === "wrong-number" ? /Missing snapshot block identity/
      : fault === "regress" ? /Execution head regression/ : /Execution head changed since snapshot/;
    await assert.rejects(assertFresh(rpc, s), expected);
    assert.equal(headCalls, 1);
    assert.equal(headerCalls, fault === "head-error" ? 0 : 1);
  });
}
