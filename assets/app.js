/* =====================================================================
   Zotero Paper Hub — 静态文献检索与追溯系统
   数据: data/papers.json (由 export_papers.py 从 zotero.sqlite 生成)
   ===================================================================== */
'use strict';

/* ---------------- 全局状态 ---------------- */
const S = {
  papers: [],
  meta: {},
  idx: { byId: new Map(), authors: new Map(), tags: new Map(), venues: new Map(), types: new Map(), years: new Map(), colls: new Map() },
  route: { view: 'dashboard', arg: null, q: null },
  lib: { q: '', type: '', coll: '', tag: '', year: '', sort: 'year_desc', page: 1, pageSize: 20, searchAbstract: true },
  charts: [],
  ghRate: { remaining: null, limit: null },
};

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const norm = s => String(s || '').toLowerCase().normalize('NFKD');

/* ---------------- 数据加载 ---------------- */
async function loadData() {
  const fill = $('#loader-fill'), text = $('#loader-text');
  const resp = await fetch('data/papers.json');
  if (!resp.ok) throw new Error('papers.json 加载失败: ' + resp.status);
  const total = +resp.headers.get('content-length') || 7e6;
  const reader = resp.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    fill.style.width = Math.min(99, Math.round(got / total * 100)) + '%';
    text.textContent = `正在加载文献数据… ${(got / 1e6).toFixed(1)} MB`;
  }
  fill.style.width = '100%';
  text.textContent = '正在建立索引…';
  const buf = await new Blob(chunks).arrayBuffer();
  const data = JSON.parse(new TextDecoder('utf-8').decode(buf));
  S.papers = data.papers; S.meta = data.meta;
  buildIndex();
  await new Promise(r => setTimeout(r, 150));
  $('#loader').style.display = 'none';
  $('#topbar').hidden = false; $('#main').hidden = false;
  $('#brand-meta').textContent = `${S.papers.length} 篇文献`;
}

function buildIndex() {
  const P = S.papers, idx = S.idx;
  for (const p of P) {
    idx.byId.set(p.id, p);
    p._searchBase = null; // lazy
    const add = (m, k) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(p); };
    for (const a of p.allAuthors) add(idx.authors, a);
    for (const t of p.tags) add(idx.tags, t);
    add(idx.venues, p.venue);
    add(idx.types, p.type);
    add(idx.colls, p.collections.join(' / '));
    if (p.year) { const y = String(p.year); if (!idx.years.has(y)) idx.years.set(y, []); idx.years.get(y).push(p); }
  }
}

/* ---------------- 搜索评分引擎 ---------------- */
const STOP = new Set('a an the and or of for to in on with by from at as is are was were be been it its this that we you they he she i not no can will would could based using via new approach proposed paper study analysis method methods algorithm algorithms learning model models data deep neural network networks federated'.split(' '));

function tokenize(text) {
  const t = norm(text).replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  const out = [];
  for (const w of t.split(/\s+/)) {
    if (!w || w.length <= 1) continue;
    const isLatin = /^[\x00-\x7f]+$/.test(w);
    if (isLatin) { if (!STOP.has(w)) out.push(w); continue; }
    // CJK：整词 + bigram（让中文相似度/关键词可用）
    out.push(w);
    const m = w.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of m) for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function keywordExtract(text, n) {
  const t = norm(text).replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  const words = [];
  for (const w of t.split(/\s+/)) {
    if (w.length < 4) continue;
    if (/[\u4e00-\u9fff]/.test(w)) { if (w.length >= 4) words.push(w); }
    else if (!STOP.has(w)) words.push(w);
  }
  return words.slice(0, n || 20);
}

function parseQuery(q) {
  const terms = []; const re = /(\w+):"([^"]*)"|(\w+):([^\s"]+)|"([^"]*)"|(\S+)/g; let m;
  while ((m = re.exec(q))) {
    if (m[1]) terms.push({ field: m[1].toLowerCase(), text: m[2].toLowerCase() });
    else if (m[3]) terms.push({ field: m[3].toLowerCase(), text: m[4].toLowerCase() });
    else if (m[5] !== undefined) terms.push({ field: 'any', text: m[5].toLowerCase(), phrase: true });
    else terms.push({ field: 'any', text: m[6].toLowerCase() });
  }
  return terms;
}

function paperHaystacks(p) {
  if (p._searchBase) return p._searchBase;
  const authors = p.allAuthors.join(' ');
  const tags = p.tags.join(' ');
  const p2 = { title: norm(p.title), authors: norm(authors), venue: norm(p.venue), tags: norm(tags), doi: norm(p.doi), abstract: norm(p.abstract), coll: norm(p.collections.join(' ')), year: p.year ? String(p.year) : '', any: '' };
  p2.any = [p2.title, p2.authors, p2.venue, p2.tags, p2.doi, p2.coll].join(' ');
  if (S.lib.searchAbstract) p2.any += ' ' + p2.abstract;
  p._searchBase = p2;
  return p2;
}

