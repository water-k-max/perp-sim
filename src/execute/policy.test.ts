import assert from "node:assert/strict";
import { test } from "node:test";
import { decideExecution, ExecutionRefused, type ExecutionRequest, type ExecutionSettings } from "./policy.js";

/**
 *  One canary per refusal arm. Each test pins a single guard: if that guard is removed or inverted,
 *  the named test goes red. The allow arm is asserted too, so a kernel that refuses everything
 *  (and would silently make execution dead) is caught as well.
 */

const LIVE: ExecutionSettings = { enabled: true, dryRun: false, hasKey: true, maxNotional: 1_000n };
const OK: ExecutionRequest = { mode: "local", confirm: true, notional: 100n, placeable: true };

const refused = (settings: ExecutionSettings, request: ExecutionRequest, fragment: RegExp): void => {
  assert.throws(() => decideExecution(settings, request), (error: unknown) => {
    assert.ok(error instanceof ExecutionRefused, `expected ExecutionRefused, got ${String(error)}`);
    assert.match((error as Error).message, fragment);
    return true;
  });
};

test("a deployment can never send, whatever its environment says", () => {
  // The guard is by transport mode, not by settings: even fully enabled, live, confirmed and keyed,
  // a serverless request is refused. This is what keeps the public function credential-free.
  refused(LIVE, { ...OK, mode: "serverless" }, /local-only/);
});

test("the local allow arm sends when every gate is satisfied", () => {
  const decision = decideExecution(LIVE, OK);
  assert.equal(decision.action, "send");
  assert.ok(decision.reason.length > 0);
});

test("EXECUTION_ENABLED=false previews, never sends", () => {
  const decision = decideExecution({ ...LIVE, enabled: false }, OK);
  assert.equal(decision.action, "preview");
  assert.match(decision.reason, /EXECUTION_ENABLED/);
});

test("DRY_RUN=true previews even when enabled", () => {
  const decision = decideExecution({ ...LIVE, dryRun: true }, OK);
  assert.equal(decision.action, "preview");
  assert.match(decision.reason, /DRY_RUN/);
});

test("live over the notional cap is refused", () => {
  refused(LIVE, { ...OK, notional: 1_001n }, /cap/);
});

test("notional exactly at the cap is allowed (the gate is >, not >=)", () => {
  assert.equal(decideExecution(LIVE, { ...OK, notional: 1_000n }).action, "send");
});

test("an unplaceable order is never sent", () => {
  refused(LIVE, { ...OK, placeable: false }, /not placeable/);
});

test("live without an explicit confirm is refused", () => {
  refused(LIVE, { ...OK, confirm: false }, /confirm/);
});

test("live without a configured key is refused", () => {
  refused({ ...LIVE, hasKey: false }, OK, /PRIVATE_KEY/);
});

test("preview is safe even over cap — the proposal shows the gate, the kernel does not hide it", () => {
  const decision = decideExecution({ ...LIVE, enabled: false }, { ...OK, notional: 9_999n });
  assert.equal(decision.action, "preview");
});

test("preview is safe even when unplaceable", () => {
  const decision = decideExecution({ ...LIVE, dryRun: true }, { ...OK, placeable: false });
  assert.equal(decision.action, "preview");
});

test("the key never reaches the kernel — only a boolean does", () => {
  // The settings type carries hasKey, not the key. A kernel handed a boolean cannot leak a secret
  // into a reason string; assert no decision reason contains anything key-shaped.
  for (const settings of [LIVE, { ...LIVE, enabled: false }, { ...LIVE, hasKey: false }]) {
    try {
      const decision = decideExecution(settings, OK);
      assert.doesNotMatch(decision.reason, /0x[0-9a-fA-F]{64}/);
    } catch (error) {
      assert.doesNotMatch((error as Error).message, /0x[0-9a-fA-F]{64}/);
    }
  }
});