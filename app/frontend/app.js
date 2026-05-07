const BOARD_NAME = window.location.pathname.split('/').filter(Boolean)[0] || null;
const API_BASE   = BOARD_NAME ? `/api/${BOARD_NAME}` : null;
const API        = BOARD_NAME ? `${API_BASE}/board`  : null;

// ---- Custom dialog ----
function showConfirm(msg, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    document.getElementById('dialogMsg').textContent = msg;
    const okBtn = document.getElementById('dialogOkBtn');
    okBtn.textContent = okLabel;
    okBtn.className = danger ? 'btn btn-confirm-danger' : 'btn btn-accent';
    const backdrop = document.getElementById('dialogBackdrop');
    backdrop.style.display = 'flex';

    const finish = result => {
      backdrop.style.display = 'none';
      resolve(result);
    };

    okBtn.onclick    = () => finish(true);
    document.getElementById('dialogCancelBtn').onclick = () => finish(false);

    const onKey = e => {
      if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); finish(true); }
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); finish(false); }
    };
    document.addEventListener('keydown', onKey);
  });
}
const COLORS = ['#7c6af7','#f59e0b','#10b981','#ec4899','#3b82f6','#f97316','#14b8a6','#ef4444'];
const COL_COLORS = ['#7c6af7','#f59e0b','#10b981','#ec4899','#3b82f6','#f97316','#14b8a6','#06b6d4'];
const PRIORITY_COLORS = ['', '#ef4444', '#f97316', '#f59e0b', '#10b981', '#6b7280'];
const PRIORITY_LABELS = ['—', 'P1', 'P2', 'P3', 'P4', 'P5'];

const CARDS_PER_PAGE = 30;
const colVisible = {}; // colId → number of cards currently shown
const colCollapsed = new Set(); // colIds whose content is hidden

let state = { columns: [] };
let baseState = null;    // snapshot from last server load — the merge ancestor
let pendingRemote = null; // latest remote state that differs from local
let dragState = null;
let colDragState = null;
let touchDrag = null;
let touchPending = null;
let touchLongPressTimer = null;
let lastInputWasTouch = false;

document.addEventListener('touchstart', () => { lastInputWasTouch = true; }, { passive: true });
document.addEventListener('mousedown', () => { lastInputWasTouch = false; }, { passive: true });
let modalColId = null;
let modalMode = 'add'; // 'add' | 'edit'
let editCardId = null;
let selectedColor = COLORS[0];
let selectedPriority = 0;
let saveTimer = null;

// ---- Data ----
async function load() {
  if (!API) return;
  const r = await fetch(API);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  state = await r.json();
  baseState = JSON.parse(JSON.stringify(state));
  pendingRemote = null;
  autoCollapseLeadingInboxes();
  render();
}

function autoCollapseLeadingInboxes() {
  let count = 0;
  for (const col of state.columns) {
    if (/^inbox\b/i.test(col.title)) count++;
    else break;
  }
  if (count > 1) {
    for (let i = 0; i < count; i++) colCollapsed.add(state.columns[i].id);
  }
}

function buildPatch(base, current) {
  const baseIds = base.columns.map(c => c.id);
  const currIds = current.columns.map(c => c.id);
  const patch = {};

  if (JSON.stringify(baseIds) !== JSON.stringify(currIds)) {
    patch.columnOrder = currIds;
  }

  const updated = current.columns.filter(col => {
    const baseCol = base.columns.find(c => c.id === col.id);
    return !baseCol || JSON.stringify(baseCol) !== JSON.stringify(col);
  });
  if (updated.length) patch.updatedColumns = updated;

  const removed = baseIds.filter(id => !currIds.includes(id));
  if (removed.length) patch.removedColumnIds = removed;

  return patch;
}

function schedulesSave() {
  if (!API) return;
  clearTimeout(saveTimer);
  showSaving();
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      let r;
      if (baseState) {
        const patch = buildPatch(baseState, state);
        if (!Object.keys(patch).length) { showSaved(); return; }
        r = await fetch(API, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch) });
      } else {
        r = await fetch(API, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(state) });
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      baseState = JSON.parse(JSON.stringify(state));
      showSaved();
    } catch (e) {
      showSaveError();
    }
  }, 600);
}

function showSaving() {
  const el = document.getElementById('saveIndicator');
  el.textContent = 'saving…';
  el.className = 'save-indicator show saving';
}

function showSaved() {
  const el = document.getElementById('saveIndicator');
  el.textContent = '✓ saved';
  el.className = 'save-indicator show saved';
  setTimeout(() => el.classList.remove('show'), 2000);
}

function showSaveError() {
  const el = document.getElementById('saveIndicator');
  el.textContent = '✗ error';
  el.className = 'save-indicator show save-error';
}

