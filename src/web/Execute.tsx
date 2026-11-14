import { useEffect, useState } from 'react';
import { amount, changedLabels, fetchMarkets, record, validateExecuteResult, type ExecuteCallDTO, type ExecuteCheckDTO, type ExecuteResultDTO, type ExecutionCapability, type Market, type OrderProposalDTO } from './dto.js';
import { Stat, StaleNote } from './Resample.js';

/** The body the panel posts for these form values, and the labels an edit is reported under. */
const inputsOf = (market: string, side: string, orderType: string, size: string, price: string, cash: string, deposit: string) => ({
  market: market.trim() || 'BTC', side, orderType, size: size.trim(), price: price.trim(), cash: cash.trim() || '1000', deposit: deposit.trim(),
});
const EXEC_WATCH = { market: 'Market', side: 'Side', orderType: 'Order type', size: 'Size', price: 'Price', cash: 'Cash', deposit: 'Deposit' };
const positive = (v: string) => /^\d+(?:\.\d+)?$/.test(v.trim()) && Number(v.trim()) > 0;
const nonNegative = (v: string) => /^\d+(?:\.\d+)?$/.test(v.trim());

/**
 *  The bounded execution lens, rendered only when the server says this deployment can place an order
 *  (`capability.available`, true only locally). It previews the exact order the pre-trade gates price,
 *  and — only when the operator has opted in twice (EXECUTION_ENABLED, DRY_RUN=false), configured a key
 *  and ticked the per-request confirm — places one real order on Somnia Hideki testnet. The public
 *  deployment never reaches this component; it renders ExecutionUnavailable instead.
 */
