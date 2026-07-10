// ---- Scroll position helpers ----
function saveColScrolls() {
  const map = {};
  document.querySelectorAll('[data-col-id]').forEach(col => {
    const cards = col.querySelector('.cards');
    if (cards) map[col.dataset.colId] = cards.scrollTop;
  });
  return map;
}

function restoreColScrolls(map) {
  Object.entries(map).forEach(([colId, top]) => {
    const col = document.querySelector(`[data-col-id="${colId}"]`);
    const cards = col?.querySelector('.cards');
    if (cards) cards.scrollTop = top;
  });
}

// ---- Drag state ----
let dragState    = null;
let colDragState = null;
let touchDrag    = null;
let touchPending = null;
let touchLongPressTimer = null;
let lastInputWasTouch   = false;
let cardTapState        = null; // { cardId, colId, card, x, y, timer }

document.addEventListener('touchstart', () => { lastInputWasTouch = true; },  { passive: true });
document.addEventListener('mousedown',  () => { lastInputWasTouch = false; }, { passive: true });

// ---- Column drag & drop ----
function onColDragStart(e, colId) {
  colDragState = { colId };
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    const el = document.querySelector(`[data-col-id="${colId}"]`);
    if (el) el.classList.add('dragging-col');
  }, 0);
}

function onColDragEnd() {
  document.querySelectorAll('.dragging-col').forEach(el => el.classList.remove('dragging-col'));
  document.querySelectorAll('.col-drop-left, .col-drop-right').forEach(el => {
    el.classList.remove('col-drop-left', 'col-drop-right');
  });
  colDragState = null;
}

function onColDrop(e, toColId) {
  e.preventDefault();
  const fromColId = colDragState.colId;
  if (fromColId === toColId) return;

  const fromIdx = state.columns.findIndex(c => c.id === fromColId);
  const toEl = document.querySelector(`[data-col-id="${toColId}"]`);
  const insertBefore = e.clientX < toEl.getBoundingClientRect().left + toEl.offsetWidth / 2;

  const [col] = state.columns.splice(fromIdx, 1);
  const newToIdx = state.columns.findIndex(c => c.id === toColId);
  state.columns.splice(insertBefore ? newToIdx : newToIdx + 1, 0, col);

  const _scrolls = saveColScrolls();
  render();
  restoreColScrolls(_scrolls);
  schedulesSave();
}

// ---- Card drag & drop ----

// Build a stacked-cards visual element for multi-drag feedback.
// Returns the wrapper element (caller must append/remove from DOM).
function _buildStackedWrapper(sourceEl, count, rect) {
  const stackCount = Math.min(count - 1, 2);
  const w = rect.width, h = rect.height;
  const pad = stackCount * 5;

  const wrapper = document.createElement('div');
  wrapper.style.cssText = `position:fixed;width:${w + pad}px;height:${h + pad}px;pointer-events:none;transition:none;`;

  // Backing cards rendered behind (largest index = furthest back)
  for (let i = stackCount; i >= 1; i--) {
    const back = document.createElement('div');
    back.style.cssText = `position:absolute;left:${i * 5}px;top:${i * 5}px;width:${w}px;height:${h}px;`
      + `background:var(--surface2);border:1px solid var(--border);border-radius:8px;`
      + `box-shadow:0 4px 12px rgba(0,0,0,0.3);`;
    wrapper.appendChild(back);
  }

  // Front card clone
  const clone = sourceEl.cloneNode(true);
  Object.assign(clone.style, { position: 'absolute', left: '0', top: '0', width: w + 'px', margin: '0' });
  wrapper.appendChild(clone);

  // Count badge on the top-right corner of the front card
  const badge = document.createElement('div');
  badge.style.cssText = `position:absolute;top:-11px;left:${w - 15}px;width:30px;height:30px;z-index:10;`
    + `background:var(--accent);color:#fff;border-radius:50%;`
    + `display:flex;align-items:center;justify-content:center;`
    + `font-size:1.05rem;font-weight:700;font-family:system-ui,sans-serif;`;
  badge.textContent = count;
  wrapper.appendChild(badge);

  return wrapper;
}