// ---- IDs ----
const uid = () => 'id-' + Math.random().toString(36).slice(2, 9);

// ---- State mutations ----
function addColumn() {
  const idx = state.columns.length;
  state.columns.push({ id: uid(), title: 'New Column', cards: [], color: COL_COLORS[idx % COL_COLORS.length] });
  render();
  schedulesSave();
  setTimeout(() => {
    const titles = document.querySelectorAll('.column-title');
    const last = titles[titles.length - 1];
    if (last) { last.focus(); last.select?.(); }
  }, 50);
}

function deleteColumn(colId) {
  state.columns = state.columns.filter(c => c.id !== colId);
  render();
  schedulesSave();
}

function updateColumnTitle(colId, title) {
  const col = state.columns.find(c => c.id === colId);
  if (col) { col.title = title; schedulesSave(); }
}

function addCard(colId, data) {
  const col = state.columns.find(c => c.id === colId);
  if (col) { col.cards.push({ id: uid(), created: new Date().toISOString().slice(0, 10), ...data }); render(); schedulesSave(); }
}

function recordMove(card, fromColTitle, toColTitle) {
  if (!card.moves) card.moves = [];
  card.moves.push({ at: new Date().toISOString(), from: fromColTitle, to: toColTitle });
}

function updateCardFull(colId, cardId, data) {
  const col = state.columns.find(c => c.id === colId);
  if (!col) return;
  const card = col.cards.find(c => c.id === cardId);
  if (card) { Object.assign(card, data); render(); schedulesSave(); }
}

function deleteCard(colId, cardId) {
  const col = state.columns.find(c => c.id === colId);
  if (col) { col.cards = col.cards.filter(c => c.id !== cardId); render(); schedulesSave(); }
}

function moveCardToColumn(fromColId, cardId, toColId) {
  const fromCol = state.columns.find(c => c.id === fromColId);
  const toCol   = state.columns.find(c => c.id === toColId);
  if (!fromCol || !toCol) return;
  const card = fromCol.cards.find(c => c.id === cardId);
  if (!card) return;
  recordMove(card, fromCol.title, toCol.title);
  fromCol.cards = fromCol.cards.filter(c => c.id !== cardId);
  toCol.cards.unshift(card);
  render();
  schedulesSave();
}

function updateCardText(colId, cardId, text) {
  const col = state.columns.find(c => c.id === colId);
  if (!col) return;
  const card = col.cards.find(c => c.id === cardId);
  if (card) { card.text = text; schedulesSave(); }
}

// ---- Modal ----
function openModal(colId) {
  modalMode = 'add';
  modalColId = colId;
  editCardId = null;
  selectedColor = COLORS[0];
  selectedPriority = 0;
  document.getElementById('cardText').value = '';
  document.getElementById('cardDesc').value = '';
  document.getElementById('cardLink').value = '';
  document.getElementById('cardStart').value = '';
  document.getElementById('cardEnd').value = '';
  document.getElementById('modalTitle').textContent = 'Add Card';
  document.getElementById('modalSubmitBtn').textContent = 'Add Card';
  renderColorRow();
  renderPriorityRow();
  document.getElementById('modal').style.display = 'flex';
  document.getElementById('cardText').focus();
}

function openEditModal(colId, card) {
  modalMode = 'edit';
  modalColId = colId;
  editCardId = card.id;
  selectedColor = card.color || COLORS[0];
  selectedPriority = card.priority || 0;
  document.getElementById('cardText').value = card.text || '';
  document.getElementById('cardDesc').value = card.description || '';
  document.getElementById('cardLink').value = card.link || '';
  document.getElementById('cardStart').value = card.startDate || '';
  document.getElementById('cardEnd').value = card.endDate || '';
  document.getElementById('modalTitle').textContent = 'Edit Card';
  document.getElementById('modalSubmitBtn').textContent = 'Save';
  renderColorRow();
  renderPriorityRow();
  document.getElementById('modal').style.display = 'flex';
  document.getElementById('cardText').focus();
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
}

function submitCard() {
  const text = document.getElementById('cardText').value.trim();
  if (!text) return;
  const data = {
    text,
    color: selectedColor,
    priority: selectedPriority || null,
    description: document.getElementById('cardDesc').value.trim() || null,
    link: document.getElementById('cardLink').value.trim() || null,
    startDate: document.getElementById('cardStart').value || null,
    endDate: document.getElementById('cardEnd').value || null,
  };
  if (modalMode === 'add') {
    addCard(modalColId, data);
  } else {
    updateCardFull(modalColId, editCardId, data);
  }
  closeModal();
}

