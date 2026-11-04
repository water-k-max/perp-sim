/**
 *  Prop-evaluation simulator (spec §9): the strategy's *own* trading days replayed
 *  against a typed-in rules form.
 *
 *  Days are aggregated from the trade list (UTC day of each trade's exit, exact bigint
 *  PnL). Each resampled path is one simulated evaluation over bootstrap-drawn days:
 *  outcomes are funded / breach (daily-loss or drawdown, rule recorded) / lockout
 *  (consistency cap) / expired (day cap) / idle. Outputs are the share of paths funded,
 *  the trades-to-fund distribution, the expected number of resets before funding, and
 *  average / bad-month payouts after fees.
 *
 *  Honesty framing, kept verbatim in spirit: this replays the strategy's own trading
 *  days against typed-in rules. It predicts nothing about any firm's challenge, and
 *  intraday breach odds are *estimated from observed excursions* — a day whose trades
 *  carry no excursion data is walked at its close-to-close PnL instead, never worse.
 *  Only days that traded are observable, so idle cannot be estimated and stays zero.
 *
 *  Determinism: one derived stream per path (`deriveStream(seed, pathIndex)`); the only
 *  draws are day indices. Equity and every limit are bigint quote units; the payout fee
 *  is an exact integer bps deduction.
 */

import { deriveStream, nextIndex } from "./rng.js";
import type { TradeRecord } from "./inputs.js";

export const DRAWDOWN_MODES = ["static", "trailing_eod", "trailing_intraday"] as const;
export type DrawdownMode = (typeof DRAWDOWN_MODES)[number];

export const PAYOUT_CADENCES = ["monthly", "one_time"] as const;
export type PayoutCadence = (typeof PAYOUT_CADENCES)[number];

export type PropPhase = {
  /** Profit target in decimal quote units to complete the phase. */
  profitTarget: string;
  /** One day may not contribute more than this many bps of the phase's cumulative profit. */
  consistencyCapBps: number | null;
};

export type PropRules = {
  /** Evaluation balance in decimal quote units; null = the run's start equity. */
  startingBalance: string | null;
  drawdownMode: DrawdownMode;
  /** True = the trailing drawdown reference locks once the total profit target is reached. */
  drawdownLocks: boolean;
  /** Maximum same-day loss in decimal quote units. */
  dailyLossLimit: string;
  /** Maximum drawdown from the mode's reference, in decimal quote units. */
  drawdownLimit: string;
  phases: PropPhase[];
  payoutCadence: PayoutCadence;
  /** Fee deducted from payouts, integer basis points. */
  payoutFeeBps: number;
  /** Hard cap on evaluation length in trading days. */
  maxDays: number;
};

const DECIMAL = /^\d{1,15}(\.\d{1,18})?$/;

function parseDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || Number(value) <= 0)
    throw new Error(`prop ${field} must be a positive decimal.`);
  return value;
}