export function ExecutePanel({ capability }: { capability: ExecutionCapability }) {
  const [market, setMarket] = useState('BTC');
  const [markets, setMarkets] = useState<Market[]>([]);
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [cash, setCash] = useState('1000');
  const [deposit, setDeposit] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExecuteResultDTO | null>(null);
  const [ranWith, setRanWith] = useState<ReturnType<typeof inputsOf> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMarkets().then(next => {
      if (cancelled) return;
      setMarkets(next);
      setMarket(old => next.some(m => m.symbol === old) ? old : next[0].symbol);
    }).catch(() => { /* Static choices remain available offline. */ });
    return () => { cancelled = true; };
  }, []);

  const live = capability.enabled && !capability.dryRun;
  const formQuote = markets.find(m => m.symbol === market)?.quoteSymbol ?? 'USDso';
  const sizeValid = positive(size);
  const cashValid = positive(cash);
  const priceValid = price.trim() === '' || positive(price);
  const depositValid = deposit.trim() === '' || nonNegative(deposit);
  const formValid = sizeValid && cashValid && priceValid && depositValid;
  const canSend = live && capability.hasKey && confirm;
  const disabled = busy || !formValid || (live && !canSend);

  async function run() {
    if (disabled) return;
    setBusy(true); setError(null);
    const sent = inputsOf(market, side, orderType, size, price, cash, deposit);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...sent, confirm }),
        signal: controller.signal,
      });
      const out: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(record(out) && typeof out.error === 'string' ? out.error : `Request failed (HTTP ${response.status}).`);
      const next = validateExecuteResult(out);
      setResult(next); setRanWith(sent);
      // A live order consumes its confirmation: the next send needs a fresh, explicit tick.
      if (next.action === 'send') setConfirm(false);
    } catch (err) {
      setError(err instanceof Error && err.name === 'AbortError' ? 'Timed out.' : err instanceof Error ? err.message : 'Request failed.');
    } finally { clearTimeout(timer); setBusy(false); }
  }

  const changed = changedLabels(inputsOf(market, side, orderType, size, price, cash, deposit), ranWith, EXEC_WATCH);
  return <section className="wallet" aria-labelledby="execute-title">
    <div className="workspace-heading"><h2 id="execute-title">Place a testnet order</h2><span>04 / BOUNDED EXECUTION · LOCAL ONLY</span></div>
    <div className="panel wallet-card">
      <div className="exec-badges">
        {live
          ? <span className="pill pill-live">LIVE · TESTNET</span>
          : <span className="pill pill-dry">DRY RUN</span>}
        <span className="pill">CAP {amount(capability.maxNotional)} {formQuote}</span>
        {live && !capability.hasKey && <span className="pill pill-danger">NO KEY</span>}
      </div>
      <p className="muted exec-safety">{live
        ? `This places one real order on Somnia Hideki testnet (chain 50383) with your local PRIVATE_KEY, capped at ${amount(capability.maxNotional)} ${formQuote} notional. ${capability.hasKey ? 'Tick the confirmation below to send.' : 'No PRIVATE_KEY is configured in the local environment, so nothing can be signed or sent.'}`
        : 'Preview only — no transaction is sent and no key is used. The order is priced by the same pre-trade gates the pre-flight check uses, and the exact calldata a live placement would broadcast is shown. To place a real testnet order, set EXECUTION_ENABLED=true and DRY_RUN=false in the local .env.'}</p>

      <div className="execute-form">
        <label htmlFor="exec-market">Market<select id="exec-market" value={market} onChange={e => setMarket(e.target.value)}>{(markets.length ? markets : ['BTC', 'ETH', 'SOL', 'ZRO'].map(symbol => ({ symbol, quoteSymbol: 'USDso' }))).map(m => <option key={m.symbol} value={m.symbol}>{m.symbol} · {m.quoteSymbol}</option>)}</select></label>
        <label htmlFor="exec-size">Size <span className="muted">(base)</span><input id="exec-size" value={size} onChange={e => setSize(e.target.value)} placeholder="0.01" inputMode="decimal" spellCheck={false} autoComplete="off" aria-invalid={size !== '' && !sizeValid} aria-describedby="exec-size-help" /><small id="exec-size-help" className="field-help">Aligned down to the lot grid; below one lot is refused.</small></label>
        <label htmlFor="exec-price">Price <span className="muted">(optional)</span><input id="exec-price" value={price} onChange={e => setPrice(e.target.value)} placeholder="blank: current mark" inputMode="decimal" spellCheck={false} autoComplete="off" aria-invalid={price.trim() !== '' && !priceValid} /></label>
        <label htmlFor="exec-cash">Cash <span className="muted">({formQuote})</span><input id="exec-cash" value={cash} onChange={e => setCash(e.target.value)} inputMode="decimal" spellCheck={false} autoComplete="off" aria-invalid={!cashValid} aria-describedby="exec-cash-help" /><small id="exec-cash-help" className="field-help">Collateral the margin and liquidation gates are measured against.</small></label>
        <label htmlFor="exec-deposit">Deposit <span className="muted">(optional)</span><input id="exec-deposit" value={deposit} onChange={e => setDeposit(e.target.value)} placeholder="blank: skip" inputMode="decimal" spellCheck={false} autoComplete="off" aria-invalid={deposit.trim() !== '' && !depositValid} aria-describedby="exec-deposit-help" /><small id="exec-deposit-help" className="field-help">Collateral to approve and deposit before placing.</small></label>
      </div>

      <div className="exec-controls">
        <fieldset className="direction"><legend>Side</legend><div className="segmented">
          <label><input type="radio" name="exec-side" checked={side === 'long'} onChange={() => setSide('long')} /><span>Long</span></label>
          <label><input type="radio" name="exec-side" checked={side === 'short'} onChange={() => setSide('short')} /><span>Short</span></label>
        </div></fieldset>
        <fieldset className="direction"><legend>Order type</legend><div className="segmented">
          <label><input type="radio" name="exec-type" checked={orderType === 'limit'} onChange={() => setOrderType('limit')} /><span>Limit</span></label>
          <label><input type="radio" name="exec-type" checked={orderType === 'market'} onChange={() => setOrderType('market')} /><span>Market</span></label>
        </div></fieldset>
      </div>

      {live && <label className="checkbox" htmlFor="exec-confirm">
        <input id="exec-confirm" type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} disabled={!capability.hasKey} />
        <span>I understand this sends a real transaction on the testnet.<small>Required for every live order. The notional cap and pre-trade gates still apply.</small></span>
      </label>}

      <div className="exec-actions">
        <button type="button" className="primary" disabled={disabled} onClick={() => void run()}>{busy ? (live ? 'Sending…' : 'Previewing…') : (live ? 'Place testnet order' : 'Preview order')}</button>
        {!formValid && size !== '' && <span className="muted">Enter a positive size and cash to continue.</span>}
      </div>
      <p className="error" role="alert" hidden={error === null}>{error}</p>
      {result && <StaleNote fields={changed} />}
      {result && <OrderResult result={result} />}
    </div>
  </section>;
}

/**
 *  The public deployment's answer: it is read-only and holds no key, so it cannot place an order.
 *  This is a statement about the transport, not a setting the visitor can change — the local lab is
 *  the only place a testnet order can be sent, with the operator's own funded key.
 */
export function ExecutionUnavailable() {
  return <section className="wallet" aria-labelledby="execute-title">
    <div className="workspace-heading"><h2 id="execute-title">Place a testnet order</h2><span>04 / BOUNDED EXECUTION · LOCAL ONLY</span></div>
    <div className="panel wallet-card">
      <div className="exec-badges"><span className="pill">READ-ONLY DEPLOYMENT</span></div>
      <p className="muted">Placing an order is <strong>local-only</strong>. This public deployment is read-only and holds no key, so it cannot send a transaction. To place a real order on Somnia Hideki testnet, run the lab locally with your own funded <code>PRIVATE_KEY</code> — see the README’s Execution section. Everything above (discover, verify, mirror, simulate) works here without a key.</p>
    </div>
  </section>;
}

/** The previewed or sent order, rendered the same way: the proposal it was priced from, then the outcome. */
export function OrderResult({ result }: { result: ExecuteResultDTO }) {
  return <div className="exec-result">
    {result.action === 'send'
      ? <SendReceipt hash={result.hash} depositHash={result.depositHash} orderId={result.orderId} />
      : <p className="integrity-note integrity-preview" role="status"><strong>Preview.</strong> {result.reason}</p>}
    <ProposalView proposal={result.proposal} />
    {result.action === 'preview' && <PreviewCalls calls={result.calls} />}
  </div>;
}

