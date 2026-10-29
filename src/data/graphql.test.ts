import assert from "node:assert/strict";
import test from "node:test";
import { epochBefore, epochWindow } from "./graphql.js";

const raw = (block: number, log: number) => ({ blockNumber: block, logIndex: log, timestamp: block, initialMarginBps: "500", maintenanceMarginBps: null, closeOutMarginBps: null, takerFeeBpsTimes1k: null, makerFeeBpsTimes1k: null, maxPositionSize: null, maxOpenInterest: null, insuranceFundShareBps: null, source: "event" });
test("epoch baseline is strictly before start; composite cursor includes all start-block logs", async () => {
  const original = globalThis.fetch;
  const variables: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    const { query, variables: v } = JSON.parse(String(init?.body));
    variables.push(v);
    assert.match(query, /blockNumber logIndex timestamp/);
    const rows = query.includes("query EpochsBefore") ? [raw(Number(v.block), 9)] : v.cursorLog === -1 ? [raw(100, 1)] : v.cursorLog === 1 ? [raw(100, 2)] : [];
    return new Response(JSON.stringify({ data: { PerpPoolParametersEpoch: rows } }));
  }) as typeof fetch;
  try {
    const rows = await epochWindow("POOL", 100, 101);
    assert.deepEqual(rows.map(r => [r.blockNumber, r.logIndex]), [[99, 9], [100, 1], [100, 2]]);
    assert.equal(variables[0].block, "99");
    assert.equal(variables[2].cursorBlock, "100");
    assert.equal(variables[2].cursorLog, 1);
    assert.equal((await epochBefore("POOL", 100))!.blockNumber, 100);
  } finally { globalThis.fetch = original; }
});
test("epoch truncation and no-progress cannot masquerade as complete history", async () => {
  const original = globalThis.fetch;
  let repeat = false;
  globalThis.fetch = (async (_url, init) => {
    const { query, variables: v } = JSON.parse(String(init?.body));
    const rows = query.includes("query EpochsBefore") ? [] : [raw(100, repeat ? 0 : v.cursorLog + 1)];
    return new Response(JSON.stringify({ data: { PerpPoolParametersEpoch: rows } }));
  }) as typeof fetch;
  try {
    await assert.rejects(epochWindow("pool", 100, 101), /eight-page/);
    repeat = true;
    await assert.rejects(epochWindow("pool", 100, 101), /no progress/);
  } finally { globalThis.fetch = original; }
});