export function parsePropRules(value: unknown): PropRules {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("prop rules must be an object.");
  const v = value as Record<string, unknown>;

  const startingBalance = v.startingBalance === undefined || v.startingBalance === null ? null : v.startingBalance;
  if (startingBalance !== null && (typeof startingBalance !== "string" || !DECIMAL.test(startingBalance) || Number(startingBalance) <= 0))
    throw new Error("prop startingBalance must be a positive decimal.");

  const drawdownMode: unknown = v.drawdownMode ?? "trailing_eod";
  if (typeof drawdownMode !== "string" || !(DRAWDOWN_MODES as readonly string[]).includes(drawdownMode)) throw new Error("prop drawdownMode must be static, trailing_eod or trailing_intraday.");

  const drawdownLocks: unknown = v.drawdownLocks ?? false;
  if (typeof drawdownLocks !== "boolean") throw new Error("prop drawdownLocks must be a boolean.");

  const dailyLossLimit = parseDecimal(v.dailyLossLimit, "dailyLossLimit");
  const drawdownLimit = parseDecimal(v.drawdownLimit, "drawdownLimit");

  if (!Array.isArray(v.phases) || v.phases.length < 1 || v.phases.length > 4) throw new Error("prop phases must list one to four phases.");
  const phases: PropPhase[] = v.phases.map((raw) => {
    if (typeof raw !== "object" || raw === null) throw new Error("prop phase must be an object.");
    const p = raw as Record<string, unknown>;
    const profitTarget = parseDecimal(p.profitTarget, "phase profitTarget");
    const consistencyCapBps: unknown = p.consistencyCapBps === undefined || p.consistencyCapBps === null ? null : p.consistencyCapBps;
    if (consistencyCapBps !== null && (!Number.isInteger(consistencyCapBps) || Number(consistencyCapBps) < 1 || Number(consistencyCapBps) > 10_000))
      throw new Error("prop consistencyCapBps must be a whole number of basis points in [1, 10000].");
    return { profitTarget, consistencyCapBps: consistencyCapBps as number | null };
  });

  const payoutCadence: unknown = v.payoutCadence ?? "monthly";
  if (typeof payoutCadence !== "string" || !(PAYOUT_CADENCES as readonly string[]).includes(payoutCadence)) throw new Error("prop payoutCadence must be monthly or one_time.");

  const payoutFeeBps: unknown = v.payoutFeeBps ?? 0;
  if (!Number.isInteger(payoutFeeBps) || Number(payoutFeeBps) < 0 || Number(payoutFeeBps) > 10_000)
    throw new Error("prop payoutFeeBps must be a whole number in [0, 10000].");

  const maxDays = v.maxDays ?? 120;
  if (!Number.isInteger(maxDays) || Number(maxDays) < 1 || Number(maxDays) > 10_000)
    throw new Error("prop maxDays must be a whole number in [1, 10000].");

  return {
    startingBalance: startingBalance as string | null,
    drawdownMode: drawdownMode as DrawdownMode,
    drawdownLocks: drawdownLocks as boolean,
    dailyLossLimit,
    drawdownLimit,
    phases,
    payoutCadence: payoutCadence as PayoutCadence,
    payoutFeeBps: Number(payoutFeeBps),
    maxDays: Number(maxDays),
  };
}

/** One aggregated trading day: exact PnL plus an observed-intraday worst estimate. */
export type TradeDay = {
  /** Unix days since epoch (UTC). */
  dayIndex: number;
  pnl: bigint;
  /** Lowest the equity provably sat that day (signed, ≤ pnl); equals pnl when no excursion data exists. */
  intradayWorst: bigint;
  tradeCount: number;
  /** Trades walked at their close PnL because they carry no excursion data. */
  missingExcursionCount: number;
};

export function aggregateTradeDays(trades: readonly TradeRecord[]): TradeDay[] {
  const byDay = new Map<number, TradeRecord[]>();
  for (const t of trades) {
    const dayIndex = Math.floor(t.exitTs / 86_400);
    const bucket = byDay.get(dayIndex);
    if (bucket) bucket.push(t);
    else byDay.set(dayIndex, [t]);
  }
  const days: TradeDay[] = [];
  for (const [dayIndex, bucket] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    bucket.sort((a, b) => a.seq - b.seq);
    let pnl = 0n;
    let running = 0n;
    let intradayWorst = 0n;
    let missing = 0;
    for (const t of bucket) {
      pnl += t.pnl;
      running += t.pnl;
      const worst = running + (t.mae ?? (missing += 1, 0n));
      if (worst < intradayWorst) intradayWorst = worst;
    }
    days.push({ dayIndex, pnl, intradayWorst, tradeCount: bucket.length, missingExcursionCount: missing });
  }
  return days;
}

export const PROP_OUTCOMES = ["funded", "breach_daily_loss", "breach_drawdown", "lockout", "expired", "idle"] as const;
export type PropOutcome = (typeof PROP_OUTCOMES)[number];

