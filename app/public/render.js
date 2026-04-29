// ---- Render helpers ----
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[+m-1]} ${+d}`;
}

function safeLink(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? url : '';
  } catch { return ''; }
}

function getLinkBadgeHtml(url, href) {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  const a = (bg, inner) =>
    `<a class="card-link-badge" href="${escHtml(href)}" target="_blank" rel="noopener" title="${escHtml(url)}" style="background:${bg}">${inner}</a>`;
  const svg = (viewBox, path) =>
    `<svg viewBox="${viewBox}" width="11" height="11" xmlns="http://www.w3.org/2000/svg" fill="white">${path}</svg>`;

  if (host.includes('linkedin.com')) {
    return a('#0077b5', svg('0 0 16 16',
      `<path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526
       1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854zm4.943 12.248V6.169H2.542v7.225zm-1.2-8.212c.837
       0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248S2.4 3.226 2.4 3.934c0 .694.521 1.248
       1.327 1.248zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662
       1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165
       1.193v.025h-.016l.016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225z"/>`
    ));
  }

  if (host.includes('xing.com')) {
    return a('#026466', svg('0 0 24 24',
      `<path d="M18.188 0c-.517 0-.741.325-.927.66L9.559 14.317l4.919 9.023c.17.308.436.66.967.66h3.454
       c.211 0 .375-.078.463-.22.089-.151.089-.346-.009-.536l-4.879-8.916L22.139.756c.095-.191.097-.387
       .006-.535C22.056.078 21.894 0 21.686 0zM3.648 4.74c-.211 0-.385.074-.473.216-.09.149-.078.339.02
       .531l2.34 4.05L1.86 16.051c-.099.188-.093.381 0 .529.085.142.239.234.45.234h3.461c.518 0
       .766-.348.945-.667l3.734-6.609-2.378-4.155c-.172-.315-.434-.659-.962-.659z"/>`
    ));
  }

  if (host.includes('stepstone.')) {
    return a('#E31837', svg('0 0 16 16',
      `<rect x="0" y="8" width="10" height="7" rx="5"/>
       <rect x="7.5" y="4" width="7" height="4" rx="3"/>
       <rect x="2" y="2" width="4" height="3" rx="2"/>`
    ));
  }

  if (host.includes('miro.com')) {
    return a('#FFD02F', svg('127 55 203 203',
      `<path fill="#050038" d="M267.88,80.5h-22.26l18.54,32.58l-40.8-32.58H201.1l20.4,39.84L178.84,80.5h-22.26l22.26,50.7l-22.26,101.4h22.26l42.66-108.66L201.1,232.6h22.26l40.8-115.86L245.62,232.6h22.26l40.8-126.78L267.88,80.5z"/>`
    ));
  }

  if (!host) return `<a class="card-link-badge card-link-badge--fallback" href="${escHtml(href)}" target="_blank" rel="noopener" title="${escHtml(url)}">></a>`;
  return `<a class="card-link-badge card-link-badge--favicon" href="${escHtml(href)}" target="_blank" rel="noopener" title="${escHtml(url)}">` +
    `<img src="https://${host}/favicon.ico" alt="" ` +
    `onerror="this.parentElement.classList.replace('card-link-badge--favicon','card-link-badge--fallback');this.parentElement.textContent='>'">` +
    `</a>`;
}

// ---- Render ----
function _buildNoteLinkedSet() {
  const s = new Set();
  if (typeof notesState === 'undefined') return s;
  (function collect(pages) {
    for (const p of pages) {
      for (const id of (p.linkedCards || [])) s.add(id);
      collect(p.children || []);
    }
  })(notesState.pages);
  return s;
}

