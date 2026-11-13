/**
 *  One lightweight venue-wide closing discovery read in the exact shape the leaderboard uses
 *  (kinds + desc). Prints HEALTH_OK when the indexer serves it, HEALTH_FAIL otherwise. Read-only.
 *  Used to detect indexer recovery without hammering the full board read. `desc` is the served
 *  shape; `asc` is refused (see probe/leaderboard-order.mts), so an asc health read would report
 *  HEALTH_FAIL on a healthy indexer.
 */
import { createClient } from "../src/client.js";

const client = createClient().client;
const to = Math.floor(Date.now() / 1000);
try {
  const rows = await client.listPerpPositionChanges({ kinds: ["REDUCE", "CLOSE", "FLIP"], from: to - 86400, to, order: "desc", limit: 10 });
  console.log(`HEALTH_OK desc discovery served ${rows.length} rows`);
} catch (e) {
  console.log(`HEALTH_FAIL ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 110)}`);
}