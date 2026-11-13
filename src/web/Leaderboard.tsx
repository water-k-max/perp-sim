import { useState } from 'react';
import { amount, changedLabels, day, record } from './dto.js';
import { StaleNote } from './Resample.js';

export type LeaderboardRow = { rank: number; account: string; net: string; gross: string; fundingPaid: string; tradeFees: string; liquidationFees: string; closes: number; markets: number; ok: boolean; warnings: string[] };
export type DiscoveryCoverage = { rowsScanned: number; rowsInWindow: number; pages: number; truncated: boolean; firstChangeSec: number | null; lastChangeSec: number | null };
export type Board = { fromSec: number; toSec: number; quoteSymbol: string; quoteDecimals: number; discovered: number; netted: number; maxAccounts: number; discovery: DiscoveryCoverage; rows: LeaderboardRow[]; warnings: string[] };

const num = (v: unknown) => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const count = (v: unknown): v is number => int(v) && (v as number) >= 0;
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const timestamp = (v: unknown): v is number => int(v) && (v as number) >= 0;

/** Validate the wire board before it enters UI state — every field mirrors the server DTO. */
export function parse(value: unknown): Board {
  if (!record(value) || !timestamp(value.fromSec) || !timestamp(value.toSec) || typeof value.quoteSymbol !== 'string' || !count(value.quoteDecimals)
    || !count(value.discovered) || !count(value.netted) || !count(value.maxAccounts) || !Array.isArray(value.rows) || !Array.isArray(value.warnings)) throw new Error('Unexpected response.');
  if (!value.warnings.every((w: unknown) => typeof w === 'string')) throw new Error('Unexpected response.');
  const c = value.discovery;
  if (!record(c) || !count(c.rowsScanned) || !count(c.rowsInWindow) || !count(c.pages) || typeof c.truncated !== 'boolean'
    || !(c.firstChangeSec === null || timestamp(c.firstChangeSec)) || !(c.lastChangeSec === null || timestamp(c.lastChangeSec))) throw new Error('Unexpected response.');
  for (const r of value.rows as unknown[]) {
    if (!record(r) || !count(r.rank) || !address(r.account) || !count(r.closes) || !count(r.markets) || typeof r.ok !== 'boolean' || !Array.isArray(r.warnings)) throw new Error('Unexpected response.');
    for (const key of ['net', 'gross', 'fundingPaid', 'tradeFees', 'liquidationFees'] as const) if (!num(r[key])) throw new Error('Unexpected response.');
    if (!(r.warnings as unknown[]).every((w: unknown) => typeof w === 'string')) throw new Error('Unexpected response.');
  }
  return value as unknown as Board;
}

const inputsOf = (days: string, maxAccounts: string) => ({ days, maxAccounts });
const WATCH = { days: 'Window', maxAccounts: 'Accounts to net' };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sign = (v: string) => (Number(v) < 0 ? 'negative' : Number(v) > 0 ? 'positive' : '');

/**
 *  The ranked board, rendered. Extracted so the honesty labels — net not gross, liquidation in its
 *  own column, a truncated read called partial, the vacuous-zero warning, a `review` row's reasons —
 *  can be pinned offline against a fixture board, the same way the resample panel's caveats are.
 */
