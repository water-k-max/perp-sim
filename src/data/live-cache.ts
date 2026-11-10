/**
 *  One short-lived memo for the chain reads that every request repeats: the perp market list and a
 *  pool's live risk parameters.
 *
 *  Both are per-request in `src/backtest-api.ts` — `listPerps` plus `getPerpRiskParams` and
 *  `getEffectiveImfBps` — and neither is cached anywhere, because the dataset cache in
 *  `src/data/store.ts` is keyed by history window, not by market metadata. Locally that costs three
 *  reads per replay and nobody notices. On a deployment it is the same three reads on every warm
 *  invocation, and the instance is the only thing that could remember them.
 *
 *  Off by default, and deliberately so. A stale risk parameter is not a rounding error: `imBps` and
 *  `effectiveImfBps` decide when a simulated position dies, so a local run that quietly reused a
 *  five-minute-old read would report numbers the chain no longer backs — and a test that asserts
 *  "no network, no run" would start passing from memory instead of failing, which is the kind of
 *  green nobody should trust. The entry point for a deployment turns it on for a minute; nothing
 *  else can.
 *
 *  Only the market list and one entry per pool land in here, so the map is bounded by the number of
 *  perp markets at the venue (~21 on Hideki), not by traffic.
 */

export type LiveCacheStats = { reads: number; hits: number; entries: number };

type Slot = { expiresAt: number; value: Promise<unknown> };

const slots = new Map<string, Slot>();
let reads = 0;
let hits = 0;

/** Seconds a live read may be reused. `0` or unset means every request re-reads the venue. */
export function liveCacheSec(): number {
  const raw = process.env.PERP_SIM_LIVE_CACHE_SEC;
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("PERP_SIM_LIVE_CACHE_SEC must be a non-negative number of seconds.");
  return value;
}

export async function onceLive<T>(key: string, read: () => Promise<T>): Promise<T> {
  const ttl = liveCacheSec();
  if (ttl <= 0) return read();
  const now = Date.now();
  const held = slots.get(key);
  if (held && held.expiresAt > now) {
    hits++;
    return (await held.value) as T;
  }
  let entry: Slot | null = null;
  reads++;
  const value = read().catch((error: unknown) => {
    // A failed read must not be remembered, or one indexer hiccup would answer every later request
    // for this key with the same rejection until the TTL ran out.
    if (entry !== null && slots.get(key) === entry) slots.delete(key);
    throw error;
  });
  entry = { expiresAt: now + ttl * 1000, value };
  slots.set(key, entry);
  return (await value) as T;
}

/** What the cache has actually done since the process started — `hits` alone proves nothing. */
export function liveCacheStats(): LiveCacheStats {
  return { reads, hits, entries: slots.size };
}

export function clearLiveCache(): void {
  slots.clear();
  reads = 0;
  hits = 0;
}
