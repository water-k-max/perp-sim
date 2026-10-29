'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const form = $('backtest-form');
  let busy = false;
  let result = null;
  let lastRequest = null;
  let exportReady = false;
  const decimal = /^-?\d+(?:\.\d+)?$/;
  const date = t => new Date(t * 1000).toLocaleString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC';
  const amount = value => {
    // Format strings without losing decimal precision to floating-point conversion.
    const [whole, fraction] = String(value).split('.');
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
  };
  const text = (id, value) => { $(id).textContent = value; };
  const markets = new Map();
  let sizeTouched = false;
  function applyMarket(symbol) {
    text('size-unit', symbol);
    const market = markets.get(symbol);
    if (!market) { text('size-help', 'Base asset quantity, not leverage.'); return; }
    text('size-help', `Lots of ${market.lot} ${symbol} · minimum ${market.minQuantity} ${symbol}. Base quantity, not leverage.`);
    const current = $('size').value.trim();
    if (!sizeTouched || !decimal.test(current) || Number(current) < Number(market.minQuantity)) $('size').value = market.minQuantity;
  }
  async function loadMarkets() {
    try {
      const response = await fetch('/api/markets', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const list = await response.json();
      if (!Array.isArray(list) || !list.length) return;
      const select = $('market');
      const previous = select.value;
      select.replaceChildren();
      for (const market of list) {
        markets.set(market.symbol, market);
        const option = document.createElement('option');
        option.value = market.symbol;
        option.textContent = `${market.symbol} · ${market.quoteSymbol}`;
        select.append(option);
      }
      if (markets.has(previous)) select.value = previous;
      applyMarket(select.value);
    } catch { /* the static market list remains usable offline */ }
  }
  $('market').addEventListener('change', () => applyMarket($('market').value));
  $('size').addEventListener('input', () => { sizeTouched = true; });
  loadMarkets();
  ['size', 'cash'].forEach(id => $(id).addEventListener('input', () => $(id).setCustomValidity('')));
  function validateResponse(data) {
    if (!data || typeof data !== 'object' || !data.coverage || !Array.isArray(data.trail) || !Array.isArray(data.warnings)) throw new Error('The server returned an unexpected result. Please retry.');
    for (const key of ['market', 'quoteSymbol', 'side', 'status']) {
      if (typeof data[key] !== 'string') throw new Error('The result is missing required metadata.');
    }
    for (const key of ['size', 'cash', 'entryPrice', 'equityEnd', 'pnl', 'funding', 'fees', 'maxDrawdownPct']) {
      if (typeof data[key] !== 'string' || !decimal.test(data[key]) || !Number.isFinite(Number(data[key]))) throw new Error('The result contains an invalid amount.');
    }
    const timestamp = t => typeof t === 'number' && Number.isFinite(t) && !Number.isNaN(new Date(t * 1000).getTime());
    if (!timestamp(data.from) || !timestamp(data.to) || typeof data.complete !== 'boolean') throw new Error('The result contains invalid period or completion data.');
    for (const point of data.trail) {
      if (!point || !timestamp(point.t) || typeof point.equity !== 'string' || !decimal.test(point.equity) || !Number.isFinite(Number(point.equity))) throw new Error('The result contains invalid chart data.');
    }
    if (!data.warnings.every(w => typeof w === 'string')) throw new Error('The result contains invalid warnings.');
    return data;
  }
  function metric(id, value, signed = false) {
    text(id, Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
    $(id).title = String(value);
    $(id).classList.toggle('positive', signed && Number(value) > 0);
    $(id).classList.toggle('negative', signed && Number(value) < 0);
  }
  function coverageRow(label, value) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value == null ? 'Not reported' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
    row.append(term, detail);
    $('coverage-list').append(row);
  }
  const ns = 'http://www.w3.org/2000/svg';
  function svgNode(tag, attributes, content) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function drawChart(data) {
    const svg = $('chart');
    const points = [...data.trail].sort((a, b) => a.t - b.t);
    svg.replaceChildren(svgNode('title', { id: 'chart-title' }, 'Historical equity'), svgNode('desc', { id: 'chart-desc' }));
    const summary = points.length ? `${points.length} equity samples, from ${date(points[0].t)} to ${date(points[points.length - 1].t)}. Equity starts at ${amount(points[0].equity)} and ends at ${amount(points[points.length - 1].equity)} ${data.quoteSymbol}. Reported maximum drawdown: ${data.maxDrawdownPct}%.` : 'The engine returned no equity samples. Summary metrics are available, but no curve can be drawn.';
    text('chart-desc', summary);
    text('chart-summary', summary);
    text('chart-unit', data.quoteSymbol + ' · UTC');
    if (!points.length) {
      svg.append(svgNode('text', { x: 380, y: 135, 'text-anchor': 'middle' }, 'No equity samples returned'));
      return;
    }
    let low = Infinity, high = -Infinity;
    for (const point of points) { low = Math.min(low, Number(point.equity)); high = Math.max(high, Number(point.equity)); }
    const pad = (high - low) * .12 || Math.max(Math.abs(low) * .01, 1);
    low -= pad; high += pad;
    const start = points[0].t, end = points[points.length - 1].t;
    const x = t => start === end ? 412 : 82 + (t - start) / (end - start) * 656;
    const y = value => 230 - (Number(value) - low) / (high - low) * 204;
    const tickFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    for (let i = 0; i < 5; i++) {
      const value = low + (high - low) * i / 4;
      const yy = y(value);
      svg.append(svgNode('line', { x1: 82, x2: 738, y1: yy, y2: yy, stroke: '#27334a', 'stroke-dasharray': '3 5' }), svgNode('text', { x: 70, y: yy + 4, 'text-anchor': 'end' }, tickFormat.format(value)));
    }
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(p.equity).toFixed(2)}`).join(' ');
    if (points.length > 1) {
      svg.append(svgNode('path', { d: `${path} L${x(end)},230 L${x(start)},230 Z`, fill: '#60e2e9', opacity: '.07' }));
      svg.append(svgNode('path', { d: path, fill: 'none', stroke: '#60e2e9', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    }
    const last = points[points.length - 1];
    svg.append(svgNode('circle', { cx: x(last.t), cy: y(last.equity), r: 4, fill: '#60e2e9' }));
    const shortDate = t => new Date(t * 1000).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
    svg.append(svgNode('text', { x: 82, y: 260 }, shortDate(start)), svgNode('text', { x: 738, y: 260, 'text-anchor': 'end' }, shortDate(end)));
  }
  function render(data) {
    $('empty').hidden = true;
    $('chart-wrap').hidden = false;
    text('result-context', `${data.market} / ${data.quoteSymbol} · ${data.side.toUpperCase()} · ${amount(data.size)} ${data.market} · ${date(data.from)} – ${date(data.to)}`);
    text('result-badge', data.complete ? 'RUN COMPLETE' : 'PARTIAL RESULT');
    metric('equity', data.equityEnd);
    text('equity-note', `${data.quoteSymbol} · Starting cash ${amount(data.cash)}`);
    metric('pnl', data.pnl, true);
    metric('funding', data.funding, true);
    metric('fees', data.fees);
    text('drawdown', amount(data.maxDrawdownPct) + '%');
    ['pnl', 'funding', 'fees'].forEach(id => { $(id).title = `${data[id]} ${data.quoteSymbol}`; });
    const coverageClean = data.complete && !data.coverage.missingSettlements && !data.coverage.gaps && !data.coverage.anchorResynced && (!data.candleCoverage || (data.candleCoverage.complete && data.candleCoverage.covered === data.candleCoverage.bars));
    text('coverage-badge', coverageClean ? 'COMPLETE' : 'REVIEW COVERAGE');
    $('coverage-empty').hidden = true;
    $('coverage-list').hidden = false;
    $('coverage-list').replaceChildren();
    coverageRow('Engine status', data.status);
    coverageRow('Quote currency', data.quoteSymbol);
    coverageRow('Entry price', amount(data.entryPrice));
    for (const [key, label] of Object.entries({ bars: 'Bars', expectedSettlements: 'Expected settlements', missingSettlements: 'Missing settlements', gaps: 'Gaps', anchorResynced: 'Anchor resynced', forgivenIntervals: 'Forgiven intervals', markFromIndex: 'Mark from index' })) coverageRow(label, data.coverage[key]);
    if (data.candleCoverage) {
      coverageRow('Candle bars', data.candleCoverage.bars);
      coverageRow('Candles covered', data.candleCoverage.covered);
      coverageRow('Candle coverage complete', data.candleCoverage.complete);
    } else coverageRow('Candle coverage', 'Not available');
    const warnings = [...data.warnings];
    if (!data.complete) warnings.unshift('This run is incomplete. Treat the returned figures as partial results.');
    $('warnings').replaceChildren();
    for (const warning of warnings) {
      const li = document.createElement('li');
      li.textContent = warning;
      $('warnings').append(li);
    }
    $('warnings').hidden = !warnings.length;
    drawChart(data);
  }
  async function run(payload) {
    if (busy) return;
    busy = true;
    lastRequest = { ...payload };
    exportReady = false;
    $('export').disabled = true;
    $('inputs').disabled = true;
    $('run').disabled = true;
    $('retry').disabled = true;
    $('error').hidden = true;
    $('results').setAttribute('aria-busy', 'true');
    text('run-label', 'Running simulation…');
    text('activity', result ? 'Running a new simulation. Showing previous results below.' : 'Fetching historical data and calculating your position…');
    text('result-badge', result ? 'PREVIOUS RESULT' : 'RUNNING');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch('/api/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { throw new Error(`The server returned an unreadable response (HTTP ${response.status}). Please retry.`); }
      if (!response.ok) {
        const message = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `Request failed (HTTP ${response.status}). Please retry.`;
        throw new Error(message);
      }
      const next = validateResponse(data);
      render(next);
      result = next;
      exportReady = true;
      $('export').disabled = false;
      text('activity', next.complete ? 'Simulation finished. Results are ready.' : 'Simulation returned partial results. Review data coverage.');
    } catch (error) {
      text('error-text', error.name === 'AbortError' ? 'The request timed out after two minutes. Please retry.' : error instanceof TypeError ? 'Could not reach the backtest service. Check your connection and retry.' : error.message);
      $('error').hidden = false;
      text('activity', result ? 'The new run failed. Previous results remain below; they do not reflect the current setup.' : 'No results yet. Resolve the error or retry your request.');
      text('result-badge', result ? 'PREVIOUS RESULT' : 'RUN FAILED');
    } finally {
      clearTimeout(timeout);
      busy = false;
      $('inputs').disabled = false;
      $('run').disabled = false;
      $('retry').disabled = false;
      $('results').setAttribute('aria-busy', 'false');
      text('run-label', 'Run backtest');
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    for (const id of ['size', 'cash']) {
      const input = $(id);
      const value = input.value.trim();
      input.setCustomValidity(/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0 ? '' : 'Enter a positive decimal amount, using a dot for decimals.');
    }
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    run({ market: values.get('market'), days: Number(values.get('days')), side: values.get('side'), size: values.get('size').trim(), cash: values.get('cash').trim(), intrabar: $('intrabar').checked });
  });
  $('retry').addEventListener('click', () => { if (lastRequest) run(lastRequest); });
  $('export').addEventListener('click', () => {
    if (!result || !exportReady || busy) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `nova-backtest-${lastRequest.market}-${result.to}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