function onDragStart(e, colId, cardId) {
  // Multi-select drag: only when all selected cards are from this same column
  const selColIds = new Set(selectedCards.values());
  const isMultiDrag = selectedCards.size >= 2 && selectedCards.has(cardId) && selColIds.size === 1 && [...selColIds][0] === colId;
  dragState = isMultiDrag
    ? { colId, cardId, multiIds: [...selectedCards.keys()] }
    : { colId, cardId };
  e.dataTransfer.effectAllowed = 'move';

  if (isMultiDrag) {
    const rect = e.currentTarget.getBoundingClientRect();
    const img = _buildStackedWrapper(e.currentTarget, dragState.multiIds.length, rect);
    img.style.top  = '0';
    img.style.left = `${-(rect.width + 50)}px`; // off-screen so it doesn't flash
    document.body.appendChild(img);
    e.dataTransfer.setDragImage(img, e.clientX - rect.left, e.clientY - rect.top);
    setTimeout(() => img.remove(), 0);
  }

  setTimeout(() => {
    const ids = dragState.multiIds || [cardId];
    for (const id of ids) {
      const el = document.querySelector(`[data-card-id="${id}"]`);
      if (el) el.classList.add('dragging');
    }
  }, 0);
}

function onDragEnd() {
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('.drop-indicator.active').forEach(el => el.classList.remove('active'));
  dragState = null;
}

function onDragOver(e, colId) {
  if (!dragState) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const cardsEl = document.querySelector(`[data-col-id="${colId}"] .cards`);
  if (cardsEl) showDropIndicator(cardsEl, e.clientY);
}

function getDropIndex(cardsEl, clientY) {
  const cards = [...cardsEl.querySelectorAll('.card:not(.dragging)')];
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

function showDropIndicator(cardsEl, clientY) {
  document.querySelectorAll('.drop-indicator.active').forEach(el => el.classList.remove('active'));
  // Use all cards (including the dragging one, which still occupies space in the
  // layout). The midpoint comparison against the full list maps directly to the
  // correct indicator slot without any offset arithmetic.
  const allCards = [...cardsEl.querySelectorAll('.card')];
  let insertIdx = allCards.length;
  for (let i = 0; i < allCards.length; i++) {
    const rect = allCards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) { insertIdx = i; break; }
  }
  const indicators = cardsEl.querySelectorAll('.drop-indicator');
  if (indicators[insertIdx]) indicators[insertIdx].classList.add('active');
}

function onDrop(e, toColId) {
  if (!dragState) return;
  e.preventDefault();
  const { colId: fromColId, cardId, multiIds } = dragState;

  const fromCol = state.columns.find(c => c.id === fromColId);
  const toCol   = state.columns.find(c => c.id === toColId);
  if (!fromCol || !toCol) return;

  if (multiIds && fromColId !== toColId) {
    // Multi-card drop — preserve relative source order, insert at drop position
    const cardsToMove = fromCol.cards.filter(c => multiIds.includes(c.id));
    if (!cardsToMove.length) return;
    fromCol.cards = fromCol.cards.filter(c => !multiIds.includes(c.id));
    const cardsEl = document.querySelector(`[data-col-id="${toColId}"] .cards`);
    const dropIdx = getDropIndex(cardsEl, e.clientY);
    const now = new Date().toISOString();
    for (const card of cardsToMove) {
      recordMove(card, fromCol.title, toCol.title);
      applyColumnActions(card, toCol);
      card.lastModified = now;
    }
    toCol.cards.splice(dropIdx, 0, ...cardsToMove);
    selectedCards.clear();
  } else if (!multiIds) {
    // Single card drop
    const card = fromCol.cards.find(c => c.id === cardId);
    if (!card) return;
    fromCol.cards = fromCol.cards.filter(c => c.id !== cardId);
    const cardsEl = document.querySelector(`[data-col-id="${toColId}"] .cards`);
    toCol.cards.splice(getDropIndex(cardsEl, e.clientY), 0, card);
    if (fromColId !== toColId) {
      recordMove(card, fromCol.title, toCol.title);
      applyColumnActions(card, toCol);
      card.lastModified = new Date().toISOString();
    }
  }

  const _scrolls = saveColScrolls();
  render();
  restoreColScrolls(_scrolls);
  schedulesSave();
}

// ---- Touch drag & drop ----
function spawnGhost(sourceEl, touchX, touchY) {
  const rect = sourceEl.getBoundingClientRect();
  const el = sourceEl.cloneNode(true);
  sourceEl.querySelectorAll('textarea').forEach((ta, i) => {
    el.querySelectorAll('textarea')[i].value = ta.value;
    el.querySelectorAll('textarea')[i].style.height = ta.style.height;
  });
  Object.assign(el.style, {
    position: 'fixed',
    left: rect.left + 'px',
    top: rect.top + 'px',
    width: rect.width + 'px',
    margin: '0',
    zIndex: '9999',
    opacity: '0.9',
    pointerEvents: 'none',
    transform: 'scale(1.03) rotate(0.5deg)',
    boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
    transition: 'none',
  });
  document.body.appendChild(el);
  return { el, dx: touchX - rect.left, dy: touchY - rect.top };
}

