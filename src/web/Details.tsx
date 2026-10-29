import { useRef, useState } from 'react';
import { amount, date, describeModel, type Result } from './dto.js';

type Column<T> = { label: string; render: (row: T) => unknown; align?: string };
function Table<T>({ rows, columns, empty }: { rows: T[]; columns: Column<T>[]; empty?: string }) {
  return <div className="table-wrap">{!rows.length ? <p className="muted">{empty}</p> : <table>
    <thead><tr>{columns.map(c => <th key={c.label} scope="col">{c.label}</th>)}</tr></thead>
    <tbody>{rows.map((row, i) => <tr key={i}>{columns.map(c => <td key={c.label} className={c.align}>{String(c.render(row) ?? '—')}</td>)}</tr>)}</tbody>
  </table>}</div>;
}
function RunFacts({ data }: { data: Result }) {
  const facts: [string, unknown][] = [];
  const fact = (label: string, value: unknown) => facts.push([label, value]);
  const quote = data.quoteSymbol;
  if (data.manifest) {
    fact('Run id', data.manifest.runId); fact('Data version', data.manifest.dataVersion);
    fact('Config hash', data.manifest.configHash); fact('Code commit', data.manifest.codeCommit);
    fact('Tape slices', (data.manifest.tapeSlices || []).length);
    if (data.manifest.data) fact('Blocks', `${data.manifest.data.fromBlock}–${data.manifest.data.toBlock}`);
  }
  if (data.model) {
    fact('Fill model', data.model.fillModel); fact('Profile', data.model.profile);
    fact('Latency', `${data.model.latencySec}s`); fact('Window', data.model.windowSec === null ? '—' : `${data.model.windowSec}s`);
    fact('Gas per order', `${data.model.gasPerTx} ${quote}`);
  }
  if (data.strategy) fact('Strategy', `${data.strategy.id} ${JSON.stringify(data.strategy.params)}`);
  if (data.eventHash) fact('Event hash', data.eventHash);
  if (data.attribution) {
    fact('Price PnL', `${amount(data.attribution.price)} ${quote}`); fact('Funding', `${amount(data.attribution.funding)} ${quote}`);
    fact('Taker fees', `${amount(data.attribution.feesTaker)} ${quote}`); fact('Maker fees', `${amount(data.attribution.feesMaker)} ${quote}`);
    fact('Gas', `${amount(data.attribution.gas)} ${quote}`);
    fact('Residual', Number(data.attribution.residual) === 0 ? '0 (exact)' : `${data.attribution.residual} — books do not balance`);
  }
  return <><dl className="facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value ?? '—')}</dd></div>)}</dl>
    {!!data.paramEpochs?.length && <><p className="muted">Parameter epochs read for this window. Each fill is priced with the epoch in force at its own block.</p><Table rows={data.paramEpochs} columns={[
      { label: 'Block', render: e => e.block }, { label: 'Time (UTC)', render: e => date(e.t) },
      { label: 'IM bps', render: e => e.initialMarginBps ?? 'live' }, { label: 'MM bps', render: e => e.maintenanceMarginBps ?? 'live' },
      { label: 'Taker bps×1k', render: e => e.takerFeeBpsTimes1k ?? 'live' }, { label: 'Maker bps×1k', render: e => e.makerFeeBpsTimes1k ?? 'live' },
    ]} /></>}
  </>;
}
const tabs = ['trades', 'fills', 'invariants', 'run'] as const;
export function Details({ data }: { data: Result | null }) {
  const [active, setActive] = useState<string>('trades');
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <section id="detail-tabs" className="panel details" hidden={!data || (!data.analytics && !data.trades)}>
    <div className="tablist" role="tablist" aria-label="Run detail">{tabs.map((name, index) => <button key={name} ref={el => { buttons.current[index] = el; }} id={`tab-button-${name}`} type="button" role="tab" aria-selected={active === name} aria-controls={`tab-${name}`} data-tab={name} tabIndex={active === name ? 0 : -1} onClick={() => setActive(name)} onKeyDown={event => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      buttons.current[next]?.focus(); setActive(tabs[next]);
    }}>{['Trades', 'Fills', 'Invariants', 'Run & data'][index]}</button>)}</div>
    <div id="tab-trades" role="tabpanel" aria-labelledby="tab-button-trades" tabIndex={0} hidden={active !== 'trades'}>{data && <Table rows={data.trades || []} empty="No closed trades in this run." columns={[
      { label: 'Closed (UTC)', render: t => date(t.t) }, { label: 'Side', render: t => t.side }, { label: 'Size', render: t => amount(t.size) },
      { label: 'Entry', render: t => amount(t.entryPrice) }, { label: 'Exit', render: t => amount(t.exitPrice) },
      { label: 'Price PnL', render: t => amount(t.grossPnl), align: 'num' }, { label: 'Funding', render: t => amount(t.funding), align: 'num' },
      { label: 'Fee', render: t => amount(t.fee), align: 'num' }, { label: `Net ${data.quoteSymbol}`, render: t => amount(t.netPnl), align: 'num' },
      { label: 'Held', render: t => `${Math.round(Number(t.heldSec) / 60)}m` },
    ]} />}</div>
    <div id="tab-fills" role="tabpanel" aria-labelledby="tab-button-fills" tabIndex={0} hidden={active !== 'fills'}>{data && <>
      {data.model && <p className="muted">{describeModel(data.model)}</p>}
      <Table rows={data.fills || []} empty="No fills in this run." columns={[
        { label: 'Fill (UTC)', render: f => date(f.t) }, { label: 'Side', render: f => f.side }, { label: 'Size', render: f => amount(f.size) },
        { label: 'Price', render: f => amount(f.price) }, { label: 'Notional', render: f => amount(f.quote), align: 'num' },
        { label: 'Fee', render: f => amount(f.fee), align: 'num' }, { label: 'Tape prints', render: f => f.tapeFills === 0 ? 'mark' : f.tapeFills, align: 'num' },
      ]} />
      {data.orders?.some(o => o.status !== 'filled') && <Table rows={data.orders.filter(o => o.status !== 'filled')} columns={[
        { label: 'Order', render: o => o.id }, { label: 'Side', render: o => o.side }, { label: 'Requested', render: o => amount(o.requested) },
        { label: 'Filled', render: o => amount(o.filled) }, { label: 'Status', render: o => o.status }, { label: 'Reason', render: o => o.reason },
      ]} />}
    </>}</div>
    <div id="tab-invariants" role="tabpanel" aria-labelledby="tab-button-invariants" tabIndex={0} hidden={active !== 'invariants'}>{data && <Table rows={data.invariants || []} empty="This run returned no invariant report." columns={[
      { label: 'Check', render: i => i.id }, { label: 'Status', render: i => i.status.toUpperCase() }, { label: 'Severity', render: i => i.severity }, { label: 'Detail', render: i => i.detail },
    ]} />}</div>
    <div id="tab-run" role="tabpanel" aria-labelledby="tab-button-run" tabIndex={0} hidden={active !== 'run'}>{data && <RunFacts data={data} />}</div>
  </section>;
}
