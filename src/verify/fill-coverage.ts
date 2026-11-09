/**
 *  What a paginated fill read actually covered, as the reconcile reports it.
 *
 *  This is fill-read coverage — how much of the requested window the indexer handed over — not
 *  the run panel's candle/settlement coverage. It is a plain JSON shape so the browser panel and
 *  the CLI can share one wording, and it carries no SDK or Node dependency.
 */
export type FillReadCoverage = {
  /** Oldest and newest fill actually reconciled — the window this read truly describes. */
  firstFillSec: number | null;
  lastFillSec: number | null;
  /** Rows the indexer returned across all pages, before the pool and window filters. */
  rowsScanned: number;
  /** Rows that survived the filters, before the cap. */
  rowsInWindow: number;
  /** Rows this reconcile used. */
  rowsKept: number;
  pages: number;
  /** True when the read did not reach the start of the requested window. */
  truncated: boolean;
  stoppedBy: "maxFills" | "page-bound" | null;
  /**
   *  The indexer's own count of this account's perp fills on this pool in the window. Taken only
   *  when the page read fell short — a read whose cursor ran out is already proved complete, and
   *  the count costs a 10,001-row scan. Null otherwise, or when the count read failed: it is
   *  advisory, and its absence must not turn a working reconcile into an error.
   */
  accountFillsInWindow: number | null;
  /** True when that count reached the indexer's hard ceiling, i.e. it is a lower bound. */
  accountFillsAtCeiling: boolean;
};

export type CoverageStamp = { tone: "complete" | "partial" | "empty"; label: string; text: string };

const stamp = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ");

/** Grouped by hand: `toLocaleString` depends on the ICU build, and this sentence is asserted in tests. */
const group = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const count = (n: number, word: string): string => `${group(n)} ${word}${n === 1 ? "" : "s"}`;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/**
 *  The coverage object as the server's contract, checked before anything renders it.
 *
 *  The whole point of the stamp is to be trusted, so a payload that does not carry a real
 *  coverage block is refused here rather than rendered as a guess.
 */
export function parseCoverage(value: unknown): FillReadCoverage {
  const bad = (): never => { throw new Error("Unexpected response."); };
  if (typeof value !== "object" || value === null) bad();
  const c = value as Record<string, unknown>;
  const nullableInt = (v: unknown) => v === null || isInt(v);
  if (!nullableInt(c.firstFillSec) || !nullableInt(c.lastFillSec)) bad();
  if (!isInt(c.rowsScanned) || !isInt(c.rowsInWindow) || !isInt(c.rowsKept) || !isInt(c.pages)) bad();
  if ((c.rowsScanned as number) < 0 || (c.rowsInWindow as number) < 0 || (c.rowsKept as number) < 0 || (c.pages as number) < 1) bad();
  if (typeof c.truncated !== "boolean" || typeof c.accountFillsAtCeiling !== "boolean") bad();
  if (!(c.stoppedBy === null || c.stoppedBy === "maxFills" || c.stoppedBy === "page-bound")) bad();
  if (!(c.accountFillsInWindow === null || (isInt(c.accountFillsInWindow) && c.accountFillsInWindow >= 0))) bad();
  return c as unknown as FillReadCoverage;
}

/** `1,200 the indexer counts here`, or the rows the read itself saw when the count read failed. */
function population(coverage: FillReadCoverage): string {
  if (coverage.accountFillsInWindow === null) return `${count(coverage.rowsInWindow, "fill")} the read itself returned`;
  const atLeast = coverage.accountFillsAtCeiling ? "at least " : "";
  return `${atLeast}${count(coverage.accountFillsInWindow, "fill")} the indexer counts here`;
}

/**
 *  One sentence saying what a chain read actually covered.
 *
 *  Every number the wallet panel shows comes from a paginated indexer read that can stop early,
 *  and the indexer's own count is capped, so a fill list is not automatically the whole window.
 *  The wording lives in this one function so a truncated read cannot be presented as a complete
 *  one by a second panel forgetting to say so. `parseCoverage` is what lets this take the shape
 *  as given. This is fill-read coverage; the run panel's "Data coverage" is candle and
 *  settlement coverage, which is a different question.
 */
export function fillCoverageStamp(coverage: FillReadCoverage): CoverageStamp {
  const span = coverage.firstFillSec !== null && coverage.lastFillSec !== null
    ? `${stamp(coverage.firstFillSec)} → ${stamp(coverage.lastFillSec)} UTC`
    : "no fills at all";
  if (coverage.rowsKept === 0) {
    return {
      tone: "empty",
      label: "No fills",
      text: coverage.truncated
        ? `This read kept no fills and stopped before reaching the start of the window, so it cannot say the window is empty. ${count(coverage.rowsScanned, "row")} scanned over ${count(coverage.pages, "page")}.`
        : `The read ran to the end of the indexer's page cursor and kept no fills. That is the answer, not a short read (${count(coverage.rowsScanned, "row")} scanned over ${count(coverage.pages, "page")}).`,
    };
  }
  if (coverage.truncated) {
    const why = coverage.stoppedBy === "maxFills" ? "the fill cap bound the read"
      : coverage.stoppedBy === "page-bound" ? `the read stopped at its ${coverage.pages}-page bound`
        : "the read stopped before the start of the window";
    return {
      tone: "partial",
      label: "Partial window",
      text: `Booked ${group(coverage.rowsKept)} of ${population(coverage)} across ${count(coverage.pages, "page")}; ${why}. The fills behind these numbers run ${span} — a sub-window, so every total here describes that slice only.`,
    };
  }
  return {
    tone: "complete",
    label: "Full window read",
    text: `Read every fill in the window: ${count(coverage.rowsKept, "fill")} across ${count(coverage.pages, "page")}, ${span}. The indexer's page cursor ran out, which is what "every" rests on.`,
  };
}
