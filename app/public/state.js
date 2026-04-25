const BOARD_NAME = window.location.pathname.split('/').filter(Boolean)[0] || null;
const API_BASE   = BOARD_NAME ? `/api/${BOARD_NAME}` : null;
const API        = BOARD_NAME ? `${API_BASE}/board`  : null;

// ---- Custom confirm dialog ----
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

    okBtn.onclick = () => finish(true);
    document.getElementById('dialogCancelBtn').onclick = () => finish(false);

    const onKey = e => {
      if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); finish(true); }
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); finish(false); }
    };
    document.addEventListener('keydown', onKey);
  });
}

// ---- Constants ----
const COLORS         = ['#7c6af7','#f59e0b','#10b981','#ec4899','#3b82f6','#f97316','#14b8a6','#ef4444'];
const COL_COLORS     = ['#7c6af7','#f59e0b','#10b981','#ec4899','#3b82f6','#f97316','#14b8a6','#06b6d4'];
const PRIORITY_COLORS = ['', '#ef4444', '#f97316', '#f59e0b', '#10b981', '#6b7280'];
const PRIORITY_LABELS = ['—', 'P1', 'P2', 'P3', 'P4', 'P5'];

const CARDS_PER_PAGE = 30;
const colVisible   = {}; // colId → number of cards currently shown
const colCollapsed = new Set(); // colIds whose content is hidden

// ---- State ----
let state        = { columns: [] };
let baseState    = null; // snapshot from last server load — the merge ancestor
let pendingRemote = null;
let saveTimer    = null;

// ---- Data load ----
async function load() {
  if (!API) return;
  const r = await fetch(API);
  if (r.status === 404) {
    document.getElementById('overviewHint').textContent = `Board "${BOARD_NAME}" does not exist.`;
    document.getElementById('overviewHint').style.display = '';
    initOverview();
    return;
  }
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

// ---- Save ----
function buildPatch(base, current) {
  const baseIds = base.columns.map(c => c.id);
  const currIds = current.columns.map(c => c.id);
  const patch = {};

  if (JSON.stringify(baseIds) !== JSON.stringify(currIds)) patch.columnOrder = currIds;

  if ((current.description ?? '') !== (base.description ?? ''))
    patch.description = current.description ?? '';

  if ((current.inboxWithDate ?? false) !== (base.inboxWithDate ?? false))
    patch.inboxWithDate = current.inboxWithDate ?? false;

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

// ---- ID generator ----
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

// ---- Merge helpers ----
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

  for (const lCol of local.columns) {
    if (!base.columns.find(c => c.id === lCol.id) && !merged.columns.find(c => c.id === lCol.id))
      merged.columns.push(JSON.parse(JSON.stringify(lCol)));
  }

  for (const bCol of base.columns) {
    if (!local.columns.find(c => c.id === bCol.id))
      merged.columns = merged.columns.filter(c => c.id !== bCol.id);
  }

  for (const lCol of local.columns) {
    const bCol = base.columns.find(c => c.id === lCol.id);
    if (!bCol) continue;
    const mCol = merged.columns.find(c => c.id === lCol.id);
    if (!mCol) continue;
    if (lCol.title !== bCol.title) mCol.title = lCol.title;
    if (lCol.color !== bCol.color) mCol.color = lCol.color;
  }

  for (const lCol of local.columns) {
    for (const lCard of lCol.cards) {
      if (!findCardInState(base, lCard.id) && !findCardInState(merged, lCard.id)) {
        const mCol = merged.columns.find(c => c.id === lCol.id);
        if (mCol) mCol.cards.push(JSON.parse(JSON.stringify(lCard)));
      }
    }
  }

  for (const bCol of base.columns) {
    for (const bCard of bCol.cards) {
      if (!findCardInState(local, bCard.id)) {
        for (const mCol of merged.columns) mCol.cards = mCol.cards.filter(c => c.id !== bCard.id);
      }
    }
  }

  for (const lCol of local.columns) {
    for (const lCard of lCol.cards) {
      const bCard = findCardInState(base, lCard.id);
      if (!bCard) continue;
      const mCard = findCardInState(merged, lCard.id);
      if (!mCard) continue;
      for (const key of Object.keys(lCard)) {
        if (key === 'id') continue;
        if (JSON.stringify(lCard[key]) !== JSON.stringify(bCard[key])) mCard[key] = lCard[key];
      }
    }
  }

  return merged;
}
