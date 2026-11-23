/* Asset Management – read-only viewer. Data comes from data/devices.json (written by scripts/Get-IntuneAssets.ps1).
   No credentials, no calls to Graph. Everything user-visible goes through esc(). */
'use strict';

const $app = document.getElementById('app');
const state = { data: null, assets: [], sort: { key: 'deviceName', desc: false } };
const DAY = 86400000;

// ---------- utils ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '#';
const fmtDate = d => d ? String(d).slice(0, 10) : '—';
const fmtMoney = n => (n == null || n === '') ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' €';
const daysUntil = d => d ? Math.round((new Date(d) - Date.now()) / DAY) : null;
const yearsSince = d => d ? (Date.now() - new Date(d)) / (365.25 * DAY) : null;
const uniq = (arr) => [...new Set(arr.filter(v => v != null && v !== ''))].sort();
const countBy = (arr, fn) => { const m = new Map(); arr.forEach(a => { const k = fn(a) || '(none)'; m.set(k, (m.get(k) || 0) + 1); }); return [...m].sort((a, b) => b[1] - a[1]); };

function enrich(a) {
  a.ageYears = yearsSince(a.purchaseDate);
  const w = daysUntil(a.warrantyEnd);
  a.warrantyDays = w;
  a.warrantyState = a.warrantyEnd == null ? 'unknown' : w < 0 ? 'expired' : w <= 90 ? 'expiring' : 'ok';
  a.ageBucket = a.ageYears == null ? 'unknown' : a.ageYears < 1 ? '0-1 yr' : a.ageYears < 3 ? '1-3 yrs' : a.ageYears < 4 ? '3-4 yrs' : '4+ yrs';
  const types = (a.documents || []).map(d => (d.docType || '').toLowerCase());
  a.hasInvoice = types.some(t => t.includes('invoice'));
  a.hasWarrantyDoc = types.some(t => t.includes('warrant'));
  a.docCount = (a.documents || []).length;
  a.isPurchasable = a.status !== 'Retired' && a.status !== 'Lost';
  return a;
}
const active = a => a.status !== 'Retired' && a.status !== 'Lost';

function chip(text, kind) { return `<span class="chip ${kind || ''}">${esc(text)}</span>`; }
function complianceChip(c) { if (!c) return ''; return chip(c, c === 'compliant' ? 'ok' : c === 'inGracePeriod' ? 'warn' : 'bad'); }
function statusChip(s) { return chip(s, s === 'In use' ? 'ok' : s === 'In repair' ? 'warn' : s === 'Retired' || s === 'Lost' ? 'bad' : ''); }
function warrantyChip(a) {
  if (a.warrantyState === 'expired') return chip('Warranty expired', 'bad');
  if (a.warrantyState === 'expiring') return chip(`Warranty ends in ${a.warrantyDays} d`, 'warn');
  if (a.warrantyState === 'ok') return chip('In warranty', 'ok');
  return chip('No warranty date', 'warn');
}

function bars(rows, linkFn) {
  const max = Math.max(1, ...rows.map(r => r[1]));
  return rows.map(([name, n]) => {
    const inner = `<span class="name" title="${esc(name)}">${esc(name)}</span><span class="track"><span class="fill" style="width:${(n / max * 100).toFixed(0)}%;display:block"></span></span><span class="v">${n}</span>`;
    const href = linkFn ? linkFn(name) : null;
    return href ? `<a class="bar-row" href="${esc(href)}">${inner}</a>` : `<div class="bar-row">${inner}</div>`;
  }).join('') || '<div class="empty">No data</div>';
}