export function BoardView({ board, onPick }: { board: Board; onPick?: (address: string) => void }) {
  const flagged = board.rows.filter(r => r.warnings.length > 0);
  return <>
    <p className={`coverage-note ${board.discovery.truncated ? 'tone-partial' : 'tone-complete'}`}>
      <strong>{board.discovery.truncated ? 'Read stopped early.' : 'Read drained.'}</strong> {board.discovered.toLocaleString()} account(s) closed positions in the window; netted the top {board.netted.toLocaleString()} by gross realized, then ranked by net. Discovery scanned {board.discovery.rowsScanned.toLocaleString()} closing updates over {board.discovery.pages} page(s){board.discovery.firstChangeSec !== null && board.discovery.lastChangeSec !== null ? `, spanning ${day(board.discovery.firstChangeSec)} → ${day(board.discovery.lastChangeSec)} UTC` : ''}.
    </p>
    {board.warnings.length > 0 && <ul className="warnings">{board.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
    {board.rows.length === 0
      ? <p className="muted">No account closed a perp position in this window, so there is nothing to rank.</p>
      : <>
        <p className="muted">All amounts in {board.quoteSymbol}. Ranked by net realized, largest first; ties break by gross then address.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th className="num">#</th><th>Account</th><th className="num">Net</th><th className="num">Gross</th><th className="num">Funding paid</th><th className="num">Trade fees</th><th className="num">Liquidation</th><th className="num">Closes</th><th className="num">Markets</th><th>Check</th></tr></thead>
            <tbody>{board.rows.map(r => <tr key={r.account}>
              <td className="num">{r.rank}</td>
              <td>{onPick
                ? <button type="button" className="lb-account lb-pick" title={`Verify ${r.account} across all markets over this window`} onClick={() => onPick(r.account)}>{r.account}</button>
                : <code className="lb-account" title={r.account}>{r.account}</code>}</td>
              <td className={`num ${sign(r.net)}`}>{amount(r.net)}</td>
              <td className={`num ${sign(r.gross)}`}>{amount(r.gross)}</td>
              <td className="num">{amount(r.fundingPaid)}</td>
              <td className="num">{amount(r.tradeFees)}</td>
              <td className="num">{amount(r.liquidationFees)}</td>
              <td className="num">{r.closes.toLocaleString()}</td>
              <td className="num">{r.markets.toLocaleString()}</td>
              <td>{r.ok ? <span className="positive">ok</span> : <span className="negative">review</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {flagged.length > 0 && <ul className="warnings">{flagged.flatMap(r => r.warnings.map(w => <li key={r.account + w}><code className="lb-account">{short(r.account)}</code> — {w}</li>))}</ul>}
        <p className="muted">“ok” means both legs read to the window edge and every fee kind mapped to a rail. “review” means a leg was truncated or a fee kind was unrecognised, so that row’s net cannot be trusted — its reasons are listed above. Funding paid is positive when the account paid it; a negative figure is funding received, which raises net.</p>
      </>}
  </>;
}

/**
 *  Discovery: rank the accounts that closed perp positions in a window by net realized PnL
 *  (gross − funding paid − trade fees). A heavy venue-wide read, so it runs only on an explicit
 *  click, never on mount. Every limit that can shorten the answer — discovery truncation, the
 *  account cap, a per-account leg cap, an unrecognised fee kind — is surfaced, not hidden.
 */
export function LeaderboardPanel({ onPick }: { onPick?: (address: string, days: string) => void }) {
  const [days, setDays] = useState('7');
  const [maxAccounts, setMaxAccounts] = useState('50');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Board | null>(null);
  const [ranWith, setRanWith] = useState<ReturnType<typeof inputsOf> | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true); setError(null);
    const sent = inputsOf(days, maxAccounts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const query = new URLSearchParams({ days: sent.days, maxAccounts: sent.maxAccounts });
      const response = await fetch(`/api/leaderboard?${query}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(record(payload) && typeof payload.error === 'string' ? payload.error : `Request failed (HTTP ${response.status}).`);
      setResult(parse(payload));
      setRanWith(sent);
    } catch (err) {
      setError(err instanceof Error && err.name === 'AbortError' ? 'Timed out reading the venue. Narrow the window or retry when the indexer is less busy.' : err instanceof Error ? err.message : 'Request failed.');
    } finally { clearTimeout(timer); setBusy(false); }
  }

  const changed = changedLabels(inputsOf(days, maxAccounts), ranWith, WATCH);
  return <section className="leaderboard" aria-labelledby="leaderboard-title">
    <div className="workspace-heading"><h2 id="leaderboard-title">Find the traders who kept the most</h2><span>00 / DISCOVER BY NET PNL</span></div>
    <div className="panel leaderboard-card">
      <p className="muted intro">Rank every account that closed a perp position in the window by what it actually kept: <strong>net realized = gross realized − funding paid − trade fees</strong>. Liquidation penalties are listed separately and never deducted from net. A read that stops early is labelled, not presented as a complete census. This is a historical read, not a forecast.</p>
      <div className="leaderboard-form">
        <label htmlFor="lb-days">Window<select id="lb-days" value={days} onChange={e => setDays(e.target.value)}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
        <label htmlFor="lb-max">Accounts to net<select id="lb-max" value={maxAccounts} onChange={e => setMaxAccounts(e.target.value)}><option value="25">Top 25 by gross</option><option value="50">Top 50 by gross</option><option value="100">Top 100 by gross</option></select></label>
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Reading venue…' : 'Rank traders'}</button>
      </div>
      <p className="error" role="alert" hidden={error === null}>{error}</p>
      {result && <StaleNote fields={changed} />}
      {result && <BoardView board={result} onPick={onPick ? (addr) => onPick(addr, ranWith?.days ?? days) : undefined} />}
    </div>
  </section>;
}