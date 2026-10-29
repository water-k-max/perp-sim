import type { Coverage } from "../history/bars.js";
import type { RunResult } from "../engine/loop.js";
import { hashRun } from "../engine/loop.js";
import { attribute } from "../analytics/attribution.js";

/**
 *  What a run must satisfy to be trusted, stated once and checked mechanically.
 *
 *  A check that cannot be evaluated on this venue returns `skip` with the reason, never a
 *  pass: "no historical book depth" is a fact about the data, and pretending it is verified
 *  is worse than admitting it is not.
 */
export type InvariantSeverity = "error" | "warn";
export type InvariantStatus = "pass" | "fail" | "skip";

export type Invariant = {
  id: string;
  status: InvariantStatus;
  severity: InvariantSeverity;
  detail: string;
};

const FEE_SCALE = 10_000n * 1_000n;

export function checkRun(run: RunResult, extras: { coverage?: Coverage } = {}): Invariant[] {
  const out: Invariant[] = [];
  const verdict = (id: string, ok: boolean, severity: InvariantSeverity, detail: string): void => {
    out.push({ id, status: ok ? "pass" : "fail", severity, detail });
  };

  const attribution = attribute(run);
  verdict(
    "equity-identity",
    attribution.residual === 0n,
    "error",
    attribution.residual === 0n
      ? `equity change ${attribution.delta} = price ${attribution.price} - funding ${attribution.funding} - fees ${run.feesTaker + run.feesMaker} - gas ${run.gasPaid}`
      : `residual ${attribution.residual} raw units: price ${attribution.price}, funding ${attribution.funding}, delta ${attribution.delta}`,
  );

  const signed = run.fills.reduce((sum, f) => sum + (f.side === "buy" ? f.size : -f.size), 0n);
  const finalSize = run.status === "closed" ? 0n : (run.trail[run.trail.length - 1]?.size ?? 0n);
  verdict(
    "quantity-identity",
    signed === finalSize,
    "error",
    `fills net to ${signed}, final position is ${finalSize}`,
  );

  let feeOk = true;
  let feeDetail = `${run.fills.length} fills recompute exactly`;
  for (const fill of run.fills) {
    const expected = (fill.quote * fill.feeBps) / FEE_SCALE;
    if (expected !== fill.fee) {
      feeOk = false;
      feeDetail = `fill ${fill.id} charged ${fill.fee}, expected ${expected} at ${fill.feeBps} bpsx1k`;
      break;
    }
  }
  verdict("fee-recompute", feeOk, "error", feeDetail);

  let lookahead: string | null = null;
  for (const order of run.orders) {
    if (order.status === "rejected") continue;
    if (order.price === null) continue;
    const terminal = order.tag === "terminal-close" && order.reduceOnly;
    const earliest = terminal || run.model.fillModel === "settlement-mark" ? order.decidedAt : order.decidedAt + run.model.latencySec;
    if (order.eligibleAt < earliest) {
      lookahead = `order ${order.id} could trade at ${order.eligibleAt}, before ${earliest}`;
      break;
    }
  }
  const end = run.trail[run.trail.length - 1]?.t ?? -Infinity;
  for (const fill of run.fills) {
    const order = run.orders.find(o => o.id === fill.orderId);
    if (!order || fill.t < order.eligibleAt || fill.t < order.decidedAt || fill.t > end) {
      lookahead = `fill ${fill.id} at ${fill.t} is outside its decision/eligibility/run horizon`;
      break;
    }
    if (fill.t === order.decidedAt && order.decidedBlock !== undefined && fill.block !== undefined) {
      const decisionLog = order.decidedLogIndex ?? Number.MAX_SAFE_INTEGER;
      const fillLog = fill.logIndex ?? Number.MAX_SAFE_INTEGER;
      const terminal = order.tag === "terminal-close" && order.reduceOnly;
      if (fill.block < order.decidedBlock || (fill.block === order.decidedBlock &&
        (fillLog < decisionLog || (!terminal && fillLog === decisionLog)))) {
        lookahead = `fill ${fill.id} at ${fill.block}:${fillLog} is not after decision ${order.decidedBlock}:${decisionLog}`;
        break;
      }
    }
  }
  verdict("no-lookahead", lookahead === null, "error", lookahead ?? "actual fills respect decision, eligibility and run end (terminal closes exempt from latency)");

  verdict(
    "determinism",
    hashRun(run) === run.eventHash,
    "error",
    hashRun(run) === run.eventHash ? `result integrity hash ${run.eventHash.slice(0, 16)}; self-hash is not independent proof of determinism` : "result integrity hash differs from the recorded one",
  );

  if (extras.coverage) {
    const c = extras.coverage;
    verdict(
      "coverage-complete",
      c.missingSettlements === 0 && c.gaps === 0,
      "error",
      `${c.bars} bars, ${c.missingSettlements} missing settlements, ${c.gaps} gaps`,
    );
  } else {
    out.push({ id: "coverage-complete", status: "skip", severity: "error", detail: "no coverage summary supplied" });
  }

  const negative = run.trail.some((t) => t.equityAtMark < 0n);
  out.push({
    id: "equity-nonnegative",
    status: run.liquidatedAtBar === null && negative ? "fail" : "pass",
    severity: "warn",
    detail:
      run.liquidatedAtBar === null && negative
        ? "equity went negative without a liquidation bar"
        : run.liquidatedAtBar !== null
          ? `liquidated at bar ${run.liquidatedAtBar}`
          : "equity stayed non-negative on every marked bar",
  });

  out.push({
    id: "liquidation-fill-modelled",
    status: "skip",
    severity: "warn",
    detail: "a liquidation ends the run at the adverse extreme; no liquidation fill price exists in the tape",
  });
  out.push({
    id: "book-not-crossed",
    status: "skip",
    severity: "warn",
    detail: "no historical order-book depth is published for this venue, so queue position is not modelled",
  });

  return out;
}

export function invariantsOk(list: readonly Invariant[]): boolean {
  return list.every((i) => i.status !== "fail");
}
