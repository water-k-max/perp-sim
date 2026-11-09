import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { decimal, fetchMarkets, type Market, type RequestDTO } from './dto.js';

const PROFILE_HELP = { optimistic: '5 s window · 100% of volume', realistic: '30 s window · 25% of volume', conservative: '120 s window · 5% of volume' };
type Fields = {
  market: string; side: 'long' | 'short'; size: string; cash: string; windowMode: 'days' | 'custom'; days: string;
  from: string; to: string; intrabar: boolean; fillModel: RequestDTO['fillModel']; profile: RequestDTO['fillProfile'];
  latency: string; gas: string; strategy: 'fixed' | 'sma'; fast: string; slow: string;
  resample: boolean; resampleSeed: string; resamplePaths: string;
  resampleMode: 'both' | 'shuffle_without_replacement' | 'bootstrap_with_replacement';
  resampleSizing: 'static' | 'compound';
};
export type { Fields as ConfigFields };

/**
 *  The inputs that actually feed the request for the form as it stands: only the window
 *  control the mode uses, and only the resample options when resampling is on. Anything
 *  here that moves after a run makes the results on screen answer a setup that is gone.
 */
export function watchFields(fields: Fields): Partial<Record<keyof Fields, string>> {
  const window = fields.windowMode === 'custom' ? { from: 'Start date', to: 'End date' } : { days: 'Lookback' };
  const strategy = fields.strategy === 'sma' ? { fast: 'Fast SMA', slow: 'Slow SMA' } : {};
  const resample = fields.resample ? { resampleSeed: 'Resample seed', resamplePaths: 'Resample paths', resampleMode: 'Resample mode', resampleSizing: 'Resample sizing' } : {};
  return { market: 'Market', side: 'Side', size: 'Size', cash: 'Starting cash', intrabar: 'Intra-bar path', fillModel: 'Fill model', profile: 'Fill profile', latency: 'Latency', gas: 'Gas per order', strategy: 'Strategy', ...window, ...strategy, resample: 'Resampling', ...resample };
}
export function Configuration({ busy, error, onRun, onRetry, onDraft, mobile, open, hasResults, onEdit, onShowResults }: {
  mobile: boolean; open: boolean; hasResults: boolean; onEdit: () => void; onShowResults: () => void;
  busy: boolean; error: string | null; onRun: (body: RequestDTO, fields: Fields) => void; onRetry: () => void;
  onDraft: (fields: Fields) => void;
}) {
  const [fields, setFields] = useState<Fields>({ market: 'BTC', side: 'long', size: '0.01', cash: '1000', windowMode: 'days', days: '14', from: '', to: '', intrabar: true, fillModel: 'tape', profile: 'realistic', latency: '1', gas: '0', strategy: 'fixed', fast: '6', slow: '24', resample: false, resampleSeed: '', resamplePaths: '1000', resampleMode: 'both', resampleSizing: 'static' });
  const [markets, setMarkets] = useState<Market[]>([]);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const dateRefs = useRef<Partial<Record<'from' | 'to', HTMLInputElement | null>>>({});
  const sizeTouched = useRef(false);
  const decimals = useRef<Partial<Record<'size' | 'cash' | 'gas', HTMLInputElement | null>>>({});
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields(old => ({ ...old, [key]: value }));
  const applyMarket = (old: Fields, market: Market | undefined, symbol: string): Fields => ({ ...old, market: symbol, size: market && (!sizeTouched.current || !decimal.test(old.size.trim()) || Number(old.size.trim()) < Number(market.minQuantity)) ? market.minQuantity : old.size });
  useEffect(() => {
    let cancelled = false;
    fetchMarkets().then(next => {
      if (cancelled) return;
      setMarkets(next);
      setFields(old => { const market = next.find(m => m.symbol === old.market) ?? next[0]; return applyMarket(old, market, market.symbol); });
    }).catch(() => { /* Static choices remain available offline. */ });
    return () => { cancelled = true; };
  }, []);
  const decimalInput = (key: 'size' | 'cash' | 'gas') => ({
    ref: (el: HTMLInputElement | null) => { decimals.current[key] = el; },
    value: fields[key], onChange: (event: ChangeEvent<HTMLInputElement>) => {
      if (key === 'size') sizeTouched.current = true;
      event.currentTarget.setCustomValidity(''); set(key, event.currentTarget.value);
    },
  });
  const market = markets.find(m => m.symbol === fields.market);
  // The parent needs the live form to tell an edited setup from a matching one.
  useEffect(() => { onDraft(fields); }, [fields, onDraft]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    for (const key of ['size', 'cash', 'gas'] as const) {
      const value = fields[key].trim();
      decimals.current[key]?.setCustomValidity(/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? '' : 'Enter a decimal amount, using a dot for decimals.');
    }
    if (!event.currentTarget.reportValidity()) return;
    const body: RequestDTO = {
      market: fields.market, side: fields.side, size: fields.size.trim(), cash: fields.cash.trim(), intrabar: fields.intrabar,
      fillModel: fields.fillModel, fillProfile: fields.profile, latencySec: Number(fields.latency), gasPerTx: fields.gas.trim(),
      strategy: fields.strategy === 'sma' ? { id: 'sma', params: { fast: Number(fields.fast), slow: Number(fields.slow), side: 'both' } } : { id: 'fixed', params: { side: fields.side, atBar: 1 } },
    };
    if (fields.windowMode === 'custom') {
      if (!fields.from || !fields.to || fields.from >= fields.to) {
        setRangeError(!fields.from || !fields.to ? 'Choose both a start and an end date.' : 'The end date must be after the start date.');
        const first = !fields.from ? dateRefs.current.from : !fields.to ? dateRefs.current.to : dateRefs.current.from;
        first?.focus();
        first?.scrollIntoView({ block: 'center' });
        return;
      }
      setRangeError(null);
      body.from = fields.from; body.to = fields.to;
    } else body.days = Number(fields.days);
    if (fields.resample) {
      body.resample = {
        seed: fields.resampleSeed.trim(),
        paths: Number(fields.resamplePaths),
        mode: fields.resampleMode,
        sizing: fields.resampleSizing,
        horizonTrades: null,
        acceptedLoss: null,
        holdbackFraction: 0.3,
      };
    }
    onRun(body, fields);
  }
  return <section className="panel configuration" aria-labelledby="config-title">
    <div className="panel-heading"><h3 id="config-title" tabIndex={-1}>Position setup</h3><span className="pill">PERPETUALS</span></div>
    <div className="mobile-setup-controls setup-navigation">
      <p className="muted">{fields.market} · {fields.side.toUpperCase()} · {fields.size} · {fields.windowMode === 'days' ? `${fields.days} days` : `${fields.from || 'Start'} – ${fields.to || 'End'}`} · {fields.strategy === 'fixed' ? 'Fixed position' : 'SMA crossover'}</p>
      <div>{!open && <button type="button" className="secondary" aria-expanded={false} aria-controls="backtest-form" onClick={onEdit}>Edit setup</button>}{hasResults && <button type="button" className="secondary" aria-controls="results" onClick={onShowResults}>Show results</button>}</div>
    </div>
    <p className="muted intro" hidden={mobile && !open}>One position. A clearer picture.</p>
    <form id="backtest-form" hidden={mobile && !open} onSubmit={submit}>
      <fieldset id="inputs" disabled={busy}>
        <label htmlFor="market">Market</label><select id="market" name="market" value={fields.market} onChange={e => { const symbol = e.target.value; setFields(old => applyMarket(old, markets.find(m => m.symbol === symbol), symbol)); }}>{(markets.length ? markets : ['BTC', 'ETH', 'SOL', 'ZRO'].map(symbol => ({ symbol, quoteSymbol: 'USDso' }))).map(m => <option key={m.symbol} value={m.symbol}>{m.symbol} · {m.quoteSymbol}</option>)}</select>
        <fieldset className="direction"><legend>Direction</legend><div className="segmented"><label><input type="radio" name="side" value="long" checked={fields.side === 'long'} onChange={() => set('side', 'long')} /><span>↗ Long</span></label><label><input type="radio" name="side" value="short" checked={fields.side === 'short'} onChange={() => set('side', 'short')} /><span>↘ Short</span></label></div></fieldset>
        <label htmlFor="size">Position size <span id="size-unit">{fields.market}</span></label><input id="size" name="size" type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" {...decimalInput('size')} required aria-describedby="size-help" /><small id="size-help" className="field-help">{market ? `Lots of ${market.lot} ${fields.market} · minimum ${market.minQuantity} ${fields.market}. Base quantity, not leverage.` : 'Base asset quantity, not leverage.'}</small>
        <label htmlFor="cash">Starting cash <span>Quote currency</span></label><input id="cash" name="cash" type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" {...decimalInput('cash')} required />
        <label htmlFor="window-mode">Window <span>UTC</span></label><select id="window-mode" name="windowMode" value={fields.windowMode} onChange={e => { set('windowMode', e.target.value as Fields['windowMode']); setRangeError(null); }}><option value="days">Lookback in days</option><option value="custom">Custom dates</option></select>
        <label htmlFor="days" id="days-label" hidden={fields.windowMode === 'custom'}>Lookback window <span>1–90 days</span></label><div className="input-suffix" id="days-row" hidden={fields.windowMode === 'custom'}><input id="days" name="days" type="number" min="1" max="90" step="1" value={fields.days} onChange={e => set('days', e.target.value)} required /><span>days</span></div>
        <div id="custom-range" hidden={fields.windowMode !== 'custom'}>
          <label htmlFor="from">From <span>00:00 UTC</span></label><input id="from" name="from" type="date" ref={el => { dateRefs.current.from = el; }} value={fields.from} onChange={e => { set('from', e.target.value); setRangeError(null); }} aria-invalid={rangeError !== null} aria-describedby="range-error" />
          <label htmlFor="to">To <span>00:00 UTC, exclusive</span></label><input id="to" name="to" type="date" ref={el => { dateRefs.current.to = el; }} value={fields.to} onChange={e => { set('to', e.target.value); setRangeError(null); }} aria-invalid={rangeError !== null} aria-describedby="range-error" />
          <p id="range-error" className="field-error" role="alert" hidden={rangeError === null}>{rangeError}</p>
        </div>
        <label className="checkbox"><input id="intrabar" name="intrabar" type="checkbox" checked={fields.intrabar} onChange={e => set('intrabar', e.target.checked)} /><span>Include intrabar checks<small>Use hourly candle extremes for maintenance checks.</small></span></label>
      </fieldset>
      <fieldset id="model-fields" disabled={busy}>
        <legend className="field-legend">Execution model</legend>
        <label htmlFor="fill-model">Fill model</label><select id="fill-model" name="fillModel" value={fields.fillModel} onChange={e => set('fillModel', e.target.value as Fields['fillModel'])}><option value="tape">Trade tape (modelled fill)</option><option value="settlement-mark">Settlement mark</option></select>
        <label htmlFor="profile">Tape profile <span id="profile-help">{fields.fillModel === 'tape' ? PROFILE_HELP[fields.profile] : 'settlement mark, no tape read'}</span></label><select id="profile" name="profile" disabled={fields.fillModel !== 'tape'} value={fields.profile} onChange={e => set('profile', e.target.value as Fields['profile'])}><option value="optimistic">Optimistic — 5 s · 100%</option><option value="realistic">Realistic — 30 s · 25%</option><option value="conservative">Conservative — 120 s · 5%</option></select>
        <label htmlFor="latency">Decision latency <span>seconds</span></label><input id="latency" name="latency" type="number" min="0" max="300" step="1" value={fields.latency} onChange={e => set('latency', e.target.value)} required />
        <label htmlFor="gas">Gas per order <span>quote units</span></label><input id="gas" name="gas" type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" {...decimalInput('gas')} required />
        <label htmlFor="strategy">Strategy</label><select id="strategy" name="strategy" value={fields.strategy} onChange={e => set('strategy', e.target.value as Fields['strategy'])}><option value="fixed">Fixed position, held to the end</option><option value="sma">SMA crossover</option></select>
        <div id="sma-fields" hidden={fields.strategy !== 'sma'}>
          <label htmlFor="fast">Fast window <span>bars</span></label><input id="fast" name="fast" type="number" min="1" max="200" step="1" value={fields.fast} onChange={e => set('fast', e.target.value)} />
          <label htmlFor="slow">Slow window <span>bars</span></label><input id="slow" name="slow" type="number" min="2" max="400" step="1" value={fields.slow} onChange={e => set('slow', e.target.value)} />
        </div>
      </fieldset>
      <fieldset id="resample-fields" disabled={busy}>
        <legend className="field-legend">Trade-order resampling (optional)</legend>
        <label className="checkbox"><input id="resample" name="resample" type="checkbox" checked={fields.resample} onChange={e => set('resample', e.target.checked)} /><span>Add resampling analysis<small>Distribution, optimism audit, sizing odds and an out-of-sample boundary over this run&apos;s trade list.</small></span></label>
        <div id="resample-options" hidden={!fields.resample}>
          <label htmlFor="resample-seed">Seed <span>blank derives one from the run id</span></label><input id="resample-seed" name="resampleSeed" type="text" value={fields.resampleSeed} onChange={e => set('resampleSeed', e.target.value)} />
          <label htmlFor="resample-paths">Paths <span>10–20,000</span></label><input id="resample-paths" name="resamplePaths" type="number" min="10" max="20000" step="1" value={fields.resamplePaths} onChange={e => set('resamplePaths', e.target.value)} required />
          <label htmlFor="resample-mode">Draw</label><select id="resample-mode" name="resampleMode" value={fields.resampleMode} onChange={e => set('resampleMode', e.target.value as Fields['resampleMode'])}><option value="both">Shuffle + bootstrap (compare both)</option><option value="shuffle_without_replacement">Shuffle without replacement</option><option value="bootstrap_with_replacement">Bootstrap with replacement</option></select>
          <label htmlFor="resample-sizing">Sizing</label><select id="resample-sizing" name="resampleSizing" value={fields.resampleSizing} onChange={e => set('resampleSizing', e.target.value as Fields['resampleSizing'])}><option value="static">Static size per trade</option><option value="compound">Compound (reinvest within a cap)</option></select>
        </div>
      </fieldset>
      <button id="run" className="primary" type="submit" disabled={busy}><span id="run-label">{busy ? 'Running simulation…' : 'Run backtest'}</span><span aria-hidden="true">↗</span></button>
      <p className="form-note">Simulation only. No orders are placed.</p>
    </form>
    <div id="error" className="error" role="alert" hidden={error === null}><p id="error-text">{error}</p><button id="retry" type="button" className="secondary" disabled={busy} onClick={onRetry}>Retry last request</button></div>
  </section>;
}