function spawnMultiGhost(sourceEl, count, touchX, touchY) {
  const rect = sourceEl.getBoundingClientRect();
  const wrapper = _buildStackedWrapper(sourceEl, count, rect);
  Object.assign(wrapper.style, {
    left: rect.left + 'px',
    top:  rect.top  + 'px',
    zIndex: '9999',
    opacity: '0.92',
  });
  // Apply the same animated lift to the front clone as spawnGhost does
  const clone = wrapper.querySelector('.card') || wrapper.lastElementChild;
  if (clone) Object.assign(clone.style, { transform: 'scale(1.03) rotate(0.5deg)', boxShadow: '0 16px 48px rgba(0,0,0,0.55)' });
  document.body.appendChild(wrapper);
  return { el: wrapper, dx: touchX - rect.left, dy: touchY - rect.top };
}

function endTouchDrag() {
  if (!touchDrag) return;
  touchDrag.ghost.el.remove();
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  touchDrag.sourceEl.classList.remove('dragging-col');
  document.querySelectorAll('.drag-over, .col-drop-left, .col-drop-right')
    .forEach(e => e.classList.remove('drag-over', 'col-drop-left', 'col-drop-right'));
  document.querySelectorAll('.drop-indicator.active').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.notes-tree-item--drag-over').forEach(el => el.classList.remove('notes-tree-item--drag-over'));
  touchDrag = null;
}

document.addEventListener('touchmove', e => {
  const t = e.touches[0];

  if (touchPending && !touchDrag) {
    if (Math.hypot(t.clientX - touchPending.sx, t.clientY - touchPending.sy) > 10) {
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = null;
      touchPending = null;
    }
    return;
  }

  if (!touchDrag) return;
  e.preventDefault();

  const x = t.clientX, y = t.clientY;
  touchDrag.ghost.el.style.left = (x - touchDrag.ghost.dx) + 'px';
  touchDrag.ghost.el.style.top  = (y - touchDrag.ghost.dy) + 'px';

  touchDrag.ghost.el.style.display = 'none';
  const under = document.elementFromPoint(x, y);
  touchDrag.ghost.el.style.display = '';

  if (touchDrag.type === 'card') {
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    under?.closest('.column')?.classList.add('drag-over');
    const cardsEl = under?.closest('.cards');
    if (cardsEl) {
      const cr = cardsEl.getBoundingClientRect();
      if (y < cr.top + 50)    cardsEl.scrollTop -= 8;
      if (y > cr.bottom - 50) cardsEl.scrollTop += 8;
      showDropIndicator(cardsEl, y);
    } else {
      document.querySelectorAll('.drop-indicator.active').forEach(el => el.classList.remove('active'));
    }
  } else {
    document.querySelectorAll('.col-drop-left, .col-drop-right')
      .forEach(el => el.classList.remove('col-drop-left', 'col-drop-right'));
    const colEl = under?.closest('.column');
    if (colEl && colEl.dataset.colId !== touchDrag.colId) {
      const cr = colEl.getBoundingClientRect();
      colEl.classList.toggle('col-drop-left',  x < cr.left + cr.width / 2);
      colEl.classList.toggle('col-drop-right', x >= cr.left + cr.width / 2);
    }
  }

  const bw = document.querySelector('.board-wrapper');
  const bwR = bw.getBoundingClientRect();
  if (x < bwR.left  + 80) bw.scrollLeft -= 10;
  if (x > bwR.right - 80) bw.scrollLeft += 10;

}, { passive: false });