function scorePaper(p, terms) {
  if (!terms.length) return 1;
  const h = paperHaystacks(p);
  let total = 0;
  for (const t of terms) {
    let hit = false;
    const txt = t.text;
    if (t.field === 'any') {
      if (h.title.includes(txt)) { total += t.phrase ? 30 : 14; hit = true; }
      else if (h.authors.includes(txt)) { total += t.phrase ? 18 : 9; hit = true; }
      else if (h.tags.includes(txt) || h.coll.includes(txt)) { total += t.phrase ? 16 : 8; hit = true; }
      else if (h.venue.includes(txt)) { total += 7; hit = true; }
      else if (h.doi.includes(txt)) { total += 10; hit = true; }
      else if (S.lib.searchAbstract && h.abstract.includes(txt)) { total += t.phrase ? 6 : 3; hit = true; }
      else if (h.any.includes(txt)) { total += 2; hit = true; }
    } else if (t.field === 'title') { if (h.title.includes(txt)) { total += 16; hit = true; } }
    else if (t.field === 'author') { if (h.authors.includes(txt)) { total += 12; hit = true; } }
    else if (t.field === 'venue' || t.field === 'journal') { if (h.venue.includes(txt)) { total += 10; hit = true; } }
    else if (t.field === 'tag') { if (h.tags.includes(txt)) { total += 12; hit = true; } }
    else if (t.field === 'doi') { if (h.doi.includes(txt)) { total += 12; hit = true; } }
    else if (t.field === 'year') {
      const m = /^(\d{4})(?:-(\d{4}))?$/.exec(txt);
      if (m) { const y = p.year || 0; if (y >= +m[1] && y <= +(m[2] || m[1])) { total += 5; hit = true; } }
    }
    if (!hit) return 0; // AND 语义
  }
  return total;
}

function searchPapers(q, pool) {
  const terms = parseQuery(q.trim());
  if (!terms.length) return pool.slice();
  const out = [];
  for (const p of pool) { const s = scorePaper(p, terms); if (s > 0) out.push([s, p]); }
  out.sort((a, b) => b[0] - a[0] || (b[1].year || 0) - (a[1].year || 0));
  return out.map(x => x[1]);
}

function applyFilters(pool) {
  const L = S.lib; let r = pool;
  if (L.type) r = r.filter(p => p.type === L.type);
  if (L.coll) r = r.filter(p => p.collections.some(c => c === L.coll || c.startsWith(L.coll + ' / ')));
  if (L.tag) r = r.filter(p => p.tags.includes(L.tag));
  if (L.year) {
    const [a, b] = L.year.split('-');
    r = r.filter(p => p.year >= +a && p.year <= +(b || a));
  }
  return r;
}

function sortPapers(pool) {
  const [key, dir] = S.lib.sort.split('_');
  const f = dir === 'desc' ? -1 : 1;
  const arr = pool.slice();
  const val = p => key === 'year' ? (p.year || 0) : key === 'title' ? norm(p.title) : key === 'author' ? norm(p.firstAuthor) : key === 'venue' ? norm(p.venue) : (p.dateAdded || '');
  arr.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * f; });
  return arr;
}

/* ---------------- 路由 ---------------- */
function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  const q = new URLSearchParams(qs || '');
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (!seg.length) return { view: 'dashboard' };
  if (seg[0] === 'papers') return { view: 'list', q: q.get('q') };
  if (seg[0] === 'paper') return { view: 'detail', arg: seg[1] };
  if (seg[0] === 'author') return { view: 'author', arg: seg.slice(1).join('/') };
  if (seg[0] === 'authors') return { view: 'authors' };
  if (seg[0] === 'venue') return { view: 'venue', arg: seg.slice(1).join('/') };
  if (seg[0] === 'venues') return { view: 'venues' };
  if (seg[0] === 'tag') return { view: 'tag', arg: seg.slice(1).join('/') };
  if (seg[0] === 'tags') return { view: 'tags' };
  return { view: 'dashboard' };
}

function navigate() {
  S.route = parseHash();
  S.charts.forEach(c => { try { c.dispose(); } catch (e) {} }); S.charts = [];
  const v = S.route.view;
  if (v === 'detail') renderDetail(S.route.arg);
  else if (v === 'list') { if (S.route.q !== null) { S.lib.q = S.route.q; $('#global-search').value = S.route.q; } renderLibrary(); }
  else if (v === 'author') renderAuthorPage(S.route.arg);
  else if (v === 'authors') renderAuthorsIndex();
  else if (v === 'venue') renderVenuePage(S.route.arg);
  else if (v === 'venues') renderVenuesIndex();
  else if (v === 'tag') renderTagPage(S.route.arg);
  else if (v === 'tags') renderTagsIndex();
  else renderDashboard();
  $$('.topnav a').forEach(a => a.classList.toggle('active', a.dataset.navlink === (v === 'dashboard' ? '#/' : v === 'list' ? '#/papers' : v === 'authors' ? '#/authors' : v === 'venues' ? '#/venues' : v === 'tags' ? '#/tags' : '')));
  window.scrollTo(0, 0);
}

/* ---------------- 通用组件 ---------------- */
function paperItemHTML(p, q) {
  const terms = q ? parseQuery(q).map(t => t.text).filter(t => t.length > 1) : [];
  let title = esc(p.title);
  for (const t of terms) title = title.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
  const auth = p.allAuthors.slice(0, 6).map(a => `<a href="#/author/${encodeURIComponent(a)}" data-stop>${esc(a)}</a>`).join(', ') + (p.allAuthors.length > 6 ? ' et al.' : '');
  const badges = [
    p.year ? `<span class="badge badge-year">${p.year}</span>` : '',
    `<span class="badge badge-type">${esc(typeName(p.type))}</span>`,
    p.venue ? `<span class="badge badge-type" title="${esc(p.venue)}">${esc(truncate(p.venue, 42))}</span>` : '',
    ...(p.collections || []).slice(0, 2).map(c => `<span class="badge badge-coll">📂 ${esc(c)}</span>`),
    ...p.tags.slice(0, 3).map(t => `<a class="badge badge-tag" href="#/tag/${encodeURIComponent(t)}" data-stop>#${esc(t)}</a>`),
    p.hasPDF ? `<span class="badge badge-pdf">📄 PDF</span>` : '',
    p.github.length ? `<span class="badge badge-gh">⭐ GitHub</span>` : '',
    p.doi ? `<span class="badge badge-doi">DOI</span>` : '',
  ].join('');
  const abs = p.abstract ? `<div class="paper-abs">${esc(truncate(p.abstract, 260))}</div>` : '';
  return `<article class="paper-item panel" data-goto="#/paper/${p.id}">
    <div class="paper-title">${title}</div>
    <div class="paper-meta"><span class="authors">${auth || '<span class="muted">无作者</span>'}</span></div>
    <div class="paper-badges">${badges}</div>${abs}</article>`;
}