export type PropPathResult = {
  outcome: PropOutcome;
  daysUsed: number;
  tradesUsed: number;
  /** Day PnLs in draw order, up to the terminal event — raw material for payouts. */
  dayPnls: bigint[];
  finalEquity: bigint;
};

export type PropSimulateOptions = {
  days: readonly TradeDay[];
  rules: PropRules;
  seed: string | number | bigint;
  paths: number;
  /** Starting equity in raw quote units. */
  start: bigint;
  /** Parse a decimal quote-unit string into raw units exactly. */
  toRaw: (decimal: string) => bigint;
};

function simulatePath(opts: PropSimulateOptions, pathIndex: number): PropPathResult {
  const { rules, days } = opts;
  const rng = deriveStream(opts.seed, pathIndex);
  const dailyLoss = opts.toRaw(rules.dailyLossLimit);
  const drawdownLimit = opts.toRaw(rules.drawdownLimit);
  const targets = rules.phases.map((p) => opts.toRaw(p.profitTarget));
  const totalTarget = targets.reduce((a, b) => a + b, 0n);

  let equity = opts.start;
  let reference = opts.start; // static: never moves; trailing: ratchets with equity
  let locked = false;
  let phaseIdx = 0;
  let phaseCum = 0n;
  let daysUsed = 0;
  let tradesUsed = 0;
  const dayPnls: bigint[] = [];

  const terminal = (outcome: PropOutcome): PropPathResult => ({
    outcome, daysUsed, tradesUsed, dayPnls, finalEquity: equity,
  });

  while (daysUsed < rules.maxDays) {
    const day = days[nextIndex(rng, days.length)]!;
    const dayStart = equity;
    const endOfDay = dayStart + day.pnl;
    // The intraday estimate is the observed excursion low; EOD modes check the close only.
    const worstPoint = rules.drawdownMode === "trailing_intraday" && dayStart + day.intradayWorst < endOfDay
      ? dayStart + day.intradayWorst
      : endOfDay;

    // Daily loss is an intraday rule: measured against the observed excursion low.
    if (day.intradayWorst <= -dailyLoss) return terminal("breach_daily_loss");

    if (rules.drawdownMode !== "static" && !locked) {
      // Trailing reference ratchets with equity (intraday modes also ratchet on the
      // observed intraday high, which is the day start when the day lost money) and
      // freezes once it locks.
      let peak = endOfDay;
      if (rules.drawdownMode === "trailing_intraday" && dayStart > peak) peak = dayStart;
      if (peak > reference) reference = peak;
    }
    if (reference - worstPoint >= drawdownLimit) return terminal("breach_drawdown");

    equity = endOfDay;
    dayPnls.push(day.pnl);
    tradesUsed += day.tradeCount;
    daysUsed += 1;
    phaseCum += day.pnl;

    const cap = rules.phases[phaseIdx]!.consistencyCapBps;
    if (cap !== null && phaseCum > 0n && day.pnl * 10_000n > BigInt(cap) * phaseCum) return terminal("lockout");

    if (phaseCum >= targets[phaseIdx]!) {
      phaseIdx += 1;
      phaseCum = 0n;
      if (rules.drawdownLocks && !locked && equity >= opts.start + totalTarget) {
        locked = true; // the trailing reference freezes at its current high-water mark
      }
      if (phaseIdx === rules.phases.length) return terminal("funded");
    }
  }
  return terminal("expired");
}

export type PropPayouts = {
  cadence: PayoutCadence;
  feeBps: number;
  /** Mean payout across funded paths (monthly: across all drawn months). */
  average: bigint;
  /** 5th percentile payout — the bad month. Decimal interpolation happens at the edge. */
  bad: bigint;
  /** Exact payout values, payout order, for the edge's percentile step. */
  values: bigint[];
};

