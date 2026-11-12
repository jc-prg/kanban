// ---- Today: Stickies tile (TODAY_TILES.stickies) ----
// Unstructured notes without a home yet: a stack of rotated square stickies to flip through
// (swipe, slider, ← →), a random one brought to the top on a rhythm, a detail panel to edit
// them and to turn one into a mail, event, card or note page. Data: /api/stickies (routes/stickies.js).

// Paper colours — same list as STICKY_COLORS in backend/routes/stickies.js
const _STK_COLORS = ['#fde68a', '#fdba74', '#f9a8d4', '#c4b5fd', '#93c5fd', '#86efac', '#5eead4', '#d1d5db'];
const _STK_CATEGORIES = [
  { id: 'note',  label: 'Note' },
  { id: 'quote', label: 'Quote' },
  { id: 'other', label: 'Other' },
];
const _STK_BEHIND = 3;          // stickies visible behind the top one
const _STK_SAVE_MS = 600;

let _stkItems = [];             // newest first, as the server sends them
let _stkDrag = null;            // swipe in progress: re-renders wait for it
let _stkPendingRender = false;
let _stkEdit = null;            // detail panel: { id, text, source, color, category, created, updated, timer, chain }
let _stkAngles = null;          // rotation per stack slot: [top, 1st behind, 2nd, 3rd] — shifted on every flip

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

/** Count per category plus `all`: { all, note, quote, other }. Pure. */
function _stkCounts(items) {
  const out = { all: items.length };
  for (const c of _STK_CATEGORIES) out[c.id] = 0;
  for (const s of items) { const c = s.category || 'note'; if (c in out) out[c]++; }
  return out;
}

