// ---- Today: Stickies tile (TODAY_TILES.stickies) ----
// Unstructured notes without a home yet: a stack of rotated square stickies to flip through
// (swipe, slider, ← →), a random one brought to the top on a rhythm, a detail panel to edit
// them and to turn one into a mail, event, card or note page. Data: /api/stickies (routes/stickies.js).

// Paper colours — same list as STICKY_COLORS in backend/routes/stickies.js
const _STK_COLORS = ['#fde68a', '#fdba74', '#f9a8d4', '#c4b5fd', '#93c5fd', '#86efac', '#5eead4', '#d1d5db'];
// Default categories — the list is editable (fullscreen packs: add / delete) and comes with GET /api/stickies
const _STK_DEFAULT_CATEGORIES = [
  { id: 'note',  label: 'Note' },
  { id: 'quote', label: 'Quote' },
  { id: 'intervention', label: 'Intervention' },
  { id: 'other', label: 'Other' },
];
let _stkCats = _STK_DEFAULT_CATEGORIES.map(c => ({ ...c }));
const _STK_BEHIND = 3;          // stickies visible behind the top one
const _STK_SAVE_MS = 600;

let _stkItems = [];             // newest first, as the server sends them
let _stkDrag = null;            // swipe in progress: re-renders wait for it
let _stkPendingRender = false;
let _stkEdit = null;            // detail panel: { id, text, source, color, category, created, updated, timer, chain }
let _stkAngles = null;          // rotation per stack slot: [top, 1st behind, 2nd, 3rd] — shifted on every flip
let _stkFs = false;             // fullscreen: the tile covers the screen — grid of all stickies (small screens: the stack)
let _stkGridTilts = [];         // fullscreen grid: random tilt per position (_stkGridAngles), kept for the session
let _stkQuery = '';             // fullscreen grid: keyword filter (text + source)

// ---- Pure helpers ----

/**
 * A new rotation (±1.5° … ±6°, one decimal) at least 1.5° away from each of `others`, leaning the
 * other way than `neighbour` (the paper next to it in the stack) when given. Pure.
 */
function _stkNewAngle(others = [], neighbour = null, rnd = Math.random) {
  let a = 0;
  for (let i = 0; i < 20; i++) {
    const mag  = 1.5 + rnd() * 4.5;
    const sign = neighbour != null ? -Math.sign(neighbour) || 1 : (rnd() < 0.5 ? -1 : 1);
    a = Math.round(sign * mag * 10) / 10;
    if (others.every(o => Math.abs(o - a) >= 1.5)) break;
  }
  return a;
}

/**
 * Stack slot angles after flipping `step` stickies: forward = the papers move up one slot keeping
 * their angle and the new last one gets a fresh angle; backward = the new top gets a fresh one. Pure.
 */
function _stkShiftAngles(angles, step, slots = 4, rnd = Math.random) {
  let out = angles?.length ? angles.slice(0, slots) : [];
  if (!out.length) {
    for (let i = 0; i < slots; i++) out.push(_stkNewAngle(out, out[i - 1] ?? null, rnd));
    return out;
  }
  while (out.length < slots) out.push(_stkNewAngle(out, out.at(-1), rnd));
  const n = Math.min(Math.abs(step), slots);
  for (let i = 0; i < n; i++) {
    if (step > 0) {
      const rest = out.slice(1);
      out = [...rest, _stkNewAngle(rest, rest.at(-1), rnd)];
    } else {
      const rest = out.slice(0, slots - 1);
      out = [_stkNewAngle(rest, rest[0], rnd), ...rest];
    }
  }
  return out;
}

/** Source text → HTML: http(s) URLs as links (shown without the scheme), the rest escaped. */
function _stkLinkify(text) {
  const src = String(text || '');
  let out = '', last = 0;
  for (const m of src.matchAll(/\bhttps?:\/\/[^\s<>"]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    const safe = safeLink(url);
    out += escHtml(src.slice(last, m.index));
    out += safe
      ? `<a href="${escHtml(safe)}" target="_blank" rel="noopener noreferrer" title="${escHtml(url)}">${escHtml(url.replace(/^https?:\/\/(www\.)?/i, ''))}</a>`
      : escHtml(url);
    last = m.index + url.length;
  }
  return out + escHtml(src.slice(last));
}

/** Is a random sticky due? rhythm in minutes (0 = only on request), at = last pick (ms). Pure. */
function _stkDue(rhythm, at, now) {
  return rhythm > 0 && (!at || now - at >= rhythm * 60000);
}

/** Id of a random sticky other than the current one (the only one when there is just one). Pure. */
function _stkPickRandom(items, currentId, rnd = Math.random) {
  if (!items.length) return null;
  const pool = items.length > 1 ? items.filter(i => i.id !== currentId) : items;
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))].id;
}

/**
 * Title + body for a conversion: title = first line (≤ 120 chars, cut at a word + …), body = the
 * whole text — empty when the title already says everything. Pure.
 */
function _stkSplit(text) {
  const full  = String(text || '').trim();
  const first = full.split('\n')[0].trim();
  let title = first;
  if (first.length > 120) {
    const cut = first.slice(0, 120);
    const sp  = cut.lastIndexOf(' ');
    title = `${(sp > 60 ? cut.slice(0, sp) : cut).trimEnd()}…`;
  }
  return { title, body: full === title ? '' : full };
}

/**
 * Markdown for card / note descriptions: quotes become a blockquote, the source follows
 * ("— source" inside the quote, else "Source: …"); with a source the text is always included. Pure.
 */
function _stkMarkdown(sticky, body) {
  const src  = String(sticky.source || '').trim();
  const text = body || (src ? String(sticky.text || '').trim() : '');
  if (!text) return '';
  const quote = sticky.category === 'quote';
  const md = quote ? text.split('\n').map(l => `> ${l}`).join('\n') : text;
  return !src ? md : quote ? `${md}\n>\n> \u2014 ${src}` : `${md}\n\nSource: ${src}`;
}

/** Plain text for mail / event bodies: text plus "— source". Pure. */
function _stkPlain(sticky, body) {
  const src  = String(sticky.source || '').trim();
  const text = body || (src ? String(sticky.text || '').trim() : '');
  return src ? `${text}\n\n\u2014 ${src}` : text;
}

/** Stickies of one category ('all' = every one), order kept. Pure. */
function _stkFilter(items, cat) {
  return cat === 'all' ? items : items.filter(s => (s.category || 'note') === cat);
}

/** Count per category plus `all`: { all, note, quote, intervention, other }. Pure. */
function _stkCounts(items) {
  const out = { all: items.length };
  for (const c of _stkCats) out[c.id] = 0;
  for (const s of items) { const c = s.category || 'note'; if (c in out) out[c]++; }
  return out;
}

/**
 * Sort key — same rule as stickyOrderKey in backend/global-db.js: `pos` once the sticky was dragged
 * to a place in the grid, else minus its creation time (newest first). Pure.
 */
function _stkOrderKey(s) {
  return Number.isFinite(s.pos) ? s.pos : -(Date.parse(s.created) || 0);
}

/** Stickies in their order (ties: newest first). Pure, returns a new array. */
function _stkSort(items) {
  return [...items].sort((a, b) => _stkOrderKey(a) - _stkOrderKey(b) || String(b.created || '').localeCompare(String(a.created || '')));
}

