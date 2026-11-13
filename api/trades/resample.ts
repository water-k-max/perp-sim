/**
 *  `/api/trades/resample` — the imported-trade-list replay (POST). Three segments deep, so it gets
 *  its own function file rather than relying on the catch-all; the handler is the shared one.
 */
export { default } from "../../src/server/serverless-entry.js";