document.addEventListener('touchend', e => {
  clearTimeout(touchLongPressTimer);
  touchLongPressTimer = null;
  touchPending = null;
  if (!touchDrag) return;

  const t = e.changedTouches[0];
  touchDrag.ghost.el.style.display = 'none';
  const under = document.elementFromPoint(t.clientX, t.clientY);
  touchDrag.ghost.el.style.display = '';

  if (touchDrag.type === 'card') {
    const colEl = under?.closest('.column');
    if (colEl) {
      const toColId = colEl.dataset.colId;
      const { colId: fromColId, cardId, multiIds } = touchDrag;
      const fromCol = state.columns.find(c => c.id === fromColId);
      const toCol   = state.columns.find(c => c.id === toColId);
      if (fromCol && toCol) {
        if (multiIds && fromColId !== toColId) {
          const cardsToMove = fromCol.cards.filter(c => multiIds.includes(c.id));
          if (cardsToMove.length) {
            fromCol.cards = fromCol.cards.filter(c => !multiIds.includes(c.id));
            const dropIdx = getDropIndex(colEl.querySelector('.cards'), t.clientY);
            const now = new Date().toISOString();
            for (const card of cardsToMove) {
              recordMove(card, fromCol.title, toCol.title);
              applyColumnActions(card, toCol);
              card.lastModified = now;
            }
            toCol.cards.splice(dropIdx, 0, ...cardsToMove);
            selectedCards.clear();
            const _scrolls = saveColScrolls();
            render();
            restoreColScrolls(_scrolls);
            schedulesSave();
          }
        } else if (!multiIds) {
          const card = fromCol.cards.find(c => c.id === cardId);
          if (card) {
            fromCol.cards = fromCol.cards.filter(c => c.id !== cardId);
            toCol.cards.splice(getDropIndex(colEl.querySelector('.cards'), t.clientY), 0, card);
            if (fromColId !== toColId) {
              recordMove(card, fromCol.title, toCol.title);
              applyColumnActions(card, toCol);
              card.lastModified = new Date().toISOString();
            }
            const _scrolls = saveColScrolls();
            render();
            restoreColScrolls(_scrolls);
            schedulesSave();
          }
        }
      }
    }
  } else {
    const colEl = under?.closest('.column');
    if (colEl && colEl.dataset.colId !== touchDrag.colId) {
      const fromIdx = state.columns.findIndex(c => c.id === touchDrag.colId);
      const cr = colEl.getBoundingClientRect();
      const [col] = state.columns.splice(fromIdx, 1);
      const newIdx = state.columns.findIndex(c => c.id === colEl.dataset.colId);
      state.columns.splice(t.clientX < cr.left + cr.width / 2 ? newIdx : newIdx + 1, 0, col);
      const _scrolls = saveColScrolls();
      render();
      restoreColScrolls(_scrolls);
      schedulesSave();
    }
  }

  endTouchDrag();
}, { passive: true });

document.addEventListener('touchcancel', () => {
  clearTimeout(touchLongPressTimer);
  touchLongPressTimer = null;
  touchPending = null;
  endTouchDrag();
}, { passive: true });

// Prevent the browser from navigating/reloading when a drag is released
// outside of any registered drop target (e.g. board gaps, header, window edge).
document.addEventListener('dragover', e => { if (dragState || colDragState) e.preventDefault(); });
document.addEventListener('drop',     e => { if (dragState || colDragState) e.preventDefault(); });

// ---- Arrow-key scrolling for hovered column ----
let hoveredCardsEl = null;
let _arrowScrollTarget = 0;
let _arrowScrollRafId = null;

function _arrowScrollStep() {
  if (!hoveredCardsEl) { _arrowScrollRafId = null; return; }
  const diff = _arrowScrollTarget - hoveredCardsEl.scrollTop;
  if (Math.abs(diff) < 1) {
    hoveredCardsEl.scrollTop = _arrowScrollTarget;
    _arrowScrollRafId = null;
    return;
  }
  hoveredCardsEl.scrollTop += diff * 0.18;
  _arrowScrollRafId = requestAnimationFrame(_arrowScrollStep);
}

document.addEventListener('mouseover', e => {
  const col = e.target.closest('[data-col-id]');
  const next = col ? col.querySelector('.cards') : null;
  if (next !== hoveredCardsEl) {
    hoveredCardsEl = next;
    _arrowScrollTarget = next ? next.scrollTop : 0;
    if (_arrowScrollRafId) { cancelAnimationFrame(_arrowScrollRafId); _arrowScrollRafId = null; }
  }
});

document.addEventListener('keydown', e => {
  if (!hoveredCardsEl) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  _arrowScrollTarget += e.key === 'ArrowDown' ? 80 : -80;
  const max = hoveredCardsEl.scrollHeight - hoveredCardsEl.clientHeight;
  _arrowScrollTarget = Math.max(0, Math.min(max, _arrowScrollTarget));
  if (!_arrowScrollRafId) _arrowScrollRafId = requestAnimationFrame(_arrowScrollStep);
});
