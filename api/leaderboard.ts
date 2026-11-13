/**
 *  `/api/leaderboard` — the net realized leaderboard. Its own function file beside the catch-all so
 *  the route does not depend on catch-all expansion; the handler is the same shared route table.
 */
export { default } from "../src/server/serverless-entry.js";