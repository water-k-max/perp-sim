/**
 *  Bring-your-own trades: a CSV or JSON trade list from any source becomes a resample
 *  analysis, without an engine run and without touching the chain.
 *
 *  Required per trade: side, entryTime, exitTime, pnl — pnl taken as recorded (net of the
 *  importer's own fees and funding), which is disclosed rather than re-derived. Optional
 *  size, entryPrice, fee and funding columns enrich the record. When the named market's
 *  history is available, the hourly candle path of the settlement bars each position lived
 *  through fills in the worst and best prices it provably saw; trades outside that history
 *  carry no excursion data and are counted, not invented. The list is sorted chronologically
 *  before analysis, because the block bootstrap's realism depends on real adjacency.
 */

import { sha256, canonical } from "../data/store.js";
import { toRaw } from "../units.js";
import type { MarketConfig } from "../history/market.js";
import type { Bar } from "../history/bars.js";
import { barIndexAt, excursionFromCandles, type TradeRecord, type TradeList } from "./inputs.js";
import { buildResampleAnalysis, parseResampleRequest, type AnalysisInputs, type ResampleAnalysis, type ResampleRequest } from "./analysis.js";
import { checkResample, type Invariant } from "../verify/invariants.js";

export const MAX_IMPORT_TRADES = 10_000;
export const IMPORT_PAYLOAD_MAX = 2_000_000;

const REQUIRED = ["side", "entryTime", "exitTime", "pnl"] as const;
const OPTIONAL = ["size", "entryPrice", "fee", "funding"] as const;
const KNOWN = new Set<string>([...REQUIRED, ...OPTIONAL]);

const SIGNED_DECIMAL = /^-?\d{1,15}(\.\d{1,18})?$/;
const UNSIGNED_DECIMAL = /^\d{1,15}(\.\d{1,18})?$/;

export type ImportRequest = {
  market: string;
  startingCash: string;
  resample: ResampleRequest;
  /** Raw CSV or JSON-array text; exactly one of payload / trades must be present. */
  payload: string | null;
  trades: unknown[] | null;
};

/** A validated trade in exact decimal strings, before market decimals are known. */
export type ParsedTrade = {
  side: "long" | "short";
  entryTs: number;
  exitTs: number;
  pnl: string;
  size: string | null;
  entryPrice: string | null;
  fee: string | null;
  funding: string | null;
};

/** The scalar part of an import request: market, starting cash and the resample options. */
export function parseImportRequest(value: unknown): ImportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an import request.");
  const v = value as Record<string, unknown>;
  if (typeof v.market !== "string" || !/^[A-Za-z0-9/-]{1,64}$/.test(v.market)) throw new Error("Choose a valid market symbol or pool address.");
  if (typeof v.startingCash !== "string" || !UNSIGNED_DECIMAL.test(v.startingCash) || Number(v.startingCash) <= 0) {
    throw new Error("startingCash must be a positive decimal (up to 12 whole and 18 fractional digits).");
  }
  const hasPayload = v.payload !== undefined && v.payload !== null;
  const hasTrades = v.trades !== undefined && v.trades !== null;
  if (hasPayload === hasTrades) throw new Error("Send exactly one of payload (CSV or JSON text) or trades (a JSON array).");
  let payload: string | null = null;
  if (hasPayload) {
    if (typeof v.payload !== "string") throw new Error("payload must be CSV or JSON text.");
    if (v.payload.length > IMPORT_PAYLOAD_MAX) throw new Error(`payload is capped at ${IMPORT_PAYLOAD_MAX} characters.`);
    payload = v.payload;
  }
  let trades: unknown[] | null = null;
  if (hasTrades) {
    if (!Array.isArray(v.trades)) throw new Error("trades must be a JSON array.");
    trades = v.trades;
  }
  return {
    market: v.market,
    startingCash: v.startingCash,
    resample: parseResampleRequest(v.resample),
    payload,
    trades,
  };
}

function decimalField(row: Record<string, unknown>, key: string, where: string, signed: boolean): string {
  const v = row[key];
  const text = typeof v === "number"
    ? (Number.isFinite(v) ? String(v) : null)
    : typeof v === "string" ? v.trim() : null;
  if (text === null || !(signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(text)) {
    throw new Error(`${where}: ${key} must be a ${signed ? "decimal (negative allowed)" : "positive decimal"}.`);
  }
  return text;
}

function timeField(row: Record<string, unknown>, key: string, where: string): number {
  const v = row[key];
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === "string") {
    const text = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
      const ms = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
      if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
    }
    if (/^\d{1,12}$/.test(text)) {
      const sec = Number(text);
      if (Number.isSafeInteger(sec) && sec > 0) return sec;
    }
  }
  throw new Error(`${where}: ${key} must be a unix second count or an ISO date.`);
}

