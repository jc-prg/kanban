// ---- Today: Search tile ----
// Finds cards, notes, calendar events, mail and CV-App applications. Title mode matches title +
// subtitle (card text / column, note title / folders, event title / location, mail subject /
// addresses, job title / company); "Full text" adds all text fields (never attachments).
// One request per source (mail: per account — GET /api/today/search/:type), so fast sources show
// while IMAP is still searching. Results are kept per query + mode: toggling a type only fetches
// what is missing, and the auto-refresh never re-runs a search. Rows reuse the Today row markup,
// so the grid's delegation in today.js opens them (detail panel / note dialog); applications are
// links into the CV-App (new tab). Loaded after today.js.

const _TS_TYPES = [
  { id: 'cards',        label: 'Cards' },
  { id: 'notes',        label: 'Notes' },
  { id: 'events',       label: 'Events' },
  { id: 'mail',         label: 'Mail' },
  { id: 'applications', label: 'Applications' },
];
const _TS_DEBOUNCE_MS = 350;

const _ts = {
  q: '',
  key: '',            // "<full>|<query>" the results belong to
  results: {},        // slot id ('cards', 'mail:<accountId>', …) → { status, items, total, error, truncated }
  open: new Set(),    // categories opened for the current query (all start collapsed)
  ctrl: null,         // AbortController of the current key
  timer: 0,
  sources: null,      // { types, mailAccounts } from GET /api/today/search
  body: null,
  el: null,
};

/** Per-browser prefs: { off: [type ids], full }. Unknown / new types default to on. */
function _tsPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('today-search') || '{}');
    return { off: Array.isArray(p.off) ? p.off : [], full: p.full === true };
  } catch { return { off: [], full: false }; }
}

function _tsSavePrefs(p) {
  try { localStorage.setItem('today-search', JSON.stringify(p)); } catch { /* ignore */ }
}

/** Available types that are switched on. Pure. */
function _tsActiveTypes(available, off) {
  return (available || []).filter(t => !(off || []).includes(t));
}

/** Requests for a search: one per active type, mail one per account. Pure. */
function _tsSlots(sources, off) {
  const slots = [];
  for (const type of _tsActiveTypes(sources?.types, off)) {
    if (type === 'mail') for (const acc of sources.mailAccounts || []) slots.push({ id: `mail:${acc.id}`, type, acc });
    else slots.push({ id: type, type });
  }
  return slots;
}

function _tsUrl(slot, q, full) {
  const qs = `q=${encodeURIComponent(q)}${full ? '&full=1' : ''}${slot.acc ? `&account=${encodeURIComponent(slot.acc.id)}` : ''}`;
  return `/api/today/search/${slot.type}?${qs}`;
}

function _tsSetType(type, on) {
  const p = _tsPrefs();
  p.off = on ? p.off.filter(t => t !== type) : [...new Set([...p.off, type])];
  _tsSavePrefs(p);
  _tsSearch();
}

function _tsSetAll(on) {
  const p = _tsPrefs();
  p.off = on ? [] : _TS_TYPES.map(t => t.id);
  _tsSavePrefs(p);
  _tsRenderChips();
  _tsSearch();
}

function _tsToggleFull() {
  const p = _tsPrefs();
  p.full = !p.full;
  _tsSavePrefs(p);
  _todaySetTileActions('search');
  _tsSearch();
}

/** Run the search for the current query: fetch every active slot that has no result for this key yet. */
function _tsSearch() {
  clearTimeout(_ts.timer);
  const q = _ts.q.trim();
  const { off, full } = _tsPrefs();
  const key = `${full ? 1 : 0}|${q}`;
  if (key !== _ts.key) {
    _ts.ctrl?.abort();
    _ts.ctrl = new AbortController();
    _ts.key = key;
    _ts.results = {};
    _ts.open = new Set();
  }
  if (q.length >= 2) {
    const { signal } = _ts.ctrl;
    for (const slot of _tsSlots(_ts.sources, off)) {
      if (_ts.results[slot.id]) continue;
      _ts.results[slot.id] = { status: 'loading' };
      fetch(_tsUrl(slot, q, full), { signal })
        .then(async r => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
          return data;
        })
        .then(data => {
          if (_ts.key !== key) return;
          _ts.results[slot.id] = { status: 'done', items: data.items || [], total: data.total ?? (data.items || []).length,
            truncated: !!data.truncated, errors: data.errors || [] };
          _tsRenderResults();
        })
        .catch(err => {
          if (err.name === 'AbortError' || _ts.key !== key) return;
          _ts.results[slot.id] = { status: 'error', error: err.message };
          _tsRenderResults();
        });
    }
  }
  _tsRenderResults();
}