function typeName(t) { return ({ journalArticle: '期刊论文', conferencePaper: '会议论文', preprint: '预印本', thesis: '学位论文', book: '图书', bookSection: '章节', webpage: '网页', report: '报告', computerProgram: '软件', blogPost: '博客', newspaperArticle: '新闻', document: '文档' })[t] || t; }
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function bindPaperItems(root) {
  $$('[data-goto]', root).forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-stop]')) return;
    location.hash = el.dataset.goto;
  }));
}

function makeChart(dom, opt) {
  if (typeof echarts === 'undefined') { dom.innerHTML = '<div class="empty-hint">图表库未加载（需要网络访问 CDN）</div>'; return null; }
  const c = echarts.init(dom, document.documentElement.dataset.theme === 'dark' ? 'dark' : null);
  c.setOption(opt); S.charts.push(c); return c;
}
const PALETTE = ['#3563e9', '#7c5cff', '#18a058', '#f0a020', '#d03050', '#0d82aa', '#8b5cf6', '#059669', '#dc2626', '#7c3aed'];

/* ---------------- 视图：概览 ---------------- */
function renderDashboard() {
  const P = S.papers, m = S.meta;
  const yearMap = new Map(); P.forEach(p => { if (p.year) yearMap.set(p.year, (yearMap.get(p.year) || 0) + 1); });
  const years = Array.from(yearMap.keys()).sort();
  const stat = (label, num) => `<div class="panel stat-card"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;

  $('#main').innerHTML = `
    <div class="stat-row">
      ${stat('文献总数', P.length)}${stat('有摘要', m.withAbstract)}${stat('有 DOI', m.withDOI)}
      ${stat('本地 PDF', m.withPDF)}${stat('含 GitHub 链接', m.withGithub)}
      ${stat('作者数', S.idx.authors.size)}${stat('标签数', S.idx.tags.size)}${stat('期刊/会议', S.idx.venues.size)}
    </div>
    <div class="dash-grid">
      <div class="panel panel-pad"><div class="section-title">📈 年度发文分布</div><div id="ch-years" class="chart-box"></div></div>
      <div class="panel panel-pad"><div class="section-title">🧩 文献类型</div><div id="ch-types" class="chart-box"></div></div>
    </div>
    <div class="dash-grid-2">
      <div class="panel panel-pad"><div class="section-title">👤 高产作者 TOP 15</div><div id="ch-authors" class="chart-box-sm"></div></div>
      <div class="panel panel-pad"><div class="section-title">🏷️ 高频标签 TOP 15</div><div id="ch-tags" class="chart-box-sm"></div></div>
      <div class="panel panel-pad"><div class="section-title">📂 收藏夹分布 TOP 10</div><div id="ch-colls" class="chart-box-sm"></div></div>
    </div>
    <div class="panel panel-pad" style="margin-top:16px"><div class="section-title">🕘 最近添加</div><div id="recent-list"></div>
      <div class="foot">Zotero Paper Hub · 数据生成于 ${esc(m.generated)} · 引用追溯 / 相似论文 / GitHub 匹配在详情页触发</div></div>`;

  makeChart($('#ch-years'), {
    color: PALETTE, grid: { left: 40, right: 16, top: 20, bottom: 28 },
    tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: years.map(String) },
    yAxis: { type: 'value' }, series: [{ type: 'bar', data: years.map(y => yearMap.get(y)), itemStyle: { borderRadius: [3, 3, 0, 0], color: '#3563e9' } }]
  });
  const typeEntries = Array.from(S.idx.types.entries()).map(([k, v]) => ({ name: typeName(k), value: v.length })).sort((a, b) => b.value - a.value);
  makeChart($('#ch-types'), { color: PALETTE, tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' }, series: [{ type: 'pie', radius: ['42%', '70%'], data: typeEntries, label: { fontSize: 12 } }] });
  const topAuthors = Array.from(S.idx.authors.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 15).reverse();
  makeChart($('#ch-authors'), { grid: { left: 130, right: 30, top: 10, bottom: 24 }, tooltip: {}, xAxis: { type: 'value' }, yAxis: { type: 'category', data: topAuthors.map(a => truncate(a[0], 22)) }, series: [{ type: 'bar', data: topAuthors.map(a => a[1].length), itemStyle: { color: '#7c5cff', borderRadius: [0, 3, 3, 0] } }] });
  const topTags = Array.from(S.idx.tags.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 15).reverse();
  makeChart($('#ch-tags'), { grid: { left: 130, right: 30, top: 10, bottom: 24 }, tooltip: {}, xAxis: { type: 'value' }, yAxis: { type: 'category', data: topTags.map(t => truncate(t[0], 22)) }, series: [{ type: 'bar', data: topTags.map(t => t[1].length), itemStyle: { color: '#18a058', borderRadius: [0, 3, 3, 0] } }] });
  const topColls = Array.from(S.idx.colls.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  makeChart($('#ch-colls'), { color: PALETTE, tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' }, series: [{ type: 'pie', radius: ['38%', '66%'], data: topColls.map(c => ({ name: c[0], value: c[1].length })), label: { fontSize: 11, formatter: '{b}' } }] });

  const recent = P.slice().sort((a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || '')).slice(0, 8);
  $('#recent-list').innerHTML = recent.map(p => paperItemHTML(p, '')).join('');
  bindPaperItems($('#recent-list'));
}

/* ---------------- 视图：文献库 ---------------- */
function facetList(map, cur, attr, limit) {
  const arr = Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, limit);
  return arr.map(([k, v]) => `<li class="${cur === k ? 'on' : ''}" data-${attr}="${esc(k)}"><span>${esc(truncate(k, 24))}</span><span class="cnt">${v.length}</span></li>`).join('');
}

function renderLibrary() {
  const L = S.lib;
  let pool = S.papers;
  if (L.q.trim()) pool = searchPapers(L.q, pool);
  pool = applyFilters(pool);
  const sorted = sortPapers(pool);
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / L.pageSize));
  if (L.page > pages) L.page = pages;
  const slice = sorted.slice((L.page - 1) * L.pageSize, L.page * L.pageSize);

  const yearBuckets = [['2025-2026', '2025+'], ['2020-2024', '2020s'], ['2015-2019', '2015–19'], ['2010-2014', '2010–14'], ['1987-2009', '2009 前']];
  $('#main').innerHTML = `
  <div class="lib-layout">
    <aside class="sidebar panel">
      <h4>文献类型</h4><ul class="facet-list" id="f-type">${facetList(S.idx.types, L.type, 'type', 12)}</ul>
      <h4>收藏夹分类</h4><ul class="facet-list" id="f-coll">${facetList(S.idx.colls, L.coll, 'coll', 30)}</ul>
      <h4>标签</h4><ul class="facet-list" id="f-tag">${facetList(S.idx.tags, L.tag, 'tag', 40)}</ul>
    </aside>
    <section>
      <div class="panel filter-bar">
        ${yearBuckets.map(([v, l]) => `<button class="chip ${L.year === v ? 'on' : ''}" data-year="${v}">${l}</button>`).join('')}
        <span style="flex:1"></span>
        <label class="small muted">排序</label>
        <select id="sel-sort">
          <option value="year_desc" ${L.sort === 'year_desc' ? 'selected' : ''}>年份 ↓</option>
          <option value="year_asc" ${L.sort === 'year_asc' ? 'selected' : ''}>年份 ↑</option>
          <option value="title_asc" ${L.sort === 'title_asc' ? 'selected' : ''}>标题 A→Z</option>
          <option value="title_desc" ${L.sort === 'title_desc' ? 'selected' : ''}>标题 Z→A</option>
          <option value="author_asc" ${L.sort === 'author_asc' ? 'selected' : ''}>第一作者</option>
          <option value="venue_asc" ${L.sort === 'venue_asc' ? 'selected' : ''}>期刊/会议</option>
          <option value="dateAdded_desc" ${L.sort === 'dateAdded_desc' ? 'selected' : ''}>入库时间 ↓</option>
        </select>
        <select id="sel-size">${[10, 20, 50, 100].map(n => `<option ${L.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <label class="small muted"><input type="checkbox" id="ck-abs" ${L.searchAbstract ? 'checked' : ''}> 摘要参与搜索</label>
      </div>
      <div class="small muted" style="margin:0 2px 8px">命中 <b>${total}</b> / ${S.papers.length} 篇${L.q ? ` · 查询: <b>${esc(L.q)}</b>` : ''}</div>
      <div id="paper-list">${slice.length ? slice.map(p => paperItemHTML(p, L.q)).join('') : '<div class="panel empty-hint">没有匹配的文献，试试减少筛选条件或更换关键词</div>'}</div>
      <div class="pager" id="pager"></div>
    </section>
  </div>`;

  bindPaperItems($('#paper-list'));
  $('#f-type').onclick = e => { const k = e.target.dataset.type; L.type = L.type === k ? '' : k; L.page = 1; renderLibrary(); };
  $('#f-coll').onclick = e => { const k = e.target.dataset.coll; L.coll = L.coll === k ? '' : k; L.page = 1; renderLibrary(); };
  $('#f-tag').onclick = e => { const k = e.target.dataset.tag; L.tag = L.tag === k ? '' : k; L.page = 1; renderLibrary(); };
  $$('.chip[data-year]').forEach(c => c.onclick = () => { L.year = L.year === c.dataset.year ? '' : c.dataset.year; L.page = 1; renderLibrary(); });
  $('#sel-sort').onchange = e => { L.sort = e.target.value; L.page = 1; renderLibrary(); };
  $('#sel-size').onchange = e => { L.pageSize = +e.target.value; L.page = 1; renderLibrary(); };
  $('#ck-abs').onchange = e => { S.lib.searchAbstract = e.target.checked; S.papers.forEach(p => p._searchBase = null); renderLibrary(); };
  renderPager(pages);
}

function renderPager(pages) {
  const L = S.lib, el = $('#pager'); if (!el) return;
  let nums = [];
  const win = 2;
  for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - L.page) <= win) nums.push(i);
  nums = nums.filter((v, i) => i === 0 || v - nums[i - 1] > 1 ? true : true);
  let html = `<button ${L.page === 1 ? 'disabled' : ''} data-pg="${L.page - 1}">‹</button>`;
  let prev = 0;
  for (const n of nums) { if (n - prev > 1) html += '<span class="ellipsis">…</span>'; html += `<button class="${n === L.page ? 'cur' : ''}" data-pg="${n}">${n}</button>`; prev = n; }
  html += `<button ${L.page === pages ? 'disabled' : ''} data-pg="${L.page + 1}">›</button>`;
  el.innerHTML = html;
  el.onclick = e => { const b = e.target.dataset.pg ? e.target : null; if (!b || b.disabled) return; L.page = +b.dataset.pg; renderLibrary(); window.scrollTo({ top: 0 }); };
}

