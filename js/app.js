/* ============================================================
   CONSTANTS
   ============================================================ */
const ACTION_BUCKETS = [
  { key: 'buy', label: 'Buy', test: /bought|buy|reinvest/i, sign: 1 },
  { key: 'sell', label: 'Sell', test: /sold|sell|redeem/i, sign: -1 },
  { key: 'dividend', label: 'Dividend', test: /dividend/i, sign: 0 },
  { key: 'interest', label: 'Interest', test: /interest/i, sign: 0 },
  { key: 'fee', label: 'Fee', test: /fee/i, sign: 0 },
  { key: 'transfer', label: 'Transfer', test: /transfer|contribution|deposit|withdrawal/i, sign: 0 },
];

function bucketFor(action){
  for (const b of ACTION_BUCKETS) if (b.test.test(action)) return b;
  return { key: 'other', label: 'Other', sign: 0 };
}

/* ============================================================
   CSV PARSING (Fidelity "Accounts History" / activity export)

   Expected columns (by substring match, case-insensitive, order-
   independent): Run Date, Account, Action, Symbol, Description,
   Type, Quantity, Price, Commission, Fees, Accrued Interest,
   Amount, Settlement Date. Only Run Date/Action/Amount are
   required — everything else degrades gracefully if missing.

   The header row is located by scanning the first few lines for
   one containing both "run date" and "action" (Fidelity exports
   sometimes prepend a title line). Rows that don't parse to a
   valid date are skipped rather than aborting the import, which
   also quietly drops the disclaimer/footer text some exports
   append after the data.
   ============================================================ */
