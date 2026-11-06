/**
 *  The import flow the HTTP route drives, factored out of the server so the glue —
 *  market resolution, the ingest window, the history-failure degradation — is testable
 *  without opening a socket or touching the chain. The route keeps the status codes;
 *  this module owns everything below them.
 */

import { buildBars, withIntraBarPath, type Bar } from "../history/bars.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { loadMarketData } from "../data/ingest.js";
import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { resampleImportedTrades, type ParsedImport } from "./import.js";
import type { ResampleAnalysis } from "./analysis.js";
import type { Invariant } from "../verify/invariants.js";

/** The chain access the flow needs, injectable so tests can stand in a fake. */
export type ImportFlowDeps = {
  createClient: () => SomniaMarkets;
  listPerps: typeof listPerps;
  selectMarket: typeof selectMarket;
  resolveConfig: typeof resolveConfig;
  loadMarketData: typeof loadMarketData;
};

export type ImportFlowResult = {
  runId: string;
  market: string;
  quoteSymbol: string;
  tradeCount: number;
  resample: ResampleAnalysis & { invariants: Invariant[] };
};

export async function runImportFlow(parsed: ParsedImport, deps: ImportFlowDeps): Promise<ImportFlowResult> {
  const client = deps.createClient().client;
  const market = deps.selectMarket(await deps.listPerps(client), parsed.request.market);
  const cfg = await deps.resolveConfig(client, market);
  let bars: Bar[] = [];
  let historyWarning: string | null = null;
  if (parsed.window) {
    try {
      // One interval earlier, matching the replay ingest: the first settlement bar
      // can open on the hour-aligned bucket at or before its own settlement.
      const data = await deps.loadMarketData(client, cfg, { fromSec: Math.max(0, parsed.window.from - 3600 + 1), toSec: parsed.window.to });
      bars = withIntraBarPath(buildBars(data.funding), data.candles3600);
    } catch (error) {
      console.error("Import history load failed:", error instanceof Error ? error.message : "Unknown error");
      historyWarning = "The market history for the trade window could not be loaded; the trades carry no excursion data and the sizing leverage note has no mark price.";
    }
  }
  const outcome = resampleImportedTrades(parsed, { cfg, bars, historyWarning });
  return {
    runId: outcome.importId,
    market: cfg.symbol,
    quoteSymbol: outcome.quoteSymbol,
    tradeCount: parsed.trades.length,
    resample: { ...outcome.analysis, invariants: outcome.invariants },
  };
}
