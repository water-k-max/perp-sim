/**
 *  The execution safety kernel. Pure: it decides whether an order may be SENT from the transport
 *  mode and the operator's explicit settings, before any signer is built or any transaction is
 *  broadcast. It never sees the private key — only whether one is configured.
 *
 *  Two facts are load-bearing and each has a canary in policy.test.ts:
 *   1. A deployment can never send. The refusal is by transport mode, not by environment, so the
 *      public function holds no credential and cannot place an order even if one were configured.
 *   2. Sending is opt-in twice over (EXECUTION_ENABLED and DRY_RUN) and then gated per request
 *      (explicit confirm, a key, a notional under the cap, and a placeable pre-trade verdict).
 *      Previewing is always safe locally, so an over-cap or unplaceable order still previews — the
 *      proposal shows the failing gate rather than the kernel hiding it.
 */

export type ExecutionMode = "local" | "serverless";

export type ExecutionSettings = {
  /** EXECUTION_ENABLED — the operator's opt-in. Default false. */
  enabled: boolean;
  /** DRY_RUN — preview only, never send. Default true. */
  dryRun: boolean;
  /** Whether a PRIVATE_KEY is configured. The key itself never reaches this function. */
  hasKey: boolean;
  /** EXECUTION_MAX_NOTIONAL in raw quote units — the ceiling on one order's notional. */
  maxNotional: bigint;
};

export type ExecutionRequest = {
  mode: ExecutionMode;
  /** The caller's explicit, per-request confirmation. Required to send. */
  confirm: boolean;
  /** The order's notional in raw quote units (size × price / oneBase). */
  notional: bigint;
  /** The pre-trade gate verdict: an order the pool would refuse is never sent. */
  placeable: boolean;
};

export type ExecutionDecision =
  | { action: "preview"; reason: string }
  | { action: "send"; reason: string };

/** A refusal with a stated reason, so the caller can show why rather than discover it by trial. */
export class ExecutionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionRefused";
  }
}

export function decideExecution(settings: ExecutionSettings, request: ExecutionRequest): ExecutionDecision {
  if (request.mode !== "local") {
    throw new ExecutionRefused("Execution is local-only. The public deployment is read-only and holds no key; run the lab locally to place a testnet order.");
  }

  const wantsLive = settings.enabled && !settings.dryRun;
  if (!wantsLive) {
    return {
      action: "preview",
      reason: !settings.enabled
        ? "EXECUTION_ENABLED is false — previewing the order, not sending it."
        : "DRY_RUN is true — previewing the order, not sending it.",
    };
  }

  if (request.notional > settings.maxNotional) {
    throw new ExecutionRefused(`Order notional ${request.notional} exceeds the EXECUTION_MAX_NOTIONAL cap ${settings.maxNotional} (raw quote units). Lower the size or raise the cap deliberately.`);
  }
  if (!request.placeable) {
    throw new ExecutionRefused("The pre-trade gate verdict is not placeable, so the order would be refused by the pool. Fix the binding gate before sending.");
  }
  if (!request.confirm) {
    throw new ExecutionRefused("Live execution requires an explicit per-request confirm. This sends a real transaction on the testnet.");
  }
  if (!settings.hasKey) {
    throw new ExecutionRefused("Live execution requires PRIVATE_KEY in the local environment. None is configured, so nothing can be signed.");
  }

  return { action: "send", reason: "Enabled, live, confirmed, keyed, under cap and placeable — sending one testnet order." };
}