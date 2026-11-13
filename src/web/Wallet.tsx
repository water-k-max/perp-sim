import { useEffect, useState } from 'react';
import { amount, changedLabels, fetchMarkets, number, record, type Market } from './dto.js';
import { DIST_NOTES, CoverageNote, Histogram, FanChart, Stat, ShuffleNote, StaleNote } from './Resample.js';
import { parseCoverage, type FillReadCoverage } from '../verify/fill-coverage.js';

type FanBand = { step: number; p10: string; p25: string; p50: string; p75: string; p90: string };
type Dist = { mode: string; paths: number; median: string; p05: string; p95: string; cvar95: string; bankruptcyRate: string; medianMaxDrawdownBps: number; medianMaxLosingStreak: number; finalEquities: string[]; fan: FanBand[] };
type MarketRow = { market: string; pool: string; fills: number; closedTrades: number; openingFills: number; winRateBps: number; realizedTotal: string; mismatches: number; unmatched: number; ok: boolean; coverage: FillReadCoverage };
type Wallet = { account: string; market: string; quoteSymbol: string; closedTrades: number; winRateBps: number; realizedTotal: string; coverage: FillReadCoverage; distributions: Dist[]; warnings: string[]; mismatches: number; unmatched: number; reconcileOk: boolean; fillsRead: number; changesReconciled: number; markets?: MarketRow[]; marketsRead?: number; marketsWithFills?: number };

const num = (v: unknown) => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
function parse(value: unknown): Wallet {
  if (!record(value) || typeof value.account !== 'string' || typeof value.quoteSymbol !== 'string' || !int(value.closedTrades) || !int(value.winRateBps) || !num(value.realizedTotal) || !Array.isArray(value.distributions) || !Array.isArray(value.warnings) || !int(value.mismatches) || !int(value.unmatched) || typeof value.reconcileOk !== 'boolean' || !int(value.fillsRead) || !int(value.changesReconciled)) throw new Error('Unexpected response.');
  parseCoverage(value.coverage);
  for (const d of value.distributions as unknown[]) {
    if (!record(d) || typeof d.mode !== 'string' || !int(d.paths) || !num(d.median) || !num(d.p05) || !num(d.p95) || !num(d.cvar95) || !num(d.bankruptcyRate) || !Array.isArray(d.finalEquities) || !(d.finalEquities as unknown[]).every(num)) throw new Error('Unexpected response.');
    if (!Array.isArray(d.fan) || !(d.fan as unknown[]).every(b => record(b) && int(b.step) && num(b.p10) && num(b.p25) && num(b.p50) && num(b.p75) && num(b.p90))) throw new Error('Unexpected response.');
  }
  // The cross-market breakdown is present only on an `ALL` read; a single-market response omits it.
  if (value.markets !== undefined) {
    if (!Array.isArray(value.markets) || !int(value.marketsRead) || !int(value.marketsWithFills)) throw new Error('Unexpected response.');
    for (const m of value.markets as unknown[]) {
      if (!record(m) || typeof m.market !== 'string' || typeof m.pool !== 'string' || !int(m.fills) || !int(m.closedTrades) || !int(m.openingFills) || !int(m.winRateBps) || !num(m.realizedTotal) || !int(m.mismatches) || !int(m.unmatched) || typeof m.ok !== 'boolean') throw new Error('Unexpected response.');
      parseCoverage(m.coverage);
    }
  }
  return value as unknown as Wallet;
}

/** The read the panel performs for these form values — the same shape decides what is stale. */
const inputsOf = (address: string, market: string, days: string, cash: string) => ({ address: address.trim(), market: market.trim() || 'ALL', days, cash: cash.trim() || '1000' });
const WALLET_WATCH = { address: 'Address', market: 'Market', days: 'Window', cash: 'Starting cash' };

/** The leaderboard row a "Mirror" click came from: the net rank the copy-sim must not be mistaken for. */
export type MirrorContext = { rank: number; net: string; gross: string; fundingPaid: string };