// ---- Rows ----

function _tsCardHtml(item) {
  return `<div class="today-swipe">${_todayKanbanCardHtml(item)}</div>`;
}

function _tsNoteHtml(n) {
  const where = [n.board, ...(n.path || [])].join(' / ');
  return `<a class="today-npage today-search-note" data-board="${escHtml(n.board)}" data-page-id="${escHtml(n.id)}" href="${BASE_PATH}/board/${encodeURIComponent(n.board)}#note:${encodeURIComponent(n.id)}" title="${escHtml(n.title)} — ${escHtml(where)}">
    ${SVGICONS.notePages(10, 10)}<span class="today-row-main"><span class="today-row-title">${escHtml(n.title || '(untitled)')}</span>
    <span class="today-row-meta"><span>${escHtml(where)}</span>${n.lastModified ? `<span class="today-row-date">${escHtml(_fmtRecentDate(n.lastModified))}</span>` : ''}</span></span></a>`;
}

/** Date (+ time) of an event start; all-day starts are plain YYYY-MM-DD. */
function _tsEventWhen(ev) {
  if (!ev.start) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(ev.start)) return fmtDate(ev.start);
  return `${fmtDate(_todayLocalDay(new Date(ev.start)))} ${_todayFmtTime(ev.start)}`;
}

function _tsEventHtml(ev) {
  // Same tagging as the agenda, so the detail panel and the context menu find it
  const tagged = { ...ev, _label: ev.label, _accountId: ev.accountId, _webUrl: ev.webUrl || '', _color: ev.color || null, _accountType: ev.accountType || 'caldav' };
  _calEventMap.set(`${ev.accountId}\0${ev.uid}`, tagged);
  const title = _todayDecodeEntities(ev.title);
  const loc   = _todayDecodeEntities(ev.location).trim();
  const past  = new Date(ev.end || ev.start) < new Date();
  const color = ev.color ? ` style="--card-color:${escHtml(ev.color)}"` : '';
  return `<div class="today-ev today-ev-row today-search-ev${past ? ' today-ev--past' : ''}" data-account-id="${escHtml(ev.accountId)}" data-uid="${escHtml(ev.uid)}" data-web-url="${escHtml(ev.webUrl || '')}"${color}>
    <span class="today-ev-time">${escHtml(_tsEventWhen(ev))}</span>
    <span class="today-ev-title"><span class="today-ev-line" title="${escHtml(title)}">${escHtml(title)}</span>${loc ? `<span class="today-ev-line today-ev-loc" title="${escHtml(loc)}">${escHtml(loc)}</span>` : ''}</span>
  </div>`;
}

function _tsMailHtml({ acc, msg }) {
  return `<div class="today-mail-row dashboard-mail-item" data-account-id="${escHtml(acc.id)}" data-msg-id="${escHtml(msg.id)}" data-folder="${escHtml(msg.folder || '')}"${msg.unread ? ' data-unread="1"' : ''} data-web-url="${escHtml(acc.webInterfaceUrl || '')}"${acc.color ? ` style="--card-color:${escHtml(acc.color)}"` : ''}>
    <span class="today-row-main"><span class="today-row-title card-text">${msg.unread ? '<strong>' : ''}${escHtml(msg.subject || '(no subject)')}${msg.unread ? '</strong>' : ''}</span>
    <span class="today-row-meta"><span>${escHtml(_mailDisplayName(msg.from))}</span><span class="today-search-folder" title="${escHtml(acc.label)} · ${escHtml(msg.folder || '')}">${escHtml(msg.folder || '')}</span><span class="today-row-date">${escHtml(msg.date ? _fmtRecentDate(msg.date) : '')}</span></span></span>
  </div>`;
}

