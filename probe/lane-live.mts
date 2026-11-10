/**
 *  Live lane check against the real Hideki indexer, on a port that is not the user's app. Read-only:
 *  it asks the same two wallet endpoints the "Analyse a wallet" panel asks, and nothing else.
 *
 *  Five requests, fired together: one reconcile, two *different* wallet resamples, and two copies
 *  of the first resample. Under the old one-slot lock, four of these five were refused with "a
 *  replay is already running". Here none should be, and the two identical requests must be answered
 *  by the same job — which is visible as an identical body and a shorter wait than a resample of
 *  their own would cost.
 *
 *  Run it as `npx tsx probe/lane-live.mts [0xACCOUNT]`; the default account is a human-scale one
 *  found by `probe/pick-account.mts`, and any address with fills in the last 7 days works.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

const PORT = 3111;
const ACCOUNT = process.argv[2] ?? "0x6e12c5897145ec7d02812471e72e8d463d60691f";
const base = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ["--import", "tsx", "src/bin/web.ts"], { cwd: new URL("../", import.meta.url), env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
const line = (n: number) => { const s = String(n); return s.length === 60 ? s : s.padEnd(60, "."); };

try {
  await Promise.race([once(server.stdout, "data"), once(server, "exit").then(([code]) => { throw new Error(`server exited: ${code}`); })]);
  const resample = (seed: string) => `${base}/api/accounts/${ACCOUNT}/resample?market=BTC&days=7&paths=100&cash=1000&seed=${seed}`;
  const timed = async (label: string, url: string) => {
    const t0 = Date.now();
    const response = await fetch(url);
    const text = await response.text();
    console.log(`${line(label)} ${response.status}  ${(Date.now() - t0) / 1000}s  ${text.length} bytes`);
    return { label, status: response.status, text, seconds: (Date.now() - t0) / 1000 };
  };
  const [reconcile, first, second, copy1, copy2] = await Promise.all([
    timed("reconcile", `${base}/api/accounts/${ACCOUNT}/reconcile?market=BTC&days=7`),
    timed("resample-seed-one", resample("lane-live")),
    timed("resample-seed-two", resample("lane-other")),
    timed("resample-seed-one-copy", resample("lane-live")),
    timed("resample-seed-one-copy2", resample("lane-live")),
  ]);
  const statuses = [reconcile, first, second, copy1, copy2].map(r => r.status);
  console.log(`statuses: ${statuses.join(" ")}  refused: ${statuses.filter(s => s === 429).length}`);
  console.log(`identical requests shared one answer: ${copy1.text === first.text && copy2.text === first.text}`);
  console.log(`different seeds gave different answers: ${first.text !== second.text}`);
  console.log(`coalesced copies waited ${(Math.min(copy1.seconds, copy2.seconds)).toFixed(1)}s vs a full job at ${first.seconds.toFixed(1)}s`);
  if (statuses.some(s => s !== 200)) console.log("BODY:", first.text.slice(0, 300));
} finally {
  const exited = once(server, "exit");
  server.kill();
  await exited;
}
