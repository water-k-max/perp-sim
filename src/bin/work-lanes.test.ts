import assert from "node:assert/strict";
import { test } from "node:test";
import { LaneBusy, WorkLanes } from "./work-lanes.js";

/**
 * A lane whose jobs only finish when the test says so. Every job records the order it started in
 * and the highest number of jobs seen in flight at once, so "concurrency 2" is measured rather than
 * assumed, and nothing here depends on wall-clock timing.
 */
function rig(limits: { concurrency: number; queueLimit: number }) {
  const lanes = new WorkLanes(limits);
  const lanes_ = lanes;
  const order: string[] = [];
  const gates: Record<string, { p: Promise<void>; open: () => void }> = {};
  // The gate is built the moment a key is mentioned, not when its job happens to start: a test that
  // settles a queued key before it has been dequeued would otherwise be settling nothing, and the
  // job would then wait on a resolver nobody holds.
  const gate = (key: string) => (gates[key] ??= (() => {
    let open!: () => void;
    const p = new Promise<void>((resolve) => { open = resolve; });
    return { p, open };
  })());
  let inflight = 0;
  let peak = 0;
  let failed = 0;

  const job = (key: string, value: unknown = key) => async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    order.push(key);
    await gate(key).p;
    inflight -= 1;
    if (value instanceof Error) { failed += 1; throw value; }
    return value;
  };

  /** Start a job and keep the caller's promise, without awaiting it. */
  const start = (key: string, value?: unknown) => {
    gate(key);
    return { key, promise: lanes_.submit(key, job(key, value)) };
  };
  const settle = (key: string) => { gate(key).open(); };
  const settleAll = () => { Object.keys(gates).forEach((key) => gates[key]!.open()); };

  // `submit` is exposed too, for the cases that must hand in work which is never allowed to run.
  return { lanes: lanes_, order, start, settle, settleAll, submit: (key: string, work: () => Promise<unknown>) => lanes_.submit(key, work), peak: () => peak, failed: () => failed };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settled = <T,>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

test("the same request twice is one job, and both callers get the same answer", async () => {
  const r = rig({ concurrency: 2, queueLimit: 4 });
  const first = r.start("backtest:A");
  await tick();
  const second = r.start("backtest:A");
  const third = r.start("backtest:A");
  assert.equal(r.lanes.status.started, 1, "a second copy of the same key must not start a second replay");
  assert.equal(r.lanes.status.coalesced, 2);

  r.settle("backtest:A");
  const results = await Promise.all([first.promise, second.promise, third.promise]);
  assert.deepEqual(results, ["backtest:A", "backtest:A", "backtest:A"]);
  assert.equal(r.lanes.status.started, 1);
});

test("keys that differ in one field are different work", async () => {
  const r = rig({ concurrency: 2, queueLimit: 4 });
  const btc = r.start("backtest:BTC:14");
  const eth = r.start("backtest:ETH:14");
  await tick();
  assert.deepEqual(r.order.sort(), ["backtest:BTC:14", "backtest:ETH:14"]);
  assert.equal(r.lanes.status.coalesced, 0, "distinct requests were folded into one");
  r.settleAll();
  await Promise.all([btc.promise, eth.promise]);
});

test("different jobs never exceed the slots", async () => {
  const r = rig({ concurrency: 2, queueLimit: 8 });
  const running = Array.from({ length: 6 }, (_, i) => r.start(`job:${i}`));
  await tick();
  assert.equal(r.peak(), 2, `concurrency 2 was exceeded: peak ${r.peak()}`);
  assert.equal(r.lanes.status.running, 2);
  assert.equal(r.lanes.status.waiting, 4);

  // Free the slots one at a time and check nothing runs ahead of the two that may run.
  for (let i = 0; i < 6; i += 1) {
    r.settle(`job:${i}`);
    await tick();
    assert.ok(r.peak() <= 2, `peak went to ${r.peak()} after freeing job:${i}`);
  }
  await Promise.all(running.map((j) => j.promise));
  assert.equal(r.lanes.status.running, 0);
  assert.equal(r.lanes.status.active, 0);
});

test("the queue is first-come first-served, not whichever job is cheapest", async () => {
  const r = rig({ concurrency: 1, queueLimit: 5 });
  const submitted = ["a", "b", "c", "d", "e"].map((k) => ({ k, ...r.start(`q:${k}`) }));
  await tick();
  assert.deepEqual(r.order, ["q:a"], `only one slot, so only the first may run: ${r.order}`);
  assert.equal(r.lanes.status.waiting, 4);
  for (const { k } of submitted) {
    r.settle(`q:${k}`);
    await tick();
  }
  assert.deepEqual(r.order, ["q:a", "q:b", "q:c", "q:d", "q:e"]);
  await Promise.all(submitted.map((s) => s.promise));
});