function toCsv(rows, cols) {
  const q = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [cols.map(c => q(c.label)).join(','), ...rows.map(r => cols.map(c => q(c.csv ? c.csv(r) : r[c.key])).join(','))].join('\r\n');
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- data + freshness ----------
async function load() {
  let res = await fetch('data/devices.json', { cache: 'no-store' });
  let sample = false;
  if (!res.ok) { res = await fetch('data/devices.sample.json', { cache: 'no-store' }); sample = true; }
  if (!res.ok) throw new Error('No data file found (data/devices.json). Has the sync task run?');
  state.data = await res.json();
  state.assets = (state.data.assets || []).map(enrich);
  const f = document.getElementById('freshness'), b = document.getElementById('banner');
  const gen = new Date(state.data.generatedAt), hrs = (Date.now() - gen) / 3600000;
  f.textContent = 'Data as of ' + gen.toLocaleString();
  f.classList.toggle('stale', hrs > 24);
  const msgs = [];
  if (sample || state.data.isSample) msgs.push('SAMPLE DATA – not your real inventory.');
  if (hrs > 24) msgs.push(`Data is ${Math.floor(hrs)} hours old – the sync task may have failed.`);
  b.hidden = !msgs.length; b.textContent = msgs.join(' '); b.classList.toggle('bad', hrs > 24);
}

// ---------- router ----------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { route: parts[0] || 'dashboard', arg: parts[1], q: new URLSearchParams(qs || '') };
}
function assetsLink(params) { const q = new URLSearchParams(params).toString(); return '#/assets' + (q ? '?' + q : ''); }

function render() {
  if (!state.data) return;
  const { route, arg, q } = parseHash();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === (route === 'asset' ? 'assets' : route)));
  window.scrollTo(0, 0);
  if (route === 'assets') return renderAssets(q);
  if (route === 'asset') return renderDetail(arg);
  if (route === 'reports') return renderReports(q);
  return renderDashboard();
}

// ---------- dashboard ----------
function renderDashboard() {
  const all = state.assets, act = all.filter(active);
  const n = (fn) => all.filter(fn).length;
  const kpi = (num, label, href, cls) => `<a class="card kpi ${cls || ''}" href="${esc(href)}"><div class="n">${num}</div><div class="l">${esc(label)}</div></a>`;
  const attention = [
    ['Stale devices (no sync)', all.filter(a => a.stale && active(a)), a => `${a.daysSinceLastSync} days`],
    ['Missing invoice', act.filter(a => !a.hasInvoice), () => ''],
    ['Missing warranty document', act.filter(a => !a.hasWarrantyDoc && a.type !== 'Other'), () => ''],
    ['Missing serial number', act.filter(a => !a.serial), () => ''],
    ['No assigned user (in use)', act.filter(a => a.status === 'In use' && !a.user), () => ''],
  ];
  $app.innerHTML = `
    <h1>Dashboard</h1>
    <div class="grid kpis">
      ${kpi(all.length, 'Total assets', '#/assets')}
      ${kpi(n(a => a.status === 'In use'), 'In use', assetsLink({ status: 'In use' }))}
      ${kpi(n(a => a.status === 'In stock'), 'In stock', assetsLink({ status: 'In stock' }))}
      ${kpi(n(a => a.status === 'In repair'), 'In repair', assetsLink({ status: 'In repair' }), 'warn')}
      ${kpi(n(a => a.status === 'Retired'), 'Retired', assetsLink({ status: 'Retired' }))}
      ${kpi(act.filter(a => a.compliance && a.compliance !== 'compliant').length, 'Non-compliant', assetsLink({ compliance: 'noncompliant' }), 'bad')}
      ${kpi(act.filter(a => a.stale).length, 'Not synced > ' + (state.data.config?.staleAfterDays || 30) + ' d', assetsLink({ stale: '1' }), 'warn')}
      ${kpi(act.filter(a => a.warrantyState === 'expiring').length, 'Warranty ends ≤ 90 d', assetsLink({ warranty: 'expiring' }), 'warn')}
      ${kpi(act.filter(a => a.ageBucket === '4+ yrs').length, 'Older than 4 yrs', assetsLink({ age: '4+ yrs' }))}
    </div>
    <div class="grid cols">
      <div class="card"><h2>By platform</h2>${bars(countBy(act.filter(a => a.os), a => a.os), v => assetsLink({ os: v }))}</div>
      <div class="card"><h2>By age</h2>${bars(['0-1 yr', '1-3 yrs', '3-4 yrs', '4+ yrs', 'unknown'].map(b => [b, act.filter(a => a.ageBucket === b).length]).filter(r => r[1]), v => assetsLink({ age: v }))}</div>
      <div class="card"><h2>By compliance</h2>${bars(countBy(act.filter(a => a.compliance), a => a.compliance), v => assetsLink({ compliance: v }))}</div>
      <div class="card"><h2>Top models</h2>${bars(countBy(act, a => `${a.manufacturer || ''} ${a.model || ''}`.trim()).slice(0, 8), v => assetsLink({ q: v }))}</div>
      <div class="card"><h2>By location</h2>${bars(countBy(act, a => a.location), v => assetsLink({ site: v }))}</div>
      <div class="card"><h2>By department</h2>${bars(countBy(act, a => a.department), v => assetsLink({ dept: v }))}</div>
      <div class="card"><h2>OS versions</h2>${bars(countBy(act.filter(a => a.os), a => `${a.os} ${a.osVersion || ''}`.trim()).slice(0, 8))}</div>
    </div>
    <h1>Needs attention</h1>
    <div class="grid cols">
      ${attention.map(([title, list, extra]) => `
        <div class="card"><h2>${esc(title)} <span class="chip ${list.length ? 'warn' : 'ok'}">${list.length}</span></h2>
        ${list.length ? list.slice(0, 6).map(a => `<div><a href="#/asset/${encodeURIComponent(a.id)}">${esc(a.deviceName || a.assetTag || a.serial || a.id)}</a> <span class="muted">${esc(a.user || '')} ${esc(extra(a))}</span></div>`).join('') + (list.length > 6 ? `<div class="muted">+ ${list.length - 6} more</div>` : '') : '<div class="muted">Nothing to do ✓</div>'}
        </div>`).join('')}
    </div>`;
}

