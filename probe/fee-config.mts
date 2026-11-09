import { createClient } from "../src/client.js";
import { listPerps, resolveConfig, selectMarket, feeBps } from "../src/history/market.js";
const { client } = createClient();
const market = await resolveConfig(client, selectMarket(await listPerps(client), "BTC"));
console.log("symbol", market.symbol, "pool", market.pool);
console.log("takerFeeBpsTimes1k", market.takerFeeBpsTimes1k.toString(), "makerFeeBpsTimes1k", market.makerFeeBpsTimes1k.toString());
console.log("feeBps taker", feeBps(market, "taker"), "maker", feeBps(market, "maker"));
console.log("fundingIntervalSec", market.fundingIntervalSec, "window", market.fundingWindowSec);
console.log("imBps", market.imBps.toString(), "mmBps", market.mmBps.toString(), "closeOutBps", market.closeOutBps.toString());
