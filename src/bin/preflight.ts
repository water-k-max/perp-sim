import { perpMarkForPnl, fundingRatePerInterval, FUNDING_PRECISION } from "@somnia-chain/markets-sdk";
import { createClient } from "../client.js";
import { config } from "../config.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { contractGates, lockFor, positionAtFill, staticGates, type Intent } from "../pretrade/gates.js";
import { fromRaw, toRaw } from "../units.js";
import { retryRead } from "../retry.js";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const symbol = arg("market", "BTC") as string;
const side = arg("side", "long") === "short" ? ("short" as const) : ("long" as const);
const cash = toRaw(arg("cash", "1000") as string, 18);
const sizeArg = arg("size") as string | undefined;
const priceArg = arg("price");
const accountArg = arg("account") ?? (config.walletAddress as string | undefined);

const client = createClient().client;
const cfg = await resolveConfig(client, selectMarket(await listPerps(client), symbol));
const state = await retryRead("getPerpState", () => client.getPerpState(cfg.pool as `0x${string}`));
const system = await retryRead("getPerpSystemConfig", () => client.getPerpSystemConfig(cfg.marginBank as `0x${string}`));
const mark = perpMarkForPnl(state);

if (mark.fromIndex) {
  console.log("WARNING mark feed is at its sentinel, so the index price is marking this check instead");
}

let size = sizeArg !== undefined ? toRaw(sizeArg, cfg.baseDecimals) : cfg.minQuantity;
size -= size % cfg.lotSize;
if (size === 0n) size = cfg.lotSize;
const rawPrice = priceArg !== undefined ? toRaw(priceArg, cfg.quoteDecimals) : mark.price;
const intent: Intent = { side, size, price: rawPrice - (rawPrice % cfg.tickSize) };

const gates = staticGates(cfg, intent, {
  cash,
  markPrice: mark.price,
  openInterest: state.openInterest,
});

console.log(`${cfg.symbol}/${cfg.quoteSymbol}  pool ${cfg.pool}`);
console.log(
  `mark ${fromRaw(mark.price, cfg.quoteDecimals)}${mark.fromIndex ? " (index fallback)" : ""}  index ${fromRaw(state.indexPrice, cfg.quoteDecimals)}  OI ${fromRaw(state.openInterest, cfg.baseDecimals)} ${cfg.symbol}`,
);
console.log(
  `chain config: marginBank ${system.marginBank}  collateral ${system.collateralToken}  liquidationEngine ${system.liquidationEngine}  maxLeverage ${system.maxLeverageLimit}x`,
);
if (system.marginBank.toLowerCase() !== cfg.marginBank.toLowerCase()) {
  console.log("NOTE the system config's marginBank differs from the market row's");
}

console.log(
  `\nintent  ${side} ${fromRaw(size, cfg.baseDecimals)} ${cfg.symbol} @ ${fromRaw(intent.price, cfg.quoteDecimals)}  collateral ${fromRaw(cash, cfg.quoteDecimals)} ${cfg.quoteSymbol}`,
);
for (const c of gates.checks) {
  console.log(`  [${c.verdict.toUpperCase().padEnd(4)}] ${c.id}: ${c.detail}`);
}
console.log(
  `\nmargin  notional ${fromRaw(lockFor(cfg, intent, mark.price).notional, cfg.quoteDecimals)}  initial ${fromRaw(gates.initialMargin, cfg.quoteDecimals)}  adverse gap ${fromRaw(gates.adverseGap, cfg.quoteDecimals)}  lock ${fromRaw(gates.lock, cfg.quoteDecimals)} ${cfg.quoteSymbol}`,
);
const distance =
  gates.liquidationPrice === null
    ? "none (no price trips it)"
    : gates.liquidationPrice === 0n
      ? "unreachable: this position outlives a move to zero"
      : `${(100 - (Number(gates.liquidationPrice) / Number(mark.price)) * 100).toFixed(2)}% ${side === "long" ? "below" : "above"} mark`;
