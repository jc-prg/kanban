(function () {
  let selPriorities = new Set(); // empty = show all
  let selColumns    = new Set(); // empty = show all

  window.openSearch = function () {
    if (!API) return;
    document.getElementById('searchBackdrop').style.display = 'flex';
    renderPriorityFilter();
    renderColumnFilter();
    runSearch();
    document.getElementById('searchText').select();
    document.getElementById('searchText').focus();
  };

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
    const list  = document.getElementById('searchColumnList');
    const items = buildColumnItems();
    const allIds = state.columns.map(c => c.id);

    list.innerHTML = items.map((item, i) => {
      const checked = selColumns.size === 0 || item.ids.every(id => selColumns.has(id));
      return `<label class="search-col-label">
        <input type="checkbox" class="search-col-cb" data-idx="${i}"${checked ? ' checked' : ''}>
        <span>${escHtml(item.label)}</span>
      </label>`;
    }).join('');

    list.querySelectorAll('.search-col-cb').forEach((cb, i) => {
      cb.addEventListener('change', () => {
        if (selColumns.size === 0) allIds.forEach(id => selColumns.add(id));
        if (cb.checked) items[i].ids.forEach(id => selColumns.add(id));
        else            items[i].ids.forEach(id => selColumns.delete(id));
        if (allIds.every(id => selColumns.has(id))) selColumns.clear();
        runSearch();
      });
    });
  }

  // ---- Search logic ----
  function normalize(str) {
    return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function runSearch() {
    const query     = normalize(document.getElementById('searchText').value.trim());
    const words     = query ? query.split(/\s+/) : [];
    const dateStart = document.getElementById('searchDateStart').value;
    const dateEnd   = document.getElementById('searchDateEnd').value;

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

    renderResults(results);
  }

  // ---- Result rendering ----
  function renderResults(results) {
    const box   = document.getElementById('searchResults');
    const count = document.getElementById('searchCount');
    count.textContent = results.length + (results.length === 1 ? ' result' : ' results');

    if (!results.length) {
      box.innerHTML = '<p class="search-empty">No cards match.</p>';
      return;
    }

    box.innerHTML = results.map(({ card, col }, i) => {
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
      if (card.description) meta.push(`<span class="card-desc" title="${escHtml(card.description)}">☰</span>`);
      if (card.done)        meta.push(`<span class="card-done-mark">✓ done</span>`);

      const metaHtml = meta.length ? `<div class="card-meta">${meta.join('')}</div>` : '';
      const colIdx   = state.columns.indexOf(col);
      const color    = card.color || col.color || COL_COLORS[colIdx % COL_COLORS.length];

      return `<div class="search-result-item" data-idx="${i}" style="--card-color:${color}">
        <div class="search-result-col-label">${escHtml(col.title)}</div>
        <div class="card-body">
          <div class="search-result-text">${escHtml(card.text)}</div>
          ${metaHtml}
        </div>
      </div>`;
    }).join('');

    box.querySelectorAll('.search-result-item').forEach((el, i) => {
      el.addEventListener('click', () => {
        const { card, col } = results[i];
        closeSearch();
        openEditModal(col.id, card);
      });
    });
  }

  // ---- Event wiring ----
  document.addEventListener('DOMContentLoaded', () => {
    const rerun = () => runSearch();
    document.getElementById('searchText').addEventListener('input', rerun);
    document.getElementById('searchDateStart').addEventListener('change', rerun);
    document.getElementById('searchDateEnd').addEventListener('change', rerun);

    document.getElementById('searchBackdrop').addEventListener('click', e => {
      if (e.target === document.getElementById('searchBackdrop')) closeSearch();
    });
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && API) {
      if (document.getElementById('searchBackdrop').style.display !== 'none') return;
      e.preventDefault();
      openSearch();
    }
    if (e.key === 'Escape' && document.getElementById('searchBackdrop').style.display !== 'none') {
      closeSearch();
    }
  });
})();
