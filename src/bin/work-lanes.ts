export type LaneLimits = {
  concurrency: number;
  queueLimit: number;
};

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

type Entry = {
  work: () => Promise<unknown>;
  deferred: Deferred;
  promise: Promise<unknown>;
  waiters: number;
};

/** Every lane is occupied and the queue is full, so this request will not start. */
export class LaneBusy extends Error {
  constructor(
    readonly running: number,
    readonly waiting: number,
    readonly concurrency: number,
    readonly queueLimit: number,
  ) {
    super(`All ${concurrency} lanes are busy and ${queueLimit} request(s) are already queued.`);
    this.name = "LaneBusy";
  }

  /**
   *  A floor, not a duration estimate: the lanes keep no timing history, and a wait that was
   *  guessed from the last job would be wrong for a queue. The routes send it as `Retry-After`.
   */
  get retryAfterSeconds(): number {
    return 2;
  }
}

/**
 *  Bounded concurrency with request coalescing, replacing the one-slot lock this file took over.
 *
 *  A single lock made every heavy route depend on every other one: a wallet reconciliation for an
 *  unrelated market refused a backtest that was about to finish, and a double-clicked form got
 *  "try again later" instead of the result it was already waiting for. The limit belongs to the
 *  work, so the queue is per-request and the answers are shared:
 *
 *  - **Coalescing.** A key identifies a job. A caller that arrives while that job is running, or
 *    queued, or even finished-but-not-yet-resolved joins it rather than starting a second copy —
 *    so eight tabs asking for the same resample cost one indexer read and eight sockets.
 *  - **Queueing.** Once all lanes are busy, up to `queueLimit` requests wait in arrival order.
 *  - **Refusal.** Past the queue, `submit` rejects with `LaneBusy`, which carries the depth it saw
 *    so the route can answer 429 with a `Retry-After` instead of hanging a client indefinitely.
 *
 *  There is deliberately no deadline on a queued request. Dropping the waiter while its work runs
 *  would let a second copy of the same expensive replay start behind it, which is the exact failure
 *  the coalescing exists to prevent; the queue limit is what bounds the wait instead.
 *
 *  Nothing here reads a clock, a random source or the network, so the lanes are testable with
 *  plain deferred promises and the routes own the policy of what a key means.
 */
export class WorkLanes {
  private readonly concurrency: number;
  private readonly queueLimit: number;
  private readonly entries = new Map<string, Entry>();
  private readonly waiting: string[] = [];
  private running = 0;
  private startedCount = 0;
  private coalescedCount = 0;
  private refusedCount = 0;

  constructor(limits: LaneLimits) {
    if (!Number.isInteger(limits.concurrency) || limits.concurrency < 1) throw new Error("lane concurrency must be an integer of at least 1");
    if (!Number.isInteger(limits.queueLimit) || limits.queueLimit < 0) throw new Error("lane queueLimit must be an integer of at least 0");
    this.concurrency = limits.concurrency;
    this.queueLimit = limits.queueLimit;
  }

  /**
   *  Run `work` for `key`, or join the run already in flight for it. `key` must identify the
   *  request, not the caller: the routes build it from their validated inputs so two spellings of
   *  one request cannot start two replays.
   */
  submit<T>(key: string, work: () => Promise<T>): Promise<T> {
    // Rejected rather than thrown: the routes `await` this, and a caller that forgot to wrap its
    // `submit` in the same error handling as the job's own failures would take the server down.
    if (!key) return Promise.reject(new Error("a lane key is required"));
    const existing = this.entries.get(key);
    if (existing) {
      existing.waiters++;
      this.coalescedCount++;
      return existing.promise as Promise<T>;
    }
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.queueLimit) {
        this.refusedCount++;
        return Promise.reject(new LaneBusy(this.running, this.waiting.length, this.concurrency, this.queueLimit));
      }
      // Joining a queue that a *different* key will empty is a false wait; the entry is created
      // here so an identical request that lands while this one queues still coalesces onto it.
      const entry = this.create(key, work);
      this.waiting.push(key);
      return entry.promise as Promise<T>;
    }
    const entry = this.create(key, work);
    this.begin(key, entry);
    return entry.promise as Promise<T>;
  }

  private create<T>(key: string, work: () => Promise<T>): Entry {
    let deferred!: Deferred;
    const promise = new Promise<unknown>((resolve, reject) => { deferred = { resolve, reject }; });
    const entry: Entry = { work: work as () => Promise<unknown>, deferred, promise, waiters: 1 };
    this.entries.set(key, entry);
    return entry;
  }

  private begin(key: string, entry: Entry): void {
    this.running++;
    this.startedCount++;
    // Scheduling on the microtask queue keeps a throwing `work` from rejecting inside the caller's
    // synchronous `submit`, where it would look like an argument error rather than a failed job.
    Promise.resolve().then(entry.work).then(
      (value) => { this.release(key); entry.deferred.resolve(value); },
      (error) => { this.release(key); entry.deferred.reject(error); },
    );
  }

  private release(key: string): void {
    this.running--;
    this.entries.delete(key);
    this.drain();
  }

  private drain(): void {
    if (this.running >= this.concurrency) return;
    const next = this.waiting.shift();
    if (next === undefined) return;
    const entry = this.entries.get(next);
    // A queued key whose job already resolved cannot exist: entries are removed only by their own
    // release, which is what just called this. Reaching this line means the bookkeeping is broken,
    // and a queued request left hanging forever is worse than a crash the test can see.
    if (!entry) throw new Error(`lane bookkeeping lost queued key ${next}`);
    this.begin(next, entry);
  }

  get status(): { running: number; waiting: number; active: number; started: number; coalesced: number; refused: number } {
    return {
      running: this.running,
      waiting: this.waiting.length,
      active: this.entries.size,
      started: this.startedCount,
      coalesced: this.coalescedCount,
      refused: this.refusedCount,
    };
  }
}