function parseCSVLine(line){
  const out = [];
  let cur = '', inQuotes = false;
  for (let i=0; i<line.length; i++){
    const c = line[i];
    if (inQuotes){
      if (c === '"'){
        if (line[i+1] === '"'){ cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ','){ out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(s=>s.trim());
}

function parseMoney(s){
  if (s === undefined || s === null) return NaN;
  let t = String(s).trim();
  if (t === '') return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(t)){ neg = true; t = t.slice(1,-1); }
  t = t.replace(/[$,]/g, '');
  if (t.startsWith('-')){ neg = true; t = t.slice(1); }
  const n = parseFloat(t);
  if (isNaN(n)) return NaN;
  return neg ? -n : n;
}

function parseActivityDate(s){
  const t = String(s || '').trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(parseInt(m[3],10), parseInt(m[1],10)-1, parseInt(m[2],10));
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
  return null;
}

function findCol(header, patterns){
  const lower = header.map(h => h.toLowerCase());
  for (const p of patterns){
    const idx = lower.findIndex(h => h.includes(p));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseFidelityActivityCSV(text, sourceName){
  const lines = text.split(/\r\n|\n|\r/);
  let headerIdx = -1, header = null;
  for (let i=0; i<Math.min(lines.length, 10); i++){
    if (!lines[i] || !lines[i].trim()) continue;
    const cells = parseCSVLine(lines[i]).map(c=>c.toLowerCase());
    if (cells.some(c=>c.includes('run date')) && cells.some(c=>c.includes('action'))){
      headerIdx = i;
      header = parseCSVLine(lines[i]).map(h=>h.trim());
      break;
    }
  }
  if (headerIdx === -1) throw new Error(`${sourceName}: couldn't find a header row with "Run Date" and "Action" columns — is this a Fidelity activity/history export?`);

  const idx = {
    date: findCol(header, ['run date', 'date']),
    account: findCol(header, ['account']),
    action: findCol(header, ['action']),
    symbol: findCol(header, ['symbol']),
    description: findCol(header, ['description']),
    secType: findCol(header, ['type']),
    quantity: findCol(header, ['quantity']),
    price: findCol(header, ['price']),
    commission: findCol(header, ['commission']),
    fees: findCol(header, ['fees']),
    accruedInterest: findCol(header, ['accrued interest']),
    amount: findCol(header, ['amount']),
    settlementDate: findCol(header, ['settlement date']),
  };
  if (idx.date === -1 || idx.action === -1 || idx.amount === -1){
    throw new Error(`${sourceName}: missing one of the required columns (Run Date, Action, Amount)`);
  }

  const rows = [];
  for (let i=headerIdx+1; i<lines.length; i++){
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cells = parseCSVLine(raw);
    const date = parseActivityDate(cells[idx.date]);
    if (!date) continue; // disclaimer/footer line, or a row we can't trust
    const amount = parseMoney(cells[idx.amount]);
    if (isNaN(amount)) continue;
    const quantity = idx.quantity === -1 ? 0 : (parseMoney(cells[idx.quantity]) || 0);
    rows.push({
      date,
      account: idx.account === -1 ? '' : (cells[idx.account] || ''),
      action: idx.action === -1 ? '' : (cells[idx.action] || ''),
      symbol: idx.symbol === -1 ? '' : (cells[idx.symbol] || '').trim(),
      description: idx.description === -1 ? '' : (cells[idx.description] || ''),
      secType: idx.secType === -1 ? '' : (cells[idx.secType] || ''),
      quantity,
      price: idx.price === -1 ? NaN : parseMoney(cells[idx.price]),
      commission: idx.commission === -1 ? 0 : (parseMoney(cells[idx.commission]) || 0),
      fees: idx.fees === -1 ? 0 : (parseMoney(cells[idx.fees]) || 0),
      accruedInterest: idx.accruedInterest === -1 ? 0 : (parseMoney(cells[idx.accruedInterest]) || 0),
      amount,
      settlementDate: idx.settlementDate === -1 ? null : parseActivityDate(cells[idx.settlementDate]),
      source: sourceName,
    });
  }
  return rows;
}

function dedupKey(r){
  const d = r.date instanceof Date ? r.date.toISOString().slice(0,10) : r.date;
  return [d, r.account, r.action, r.symbol, r.amount, r.quantity, r.description].join('|');
}

/* ============================================================
   AGGREGATION
   HOLDINGS: one row per symbol with running quantity and a
   cash-flow-based cost basis (sum of -amount across buy/sell/
   reinvest rows). This is an approximation — it does not track
   lot-level cost basis or pull live prices, so "value" here means
   net cash invested, not current market value. Good enough to
   spot trends; swap in a price feed later for real P/L.
   ============================================================ */
function aggregate(activity){
  const bySymbol = new Map();
  for (const r of activity){
    if (!r.symbol) continue;
    const bucket = bucketFor(r.action);
    if (!bySymbol.has(r.symbol)){
      bySymbol.set(r.symbol, {
        symbol: r.symbol,
        description: r.description,
        quantity: 0,
        costBasis: 0,
        txCount: 0,
        lastDate: r.date,
        account: r.account,
      });
    }
    const h = bySymbol.get(r.symbol);
    h.txCount++;
    if (r.date > h.lastDate) h.lastDate = r.date;
    if (bucket.key === 'buy' || bucket.key === 'sell'){
      h.quantity += r.quantity;
      h.costBasis += -r.amount;
    }
  }
  const holdings = Array.from(bySymbol.values()).sort((a,b)=> b.costBasis - a.costBasis);

  const sorted = activity.slice().sort((a,b)=> a.date - b.date);
  let running = 0;
  const netInvestedSeries = sorted.map(r=>{
    running += -r.amount;
    return { date: r.date, value: running };
  });

  const byBucket = new Map();
  for (const r of activity){
    const b = bucketFor(r.action);
    byBucket.set(b.key, (byBucket.get(b.key) || 0) + r.amount);
  }

  return { holdings, netInvestedSeries, byBucket };
}

/* ============================================================
   STATE
   ============================================================ */
let ACTIVITY = [];
let DERIVED = aggregate(ACTIVITY);
let nav = 'holdings';
let selectedSymbol = null;
let sourceFiles = [];
let ioMessage = '';

function recompute(){
  DERIVED = aggregate(ACTIVITY);
  if (selectedSymbol && !DERIVED.holdings.some(h=>h.symbol === selectedSymbol)) selectedSymbol = null;
}

/* ============================================================
   HELPERS
   ============================================================ */
function fmtMoney(n){
  if (n === undefined || n === null || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(n, dp=4){
  if (n === undefined || n === null || isNaN(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
function fmtDate(d){
  if (!d) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function el(tag, cls, text){
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ============================================================
   LEFT NAV
   ============================================================ */
function navItem(label, key){
  const btn = el('button', 'tf-item' + (nav === key ? ' active' : ''), label);
  btn.type = 'button';
  btn.addEventListener('click', ()=>{ nav = key; renderAll(); });
  return btn;
}

function renderNav(){
  const wrap = document.getElementById('tfList');
  wrap.innerHTML = '';
  wrap.appendChild(navItem('Holdings', 'holdings'));
  wrap.appendChild(navItem('Activity', 'activity'));
  wrap.appendChild(navItem('Charts', 'charts'));
}

/* ============================================================
   MID PANEL
   ============================================================ */
function renderMid(){
  const mid = document.getElementById('midPanel');
  mid.innerHTML = '';
  if (!ACTIVITY.length){
    mid.appendChild(renderEmptyState());
    return;
  }
  if (nav === 'holdings') mid.appendChild(renderHoldings());
  else if (nav === 'activity') mid.appendChild(renderActivity());
  else mid.appendChild(renderCharts());
}

function renderEmptyState(){
  const wrap = el('div', 'empty-state');
  wrap.appendChild(el('div', null, 'No activity loaded yet.'));
  wrap.appendChild(el('div', null, 'Import a Fidelity activity CSV, or load a previously saved JSON file, to get started.'));
  const btn = el('button', 'btn', 'Import CSV');
  btn.type = 'button';
  btn.addEventListener('click', ()=> document.getElementById('importCsvInput').click());
  wrap.appendChild(btn);
  return wrap;
}

function titledSection(title){
  const wrap = el('div', 'mid-body');
  const header = el('div', 'mid-title');
  header.appendChild(el('h2', null, title));
  wrap.appendChild(header);
  return wrap;
}

function renderHoldings(){
  const wrap = titledSection('Holdings');
  const scroll = el('div', 'table-scroll');
  const table = document.createElement('table');
  table.className = 'ledger';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Symbol</th><th>Description</th>
    <th class="num">Quantity</th><th class="num">Net Invested</th>
    <th class="num">Avg Cost</th><th class="num">Transactions</th><th>Last Activity</th>
  </tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const h of DERIVED.holdings){
    const tr = document.createElement('tr');
    if (h.symbol === selectedSymbol) tr.classList.add('selected');
    const avgCost = h.quantity !== 0 ? h.costBasis / h.quantity : NaN;
    tr.innerHTML = `
      <td>${h.symbol}</td>
      <td>${h.description || ''}</td>
      <td class="num">${fmtNum(h.quantity)}</td>
      <td class="num">${fmtMoney(h.costBasis)}</td>
      <td class="num">${fmtMoney(avgCost)}</td>
      <td class="num">${h.txCount}</td>
      <td>${fmtDate(h.lastDate)}</td>`;
    tr.addEventListener('click', ()=>{ selectedSymbol = h.symbol; renderAll(); });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  return wrap;
}

function renderActivity(){
  const wrap = titledSection('Activity');
  const scroll = el('div', 'table-scroll');
  const table = document.createElement('table');
  table.className = 'ledger';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Date</th><th>Account</th><th>Action</th><th>Symbol</th>
    <th class="num">Quantity</th><th class="num">Price</th><th class="num">Amount</th>
  </tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const rows = ACTIVITY.slice().sort((a,b)=> b.date - a.date);
  for (const r of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDate(r.date)}</td>
      <td>${r.account || ''}</td>
      <td>${r.action || ''}</td>
      <td>${r.symbol || ''}</td>
      <td class="num">${r.quantity ? fmtNum(r.quantity) : ''}</td>
      <td class="num">${isNaN(r.price) ? '' : fmtMoney(r.price)}</td>
      <td class="num ${r.amount < 0 ? 'negative' : 'positive'}">${fmtMoney(r.amount)}</td>`;
    if (r.symbol) tr.addEventListener('click', ()=>{ selectedSymbol = r.symbol; renderAll(); });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  return wrap;
}

/* ============================================================
   CHARTS (plain inline SVG, no charting library)
   ============================================================ */
function buildLineChart(series, { width=600, height=200, color='var(--accent-teal)' } = {}){
  if (!series.length){
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    return svg;
  }
  const pad = 24;
  const xs = series.map(p=>p.date.getTime());
  const ys = series.map(p=>p.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys), maxY = Math.max(0, ...ys);
  const spanX = (maxX - minX) || 1;
  const spanY = (maxY - minY) || 1;
  const toX = x => pad + ((x - minX) / spanX) * (width - pad*2);
  const toY = y => height - pad - ((y - minY) / spanY) * (height - pad*2);

  const points = series.map(p => `${toX(p.date.getTime())},${toY(p.value)}`).join(' ');
  const zeroY = toY(0);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const zeroLine = document.createElementNS(svg.namespaceURI, 'line');
  zeroLine.setAttribute('x1', pad); zeroLine.setAttribute('x2', width-pad);
  zeroLine.setAttribute('y1', zeroY); zeroLine.setAttribute('y2', zeroY);
  zeroLine.setAttribute('stroke', 'var(--border-soft)');
  zeroLine.setAttribute('stroke-width', '1');
  svg.appendChild(zeroLine);

  const path = document.createElementNS(svg.namespaceURI, 'polyline');
  path.setAttribute('points', points);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  return svg;
}

function buildBarChart(items, { width=600, height=220, color='var(--accent-teal)' } = {}){
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  if (!items.length) return svg;
  const pad = 8;
  const max = Math.max(...items.map(i=>Math.abs(i.value)), 1);
  const barH = Math.min(28, (height - pad*2) / items.length - 6);
  const labelW = 70;
  items.forEach((item, i)=>{
    const y = pad + i * ((height - pad*2) / items.length);
    const w = Math.max(2, (Math.abs(item.value) / max) * (width - pad*2 - labelW));
    const label = document.createElementNS(svg.namespaceURI, 'text');
    label.setAttribute('x', 0); label.setAttribute('y', y + barH/2 + 4);
    label.setAttribute('fill', 'var(--text-secondary)');
    label.setAttribute('font-size', '11');
    label.textContent = item.label;
    svg.appendChild(label);

    const rect = document.createElementNS(svg.namespaceURI, 'rect');
    rect.setAttribute('x', labelW); rect.setAttribute('y', y);
    rect.setAttribute('width', w); rect.setAttribute('height', barH);
    rect.setAttribute('rx', 3);
    rect.setAttribute('fill', item.value < 0 ? 'var(--negative)' : color);
    svg.appendChild(rect);

    const val = document.createElementNS(svg.namespaceURI, 'text');
    val.setAttribute('x', labelW + w + 6); val.setAttribute('y', y + barH/2 + 4);
    val.setAttribute('fill', 'var(--text-muted)');
    val.setAttribute('font-size', '11');
    val.textContent = fmtMoney(item.value);
    svg.appendChild(val);
  });
  return svg;
}

function renderCharts(){
  const wrap = titledSection('Charts');
  const body = el('div', 'chart-wrap');

  const card1 = el('div', 'chart-card');
  card1.appendChild(el('h3', null, 'Net Amount Invested Over Time'));
  card1.appendChild(buildLineChart(DERIVED.netInvestedSeries));
  const legend1 = el('div', 'chart-legend', 'Cumulative cash invested (buys/sells), not current market value.');
  card1.appendChild(legend1);
  body.appendChild(card1);

  const card2 = el('div', 'chart-card');
  card2.appendChild(el('h3', null, 'Net Invested by Holding'));
  const items = DERIVED.holdings.slice(0, 15).map(h => ({ label: h.symbol, value: h.costBasis }));
  card2.appendChild(buildBarChart(items));
  body.appendChild(card2);

  wrap.appendChild(body);
  return wrap;
}

/* ============================================================
   RIGHT PANEL
   ============================================================ */
function renderRight(){
  const panel = document.getElementById('rightPanel');
  const body = document.getElementById('rightPanelBody');
  body.innerHTML = '';
  if (!selectedSymbol){
    panel.classList.add('collapsed');
    body.setAttribute('inert', '');
    return;
  }
  panel.classList.remove('collapsed');
  body.removeAttribute('inert');

  const h = DERIVED.holdings.find(x => x.symbol === selectedSymbol);
  const wrap = el('div', 'right-detail');
  wrap.appendChild(el('h3', null, selectedSymbol));
  wrap.appendChild(el('div', 'right-sub', h && h.description ? h.description : ''));

  const dl = document.createElement('dl');
  const rows = [
    ['Quantity', h ? fmtNum(h.quantity) : '—'],
    ['Net Invested', h ? fmtMoney(h.costBasis) : '—'],
    ['Avg Cost', h && h.quantity ? fmtMoney(h.costBasis / h.quantity) : '—'],
    ['Transactions', h ? h.txCount : '—'],
    ['Last Activity', h ? fmtDate(h.lastDate) : '—'],
  ];
  for (const [k,v] of rows){
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, String(v)));
  }
  wrap.appendChild(dl);

  wrap.appendChild(el('h3', null, 'Transactions'));
  const txList = ACTIVITY.filter(r => r.symbol === selectedSymbol).sort((a,b)=> b.date - a.date);
  for (const r of txList){
    const row = el('div', 'tx-row');
    row.appendChild(el('span', null, `${fmtDate(r.date)} · ${r.action}`));
    row.appendChild(el('span', `num ${r.amount < 0 ? 'negative' : 'positive'}`, fmtMoney(r.amount)));
    wrap.appendChild(row);
  }

  body.appendChild(wrap);
}

/* ============================================================
   STATUS BAR
   ============================================================ */
function renderStatus(){
  const chip = document.getElementById('statusChip');
  chip.textContent = ACTIVITY.length
    ? `${ACTIVITY.length} transactions · ${DERIVED.holdings.length} holdings`
    : 'No data loaded';
  document.getElementById('ioStatus').textContent = ioMessage;
}

/* ============================================================
   LOAD / SAVE ACTIONS
   ============================================================ */
function mergeActivity(newRows){
  const seen = new Set(ACTIVITY.map(dedupKey));
  let added = 0;
  for (const r of newRows){
    const k = dedupKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    ACTIVITY.push(r);
    added++;
  }
  return added;
}

async function importCSVFiles(files){
  let added = 0, errors = [];
  for (const file of files){
    try {
      const text = await file.text();
      const rows = parseFidelityActivityCSV(text, file.name);
      added += mergeActivity(rows);
      sourceFiles.push(file.name);
    } catch (e){
      errors.push(e.message);
    }
  }
  recompute();
  ioMessage = errors.length
    ? `Imported with errors: ${errors.join('; ')}`
    : `Imported ${added} new transaction(s) from ${files.length} file(s).`;
  renderAll();
}

function loadJSONFile(file){
  file.text().then(text => {
    try {
      const data = JSON.parse(text);
      const rows = (data.activity || []).map(r => ({
        ...r,
        date: new Date(r.date),
        settlementDate: r.settlementDate ? new Date(r.settlementDate) : null,
      }));
      ACTIVITY = [];
      mergeActivity(rows);
      recompute();
      ioMessage = `Loaded ${rows.length} transaction(s) from ${file.name}.`;
      renderAll();
    } catch (e){
      ioMessage = `Couldn't load ${file.name}: ${e.message}`;
      renderStatus();
    }
  });
}

function saveJSON(){
  const data = {
    version: 1,
    savedAt: new Date().toISOString(),
    activity: ACTIVITY,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `investr-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  ioMessage = `Saved ${ACTIVITY.length} transaction(s).`;
  renderStatus();
}

function clearAll(){
  if (!confirm('Clear all loaded activity? This cannot be undone unless you have a saved JSON file.')) return;
  ACTIVITY = [];
  sourceFiles = [];
  selectedSymbol = null;
  recompute();
  ioMessage = 'Cleared.';
  renderAll();
}

/* ============================================================
   RENDER ALL
   ============================================================ */
function renderAll(){
  renderNav();
  renderMid();
  renderRight();
  renderStatus();
}

/* ============================================================
   INIT
   ============================================================ */
function init(){
  document.getElementById('importCsvBtn').addEventListener('click', ()=> document.getElementById('importCsvInput').click());
  document.getElementById('importCsvInput').addEventListener('change', (e)=>{
    if (e.target.files.length) importCSVFiles(Array.from(e.target.files));
    e.target.value = '';
  });
  document.getElementById('loadJsonBtn').addEventListener('click', ()=> document.getElementById('loadJsonInput').click());
  document.getElementById('loadJsonInput').addEventListener('change', (e)=>{
    if (e.target.files.length) loadJSONFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('saveJsonBtn').addEventListener('click', saveJSON);
  document.getElementById('clearBtn').addEventListener('click', clearAll);
  document.getElementById('rightPanelCollapseBtn').addEventListener('click', ()=>{ selectedSymbol = null; renderAll(); });
  document.getElementById('rightPanelExpandBtn').addEventListener('click', ()=>{
    document.getElementById('rightPanel').classList.remove('collapsed');
    document.getElementById('rightPanelBody').removeAttribute('inert');
  });
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
