(function () {
  let selPriorities  = new Set();
  let selColumns     = new Set();
  let searchMode     = 'cards'; // 'cards' | 'pages'
  let dashMode       = false;
  let _allBoardCards = []; // [{ card, col: {title}, boardName }]
  let _allBoardPages = []; // [{ items, boardName }]
  let _dashLoaded    = false;

  function setSearchMode(mode) {
    searchMode = mode;
    document.getElementById('searchCardFilters').style.display = mode === 'cards' ? '' : 'none';
    document.getElementById('searchToggleCards').classList.toggle('search-type-btn--active', mode === 'cards');
    document.getElementById('searchTogglePages').classList.toggle('search-type-btn--active', mode === 'pages');
    runSearch();
  }

  window.openSearch = function () {
    const onDashboard = document.getElementById('dashboard').style.display !== 'none';
    if (!API && !onDashboard) return;
    dashMode = onDashboard && !API;

    const colGroup = document.querySelector('#searchCardFilters .search-col-group');
    if (colGroup) colGroup.style.display = dashMode ? 'none' : '';

    document.getElementById('searchBackdrop').style.display = 'flex';
    setSearchMode(searchMode);
    renderPriorityFilter();
    if (!dashMode) renderColumnFilter();

    if (dashMode) {
      _dashLoaded    = false;
      _allBoardCards = [];
      _allBoardPages = [];
      runSearch(); // shows loading state immediately
      fetchAllBoardsData();
    } else {
      runSearch();
    }
    const searchText = document.getElementById('searchText');
    searchText.placeholder = dashMode ? 'min. 3 characters…' : 'Contains all words…';
    searchText.select();
    searchText.focus();
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

  function runSearch() {
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
        if (typeof notesState !== 'undefined')
          collectPages(notesState.items || notesState.pages || [], words, results, []);
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
        el.addEventListener('click', () => window.open(`/board/${encodeURIComponent(boardName)}#card:${card.id}`, '_blank', 'noopener,noreferrer'));
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
        el.addEventListener('click', () => window.open(`/board/${encodeURIComponent(boardName)}#note:${page.id}`, '_blank', 'noopener,noreferrer'));
      } else {
        el.addEventListener('click', () => { closeSearch(); openNoteModal(page.id); });
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

    document.getElementById('searchToggleCards').addEventListener('click', () => setSearchMode('cards'));
    document.getElementById('searchTogglePages').addEventListener('click', () => setSearchMode('pages'));

    document.getElementById('searchBackdrop').addEventListener('click', e => {
      if (e.target === document.getElementById('searchBackdrop')) closeSearch();
    });
  });

  document.addEventListener('keydown', e => {
    const onDashboard = document.getElementById('dashboard').style.display !== 'none';
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && (API || onDashboard)) {
      if (document.getElementById('searchBackdrop').style.display !== 'none') return;
      e.preventDefault();
      openSearch();
    }
    if (e.key === 'Escape' && document.getElementById('searchBackdrop').style.display !== 'none') {
      closeSearch();
    }
  });
})();
