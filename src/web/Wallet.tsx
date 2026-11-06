import { useEffect, useState } from 'react';
import { amount, number, record, type Market } from './dto.js';
import { Histogram, FanChart, Stat } from './Resample.js';

type FanBand = { step: number; p10: string; p25: string; p50: string; p75: string; p90: string };
type Dist = { mode: string; paths: number; median: string; p05: string; p95: string; cvar95: string; bankruptcyRate: string; medianMaxDrawdownBps: number; medianMaxLosingStreak: number; finalEquities: string[]; fan: FanBand[] };
type Wallet = { account: string; market: string; closedTrades: number; winRateBps: number; realizedTotal: string; distributions: Dist[]; warnings: string[] };

const num = (v: unknown) => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
function parse(value: unknown): Wallet {
  if (!record(value) || typeof value.account !== 'string' || !Number.isInteger(value.closedTrades) || !Number.isInteger(value.winRateBps) || !num(value.realizedTotal) || !Array.isArray(value.distributions) || !Array.isArray(value.warnings)) throw new Error('Unexpected response.');
  for (const d of value.distributions as unknown[]) {
    if (!record(d) || typeof d.mode !== 'string' || !Number.isInteger(d.paths) || !num(d.median) || !num(d.p05) || !num(d.p95) || !num(d.cvar95) || !num(d.bankruptcyRate) || !Array.isArray(d.finalEquities) || !(d.finalEquities as unknown[]).every(num)) throw new Error('Unexpected response.');
    if (!Array.isArray(d.fan) || !(d.fan as unknown[]).every(b => record(b) && Number.isInteger(b.step) && num(b.p10) && num(b.p25) && num(b.p50) && num(b.p75) && num(b.p90))) throw new Error('Unexpected response.');
  }
  return value as unknown as Wallet;
}

export function WalletPanel() {
  const [address, setAddress] = useState('');
  const [market, setMarket] = useState('BTC');
  const [markets, setMarkets] = useState<Market[]>([]);
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Wallet | null>(null);
  const [quote, setQuote] = useState('USDso');
  const [mode, setMode] = useState('shuffle_without_replacement');
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/markets', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const list: unknown = await response.json();
        if (!Array.isArray(list) || !list.length || !list.every((m: unknown) => record(m) && typeof m.symbol === 'string' && typeof m.quoteSymbol === 'string')) return;
        if (cancelled) return;
        const next = list as Market[];
        setMarkets(next);
        setMarket(old => next.some(m => m.symbol === old) ? old : next[0].symbol);
      } catch { /* Static choices remain available offline. */ }
    })();
    return () => { cancelled = true; };
  }, []);

  async function run() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const symbol = market.trim() || 'BTC';
      const query = new URLSearchParams({ market: symbol, days, paths: '1000' });
      const response = await fetch(`/api/accounts/${address.trim()}/resample?${query}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(record(payload) && typeof payload.error === 'string' ? payload.error : `Request failed (HTTP ${response.status}).`);
      setQuote(markets.find(m => m.symbol === symbol)?.quoteSymbol ?? 'USDso');
      setResult(parse(payload));
    } catch (err) {
      setError(err instanceof Error && err.name === 'AbortError' ? 'Timed out.' : err instanceof Error ? err.message : 'Request failed.');
    } finally { clearTimeout(timer); setBusy(false); }
  }

  const dist = result?.distributions.find(d => d.mode === mode) ?? result?.distributions[0];
  return <section className="wallet" aria-labelledby="wallet-title">
    <div className="workspace-heading"><h2 id="wallet-title">Analyse a wallet</h2><span>02 / RESAMPLE REAL FILLS</span></div>
    <div className="panel wallet-card">
      <div className="wallet-form">
        <label htmlFor="wallet-address">Address<input id="wallet-address" value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={address !== '' && !valid} /></label>
        <label htmlFor="wallet-market">Market<select id="wallet-market" value={market} onChange={e => setMarket(e.target.value)}>{(markets.length ? markets : ['BTC', 'ETH', 'SOL', 'ZRO'].map(symbol => ({ symbol, quoteSymbol: 'USDso' }))).map(m => <option key={m.symbol} value={m.symbol}>{m.symbol} · {m.quoteSymbol}</option>)}</select></label>
        <label htmlFor="wallet-days">Window<select id="wallet-days" value={days} onChange={e => setDays(e.target.value)}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
        <button type="button" className="primary" disabled={!valid || busy} onClick={() => void run()}>{busy ? 'Reading fills…' : 'Resample'}</button>
      </div>
      <p className="error" role="alert" hidden={error === null}>{error}</p>
      {result && (dist ? <>
        <div className="segmented resample-mode">{result.distributions.map(d => <label key={d.mode}><input type="radio" name="wallet-mode" checked={dist.mode === d.mode} onChange={() => setMode(d.mode)} /><span>{d.mode.startsWith('shuffle') ? 'Shuffle' : d.mode.startsWith('block') ? 'Block boot.' : 'Bootstrap'}</span></label>)}</div>
        <FanChart dist={dist} quote={quote} original={[]} />
        <div className="metrics">
          <Stat label="Closed trades" value={String(result.closedTrades)} />
          <Stat label="Win rate" value={`${number(result.winRateBps / 100, 1)}%`} />
          <Stat label="Realized (gross)" value={amount(result.realizedTotal)} />
          <Stat label="Median final" value={amount(dist.median)} />
          <Stat label="p05 / p95" value={`${amount(dist.p05)} / ${amount(dist.p95)}`} />
          <Stat label="CVaR 95" value={amount(dist.cvar95)} />
          <Stat label="Bankruptcy rate" value={`${(Number(dist.bankruptcyRate) * 100).toFixed(1)}%`} />
          <Stat label="Median max drawdown" value={`${number(dist.medianMaxDrawdownBps / 100, 1)}%`} />
        </div>
        <Histogram values={dist.finalEquities.map(Number)} label="Final equity" />
      </> : <p className="muted">No closed trades in this window.</p>)}
      {result && result.warnings.length > 0 && <ul className="warnings">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
    </div>
  </section>;
}
