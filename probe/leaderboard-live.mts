/**
 *  Live smoke for the full net-leaderboard orchestration: discover venue-wide, net the top accounts,
 *  rank by net. Light limits so it stays polite to the shared indexer. Read-only — no signer, no write.
 *  Backs the "measured on Hideki" claim for buildLeaderboard itself, not just the discovery probe.
 */
import { createClient } from "../src/client.js";
import { buildLeaderboard } from "../src/verify/leaderboard.js";

const client = createClient().client;
const to = Math.floor(Date.now() / 1000);
const board = await buildLeaderboard({
  client, fromSec: to - 7 * 86_400, toSec: to,
  maxAccounts: 8, discoveryPages: 4, legPages: 2, concurrency: 3,
});
console.log(`window ${board.fromSec} -> ${board.toSec}  quote ${board.quoteSymbol}/${board.quoteDecimals}`);
console.log(`discovered ${board.discovered}  netted ${board.netted}  pages ${board.discovery.pages}  truncated ${board.discovery.truncated}`);
console.log(`discovery rows scanned ${board.discovery.rowsScanned}  in window ${board.discovery.rowsInWindow}`);
for (const w of board.warnings) console.log(`WARN ${w}`);
for (const r of board.rows) {
  console.log(`#${r.rank} ${r.account} net=${r.net} gross=${r.gross} funding=${r.fundingPaid} fees=${r.tradeFees} liq=${r.liquidationFees} closes=${r.closes} markets=${r.markets} ok=${r.ok}`);
  for (const w of r.warnings) console.log(`     row-warn ${w}`);
}