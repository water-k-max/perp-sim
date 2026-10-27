/**
 *  Retry the reads the Hideki RPC drops on the floor.
 *
 *  The SDK sends every chain read over one WebSocket with a fixed 4s connect budget
 *  (`WS_CONNECT_TIMEOUT_MS`, `dist/client.js:29`) and no HTTP fallback behind it. A handshake
 *  that exceeds it surfaces as `RpcError: rpc getBlock failed: genesis check failed` carrying an
 *  empty request body — a message that names the genesis check, not the socket that did not open
 *  in time. A backtester cannot tell a genuine result apart from an outage, so the retry is
 *  bounded and it says out loud when it fired.
 */
const RETRYABLE = /genesis check failed|took too long|timed out|Socket closed|connection|SocketClosed/i;

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
