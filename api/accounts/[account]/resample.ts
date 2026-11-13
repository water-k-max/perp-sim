/**
 *  `/api/accounts/<account>/resample` — the wallet replay, including `market=ALL`.
 *
 *  Its own function file because the deployed catch-all matched only one path segment and this
 *  route is four deep; the platform's edge answered 404 before any handler ran. A static prefix
 *  with one dynamic segment is a shape the platform compiles without catch-all expansion. The
 *  handler is the shared one — `src/server/serverless-entry.ts` explains the split.
 */
export { default } from "../../../src/server/serverless-entry.js";