function tradeFromObject(value: unknown, where: string): ParsedTrade {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object.`);
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!KNOWN.has(key)) throw new Error(`${where} has an unknown field "${key}". Allowed: ${[...KNOWN].join(", ")}.`);
  }
  for (const key of REQUIRED) {
    if (row[key] === undefined || row[key] === null) throw new Error(`${where} is missing ${key}.`);
  }
  const sideText = typeof row.side === "string" ? row.side.trim().toLowerCase() : "";
  if (sideText !== "long" && sideText !== "short") throw new Error(`${where}: side must be long or short.`);
  const entryTs = timeField(row, "entryTime", where);
  const exitTs = timeField(row, "exitTime", where);
  if (exitTs <= entryTs) throw new Error(`${where}: exitTime must be after entryTime.`);
  const optional = (key: (typeof OPTIONAL)[number]) =>
    row[key] === undefined || row[key] === null ? null : decimalField(row, key, where, key === "funding");
  return {
    side: sideText as "long" | "short",
    entryTs,
    exitTs,
    pnl: decimalField(row, "pnl", where, true),
    size: optional("size"),
    entryPrice: optional("entryPrice"),
    fee: optional("fee"),
    funding: optional("funding"),
  };
}

function csvList(text: string): ParsedTrade[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("The CSV needs a header row and at least one trade row.");
  const header = lines[0]!.split(",").map((name) => name.trim());
  const seen = new Set<string>();
  for (const name of header) {
    if (!KNOWN.has(name)) throw new Error(`The CSV has an unknown column "${name}". Allowed: ${[...KNOWN].join(", ")}.`);
    if (seen.has(name)) throw new Error(`The CSV has a duplicate column "${name}".`);
    seen.add(name);
  }
  for (const name of REQUIRED) {
    if (!header.includes(name)) throw new Error(`The CSV is missing the required column "${name}".`);
  }
  const index = new Map(header.map((name, i) => [name, i] as const));
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length !== header.length) throw new Error(`CSV row ${i + 2} has ${cells.length} cells for ${header.length} columns.`);
    const row: Record<string, unknown> = {};
    for (const [name, idx] of index) row[name] = cells[idx];
    return tradeFromObject(row, `CSV row ${i + 2}`);
  });
}

function jsonList(text: string): ParsedTrade[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("payload is neither valid JSON nor CSV."); }
  return objectList(parsed);
}

function objectList(value: unknown): ParsedTrade[] {
  if (!Array.isArray(value)) throw new Error("The trade list must be a JSON array or CSV text.");
  if (value.length === 0) throw new Error("The trade list is empty.");
  if (value.length > MAX_IMPORT_TRADES) throw new Error(`The trade list is capped at ${MAX_IMPORT_TRADES} trades (got ${value.length}).`);
  return value.map((t, i) => tradeFromObject(t, `Trade ${i + 1}`));
}

/** Parse a trade list from raw CSV/JSON text or an already-parsed array, then sort it chronologically. */
export function parseTradeList(value: string | unknown[]): ParsedTrade[] {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const trades = typeof value === "string"
    ? (trimmed.startsWith("[") || trimmed.startsWith("{") ? jsonList(value) : csvList(value))
    : objectList(value);
  return chronological(trades);
}

/** The block bootstrap draws consecutive trades, so the list must run in chronological order. */
function chronological(trades: readonly ParsedTrade[]): ParsedTrade[] {
  return trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.entryTs - b.t.entryTs || a.t.exitTs - b.t.exitTs || a.i - b.i)
    .map(({ t }) => t);
}

/** The trade window a market-history load must cover, or null for an empty list. */
export function importWindow(trades: readonly ParsedTrade[]): { from: number; to: number } | null {
  if (trades.length === 0) return null;
  return {
    from: Math.min(...trades.map((t) => t.entryTs)),
    to: Math.max(...trades.map((t) => t.exitTs)),
  };
}

/**
 *  Imported records become TradeRecords against the market's settlement bars: holding
 *  windows are measured in bars, and candle extremes fill in the observed excursion.
 *  Prices are raw at the quote's decimals, the same scale every chain price here uses.
 */
export function buildImportedTradeList(parsed: readonly ParsedTrade[], cfg: MarketConfig, bars: readonly Bar[]): TradeList {
  const out: TradeRecord[] = parsed.map((t, i) => {
    const entryIdx = barIndexAt(bars, t.entryTs);
    const exitIdx = barIndexAt(bars, t.exitTs);
    // barIndexAt returns the last bar when the timestamp lies beyond the data; only a bar
    // that actually starts at or after the timestamp counts as covering it.
    const covered = entryIdx !== null && exitIdx !== null &&
      bars[entryIdx]!.t >= t.entryTs && bars[exitIdx]!.t >= t.exitTs;
    const barsHeld = covered ? exitIdx! - entryIdx! : 0;

    let excursion: { worst: bigint; best: bigint } | null = null;
    if (covered) excursion = excursionFromCandles(bars, entryIdx!, exitIdx!, t.side);

    const entryPrice = t.entryPrice === null ? null : toRaw(t.entryPrice, cfg.quoteDecimals);
    let mae: bigint | null = null;
    let mfe: bigint | null = null;
    if (excursion !== null && entryPrice !== null) {
      const size = t.size === null ? cfg.oneBase : toRaw(t.size, cfg.baseDecimals);
      const adversePnl = t.side === "long"
        ? ((entryPrice - excursion.worst) * size) / cfg.oneBase
        : ((excursion.worst - entryPrice) * size) / cfg.oneBase;
      const favourablePnl = t.side === "long"
        ? ((excursion.best - entryPrice) * size) / cfg.oneBase
        : ((entryPrice - excursion.best) * size) / cfg.oneBase;
      mae = adversePnl > 0n ? -adversePnl : 0n;
      mfe = favourablePnl > 0n ? favourablePnl : 0n;
    }

    return {
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      pnl: toRaw(t.pnl, cfg.quoteDecimals),
      direction: t.side,
      barsHeld,
      sameBar: covered && barsHeld === 0,
      mae,
      mfe,
      worstPrice: excursion?.worst ?? null,
      bestPrice: excursion?.best ?? null,
      excursionSource: excursion === null ? "none" : "candles",
      size: t.size === null ? cfg.oneBase : toRaw(t.size, cfg.baseDecimals),
      entryPrice: entryPrice ?? 0n,
      exitPrice: entryPrice ?? 0n,
      funding: t.funding === null ? 0n : toRaw(t.funding, cfg.quoteDecimals),
      fee: t.fee === null ? 0n : toRaw(t.fee, cfg.quoteDecimals),
      gas: 0n,
      seq: i + 1,
    };
  });

  return {
    trades: out,
    sameBarCount: out.filter((t) => t.sameBar).length,
    withoutExcursionCount: out.filter((t) => t.excursionSource === "none").length,
    window: out.length === 0 ? { from: null, to: null } : {
      from: Math.min(...out.map((t) => t.entryTs)),
      to: Math.max(...out.map((t) => t.exitTs)),
    },
  };
}

export type ParsedImport = {
  request: ImportRequest;
  /** Sorted chronologically, exactly as the analysis sees them. */
  trades: ParsedTrade[];
  window: { from: number; to: number } | null;
};

/** The full strict parse: scalars, the trade list, chronological order, window. */
export function parseImport(value: unknown): ParsedImport {
  const request = parseImportRequest(value);
  const trades = parseTradeList(request.payload ?? request.trades!);
  return { request, trades, window: importWindow(trades) };
}

export type ImportFlowOptions = {
  cfg: MarketConfig;
  bars: readonly Bar[];
  /** Set when the market history for the trade window could not be loaded at all. */
  historyWarning?: string | null;
};

/**
 *  The full import analysis: one deterministic document over the imported trades. The
 *  import id hashes the sorted list with its market and starting cash, so the same import
 *  with the default seed reproduces byte-identical output.
 */
export function resampleImportedTrades(parsed: ParsedImport, opts: ImportFlowOptions): {
  analysis: ResampleAnalysis;
  invariants: Invariant[];
  importId: string;
  quoteSymbol: string;
} {
  const { cfg } = opts;
  const list = buildImportedTradeList(parsed.trades, cfg, opts.bars);
  const runId = sha256(canonical([
    "perp-sim/import/v1",
    cfg.symbol,
    parsed.request.startingCash,
    parsed.trades,
  ]));
  const extraWarnings: string[] = [];
  if (parsed.trades.some((t) => t.size === null)) {
    extraWarnings.push("Sizes were not supplied: every trade is treated as 1 whole base wherever a trade's own size scales a result (the sizing ladder), which does not affect the distributions.");
  }
  if (opts.historyWarning) extraWarnings.push(opts.historyWarning);

  const inputs: AnalysisInputs = {
    runId,
    list,
    request: parsed.request.resample,
    createdAt: list.window.to === null ? "1970-01-01T00:00:00.000Z" : new Date(list.window.to * 1000).toISOString(),
    start: toRaw(parsed.request.startingCash, cfg.quoteDecimals),
    quoteDecimals: cfg.quoteDecimals,
    baseDecimals: cfg.baseDecimals,
    quoteScale: 10n ** BigInt(cfg.quoteDecimals),
    oneBase: cfg.oneBase,
    lotSize: cfg.lotSize,
    maxSize: cfg.maxPositionSize,
    markPrice: opts.bars.length > 0 ? opts.bars[opts.bars.length - 1]!.mark : 0n,
    effectiveImfBps: cfg.effectiveImfBps,
    market: cfg.symbol,
    assumptions: {
      fillModel: "imported",
      profile: null,
      latencySec: 1,
      gasPerTx: "0",
      intrabar: true,
    },
    extraWarnings,
    sourceKind: "import",
  };
  const analysis = buildResampleAnalysis(inputs);
  const invariants = checkResample(analysis, inputs);
  return { analysis, invariants, importId: runId, quoteSymbol: cfg.quoteSymbol };
}
