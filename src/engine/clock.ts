/**
 *  A replay needs one total order over everything that happens, or two runs of the same
 *  input can disagree on a fee. Time alone is not enough: a settlement bar and a fill can
 *  share a timestamp, and two orders submitted in the same bar must keep their submission
 *  order. Events sort by time, then eligibility registration first, then chain position,
 *  then rank (`fill`, `bar`, `end`) and submission sequence. Missing chain positions
 *  sort after known positions, with fill-before-bar as the synthetic-data fallback.
 *  Dynamically submitted events cannot rewind events already processed; the loop also
 *  excludes already-observed prints when registering zero-latency callback orders.
 *
 *  The order is total, so a run is a pure function of its inputs and its event hash means
 *  something.
 */
export type Rank = "order" | "fill" | "bar" | "end";

const RANK: Record<Rank, number> = { order: 0, fill: 1, bar: 2, end: 3 };

export type ChainPosition = { block: number; logIndex: number };
export type Queued<T> = { t: number; rank: Rank; seq: number; payload: T; position?: ChainPosition };

export class EventQueue<T> {
  private items: Queued<T>[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.items.length;
  }

  push(t: number, rank: Rank, payload: T, position?: ChainPosition): void {
    const item: Queued<T> = { t, rank, seq: this.nextSeq, payload, position };
    this.nextSeq += 1;
    // Binary search for the first item that sorts after this one, then splice.
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(this.items[mid]!, item) <= 0) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, item);
  }

  shift(): Queued<T> | undefined {
    return this.items.shift();
  }

  /** Drop everything still queued, e.g. after a liquidation ends the run. */
  clear(): void {
    this.items.length = 0;
  }

  snapshot(): Queued<T>[] {
    return [...this.items];
  }
}

function compare<T>(a: Queued<T>, b: Queued<T>): number {
  if (a.t !== b.t) return a.t - b.t;
  // Eligibility registers first. Executions/settlements then follow chain order;
  // without chain metadata the legacy fill-before-bar rank is the fallback.
  if (a.rank === "order" || b.rank === "order") {
    const rank = RANK[a.rank] - RANK[b.rank];
    if (rank) return rank;
  }
  const chain = (a.position?.block ?? Number.MAX_SAFE_INTEGER) - (b.position?.block ?? Number.MAX_SAFE_INTEGER) ||
    (a.position?.logIndex ?? Number.MAX_SAFE_INTEGER) - (b.position?.logIndex ?? Number.MAX_SAFE_INTEGER);
  if (chain) return chain;
  const ra = RANK[a.rank];
  const rb = RANK[b.rank];
  if (ra !== rb) return ra - rb;
  return a.seq - b.seq;
}