// ---------- asset list ----------
const COLS = [
  { key: 'assetTag', label: 'Asset tag' },
  { key: 'deviceName', label: 'Device' },
  { key: 'type', label: 'Type' },
  { key: 'model', label: 'Model', val: a => `${a.manufacturer || ''} ${a.model || ''}`.trim(), csv: a => `${a.manufacturer || ''} ${a.model || ''}`.trim() },
  { key: 'serial', label: 'Serial' },
  { key: 'os', label: 'OS', val: a => a.os ? `${a.os} ${a.osVersion || ''}` : '', csv: a => a.os ? `${a.os} ${a.osVersion || ''}` : '' },
  { key: 'user', label: 'User' },
  { key: 'department', label: 'Dept' },
  { key: 'location', label: 'Location' },
  { key: 'status', label: 'Status', html: a => statusChip(a.status) },
  { key: 'compliance', label: 'Compliance', html: a => complianceChip(a.compliance) },
  { key: 'lastSync', label: 'Last sync', val: a => a.lastSync ? fmtDate(a.lastSync) : '', html: a => a.stale ? chip(fmtDate(a.lastSync), 'bad') : esc(a.lastSync ? fmtDate(a.lastSync) : '') },
  { key: 'purchaseDate', label: 'Purchased', val: a => fmtDate(a.purchaseDate) === '—' ? '' : fmtDate(a.purchaseDate) },
  { key: 'warrantyEnd', label: 'Warranty end', html: a => a.warrantyEnd ? (a.warrantyState === 'expired' ? chip(fmtDate(a.warrantyEnd), 'bad') : a.warrantyState === 'expiring' ? chip(fmtDate(a.warrantyEnd), 'warn') : esc(fmtDate(a.warrantyEnd))) : '' },
  { key: 'docCount', label: 'Docs', html: a => a.docCount ? `📎 ${a.docCount}` : '<span class="muted">0</span>' },
];
const cellVal = (c, a) => c.val ? c.val(a) : (a[c.key] ?? '');