console.log(
  `        liquidation price ${gates.liquidationPrice === null ? "none" : fromRaw(gates.liquidationPrice, cfg.quoteDecimals)}  =  ${distance}`,
);

const perInterval = fundingRatePerInterval(
  state.fundingRate,
  state.fundingWindowSec,
  state.fundingIntervalSec,
);
const notionalNow = (size * mark.price) / cfg.oneBase;
const hourly = (notionalNow * perInterval) / FUNDING_PRECISION;
console.log(
  `\ncarry   rate ${state.fundingRate} per ${state.fundingWindowSec}s window, ${perInterval} per ${state.fundingIntervalSec}s interval`,
);
console.log(
  `        at this rate the position pays ${fromRaw(hourly, cfg.quoteDecimals)} ${cfg.quoteSymbol} per settlement, ${fromRaw(hourly * 24n, cfg.quoteDecimals)} per day (${side === "long" ? "longs pay a positive rate" : "shorts pay a negative rate"})`,
);

const analytics = positionAtFill(cfg, intent, mark.price, state.cumulativeFundingPerUnit, state.projectedCumulativeFundingPerUnit);
console.log(
  `        maintenance ${fromRaw(analytics.maintenanceMarginRequirement, cfg.quoteDecimals)}  close-out ${fromRaw(analytics.closeOutMarginRequirement, cfg.quoteDecimals)} ${cfg.quoteSymbol}`,
);

if (accountArg !== undefined) {
  try {
    const chain = await retryRead("contractGates", () =>
      contractGates(client, cfg, accountArg as `0x${string}`, intent),
    );
    const p = chain.preview as Record<string, unknown>;
    const m = chain.maxSize as Record<string, unknown>;
    console.log(`\ncontract cross-check for account ${accountArg}`);
    console.log(
      `  previewPerpOrderMargin  priceable ${p.priceable}  lock ${p.lockAmount}  initial ${p.initialMarginPortion}  adverse ${p.adverseGapPortion}  leverageSurcharge ${p.leverageSurcharge}  sufficient ${p.sufficient}  unlocked ${p.unlockedCollateral}`,
    );
    console.log(`  getMaxPerpOrderSize       priceable ${m.priceable}  maxQuantity ${m.maxQuantity}  limitedBy ${m.limitedBy}  placeable ${m.placeable}`);
    console.log(`  meetsPerpImForFill (IM probe) ${chain.coldProbe}`);
    console.log(`        its own doc: "does not model the lock's adverse mark-to-entry reserve;`);
    console.log(`        previewPerpOrderMargin is the accurate gate" — so this one is context, not a verdict`);
    if (p.priceable === true && typeof p.lockAmount === "bigint" && typeof p.markPrice === "bigint") {
      const atContractMark = lockFor(cfg, intent, p.markPrice);
      const delta = p.lockAmount - atContractMark.lock;
      console.log(
        `  same arithmetic, the contract's own mark ${fromRaw(p.markPrice, cfg.quoteDecimals)}: kernel ${fromRaw(atContractMark.lock, cfg.quoteDecimals)} vs contract ${fromRaw(p.lockAmount, cfg.quoteDecimals)} ${cfg.quoteSymbol}  ${delta === 0n ? "IDENTICAL" : `delta ${fromRaw(delta, cfg.quoteDecimals)}`}`,
      );
      if (p.markPrice !== mark.price) {
        console.log(
          `  the two reads are ${fromRaw(p.markPrice - mark.price, cfg.quoteDecimals)} apart on price — a preview is a statement about its own block, so re-quote at send time`,
        );
      }
    }
  } catch (e) {
    console.log(`\ncontract cross-check failed: ${(e as Error).message.slice(0, 300)}`);
  }
} else {
  console.log("\nno --account given: contract previews skipped, verdict is kernel-only");
}

console.log(
  `\nverdict  ${gates.placeable ? "PASS" : `BLOCKED by ${gates.binding}`}` +
    (gates.placeable && intent.price !== mark.price
      ? "  (a limit price away from the mark also changes the adverse gap above)"
      : ""),
);
process.exit(0);
