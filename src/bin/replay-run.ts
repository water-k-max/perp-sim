import { replaySavedRun } from "../backtest-api.js";

const id = process.argv[2];
if (!id || !/^[a-f0-9]{64}$/.test(id)) {
  console.error("usage: pnpm replay-run <run-id>");
  process.exit(1);
}
try {
  const result = await replaySavedRun(id);
  console.log(`Reproduced ${result.manifest.runId}`);
  console.log(`Event hash ${result.eventHash}`);
  console.log(`Ending equity ${result.equityEnd} ${result.quoteSymbol}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