test("a full queue refuses, and the refusal says how full it is", async () => {
  const r = rig({ concurrency: 1, queueLimit: 2 });
  const held = r.start("x:1");
  await tick();
  const queued = [r.start("x:2"), r.start("x:3")];
  await tick();
  const refused = await settled(r.submit("x:4", async () => "never runs"));
  assert.equal(r.lanes.status.refused, 1);
  assert.ok(refused.ok === false && refused.error instanceof LaneBusy, `expected LaneBusy, got ${JSON.stringify(refused)}`);
  const busy = refused.error as LaneBusy;
  assert.equal(busy.running, 1);
  assert.equal(busy.waiting, 2);
  assert.equal(busy.concurrency, 1);
  assert.equal(busy.queueLimit, 2);
  assert.equal(busy.retryAfterSeconds, 2);
  assert.match(busy.message, /All 1 lanes are busy and 2 request\(s\) are already queued/);
  assert.equal(r.order.includes("x:4"), false, "a refused job must not have started");

  r.settleAll();
  const rest = await Promise.all([held.promise, queued[0]!.promise, queued[1]!.promise]);
  assert.deepEqual(rest, ["x:1", "x:2", "x:3"]);
  assert.deepEqual(r.order, ["x:1", "x:2", "x:3"]);
});

test("queueLimit 0 means no waiting at all", async () => {
  const r = rig({ concurrency: 2, queueLimit: 0 });
  const running = [r.start("z:1"), r.start("z:2")];
  await tick();
  const third = await settled(r.submit("z:3", async () => "no"));
  assert.ok(third.ok === false && third.error instanceof LaneBusy);
  assert.equal((third.error as LaneBusy).waiting, 0);
  assert.equal(r.order.length, 2);
  r.settleAll();
  await Promise.all(running.map((j) => j.promise));
});

test("a job that throws reaches every waiter with the same error and frees its slot", async () => {
  const r = rig({ concurrency: 1, queueLimit: 2 });
  const boom = new Error("indexer refused");
  const first = r.start("f:1", boom);
  await tick();
  const second = { key: "f:1", promise: r.submit("f:1", async () => "must not run") };
  const a = settled(first.promise);
  const b = settled(second.promise);
  r.settle("f:1");
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(ra.ok === false && ra.error === boom, "the first waiter got a different error");
  assert.ok(rb.ok === false && rb.error === boom, "the coalesced waiter got a different error");
  assert.equal(r.failed(), 1, "the work itself ran more than once");
  assert.equal(r.lanes.status.coalesced, 1);
  assert.equal(r.lanes.status.active, 0, "a failure left the key registered");
  assert.equal(r.lanes.status.running, 0, "a failure leaked a slot");

  // The lane still works afterwards: this is the canary for a lock that was never released.
  const recovery = await r.submit("f:2", async () => "recovered");
  assert.equal(recovery, "recovered");
});

test("an empty key is refused before anything is scheduled", async () => {
  const lanes = new WorkLanes({ concurrency: 1, queueLimit: 1 });
  const refused = await settled(lanes.submit("", async () => "x"));
  assert.ok(refused.ok === false);
  assert.match(String(refused.ok === false && refused.error), /lane key is required/);
  assert.equal(lanes.status.started, 0);
});

test("limits are checked when the lane is built, not when it is first used", () => {
  for (const bad of [{ concurrency: 0, queueLimit: 1 }, { concurrency: 1.5, queueLimit: 1 }, { concurrency: 1, queueLimit: -1 }]) {
    assert.throws(() => new WorkLanes(bad), /integer/, JSON.stringify(bad));
  }
});

test("refusals and coalesced hits are counted separately from starts", async () => {
  const r = rig({ concurrency: 1, queueLimit: 1 });
  const held = r.start("c:1");
  await tick();
  const queued = r.start("c:2");
  await tick();
  await assert.rejects(r.submit("c:3", async () => "no"));
  void r.submit("c:1", async () => "no");
  await tick();
  const s = r.lanes.status;
  assert.equal(s.started, 1);
  assert.equal(s.refused, 1);
  assert.equal(s.coalesced, 1);
  assert.equal(s.active, 2);
  r.settleAll();
  await Promise.all([held.promise, queued.promise]);
  assert.equal(r.lanes.status.active, 0);
});