/* ---------------- 视图：论文详情 ---------------- */
function renderDetail(id) {
  const p = S.idx.byId.get(id);
  if (!p) { $('#main').innerHTML = '<div class="panel empty-hint">未找到该文献</div>'; return; }
  const auth = p.allAuthors.map(a => `<a href="#/author/${encodeURIComponent(a)}">${esc(a)}</a>`).join(' · ');
  const ghRow = p.github.map(g => `<span class="badge badge-gh">⭐ <a href="${esc(g)}" target="_blank" style="color:inherit">${esc(g.replace('https://github.com/', ''))}</a></span>`).join(' ');
  $('#main').innerHTML = `
  <div class="panel detail-head">
    <div style="margin-bottom:6px"><a href="#/papers" class="small">← 返回文献库</a></div>
    <div class="detail-title">${esc(p.title)}</div>
    <div class="detail-meta">
      <span>👤 ${auth || '无作者'}</span>
      ${p.year ? `<span>📅 ${p.year}</span>` : ''}
      ${p.venue ? `<span>📰 <a href="#/venue/${encodeURIComponent(p.venue)}">${esc(p.venue)}</a></span>` : ''}
      <span>🧩 ${typeName(p.type)}</span>
      ${p.hasPDF ? '<span>📄 本地已有 PDF</span>' : ''}
    </div>
    <div class="paper-badges" style="margin-top:10px">
      ${p.tags.map(t => `<a class="badge badge-tag" href="#/tag/${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}
      ${p.collections.map(c => `<span class="badge badge-coll">📂 ${esc(c)}</span>`).join('')}
      ${ghRow}
    </div>
    <div class="detail-actions">
      <button class="btn" id="btn-oa-cited">📑 追溯：引用本文的文章</button>
      <button class="btn" id="btn-oa-sim">🔬 追溯：类似研究 (OpenAlex)</button>
      <button class="btn" id="btn-gh">⭐ 查询 GitHub 开源项目</button>
      ${p.firstAuthor ? `<a class="btn" href="#/author/${encodeURIComponent(p.firstAuthor)}">👤 按 ${esc(p.firstAuthor)} 追溯</a>` : ''}
      ${p.doi ? `<a class="btn" href="https://doi.org/${esc(p.doi)}" target="_blank">🔗 DOI</a>` : ''}
      ${p.url ? `<a class="btn" href="${esc(p.url)}" target="_blank">🔗 原文链接</a>` : ''}
    </div>
  </div>
  <div class="detail-grid">
    <div>
      ${p.abstract ? `<div class="panel abstract-box"><div class="section-title">摘要</div>${esc(p.abstract)}</div>` : '<div class="panel empty-hint">无摘要</div>'}
      <div class="panel ext-section">
        <div class="tabs">
          <button class="on" data-tab="local">🧠 本地相似论文</button>
          <button data-tab="oa-sim">🔬 类似研究</button>
          <button data-tab="oa-cited">📑 引用本文</button>
          <button data-tab="gh">⭐ GitHub</button>
        </div>
        <div id="tab-body"></div>
      </div>
    </div>
    <aside>
      <div class="panel"><dl class="kv">
        <dt>Zotero Key</dt><dd>${esc(p.id)}</dd>
        ${p.doi ? `<dt>DOI</dt><dd><a href="https://doi.org/${esc(p.doi)}" target="_blank">${esc(p.doi)}</a></dd>` : ''}
        ${p.date ? `<dt>日期</dt><dd>${esc(p.date)}</dd>` : ''}
        ${p.url ? `<dt>URL</dt><dd><a href="${esc(p.url)}" target="_blank">${esc(truncate(p.url, 60))}</a></dd>` : ''}
        <dt>入库时间</dt><dd>${esc(p.dateAdded || '')}</dd>
      </dl></div>
      <div class="panel panel-pad" style="margin-top:14px">
        <div class="section-title">📊 关键词</div>
        <div class="small muted" id="kw-cloud">${keywordExtract(p.title + ' ' + (p.abstract || ''), 20).map(w => `<span style="display:inline-block;margin:2px 6px 2px 0;color:var(--accent);cursor:pointer" data-kw="${esc(w)}">${esc(w)}</span>`).join('') || '—'}</div>
      </div>
      <div class="panel panel-pad" style="margin-top:14px">
        <div class="section-title">⭐ GitHub 匹配</div>
        <div id="gh-known" class="small">${p.github.length ? p.github.map(g => `<div>✅ <a href="${esc(g)}" target="_blank">${esc(g)}</a></div>`).join('') : '<span class="muted">元数据中未发现仓库链接</span>'}</div>
        <div class="github-token-row">
          <input id="gh-token" type="password" placeholder="GitHub Token (可选, 提升限额)" value="${esc(localStorage.getItem('gh_token') || '')}">
          <button class="btn" id="gh-token-save">保存</button>
        </div>
        <div class="small muted" id="gh-rate" style="margin-top:6px"></div>
      </div>
    </aside>
  </div>`;

  // tabs
  const body = $('#tab-body');
  const showTab = name => {
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'local') renderLocalSimilar(p, body);
    else if (name === 'oa-sim') renderOASimilar(p, body);
    else if (name === 'oa-cited') renderOACited(p, body);
    else renderGHDetail(p, body);
  };
  $$('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  showTab('local');

  $('#kw-cloud').onclick = e => { const k = e.target.dataset.kw; if (k) { S.lib.q = k; S.lib.page = 1; $('#global-search').value = k; location.hash = '#/papers?q=' + encodeURIComponent(k); } };
  $('#btn-oa-cited').onclick = () => { showTab('oa-cited'); $('.panel [data-tab="oa-cited"]').scrollIntoView({ behavior: 'smooth' }); };
  $('#btn-oa-sim').onclick = () => { showTab('oa-sim'); $('.panel [data-tab="oa-sim"]').scrollIntoView({ behavior: 'smooth' }); };
  $('#btn-gh').onclick = () => { showTab('gh'); $('.panel [data-tab="gh"]').scrollIntoView({ behavior: 'smooth' }); };
  $('#gh-token-save').onclick = () => { localStorage.setItem('gh_token', $('#gh-token').value.trim()); $('#gh-token-save').textContent = '已保存'; setTimeout(() => $('#gh-token-save').textContent = '保存', 1200); };
}

/* 本地相似：标题+摘要词袋余弦（同题重复副本只保留一条） */
function localSimilar(p, topN) {
  const vec = t => { const m = new Map(); for (const w of tokenize(t)) m.set(w, (m.get(w) || 0) + 1); return m; };
  const a = vec(p.title + ' ' + (p.abstract || ''));
  const magA = Math.hypot(...a.values()) || 1;
  const selfTitle = norm(p.title);
  const out = []; const seenTitles = new Set([selfTitle]);
  for (const q of S.papers) {
    if (q.id === p.id) continue;
    const qt = norm(q.title);
    if (seenTitles.has(qt)) continue;
    const b = vec(q.title + ' ' + (q.abstract || ''));
    if (!b.size) continue;
    let dot = 0; for (const [w, c] of a) if (b.has(w)) dot += c * b.get(w);
    if (!dot) continue;
    const magB = Math.hypot(...b.values()) || 1;
    const cos = dot / (magA * magB);
    const titleBonus = q.title.length > 10 && norm(p.title).split(/\s+/).filter(w => w.length > 3 && norm(q.title).includes(w)).length >= 2 ? 0.08 : 0;
    seenTitles.add(qt);
    out.push([cos + titleBonus, q]);
  }
  out.sort((x, y) => y[0] - x[0]);
  return out.slice(0, topN || 10);
}
function renderLocalSimilar(p, body) {
  body.innerHTML = '<div class="empty-hint"><span class="spin"></span> 正在计算相似度…</div>';
  setTimeout(() => {
    const sims = localSimilar(p, 10);
    body.innerHTML = sims.length ? `<ul class="ext-list">${sims.map(([s, q]) => `<li data-goto="#/paper/${q.id}" style="cursor:pointer">
      <div class="t">${esc(q.title)} <span class="badge badge-year" style="float:right">相似度 ${(s * 100).toFixed(0)}%</span></div>
      <div class="m">${esc(q.allAuthors.slice(0, 3).join(', '))} · ${q.year || ''} · ${esc(truncate(q.venue, 40))}</div></li>`).join('')}</ul>`
      : '<div class="empty-hint">未找到足够相似的论文</div>';
    bindPaperItems(body);
  }, 30);
}

/* OpenAlex: 解析 work */
async function oaResolve(p) {
  if (p.doi) {
    const r = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(p.doi)}`);
    if (r.ok) return await r.json();
  }
  const r = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(p.title)}&per-page=5&select=id,display_name,publication_year,cited_by_count,cited_by_api_url,authorships,doi,type`);
  if (!r.ok) throw new Error('OpenAlex 请求失败 ' + r.status);
  const d = await r.json();
  const nt = norm(p.title).replace(/[^a-z0-9 ]/g, '');
  let best = null, bestScore = 0;
  for (const w of d.results || []) {
    const nw = norm(w.display_name).replace(/[^a-z0-9 ]/g, '');
    const ta = nt.split(' '), ov = ta.filter(t => nw.includes(t)).length;
    const sc = ov / Math.max(ta.length, 1);
    if (sc > bestScore) { bestScore = sc; best = w; }
  }
  if (best && bestScore >= 0.5) return best;
  return null;
}

async function renderOASimilar(p, body) {
  body.innerHTML = '<div class="empty-hint"><span class="spin"></span> 正在通过 OpenAlex 检索类似研究…</div>';
  try {
    const r = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(p.title)}&per-page=12&select=id,display_name,publication_year,doi,cited_by_count,authorships,type`);
    const d = await r.json();
    const items = (d.results || []).filter(w => norm(w.display_name) !== norm(p.title)).slice(0, 10);
    body.innerHTML = items.length ? `<div class="small muted" style="padding:8px 14px 0">来源：OpenAlex · 按相关度排序</div><ul class="ext-list">${items.map(w => {
      const au = (w.authorships || []).slice(0, 3).map(a => a.author?.display_name).filter(Boolean).join(', ');
      const doi = w.doi ? w.doi.replace('https://doi.org/', '') : '';
      const inLib = doi && S.papers.some(x => norm(x.doi) === norm(doi));
      return `<li>${inLib ? `<span class="badge badge-pdf" style="float:right">已在库中</span>` : ''}
        <div class="t"><a href="${w.id}" target="_blank">${esc(w.display_name)}</a></div>
        <div class="m">${esc(au)} · ${w.publication_year || ''} · 被引 ${w.cited_by_count ?? 0} · ${esc(w.type || '')}</div></li>`;
    }).join('')}</ul>` : '<div class="empty-hint">OpenAlex 未找到类似研究</div>';
  } catch (e) { body.innerHTML = `<div class="empty-hint">检索失败（需要网络）: ${esc(e.message)}</div>`; }
}