/** Sort key for a sticky dropped between two neighbours (null = no neighbour on that side). Pure. */
function _stkPosBetween(prev, next) {
  if (prev == null && next == null) return 0;
  if (prev == null) return next - 1;
  if (next == null) return prev + 1;
  return (prev + next) / 2;
}

/**
 * Grid tilts per position: `angles` extended to `n` entries, each new one random (±1.5–6°, either
 * direction, ≥ 1.5° away from its left neighbour). Existing positions keep theirs, so refreshes don't
 * make the grid jump. Pure apart from `rnd`; returns a new array.
 */
function _stkGridAngles(angles, n, rnd = Math.random) {
  const out = (angles || []).slice();
  while (out.length < n) out.push(_stkNewAngle(out.length ? [out.at(-1)] : [], null, rnd));
  return out;
}

/**
 * Sticky text → HTML: escaped, then **bold**, *italic* / _italic_, __underline__, ~~strike~~ (within
 * one line) and {-} as a hyphenation point (soft hyphen — the word may break there). Pure.
 */
function _stkFormat(text) {
  return escHtml(String(text || ''))
    .replace(/\{-\}/g, '\u00ad')
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([^\n]*?\S)__/g, '<u>$1</u>')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?!\w)/g, '$1<em>$2</em>');
}