function renderColorRow() {
  const row = document.getElementById('colorRow');
  row.innerHTML = COLORS.map(c => `
    <div class="color-swatch ${c === selectedColor ? 'selected' : ''}"
         style="background:${c}"
         onclick="selectColor('${c}')"></div>
  `).join('');
}

function selectColor(c) {
  selectedColor = c;
  renderColorRow();
}

function renderPriorityRow() {
  const row = document.getElementById('priorityRow');
  row.innerHTML = [0,1,2,3,4,5].map(p => {
    const isSelected = selectedPriority === p;
    if (p === 0) {
      return `<button class="priority-btn ${isSelected ? 'selected' : ''}"
        style="${isSelected ? 'background:var(--surface);border-color:var(--accent);color:var(--text)' : ''}"
        onclick="selectPriority(0)">—</button>`;
    }
    const col = PRIORITY_COLORS[p];
    return `<button class="priority-btn ${isSelected ? 'selected' : ''}"
      style="color:${col};${isSelected ? `background:${col};border-color:${col};color:#fff` : `border-color:var(--border)`}"
      onclick="selectPriority(${p})">${PRIORITY_LABELS[p]}</button>`;
  }).join('');
}

function selectPriority(p) {
  selectedPriority = p;
  renderPriorityRow();
}

document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && document.getElementById('modal').style.display !== 'none' && !e.shiftKey) {
    if (document.activeElement.id === 'cardDesc') return;
    e.preventDefault();
    submitCard();
  }
});

// ---- Drag & Drop (columns) ----
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

  render();
  schedulesSave();
}

// ---- Drag & Drop (cards) ----
function onDragStart(e, colId, cardId) {
  dragState = { colId, cardId };
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    const el = document.querySelector(`[data-card-id="${cardId}"]`);
    if (el) el.classList.add('dragging');
  }, 0);
}

function onDragEnd(e) {
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
  const { colId: fromColId, cardId } = dragState;

  const fromCol = state.columns.find(c => c.id === fromColId);
  const toCol = state.columns.find(c => c.id === toColId);
  if (!fromCol || !toCol) return;

  const card = fromCol.cards.find(c => c.id === cardId);
  if (!card) return;

  fromCol.cards = fromCol.cards.filter(c => c.id !== cardId);

  const cardsEl = document.querySelector(`[data-col-id="${toColId}"] .cards`);
  const dropIdx = getDropIndex(cardsEl, e.clientY);
  toCol.cards.splice(dropIdx, 0, card);

  if (fromColId !== toColId) recordMove(card, fromCol.title, toCol.title);

  render();
  schedulesSave();
}

// ---- Touch Drag & Drop ----
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

function endTouchDrag() {
  if (!touchDrag) return;
  touchDrag.ghost.el.remove();
  touchDrag.sourceEl.classList.remove('dragging', 'dragging-col');
  document.querySelectorAll('.drag-over, .col-drop-left, .col-drop-right')
    .forEach(e => e.classList.remove('drag-over', 'col-drop-left', 'col-drop-right'));
  document.querySelectorAll('.drop-indicator.active').forEach(el => el.classList.remove('active'));
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
      const { colId: fromColId, cardId } = touchDrag;
      const fromCol = state.columns.find(c => c.id === fromColId);
      const toCol   = state.columns.find(c => c.id === toColId);
      const card    = fromCol?.cards.find(c => c.id === cardId);
      if (fromCol && toCol && card) {
        fromCol.cards = fromCol.cards.filter(c => c.id !== cardId);
        toCol.cards.splice(getDropIndex(colEl.querySelector('.cards'), t.clientY), 0, card);
        if (fromColId !== toColId) recordMove(card, fromCol.title, toCol.title);
        render();
        schedulesSave();
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
      render();
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
document.addEventListener('dragover', e => {
  if (dragState || colDragState) e.preventDefault();
});
document.addEventListener('drop', e => {
  if (dragState || colDragState) e.preventDefault();
});

// ---- Helpers ----
function findCardInState(s, cardId) {
  for (const col of s.columns) {
    const card = col.cards.find(c => c.id === cardId);
    if (card) return card;
  }
  return null;
}

// 3-way merge: remote wins for structure, local wins for card-field edits.
function mergeStates(base, remote, local) {
  const merged = JSON.parse(JSON.stringify(remote));

  // 1. Local column additions (not in base → add to merged)
  for (const lCol of local.columns) {
    if (!base.columns.find(c => c.id === lCol.id) &&
        !merged.columns.find(c => c.id === lCol.id)) {
      merged.columns.push(JSON.parse(JSON.stringify(lCol)));
    }
  }

  // 2. Local column deletions (in base, not in local → remove from merged)
  for (const bCol of base.columns) {
    if (!local.columns.find(c => c.id === bCol.id)) {
      merged.columns = merged.columns.filter(c => c.id !== bCol.id);
    }
  }

  // 3. Local column field changes (title, color)
  for (const lCol of local.columns) {
    const bCol = base.columns.find(c => c.id === lCol.id);
    if (!bCol) continue;
    const mCol = merged.columns.find(c => c.id === lCol.id);
    if (!mCol) continue;
    if (lCol.title !== bCol.title) mCol.title = lCol.title;
    if (lCol.color !== bCol.color) mCol.color = lCol.color;
  }

  // 4. Local card additions (not in base → add to column in merged)
  for (const lCol of local.columns) {
    for (const lCard of lCol.cards) {
      if (!findCardInState(base, lCard.id) && !findCardInState(merged, lCard.id)) {
        const mCol = merged.columns.find(c => c.id === lCol.id);
        if (mCol) mCol.cards.push(JSON.parse(JSON.stringify(lCard)));
      }
    }
  }

  // 5. Local card deletions (in base, not in local → remove from merged)
  for (const bCol of base.columns) {
    for (const bCard of bCol.cards) {
      if (!findCardInState(local, bCard.id)) {
        for (const mCol of merged.columns) {
          mCol.cards = mCol.cards.filter(c => c.id !== bCard.id);
        }
      }
    }
  }

  // 6. Local card field edits (field-level merge: local wins for changed fields)
  for (const lCol of local.columns) {
    for (const lCard of lCol.cards) {
      const bCard = findCardInState(base, lCard.id);
      if (!bCard) continue; // new card, handled above
      const mCard = findCardInState(merged, lCard.id);
      if (!mCard) continue; // deleted remotely → stays deleted
      for (const key of Object.keys(lCard)) {
        if (key === 'id') continue;
        if (JSON.stringify(lCard[key]) !== JSON.stringify(bCard[key])) {
          mCard[key] = lCard[key];
        }
      }
    }
  }

  return merged;
}

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

  // Generic link
  return `<a class="card-link-badge" href="${escHtml(href)}" target="_blank" rel="noopener" title="${escHtml(url)}">↗</a>`;
}

// ---- Render ----
function render() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const builtCols = [];

  state.columns.forEach((col, ci) => {
    const color = col.color || COL_COLORS[ci % COL_COLORS.length];

    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.colId = col.id;
    colEl.setAttribute('dragover', 'true');

    colEl.addEventListener('dragstart', e => {
      if (e.target.closest('.col-drag-handle')) onColDragStart(e, col.id);
    });
    colEl.addEventListener('dragend', e => {
      if (colDragState) onColDragEnd();
    });
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
        <span class="column-count">${col.cards.length}</span>
        <button class="col-btn" title="Column options" style="margin-left:auto">⋮</button>
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

    const titleInput = colEl.querySelector('.column-title');
    titleInput.addEventListener('change', () => updateColumnTitle(col.id, titleInput.value));
    titleInput.addEventListener('blur', () => updateColumnTitle(col.id, titleInput.value));

    const colMenuBtn = colEl.querySelector('.col-btn');
    colMenuBtn.addEventListener('mousedown', e => e.stopPropagation());
    colMenuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const rect = colMenuBtn.getBoundingClientRect();
      showColContextMenu(rect.left, rect.bottom + 4, col.id);
    });

    colEl.querySelector('.add-card-btn').addEventListener('click', () => openModal(col.id));

    const cardsEl = colEl.querySelector('.cards');

    const limit   = colVisible[col.id] || CARDS_PER_PAGE;
    const visible = col.cards.slice(0, limit);
    const remaining = col.cards.length - limit;

    visible.forEach(card => {
      const cardEl = document.createElement('div');
      cardEl.className = 'card';
      cardEl.dataset.cardId = card.id;
      cardEl.draggable = true;
      cardEl.style.setProperty('--card-color', card.color || color);

      // Build meta row
      const metaParts = [];
      if (card.priority) {
        const pc = PRIORITY_COLORS[card.priority];
        metaParts.push(`<span class="priority-badge" style="background:${pc}22;color:${pc}">${PRIORITY_LABELS[card.priority]}</span>`);
      }
      if (card.startDate || card.endDate) {
        if (card.startDate && card.endDate) {
          metaParts.push(`<span class="card-date">${fmtDate(card.startDate)} → ${fmtDate(card.endDate)}</span>`);
        } else if (card.startDate) {
          metaParts.push(`<span class="card-date">from ${fmtDate(card.startDate)}</span>`);
        } else {
          metaParts.push(`<span class="card-date">until ${fmtDate(card.endDate)}</span>`);
        }
      }
      if (card.description) {
        const snippet = card.description.length > 50 ? card.description.slice(0, 50) + '…' : card.description;
        metaParts.push(`<span class="card-desc" title="${escHtml(card.description)}">${escHtml(snippet)}</span>`);
      }
      if (card.link) {
        const href = safeLink(card.link);
      }

      const metaHtml = metaParts.length ? `<div class="card-meta">${metaParts.join('')}</div>` : '';

      const safeLinkHref = card.link ? safeLink(card.link) : '';
      const linkBadgeHtml = safeLinkHref ? getLinkBadgeHtml(card.link, safeLinkHref) : '';

      cardEl.innerHTML = `
        ${linkBadgeHtml}
        <div class="card-body">
          <textarea class="card-text" rows="1" spellcheck="false">${escHtml(card.text)}</textarea>
          ${metaHtml}
        </div>
        <button class="card-more-btn" tabindex="-1" title="Options">⋮</button>
      `;

      if (safeLinkHref) {
        cardEl.querySelector('.card-link-badge').addEventListener('mousedown', e => e.stopPropagation());
      }

      const moreBtn = cardEl.querySelector('.card-more-btn');
      moreBtn.addEventListener('mousedown', e => e.stopPropagation());
      moreBtn.addEventListener('click', e => {
        e.stopPropagation();
        const rect = moreBtn.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 4, col.id, card);
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
        if (e.target.tagName === 'TEXTAREA' || e.target.closest('a') || e.target.closest('.card-more-btn')) return;
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

      let lastTapTime = 0;
      cardEl.addEventListener('touchend', e => {
        if (touchDrag) return;
        if (e.target.tagName === 'TEXTAREA' || e.target.closest('a')) return;
        const now = Date.now();
        if (now - lastTapTime < 300) {
          e.preventDefault();
          touchPending = null;
          openEditModal(col.id, card);
          lastTapTime = 0;
        } else {
          lastTapTime = now;
        }
      }, { passive: false });

      const ta = cardEl.querySelector('.card-text');
      ta.addEventListener('mousedown', e => e.stopPropagation());
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
        updateCardText(col.id, card.id, ta.value);
      });
      ta.addEventListener('focus', () => { cardEl.draggable = false; });
      ta.addEventListener('blur', () => { cardEl.draggable = true; });

      const ind = document.createElement('div');
      ind.className = 'drop-indicator';
      cardsEl.appendChild(ind);
      cardsEl.appendChild(cardEl);
    });

    // Final drop indicator after all cards
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

  // Append columns, wrapping consecutive collapsed ones in a vertical group
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

  // Add column button
  const addColBtn = document.createElement('button');
  addColBtn.className = 'add-column-btn';
  addColBtn.textContent = '+ add column';
  addColBtn.addEventListener('click', addColumn);
  board.appendChild(addColBtn);

  // Resize all card textareas now that everything is in the DOM
  board.querySelectorAll('.card-text').forEach(ta => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  });
}

// ---- Card Info dialog ----
function openCardInfo(card) {
  const backdrop = document.getElementById('cardInfoBackdrop');
  const content  = document.getElementById('cardInfoContent');
  content.innerHTML = '<span class="card-info-loading">Loading…</span>';
  backdrop.style.display = 'flex';

  fetch(`${API_BASE}/card/${encodeURIComponent(card.id)}`)
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(({ created, moves, column }) => {
      let html = '';
      html += `<div class="card-info-title">${escHtml(card.text)}</div>`;
      html += '<table class="card-info-table">';
      if (created) html += `<tr><th>Created</th><td>${escHtml(created)}</td></tr>`;
      html += `<tr><th>Current column</th><td>${escHtml(column)}</td></tr>`;
      html += '</table>';
      if (moves && moves.length) {
        html += '<h3 class="card-info-section">Move history</h3>';
        html += '<ol class="card-info-moves">';
        for (const m of moves) {
          const when = m.at ? new Date(m.at).toLocaleString() : '?';
          html += `<li><span class="card-info-move-time">${escHtml(when)}</span> ` +
                  `<span class="card-info-move-from">${escHtml(m.from)}</span>` +
                  ` → <span class="card-info-move-to">${escHtml(m.to)}</span></li>`;
        }
        html += '</ol>';
      } else {
        html += '<p class="card-info-empty">No move history.</p>';
      }
      content.innerHTML = html;
    })
    .catch(() => { content.innerHTML = '<span class="card-info-error">Failed to load card info.</span>'; });
}

function closeCardInfo() {
  document.getElementById('cardInfoBackdrop').style.display = 'none';
}

document.getElementById('cardInfoBackdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('cardInfoBackdrop')) closeCardInfo();
});

// ---- Context menu (cards) ----
let ctxColId = null;
let ctxCard = null;

// ---- Context menu (column headers) ----
let ctxHeaderColId = null;

function showColContextMenu(x, y, colId) {
  ctxHeaderColId = colId;

  document.getElementById('colCtxToggleContent').textContent =
    colCollapsed.has(colId) ? '▸  Show content' : '▾  Hide content';

  const submenu = document.getElementById('colCtxMoveSubmenu');
  submenu.innerHTML = state.columns
    .filter(c => c.id !== colId)
    .map(c => `<button class="ctx-item" data-col-id="${escHtml(c.id)}">${escHtml(c.title)}</button>`)
    .join('');
  submenu.querySelectorAll('.ctx-item').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      moveAllCards(ctxHeaderColId, btn.dataset.colId);
      hideColContextMenu();
    });
  });

  const trigger = document.querySelector('#colContextMenu .ctx-submenu-trigger');
  trigger.classList.toggle('ctx-submenu-left', x > window.innerWidth / 2);

  const menu = document.getElementById('colContextMenu');
  menu.style.display = 'block';
  const mw = menu.offsetWidth || 160;
  const mh = menu.offsetHeight || 80;
  menu.style.left = (x + mw > window.innerWidth  ? x - mw : x) + 'px';
  menu.style.top  = (y + mh > window.innerHeight ? y - mh : y) + 'px';

  // Flip submenu up if it would overflow the bottom of the viewport
  const triggerRect = trigger.getBoundingClientRect();
  trigger.classList.toggle('ctx-submenu-up', triggerRect.bottom + 260 > window.innerHeight);
}

function hideColContextMenu() {
  document.getElementById('colContextMenu').style.display = 'none';
  ctxHeaderColId = null;
}

document.getElementById('colCtxToggleContent').addEventListener('click', () => {
  const colId = ctxHeaderColId;
  hideColContextMenu();
  if (colCollapsed.has(colId)) colCollapsed.delete(colId);
  else colCollapsed.add(colId);
  render();
});

document.getElementById('colCtxClear').addEventListener('click', async () => {
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  hideColContextMenu();
  if (col && col.cards.length > 0 && await showConfirm(`Remove all ${col.cards.length} card(s) from "${col.title}"?`, { okLabel: 'Clear', danger: true })) {
    col.cards = [];
    render();
    schedulesSave();
  }
});

document.getElementById('colCtxDelete').addEventListener('click', async () => {
  const colId = ctxHeaderColId;
  const col = state.columns.find(c => c.id === colId);
  hideColContextMenu();
  if (!col) return;
  const msg = col.cards.length
    ? `Delete column "${col.title}" and its ${col.cards.length} card(s)?`
    : `Delete column "${col.title}"?`;
  if (await showConfirm(msg, { okLabel: 'Delete', danger: true })) deleteColumn(colId);
});

function moveAllCards(fromColId, toColId) {
  const fromCol = state.columns.find(c => c.id === fromColId);
  const toCol   = state.columns.find(c => c.id === toColId);
  if (!fromCol || !toCol) return;
  toCol.cards.push(...fromCol.cards);
  fromCol.cards = [];
  render();
  schedulesSave();
}

function showContextMenu(x, y, colId, card) {
  ctxColId = colId;
  ctxCard = card;

  // Populate "Move to" submenu
  const submenu = document.getElementById('ctxMoveSubmenu');
  submenu.innerHTML = state.columns
    .filter(c => c.id !== colId)
    .map(c => `<button class="ctx-item" data-col-id="${escHtml(c.id)}">${escHtml(c.title)}</button>`)
    .join('');
  submenu.querySelectorAll('.ctx-item').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      moveCardToColumn(ctxColId, ctxCard.id, btn.dataset.colId);
      hideContextMenu();
    });
  });

  const trigger = document.querySelector('#contextMenu .ctx-submenu-trigger');
  trigger.classList.toggle('ctx-submenu-left', x > window.innerWidth / 2);

  const menu = document.getElementById('contextMenu');
  menu.style.display = 'block';
  const mw = menu.offsetWidth || 140;
  const mh = menu.offsetHeight || 100;
  menu.style.left = (x + mw > window.innerWidth  ? x - mw : x) + 'px';
  menu.style.top  = (y + mh > window.innerHeight ? y - mh : y) + 'px';

  // Flip submenu up if it would overflow the bottom of the viewport
  const triggerRect = trigger.getBoundingClientRect();
  trigger.classList.toggle('ctx-submenu-up', triggerRect.bottom + 260 > window.innerHeight);
}

function hideContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
  ctxColId = null;
  ctxCard = null;
}

document.getElementById('ctxInfo').addEventListener('click', async () => {
  const card = ctxCard;
  hideContextMenu();
  if (!card) return;
  openCardInfo(card);
});

document.getElementById('ctxEdit').addEventListener('click', () => {
  if (ctxColId && ctxCard) openEditModal(ctxColId, ctxCard);
  hideContextMenu();
});

document.getElementById('ctxDelete').addEventListener('click', async () => {
  const colId = ctxColId, card = ctxCard;
  hideContextMenu();
  if (colId && card && await showConfirm(`Delete card "${card.text}"?`, { okLabel: 'Delete', danger: true })) {
    deleteCard(colId, card.id);
  }
});

document.addEventListener('click', () => { hideContextMenu(); hideColContextMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideContextMenu(); hideColContextMenu(); closeCardInfo(); } });

// ---- Title char init ----
function initTitleChars() {
  const h1 = document.getElementById('appTitle');
  const chars = [];
  h1.childNodes.forEach(node => {
    const accent = node.nodeType === Node.ELEMENT_NODE;
    [...(node.textContent)].forEach(ch => chars.push({ ch, accent }));
  });
  h1.innerHTML = chars.map((c, i) =>
    `<span class="title-char${c.accent ? ' title-char-accent' : ''}" style="animation-delay:${i * 80}ms">${c.ch.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`
  ).join('');
}

// ---- Remote change polling ----
async function checkForUpdates() {
  if (!API || saveTimer) return;
  try {
    const r = await fetch(API);
    const remote = await r.json();
    if (JSON.stringify(remote) !== JSON.stringify(state)) {
      pendingRemote = remote;
      document.getElementById('appTitle').classList.add('has-updates');
    }
  } catch (e) { /* ignore network errors */ }
}

setInterval(checkForUpdates, 5000);

document.getElementById('appTitle').addEventListener('click', async () => {
  document.getElementById('appTitle').classList.remove('has-updates');
  if (pendingRemote && baseState) {
    clearTimeout(saveTimer);
    saveTimer = null;
    state = mergeStates(baseState, pendingRemote, state);
    baseState = JSON.parse(JSON.stringify(state));
    pendingRemote = null;
    render();
    schedulesSave();
  } else {
    await load();
  }
});

// ---- Auth ----
async function tryLogin(password) {
  const r = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const { ok, token } = await r.json();
  if (ok && token) {
    sessionStorage.setItem('kanban-auth', token);
    document.getElementById('loginBackdrop').style.display = 'none';
    await afterAuth();
  }
  return ok;
}

async function checkAuth() {
  const params = new URLSearchParams(location.search);
  const urlPwd = params.get('login');
  if (urlPwd) {
    history.replaceState({}, '', location.pathname);
    if (await tryLogin(urlPwd)) return;
  }
  const token = sessionStorage.getItem('kanban-auth');
  if (token) {
    const r = await fetch('/api/auth/verify', { headers: { 'x-auth-token': token } });
    const { ok } = await r.json();
    if (ok) { afterAuth(); return; }
    sessionStorage.removeItem('kanban-auth');
  }
  document.getElementById('loginBackdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('loginPassword').focus(), 50);
}

document.getElementById('loginSubmitBtn').addEventListener('click', async () => {
  const pwd = document.getElementById('loginPassword').value;
  const ok = await tryLogin(pwd);
  if (!ok) {
    document.getElementById('loginError').style.display = 'block';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginPassword').focus();
  }
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginSubmitBtn').click();
  document.getElementById('loginError').style.display = 'none';
});

// ---- Prompts dialog ----
(function () {
  const backdrop = document.getElementById('promptsBackdrop');
  const saveMsg  = document.getElementById('promptsSaveMsg');

  // Tab switching
  backdrop.querySelectorAll('.prompts-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      backdrop.querySelectorAll('.prompts-tab').forEach(t => t.classList.remove('active'));
      backdrop.querySelectorAll('.prompts-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      backdrop.querySelector(`.prompts-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  function setMsg(text, isError) {
    saveMsg.textContent = text;
    saveMsg.className = 'prompts-save-msg' + (isError ? ' prompts-save-msg-error' : ' prompts-save-msg-ok');
    if (text) setTimeout(() => { saveMsg.textContent = ''; saveMsg.className = 'prompts-save-msg'; }, 3000);
  }

  window.openPromptsDialog = async function () {
    // Reset to first tab
    backdrop.querySelectorAll('.prompts-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
    backdrop.querySelectorAll('.prompts-panel').forEach((p, i) => p.classList.toggle('active', i === 0));
    saveMsg.textContent = '';
    saveMsg.className = 'prompts-save-msg';

    // Show dialog immediately with empty fields, then populate on load
    document.getElementById('promptSearchProfile').value   = '';
    document.getElementById('promptCriteriaInclude').value = '';
    document.getElementById('promptCriteriaExclude').value = '';
    document.getElementById('promptSearchRadius').value    = '';
    backdrop.style.display = 'flex';

    try {
      const r = await fetch('/api/prompts');
      if (!r.ok) throw new Error();
      const data = await r.json();
      document.getElementById('promptSearchProfile').value   = data.searchProfile   || '';
      document.getElementById('promptCriteriaInclude').value = data.criteriaInclude || '';
      document.getElementById('promptCriteriaExclude').value = data.criteriaExclude || '';
      document.getElementById('promptSearchRadius').value    = data.searchRadius    || '';
    } catch {
      setMsg('Failed to load prompts.', true);
    }
  };

  function closePromptsDialog() {
    backdrop.style.display = 'none';
  }

  document.getElementById('promptsCancelBtn').addEventListener('click', closePromptsDialog);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closePromptsDialog(); });

  document.getElementById('promptsSaveBtn').addEventListener('click', async () => {
    const body = {
      searchProfile:   document.getElementById('promptSearchProfile').value,
      criteriaInclude: document.getElementById('promptCriteriaInclude').value,
      criteriaExclude: document.getElementById('promptCriteriaExclude').value,
      searchRadius:    document.getElementById('promptSearchRadius').value,
    };
    try {
      const r = await fetch('/api/prompts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error();
      setMsg('Saved.', false);
    } catch {
      setMsg('Failed to save.', true);
    }
  });

  // Escape closes only if no other modal is open
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop.style.display !== 'none') closePromptsDialog();
  });
})();