function _stkCategoryLabel(id) {
  return _STK_CATEGORIES.find(c => c.id === id)?.label || 'Note';
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

/** Category filter (per browser): 'all' or a category id. */
function _stkFilterCat() {
  const v = _stkLs('today-stickies-filter');
  return _STK_CATEGORIES.some(c => c.id === v) ? v : 'all';
}

/** The stickies the stack shows: those of the filtered category. */
function _stkVisible() {
  return _stkFilter(_stkItems, _stkFilterCat());
}

function _stkSetFilter(cat) {
  _stkLs('today-stickies-filter', cat);
  _stkAngles = _stkShiftAngles(_stkAngles, 1, _STK_BEHIND + 1);   // a new stack: fresh angle on top of it
  _stkRerender();
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
      <div class="today-stk-textbox"><div class="today-stk-text${s.category === 'quote' ? ' today-stk-text--quote' : ''}">${escHtml(s.text)}</div></div>
      <div class="today-stk-foot"><span class="today-stk-cat">${escHtml(_stkCategoryLabel(s.category))}</span>${
        src ? `<span class="today-stk-src" title="${escHtml(src)}">${_stkLinkify(src)}</span>` : ''}</div>
    </div>`;
}

// render(body, data, el) — `random: false` for re-renders after local changes (no random pick)
function _stkRender(body, data, el, { random = true } = {}) {
  _stkItems = data?.items || [];
  if (el) _todaySetCount(el, _stkItems.length);
  if (_stkDrag) { _stkPendingRender = true; return; }
  _stkPendingRender = false;
  if (random && _stkVisible().length > 1 && _stkDue(_stkRhythm(), _stkRandomAt(), Date.now())) {
    _stkSetCurrent(_stkPickRandom(_stkVisible(), _stkCurrentId()));
    _stkLs('today-stickies-random', JSON.stringify({ at: Date.now() }));
  }
  if (!body._stkWired) { body._stkWired = true; _stkWire(body); }

  if (!_stkItems.length) {
    body.innerHTML = '<p class="dashboard-empty today-stk-empty">No stickies yet. <a href="#" data-stk-new="1">Add one</a> for a thought that has no home yet.</p>';
    return;
  }
  // Category filter above the stack: All + one chip per category with its count
  if (!body.querySelector('.today-stk-filter')) {
    body.innerHTML = '<div class="today-stk-filter" role="radiogroup" aria-label="Category"></div><div class="today-stk-host"></div>';
  }
  const cat = _stkFilterCat(), counts = _stkCounts(_stkItems);
  body.querySelector('.today-stk-filter').innerHTML = [{ id: 'all', label: 'All' }, ..._STK_CATEGORIES].map(c =>
    `<button type="button" class="today-stk-chip${counts[c.id] ? '' : ' today-stk-chip--empty'}" role="radio" aria-checked="${c.id === cat}" data-stk-filter="${c.id}">${escHtml(c.label)}<span class="today-stk-chip-n">${counts[c.id]}</span></button>`).join('');
  const host = body.querySelector('.today-stk-host');
  const vis  = _stkVisible();
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

// Room the rotated papers need around the square (≤ 6° tilt ≈ 5 % per side)
const _STK_TILT_ROOM = 1.1;

/**
 * Square size from the tile width; tiles with a fixed height ("fit content" = container excepted)
 * also from the height, so nothing scrolls. Wider than high: the slider stands upright on the right
 * at the tile's right border (`today-stk--wide`). Then fit the texts.
 */
function _stkLayout(body) {
  const box = body.querySelector('.today-stk');
  if (!box || !body.clientWidth) return;
  const tile  = body.closest('.today-tile');
  const fixed = !!tile && !tile.classList.contains('today-tile--auto') && !tile.classList.contains('today-tile--collapsed')
    && !(tile.classList.contains('today-tile--fill') && tile.closest('.today-col--over'));
  const nav  = box.querySelector('.today-stk-nav');
  const wide = fixed && !!nav && body.clientWidth > body.clientHeight;
  box.classList.toggle('today-stk--wide', wide);
  const px = v => parseFloat(v) || 0;
  const bs = getComputedStyle(body), xs = getComputedStyle(box);
  const innerW = body.clientWidth - px(bs.paddingLeft) - px(bs.paddingRight) - px(xs.paddingLeft) - px(xs.paddingRight);
  const innerH = body.clientHeight - px(bs.paddingTop) - px(bs.paddingBottom) - px(xs.paddingTop) - px(xs.paddingBottom)
    - (body.querySelector('.today-stk-filter')?.offsetHeight || 0);
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
      _stkLayout(body);
    }).observe(body);
  }
  let tapId = null;   // touch tap on the top sticky (pointerup), opened by the click that follows
  body.addEventListener('click', e => {
    if (e.target.closest('[data-stk-new]')) { e.preventDefault(); _stkOpenDetail(null); return; }
    if (e.target.closest('.today-stk-src a')) { tapId = null; return; }   // source link: opens in a new tab
    const chip = e.target.closest('[data-stk-filter]');
    if (chip) { _stkSetFilter(chip.dataset.stkFilter); return; }
    const top = e.target.closest('.today-stk-paper--top');
    if (top && tapId === top.dataset.stkId) {
      // Opened on the click, not on pointerup: else the click lands in the new panel's text field
      tapId = null;
      _stkOpenDetail(_stkItems.find(s => s.id === top.dataset.stkId) || null);
      return;
    }
    tapId = null;
  });
  body.addEventListener('input', e => {
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
  const del = detail.querySelector('[data-stk-delete]');
  if (del) del.disabled = !ed.id;
}

function _stkOpenDetail(sticky) {
  const detail  = document.getElementById('dashboardDetail');
  const body    = document.getElementById('dashboardDetailBody');
  detail.querySelector('.dash-detail-footer')?.remove();
  document.getElementById('dashboardDetailEditBtn').style.display = 'none';
  document.getElementById('dashboardDetailWebUrl').style.display  = 'none';
  // A previous sticky still waiting for its save goes out first
  if (_stkEdit?.timer) _stkFlush();
  _stkEdit = {
    id: sticky?.id || null,
    text: sticky?.text || '',
    source: sticky?.source || '',
    color: sticky?.color || _STK_COLORS[Math.floor(Math.random() * _STK_COLORS.length)],
    category: sticky?.category || (_stkFilterCat() !== 'all' ? _stkFilterCat() : 'note'),   // new: the filtered category
    created: sticky?.created || null,
    updated: sticky?.updated || null,
    saved: sticky ? { text: sticky.text, source: sticky.source || '', color: sticky.color, category: sticky.category } : null,
    timer: null,
    chain: _stkEdit?.chain || Promise.resolve(),
  };
  const ed = _stkEdit;
  _detailCloseHook = () => { if (_stkEdit === ed) { _stkFlush(); _stkEdit = null; } };

  body.innerHTML = `<div class="stk-detail">
      <textarea class="stk-detail-text" maxlength="5000" placeholder="A thought, a quote, an idea …" aria-label="Sticky text"></textarea>
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
        <div class="stk-cats" role="radiogroup" aria-label="Category">${_STK_CATEGORIES.map(c =>
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

  const footer = document.createElement('div');
  footer.className = 'dash-detail-footer stk-detail-footer';
  footer.innerHTML = `<div class="dash-detail-footer-row stk-convert-row">
      <span class="dash-detail-footer-scope-label">Turn into</span>
      <button type="button" class="btn" data-stk-convert="mail">${SVGICONS.email(12, 12)} Mail</button>
      <button type="button" class="btn" data-stk-convert="event">${SVGICONS.date(12, 12)} Event</button>
      <button type="button" class="btn" data-stk-convert="card">${SVGICONS.card(12, 12)} Card</button>
      <button type="button" class="btn" data-stk-convert="note">${SVGICONS.noteDoc(12, 12)} Note page</button>
    </div>
    <div class="dash-detail-footer-row stk-detail-actions">
      <button type="button" class="btn btn-confirm-danger" data-stk-delete="1">${SVGICONS.delete(12, 12)} Delete</button>
    </div>`;
  detail.querySelector('.modal').appendChild(footer);

  ta.addEventListener('input', () => {
    if (_stkEdit !== ed) return;
    ed.text = ta.value;
    _stkSyncDetail();
    _stkScheduleSave();
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _closeDetail(); }
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
  const sticky = { id: ed.id, text: ed.text, source: ed.source, category: ed.category };
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
  actions: () => [
    { icon: SVGICONS.dice(12, 12), title: 'Random sticky', run: () => _stkShowRandom() },
    { icon: SVGICONS.create(12, 12), title: 'New sticky', run: () => _stkOpenDetail(null) },
    { icon: SVGICONS.settings(12, 12), title: 'Random rhythm (settings)', run: () => _todayOpenWidgetSettings('stickies') },
  ],
};