function _tsAppHtml(a) {
  const title = escHtml(a.title || '(untitled)');
  const sub   = [a.company, a.location].filter(Boolean).join(' · ');
  const main  = `<span class="today-app-line today-app-title" title="${title}">${title}</span>`
    + (sub ? `<span class="today-app-line today-app-company" title="${escHtml(sub)}">${escHtml(sub)}</span>` : '')
    + `<span class="today-row-meta today-app-meta">${_todayCvBadge(a.status)}</span>`;
  return a.url
    ? `<a class="today-app-row today-search-app" href="${escHtml(a.url)}" target="_blank" rel="noopener noreferrer" title="Open in the CV-App (new tab)"><span class="today-row-main">${main}</span>${SVGICONS.openLink(11, 11)}</a>`
    : `<div class="today-app-row today-search-app"><span class="today-row-main">${main}</span></div>`;
}

// ---- Rendering ----

/** Merge the result slots of one type into { status, items, total, errors, truncated }. Pure. */
function _tsGroup(type, slots, results) {
  const parts = slots.filter(s => s.type === type).map(s => ({ slot: s, res: results[s.id] })).filter(p => p.res);
  if (!parts.length) return null;
  const done = parts.filter(p => p.res.status === 'done');
  const errors = [];
  for (const p of parts) {
    if (p.res.status === 'error') errors.push(p.slot.acc ? `${p.slot.acc.label}: ${p.res.error}` : p.res.error);
    for (const e of p.res.errors || []) errors.push(e);
  }
  let items;
  if (type === 'mail') {
    items = done.flatMap(p => p.res.items.map(msg => ({ acc: p.slot.acc, msg })))
      .sort((a, b) => String(b.msg.date || '').localeCompare(String(a.msg.date || '')));
  } else {
    items = done.flatMap(p => p.res.items);
  }
  return {
    status: parts.some(p => p.res.status === 'loading') ? 'loading' : done.length ? 'done' : 'error',
    items,
    total: done.reduce((n, p) => n + (p.res.total || 0), 0),
    truncated: done.some(p => p.res.truncated),
    errors,
  };
}

const _TS_ROW = { cards: _tsCardHtml, notes: _tsNoteHtml, events: _tsEventHtml, mail: _tsMailHtml, applications: _tsAppHtml };

/** Include checkbox at the right end of a category row. */
function _tsCheckHtml(id, label, on) {
  return `<input type="checkbox" class="today-search-check" data-ts-type="${id}"${on ? ' checked' : ''} title="${on ? `Searching ${label} — untick to leave them out` : `Include ${label} in the search`}" aria-label="Include ${label}">`;
}

/**
 * One row per available source, always: a ticked source with hits is a collapsed category
 * (triangle); without hits, still searching, not searched yet or unticked it is a plain row
 * ("0" / animated dots while searching / nothing, no triangle). The checkbox on the right includes / excludes it.
 */
function _tsRenderResults() {
  const box = _ts.body?.querySelector('.today-search-results');
  if (!box) return;
  const q = _ts.q.trim();
  const { off } = _tsPrefs();
  const slots = _tsSlots(_ts.sources, off);
  const avail = _TS_TYPES.filter(t => (_ts.sources?.types || []).includes(t.id));
  let count = 0;
  const html = avail.map(({ id, label }) => {
    const on = !off.includes(id);
    const check = _tsCheckHtml(id, label, on);
    const plain = (cls, extra = '') => `<div class="today-search-group today-search-group--empty${cls}" data-type="${id}"><span class="today-search-label">${label}</span>${extra}${check}</div>`;
    if (!on) return plain(' today-search-group--off');
    if (q.length < 2) return plain('');
    const g = _tsGroup(id, slots, _ts.results) || { status: 'loading', items: [], total: 0, errors: [] };
    count += g.items.length;
    // Still searching: dots cycling " " → "." → ".." → "..." (CSS animation, today.css)
    const searching = g.status === 'loading' ? '<span class="today-search-dots" role="status" aria-label="Searching" title="Searching…"></span>' : '';
    if (!g.items.length && !g.errors.length) return plain('', searching || '<span class="today-search-n">0</span>');
    const more = g.total > g.items.length ? `<p class="today-muted today-more">Showing ${g.items.length} of ${g.total}${g.truncated ? '+' : ''} — refine the search</p>`
      : g.truncated ? '<p class="today-muted today-more">Search stopped after 20 s — some folders were skipped</p>' : '';
    const n = g.total > g.items.length ? `${g.items.length} of ${g.total}${g.truncated ? '+' : ''}` : String(g.items.length);
    // Collapsed by default; data-key lets the auto-refresh's state restore keep it as is.
    // The checkbox is the click target inside <summary>, so ticking it doesn't open the category.
    return `<details class="today-search-group" data-type="${id}" data-key="ts-${id}"${_ts.open.has(id) ? ' open' : ''}>
      <summary><span class="today-search-label">${label}</span><span class="today-search-n">${n}</span>${g.errors.length ? '<span class="today-search-warn" title="Some sources failed">⚠</span>' : ''}${searching}${check}</summary>
      ${g.errors.map(e => `<div class="dashboard-source-error">⚠ ${escHtml(e)}</div>`).join('')}
      <div class="today-search-list">${g.items.map(_TS_ROW[id]).join('')}</div>${more}
    </details>`;
  }).join('');
  box.innerHTML = html;
  if (_ts.el) _todaySetCount(_ts.el, count);
}

