import { useEffect, useState } from 'react';
import { amount, number, record, validateResample, type Market, type ResampleBlock } from './dto.js';
import { FanChart, Histogram, Stat } from './Resample.js';

type ImportOutcome = {
  runId: string;
  market: string;
  quoteSymbol: string;
  tradeCount: number;
  resample: ResampleBlock;
};

function parse(value: unknown): ImportOutcome {
  if (!record(value) || typeof value.runId !== 'string' || typeof value.market !== 'string' ||
    typeof value.quoteSymbol !== 'string' || !Number.isInteger(value.tradeCount) || !record(value.resample)) {
    throw new Error('Unexpected response.');
  }
  return { ...(value as Record<string, unknown>), resample: validateResample(value.resample) } as unknown as ImportOutcome;
}

const SAMPLE = 'side,entryTime,exitTime,pnl,size,entryPrice\nlong,2026-10-01T12:00:00Z,2026-10-01T18:00:00Z,-12.5,0.5,2100';

export function ImportTradesPanel() {
  const [market, setMarket] = useState('BTC');
  const [markets, setMarkets] = useState<Market[]>([]);
  const [startingCash, setStartingCash] = useState('1000');
  const [payload, setPayload] = useState('');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportOutcome | null>(null);
  const [mode, setMode] = useState('shuffle_without_replacement');
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
    if (busy || payload.trim() === '') return;
    setBusy(true); setError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const resample: Record<string, unknown> = {};
      if (seed.trim() !== '') resample.seed = seed.trim();
      const response = await fetch('/api/trades/resample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ market: market.trim() || 'BTC', startingCash: startingCash.trim() || '1000', payload, resample }),
        signal: controller.signal,
      });
      const out: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(record(out) && typeof out.error === 'string' ? out.error : `Request failed (HTTP ${response.status}).`);
      const next = parse(out);
      setResult(next);
      setMode(next.resample.distributions[0]?.mode ?? 'shuffle_without_replacement');
    } catch (err) {
      setError(err instanceof Error && err.name === 'AbortError' ? 'Timed out.' : err instanceof Error ? err.message : 'Request failed.');
    } finally { clearTimeout(timer); setBusy(false); }
  }

  const block = result?.resample;
  const dist = block?.distributions.find(d => d.mode === mode) ?? block?.distributions[0];
  const failed = block?.invariants.filter(i => i.status === 'fail') ?? [];
  return <section className="wallet" aria-labelledby="import-title">
    <div className="workspace-heading"><h2 id="import-title">Import a trade list</h2><span>03 / RESAMPLE YOUR OWN FILLS</span></div>
    <div className="panel wallet-card">
      <div className="import-form">
        <label htmlFor="import-market">Market<select id="import-market" value={market} onChange={e => setMarket(e.target.value)}>{(markets.length ? markets : ['BTC', 'ETH', 'SOL', 'ZRO'].map(symbol => ({ symbol, quoteSymbol: 'USDso' }))).map(m => <option key={m.symbol} value={m.symbol}>{m.symbol} · {m.quoteSymbol}</option>)}</select></label>
        <label htmlFor="import-cash">Starting cash<input id="import-cash" value={startingCash} onChange={e => setStartingCash(e.target.value)} inputMode="decimal" spellCheck={false} autoComplete="off" /></label>
        <label htmlFor="import-seed">Seed <span className="muted">(optional)</span><input id="import-seed" value={seed} onChange={e => setSeed(e.target.value)} placeholder="blank: derived from the list" spellCheck={false} autoComplete="off" /></label>
      </div>
      <label htmlFor="import-payload">Trades — paste CSV or a JSON array</label>
      <textarea id="import-payload" className="import-payload" value={payload} onChange={e => setPayload(e.target.value)} rows={6} spellCheck={false}
        placeholder={SAMPLE} aria-invalid={payload !== '' && payload.trim() === ''} />
      <p className="muted">Required per trade: side, entryTime, exitTime, pnl. Optional: size, entryPrice, fee, funding. The same columns work as JSON object keys; times accept unix seconds or ISO dates.</p>
      <button type="button" className="primary" disabled={busy || payload.trim() === ''} onClick={() => void run()}>{busy ? 'Resampling…' : 'Resample'}</button>
      <p className="error" role="alert" hidden={error === null}>{error}</p>
      {result && block && (dist ? <>
        <div className="segmented resample-mode">{block.distributions.map(d => <label key={d.mode}><input type="radio" name="import-mode" checked={dist.mode === d.mode} onChange={() => setMode(d.mode)} /><span>{d.mode.startsWith('shuffle') ? 'Shuffle' : d.mode.startsWith('block') ? 'Block boot.' : 'Bootstrap'}</span></label>)}</div>
        <p className="muted">Import id <code>{result.runId.slice(0, 16)}…</code> · {result.tradeCount} trades · {block.meta.paths} paths · seed <code>{block.meta.seed.slice(0, 8)}…</code></p>
        <FanChart dist={dist} quote={result.quoteSymbol} original={[]} />
        <div className="metrics">
          <Stat label="Median final" value={amount(dist.median)} title={`${dist.median} ${result.quoteSymbol}`} />
          <Stat label="p05 / p95" value={`${amount(dist.p05)} / ${amount(dist.p95)}`} />
          <Stat label="CVaR 95" value={amount(dist.cvar95)} title="Mean of the worst 5% of finals" />
          <Stat label="Bankruptcy rate" value={`${(Number(dist.bankruptcyRate) * 100).toFixed(1)}%`} />
          <Stat label="Median max drawdown" value={`${number(dist.medianMaxDrawdownBps / 100, 1)}%`} />
          <Stat label="Win rate p05 / p95" value={`${number(dist.p05WinRateBps / 100, 1)}% / ${number(dist.p95WinRateBps / 100, 1)}%`} title="Trade-order confidence interval for the win rate" />
          <Stat label="Sharpe p05 / p95" value={dist.p05SharpeX1e4 === null || dist.medianSharpeX1e4 === null || dist.p95SharpeX1e4 === null ? '—' : `${number(dist.p05SharpeX1e4 / 10_000, 2)} / ${number(dist.p95SharpeX1e4 / 10_000, 2)}`} title="Trade-order confidence interval for per-trade Sharpe" />
        </div>
        <Histogram values={dist.finalEquities.map(Number)} label={`Final equity (${result.quoteSymbol})`} />
        <details className="panel methodology">
          <summary>What this import assumes <span>Audit &amp; disclosures</span></summary>
          <h4>Assumptions</h4>
          <ul className="warnings">{block.assumptions.map((line, i) => <li key={i}>{line}</li>)}</ul>
          <h4>Limits of this check</h4>
          <ul className="warnings">{block.audit.notes.map((line, i) => <li key={i}>{line}</li>)}</ul>
          {block.sizing.rows.length > 0 && <>
            <h4>Sizing ladder</h4>
            <div className="table-wrap"><table>
              <thead><tr><th scope="col">Size ({result.market})</th><th scope="col">Loss probability</th><th scope="col">Median PnL</th><th scope="col">p05 PnL</th></tr></thead>
              <tbody>{block.sizing.rows.map((row, i) => <tr key={i}><td>{amount(row.sizeBase)}</td><td>{(Number(row.lossProbability) * 100).toFixed(1)}%</td><td className="num">{amount(row.medianPnl)}</td><td className="num">{amount(row.p05Pnl)}</td></tr>)}</tbody>
            </table></div>
            <p className="muted">Accepted loss {amount(block.sizing.acceptedLoss)} {result.quoteSymbol} within the first {block.sizing.horizonTrades} trades.</p>
          </>}
        </details>
        {(failed.length > 0 || block.warnings.length > 0) && <ul className="warnings" aria-label="Import warnings">
          {failed.map((i) => <li key={i.id}>Invariant {i.id} failed: {i.detail}</li>)}
          {block.warnings.map((w, i) => <li key={`w${i}`}>{w}</li>)}
        </ul>}
      </> : <p className="muted">The imported list carries no trades.</p>)}
    </div>
  </section>;
}
