// Find dialog (header menu "Find", Ctrl+F). Opens with an overview of the categories (Cards, Pages,
// Events, Mail — big icons); after a pick, an icon switch in the header bar changes between them.
// Cards / pages: this board (board page) or all boards (Today), filtered in the browser. Events and
// mail are searched server-side (GET /api/today/search/:type, ≥ 3 characters) with account and date
// range filters, mail also by folder; their results open the detail panel.
(function () {
  let selPriorities  = new Set();
  let selColumns     = new Set();
  let searchMode     = null;    // null = overview | 'cards' | 'pages' | 'events' | 'mail'
  let dashMode       = false;
  let _allBoardCards = []; // [{ card, col: {title}, boardName }]
  let _allBoardPages = []; // [{ items, boardName }]
  let _dashLoaded    = false;

  const MIN_CHARS   = 3;
  const DEBOUNCE_MS = 350;
  const REMOTE = new Set(['events', 'mail']);
  let _sources     = null;        // { types, mailAccounts, calendarAccounts } — GET /api/today/search
  const _folders   = new Map();   // mail account id → folder list (promise)
  const _account   = { events: '', mail: '' };   // account filter per mode ('' = all)
  // parts: slot id → { status, items, total, error, truncated, acc }; message: shown instead of results (invalid range)
  let _remote      = { key: '', parts: {}, ctrl: null, timer: 0, message: '' };

  /** Overview of the categories (no mode) or one category's search. */
  function setSearchMode(mode) {
    if (REMOTE.has(mode) && !(_sources?.types || []).includes(mode)) mode = null;
    searchMode = mode;
    document.getElementById('searchOverview').hidden = !!mode;
    document.getElementById('searchMain').hidden     = !mode;
    document.querySelector('.search-scope').hidden    = !mode;
    if (!mode) {
      clearTimeout(_remote.timer);
      document.querySelector('#searchOverview .search-ov-btn:not([hidden])')?.focus();
      return;
    }
    document.getElementById('searchCardFilters').hidden    = mode !== 'cards';
    document.getElementById('searchRangeFilters').hidden   = !REMOTE.has(mode);
    document.getElementById('searchAccountFilters').hidden = !REMOTE.has(mode);
    document.getElementById('searchFolderGroup').hidden    = mode !== 'mail';
    document.getElementById('searchAccountFilters').dataset.mode = mode;   // small screens: grid placement
    document.getElementById('searchMailFullLabel').hidden  = mode !== 'mail';
    document.getElementById('searchRangeBreak').hidden     = mode !== 'mail';
    document.querySelectorAll('.search-scope [data-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
      b.setAttribute('aria-selected', b.dataset.mode === mode ? 'true' : 'false');
    });
    const searchText = document.getElementById('searchText');
    searchText.placeholder = dashMode || REMOTE.has(mode) ? `min. ${MIN_CHARS} characters…` : 'Contains all words…';
    if (REMOTE.has(mode)) renderAccountFilter();
    runSearch(true);
    searchText.select();
    searchText.focus();
  }

  /** Which sources exist (events / mail need accounts): shows their overview tiles and switch buttons. */
  async function loadSources() {
    try {
      const r = await fetch('/api/today/search');
      if (r.ok) _sources = await r.json();
    } catch { /* cards / pages only */ }
    const types = _sources?.types || [];
    for (const t of REMOTE) {
      document.querySelectorAll(`#searchBackdrop [data-mode="${t}"]`).forEach(b => { b.hidden = !types.includes(t); });
    }
  }

  function _accounts(mode = searchMode) {
    return (mode === 'mail' ? _sources?.mailAccounts : _sources?.calendarAccounts) || [];
  }

  /**
   * Account select of the current mode; mail also refreshes the folder select. A single account is
   * selected directly (no "All" entry), so its folders are available right away.
   */
  function renderAccountFilter() {
    const sel = document.getElementById('searchAccount');
    const accounts = _accounts();
    if (accounts.length === 1) _account[searchMode] = accounts[0].id;
    else if (!accounts.some(a => a.id === _account[searchMode])) _account[searchMode] = '';
    sel.innerHTML = (accounts.length > 1 ? `<option value="">${searchMode === 'mail' ? 'All accounts' : 'All calendars'}</option>` : '')
      + accounts.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.label)}</option>`).join('');
    sel.value = _account[searchMode];
    if (searchMode === 'mail') renderFolderFilter();
  }

  /** Folder select: All folders, plus the selectable folders of the chosen account (nested ones indented). */
  async function renderFolderFilter() {
    const sel = document.getElementById('searchMailFolder');
    const accId = _account.mail;
    if (!accId) {
      sel.innerHTML = '<option value="">All folders</option>';
      sel.disabled = true;
      sel.title = 'Choose an account to pick a folder';
      return;
    }
    sel.disabled = false;
    sel.title = '';
    if (!_folders.has(accId)) {
      _folders.set(accId, fetch(`/api/dashboard/mail/${encodeURIComponent(accId)}/folders`)
        .then(r => r.ok ? r.json() : { folders: [] }).then(d => d.folders || []).catch(() => []));
    }
    const keep = sel.value;
    const folders = (await _folders.get(accId)).filter(f => !f.noselect)
      .sort((a, b) => (b.path.toUpperCase() === 'INBOX') - (a.path.toUpperCase() === 'INBOX') || a.path.localeCompare(b.path));
    if (_account.mail !== accId) return;   // account changed meanwhile
    sel.innerHTML = '<option value="">All folders</option>' + folders.map(f => {
      const depth = f.delimiter ? f.path.split(f.delimiter).length - 1 : 0;
      return `<option value="${escHtml(f.path)}">${'\u00a0\u00a0'.repeat(depth)}${escHtml(f.name || f.path)}</option>`;
    }).join('');
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  }

  /** `text`: prefill the search text (Find tile's detailed find). */
  window.openSearch = function ({ text } = {}) {
    // Board page: this board's cards / notes; Today: all boards (results open in place)
    dashMode = ROUTE !== 'board';

    const colGroup = document.querySelector('#searchCardFilters .search-col-group');
    if (colGroup) colGroup.style.display = dashMode ? 'none' : '';
    document.getElementById('searchColBtnGroup').hidden = dashMode;
    toggleColumnPopup(false);

    document.getElementById('searchBackdrop').style.display = 'flex';
    if (typeof text === 'string' && text) document.getElementById('searchText').value = text;
    setSearchMode(null);   // start with the overview of the categories
    loadSources();
    renderPriorityFilter();
    if (!dashMode) renderColumnFilter();

    if (dashMode) {
      _dashLoaded    = false;
      _allBoardCards = [];
      _allBoardPages = [];
      fetchAllBoardsData();
    }
  };

  async function fetchAllBoardsData() {
    let boards = [];
    try {
      const r = await fetch('/api/boards');
      if (r.ok) boards = await r.json();
    } catch {}

    await Promise.all(boards.filter(b => !b.archived).map(async b => {
      await Promise.all([
        (async () => {
          try {
            const r = await fetch(`/api/${encodeURIComponent(b.name)}/all-columns`);
            if (r.ok) {
              const data = await r.json();
              Object.entries(data).forEach(([colTitle, cards]) => {
                cards.forEach(card => _allBoardCards.push({ card, col: { title: colTitle }, boardName: b.name }));
              });
            }
          } catch {}
        })(),
        (async () => {
          try {
            const r = await fetch(`/api/${encodeURIComponent(b.name)}/notes`);
            if (r.ok) {
              const notes = await r.json();
              _allBoardPages.push({ items: notes.items || notes.pages || [], boardName: b.name });
            }
          } catch {}
        })(),
      ]);
    }));

    _dashLoaded = true;
    runSearch();
  }

  window.closeSearch = function () {
    document.getElementById('searchBackdrop').style.display = 'none';
  };

  // ---- Priority filter (multi-select toggles) ----
  function renderPriorityFilter() {
    const row = document.getElementById('searchPriorityRow');
    row.innerHTML = [0, 1, 2, 3, 4, 5].map(p => {
      const on    = selPriorities.has(p);
      const label = p === 0 ? '—' : PRIORITY_LABELS[p];
      const col   = p > 0 ? PRIORITY_COLORS[p] : null;
      const style = on && col ? `background:${col};border-color:${col};color:#fff`
                  : on        ? 'background:var(--surface);border-color:var(--accent);color:var(--text)'
                  : col       ? `color:${col}`
                  : '';
      return `<button class="priority-btn search-prio-btn" data-p="${p}" style="${style}">${label}</button>`;
    }).join('');
    row.querySelectorAll('.search-prio-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = +btn.dataset.p;
        if (selPriorities.has(p)) selPriorities.delete(p);
        else selPriorities.add(p);
        renderPriorityFilter();
        runSearch();
      });
    });
  }

  // ---- Column filter (checkboxes, all checked = no filter) ----
  // Inbox* columns are collapsed into one "Inbox" checkbox.
  function buildColumnItems() {
    const items = [];
    let inboxPushed = false;
    state.columns.forEach(col => {
      if (/^inbox/i.test(col.title)) {
        if (!inboxPushed) {
          inboxPushed = true;
          items.push({ label: 'Inbox', ids: [] });
        }
        items[items.length - 1].ids.push(col.id);
      } else {
        items.push({ label: col.title, ids: [col.id] });
      }
    });
    return items;
  }

  function renderColumnFilter() {
    const list   = document.getElementById('searchColumnList');
    const toggle = document.getElementById('searchColToggleAll');
    const items  = buildColumnItems();
    const allIds = state.columns.map(c => c.id);
    // selColumns.size === 0 means "all columns" (no filter active).
    // '__none__' sentinel means "no columns" (filter active, nothing passes).
    const allOn  = selColumns.size === 0;
    const noneOn = selColumns.size === 1 && selColumns.has('__none__');

    toggle.textContent = allOn ? 'deselect all' : 'select all';
    const nOn = allOn ? items.length : noneOn ? 0 : items.filter(item => item.ids.every(id => selColumns.has(id))).length;
    document.getElementById('searchColBtn').textContent = allOn ? 'All' : `${nOn} of ${items.length}`;

    list.innerHTML = items.map((item, i) => {
      const checked = allOn || (!noneOn && item.ids.every(id => selColumns.has(id)));
      return `<label class="search-col-label">
        <input type="checkbox" class="search-col-cb" data-idx="${i}"${checked ? ' checked' : ''}>
        <span>${escHtml(item.label)}</span>
      </label>`;
    }).join('');

    list.querySelectorAll('.search-col-cb').forEach((cb, i) => {
      cb.addEventListener('change', () => {
        if (selColumns.size === 0) allIds.forEach(id => selColumns.add(id));
        selColumns.delete('__none__');
        if (cb.checked) items[i].ids.forEach(id => selColumns.add(id));
        else            items[i].ids.forEach(id => selColumns.delete(id));
        if (allIds.every(id => selColumns.has(id))) selColumns.clear();
        renderColumnFilter();
        runSearch();
      });
    });

    toggle.onclick = () => {
      if (allOn) {
        selColumns.add('__none__'); // deselect all — sentinel keeps size > 0 so filter is active
      } else {
        selColumns.clear(); // select all — size === 0 means no filter
      }
      renderColumnFilter();
      runSearch();
    };
  }

  /** Small screens: the column list is a popup below the card filters (#searchColBtn). */
  function toggleColumnPopup(open) {
    const group = document.querySelector('#searchCardFilters .search-col-group');
    const btn = document.getElementById('searchColBtn');
    if (!group || !btn) return;
    const on = open ?? !group.classList.contains('search-col-group--open');
    group.classList.toggle('search-col-group--open', on);
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  // ---- Search logic ----
  function normalize(str) {
    return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function collectPages(items, words, acc, breadcrumb, boardName) {
    for (const item of items) {
      if (item.type === 'folder') {
        collectPages(item.children || [], words, acc, [...breadcrumb, item], boardName);
        continue;
      }
      const path = [...breadcrumb, item];
      const hay  = normalize(item.title + ' ' + (item.description || ''));
      if (words.length === 0 || words.every(w => hay.includes(w)))
        acc.push({ page: item, path, boardName });
    }
  }

  // ---- Events / mail: server-side search ----

  /** Requests for the current filters: events one (all calendars or one), mail one per account (or the chosen one). */
  function remoteSlots() {
    if (searchMode === 'events') return [{ id: 'events', type: 'events', account: _account.events }];
    const folder = _account.mail ? document.getElementById('searchMailFolder').value : '';
    return (_sources?.mailAccounts || []).filter(a => !_account.mail || a.id === _account.mail)
      .map(acc => ({ id: `mail:${acc.id}`, type: 'mail', acc, account: acc.id, folder }));
  }

  function remoteUrl(slot, q) {
    const p = new URLSearchParams({ q });
    if (slot.type === 'events' || document.getElementById('searchMailFull').checked) p.set('full', '1');
    const from = document.getElementById('searchFrom').value, to = document.getElementById('searchTo').value;
    if (from) p.set('from', from);
    if (to)   p.set('to', to);
    if (slot.account) p.set('account', slot.account);
    if (slot.folder)  p.set('folder', slot.folder);
    return `/api/today/search/${slot.type}?${p}`;
  }

  /** Debounced while typing; `now` for mode / filter changes. Results are kept per query + filters. */
  function scheduleRemote(now) {
    clearTimeout(_remote.timer);
    if (now) { remoteSearch(); return; }
    _remote.timer = setTimeout(remoteSearch, DEBOUNCE_MS);
    renderRemote();
  }

  function remoteSearch() {
    clearTimeout(_remote.timer);
    const q = document.getElementById('searchText').value.trim();
    const from = document.getElementById('searchFrom').value, to = document.getElementById('searchTo').value;
    _remote.message = from && to && from > to ? '"From" is after "To".' : '';
    if (_remote.message) {
      _remote.ctrl?.abort();
      _remote.key = '';
      _remote.parts = {};
      renderRemote();
      return;
    }
    const slots = q.length >= MIN_CHARS ? remoteSlots() : [];
    const key = q.length >= MIN_CHARS ? slots.map(s => remoteUrl(s, q)).join(' ') : '';
    if (key === _remote.key) { renderRemote(); return; }
    _remote.ctrl?.abort();
    _remote.ctrl = new AbortController();
    _remote.key = key;
    _remote.parts = {};
    const { signal } = _remote.ctrl;
    for (const slot of slots) {
      _remote.parts[slot.id] = { status: 'loading', acc: slot.acc };
      fetch(remoteUrl(slot, q), { signal })
        .then(async r => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
          return data;
        })
        .then(data => {
          if (_remote.key !== key) return;
          _remote.parts[slot.id] = { status: 'done', acc: slot.acc, items: data.items || [], total: data.total ?? (data.items || []).length,
            truncated: !!data.truncated, errors: data.errors || [] };
          renderRemote();
        })
        .catch(err => {
          if (err.name === 'AbortError' || _remote.key !== key) return;
          _remote.parts[slot.id] = { status: 'error', acc: slot.acc, error: err.message };
          renderRemote();
        });
    }
    renderRemote();
  }

  function renderRemote() {
    const box = document.getElementById('searchResults');
    const count = document.getElementById('searchCount');
    const q = document.getElementById('searchText').value.trim();
    const message = _remote.message;
    if (message || q.length < MIN_CHARS) {
      box.innerHTML = `<p class="search-empty">${escHtml(message || `Type at least ${MIN_CHARS} characters.`)}</p>`;
      count.textContent = '';
      return;
    }
    const parts = Object.values(_remote.parts);
    const loading = !parts.length || parts.some(p => p.status === 'loading');
    const errors = [];
    for (const p of parts) {
      if (p.status === 'error') errors.push(p.acc ? `${p.acc.label}: ${p.error}` : p.error);
      for (const e of p.errors || []) errors.push(e);
    }
    const done = parts.filter(p => p.status === 'done');
    let items = done.flatMap(p => p.items.map(it => ({ it, acc: p.acc })));
    if (searchMode === 'mail') items.sort((a, b) => String(b.it.date || '').localeCompare(String(a.it.date || '')));
    const total = done.reduce((n, p) => n + (p.total || 0), 0);
    const truncated = done.some(p => p.truncated);
    count.textContent = loading ? 'Searching…'
      : `${total > items.length ? `${items.length} of ${total}${truncated ? '+' : ''}` : items.length} ${items.length === 1 && total <= 1 ? 'result' : 'results'}`;
    box.innerHTML = '';
    for (const e of errors) box.insertAdjacentHTML('beforeend', `<div class="dashboard-source-error">⚠ ${escHtml(e)}</div>`);
    if (!items.length) {
      box.insertAdjacentHTML('beforeend', `<p class="search-empty">${loading ? 'Searching…' : searchMode === 'events' ? 'No events match.' : 'No mail matches.'}</p>`);
      return;
    }
    for (const { it, acc } of items) box.appendChild(searchMode === 'events' ? eventItem(it) : mailItem(it, acc));
    if (total > items.length) box.insertAdjacentHTML('beforeend', '<p class="search-empty">Showing the newest hits — refine the search or narrow the date range.</p>');
    else if (truncated) box.insertAdjacentHTML('beforeend', '<p class="search-empty">Search stopped after 20 s — some folders were skipped.</p>');
  }

  // Result dates carry the year unless it is the current one (date ranges may reach into other years)
  function eventWhen(ev) {
    if (!ev.start) return '';
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(ev.start);
    const day = allDay ? ev.start : _todayLocalDay(new Date(ev.start));
    const year = day.slice(0, 4) !== String(new Date().getFullYear()) ? ` ${day.slice(0, 4)}` : '';
    return `${fmtDate(day)}${year}${allDay ? '' : ` ${_todayFmtTime(ev.start)}`}`;
  }

  function mailWhen(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d) || d.getFullYear() === new Date().getFullYear()) return _fmtRecentDate(date);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  }

  function eventItem(ev) {
    // Same tagging as the agenda, so the detail panel and its Edit / context menu find the event
    _calEventMap.set(`${ev.accountId}\0${ev.uid}`, { ...ev, _label: ev.label, _accountId: ev.accountId, _webUrl: ev.webUrl || '',
      _color: ev.color || null, _accountType: ev.accountType || 'caldav' });
    const title = _todayDecodeEntities(ev.title);
    const loc   = _todayDecodeEntities(ev.location).trim();
    const past  = new Date(ev.end || ev.start) < new Date();
    const el = document.createElement('div');
    el.className = 'search-result-item search-result-event' + (past ? ' search-result--past' : '');
    if (ev.color) el.style.setProperty('--card-color', ev.color);
    el.innerHTML = `<div class="search-result-col-label">${escHtml(eventWhen(ev))}${ev.label ? ` · ${escHtml(ev.label)}` : ''}</div>
      <div class="search-result-text">${escHtml(title || '(no title)')}</div>`
      + (loc ? `<div class="search-result-preview">${escHtml(loc)}</div>` : '');
    el.addEventListener('click', async () => {
      closeSearch();
      await _initOverlayHost();
      _openEventDetail(ev.accountId, ev.uid, ev.webUrl || '');
    });
    return el;
  }

  function mailItem(msg, acc) {
    const el = document.createElement('div');
    el.className = 'search-result-item search-result-mail' + (msg.unread ? ' search-result--unread' : '');
    if (acc.color) el.style.setProperty('--card-color', acc.color);
    const where = (_sources?.mailAccounts || []).length > 1 ? `${acc.label} / ${msg.folder || ''}` : (msg.folder || '');
    el.innerHTML = `<div class="search-result-col-label">${escHtml(mailWhen(msg.date))} · ${escHtml(where)}</div>
      <div class="search-result-text">${escHtml(msg.subject || '(no subject)')}</div>
      <div class="search-result-preview">${escHtml(_mailDisplayName(msg.from) || '')}</div>`;
    el.addEventListener('click', async () => {
      closeSearch();
      await _initOverlayHost();
      _openMailDetail(acc.id, msg.id, acc.webInterfaceUrl || '', msg.folder || undefined);
    });
    return el;
  }

  function runSearch(now) {
    if (!searchMode) return;   // overview
    if (REMOTE.has(searchMode)) { scheduleRemote(now === true); return; }
    const query     = normalize(document.getElementById('searchText').value.trim());
    const words     = query ? query.split(/\s+/) : [];
    const dateStart = document.getElementById('searchDateStart').value;
    const dateEnd   = document.getElementById('searchDateEnd').value;

    if (searchMode === 'cards') {
      if (dashMode) {
        if (!_dashLoaded) { renderCardResults(null); return; }
        if (query.length < 3) { renderCardResults([]); return; }
        const results = [];
        _allBoardCards.forEach(({ card, col, boardName }) => {
          if (words.length > 0) {
            const hay = normalize(card.text + ' ' + (card.description || ''));
            if (!words.every(w => hay.includes(w))) return;
          }
          if (selPriorities.size > 0 && !selPriorities.has(card.priority || 0)) return;
          if (dateStart && (!card.startDate || card.startDate < dateStart)) return;
          if (dateEnd   && (!card.endDate   || card.endDate   > dateEnd))   return;
          results.push({ card, col, boardName });
        });
        renderCardResults(results);
      } else {
        const results = [];
        state.columns.forEach(col => {
          if (selColumns.size > 0 && !selColumns.has(col.id)) return;
          col.cards.forEach(card => {
            if (words.length > 0) {
              const hay = normalize(card.text + ' ' + (card.description || ''));
              if (!words.every(w => hay.includes(w))) return;
            }
            if (selPriorities.size > 0 && !selPriorities.has(card.priority || 0)) return;
            if (dateStart && (!card.startDate || card.startDate < dateStart)) return;
            if (dateEnd   && (!card.endDate   || card.endDate   > dateEnd))   return;
            results.push({ card, col });
          });
        });
        renderCardResults(results);
      }
    } else {
      if (dashMode) {
        if (!_dashLoaded) { renderPageResults(null); return; }
        if (query.length < 3) { renderPageResults([]); return; }
        const results = [];
        _allBoardPages.forEach(({ items, boardName }) =>
          collectPages(items, words, results, [], boardName));
        renderPageResults(results);
      } else {
        const results = [];
        const _ns = (typeof notesState !== 'undefined' ? notesState : null)
          || window._notesModule?.getNotesState() || null;
        if (_ns)
          collectPages(_ns.items || _ns.pages || [], words, results, []);
        renderPageResults(results);
      }
    }
  }

  // ---- Result rendering ----
  function renderCardResults(results) {
    const box = document.getElementById('searchResults');
    if (results === null) {
      box.innerHTML = '<p class="search-empty">Loading…</p>';
      document.getElementById('searchCount').textContent = '';
      return;
    }
    document.getElementById('searchCount').textContent =
      results.length + (results.length === 1 ? ' result' : ' results');

    if (!results.length) { box.innerHTML = '<p class="search-empty">No cards match.</p>'; return; }
    box.innerHTML = '';

    results.forEach(({ card, col, boardName }) => {
      const today   = new Date().toISOString().slice(0, 10);
      const overdue = !card.done && card.endDate && card.endDate < today;
      const meta    = [];
      if (card.priority) {
        const pc = PRIORITY_COLORS[card.priority];
        meta.push(`<span class="priority-badge" style="background:${pc}22;color:${pc}">${PRIORITY_LABELS[card.priority]}</span>`);
      }
      if (card.startDate || card.endDate) {
        const cls = overdue ? 'card-date card-date--overdue' : 'card-date';
        if (card.startDate && card.endDate)
          meta.push(`<span class="${cls}">${fmtDate(card.startDate)} → ${fmtDate(card.endDate)}</span>`);
        else if (card.startDate)
          meta.push(`<span class="${cls}">${fmtDate(card.startDate)} →</span>`);
        else
          meta.push(`<span class="${cls}">→ ${fmtDate(card.endDate)}</span>`);
      }
      if (card.description) meta.push(`<span class="card-desc" title="${escHtml(card.description)}">${SVGICONS.description()}</span>`);
      if (card.done)        meta.push(`<span class="card-done-mark">${ICONS.done} done</span>`);
      if (card.duplicate && !dashMode) {
        const originalCol = state.columns.find(c => c.cards.some(c2 => c2.id !== card.id && c2.text === card.text && !c2.duplicate));
        const tip = originalCol ? `Also in: &quot;${escHtml(originalCol.title)}&quot;` : 'Duplicate card';
        meta.push(`<span class="card-duplicate-badge" title="${tip}">duplicate</span>`);
      }
      const metaHtml  = meta.length ? `<div class="card-meta">${meta.join('')}</div>` : '';
      const colLabel  = dashMode ? `${boardName} › ${col.title}` : col.title;
      const color     = card.color || (dashMode ? COL_COLORS[0] : (col.color || COL_COLORS[state.columns.indexOf(col) % COL_COLORS.length]));

      const el = document.createElement('div');
      el.className = 'search-result-item';
      el.style.setProperty('--card-color', color);
      el.innerHTML = `<div class="search-result-col-label">${escHtml(colLabel)}</div>
        <div class="search-result-text">${escHtml(card.text)}</div>${metaHtml}`;
      if (dashMode) {
        el.addEventListener('click', () => { closeSearch(); _todayEditCard(boardName, card.id); });
      } else {
        el.addEventListener('click', () => { closeSearch(); openEditModal(col.id, card); });
        el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, col.id, card); });
      }
      box.appendChild(el);
    });
  }

  function renderPageResults(results) {
    const box = document.getElementById('searchResults');
    if (results === null) {
      box.innerHTML = '<p class="search-empty">Loading…</p>';
      document.getElementById('searchCount').textContent = '';
      return;
    }
    document.getElementById('searchCount').textContent =
      results.length + (results.length === 1 ? ' result' : ' results');

    if (!results.length) { box.innerHTML = '<p class="search-empty">No pages match.</p>'; return; }
    box.innerHTML = '';

    results.forEach(({ page, path, boardName }) => {
      const crumb      = path.map(p => p.title).join(' › ');
      const breadcrumb = dashMode ? (boardName + (crumb ? ' › ' + crumb : '')) : crumb;
      const preview    = (page.description || '').replace(/[#*`_[\]]/g, '').trim().slice(0, 80);
      const el = document.createElement('div');
      el.className = 'search-result-item search-result-page';
      el.innerHTML =
        `<div class="search-result-col-label">${escHtml(breadcrumb)}</div>` +
        `<div class="search-result-text">${escHtml(page.title)}</div>` +
        (preview ? `<div class="search-result-preview">${escHtml(preview)}${(page.description?.length ?? 0) > 80 ? '…' : ''}</div>` : '');
      if (dashMode) {
        el.addEventListener('click', () => { closeSearch(); _todayEditNote(boardName, page.id); });
      } else {
        el.addEventListener('click', () => { closeSearch(); window._notesModule?.openNoteModal(page.id); });
      }
      box.appendChild(el);
    });
  }

  // ---- Event wiring ----
  document.addEventListener('DOMContentLoaded', () => {
    const rerun = () => runSearch();
    document.getElementById('searchText').addEventListener('input', rerun);
    document.getElementById('searchDateStart').addEventListener('change', rerun);
    document.getElementById('searchDateEnd').addEventListener('change', rerun);

    const now = () => runSearch(true);
    for (const id of ['searchFrom', 'searchTo', 'searchMailFolder', 'searchMailFull']) document.getElementById(id).addEventListener('change', now);
    document.getElementById('searchAccount').addEventListener('change', e => {
      _account[searchMode] = e.target.value;
      if (searchMode === 'mail') {
        document.getElementById('searchMailFolder').value = '';
        renderFolderFilter();
      }
      now();
    });
    document.getElementById('searchText').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); now(); } });
    document.getElementById('searchColBtn').addEventListener('click', e => { e.stopPropagation(); toggleColumnPopup(); });
    document.getElementById('searchBackdrop').addEventListener('click', e => {
      if (!e.target.closest('.search-col-group, #searchColBtn')) toggleColumnPopup(false);
    });
    // Overview tiles and header switch
    document.querySelectorAll('#searchBackdrop [data-mode]').forEach(b => b.addEventListener('click', () => setSearchMode(b.dataset.mode)));

    document.getElementById('searchBackdrop').addEventListener('click', e => {
      if (e.target === document.getElementById('searchBackdrop')) closeSearch();
    });
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      if (document.getElementById('searchBackdrop').style.display !== 'none') return;
      e.preventDefault();
      openSearch();
    }
    if (e.key === 'Escape' && document.getElementById('searchBackdrop').style.display !== 'none') {
      closeSearch();
    }
  });
})();