async function renderOACited(p, body) {
  body.innerHTML = '<div class="empty-hint"><span class="spin"></span> 正在解析 OpenAlex 条目…</div>';
  try {
    const w = await oaResolve(p);
    if (!w) { body.innerHTML = '<div class="empty-hint">在 OpenAlex 中未找到该论文（可尝试补充 DOI）</div>'; return; }
    body.innerHTML = `<div class="small muted" style="padding:8px 14px 0">OpenAlex 记录：被引 <b>${w.cited_by_count}</b> 次 · 以下为前 25 篇引用者</div>
      <div id="citation-chart"></div><ul class="ext-list" id="cited-list"><li><span class="spin"></span> 加载中…</li></ul>`;
    const cr = await fetch(`${w.cited_by_api_url}&per-page=25`);
    if (!cr.ok) throw new Error('cited-by 请求失败 ' + cr.status);
    const cd = await cr.json();
    const items = cd.results || [];
    $('#cited-list').innerHTML = items.length ? items.map(c => {
      const au = (c.authorships || []).slice(0, 3).map(a => a.author?.display_name).filter(Boolean).join(', ');
      const doi = c.doi ? c.doi.replace('https://doi.org/', '') : '';
      const inLib = doi && S.papers.some(x => norm(x.doi) === norm(doi));
      return `<li>${inLib ? `<span class="badge badge-pdf" style="float:right">已在库中</span>` : ''}
        <div class="t"><a href="${c.id}" target="_blank">${esc(c.display_name)}</a></div>
        <div class="m">${esc(au)} · ${c.publication_year || ''} · 被引 ${c.cited_by_count ?? 0}</div></li>`;
    }).join('') : '<div class="empty-hint">暂无引用记录（或被引数为 0）</div>';
    // 引用网络图
    if (typeof echarts !== 'undefined' && items.length) {
      const nodes = [{ id: w.id, name: truncate(p.title, 40), symbolSize: 46, category: 0, label: { show: true } }];
      const links = [];
      items.forEach(c => { nodes.push({ id: c.id, name: truncate(c.display_name, 40), symbolSize: 16 + Math.min(24, Math.log2((c.cited_by_count || 0) + 1) * 5), category: 1 }); links.push({ source: c.id, target: w.id }); });
      makeChart($('#citation-chart'), {
        color: PALETTE,
        legend: { data: ['本文', '引用者'], bottom: 0 },
        tooltip: { formatter: x => x.data.name },
        series: [{ type: 'graph', layout: 'force', roam: true, draggable: true,
          categories: [{ name: '本文' }, { name: '引用者' }],
          force: { repulsion: 220, edgeLength: [70, 140], gravity: 0.08 },
          label: { fontSize: 10, color: 'inherit', overflow: 'truncate', width: 130 },
          data: nodes, links }]
      });
    }
  } catch (e) { body.innerHTML = `<div class="empty-hint">检索失败（需要网络）: ${esc(e.message)}</div>`; }
}

