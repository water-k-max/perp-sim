import { config } from "../config.js";
import { retryRead } from "../retry.js";
import type { EpochRow } from "./types.js";

/**
 *  The SDK does not expose the per-pool parameter epochs, and that table is what makes a
 *  multi-week replay honest: a market's margin and fee parameters can change under the
 *  position, and today's read is not what the chain enforced last month. This is a
 *  read-only GraphQL client for the tables the SDK has no typed document for.
 */
type RawEpoch = {
  blockNumber: string | number;
  logIndex: string | number;
  timestamp: string | number;
  initialMarginBps: string | number | null;
  maintenanceMarginBps: string | number | null;
  closeOutMarginBps: string | number | null;
  takerFeeBpsTimes1k: string | number | null;
  makerFeeBpsTimes1k: string | number | null;
  maxPositionSize: string | number | null;
  maxOpenInterest: string | number | null;
  insuranceFundShareBps: string | number | null;
  source: string;
};

const EPOCH_FIELDS =
  "blockNumber logIndex timestamp initialMarginBps maintenanceMarginBps closeOutMarginBps takerFeeBpsTimes1k makerFeeBpsTimes1k maxPositionSize maxOpenInterest insuranceFundShareBps source";

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(config.indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`indexer ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`indexer: ${body.errors.map((e) => e.message).join("; ")}`);
  if (!body.data) throw new Error("indexer returned no data");
  return body.data;
}

const num = (value: string | number | null): bigint | null =>
  value === null || value === "" ? null : BigInt(value);

function epoch(row: RawEpoch): EpochRow {
  if (!Number.isSafeInteger(Number(row.logIndex)) || Number(row.logIndex) < 0) throw new Error("Epoch missing valid logIndex");
  return {
    blockNumber: Number(row.blockNumber),
    logIndex: Number(row.logIndex),
    timestamp: Number(row.timestamp),
    initialMarginBps: num(row.initialMarginBps),
    maintenanceMarginBps: num(row.maintenanceMarginBps),
    closeOutMarginBps: num(row.closeOutMarginBps),
    takerFeeBpsTimes1k: num(row.takerFeeBpsTimes1k),
    makerFeeBpsTimes1k: num(row.makerFeeBpsTimes1k),
    maxPositionSize: num(row.maxPositionSize),
    maxOpenInterest: num(row.maxOpenInterest),
    insuranceFundShareBps: num(row.insuranceFundShareBps),
    source: row.source,
  };
}

const EPOCHS_BEFORE = `query EpochsBefore($pool: String!, $block: numeric!, $limit: Int!) {
  PerpPoolParametersEpoch(
    where: { pool: { _eq: $pool }, blockNumber: { _lte: $block } }
    order_by: [{ blockNumber: desc }, { logIndex: desc }]
    limit: $limit
  ) { ${EPOCH_FIELDS} }
}`;

const EPOCHS_RANGE = `query EpochsRange($pool: String!, $from: numeric!, $to: numeric!, $cursorBlock: numeric!, $cursorLog: Int!, $limit: Int!) {
  PerpPoolParametersEpoch(
    where: { pool: { _eq: $pool }, blockNumber: { _gte: $from, _lte: $to }, _or: [{ blockNumber: { _gt: $cursorBlock } }, { blockNumber: { _eq: $cursorBlock }, logIndex: { _gt: $cursorLog } }] }
    order_by: [{ blockNumber: asc }, { logIndex: asc }]
    limit: $limit
  ) { ${EPOCH_FIELDS} }
}`;

/** The newest epoch at or before `block`, or null when the pool had no epoch yet. */
export async function epochBefore(pool: string, block: number): Promise<EpochRow | null> {
  const at = pool.toLowerCase();
  const read = await retryRead(`epoch before ${at.slice(0, 10)}`, () =>
    gql<{ PerpPoolParametersEpoch: RawEpoch[] }>(EPOCHS_BEFORE, { pool: at, block: String(block), limit: 1 }),
  );
  const row = read.PerpPoolParametersEpoch[0];
  return row ? epoch(row) : null;
}

/**
 *  Every epoch that governed `[fromBlock, toBlock]`: the one in force when the window
 *  opened (if any), plus each change inside it, oldest first.
 */
export async function epochWindow(pool: string, fromBlock: number, toBlock: number): Promise<EpochRow[]> {
  const at = pool.toLowerCase();
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) throw new Error("Invalid epoch block range");
  const baseline = await epochBefore(at, fromBlock - 1);
  const rows: EpochRow[] = baseline ? [baseline] : [];
  let cursorBlock = fromBlock;
  let cursorLog = -1;
  for (let page = 0; page < 8; page++) {
    const inside = await retryRead(`epochs in window ${at.slice(0, 10)}`, () =>
      gql<{ PerpPoolParametersEpoch: RawEpoch[] }>(EPOCHS_RANGE, {
        pool: at, from: String(fromBlock), to: String(toBlock),
        cursorBlock: String(cursorBlock), cursorLog, limit: 2000,
      }),
    );
    if (inside.PerpPoolParametersEpoch.length === 0) return rows;
    for (const raw of inside.PerpPoolParametersEpoch) {
      const row = epoch(raw);
      if (row.blockNumber < fromBlock || row.blockNumber > toBlock || row.blockNumber < cursorBlock || (row.blockNumber === cursorBlock && row.logIndex! <= cursorLog))
        throw new Error("Epoch pagination made no progress or returned unordered/out-of-range rows");
      rows.push(row);
      cursorBlock = row.blockNumber;
      cursorLog = row.logIndex!;
    }
  }
  throw new Error("Epoch history truncated by eight-page budget");
}
