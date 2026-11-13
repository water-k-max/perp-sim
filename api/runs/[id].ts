/**
 *  `/api/runs/<id>` — a saved run by digest. On a deployment this answers 501 (no durable disk),
 *  but it must reach the handler to say so: the edge 404 the catch-all drew for deep routes would
 *  blame the URL instead of stating the storage policy. Its own file, shared handler.
 */
export { default } from "../../src/server/serverless-entry.js";