import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chain, chainId, chainReport } from "./client.js";
import { config } from "./config.js";
import { parseChainReport } from "./web/dto.js";

const run = promisify(execFile);
const cwd = new URL("../", import.meta.url);

/**
 *  Which chain this process reads, and which chain it labels its data with.
 *
 *  `chainReport()` is the only place the two are compared, and the interface labels itself from it, so
 *  these checks are what stop a network name from being remembered instead of asked about. The drift
 *  case is run in a child process: `CHAIN_ID` is read once when `src/config.ts` is imported, and the
 *  import that matters has to happen with the drifted value already in the environment.
 */
test("the chain this tool reads is the hackathon chain, and the report is built from it", () => {
  assert.equal(chain.id, 50383, "reads must stay on Hideki 50383");
  assert.equal(chain.name, "Hideki Testnet");
  assert.equal(chain.testnet, true);
  assert.equal(chainId, chain.id, "the exported id must be the chain object's own id");

  const report = chainReport();
  assert.equal(report.readChainId, "50383");
  assert.equal(report.name, "Hideki Testnet");
  assert.equal(report.indexerUrl, config.indexerUrl);
  assert.equal(report.testnet, true);
  assert.equal(report.manifestChainId, String(config.chainId));
  // `agrees` must be the comparison, never a literal: a hardcoded true is how a drifted `CHAIN_ID`
  // would go on looking fine, which is the failure this report exists to catch.
  assert.equal(report.agrees, report.readChainId === report.manifestChainId);
});

test("a drifted CHAIN_ID mislabels the data without moving a single read", async () => {
  const script = "const { chainReport } = await import('./src/client.js'); console.log(JSON.stringify(chainReport()));";
  const { CHAIN_ID: _inherited, ...inherited } = process.env;
  const { stdout } = await run(process.execPath, ["--import", "tsx", "-e", script], {
    cwd,
    env: { ...inherited, CHAIN_ID: "50321" },
    timeout: 180_000,
  });
  const report = parseChainReport(JSON.parse(stdout));
  assert.ok(report, "a drifted chain id is exactly what the interface has to be told about");
  assert.equal(report.readChainId, "50383", "the environment label must not move the chain being read");
  assert.equal(report.manifestChainId, "50321");
  assert.equal(report.agrees, false, "a label that differs from the reads has to be reported as a mismatch");
});
