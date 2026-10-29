import { createClient } from "./client.js";
import { listPerps, resolveConfig, selectMarket } from "./history/market.js";
import { candleWindow, fundingWindow } from "./history/indexer.js";
import { buildBars, coverage, withIntraBarPath } from "./history/bars.js";
import { simulate } from "./engine/simulate.js";
import { fromRaw, toRaw } from "./units.js";

export type Request = { market: string; days: number; side: "long" | "short"; size: string; cash: string; intrabar: boolean };
export function parseRequest(value: unknown): Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a backtest configuration.");
  const v = value as Record<string, unknown>;
  if (typeof v.market !== "string" || !/^[A-Za-z0-9/-]{1,64}$/.test(v.market)) throw new Error("Choose a valid market symbol or pool address.");
  if (!Number.isInteger(v.days) || Number(v.days) < 1 || Number(v.days) > 90) throw new Error("Lookback must be 1–90 whole days.");
  if (v.side !== "long" && v.side !== "short") throw new Error("Side must be long or short.");
  for (const field of ["size", "cash"] as const) {
    if (typeof v[field] !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(v[field]) || Number(v[field]) <= 0) throw new Error(`${field} must be a positive decimal (up to 12 whole and 18 fractional digits).`);
  }
  if (typeof v.intrabar !== "boolean") throw new Error("Intrabar must be true or false.");
  return v as Request;
}

export class BacktestInputError extends Error {}

export async function listMarkets() {
  const client = createClient().client;
  return (await listPerps(client)).filter(m => m.baseSymbol && m.baseDecimals !== null && m.baseDecimals !== undefined)
    .map(m => ({ symbol: m.baseSymbol as string, quoteSymbol: m.quoteSymbol ?? "USDso", baseDecimals: m.baseDecimals as number, lot: fromRaw(BigInt(m.lotSize), m.baseDecimals as number), minQuantity: fromRaw(BigInt(m.minQuantity), m.baseDecimals as number) }));
}

export async function runBacktest(input: Request) {
  const client = createClient().client;
  const rows = await listPerps(client);
  let market;
  try { market = selectMarket(rows, input.market); }
  catch (error) { throw new BacktestInputError(error instanceof Error ? error.message : "Market could not be resolved."); }
  const cfg = await resolveConfig(client, market);
  const end = Math.floor(Date.now() / 1000);
  const found = await fundingWindow(client, cfg.pool, end - input.days * 86400, end);
  let bars = buildBars(found.rows);
  if (bars.length < 3) throw new BacktestInputError("Fewer than three settlements found. Try a longer lookback.");
  let candleCoverage: { bars: number; covered: number; complete: boolean } | null = null;
  if (input.intrabar) {
    const candles = await candleWindow(client, cfg.pool, 3600, bars[0].t, end);
    bars = withIntraBarPath(bars, candles.rows);
    candleCoverage = { bars: bars.length, covered: bars.filter(b => b.low !== null).length, complete: candles.complete };
  }
  const requested = toRaw(input.size, cfg.baseDecimals);
  const size = requested - requested % cfg.lotSize;
  if (size <= 0n) throw new BacktestInputError(`Position size rounds to zero: ${cfg.symbol} trades in lots of ${fromRaw(cfg.lotSize, cfg.baseDecimals)} and requires at least ${fromRaw(cfg.minQuantity, cfg.baseDecimals)}.`);
  const cash = toRaw(input.cash, cfg.quoteDecimals);
  if (cash <= 0n) throw new BacktestInputError("Collateral rounds to zero at quote precision.");
  const out = simulate({ cfg, bars, cash, entries: [{ bar: 1, side: input.side, size, price: bars[1].mark }] });
  const cov = coverage(bars);
  const warnings = ["Hypothetical fixed-position replay; settlement-mark entry is not a book fill."];
  if (requested !== size) warnings.push("Position size was rounded down to the market lot grid.");
  if (size < cfg.minQuantity || size > cfg.maxPositionSize) warnings.push("This hypothetical size is outside the market's placement limits.");
  if (!found.complete || cov.missingSettlements || cov.gaps || cov.anchorResynced) warnings.push("History has gaps, resyncs or incomplete pagination. Interpret results with caution.");
  if (candleCoverage && (!candleCoverage.complete || candleCoverage.covered < candleCoverage.bars)) warnings.push("Candle coverage is incomplete; not every interval has an intrabar path.");
  if (out.status === "liquidated") warnings.push("Modeled maintenance breach; this is not an actual liquidation. Ending equity uses the settlement mark, not liquidation proceeds.");
  const money = (n: bigint) => fromRaw(n, cfg.quoteDecimals);
  let peak = cash;
  let drawdownBps = 0n;
  for (const point of out.trail) {
    if (point.equity > peak) peak = point.equity;
    const dd = (peak - point.equity) * 10000n / peak;
    if (dd > drawdownBps) drawdownBps = dd;
  }
  const funding = -(out.fundingSettled + out.fundingOpen);
  const fees = -out.feesPaid;
  return {
    market: cfg.symbol, quoteSymbol: cfg.quoteSymbol, side: input.side, size: fromRaw(size, cfg.baseDecimals),
    cash: money(cash), entryPrice: money(bars[1].mark), from: cov.from, to: cov.to,
    status: out.status, equityEnd: money(out.equityEnd), pnl: money(out.equityEnd - cash - funding - fees),
    funding: money(funding), fees: money(fees), maxDrawdownPct: fromRaw(drawdownBps, 2),
    coverage: cov, complete: found.complete, candleCoverage, warnings,
    trail: out.trail.map(p => ({ t: p.t, equity: money(p.equity), funding: money(-p.fundingAccrued), mark: money(p.mark) })),
  };
}
