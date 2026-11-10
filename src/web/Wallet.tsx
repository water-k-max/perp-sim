import { useEffect, useState } from 'react';
import { amount, changedLabels, fetchMarkets, number, record, type Market } from './dto.js';
import { DIST_NOTES, CoverageNote, Histogram, FanChart, Stat, ShuffleNote, StaleNote } from './Resample.js';
import { parseCoverage, type FillReadCoverage } from '../verify/fill-coverage.js';

type FanBand = { step: number; p10: string; p25: string; p50: string; p75: string; p90: string };
type Dist = { mode: string; paths: number; median: string; p05: string; p95: string; cvar95: string; bankruptcyRate: string; medianMaxDrawdownBps: number; medianMaxLosingStreak: number; finalEquities: string[]; fan: FanBand[] };
type Wallet = { account: string; market: string; closedTrades: number; winRateBps: number; realizedTotal: string; coverage: FillReadCoverage; distributions: Dist[]; warnings: string[] };

const num = (v: unknown) => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
function parse(value: unknown): Wallet {
  if (!record(value) || typeof value.account !== 'string' || !Number.isInteger(value.closedTrades) || !Number.isInteger(value.winRateBps) || !num(value.realizedTotal) || !Array.isArray(value.distributions) || !Array.isArray(value.warnings)) throw new Error('Unexpected response.');
  parseCoverage(value.coverage);
  for (const d of value.distributions as unknown[]) {
    if (!record(d) || typeof d.mode !== 'string' || !Number.isInteger(d.paths) || !num(d.median) || !num(d.p05) || !num(d.p95) || !num(d.cvar95) || !num(d.bankruptcyRate) || !Array.isArray(d.finalEquities) || !(d.finalEquities as unknown[]).every(num)) throw new Error('Unexpected response.');
    if (!Array.isArray(d.fan) || !(d.fan as unknown[]).every(b => record(b) && Number.isInteger(b.step) && num(b.p10) && num(b.p25) && num(b.p50) && num(b.p75) && num(b.p90))) throw new Error('Unexpected response.');
  }
  return value as unknown as Wallet;
}

/** The read the panel performs for these form values — the same shape decides what is stale. */
const inputsOf = (address: string, market: string, days: string) => ({ address: address.trim(), market: market.trim() || 'BTC', days });
const WALLET_WATCH = { address: 'Address', market: 'Market', days: 'Window' };

export function WalletPanel() {
  const [address, setAddress] = useState('');
  const [market, setMarket] = useState('BTC');
  const [markets, setMarkets] = useState<Market[]>([]);
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Wallet | null>(null);
  const [ranWith, setRanWith] = useState<ReturnType<typeof inputsOf> | null>(null);
  const [quote, setQuote] = useState('USDso');
  const [mode, setMode] = useState('shuffle_without_replacement');
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  useEffect(() => {
    let cancelled = false;
    fetchMarkets().then(next => {
      if (cancelled) return;
      setMarkets(next);
      setMarket(old => next.some(m => m.symbol === old) ? old : next[0].symbol);
    }).catch(() => { /* Static choices remain available offline. */ });
    return () => { cancelled = true; };
  }, []);

  async function run() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    const sent = inputsOf(address, market, days);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const query = new URLSearchParams({ market: sent.market, days: sent.days, paths: '1000' });
      const response = await fetch(`/api/accounts/${sent.address}/resample?${query}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(record(payload) && typeof payload.error === 'string' ? payload.error : `Request failed (HTTP ${response.status}).`);
      setQuote(markets.find(m => m.symbol === sent.market)?.quoteSymbol ?? 'USDso');
      setResult(parse(payload));
      setRanWith(sent);
    } catch (err) {
      setError(err instanceof Error && err.name === 'AbortError' ? 'Timed out.' : err instanceof Error ? err.message : 'Request failed.');
    } finally { clearTimeout(timer); setBusy(false); }
  }

  const dist = result?.distributions.find(d => d.mode === mode) ?? result?.distributions[0];
  const changed = changedLabels(inputsOf(address, market, days), ranWith, WALLET_WATCH);
  return <section className="wallet" aria-labelledby="wallet-title">
    <div className="workspace-heading"><h2 id="wallet-title">Analyse a wallet</h2><span>02 / RESAMPLE REAL FILLS</span></div>
    <div className="panel wallet-card">
      <div className="wallet-form">
        <label htmlFor="wallet-address">Address<input id="wallet-address" value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={address !== '' && !valid} aria-describedby="wallet-address-help" /><small id="wallet-address-help" className="field-help">0x prefix + 40 hex characters.</small></label>
        <label htmlFor="wallet-market">Market<select id="wallet-market" value={market} onChange={e => setMarket(e.target.value)}>{(markets.length ? markets : ['BTC', 'ETH', 'SOL', 'ZRO'].map(symbol => ({ symbol, quoteSymbol: 'USDso' }))).map(m => <option key={m.symbol} value={m.symbol}>{m.symbol} · {m.quoteSymbol}</option>)}</select></label>
        <label htmlFor="wallet-days">Window<select id="wallet-days" value={days} onChange={e => setDays(e.target.value)}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
        <button type="button" className="primary" disabled={!valid || busy} onClick={() => void run()}>{busy ? 'Reading fills…' : 'Resample'}</button>
      </div>
      <p className="error" role="alert" hidden={error === null}>{error}</p>
      {result && <StaleNote fields={changed} />}
      {result && <CoverageNote coverage={result.coverage} />}
      {result && (dist ? <>
        <div className="segmented resample-mode">{result.distributions.map(d => <label key={d.mode}><input type="radio" name="wallet-mode" checked={dist.mode === d.mode} onChange={() => setMode(d.mode)} /><span>{d.mode.startsWith('shuffle') ? 'Shuffle' : d.mode.startsWith('block') ? 'Block boot.' : 'Bootstrap'}</span></label>)}</div>
        <FanChart dist={dist} quote={quote} original={[]} />
        <ShuffleNote mode={dist.mode} p05={dist.p05} p95={dist.p95} />
        <div className="metrics">
          <Stat label="Closed trades" value={String(result.closedTrades)} note="Closing fills the chain recorded for this address in the window. Opens carry no realized PnL and are skipped." />
          <Stat label="Win rate" value={`${number(result.winRateBps / 100, 1)}%`} note="Share of those closes with a positive gross realized PnL." />
          <Stat label="Realized (gross)" value={amount(result.realizedTotal)} note={`Sum of the chain's realized PnL per closing fill, in ${quote} — fees and funding are not deducted.`} />
          <Stat label="Median final" value={amount(dist.median)} note={DIST_NOTES.medianFinal(dist.paths, quote)} />
          <Stat label="p05 / p95" value={`${amount(dist.p05)} / ${amount(dist.p95)}`} note={DIST_NOTES.p05p95} />
          <Stat label="CVaR 95" value={amount(dist.cvar95)} note={DIST_NOTES.cvar95} />
          <Stat label="Bankruptcy rate" value={`${(Number(dist.bankruptcyRate) * 100).toFixed(1)}%`} note={DIST_NOTES.bankruptcy} />
          <Stat label="Median max drawdown" value={`${number(dist.medianMaxDrawdownBps / 100, 1)}%`} note={DIST_NOTES.drawdown} />
        </div>
        <Histogram values={dist.finalEquities.map(Number)} label="Final equity" />
      </> : <p className="muted">No closed trades in this window.</p>)}
    </div>
  </section>;
}