/** "All" / "None" above the checkboxes. */
function _tsRenderChips() {
  const row = _ts.body?.querySelector('.today-search-types');
  if (!row) return;
  row.innerHTML = '<span class="today-search-all">'
    + '<button type="button" class="today-link-btn" data-ts-all="1" title="Search all sources">All</button>'
    + '<button type="button" class="today-link-btn" data-ts-all="0" title="Leave out all sources">None</button></span>';
}

function _tsBuild(body) {
  body.innerHTML = `<div class="today-search">
    <input type="search" class="today-search-input" placeholder="Search cards, notes, events, mail…" aria-label="Search" autocomplete="off" spellcheck="false">
    <div class="today-search-types"></div>
    <div class="today-search-results"></div>
  </div>`;
  const input = body.querySelector('.today-search-input');
  input.value = _ts.q;
  input.addEventListener('input', () => {
    _ts.q = input.value;
    clearTimeout(_ts.timer);
    if (_ts.q.trim().length < 2) { _tsSearch(); return; }
    _ts.timer = setTimeout(_tsSearch, _TS_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _tsSearch(); }
    else if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; _ts.q = ''; _tsSearch(); }
  });
  // Remember opened categories so results that arrive later (re-render) keep them open
  body.querySelector('.today-search-results').addEventListener('toggle', e => {
    const d = e.target;
    if (!d.matches?.('details.today-search-group')) return;
    if (d.open) _ts.open.add(d.dataset.type); else _ts.open.delete(d.dataset.type);
  }, true);
  const results = body.querySelector('.today-search-results');
  results.addEventListener('click', e => { if (e.target.closest('.today-search-check')) e.stopPropagation(); });
  results.addEventListener('change', e => {
    const box = e.target.closest('.today-search-check');
    if (box) _tsSetType(box.dataset.tsType, box.checked);
  });
  body.querySelector('.today-search-types').addEventListener('click', e => {
    const all = e.target.closest('[data-ts-all]');
    if (all) { e.stopPropagation(); _tsSetAll(all.dataset.tsAll === '1'); }
  });
}

function _todayRenderSearch(body, sources, el) {
  _ts.sources = sources;
  _ts.el = el;
  // Built once: a refresh only updates the rows, so typing / focus are never disturbed
  if (_ts.body !== body || !body.querySelector(':scope > .today-search')) {
    _ts.body = body;
    _tsBuild(body);
  }
  _tsRenderChips();
  // New sources (e.g. a mail account added) are searched for the current query
  if (_ts.q.trim().length >= 2) _tsSearch();
  else _tsRenderResults();
}

TODAY_TILES.search = {
  title: 'Search',
  desc: 'Find cards, notes, calendar events, mail and applications — titles or full text',
  load: () => _todayFetchJson('/api/today/search'),
  render: _todayRenderSearch,
  actions: () => {
    const full = _tsPrefs().full;
    return [{ label: 'Full text', active: full,
      title: full ? 'Searching all text (descriptions, bodies, notes) — click to search titles only'
        : 'Search titles only (title, location, company, subject, addresses) — click for full text',
      run: () => _tsToggleFull() }];
  },
};