/** Keyword filter: every word in text or source, case- and accent-insensitive. Pure. */
function _stkMatches(sticky, query) {
  const fold = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const hay = fold(`${sticky.text}\n${sticky.source || ''}`);
  return fold(query).split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

/** Plain text of a sticky for conversions: markers kept (Markdown), hyphenation points dropped. Pure. */
function _stkStripHyphens(text) {
  return String(text || '').replace(/\{-\}/g, '');
}

function _stkCategoryLabel(id) {
  return _stkCats.find(c => c.id === id)?.label || id || 'Note';
}

// ---- Position / random pick (per browser) ----

function _stkLs(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch { /* ignore */ }
  return null;
}

function _stkCurrentId() { return _stkLs('today-stickies-pos'); }
function _stkSetCurrent(id) { if (id) _stkLs('today-stickies-pos', id); }

function _stkRandomAt() {
  try { return JSON.parse(_stkLs('today-stickies-random') || '{}').at || 0; } catch { return 0; }
}

function _stkRhythm() {
  const r = _todayCfg?.widgets?.stickies?.rhythm;
  return Number.isInteger(r) ? r : 0;
}

/**
 * Category filter: 'all' or a category id — saved in the Today config (`widgets.stickies.filter`),
 * so the last selection is the same on all devices; the older per-browser choice is the fallback.
 */
function _stkFilterCat() {
  const v = _todayCfg?.widgets?.stickies?.filter ?? _stkLs('today-stickies-filter');
  return _stkCats.some(c => c.id === v) ? v : 'all';
}

/** The stickies the stack / grid shows: those of the filtered category; the grid also by keyword. */
function _stkVisible() {
  const list = _stkFilter(_stkItems, _stkFilterCat());
  return _stkGridMode() && _stkQuery.trim() ? list.filter(st => _stkMatches(st, _stkQuery)) : list;
}

/** Categories from the server: [{ id, label }] (older servers: ids only). */
function _stkSetCats(list) {
  if (!Array.isArray(list) || !list.length) return;
  _stkCats = list.map(c => (typeof c === 'string' ? { id: c, label: c.charAt(0).toUpperCase() + c.slice(1) } : { id: c.id, label: c.label || c.id }));
}

/** Default category of a new sticky: "note" while it exists, else the first one. */
function _stkDefaultCat() {
  return _stkCats.some(c => c.id === 'note') ? 'note' : _stkCats[0]?.id || 'note';
}

// Filter saves run one after another; only the last response may replace the config
let _stkFilterSave = Promise.resolve(), _stkFilterSeq = 0;

function _stkSetFilter(cat) {
  const widgets = { ...(_todayCfg?.widgets || {}) };
  widgets.stickies = { ...(widgets.stickies || {}), filter: cat };
  _todayCfg = { ...(_todayCfg || {}), widgets };
  _stkAngles = _stkShiftAngles(_stkAngles, 1, _STK_BEHIND + 1);   // a new stack: fresh angle on top of it
  _stkRerender();
  const seq = ++_stkFilterSeq;
  _stkFilterSave = _stkFilterSave.then(async () => {
    if (seq !== _stkFilterSeq) return;   // a newer choice follows and saves the whole widgets object
    try {
      const res  = await fetch('/api/today/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ widgets: _todayCfg.widgets }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (seq === _stkFilterSeq) _todayCfg = data.config;
    } catch (err) {
      showMessage(`Could not save the sticky filter: ${err.message}`);
    }
  });
}

/** Index of the current sticky among the visible ones (falls back to the newest). */
function _stkIndex() {
  const i = _stkVisible().findIndex(s => s.id === _stkCurrentId());
  return i < 0 ? 0 : i;
}

// ---- Tile ----

function _stkBody() {
  return document.querySelector('.today-tile[data-tile="stickies"] .today-tile-body');
}

function _stkRerender() {
  const body = _stkBody();
  if (body) _stkRender(body, { items: _stkItems }, body.closest('.today-tile'), { random: false });
}

function _stkPaperHtml(s, cls, tilt, extra = '') {
  const src = String(s.source || '').trim();
  return `<div class="today-stk-paper ${cls}" data-stk-id="${escHtml(s.id)}" style="--stk-color:${escHtml(s.color || _STK_COLORS[0])};--stk-tilt:${tilt}deg"${extra}>
      <div class="today-stk-textbox"><div class="today-stk-text${s.category === 'quote' ? ' today-stk-text--quote' : ''}">${_stkFormat(s.text)}</div></div>
      <div class="today-stk-foot"><span class="today-stk-cat">${escHtml(_stkCategoryLabel(s.category))}</span>${
        src ? `<span class="today-stk-src" title="${escHtml(src)}">${_stkLinkify(src)}</span>` : ''}</div>
    </div>`;
}

// render(body, data, el) — `random: false` for re-renders after local changes (no random pick)
function _stkRender(body, data, el, opts) {
  _stkRenderBody(body, data, el, opts);
  _stkSyncDiceFab(body);
}

/**
 * Fullscreen on small screens: the stack centred on the screen (`today-stk-body--phonefs`) and the dice
 * as a big round button in the lower right corner (the header drops dice and settings there).
 */
function _stkSyncDiceFab(body) {
  const on = _stkPhoneFs();
  body.classList.toggle('today-stk-body--phonefs', on);
  let fab = body.querySelector(':scope > .today-stk-dice-fab');
  if (!on || _stkVisible().length < 2) { fab?.remove(); return; }
  if (!fab) {
    body.insertAdjacentHTML('beforeend', `<button type="button" class="today-stk-dice-fab" data-stk-dice="1" title="Random sticky" aria-label="Random sticky">${SVGICONS.dice(28, 28)}</button>`);
  }
}

function _stkRenderBody(body, data, el, { random = true } = {}) {
  _stkItems = _stkSort(data?.items || []);
  _stkSetCats(data?.categories);
  if (el) _todaySetCount(el, _stkItems.length);
  if (_stkDrag) { _stkPendingRender = true; return; }
  _stkPendingRender = false;
  if (random && _stkVisible().length > 1 && _stkDue(_stkRhythm(), _stkRandomAt(), Date.now())) {
    _stkSetCurrent(_stkPickRandom(_stkVisible(), _stkCurrentId()));
    _stkLs('today-stickies-random', JSON.stringify({ at: Date.now() }));
  }
  if (!body._stkWired) { body._stkWired = true; _stkWire(body); }

  body.classList.toggle('today-stk-body--grid', _stkGridMode());
  if (!_stkItems.length && !_stkGridMode()) {
    body.innerHTML = '<p class="dashboard-empty today-stk-empty">No stickies yet. <a href="#" data-stk-new="1">Add one</a> for a thought that has no home yet.</p>';
    return;
  }
  // Category filter above the stack: All + one chip per category with its count
  if (!body.querySelector('.today-stk-filter')) {
    // Head: category chips (+ the keyword field in the fullscreen grid), then the stack / grid
    body.innerHTML = `<div class="today-stk-head today-stk-filter-wrap">
        <div class="today-stk-filter" role="radiogroup" aria-label="Category" data-hscroll></div>
        <input type="search" class="today-stk-q new-board-input" placeholder="Filter by keyword" aria-label="Filter stickies by keyword" autocomplete="off">
      </div><div class="today-stk-host"></div>`;
    // One line: scrolls sideways without a scrollbar, ‹ › only where chips are cut off
    _todayHScroll(body.querySelector('.today-stk-filter'));
  }
  const q = body.querySelector('.today-stk-q');
  if (q && document.activeElement !== q) q.value = _stkQuery;
  const cat = _stkFilterCat(), counts = _stkCounts(_stkItems);
  // Categories without stickies are left out (the selected one stays, so the filter is visible)
  const filter = body.querySelector('.today-stk-filter');
  filter.innerHTML = [{ id: 'all', label: 'All' }, ..._stkCats]
    .filter(c => c.id === 'all' || c.id === cat || counts[c.id]).map(c =>
    `<button type="button" class="today-stk-chip" role="radio" aria-checked="${c.id === cat}" data-stk-filter="${c.id}">${escHtml(c.label)}<span class="today-stk-chip-n">${counts[c.id]}</span></button>`).join('');
  _stkChipIntoView(filter);
  const host = body.querySelector('.today-stk-host');
  const vis  = _stkVisible();
  if (_stkGridMode()) { _stkRenderGrid(host, vis); return; }
  if (!vis.length) {
    host.innerHTML = `<p class="dashboard-empty today-stk-empty">No ${escHtml(_stkCategoryLabel(cat).toLowerCase())} stickies. <a href="#" data-stk-new="1">Add one</a></p>`;
    return;
  }
  const n = vis.length;
  // The frame (stack + slider) is kept while the count stays the same, so a slider being dragged
  // and the keyboard focus survive flipping and refreshes
  let box = host.querySelector('.today-stk');
  if (!box || Number(box.dataset.n) !== n) {
    host.innerHTML = `<div class="today-stk" tabindex="0" data-n="${n}" aria-label="Stickies — ← → to flip, Enter to open">
        <div class="today-stk-stack"></div>
        ${n > 1 ? `<div class="today-stk-nav">
          <input type="range" class="today-stk-slider" min="1" max="${n}" value="1">
          <span class="today-stk-pos"></span>
        </div>` : ''}
      </div>`;
    box = host.querySelector('.today-stk');
  }
  const idx = _stkIndex();
  _stkSetCurrent(vis[idx].id);
  if (!_stkAngles) _stkAngles = _stkShiftAngles(null, 0, _STK_BEHIND + 1);
  const behind = [];
  for (let k = 1; k <= Math.min(_STK_BEHIND, n - 1); k++) behind.push([vis[(idx + k) % n], _stkAngles[k]]);
  box.querySelector('.today-stk-stack').innerHTML =
    behind.reverse().map(([s, a]) => _stkPaperHtml(s, 'today-stk-paper--back', a, ' aria-hidden="true"')).join('') +
    _stkPaperHtml(vis[idx], 'today-stk-paper--top', _stkAngles[0], ` title="${_todaySmall() ? 'Tap' : 'Double-click'} to open" role="button"`);
  const slider = box.querySelector('.today-stk-slider');
  if (slider) {
    slider.value = String(idx + 1);
    slider.setAttribute('aria-label', `Sticky ${idx + 1} of ${n}`);
    box.querySelector('.today-stk-pos').textContent = `${idx + 1} / ${n}`;
  }
  _stkLayout(body);
}

/** Fullscreen on larger screens shows the grid; small screens keep the stack, just full-screen. */
function _stkGridMode() { return _stkFs && !_todaySmall(); }
function _stkPhoneFs()  { return _stkFs && _todaySmall(); }

/**
 * Fullscreen on larger screens: the (filtered) stickies as a grid above — in their order, each position
 * with its own random tilt — and one pack per category in the lower 280 px (sticky at the bottom of the
 * scrolling body): click = filter, drop a sticky = move it there, + adds a category, × deletes one.
 */
function _stkRenderGrid(host, vis) {
  let frame = host.querySelector('.today-stk-fs');
  if (!frame) {
    host.innerHTML = `<div class="today-stk-fs">
        <div class="today-stk-gridbox"></div>
        <div class="today-stk-packs">
          <div class="today-stk-packs-row" role="list" aria-label="Categories — click to filter, drop a sticky to move it"></div>
          <button type="button" class="today-tile-btn today-stk-packs-settings" data-stk-settings="1" title="Stickies settings (random rhythm, export / import)" aria-label="Stickies settings">${SVGICONS.settings(14, 14)}</button>
        </div>
      </div>`;
    frame = host.querySelector('.today-stk-fs');
  }
  _stkGridTilts = _stkGridAngles(_stkGridTilts, vis.length);
  const cat = _stkFilterCat();
  frame.querySelector('.today-stk-gridbox').innerHTML = vis.length
    ? `<div class="today-stk-grid" role="list" aria-label="Stickies — click to open, drag to move or onto a category">${vis.map((s, i) =>
      `<div class="today-stk-cell" role="listitem" tabindex="0" data-stk-id="${escHtml(s.id)}" title="Click to open, drag to move">${
        _stkPaperHtml(s, 'today-stk-paper--grid', _stkGridTilts[i])}</div>`).join('')}</div>`
    : `<p class="dashboard-empty today-stk-empty">${_stkQuery.trim() ? 'No stickies match.' : cat === 'all' ? 'No stickies yet.' : `No ${escHtml(_stkCategoryLabel(cat).toLowerCase())} stickies.`} <a href="#" data-stk-new="1">Add one</a></p>`;
  // Packs: kept while a new category is being typed
  const packs = frame.querySelector('.today-stk-packs-row');
  if (!packs.contains(document.activeElement) || !document.activeElement.classList.contains('today-stk-pack-input')) packs.innerHTML = _stkPacksHtml();
  host.querySelectorAll('.today-stk-textbox').forEach(_stkFitText);
}

const _STK_PACK_TILTS = [-5, 3.5, -1.5];   // back → top

function _stkPacksHtml() {
  const cat = _stkFilterCat();
  const counts = _stkCounts(_stkItems);
  const one = _stkCats.length <= 1;
  return _stkCats.map(c => {
    const list = _stkItems.filter(st => (st.category || 'note') === c.id).slice(0, 3).reverse();
    const papers = list.map((st, i) => _stkPaperHtml(st, 'today-stk-paper--pack', _STK_PACK_TILTS[i + 3 - list.length], ' aria-hidden="true"')).join('');
    return `<div class="today-stk-pack${c.id === cat ? ' today-stk-pack--on' : ''}" role="listitem" tabindex="0" data-stk-pack="${escHtml(c.id)}"
        title="${escHtml(c.label)} — click to show only these, drop a sticky here to move it" aria-pressed="${c.id === cat}">
        <div class="today-stk-pack-stack">${papers || '<div class="today-stk-pack-empty"></div>'}</div>
        <div class="today-stk-pack-foot"><span class="today-stk-pack-name">${escHtml(c.label)}</span><span class="today-stk-pack-n">${counts[c.id] || 0}</span>${
          one ? '' : `<button type="button" class="today-tile-btn today-stk-pack-del" data-stk-cat-del="${escHtml(c.id)}" title="Delete the category ${escHtml(c.label)}" aria-label="Delete the category ${escHtml(c.label)}">${SVGICONS.delete(12, 12)}</button>`}</div>
      </div>`;
  }).join('') + `<div class="today-stk-pack today-stk-pack--add">
      <button type="button" class="today-stk-pack-addbtn" data-stk-cat-add="1" title="Add a category">${SVGICONS.create(22, 22)}<span>Category</span></button>
      <div class="today-stk-pack-foot" aria-hidden="true">&nbsp;</div>
    </div>`;
}

/** Inline name field in the "+" pack; Enter creates the category, Escape / leaving cancels. */
function _stkStartAddCat(btn) {
  const box = btn.closest('.today-stk-pack--add');
  box.innerHTML = '<input type="text" class="new-board-input today-stk-pack-input" maxlength="40" placeholder="New category" aria-label="Name of the new category">';
  const input = box.querySelector('input');
  input.focus();
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const label = input.value.trim();
    if (save && label) {
      try {
        const data = await _stkJson(`${_stkApi()}/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
        _stkSetCats(data.categories);
      } catch (err) { showMessage(`Could not add the category: ${err.message}`); }
    }
    input.blur();
    _stkRerender();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/** Delete a category after confirming; its stickies move to the first remaining one. */
async function _stkDeleteCat(id) {
  const c = _stkCats.find(x => x.id === id);
  const rest = _stkCats.filter(x => x.id !== id);
  if (!c || !rest.length) return;
  const n = _stkItems.filter(st => (st.category || 'note') === id).length;
  const msg = `Delete the category "${c.label}"?${n ? ` Its ${n} stick${n === 1 ? 'y moves' : 'ies move'} to "${rest[0].label}".` : ''}`;
  if (!(await showConfirm(msg, { okLabel: 'Delete', danger: true }))) return;
  try {
    const data = await _stkJson(`${_stkApi()}/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    _stkSetCats(data.categories);
    _stkItems = _stkItems.map(st => ((st.category || 'note') === id ? { ...st, category: data.to } : st));
    if (_stkFilterCat() === 'all' && _todayCfg?.widgets?.stickies?.filter === id) _stkSetFilter('all');
    else _stkRerender();
  } catch (err) { showMessage(`Could not delete the category: ${err.message}`); }
}

/** A sticky dropped on a pack: it moves to that category (keeps its place in the order). */
function _stkMoveToCategory(id, cat) {
  const st = _stkItems.find(x => x.id === id);
  if (!st || (st.category || 'note') === cat) { _stkRerender(); return; }
  _stkItems = _stkItems.map(x => (x.id === id ? { ...x, category: cat } : x));
  _stkRerender();
  _stkJson(_stkApi(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: cat }) })
    .then(({ item }) => _stkUpsertLocal(item))
    .catch(err => { showMessage(`Could not move the sticky: ${err.message}`); _stkReload(); });
}

/** Reload the tile from the server (the per-refresh fetch cache would hand back the old list). */
function _stkReload() {
  _todayFetchMemo?.delete(_stkApi());
  _todayLoadTile('stickies');
}

// ---- Markdown export / import (Settings → Dashboard → Stickies) ----

async function _stkExportMd() {
  const res = await fetch(`${_stkApi()}/export`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'stickies.md';
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** Import a Markdown file (merged: known ids updated, the rest added) → the server's counts. */
async function _stkImportMd(file) {
  const data = await _stkJson(`${_stkApi()}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: await file.text() }) });
  _stkSetCats(data.categories);
  if (typeof _todayLoadTile === 'function' && document.querySelector('.today-tile[data-tile="stickies"]')) _stkReload();
  return data;
}

/** Fullscreen on / off: the tile covers the screen (today.css .today-tile--fs); Escape leaves it. */
function _stkSetFs(on) {
  const tile = document.querySelector('.today-tile[data-tile="stickies"]');
  if (!tile) return;
  _stkFs = on;
  tile.classList.toggle('today-tile--fs', on);
  if (on) document.addEventListener('keydown', _stkFsKey, true);
  else document.removeEventListener('keydown', _stkFsKey, true);
  _todaySetTileActions('stickies');
  _stkRerender();
  _todayScheduleFit();
}

// Capture phase: runs before a dialog's own Escape handler, so an open dialog / detail panel closes first
function _stkFsKey(e) {
  if (e.key !== 'Escape' || !_stkFs) return;
  if (e.target.classList?.contains('today-stk-q') && e.target.value) return;   // the keyword field clears itself first
  if ([...document.querySelectorAll('.modal-backdrop, .mv-picker')].some(el => el.getClientRects().length)) return;
  e.preventDefault();
  _stkSetFs(false);
}

/** Grid drag: move the cell to the place under the pointer (neighbours slide over), follow the pointer. */
function _stkGridDragMove(body, g, x, y) {
  const cell = g.cell, grid = cell.parentElement;
  // Over a category pack (fullscreen, lower part): drop target — no reordering meanwhile
  const packs = body.querySelector('.today-stk-packs');
  const packsTop = packs ? packs.getBoundingClientRect().top : Infinity;
  const pack = y >= packsTop ? [...packs.querySelectorAll('[data-stk-pack]')].find(p => {
    const r = p.getBoundingClientRect();
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  }) : null;
  g.pack = pack?.dataset.stkPack || null;
  packs?.querySelectorAll('[data-stk-pack]').forEach(p => p.classList.toggle('today-stk-pack--drop', p === pack));
  // Layout boxes (offsets ignore transforms): neighbours still gliding must not be hit at their old place
  const gr = grid.getBoundingClientRect();
  const boxOf = c => ({ left: gr.left + c.offsetLeft - grid.offsetLeft, top: gr.top + c.offsetTop - grid.offsetTop });
  const over = [...grid.children].find(c => {
    if (c === cell) return false;
    const b = boxOf(c);
    return x >= b.left && x < b.left + c.offsetWidth && y >= b.top && y < b.top + c.offsetHeight;
  });
  if (over && y < packsTop) {
    const cells = [...grid.children];
    const before = new Map(cells.map(c => [c, c.getBoundingClientRect()]));
    grid.insertBefore(cell, cells.indexOf(over) < cells.indexOf(cell) ? over : over.nextSibling);
    for (const c of cells) {   // FLIP: the others glide to their new place
      if (c === cell) continue;
      const a = before.get(c), b = c.getBoundingClientRect();
      if (a.left !== b.left || a.top !== b.top) c.animate?.([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' });
    }
  }
  // Layout position (without the own shift) + pointer − grab offset
  const r = boxOf(cell);
  g.tx = x - g.offX - r.left;
  g.ty = y - g.offY - r.top;
  cell.style.setProperty('--stk-gx', `${g.tx}px`);
  cell.style.setProperty('--stk-gy', `${g.ty}px`);
  const br = body.getBoundingClientRect();   // near the top / bottom edge (above the packs): scroll along
  const bottom = Math.min(br.bottom, packsTop);
  if (y < br.top + 50) body.scrollBy(0, -14);
  else if (y > bottom - 50 && y < bottom) body.scrollBy(0, 14);
}

/** Dropped: the sticky gets a sort key between its new neighbours, saved as `pos`. */
function _stkGridDropped(cell) {
  const ids = [...cell.parentElement.children].map(c => c.dataset.stkId);
  const id  = cell.dataset.stkId, i = ids.indexOf(id);
  if (_stkVisible().map(s => s.id).join() === ids.join()) { _stkRerender(); return; }   // back at its place
  const byId = new Map(_stkItems.map(s => [s.id, s]));
  const prev = byId.get(ids[i - 1]), next = byId.get(ids[i + 1]);
  const pos  = _stkPosBetween(prev ? _stkOrderKey(prev) : null, next ? _stkOrderKey(next) : null);
  _stkItems = _stkSort(_stkItems.map(s => (s.id === id ? { ...s, pos } : s)));
  _stkRerender();
  _stkJson(_stkApi(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pos }) })
    .then(({ item }) => _stkUpsertLocal(item))
    .catch(err => { showMessage(`Could not move the sticky: ${err.message}`); _stkReload(); });
}

/** Keeps the selected chip inside the scrolled row and lets _todayHScroll update its ‹ › buttons. */
function _stkChipIntoView(filter) {
  const on = filter.querySelector('[aria-checked="true"]');
  if (on && filter.scrollWidth > filter.clientWidth) {
    const l = on.offsetLeft - filter.offsetLeft, r = l + on.offsetWidth;
    if (l < filter.scrollLeft) filter.scrollLeft = Math.max(0, l - 24);
    else if (r > filter.scrollLeft + filter.clientWidth) filter.scrollLeft = r - filter.clientWidth + 24;
  }
  filter.dispatchEvent(new Event('scroll'));
}

/** Height incl. vertical margins (0 without the element). */
function _stkOuterH(el) {
  if (!el) return 0;
  const cs = getComputedStyle(el);
  return el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
}

// Room the rotated papers need around the square (≤ 6° tilt ≈ 5 % per side)
const _STK_TILT_ROOM = 1.1;

/**
 * Square size from the tile width; tiles with a fixed height ("fit content" = container excepted)
 * also from the height, so nothing scrolls. Wider than high: the slider stands upright on the right
 * at the tile's right border (`today-stk--wide`). Then fit the texts.
 */
function _stkLayout(body) {
  if (body.querySelector('.today-stk-fs')) { body.querySelectorAll('.today-stk-textbox').forEach(_stkFitText); return; }
  const box = body.querySelector('.today-stk');
  if (!box || !body.clientWidth) return;
  const tile  = body.closest('.today-tile');
  const fixed = !!tile && (tile.classList.contains('today-tile--fs')   // fullscreen (small screens: the stack)
    || (!tile.classList.contains('today-tile--auto') && !tile.classList.contains('today-tile--collapsed')
        && !(tile.classList.contains('today-tile--fill') && tile.closest('.today-col--over'))));
  const nav  = box.querySelector('.today-stk-nav');
  const wide = fixed && !!nav && body.clientWidth > body.clientHeight;
  box.classList.toggle('today-stk--wide', wide);
  const px = v => parseFloat(v) || 0;
  const bs = getComputedStyle(body), xs = getComputedStyle(box);
  const innerW = body.clientWidth - px(bs.paddingLeft) - px(bs.paddingRight) - px(xs.paddingLeft) - px(xs.paddingRight);
  const innerH = body.clientHeight - px(bs.paddingTop) - px(bs.paddingBottom) - px(xs.paddingTop) - px(xs.paddingBottom)
    - _stkOuterH(body.querySelector('.today-stk-filter-wrap'));
  let size;
  // wide: the slider sits at the right border, the stack stays centred → keep its width free on both sides
  if (wide) size = Math.min((innerW - 2 * nav.offsetWidth) / _STK_TILT_ROOM, innerH / (_STK_TILT_ROOM - 0.05));
  else {
    size = Math.min(innerW / _STK_TILT_ROOM, 340);
    if (fixed) size = Math.min(size, (innerH - (nav ? nav.offsetHeight + px(xs.rowGap) : 0)) / (_STK_TILT_ROOM - 0.05));
  }
  size = fixed ? Math.min(Math.max(48, Math.floor(size) - 1), 340) : Math.max(120, Math.floor(size));
  box.style.setProperty('--stk-size', `${size}px`);
  box.querySelectorAll('.today-stk-textbox').forEach(_stkFitText);
}

/**
 * Largest font size (3–64 px) at which the text fits its square box. Words never break (CSS), so a
 * long word makes the text wider than the box until the size is small enough for it on one line.
 */
function _stkFitText(boxEl) {
  const text = boxEl.firstElementChild;
  const W = boxEl.clientWidth, H = boxEl.clientHeight;
  if (!text || !W || !H) return;
  let lo = 3, hi = 64;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    text.style.fontSize = `${mid}px`;
    if (text.offsetHeight <= H && text.scrollWidth <= W) lo = mid; else hi = mid;
  }
  text.style.fontSize = `${lo}px`;
}

/** Go `step` stickies forward (wraps around); `fly` = direction the top sticky leaves to (-1 left, 1 right). */
function _stkStep(step, fly = 0) {
  const vis = _stkVisible(), n = vis.length;
  if (n < 2) return;
  _stkSetCurrent(vis[((_stkIndex() + step) % n + n) % n].id);
  _stkAngles = _stkShiftAngles(_stkAngles, step, _STK_BEHIND + 1);
  const body = _stkBody();
  const top  = body?.querySelector('.today-stk-paper--top');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (top && fly && !reduced) {
    top.classList.add('today-stk-paper--fly');
    top.style.setProperty('--stk-fly', fly);
    setTimeout(_stkRerender, 180);
  } else _stkRerender();
}

function _stkGoTo(id) {
  const from = _stkIndex();
  _stkSetCurrent(id);
  const step = _stkIndex() - from;
  if (step) _stkAngles = _stkShiftAngles(_stkAngles, step, _STK_BEHIND + 1);
  _stkRerender();
}

/** Dice action: a random sticky now (also restarts the rhythm). */
function _stkShowRandom() {
  if (_stkVisible().length < 2) return;
  _stkLs('today-stickies-random', JSON.stringify({ at: Date.now() }));
  _stkGoTo(_stkPickRandom(_stkVisible(), _stkCurrentId()));
  const top = _stkBody()?.querySelector('.today-stk-paper--top');
  top?.classList.add('today-stk-paper--pop');
}

function _stkWire(body) {
  if (typeof ResizeObserver === 'function') {
    let w = 0, h = 0;
    new ResizeObserver(() => {
      if (body.clientWidth === w && body.clientHeight === h) return;
      w = body.clientWidth; h = body.clientHeight;
      // Fullscreen across the small-screen limit (rotation, resize): grid ⇄ stack
      if (body.querySelector('.today-stk-host') && !!body.querySelector('.today-stk-fs') !== _stkGridMode()) { _todaySetTileActions('stickies'); _stkRerender(); return; }
      _stkLayout(body);
    }).observe(body);
  }
  let tapId = null;   // touch tap on the top sticky (pointerup), opened by the click that follows
  body.addEventListener('click', e => {
    if (e.target.closest('[data-stk-new]')) { e.preventDefault(); _stkOpenDetail(null); return; }
    if (e.target.closest('.today-stk-src a')) { tapId = null; return; }   // source link: opens in a new tab
    const chip = e.target.closest('[data-stk-filter]');
    if (chip) { _stkSetFilter(chip.dataset.stkFilter); return; }
    // Fullscreen packs: × deletes the category, + adds one, a click on a pack filters (again: all)
    const del = e.target.closest('[data-stk-cat-del]');
    if (del) { e.stopPropagation(); _stkDeleteCat(del.dataset.stkCatDel); return; }
    if (e.target.closest('[data-stk-settings]')) { _todayOpenWidgetSettings('stickies'); return; }
    if (e.target.closest('[data-stk-dice]')) { _stkShowRandom(); return; }
    const add = e.target.closest('[data-stk-cat-add]');
    if (add) { _stkStartAddCat(add); return; }
    const pack = e.target.closest('[data-stk-pack]');
    if (pack && !e.target.closest('input')) { const id = pack.dataset.stkPack; _stkSetFilter(_stkFilterCat() === id ? 'all' : id); return; }
    const cell = e.target.closest('.today-stk-cell');
    if (cell) {   // grid: a click opens it (not the click that ends a drag)
      if (!gridMoved) _stkOpenDetail(_stkItems.find(s => s.id === cell.dataset.stkId) || null);
      return;
    }
    const top = e.target.closest('.today-stk-paper--top');
    if (top && tapId === top.dataset.stkId) {
      // Opened on the click, not on pointerup: else the click lands in the new panel's text field
      tapId = null;
      _stkOpenDetail(_stkItems.find(s => s.id === top.dataset.stkId) || null);
      return;
    }
    tapId = null;
  });
  let qTimer = null;
  body.addEventListener('input', e => {
    if (e.target.classList.contains('today-stk-q')) {   // keyword filter of the fullscreen grid
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { _stkQuery = e.target.value; _stkRerender(); }, 150);
      return;
    }
    if (!e.target.classList.contains('today-stk-slider')) return;
    const s = _stkVisible()[Number(e.target.value) - 1];
    if (s) _stkGoTo(s.id);
  });
  body.addEventListener('dblclick', e => {
    if (e.target.closest('.today-stk-src a')) return;
    const top = e.target.closest('.today-stk-paper--top');
    if (top) _stkOpenDetail(_stkItems.find(s => s.id === top.dataset.stkId) || null);
  });
  body.addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.target.classList.contains('today-stk-q') && e.target.value) {
      e.preventDefault(); e.stopPropagation();   // clears the field first, the next Escape leaves fullscreen
      e.target.value = ''; _stkQuery = ''; _stkRerender();
      return;
    }
    if (e.key === 'Enter' && e.target.dataset.stkPack) { e.preventDefault(); e.target.click(); return; }
    if (e.key === 'Enter' && e.target.classList.contains('today-stk-cell')) {
      e.preventDefault();
      _stkOpenDetail(_stkItems.find(s => s.id === e.target.dataset.stkId) || null);
      return;
    }
    if (!e.target.classList.contains('today-stk')) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); _stkStep(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); _stkStep(1); }
    if (e.key === 'Enter')      { e.preventDefault(); _stkOpenDetail(_stkVisible()[_stkIndex()] || null); }
  });

  // Swipe (touch, pen, mouse drag): the top sticky follows, past 30 % of its width (or a flick) it flies off
  let g = null;
  const end = (e, cancelled) => {
    if (!g || e.pointerId !== g.id) return;
    const { paper, mode, x0, t0, touch } = g;
    const dx = e.clientX - x0;
    g = null;
    if (mode === 'pending') {
      _stkDrag = null;
      // A tap without movement opens the sticky on touch screens (the mouse double-clicks)
      if (!cancelled && touch) tapId = paper.dataset.stkId;
      return;
    }
    paper.classList.remove('today-stk-paper--drag');
    paper.style.removeProperty('--stk-dx');
    paper.style.removeProperty('--stk-drot');
    _stkDrag = null;
    const v = Math.abs(dx) / Math.max(1, performance.now() - t0);
    if (!cancelled && (Math.abs(dx) > paper.offsetWidth * 0.3 || (v > 0.5 && Math.abs(dx) > 30))) {
      _stkStep(dx < 0 ? 1 : -1, dx < 0 ? -1 : 1);   // swipe left = next
    } else if (_stkPendingRender) _stkRerender();
  };
  body.addEventListener('pointerdown', e => {
    const paper = e.target.closest('.today-stk-paper--top');
    if (!paper || e.button !== 0 || _stkItems.length === 0 || e.target.closest('.today-stk-src a')) return;
    g = { id: e.pointerId, paper, x0: e.clientX, y0: e.clientY, t0: performance.now(), mode: 'pending', touch: e.pointerType !== 'mouse' };
  });
  body.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.mode === 'pending') {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }   // vertical: page scroll
      if (Math.abs(dx) < 8 || _stkVisible().length < 2) return;
      g.mode = 'drag';
      _stkDrag = g;
      g.paper.classList.add('today-stk-paper--drag');
      try { g.paper.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    g.paper.style.setProperty('--stk-dx', `${dx}px`);
    g.paper.style.setProperty('--stk-drot', `${(dx / 18).toFixed(1)}deg`);
  });
  body.addEventListener('pointerup', e => end(e, false));
  body.addEventListener('pointercancel', e => end(e, true));

  // Grid (fullscreen): drag a sticky to another place — mouse / pen at once, touch after holding it still 300 ms
  let gg = null, gridMoved = false;
  const gridEnd = (e, cancelled) => {
    if (!gg || e.pointerId !== gg.id) return;
    const { cell, started, pack } = gg;
    clearTimeout(gg.timer);
    gg = null;
    body.querySelectorAll('.today-stk-pack--drop').forEach(p => p.classList.remove('today-stk-pack--drop'));
    cell.classList.remove('today-stk-cell--armed', 'today-stk-cell--drag');
    cell.style.removeProperty('--stk-gx');
    cell.style.removeProperty('--stk-gy');
    if (!started) return;
    _stkDrag = null;
    gridMoved = true;   // the click that follows the drop opens nothing
    setTimeout(() => { gridMoved = false; }, 0);
    if (cancelled) _stkRerender();
    else if (pack) _stkMoveToCategory(cell.dataset.stkId, pack);
    else _stkGridDropped(cell);
  };
  body.addEventListener('pointerdown', e => {
    const cell = e.target.closest('.today-stk-cell');
    if (!cell || e.button !== 0 || e.target.closest('.today-stk-src a')) return;
    const touch = e.pointerType === 'touch';
    gg = { id: e.pointerId, cell, x0: e.clientX, y0: e.clientY, armed: !touch, started: false, timer: null };
    if (touch) gg.timer = setTimeout(() => { if (gg?.cell === cell) { gg.armed = true; cell.classList.add('today-stk-cell--armed'); } }, 300);
  });
  body.addEventListener('pointermove', e => {
    if (!gg || e.pointerId !== gg.id) return;
    if (!gg.started) {
      if (Math.hypot(e.clientX - gg.x0, e.clientY - gg.y0) < 6) return;
      if (!gg.armed) { clearTimeout(gg.timer); gg = null; return; }   // touch moved before the hold: scrolling
      const r = gg.cell.getBoundingClientRect();
      Object.assign(gg, { started: true, offX: gg.x0 - r.left, offY: gg.y0 - r.top, tx: 0, ty: 0 });
      _stkDrag = gg;   // re-renders wait for the drop
      gg.cell.classList.add('today-stk-cell--drag');
      try { gg.cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    _stkGridDragMove(body, gg, e.clientX, e.clientY);
  });
  // A held touch must not start scrolling once armed
  body.addEventListener('touchmove', e => { if (gg?.armed) e.preventDefault(); }, { passive: false });
  body.addEventListener('pointerup', e => gridEnd(e, false));
  body.addEventListener('pointercancel', e => gridEnd(e, true));
}

// ---- Detail panel: view / edit, convert, delete ----

function _stkApi(id = '') {
  return `/api/stickies${id ? `/${encodeURIComponent(id)}` : ''}`;
}

async function _stkJson(url, opts) {
  const res  = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Replace / add a sticky in the local list and re-render the tile. */
function _stkUpsertLocal(item) {
  const i = _stkItems.findIndex(s => s.id === item.id);
  if (i >= 0) _stkItems[i] = item; else _stkItems.unshift(item);
  _stkItems = _stkSort(_stkItems);
  _stkRerender();
}

/** Save what changed in the panel (queued, so a create is never sent twice). */
function _stkFlush() {
  const ed = _stkEdit;
  if (!ed) return Promise.resolve();
  clearTimeout(ed.timer);
  ed.timer = null;
  ed.chain = ed.chain.then(async () => {
    const text = ed.text;
    if (!text.trim()) return;   // empty stickies are not saved
    const fields = { text, source: ed.source.trim(), color: ed.color, category: ed.category };
    if (ed.id && ed.saved && Object.keys(fields).every(k => fields[k] === ed.saved[k])) return;
    try {
      const { item } = ed.id
        ? await _stkJson(_stkApi(ed.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) })
        : await _stkJson(_stkApi(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
      const isNew = !ed.id;
      Object.assign(ed, { id: item.id, created: item.created, updated: item.updated, saved: fields });
      if (isNew) _stkSetCurrent(item.id);
      _stkUpsertLocal(item);
      if (_stkEdit === ed) _stkSyncDetail();
    } catch (err) {
      showMessage(`Could not save the sticky: ${err.message}`);
    }
  });
  return ed.chain;
}

function _stkScheduleSave() {
  clearTimeout(_stkEdit.timer);
  _stkEdit.timer = setTimeout(_stkFlush, _STK_SAVE_MS);
}

/** Header tint, title, meta line and button states from _stkEdit. */
function _stkSyncDetail() {
  const ed = _stkEdit;
  const detail = document.getElementById('dashboardDetail');
  if (!ed || !detail.querySelector('.stk-detail')) return;
  detail.querySelector('.dashboard-detail-titlebar').style.setProperty('--detail-accent', ed.color);
  document.getElementById('dashboardDetailTitle').textContent = ed.id ? `Sticky · ${_stkCategoryLabel(ed.category)}` : 'New sticky';
  detail.querySelector('.stk-detail-text').style.setProperty('--stk-color', ed.color);
  detail.querySelectorAll('[data-stk-color]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.stkColor === ed.color)));
  detail.querySelectorAll('[data-stk-cat]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.stkCat === ed.category)));
  const fmt = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  detail.querySelector('.stk-detail-meta').textContent = ed.created
    ? `Created ${fmt(ed.created)}${ed.updated && ed.updated !== ed.created ? ` · changed ${fmt(ed.updated)}` : ''}`
    : 'Saved as soon as you type.';
  const empty = !ed.text.trim();
  detail.querySelectorAll('[data-stk-convert]').forEach(b => { b.disabled = empty; });
  const more = detail.querySelector('[data-stk-save-new]');
  if (more) more.disabled = empty;
  const del = detail.querySelector('[data-stk-delete]');
  if (del) del.disabled = !ed.id;
}

/** Save button: save now and close the panel (an empty new sticky is just discarded). */
async function _stkSaveAndClose(ed) {
  await _stkFlush();
  if (_stkEdit === ed) _closeDetail();
}

/** "Save & add another": the sticky goes out, a blank one in the same category takes the panel. */
async function _stkSaveAndNew(ed) {
  if (!ed.text.trim()) return;
  await _stkFlush();
  // Only once it is saved (a failed save keeps the text in the panel)
  if (_stkEdit === ed && ed.id && ed.saved?.text === ed.text) _stkOpenDetail(null, { category: ed.category });
}

function _stkOpenDetail(sticky, { category } = {}) {
  const detail  = document.getElementById('dashboardDetail');
  const body    = document.getElementById('dashboardDetailBody');
  detail.querySelector('.dash-detail-footer')?.remove();
  document.getElementById('dashboardDetailEditBtn').style.display = 'none';
  // A previous sticky still waiting for its save goes out first
  if (_stkEdit?.timer) _stkFlush();
  _stkEdit = {
    id: sticky?.id || null,
    text: sticky?.text || '',
    source: sticky?.source || '',
    color: sticky?.color || _STK_COLORS[Math.floor(Math.random() * _STK_COLORS.length)],
    category: sticky?.category || category || (_stkFilterCat() !== 'all' ? _stkFilterCat() : _stkDefaultCat()),   // new: the filtered category
    created: sticky?.created || null,
    updated: sticky?.updated || null,
    saved: sticky ? { text: sticky.text, source: sticky.source || '', color: sticky.color, category: sticky.category } : null,
    isNew: !sticky,   // opened as a new sticky: offers "Save & add another" (also after its first autosave)
    timer: null,
    chain: _stkEdit?.chain || Promise.resolve(),
  };
  const ed = _stkEdit;
  _detailCloseHook = () => { if (_stkEdit === ed) { _stkFlush(); _stkEdit = null; } };

  body.innerHTML = `<div class="stk-detail">
      <textarea class="stk-detail-text" maxlength="5000" placeholder="A thought, a quote, an idea …" aria-label="Sticky text"></textarea>
      <p class="stk-detail-hint">**bold** · *italic* · __underline__ · ~~strike~~ · {-} = hyphenation point</p>
      <div class="stk-detail-row">
        <label class="stk-detail-label" for="stkDetailSource">Source</label>
        <input id="stkDetailSource" class="new-board-input stk-detail-source" type="text" maxlength="500" placeholder="Author, book, URL …" autocomplete="off">
      </div>
      <div class="stk-detail-row">
        <span class="stk-detail-label">Colour</span>
        <div class="stk-swatches" role="radiogroup" aria-label="Colour">${_STK_COLORS.map(c =>
          `<button type="button" class="stk-swatch" role="radio" data-stk-color="${c}" style="--stk-color:${c}" title="${c}" aria-label="Colour ${c}"></button>`).join('')}</div>
      </div>
      <div class="stk-detail-row">
        <span class="stk-detail-label">Category</span>
        <div class="stk-cats" role="radiogroup" aria-label="Category">${_stkCats.map(c =>
          `<button type="button" class="stk-cat" role="radio" data-stk-cat="${c.id}">${escHtml(c.label)}</button>`).join('')}</div>
      </div>
      <p class="stk-detail-meta"></p>
    </div>`;
  const ta = body.querySelector('.stk-detail-text');
  ta.value = ed.text;
  const srcInput = body.querySelector('.stk-detail-source');
  srcInput.value = ed.source;
  srcInput.addEventListener('input', () => {
    if (_stkEdit !== ed) return;
    ed.source = srcInput.value;
    _stkScheduleSave();
  });
  srcInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _closeDetail(); } });

  // Footer buttons are icon-only: the text goes into the tooltip / accessible name
  const iconBtn = (attr, icon, label, cls = '') =>
    `<button type="button" class="btn stk-icon-btn${cls ? ` ${cls}` : ''}" ${attr} title="${label}" aria-label="${label}">${icon(14, 14)}</button>`;
  const footer = document.createElement('div');
  footer.className = 'dash-detail-footer stk-detail-footer';
  footer.innerHTML = `<div class="dash-detail-footer-row stk-convert-row">
      <span class="dash-detail-footer-scope-label">Turn into</span>
      ${iconBtn('data-stk-convert="mail"', SVGICONS.email, 'Turn into a mail')}
      ${iconBtn('data-stk-convert="event"', SVGICONS.date, 'Turn into an event')}
      ${iconBtn('data-stk-convert="card"', SVGICONS.card, 'Turn into a card')}
      ${iconBtn('data-stk-convert="note"', SVGICONS.noteDoc, 'Turn into a note page')}
    </div>
    <div class="dash-detail-footer-row stk-detail-actions">
      ${iconBtn('data-stk-save="1"', SVGICONS.save, 'Save and close (Ctrl+Enter)', 'btn-accent')}
      ${ed.isNew ? iconBtn('data-stk-save-new="1"', SVGICONS.create, 'Save and add another (Ctrl+Shift+Enter)') : ''}
      ${iconBtn('data-stk-delete="1"', SVGICONS.delete, 'Delete', 'btn-confirm-danger')}
    </div>`;
  detail.querySelector('.modal').appendChild(footer);

  ta.addEventListener('input', () => {
    if (_stkEdit !== ed) return;
    ed.text = ta.value;
    _stkSyncDetail();
    _stkScheduleSave();
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey && ed.isNew) _stkSaveAndNew(ed); else _closeDetail();
    }
  });
  body.querySelector('.stk-detail').addEventListener('click', e => {
    const col = e.target.closest('[data-stk-color]');
    const cat = e.target.closest('[data-stk-cat]');
    if (!col && !cat) return;
    if (col) ed.color = col.dataset.stkColor;
    if (cat) ed.category = cat.dataset.stkCat;
    _stkSyncDetail();
    _stkScheduleSave();
  });
  footer.addEventListener('click', e => {
    const conv = e.target.closest('[data-stk-convert]');
    if (conv) _stkConvert(conv.dataset.stkConvert, ed);
    if (e.target.closest('[data-stk-delete]')) _stkDelete(ed);
    if (e.target.closest('[data-stk-save-new]')) _stkSaveAndNew(ed);
    if (e.target.closest('[data-stk-save]')) _stkSaveAndClose(ed);
  });

  detail.style.display = '';
  { const modal = detail.querySelector('.modal');
    modal.style.height    = 'auto';
    modal.style.minHeight = '';
    modal.style.maxHeight = ''; }
  _stkSyncDetail();
  // Phones: no keyboard popping up just for reading
  if (!sticky || !_todaySmall()) {
    ta.focus();
    if (sticky) ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

async function _stkRemove(id) {
  await _stkJson(_stkApi(id), { method: 'DELETE' });
  const vi = _stkVisible().findIndex(s => s.id === id);
  const i  = _stkItems.findIndex(s => s.id === id);
  if (i >= 0) {
    _stkItems.splice(i, 1);
    // The next visible sticky takes the deleted one's place
    const vis = _stkVisible();
    if (_stkCurrentId() === id && vis.length) _stkSetCurrent(vis[Math.min(Math.max(vi, 0), vis.length - 1)].id);
  }
  _stkRerender();
}

async function _stkDelete(ed) {
  if (!ed.id) return;
  if (!(await showConfirm('Delete this sticky?', { okLabel: 'Delete', danger: true }))) return;
  clearTimeout(ed.timer);
  ed.timer = null;
  if (_stkEdit === ed) { _stkEdit = null; _closeDetail(); }
  try { await _stkRemove(ed.id); } catch (err) { showMessage(`Could not delete the sticky: ${err.message}`); }
}

/** After the target was saved: offer to delete the sticky (it found its home). */
async function _stkAfterConvert(id, what) {
  if (!id) return;
  if (!(await showConfirm(`${what} created. Delete the sticky?`, { okLabel: 'Delete', cancelLabel: 'Keep', danger: true }))) return;
  try { await _stkRemove(id); } catch (err) { showMessage(`Could not delete the sticky: ${err.message}`); }
}

/** Turn the sticky in the panel into a mail / event / card / note page (the target's own dialog). */
async function _stkConvert(kind, ed) {
  await _stkFlush();
  if (!ed.id) return;
  const sticky = { id: ed.id, text: _stkStripHyphens(ed.text), source: ed.source, category: ed.category };
  const { title, body } = _stkSplit(sticky.text);
  const md    = _stkMarkdown(sticky, body);
  const plain = _stkPlain(sticky, body);
  if (_stkEdit === ed) _stkEdit = null;
  _closeDetail();
  if (kind === 'card') {
    await openInboxModal(null, { text: title, description: md }, () => _stkAfterConvert(sticky.id, 'Card'));
  } else if (kind === 'event') {
    await _todayNewEvent({ title, description: plain, onSaved: () => _stkAfterConvert(sticky.id, 'Event') });
  } else if (kind === 'mail') {
    await _todayCompose({ subject: title, body: plain || title, onSent: () => _stkAfterConvert(sticky.id, 'Mail') });
  } else if (kind === 'note') {
    const boards = await _dashActiveBoards();
    if (!boards.length) { showMessage('There is no active board for the note page.'); return; }
    const board = boards.length === 1 ? boards[0]
      : await _todayPick('Create the note page on board', boards.map(b => ({ value: b, label: b })), { filter: boards.length > 8 });
    if (!board) return;
    await _todayNewNote(board, { title, description: md, onCreated: () => _stkAfterConvert(sticky.id, 'Note page') });
  }
}

TODAY_TILES.stickies = {
  title: 'Stickies',
  desc: 'Quick notes without a home yet — flip through them, get a random one, turn one into a mail, event, card or note page',
  settings: true,
  scales: true,
  load: () => _todayFetchJson('/api/stickies'),
  render: _stkRender,
  // Fullscreen: no dice / settings in the header — the grid has no stack (settings in the packs' lower
  // left corner), small screens get the dice as a button in the lower right corner (_stkSyncDiceFab)
  actions: () => [
    ...(_stkFs ? [] : [{ icon: SVGICONS.dice(12, 12), title: 'Random sticky', run: () => _stkShowRandom() }]),
    { icon: SVGICONS.create(12, 12), title: 'New sticky', run: () => _stkOpenDetail(null) },
    ...(_stkFs ? [] : [{ icon: SVGICONS.settings(12, 12), title: 'Random rhythm (settings)', run: () => _todayOpenWidgetSettings('stickies') }]),
    { icon: SVGICONS.fullscreen(12, 12), title: _stkFs ? 'Exit fullscreen (Esc)' : 'Fullscreen — all stickies', active: _stkFs, run: () => _stkSetFs(!_stkFs) },
  ],
};