export function WalletPanel({ preset }: { preset?: { address: string; days: string; nonce: number; mirror?: MirrorContext } | null }) {
  const [address, setAddress] = useState('');
  const [market, setMarket] = useState('ALL');
  const [markets, setMarkets] = useState<Market[]>([]);
  const [days, setDays] = useState('14');
  const [cash, setCash] = useState('1000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Wallet | null>(null);
  const [ranWith, setRanWith] = useState<ReturnType<typeof inputsOf> | null>(null);
  const [mirror, setMirror] = useState<MirrorContext | null>(null);
  // The server refuses anything but a positive decimal, and this panel is the only thing that
  // would have to explain the refusal, so the button knows the rule before it sends.
  const cashValid = /^\d+(?:\.\d+)?$/.test(cash.trim()) && Number(cash.trim()) > 0;
  const [mode, setMode] = useState('shuffle_without_replacement');
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  useEffect(() => {
    let cancelled = false;
    fetchMarkets().then(next => {
      if (cancelled) return;
      setMarkets(next);
      // `ALL` is a scope, not a listed symbol, so the market list must not reset it to a single market.
      setMarket(old => old === 'ALL' || next.some(m => m.symbol === old) ? old : next[0].symbol);
    }).catch(() => { /* Static choices remain available offline. */ });
    return () => { cancelled = true; };
  }, []);

  // A leaderboard "Verify" click presets the address and window and runs the ALL-market replay, so
  // the net ranking is corroborated by the same reconcile over the same window. A "Mirror" click also
  // carries the row's net context, which frames the distributions as an in-sample copy-sim. The nonce
  // lets a second click on the same address run again.
  useEffect(() => {
    if (!preset) return;
    setAddress(preset.address);
    setDays(preset.days);
    setMarket('ALL');
    setMirror(preset.mirror ?? null);
    void run({ address: preset.address, market: 'ALL', days: preset.days });
  }, [preset?.nonce]);

  async function run(override?: { address: string; market: string; days: string }) {
    const addr = (override?.address ?? address).trim();
    const mkt = override?.market ?? market;
    const win = override?.days ?? days;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || !cashValid || busy) return;
    if (!override) setMirror(null);
    setBusy(true); setError(null);
    const sent = inputsOf(addr, mkt, win, cash);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const query = new URLSearchParams({ market: sent.market, days: sent.days, paths: '1000', cash: sent.cash });
      const response = await fetch(`/api/accounts/${sent.address}/resample?${query}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(record(payload) && typeof payload.error === 'string' ? payload.error : `Request failed (HTTP ${response.status}).`);
      setResult(parse(payload));
      setRanWith(sent);
    } catch (err) {
      setError(err instanceof Error && err.name === 'AbortError' ? 'Timed out.' : err instanceof Error ? err.message : 'Request failed.');
    } finally { clearTimeout(timer); setBusy(false); }
  }

  const dist = result?.distributions.find(d => d.mode === mode) ?? result?.distributions[0];
  const changed = changedLabels(inputsOf(address, market, days, cash), ranWith, WALLET_WATCH);
  const integrityBad = result && (!result.reconcileOk || result.mismatches > 0 || result.unmatched > 0);
  // The cash field labels the unit the form will send; the result notes label the unit the server
  // actually returned, which on an `ALL` read is the shared quote unit of every market with fills.
  const formQuote = market === 'ALL' ? (markets[0]?.quoteSymbol ?? 'USDso') : (markets.find(m => m.symbol === market)?.quoteSymbol ?? 'USDso');
  const quote = result?.quoteSymbol ?? formQuote;
  const isAll = result?.market === 'ALL';
  const scope = isAll ? 'across all markets' : `in ${result?.market ?? market}`;
  return <section className="wallet" aria-labelledby="wallet-title">
    <div className="workspace-heading"><h2 id="wallet-title">Analyse a wallet</h2><span>01 / RESAMPLE REAL FILLS</span></div>
    <div className="panel wallet-card">
      <div className="wallet-form">
        <label htmlFor="wallet-address">Address<input id="wallet-address" value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={address !== '' && !valid} aria-describedby="wallet-address-help" /><small id="wallet-address-help" className="field-help">0x prefix + 40 hex characters.</small></label>
        <label htmlFor="wallet-market">Market<select id="wallet-market" value={market} onChange={e => setMarket(e.target.value)}><option value="ALL">All markets</option>{(markets.length ? markets : ['BTC', 'ETH', 'SOL', 'ZRO'].map(symbol => ({ symbol, quoteSymbol: 'USDso' }))).map(m => <option key={m.symbol} value={m.symbol}>{m.symbol} · {m.quoteSymbol}</option>)}</select></label>
        <label htmlFor="wallet-days">Window<select id="wallet-days" value={days} onChange={e => setDays(e.target.value)}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
        <label htmlFor="wallet-cash">Starting cash <span className="muted">({formQuote})</span><input id="wallet-cash" value={cash} onChange={e => setCash(e.target.value)} inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" spellCheck={false} autoComplete="off" aria-invalid={!cashValid} aria-describedby="wallet-cash-help" /><small id="wallet-cash-help" className="field-help">Assumed balance the bust rate is measured against.</small></label>
        <button type="button" className="primary" disabled={!valid || !cashValid || busy} onClick={() => void run()}>{busy ? 'Reading fills…' : 'Resample'}</button>
      </div>
      <p className="error" role="alert" hidden={error === null}>{error}</p>
      {result && <StaleNote fields={changed} />}
      {result && <IntegrityBanner result={result} quote={quote} cash={ranWith?.cash ?? cash} scope={scope} />}
      {result && <CoverageNote coverage={result.coverage} prominent />}
      {result?.markets && <MarketTable rows={result.markets} quote={quote} marketsRead={result.marketsRead} />}
      {result && mirror && dist && <CopySimNote mirror={mirror} account={result.account} closedTrades={result.closedTrades} quote={quote} cash={ranWith?.cash ?? cash} />}
      {result && (dist ? <>
        <div className="segmented resample-mode">{result.distributions.map(d => <label key={d.mode}><input type="radio" name="wallet-mode" checked={dist.mode === d.mode} onChange={() => setMode(d.mode)} /><span>{d.mode.startsWith('shuffle') ? 'Shuffle' : d.mode.startsWith('block') ? 'Block boot.' : 'Bootstrap'}</span></label>)}</div>
        <FanChart dist={dist} quote={quote} original={[]} />
        <ShuffleNote mode={dist.mode} p05={dist.p05} p95={dist.p95} />
        <div className="metrics">
          <Stat label="Closed trades" value={String(result.closedTrades)} note={`Closing fills the chain recorded for this address ${scope} in the window. Opens carry no realized PnL and are skipped.`} />
          <Stat label="Win rate" value={`${number(result.winRateBps / 100, 1)}%`} note="Share of those closes with a positive gross realized PnL. A trader who scales out of one winner books several winning closes, so this can overstate the share of round-trip trades that won." />
          <Stat label="Replayed total" value={amount(result.realizedTotal)} note={`Sum of the replayed realized PnL per closing fill ${scope}, in ${quote} — fees and funding are not deducted. ${integrityBad ? `Mismatches: ${result.mismatches}, unmatched: ${result.unmatched}.` : `Reconciled ${result.changesReconciled} changes across ${result.fillsRead} fills with no disagreements.`}`} />
          <Stat label="Median final" value={amount(dist.median)} note={DIST_NOTES.medianFinal(dist.paths, quote)} />
          <Stat label="p05 / p95" value={`${amount(dist.p05)} / ${amount(dist.p95)}`} note={DIST_NOTES.p05p95} />
          <Stat label="CVaR 95" value={amount(dist.cvar95)} note={DIST_NOTES.cvar95} />
          <Stat label="Bankruptcy rate" value={`${(Number(dist.bankruptcyRate) * 100).toFixed(1)}%`} note={`${DIST_NOTES.bankruptcy} Assumed starting cash: ${amount(ranWith?.cash ?? cash)} ${quote}.`} />
          <Stat label="Median max drawdown" value={`${number(dist.medianMaxDrawdownBps / 100, 1)}%`} note={DIST_NOTES.drawdown} />
        </div>
        <Histogram values={dist.finalEquities.map(Number)} label="Final equity" />
      </> : <p className="muted">No closed trades {scope} in this window.</p>)}
    </div>
  </section>;
}

/** Where the aggregate total came from: each market's own verified read, largest gross realized first. */
function MarketTable({ rows, quote, marketsRead }: { rows: MarketRow[]; quote: string; marketsRead?: number }) {
  return <div className="market-breakdown">
    <h3>Per-market breakdown</h3>
    <p className="muted">{rows.length} market{rows.length === 1 ? '' : 's'} with fills{marketsRead !== undefined ? ` of ${marketsRead} listed` : ''}, largest gross realized first. Each row is the same verified read the single-market view performs; the total above sums them.</p>
    <div className="table-wrap">
      <table>
        <thead><tr><th>Market</th><th className="num">Fills</th><th className="num">Closed</th><th className="num">Win rate</th><th className="num">Gross realized ({quote})</th><th>Check</th></tr></thead>
        <tbody>{rows.map(m => <tr key={m.market}>
          <td>{m.market}</td>
          <td className="num">{m.fills.toLocaleString()}</td>
          <td className="num">{m.closedTrades.toLocaleString()}</td>
          <td className="num">{number(m.winRateBps / 100, 1)}%</td>
          <td className={`num ${Number(m.realizedTotal) < 0 ? 'negative' : 'positive'}`}>{amount(m.realizedTotal)}</td>
          <td>{m.ok && m.mismatches === 0 && m.unmatched === 0 ? <span className="positive">ok</span> : <span className="negative">{m.mismatches} mismatch / {m.unmatched} unmatched</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

/** The integrity banner: red when the reconcile found disagreements, amber when coverage is partial. */
function IntegrityBanner({ result, quote, cash, scope }: { result: Wallet; quote: string; cash: string; scope: string }) {
  if (result.reconcileOk && result.mismatches === 0 && result.unmatched === 0) {
    return <p className="integrity-note integrity-ok" role="status">Reconcile passed {scope}: {result.changesReconciled.toLocaleString()} changes across {result.fillsRead.toLocaleString()} fills, no disagreements. Starting cash assumed at {amount(cash)} {quote}.</p>;
  }
  return <p className="integrity-note integrity-fail" role="alert">Reconcile found {result.mismatches} mismatch(es) and {result.unmatched} unmatched fill(s) out of {result.fillsRead.toLocaleString()} reads {scope}. The totals below rest on a partial or disputed read.</p>;
}

/**
 *  The copy-sim lens. A "Mirror" click resamples the trader's realized closes as if they were yours,
 *  through the same gross-PnL resampler the wallet always runs — no new engine. The banner's job is to
 *  stop the net rank being mistaken for the copy: it is in-sample, it mirrors gross trade PnL only (not
 *  the funding or fees that set the net rank), and it assumes you match the trader's size on every close.
 */
export function CopySimNote({ mirror, account, closedTrades, quote, cash }: { mirror: MirrorContext; account: string; closedTrades: number; quote: string; cash: string }) {
  const short = `${account.slice(0, 6)}…${account.slice(-4)}`;
  const fundingDroveNet = Number(mirror.fundingPaid) < 0 && Number(mirror.net) > Number(mirror.gross);
  return <div className="copy-sim-note" id="copy-sim" role="note">
    <h3>Copy-sim · mirroring <code className="lb-account">{short}</code> <span className="muted">(rank #{mirror.rank} by net)</span></h3>
    <p>Resamples this trader's {closedTrades.toLocaleString()} realized closes into new trade orders. <strong>In-sample</strong> — it models trade-order risk on their past, not a forecast of future returns or of what copying them would yield.</p>
    <p>Mirrors <strong>gross trade PnL only</strong> ({amount(mirror.gross)} {quote}). Their net rank ({amount(mirror.net)} {quote}) also includes funding ({amount(mirror.fundingPaid)} {quote} paid; a negative figure is received) and trade fees, which a copy does not replicate.{fundingDroveNet ? " Funding received — not trading — lifted this trader's net above their gross; mirroring their trades would not reproduce that income." : ''}</p>
    <p>Assumes you match their position size on every close, so your PnL per close equals theirs. Your starting cash ({amount(cash)} {quote}) is the buffer the bankruptcy rate is measured against.</p>
  </div>;
}