/* GitHub: 详情 tab + 实时搜索 */
async function ghFetch(url) {
  const headers = { Accept: 'application/vnd.github+json' };
  const tok = localStorage.getItem('gh_token');
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await fetch(url, { headers });
  S.ghRate.remaining = r.headers.get('x-ratelimit-remaining'); S.ghRate.limit = r.headers.get('x-ratelimit-limit');
  return r;
}
function ghKeywords(title) {
  return norm(title).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).slice(0, 8).join(' ');
}
async function renderGHDetail(p, body) {
  body.innerHTML = `<div class="small muted" style="padding:8px 14px 0">将按论文标题关键词实时搜索 GitHub 仓库（未登录限额 10 次/分钟）</div>
    <div style="padding:10px 14px"><button class="btn primary" id="gh-search-btn">🔍 搜索 GitHub</button></div>
    <ul class="ext-list" id="gh-result"><li class="muted small">点击搜索后展示候选开源项目…</li></ul>`;
  $('#gh-search-btn').onclick = async () => {
    const kw = ghKeywords(p.title);
    const list = $('#gh-result');
    list.innerHTML = `<li><span class="spin"></span> 正在搜索 “${esc(kw)}” …</li>`;
    try {
      const r = await ghFetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(kw)}&sort=stars&order=desc&per_page=8`);
      if (r.status === 403) { list.innerHTML = '<li class="notice warn">GitHub API 限额已用完，请在右侧输入 Token 后重试</li>'; return; }
      if (!r.ok) throw new Error('GitHub 请求失败 ' + r.status);
      const d = await r.json();
      list.innerHTML = (d.items || []).length ? d.items.map(it => `<li>
        <div class="t"><a href="${it.html_url}" target="_blank">${esc(it.full_name)}</a>
          <span class="badge badge-year" style="float:right">⭐ ${it.stargazers_count}</span></div>
        <div class="m">${esc(it.description || '')}</div>
        <div class="m">${esc(it.language || '')} · fork ${it.forks_count} · ${esc(it.updated_at || '').slice(0, 10)}</div></li>`).join('')
        : '<li class="empty-hint">未找到候选仓库（论文可能未开源）</li>';
    } catch (e) { list.innerHTML = `<li class="empty-hint">搜索失败: ${esc(e.message)}</li>`; }
  };
}

/* ---------------- 视图：作者 ---------------- */
function renderAuthorPage(name) {
  const list = S.idx.authors.get(name) || [];
  const co = new Map(); const yearMap = new Map(); const venues = new Map();
  list.forEach(p => {
    if (p.year) yearMap.set(p.year, (yearMap.get(p.year) || 0) + 1);
    if (p.venue) venues.set(p.venue, (venues.get(p.venue) || 0) + 1);
    p.allAuthors.forEach(a => { if (a !== name) co.set(a, (co.get(a) || 0) + 1); });
  });
  const years = Array.from(yearMap.keys()).sort();
  const sorted = list.slice().sort((a, b) => (b.year || 0) - (a.year || 0));
  $('#main').innerHTML = `
  <div class="panel page-head"><a href="#/authors" class="small">← 全部作者</a>
    <h2 style="margin-top:6px">👤 ${esc(name)}</h2>
    <div class="sub">共 ${list.length} 篇论文 · ${co.size} 位合作者 · ${venues.size} 个期刊/会议</div></div>
  <div class="two-col">
    <div class="panel panel-pad"><div class="section-title">📈 逐年发文</div><div id="au-years" class="chart-box-sm"></div></div>
    <div class="panel panel-pad"><div class="section-title">🤝 主要合作者 TOP 10</div>
      <ul class="rank-list">${Array.from(co.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c], i) => `<li><span class="rank-num">${i + 1}</span><span class="rank-name"><a href="#/author/${encodeURIComponent(n)}">${esc(n)}</a></span><span class="rank-count">${c} 篇合著</span></li>`).join('') || '<li class="muted">无合著记录</li>'}</ul></div>
  </div>
  <div class="panel panel-pad"><div class="section-title">📚 论文列表（${sorted.length}）</div>
    <div id="au-list"></div></div>`;
  makeChart($('#au-years'), { grid: { left: 36, right: 12, top: 16, bottom: 26 }, tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: years.map(String) }, yAxis: { type: 'value' }, series: [{ type: 'line', smooth: true, areaStyle: { opacity: 0.18 }, data: years.map(y => yearMap.get(y)), itemStyle: { color: '#3563e9' } }] });
  $('#au-list').innerHTML = sorted.map(p => paperItemHTML(p, '')).join(''); bindPaperItems($('#au-list'));
}

function renderAuthorsIndex() {
  const arr = Array.from(S.idx.authors.entries()).sort((a, b) => b[1].length - a[1].length);
  $('#main').innerHTML = `<div class="panel page-head"><h2>👤 作者索引（${arr.length}）</h2>
    <div class="sub">点击作者可追溯其全部论文、合作者与逐年发文趋势</div></div>
    <div class="panel"><ul class="ext-list" id="au-idx"></ul></div>`;
  const render = kw => {
    const f = kw ? arr.filter(([n]) => norm(n).includes(norm(kw))) : arr;
    $('#au-idx').innerHTML = f.slice(0, 300).map(([n, l]) => `<li><span class="rank-count" style="float:right">${l.length} 篇</span><a href="#/author/${encodeURIComponent(n)}">${esc(n)}</a></li>`).join('') + (f.length > 300 ? `<li class="muted small">… 还有 ${f.length - 300} 位，请用顶部搜索框过滤</li>` : '');
  };
  render('');
}

/* ---------------- 视图：期刊 / 标签 ---------------- */
function indexPage(title, sub, entries, link) {
  $('#main').innerHTML = `<div class="panel page-head"><h2>${title}</h2><div class="sub">${sub}</div></div>
    <div class="panel"><ul class="ext-list">${entries.map(([k, v]) => `<li><span class="rank-count" style="float:right">${v.length} 篇</span><a href="#/${link}/${encodeURIComponent(k)}">${esc(k || '(空)')}</a></li>`).join('')}</ul></div>`;
}
function renderVenuesIndex() { indexPage('📰 期刊 / 会议索引', `${S.idx.venues.size} 个来源`, Array.from(S.idx.venues.entries()).sort((a, b) => b[1].length - a[1].length), 'venue'); }
function renderTagsIndex() { indexPage('🏷️ 标签索引', `${S.idx.tags.size} 个标签`, Array.from(S.idx.tags.entries()).sort((a, b) => b[1].length - a[1].length), 'tag'); }

function simpleListPage(kind, name, list, backLink, backText, extraCharts) {
  const sorted = list.slice().sort((a, b) => (b.year || 0) - (a.year || 0));
  $('#main').innerHTML = `<div class="panel page-head"><a href="${backLink}" class="small">← ${backText}</a>
    <h2 style="margin-top:6px">${kind === 'venue' ? '📰' : '🏷️'} ${esc(name)}</h2>
    <div class="sub">共 ${list.length} 篇论文</div></div>
    ${extraCharts || ''}
    <div class="panel panel-pad" id="list-wrap"><div class="panel" style="box-shadow:none" id="simple-list"></div></div>`;
  $('#simple-list').innerHTML = sorted.map(p => paperItemHTML(p, '')).join(''); bindPaperItems($('#simple-list'));
}
function renderVenuePage(name) { simpleListPage('venue', name, S.idx.venues.get(name) || [], '#/venues', '全部期刊/会议'); }
function renderTagPage(name) { simpleListPage('tag', name, S.idx.tags.get(name) || [], '#/tags', '全部标签'); }

/* ---------------- 全局事件 ---------------- */
function initEvents() {
  const gs = $('#global-search');
  gs.addEventListener('keydown', e => { if (e.key === 'Enter') { S.lib.q = gs.value; S.lib.page = 1; location.hash = '#/papers?q=' + encodeURIComponent(gs.value); } });
  $('#search-btn').onclick = () => { S.lib.q = gs.value; S.lib.page = 1; location.hash = '#/papers?q=' + encodeURIComponent(gs.value); };
  $('#theme-toggle').onclick = () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? '' : 'dark';
    document.documentElement.dataset.theme = cur; localStorage.setItem('theme', cur); $('#theme-toggle').textContent = cur ? '☀️' : '🌙';
  };
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) { document.documentElement.dataset.theme = savedTheme; $('#theme-toggle').textContent = savedTheme === 'dark' ? '☀️' : '🌙'; }
  initEvents();
  try { await loadData(); } catch (e) { $('#loader-text').textContent = '加载失败: ' + e.message; $('#loader-text').style.color = '#d03050'; return; }
  window.addEventListener('hashchange', navigate);
  navigate();
  window.addEventListener('resize', debounce(() => S.charts.forEach(c => c && c.resize()), 200));
})();
