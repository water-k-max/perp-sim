import assert from "node:assert/strict";
import { test } from "node:test";
import { retryRead } from "./retry.js";

/** Counts the attempts the classifier let through, and records what each note said. */
async function run(message: string, succeedOn: number, attempts = 5) {
  let calls = 0;
  const notes: string[] = [];
  const value = await retryRead(
    "read-under-test",
    async () => {
      calls += 1;
      if (calls < succeedOn) throw new Error(message);
      return "ok";
    },
    attempts,
    (m) => notes.push(m),
  ).catch((error) => error as Error)
    ;
  return { calls, notes, value };
}

test("an indexer query that did not complete is retried, and the retry says so", async () => {
  const { calls, notes, value } = await run("indexer PerpPositionChanges failed: database query error", 3);
  assert.equal(value, "ok");
  assert.equal(calls, 3, "the transient failure must not abort the read");
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /retrying read-under-test/);
});

test("a socket that never opened and a genesis-check failure are still retried", async () => {
  for (const message of ["rpc getBlock failed: genesis check failed", "Socket closed", "fetch failed"]) {
    const { calls, value } = await run(message, 2);
    assert.equal(value, "ok", message);
    assert.equal(calls, 2, message);
  }
});

test("a read the endpoint refuses on purpose is not retried: it aborts on the first answer", async () => {
  for (const message of [
    "indexer Fill_aggregate failed: field 'Fill_aggregate' not found in type: 'query_root'",
    "gqlRequest(PerpPositionChanges): unusable variable(s): where.account",
    "indexer PerpPositionChange failed: table does not exist",
  ]) {
    const { calls, value } = await run(message, 99);
    assert.ok(value instanceof Error, message);
    assert.equal((value as Error).message, message);
    assert.equal(calls, 1, `${message} must not be re-asked`);
  }
});

test("the retry is bounded: a failure that never clears gives up with the last error", async () => {
  const { calls, value } = await run("indexer PerpPositionChanges failed: database query error", 99, 4);
  assert.ok(value instanceof Error);
  assert.equal(calls, 4, "attempts is a cap on total tries, not on retries");
});
