/**
 *  The block explorer for Somnia Hideki — which is the Tokyo testnet (chain 50383), one network under
 *  two names. The explorer is real and public: https://explorer.testnet.somnia.network/tokyo/.
 *
 *  This is the single source of truth for evidence links. An earlier version of this tool claimed no
 *  explorer existed and refused to render a link; that was factually wrong. The render guard's intent
 *  was never "no links" — it was "no *fabricated* destination". So every tx/address link is built here
 *  from the one verified host, and the guard pins that host: a link to any other origin fails the
 *  canary. Pure and dependency-free, so the node CLI and the browser bundle import the same URLs.
 */
export const EXPLORER_BASE = "https://explorer.testnet.somnia.network/tokyo";

/** A transaction's evidence page. `hash` is a 0x-prefixed 32-byte transaction hash. */
export const explorerTxUrl = (hash: string): string => `${EXPLORER_BASE}/tx/${hash}`;

/** An address's page (trader wallet, pool, token). `address` is a 0x-prefixed 20-byte address. */
export const explorerAddressUrl = (address: string): string => `${EXPLORER_BASE}/address/${address}`;