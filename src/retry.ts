/**
 *  Retry the reads the Hideki RPC drops on the floor.
 *
 *  The SDK sends every chain read over one WebSocket with a fixed 4s connect budget
 *  (`WS_CONNECT_TIMEOUT_MS`, `dist/client.js:29`) and no HTTP fallback behind it. A handshake
 *  that exceeds it surfaces as `RpcError: rpc getBlock failed: genesis check failed` carrying an
 *  empty request body — a message that names the genesis check, not the socket that did not open
 *  in time. A backtester cannot tell a genuine result apart from an outage, so the retry is
 *  bounded and it says out loud when it fired.
 *
 *  The indexer's own transient failure is in here too. `database query error` is what Hasura
 *  answers when the SQL behind one read did not complete — measured on Hideki 2026-11-09, the
 *  identical `PerpPositionChanges` read over the same 2,000 fills returned `0 unmatched` on one run
 *  and threw `indexer PerpPositionChanges failed: database query error` on the next, with no change
 *  to the query, the account or the window. The SDK wraps that as an `IndexerError` that preserves
 *  the server's wording, so matching the phrase is the only way to tell it apart from a read that
 *  is wrong on purpose. Permanent failures — a field this role may not query, an unusable variable,
 *  a table that has not been indexed — keep their own distinct messages and still abort.
 */
const RETRYABLE =
  /genesis check failed|took too long|timed out|timeout|database query error|Socket closed|connection|fetch failed|EAI_AGAIN|ECONNRESET|ECONNREFUSED/i;

export async function retryRead<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 5,
  note: (message: string) => void = (m) => console.error(m),
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!RETRYABLE.test((error as Error).message ?? "")) throw error;
      if (i === attempts) break;
      note(`  retrying ${label} after ${(error as Error).message.split("\n")[0].slice(0, 90)} (attempt ${i}/${attempts})`);
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  throw last;
}