function applyFilters(list, q) {
  const s = (q.get('q') || '').toLowerCase().trim();
  return list.filter(a => {
    if (s && !JSON.stringify([a.assetTag, a.deviceName, a.serial, a.model, a.manufacturer, a.user, a.userEmail, a.department, a.location, a.imei, a.invoiceNo, a.notes]).toLowerCase().includes(s)) return false;
    if (q.get('os') && a.os !== q.get('os')) return false;
    if (q.get('type') && a.type !== q.get('type')) return false;
    if (q.get('status') && a.status !== q.get('status')) return false;
    if (q.get('site') && (a.location || '(none)') !== q.get('site')) return false;
    if (q.get('dept') && (a.department || '(none)') !== q.get('dept')) return false;
    if (q.get('compliance')) { const c = q.get('compliance'); if (c === 'noncompliant' ? (!a.compliance || a.compliance === 'compliant') : a.compliance !== c) return false; }
    if (q.get('age') && a.ageBucket !== q.get('age')) return false;
    if (q.get('warranty') && a.warrantyState !== q.get('warranty')) return false;
    if (q.get('docs') === 'none' && a.docCount) return false;
    if (q.get('docs') === 'has' && !a.docCount) return false;
    if (q.get('stale') && !a.stale) return false;
    if (q.get('user') && a.user !== q.get('user')) return false;
    return true;
  });
}

