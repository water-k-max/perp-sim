import { perpLiquidationPrice, perpMarkForPnl } from "@somnia-chain/markets-sdk";
import { createClient } from "../client.js";
import { config } from "../config.js";
import { listPerps, resolveConfig, selectMarket } from "../history/market.js";
import { divCeil, lockFor, type Intent } from "../pretrade/gates.js";
import { fromRaw } from "../units.js";
import { retryRead } from "../retry.js";

const BPS = 10_000n;

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const account = (arg("account") ?? config.walletAddress) as `0x${string}` | undefined;
if (account === undefined) {
  console.log("validate compares the kernel against the contract, so it needs an account to ask about.");
  console.log("Pass --account 0x…, or set WALLET_ADDRESS in .env. Read-only: no transaction is sent.");
  process.exit(2);
}
const symbols = (arg("markets", "BTC,ETH,SOL,ZRO") as string).split(",");

type Row = { label: string; pass: boolean; detail: string };
const rows: Row[] = [];
let checked = 0;
let skipped = 0;

const client = createClient().client;
for (const symbol of symbols) {
  const cfg = await resolveConfig(client, selectMarket(await listPerps(client), symbol.trim()));
  const state = await retryRead("getPerpState", () => client.getPerpState(cfg.pool as `0x${string}`));
  const mark = perpMarkForPnl(state).price;

  for (const side of ["long", "short"] as const) {
    for (const [scale, offsetBps] of [
      [1n, 0n],
      [3n, 20n],
      [1n, -20n],
      [5n, 0n],
    ] as const) {
      const lots = cfg.minQuantity * scale;
      const size = lots - (lots % cfg.lotSize);
      const base = side === "long" ? mark + (mark * offsetBps) / BPS : mark - (mark * offsetBps) / BPS;
      const price = base - (base % cfg.tickSize);
      const intent: Intent = { side, size, price };
      const base3 = { pool: cfg.pool as `0x${string}`, marginBank: cfg.marginBank as `0x${string}`, account };
      const label = `${cfg.symbol} ${side.padEnd(5)} ${fromRaw(size, cfg.baseDecimals)} @ ${fromRaw(price, cfg.quoteDecimals).padStart(12)}`;

      const [preview, liq] = await retryRead(`preview ${cfg.symbol} ${side}`, () =>
        Promise.all([
          client.previewPerpOrderMargin({ ...base3, isBid: side === "long", quantity: size, price }),
          client.previewPerpLiquidationPrice({ ...base3, isBid: side === "long", quantity: size, price }),
        ]),
      );
      const p = preview as Record<string, unknown>;
      const l = liq as Record<string, unknown>;
      if (p.priceable !== true || l.priceable !== true) {
        skipped += 1;
        rows.push({ label, pass: true, detail: "unpriceable at this block (mark feed sentinel) — nothing to assert" });
        continue;
      }
      checked += 1;
      const contractMark = p.markPrice as bigint;
      const imf = p.effectiveImfBps as bigint;
      const notional = (size * price) / cfg.oneBase;
      const expectIm = divCeil(notional * imf, BPS);
      const gapPerBase = side === "long" ? price - contractMark : contractMark - price;
      const expectGap = gapPerBase > 0n ? (gapPerBase * size) / cfg.oneBase : 0n;
      const expectLock = expectIm + expectGap;

      const failures: string[] = [];
      const gotLock = p.lockAmount as bigint;
      if (gotLock !== expectLock) failures.push(`lock ${gotLock} != ${expectLock}`);
      if ((p.initialMarginPortion as bigint) !== expectIm) failures.push(`im ${(p.initialMarginPortion as bigint)} != ${expectIm}`);
      if ((p.adverseGapPortion as bigint) !== expectGap) failures.push(`gap ${(p.adverseGapPortion as bigint)} != ${expectGap}`);
      const kernelLock = lockFor(cfg, intent, contractMark, imf).lock;
      if (kernelLock !== gotLock) failures.push(`lockFor ${kernelLock} != contract ${gotLock}`);
      const expectLiq = perpLiquidationPrice({
        equity: l.projectedEquity as bigint,
        mmReq: l.projectedMmReq as bigint,
        size: l.projectedSize as bigint,
        markPrice: l.markPrice as bigint,
        maintenanceMarginBps: cfg.mmBps,
        oneBase: cfg.oneBase,
      });
      const gotLiq = l.projectedLiquidationPrice as bigint | null;
      if (expectLiq !== gotLiq) failures.push(`liq ${gotLiq ?? "null"} != ${expectLiq ?? "null"}`);

      rows.push({
        label,
        pass: failures.length === 0,
        detail: failures.length === 0
          ? `lock ${fromRaw(gotLock, cfg.quoteDecimals)}  im ${fromRaw(expectIm, cfg.quoteDecimals)}  gap ${fromRaw(expectGap, cfg.quoteDecimals)}  liq ${gotLiq === null ? "null" : fromRaw(gotLiq, cfg.quoteDecimals)}  block ${l.asOfBlock}`
          : `MISMATCH ${failures.join("; ")}`,
      });
    }
  }
}

console.log(`kernel vs contract, account ${account}`);
console.log("four identities per order: lockAmount = ceil(notional x effectiveIMF / 1e4) + adverse gap,");
console.log("and projectedLiquidationPrice = the shared solve against the contract's own projected equity.\n");
for (const r of rows) {
  console.log(`  [${r.pass ? "OK  " : "FAIL"}] ${r.label}  ${r.detail}`);
}
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${checked} order(s) asserted, ${skipped} skipped, ${failed} mismatch(es)`);
process.exit(failed === 0 ? 0 : 1);