// ---- Header menu ----
(function () {
  const btn      = document.getElementById('headerMenuBtn');
  const dropdown = document.getElementById('headerDropdown');

  function openMenu()  { dropdown.classList.add('open'); btn.classList.add('open'); }
  function closeMenu() { dropdown.classList.remove('open'); btn.classList.remove('open'); }
  function toggleMenu(e) { e.stopPropagation(); dropdown.classList.contains('open') ? closeMenu() : openMenu(); }

  btn.addEventListener('click', toggleMenu);
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  document.getElementById('menuPrompts').addEventListener('click', () => {
    closeMenu();
    openPromptsDialog();
  });

  document.getElementById('menuStatistics').addEventListener('click', () => {
    closeMenu();
    alert('Statistics — coming soon');
  });

  document.getElementById('menuSettings').addEventListener('click', () => {
    closeMenu();
    document.getElementById('settingsBackdrop').style.display = 'flex';
  });
})();

// ---- Settings dialog ----
(function () {
  const backdrop = document.getElementById('settingsBackdrop');
  function closeSettings() { backdrop.style.display = 'none'; }
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeSettings(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop.style.display !== 'none') closeSettings();
  });
})();

// ---- After-auth routing ----
async function afterAuth() {
  if (BOARD_NAME) {
    await load();
  } else {
    initOverview();
  }
}

