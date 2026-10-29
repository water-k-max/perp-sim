import type { FillRow, SomniaMarketsClient } from "@somnia-chain/markets-sdk";
import { retryRead } from "../retry.js";
import { compareFills } from "../history/indexer.js";
import { datasetKey, readDataset, writeDataset, writeSnapshot, readSnapshot, sha256 } from "./store.js";
import { config } from "../config.js";
import type { TapeFill } from "./types.js";

/** One bounded read off the pool's tape, and the truth about whether it got the whole slice. */
export type TapeSlice = {
  key: string;
  /** Snapshot digest of the payload excluding this derived field. */
  digest?: string;
  fromSec: number;
  toSec: number;
  fills: TapeFill[];
  complete: boolean;
  pages: number;
  truncated: boolean;
};

export type SliceRecord = { key: string; digest: string; fromSec: number; toSec: number; fills: number; complete: boolean };

/**
 *  The trade tape, read on demand around the moments a run actually trades.
 *
 *  A slice is `[fromSec, toSec]` and is cached by that exact range, so replaying the same
 *  run over the same window reads the same rows — including from disk on the second run.
 *  The cache key is part of the run manifest, which is what makes a tape-based result
 *  reproducible rather than merely re-runnable.
 */
export type TapeSource = {
  slice(fromSec: number, toSec: number): Promise<TapeSlice>;
  consumed(): SliceRecord[];
  /** Every slice read so far, by key, so a manifest can hash the tape it used. */
  digest(): string;
};

const PAGE = 500;
const MAX_PAGES = 8;

function tape(fill: FillRow): TapeFill {
  if (fill.blockNumber === undefined || fill.logIndex === undefined) {
    throw new Error("fill row without a block position; refusing to order the tape on partial data");
  }
  return {
    id: fill.id,
    block: Number(fill.blockNumber),
    logIndex: fill.logIndex,
    t: Number(fill.timestamp),
    price: BigInt(fill.fillPrice),
    size: BigInt(fill.quantity),
    quote: BigInt(fill.quoteQuantity),
    takerIsBid: fill.takerIsBid,
    maker: fill.maker,
    taker: fill.taker,
    txHash: fill.txHash,
  };
}

export function createTapeSource(
  client: SomniaMarketsClient,
  pool: string,
  options: { refresh?: boolean; fromBlock?: number; toBlock?: number; fromSec?: number; toSec?: number; chainId?: number; source?: string } = {},
): TapeSource {
  const records: SliceRecord[] = [];
  const { refresh: _refresh, ...bounds } = options;
  if ((options.toSec ?? Infinity) < (options.fromSec ?? -Infinity) || (options.toBlock ?? Infinity) < (options.fromBlock ?? -Infinity)) throw new Error("Invalid tape bounds");
  const key = (fromSec: number, toSec: number) =>
    datasetKey({ kind: "perp-tape-slice", version: 3, chainId: config.chainId, source: config.indexerUrl, ...bounds, pool: pool.toLowerCase(), fromSec, toSec, bounds });

  return {
    async slice(fromSec, toSec) {
      if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec) throw new Error("Invalid tape slice range");
      const id = key(fromSec, toSec);
      const cached = options.refresh ? null : await readDataset<TapeSlice>(id);
      const lo = Math.max(fromSec, options.fromSec ?? fromSec);
      const hi = Math.min(toSec, options.toSec ?? toSec);
      const hit = cached ?? (lo <= hi ? await readTape(client, pool, lo, hi, id) : { key: id, fromSec, toSec, fills: [], complete: false, pages: 0, truncated: true });
      if (hit.key !== id) throw new Error("Tape request identity mismatch");
      if (!cached) {
        hit.fromSec = fromSec;
        hit.toSec = toSec;
        const filtered = hit.fills.filter(f => f.t >= lo && f.t <= hi && f.block >= (options.fromBlock ?? -Infinity) && f.block <= (options.toBlock ?? Infinity));
        if (lo !== fromSec || hi !== toSec || filtered.length !== hit.fills.length) { hit.complete = false; hit.truncated = true; }
        hit.fills = filtered;
        await writeDataset(id, hit);
      }
      const digest = await writeSnapshot(hit);
      records.push({ key: id, digest, fromSec, toSec, fills: hit.fills.length, complete: hit.complete });
      return { ...hit, digest };
    },
    consumed: () => records.map(r => ({ ...r })),
    digest: () => datasetKey({ kind: "tape-consumed", records }),
  };
}

/** Replay only pinned snapshots; never consult request indexes or the network. */
export function createFrozenTapeSource(saved: readonly SliceRecord[]): TapeSource {
  const available = saved.map(r => ({ ...r }));
  const records: SliceRecord[] = [];
  return {
    async slice(fromSec, toSec) {
      const candidates = available.filter(r => r.fromSec === fromSec && r.toSec === toSec);
      const record = candidates[0];
      if (!record || candidates.some(r => r.digest !== record.digest)) throw new Error("Missing or ambiguous frozen tape slice");
      const payload = await readSnapshot<TapeSlice>(record.digest);
      if (payload.key !== record.key || payload.fromSec !== fromSec || payload.toSec !== toSec || payload.fills.length !== record.fills || payload.complete !== record.complete || sha256(payload) !== record.digest)
        throw new Error("Frozen tape slice identity mismatch");
      records.push({ ...record });
      return { ...payload, digest: record.digest };
    },
    consumed: () => records.map(r => ({ ...r })),
    digest: () => datasetKey({ kind: "tape-consumed", records }),
  };
}

async function readTape(
  client: SomniaMarketsClient,
  pool: string,
  fromSec: number,
  toSec: number,
  key: string,
): Promise<TapeSlice> {
  const seen = new Set<string>();
  const rows: FillRow[] = [];
  let offset = 0;
  let pages = 0;
  let complete = false;
  let truncated = false;
  for (;;) {
    const page = await retryRead(`getFills ${pool.slice(0, 10)} ${fromSec}`, () =>
      client.getFills(pool, { since: fromSec, until: toSec, limit: PAGE, offset }),
    );
    pages += 1;
    const previous = seen.size;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (page.length === 0) {
      complete = true;
      break;
    }
    if (pages >= MAX_PAGES || seen.size === previous) {
      truncated = true;
      break;
    }
    offset += page.length;
  }
  rows.sort(compareFills);
  return { key, fromSec, toSec, fills: rows.map(tape), complete, pages, truncated };
}
