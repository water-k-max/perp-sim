/**
 *  The catch-all API entry. It matches the single-segment routes (`/api/chain`, `/api/markets`,
 *  `/api/backtest`, …) that the platform was measured to route correctly. The deeper routes each
 *  have their own file beside this one — see `src/server/serverless-entry.ts` for why — and every
 *  one of them re-exports the same handler, so there is still exactly one route table.
 */
export { default } from "../src/server/serverless-entry.js";
