import { fileURLToPath } from "node:url";
import { createPorts } from "../trade/adapter.js";
import { HELP, parseArgs, SafetyError } from "../trade/input.js";
import { Journal } from "../trade/journal.js";
import { runTrade } from "../trade/workflow.js";

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") { console.log(HELP); return; }
  const options = parseArgs(process.argv.slice(2));
  const adapter = createPorts();
  try {
    await runTrade(options, adapter.ports, new Journal(fileURLToPath(new URL("../../tmp/trade-journal", import.meta.url))));
  } finally { await adapter.close(); }
}
main().catch((error: unknown) => {
  console.error(error instanceof SafetyError ? error.message : "Trade stopped. Inspect local journal for unresolved hash/nonce; no automatic retry. Provider/signer details withheld.");
  process.exitCode = 1;
});