// ---- Overview ----
async function initOverview() {
  document.querySelector('.board-wrapper').style.display = 'none';
  document.getElementById('saveIndicator').closest('.header-actions').style.display = 'none';
  document.querySelector('.header-menu').style.marginLeft = 'auto';
  document.getElementById('menuAllBoards').style.display = 'none';
  document.getElementById('overview').style.display = 'flex';

  try {
    const r = await fetch('/api/boards');
    const boards = await r.json();
    renderBoardGrid(boards);
  } catch (e) {
    document.getElementById('boardGrid').innerHTML = '<p class="new-board-error">Failed to load boards.</p>';
  }
}

function renderBoardGrid(boards) {
  const grid = document.getElementById('boardGrid');
  grid.innerHTML = boards.length
    ? boards.map(name =>
        `<a class="board-card" href="/${escHtml(name)}">
          <span class="board-card-name">${escHtml(name)}</span>
          <span class="board-card-arrow">→</span>
        </a>`).join('')
    : '<p class="board-grid-empty">No boards yet — create one below.</p>';
}

document.getElementById('newBoardBtn').addEventListener('click', async () => {
  const input = document.getElementById('newBoardInput');
  const errEl = document.getElementById('newBoardError');
  const name  = input.value.trim().toLowerCase();
  errEl.style.display = 'none';
  if (!name) return;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    errEl.textContent = 'Use only lowercase letters, digits and hyphens.';
    errEl.style.display = 'block';
    return;
  }
  try {
    const r = await fetch(`/api/boards/${encodeURIComponent(name)}`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Failed to create board.'; errEl.style.display = 'block'; return; }
    window.location.href = `/${name}`;
  } catch (e) {
    errEl.textContent = 'Failed to create board.'; errEl.style.display = 'block';
  }
});

document.getElementById('newBoardInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('newBoardBtn').click();
});

initTitleChars();
checkAuth();