/** The exact money the pre-trade gates computed, plus every gate verdict — never a rounded estimate. */
function ProposalView({ proposal }: { proposal: OrderProposalDTO }) {
  const q = proposal.quoteSymbol;
  return <div className="exec-proposal">
    <h3>{proposal.symbol} · {proposal.side === 'long' ? 'LONG' : 'SHORT'} · {proposal.orderType === 'limit' ? 'LIMIT' : 'MARKET'}</h3>
    {proposal.aligned && <p className="muted">Size aligned down to the lot grid: requested {amount(proposal.requestedSize)}, placing {amount(proposal.size)} {proposal.symbol}.</p>}
    <div className="metrics">
      <Stat label="Notional" value={`${amount(proposal.notional)} ${q}`} note="Size × entry price, in quote units." />
      <Stat label="Initial margin" value={`${amount(proposal.initialMargin)} ${q}`} note="OI-scaled initial margin the pool reserves." />
      <Stat label="Lock" value={`${amount(proposal.lock)} ${q}`} note="Initial margin plus the adverse mark-to-entry reserve." />
      <Stat label="Liquidation price" value={proposal.liquidationPrice === null ? '—' : `${amount(proposal.liquidationPrice)} ${q}`} note="Where this position's equity meets maintenance margin." />
    </div>
    <dl className="facts">
      <div><dt>Placed size</dt><dd>{amount(proposal.size)} {proposal.symbol}</dd></div>
      <div><dt>Entry price</dt><dd>{amount(proposal.price)} {q}</dd></div>
      <div><dt>Mark price</dt><dd>{amount(proposal.markPrice)} {q}</dd></div>
      <div><dt>Cash</dt><dd>{amount(proposal.cash)} {q}</dd></div>
      <div><dt>Notional cap</dt><dd>{amount(proposal.cap)} {q}</dd></div>
      <div><dt>Under cap</dt><dd className={proposal.underCap ? 'positive' : 'negative'}>{proposal.underCap ? 'yes' : 'no'}</dd></div>
      <div><dt>Placeable</dt><dd className={proposal.placeable ? 'positive' : 'negative'}>{proposal.placeable ? 'yes' : 'no'}</dd></div>
    </dl>
    {!proposal.placeable && proposal.binding && <p className="integrity-note integrity-fail" role="alert">Binding gate: <strong>{proposal.binding}</strong>. The pool would refuse this order; fix the failing check before sending.</p>}
    {proposal.placeable && !proposal.underCap && <p className="integrity-note integrity-fail" role="alert">Over the notional cap. The policy kernel refuses to send this; lower the size or raise EXECUTION_MAX_NOTIONAL deliberately.</p>}
    <Checks checks={proposal.checks} />
  </div>;
}

/** Every pre-trade gate, with its verdict and the raw comparison — the failing one is the thing to fix. */
function Checks({ checks }: { checks: ExecuteCheckDTO[] }) {
  return <ul className="exec-checks" aria-label="Pre-trade gate checks">
    {checks.map(c => <li key={c.id}>
      <span className={`verdict ${c.verdict}`}>{c.verdict}</span>
      <span className="check-id">{c.id}</span>
      <code>{c.detail}</code>
    </li>)}
  </ul>;
}

/** The bytes a live placement would broadcast, in order. Shown, never sent, on the preview arm. */
function PreviewCalls({ calls }: { calls: ExecuteCallDTO[] }) {
  return <details className="panel methodology exec-calldata">
    <summary>Calldata a live placement would broadcast <span>{calls.length} call{calls.length === 1 ? '' : 's'} · never sent</span></summary>
    <div>{calls.map((call, i) => <div className="call" key={i}>
      <p className="call-desc">{call.description}</p>
      <code>to {call.to}</code>
      <code>value {call.value}</code>
      <code>{call.data}</code>
    </div>)}</div>
  </details>;
}

/**
 *  The receipt for a sent order. The hash is the evidence — there is no public block explorer for
 *  Hideki, so this never renders an explorer link, only the hash and how to verify it against the RPC.
 */
function SendReceipt({ hash, depositHash, orderId }: { hash: string; depositHash?: string; orderId?: string }) {
  return <div className="exec-receipt integrity-note integrity-ok" role="status">
    <h3>Order sent on testnet</h3>
    <p className="muted">Transaction hash</p>
    <code className="lb-account">{hash}</code>
    {depositHash && <><p className="muted">Margin deposit hash</p><code className="lb-account">{depositHash}</code></>}
    {orderId !== undefined && <p className="muted">Order id <code>{orderId}</code></p>}
    <p className="muted">No public block explorer exists for Somnia Hideki. Verify this hash with <code>eth_getTransactionReceipt</code> against the testnet RPC.</p>
  </div>;
}