function renderAssets(q) {
  const all = state.assets;
  const sel = (name, label, opts) => `<select data-f="${name}"><option value="">${esc(label)}</option>${opts.map(o => `<option ${q.get(name) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const rows = applyFilters(all, q);
  const k = state.sort.key, col = COLS.find(c => c.key === k) || COLS[1];
  rows.sort((a, b) => { const x = cellVal(col, a), y = cellVal(col, b); const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }); return state.sort.desc ? -r : r; });
  $app.innerHTML = `
    <h1>Assets</h1>
    <div class="tools">
      <input type="search" id="search" placeholder="Search tag, name, serial, user, model…" value="${esc(q.get('q') || '')}">
      ${sel('os', 'All platforms', uniq(all.map(a => a.os)))}
      ${sel('type', 'All types', uniq(all.map(a => a.type)))}
      ${sel('status', 'All statuses', uniq(all.map(a => a.status)))}
      ${sel('site', 'All locations', uniq(all.map(a => a.location)))}
      ${sel('dept', 'All departments', uniq(all.map(a => a.department)))}
      ${sel('compliance', 'Any compliance', ['compliant', 'noncompliant', 'inGracePeriod'])}
      ${sel('age', 'Any age', ['0-1 yr', '1-3 yrs', '3-4 yrs', '4+ yrs'])}
      ${sel('warranty', 'Any warranty', ['ok', 'expiring', 'expired', 'unknown'])}
      ${sel('docs', 'Docs: any', ['has', 'none'])}
      <button id="clear">Clear</button>
      <span class="count">${rows.length} of ${all.length}</span>
      <button class="primary" id="csv">Export CSV</button>
    </div>
    <div class="tablewrap"><table><thead><tr>${COLS.map(c => `<th data-k="${c.key}" class="${k === c.key ? 'sorted' + (state.sort.desc ? ' desc' : '') : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(a => `<tr data-id="${esc(a.id)}" style="cursor:pointer">${COLS.map((c, i) => `<td>${i === 1 ? `<a href="#/asset/${encodeURIComponent(a.id)}">${esc(a.deviceName || '—')}</a>` : c.html ? c.html(a) : esc(cellVal(c, a))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${COLS.length}" class="empty">No assets match the filters.</td></tr>`}</tbody></table></div>`;

  const setParam = (key, val) => { const p = new URLSearchParams(location.hash.split('?')[1] || ''); val ? p.set(key, val) : p.delete(key); location.hash = '#/assets' + (p.toString() ? '?' + p : ''); };
  $app.querySelectorAll('select[data-f]').forEach(s => s.onchange = () => setParam(s.dataset.f, s.value));
  const search = document.getElementById('search');
  let t; search.oninput = () => { clearTimeout(t); t = setTimeout(() => { setParam('q', search.value); const el = document.getElementById('search'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); };
  document.getElementById('clear').onclick = () => { location.hash = '#/assets'; };
  document.getElementById('csv').onclick = () => download(`assets-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, COLS.filter(c => c.key !== 'docCount').concat([{ key: 'purchasePrice', label: 'Price' }, { key: 'supplier', label: 'Supplier' }, { key: 'invoiceNo', label: 'Invoice no' }, { key: 'costCentre', label: 'Cost centre' }, { key: 'docCount', label: 'Documents' }])));
  $app.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => { state.sort = { key: th.dataset.k, desc: state.sort.key === th.dataset.k ? !state.sort.desc : false }; renderAssets(parseHash().q); });
  $app.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = e => { if (e.target.tagName !== 'A') location.hash = '#/asset/' + encodeURIComponent(tr.dataset.id); });
}

// ---------- asset detail ----------
function renderDetail(id, tab) {
  const a = state.assets.find(x => x.id === id);
  if (!a) { $app.innerHTML = `<h1>Not found</h1><p><a href="#/assets">Back to assets</a></p>`; return; }
  tab = tab || 'hardware';
  const intuneUrl = a.intuneId && state.data.config?.intunePortalDeviceUrl ? state.data.config.intunePortalDeviceUrl.replace('{intuneId}', encodeURIComponent(a.intuneId)) : null;
  const libUrl = state.data.config?.sharePointLibraryUrl;
  const dl = pairs => `<dl>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v == null || v === '' ? '<span class="muted">—</span>' : v}</dd>`).join('')}</dl>`;
  const warn = [];
  if (a.hasInvoice === false && active(a)) warn.push(chip('No invoice attached', 'warn'));
  if (!a.hasWarrantyDoc && active(a)) warn.push(chip('No warranty document', 'warn'));
  if (a.stale) warn.push(chip(`Not synced for ${a.daysSinceLastSync} days`, 'bad'));
  if (a.encrypted === false) warn.push(chip('Not encrypted', 'bad'));
  if (a.ageBucket === '4+ yrs') warn.push(chip('Replacement candidate (4+ yrs)', 'warn'));
  const history = (state.data.history || []).filter(h => h.assetId === a.id);
  const sections = {
    hardware: dl([['Manufacturer', esc(a.manufacturer)], ['Model', esc(a.model)], ['Serial', esc(a.serial)], ['IMEI', esc(a.imei)], ['MAC (Wi-Fi)', esc(a.mac)],
      ['Storage', a.storageTotalGB ? `${esc(a.storageFreeGB)} GB free of ${esc(a.storageTotalGB)} GB` : ''], ['Encrypted', a.encrypted == null ? '' : a.encrypted ? 'Yes' : 'No']]),
    software: dl([['OS', esc(a.os ? `${a.os} ${a.osVersion || ''}` : '')], ['Enrolled', fmtDate(a.enrolledDate)], ['Enrollment type', esc(a.enrollmentType)], ['Owner type', esc(a.ownerType)],
      ['Management state', esc(a.managementState)], ['Compliance', complianceChip(a.compliance)], ['Last sync', a.lastSync ? esc(new Date(a.lastSync).toLocaleString()) : '']]),
    lifecycle: dl([['Purchase date', fmtDate(a.purchaseDate)], ['Age', a.ageYears == null ? '' : a.ageYears.toFixed(1) + ' years'], ['Price', fmtMoney(a.purchasePrice)], ['Supplier', esc(a.supplier)],
      ['Invoice no', esc(a.invoiceNo)], ['Warranty end', a.warrantyEnd ? `${fmtDate(a.warrantyEnd)} ${warrantyChip(a)}` : warrantyChip(a)], ['Planned replacement', fmtDate(a.replaceDate)], ['Cost centre', esc(a.costCentre)], ['Notes', esc(a.notes)]]),
    documents: `${a.docCount ? `<div class="tablewrap"><table class="table-static"><thead><tr><th>Document</th><th>Type</th><th>Valid until</th></tr></thead><tbody>${a.documents.map(d => `<tr><td><a href="${esc(safeUrl(d.webUrl))}" target="_blank" rel="noopener noreferrer">${esc(d.name)}</a></td><td>${esc(d.docType)}</td><td>${fmtDate(d.validUntil)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No documents linked to this asset.</div>'}
      <p class="muted">Documents open in SharePoint – access follows your SharePoint permissions. ${libUrl ? `<a href="${esc(safeUrl(libUrl))}" target="_blank" rel="noopener noreferrer">Open the library to upload a document</a> (set AssetKey to <b>${esc(a.serial || a.assetTag)}</b>).` : ''}</p>`,
    history: history.length ? `<div class="tablewrap"><table class="table-static"><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody>${history.map(h => `<tr><td>${esc(new Date(h.at).toLocaleString())}</td><td>${esc(h.event)}</td><td>${esc(h.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No recorded changes yet.</div>',
  };
  const labels = { hardware: 'Hardware', software: 'Software / OS', lifecycle: 'Lifecycle', documents: `Documents (${a.docCount})`, history: 'History' };
  $app.innerHTML = `
    <p><a href="#/assets">← Assets</a></p>
    <div class="detail-head"><h1>${esc(a.deviceName || a.assetTag || a.model || a.id)}</h1>${statusChip(a.status)} ${a.inIntune ? '' : chip('Not in Intune')} <span class="muted">${esc(a.assetTag)}</span>
      ${intuneUrl ? `<a style="margin-left:auto" href="${esc(safeUrl(intuneUrl))}" target="_blank" rel="noopener noreferrer">Open in Intune ↗</a>` : ''}</div>
    <div class="card" style="margin-bottom:12px">${dl([['Assigned user', a.user ? `<a href="${esc(assetsLink({ user: a.user }))}">${esc(a.user)}</a> <span class="muted">${esc(a.userEmail || '')}</span>` : ''], ['Department', esc(a.department)], ['Location', esc(a.location)], ['Type', esc(a.type)]])}</div>
    <div class="chips">${warn.join('') || chip('No issues found', 'ok')}</div>
    <div class="tabs">${Object.entries(labels).map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
    <div class="card">${sections[tab]}</div>`;
  $app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => renderDetail(id, b.dataset.tab));
}

// ---------- reports ----------
function renderReports(q) {
  const tab = q.get('tab') || 'warranty';
  const act = state.assets.filter(active);
  const tabs = { warranty: 'Warranty expiry', replace: 'Replacement forecast', cost: 'Cost by dept / site', multi: 'Devices per user', removed: 'Recently removed', quality: 'Data quality', user: 'Per-user lookup' };
  const link = a => `<a href="#/asset/${encodeURIComponent(a.id)}">${esc(a.deviceName || a.assetTag || a.serial || a.id)}</a>`;
  const table = (heads, rows) => rows.length ? `<div class="tablewrap"><table class="table-static"><thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing to show ✓</div>';
  let body = '';
  if (tab === 'warranty') {
    const list = act.filter(a => a.warrantyEnd && a.warrantyDays <= 180).sort((a, b) => a.warrantyDays - b.warrantyDays);
    body = `<p class="muted">Warranty already expired or ending within 180 days.</p>` + table(['Asset', 'User', 'Model', 'Warranty end', 'Days left'], list.map(a => [link(a), esc(a.user), esc(a.model), fmtDate(a.warrantyEnd), a.warrantyDays < 0 ? chip(a.warrantyDays + ' d', 'bad') : chip(a.warrantyDays + ' d', 'warn')]));
  } else if (tab === 'replace') {
    const yr = new Date().getFullYear();
    const target = a => a.replaceDate ? new Date(a.replaceDate).getFullYear() : (a.purchaseDate ? new Date(a.purchaseDate).getFullYear() + 4 : null);
    const withY = act.filter(a => target(a) != null && a.type !== 'Other').map(a => ({ a, y: Math.max(target(a), yr) }));
    const years = [...new Set(withY.map(x => x.y))].sort();
    body = `<p class="muted">Based on planned replacement date, otherwise purchase year + 4. Budget estimate uses each asset's original purchase price. Overdue items are counted in ${yr}.</p>` +
      table(['Year', 'Devices', 'Estimated budget'], years.map(y => { const g = withY.filter(x => x.y === y); return [y, g.length, fmtMoney(g.reduce((s, x) => s + (Number(x.a.purchasePrice) || 0), 0))]; }));
  } else if (tab === 'cost') {
    const agg = fn => { const m = new Map(); act.forEach(a => { const k = fn(a) || '(none)'; const o = m.get(k) || { n: 0, c: 0 }; o.n++; o.c += Number(a.purchasePrice) || 0; m.set(k, o); }); return [...m].sort((x, y) => y[1].c - x[1].c).map(([k, o]) => [esc(k), o.n, fmtMoney(o.c)]); };
    body = `<div class="grid cols"><div><h2>By department</h2>${table(['Department', 'Assets', 'Purchase value'], agg(a => a.department))}</div><div><h2>By location</h2>${table(['Location', 'Assets', 'Purchase value'], agg(a => a.location))}</div></div>`;
  } else if (tab === 'multi') {
    const m = new Map(); act.filter(a => a.user).forEach(a => m.set(a.user, [...(m.get(a.user) || []), a]));
    const rows = [...m].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length);
    body = `<p class="muted">People holding 3 or more assets.</p>` + table(['User', 'Count', 'Assets'], rows.map(([u, l]) => [`<a href="${esc(assetsLink({ user: u }))}">${esc(u)}</a>`, l.length, l.map(link).join(', ')]));
  } else if (tab === 'removed') {
    const list = (state.data.history || []).filter(h => h.event === 'removed' || h.event === 'added').sort((a, b) => b.at.localeCompare(a.at));
    body = table(['When', 'Event', 'Asset', 'Detail'], list.map(h => [esc(new Date(h.at).toLocaleString()), chip(h.event, h.event === 'removed' ? 'bad' : 'ok'), esc(h.label), esc(h.detail)]));
  } else if (tab === 'quality') {
    const checks = [
      ['Intune devices not in the Asset Register (no purchase/warranty data)', act.filter(a => a.inIntune && !a.purchaseDate)],
      ['Assets without invoice document', act.filter(a => !a.hasInvoice)],
      ['Assets without warranty document', act.filter(a => !a.hasWarrantyDoc)],
      ['Assets without serial number', act.filter(a => !a.serial)],
      ['Assets without location', act.filter(a => !a.location)],
    ];
    const orphans = state.data.orphanDocuments || [];
    body = checks.map(([t, l]) => `<div class="card" style="margin-bottom:12px"><h2>${esc(t)} <span class="chip ${l.length ? 'warn' : 'ok'}">${l.length}</span></h2>${l.length ? l.slice(0, 15).map(a => `<span style="margin-right:12px">${link(a)}</span>`).join('') + (l.length > 15 ? `<span class="muted">+ ${l.length - 15} more</span>` : '') : '<span class="muted">All good ✓</span>'}</div>`).join('') +
      `<div class="card"><h2>Documents that match no asset <span class="chip ${orphans.length ? 'warn' : 'ok'}">${orphans.length}</span></h2>${orphans.map(d => `<div><a href="${esc(safeUrl(d.webUrl))}" target="_blank" rel="noopener noreferrer">${esc(d.name)}</a> <span class="muted">${esc(d.docType)}</span></div>`).join('') || '<span class="muted">All documents are linked ✓</span>'}</div>`;
  } else if (tab === 'user') {
    const users = uniq(state.assets.map(a => a.user));
    const sel = q.get('u') || '';
    const list = state.assets.filter(a => a.user === sel);
    body = `<div class="tools"><input list="users" id="ulookup" placeholder="Type a name…" value="${esc(sel)}"><datalist id="users">${users.map(u => `<option value="${esc(u)}">`).join('')}</datalist><button id="ugo" class="primary">Show</button></div>` +
      (sel ? table(['Asset', 'Type', 'Model', 'Serial', 'Status', 'Purchased'], list.map(a => [link(a), esc(a.type), esc(a.model), esc(a.serial), statusChip(a.status), fmtDate(a.purchaseDate)])) : '<p class="muted">Pick a person to see everything assigned to them – handy for offboarding.</p>');
  }
  $app.innerHTML = `<h1>Reports</h1><div class="tabs">${Object.entries(tabs).map(([k, l]) => `<a href="#/reports?tab=${k}"><button class="${k === tab ? 'active' : ''}" tabindex="-1">${esc(l)}</button></a>`).join('')}</div>${body}`;
  const go = document.getElementById('ugo');
  if (go) go.onclick = () => { location.hash = '#/reports?tab=user&u=' + encodeURIComponent(document.getElementById('ulookup').value); };
}

// ---------- boot ----------
window.addEventListener('hashchange', render);
load().then(render).catch(err => {
  document.getElementById('freshness').textContent = 'No data';
  $app.innerHTML = `<div class="card"><h1>Could not load data</h1><p>${esc(err.message)}</p></div>`;
});