function render() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const builtCols = [];
  const noteLinkedCards = _buildNoteLinkedSet();

  state.columns.forEach((col, ci) => {
    const color = col.color || COL_COLORS[ci % COL_COLORS.length];

    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.colId = col.id;
    colEl.setAttribute('dragover', 'true');

    colEl.addEventListener('dragstart', e => {
      if (e.target.closest('.col-drag-handle')) onColDragStart(e, col.id);
    });
    colEl.addEventListener('dragend', () => { if (colDragState) onColDragEnd(); });
    colEl.addEventListener('dragover', e => {
      if (colDragState) {
        if (colDragState.colId === col.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const isLeft = e.clientX < colEl.getBoundingClientRect().left + colEl.offsetWidth / 2;
        colEl.classList.toggle('col-drop-left', isLeft);
        colEl.classList.toggle('col-drop-right', !isLeft);
      } else if (dragState) {
        onDragOver(e, col.id);
        colEl.classList.add('drag-over');
      }
    });
    colEl.addEventListener('dragleave', e => {
      if (!colEl.contains(e.relatedTarget)) {
        colEl.classList.remove('drag-over', 'col-drop-left', 'col-drop-right');
        colEl.querySelectorAll('.drop-indicator.active').forEach(el => el.classList.remove('active'));
      }
    });
    colEl.addEventListener('drop', e => {
      colEl.classList.remove('drag-over', 'col-drop-left', 'col-drop-right');
      if (colDragState) onColDrop(e, col.id);
      else onDrop(e, col.id);
    });

    colEl.innerHTML = `
      <div class="column-header">
        <div class="col-drag-handle" draggable="true" title="Drag to reorder">⠿</div>
        <div class="column-dot" style="background:${color}"></div>
        <input class="column-title" value="${escHtml(col.title)}" spellcheck="false" />
        <button class="col-btn" title="Column options" style="margin-left:auto">⋮</button>
        <span class="column-count">${col.cards.filter(c => !c.text.startsWith('#')).length}</span>
      </div>
      <div class="cards"></div>
      <button class="add-card-btn">+ add card</button>
    `;

    colEl.querySelector('.col-drag-handle').addEventListener('touchstart', e => {
      e.preventDefault();
      const t = e.touches[0];
      touchPending = { el: colEl, sx: t.clientX, sy: t.clientY };
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = setTimeout(() => {
        if (!touchPending) return;
        const ghost = spawnGhost(colEl, touchPending.sx, touchPending.sy);
        colEl.classList.add('dragging-col');
        touchDrag = { type: 'col', colId: col.id, sourceEl: colEl, ghost };
        touchPending = null;
        touchLongPressTimer = null;
      }, 500);
    }, { passive: false });

    colEl.querySelector('.column-header').addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      showColContextMenu(e.clientX, e.clientY, col.id);
    });

    colEl.querySelector('.column-header').addEventListener('dblclick', e => {
      if (e.target.closest('.column-title, .col-btn, .col-drag-handle')) return;
      if (colCollapsed.has(col.id)) colCollapsed.delete(col.id);
      else colCollapsed.add(col.id);
      persistCollapseState();
      render();
    });

    let lastTap = 0;
    colEl.querySelector('.column-header').addEventListener('touchend', e => {
      if (e.target.closest('.column-title, .col-btn, .col-drag-handle')) return;
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        if (colCollapsed.has(col.id)) colCollapsed.delete(col.id);
        else colCollapsed.add(col.id);
        persistCollapseState();
        render();
      }
      lastTap = now;
    });

    const titleInput = colEl.querySelector('.column-title');
    titleInput.addEventListener('change', () => updateColumnTitle(col.id, titleInput.value));
    titleInput.addEventListener('blur',   () => updateColumnTitle(col.id, titleInput.value));

    const colMenuBtn = colEl.querySelector('.col-btn');
    colMenuBtn.addEventListener('mousedown', e => e.stopPropagation());
    colMenuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const rect = colMenuBtn.getBoundingClientRect();
      showColContextMenu(rect.left, rect.bottom + 4, col.id);
    });

    colEl.querySelector('.add-card-btn').addEventListener('click', () => openModal(col.id));

    const cardsEl = colEl.querySelector('.cards');
    const limit    = colVisible[col.id] || CARDS_PER_PAGE;
    const visible  = col.cards.slice(0, limit);
    const remaining = col.cards.length - limit;

    visible.forEach(card => {
      const isLabel = card.text.startsWith('#');
      const displayText = isLabel ? card.text.slice(1).trimStart() : card.text;

      const cardEl = document.createElement('div');
      cardEl.className = 'card' + (card.done ? ' card--done' : '') + (isLabel ? ' card--label' : '');
      cardEl.dataset.cardId = card.id;
      cardEl.draggable = true;
      cardEl.style.setProperty('--card-color', card.color || color);

      const metaParts = [];
      if (card.description) {
        metaParts.push(`<span class="card-desc" title="${escHtml(card.description)}">☰</span>`);
      }
      if (cardAttachSet.has(card.id)) {
        metaParts.push(`<span class="card-attach-badge" title="Has attachments"><svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M10 5.5L5.5 10a3 3 0 0 1-4.2-4.2L7 0.8a2 2 0 0 1 2.8 2.8L4.1 9.3A1 1 0 0 1 2.7 7.9L8 2.5"></path></svg></span>`);
      }
      if (noteLinkedCards.has(card.id)) {
        metaParts.push(`<span class="card-note-badge" title="Linked in notes"><svg viewBox="0 0 11 14" width="9" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1.5h6l3 3.5v8H1z"/><path d="M7 1.5V5h3"/></svg></span>`);
      }
      if (card.priority) {
        const pc = PRIORITY_COLORS[card.priority];
        metaParts.push(`<span class="priority-badge" style="background:${pc}22;color:${pc}">${PRIORITY_LABELS[card.priority]}</span>`);
      }
      if (card.startDate || card.endDate) {
        const today = new Date().toISOString().slice(0, 10);
        const overdue = !card.done && card.endDate && card.endDate < today;
        const cls = overdue ? 'card-date card-date--overdue' : 'card-date';
        if (card.startDate && card.endDate)
          metaParts.push(`<span class="${cls}">${fmtDate(card.startDate)} → ${fmtDate(card.endDate)}</span>`);
        else if (card.startDate)
          metaParts.push(`<span class="${cls}">${fmtDate(card.startDate)} →</span>`);
        else
          metaParts.push(`<span class="${cls}">→ ${fmtDate(card.endDate)}</span>`);
      }
      if (card.done) {
        metaParts.push(`<span class="card-done-mark">✓ done</span>`);
      }

      const metaHtml = metaParts.length ? `<div class="card-meta">${metaParts.join('')}</div>` : '';
      const safeLinkHref = card.link ? safeLink(card.link) : '';
      const linkBadgeHtml = safeLinkHref ? getLinkBadgeHtml(card.link, safeLinkHref) : '';

      cardEl.innerHTML = isLabel ? `
        <div class="card-body">
          <div class="card-label-text">${escHtml(displayText)}</div>
          ${metaHtml}
        </div>
      ` : `
        ${linkBadgeHtml}
        <div class="card-body">
          <div class="card-text">${escHtml(card.text)}</div>
          ${metaHtml}
        </div>
      `;

      if (safeLinkHref && !isLabel) {
        const badge = cardEl.querySelector('.card-link-badge');
        badge.addEventListener('mousedown', e => e.stopPropagation());
        badge.addEventListener('click', e => e.stopPropagation());
      }

      cardEl.addEventListener('click', e => {
        if (e.target.closest('.card-link-badge')) return;
        openEditModal(col.id, card);
      });

      cardEl.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        if (lastInputWasTouch) return;
        showContextMenu(e.clientX, e.clientY, col.id, card);
      });

      cardEl.addEventListener('dragstart', e => { e.stopPropagation(); onDragStart(e, col.id, card.id); });
      cardEl.addEventListener('dragend', onDragEnd);
      cardEl.addEventListener('touchstart', e => {
        if (e.target.closest('a')) return;
        const t = e.touches[0];
        touchPending = { colId: col.id, cardId: card.id, el: cardEl, sx: t.clientX, sy: t.clientY };
        clearTimeout(touchLongPressTimer);
        touchLongPressTimer = setTimeout(() => {
          if (!touchPending) return;
          const ghost = spawnGhost(touchPending.el, touchPending.sx, touchPending.sy);
          touchPending.el.classList.add('dragging');
          touchDrag = { type: 'card', colId: touchPending.colId, cardId: touchPending.cardId, sourceEl: touchPending.el, ghost };
          touchPending = null;
          touchLongPressTimer = null;
        }, 500);
      }, { passive: true });

      cardEl.addEventListener('touchend', e => {
        if (touchDrag) return;
        if (e.target.closest('a')) return;
        if (!touchPending) return;
        clearTimeout(touchLongPressTimer);
        touchLongPressTimer = null;
        touchPending = null;
        e.preventDefault();
        openEditModal(col.id, card);
      }, { passive: false });

      const ind = document.createElement('div');
      ind.className = 'drop-indicator';
      cardsEl.appendChild(ind);
      cardsEl.appendChild(cardEl);
    });

    const lastInd = document.createElement('div');
    lastInd.className = 'drop-indicator';
    cardsEl.appendChild(lastInd);

    if (remaining > 0) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'load-more-btn';
      loadMoreBtn.textContent = `+ load ${Math.min(CARDS_PER_PAGE, remaining)} more  (${remaining} remaining)`;
      loadMoreBtn.addEventListener('click', () => {
        colVisible[col.id] = limit + CARDS_PER_PAGE;
        render();
      });
      cardsEl.appendChild(loadMoreBtn);
    }

    if (colCollapsed.has(col.id)) colEl.classList.add('column--collapsed');

    builtCols.push(colEl);
  });

  // Wrap consecutive collapsed columns in a vertical stack
  let bci = 0;
  while (bci < builtCols.length) {
    const el = builtCols[bci];
    if (el.classList.contains('column--collapsed')) {
      const group = document.createElement('div');
      group.className = 'collapsed-group';
      while (bci < builtCols.length && builtCols[bci].classList.contains('column--collapsed')) {
        group.appendChild(builtCols[bci++]);
      }
      board.appendChild(group);
    } else {
      board.appendChild(el);
      bci++;
    }
  }

  const addColBtn = document.createElement('button');
  addColBtn.className = 'add-column-btn';
  addColBtn.textContent = '+ add column';
  addColBtn.addEventListener('click', addColumn);
  board.appendChild(addColBtn);

}