export type PropResult = {
  rules: PropRules;
  dayCount: number;
  daysWithMissingExcursion: number;
  outcomes: { outcome: PropOutcome; count: number; share: number }[];
  fundedShare: number;
  /** Trades consumed until funded, over funded paths only. */
  tradesToFund: { values: number[]; median: number; p05: number; p95: number } | null;
  medianDaysToFund: number | null;
  /** Expected evaluation restarts before one funds: (1 - p) / p. Null when no path funds. */
  expectedResets: number | null;
  payouts: PropPayouts | null;
  notes: string[];
};

export function simulatePropEvaluation(opts: PropSimulateOptions): PropResult {
  const { rules, days } = opts;
  if (days.length === 0) throw new Error("prop evaluation needs at least one trading day");

  const results: PropPathResult[] = [];
  for (let i = 0; i < opts.paths; i += 1) results.push(simulatePath(opts, i));

  const counts = new Map<PropOutcome, number>();
  for (const outcome of PROP_OUTCOMES) counts.set(outcome, 0);
  for (const r of results) counts.set(r.outcome, counts.get(r.outcome)! + 1);
  const funded = results.filter((r) => r.outcome === "funded");
  const fundedShare = funded.length / opts.paths;

  const tradesToFund = funded.length === 0 ? null : (() => {
    const values = funded.map((r) => r.tradesUsed);
    const sorted = values.slice().sort((a, b) => a - b);
    const quantile = (q: number) => {
      const pos = q * (sorted.length - 1);
      const lo = Math.floor(pos);
      return sorted[lo]! + (sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * (pos - lo);
    };
    return { values: values.map(Number), median: quantile(0.5), p05: quantile(0.05), p95: quantile(0.95) };
  })();

  const feeFactor = 10_000n - BigInt(rules.payoutFeeBps);
  const payoutValues: bigint[] = [];
  if (funded.length > 0) {
    for (const r of funded) {
      if (rules.payoutCadence === "one_time") {
        const profit = r.finalEquity - opts.start;
        payoutValues.push((profit > 0n ? profit : 0n) * feeFactor / 10_000n);
      } else {
        for (let i = 0; i < r.dayPnls.length; i += 21) {
          const month = r.dayPnls.slice(i, i + 21).reduce((a, b) => a + b, 0n);
          payoutValues.push((month > 0n ? month : 0n) * feeFactor / 10_000n);
        }
      }
    }
  }
  const sortedPayouts = payoutValues.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const payouts: PropPayouts | null = payoutValues.length === 0 ? null : {
    cadence: rules.payoutCadence,
    feeBps: rules.payoutFeeBps,
    average: payoutValues.reduce((a, b) => a + b, 0n) / BigInt(payoutValues.length),
    bad: sortedPayouts[Math.max(0, Math.floor(0.05 * (sortedPayouts.length - 1)))]!,
    values: payoutValues,
  };

  const missing = days.reduce((sum, d) => sum + d.missingExcursionCount, 0);
  return {
    rules,
    dayCount: days.length,
    daysWithMissingExcursion: missing,
    outcomes: PROP_OUTCOMES.map((outcome) => ({
      outcome,
      count: counts.get(outcome)!,
      share: counts.get(outcome)! / opts.paths,
    })),
    fundedShare,
    tradesToFund,
    medianDaysToFund: funded.length === 0 ? null : funded.map((r) => r.daysUsed).sort((a, b) => a - b)[Math.floor(funded.length / 2)]!,
    expectedResets: fundedShare > 0 ? (1 - fundedShare) / fundedShare : null,
    payouts,
    notes: [
      "Replays the strategy's own trading days against typed-in rules; it predicts nothing about any firm's challenge.",
      "Intraday breach odds are estimated from observed excursions; days without excursion data are walked at their close PnL, never worse.",
      "Only days that traded are observable, so idle time is not estimated and stays zero.",
      ...(rules.drawdownLocks ? ["The trailing drawdown reference locks at its high-water mark once the total profit target is reached."] : []),
    ],
  };
}

