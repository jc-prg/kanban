// ---- Notes State ----
let notesState = { pages: [] };
let notesSaveTimer = null;
const NOTES_API = API_BASE ? `${API_BASE}/notes` : null;

// ---- Notes Load / Save ----
async function loadNotes() {
  if (!NOTES_API) return;
  try {
    const r = await fetch(NOTES_API);
    if (!r.ok) { notesState = { pages: [] }; }
    else { notesState = await r.json(); if (!notesState.pages) notesState.pages = []; }
  } catch (e) { notesState = { pages: [] }; }
  renderNotesTree();
}

function scheduleSaveNotes() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(async () => {
    notesSaveTimer = null;
    if (!NOTES_API) return;
    try {
      const r = await fetch(NOTES_API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notesState),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) { console.error('Notes save failed:', e.message); }
  }, 600);
}

// ---- Notes Tree Helpers ----
function findNotePage(id, pages) {
  for (const p of pages) {
    if (p.id === id) return p;
    if (p.children?.length) { const f = findNotePage(id, p.children); if (f) return f; }
  }
  return null;
}

function getNotePath(id, pages, acc = []) {
  for (const p of pages) {
    const path = [...acc, p];
    if (p.id === id) return path;
    if (p.children?.length) { const f = getNotePath(id, p.children, path); if (f) return f; }
  }
  return null;
}

function addNotePage(parentId = null) {
  const page = {
    id: 'n-' + Math.random().toString(36).slice(2, 9),
    title: 'New Page', description: '', link: '', linkedCards: [], children: [],
  };
  if (!parentId) {
    notesState.pages.push(page);
  } else {
    const parent = findNotePage(parentId, notesState.pages);
    if (parent) { if (!parent.children) parent.children = []; parent.children.push(page); }
  }
  renderNotesTree();
  scheduleSaveNotes();
  openNoteModal(page.id);
}

function deleteNotePage(id) {
  function removeFrom(arr) {
    const idx = arr.findIndex(p => p.id === id);
    if (idx !== -1) { arr.splice(idx, 1); return true; }
    return arr.some(p => p.children?.length && removeFrom(p.children));
  }
  removeFrom(notesState.pages);
  renderNotesTree();
  scheduleSaveNotes();
}

// ---- Notes Sidebar ----
const notesExpanded = new Set();
let notesSidebarOpen = false;

function toggleNotesSidebar() {
  notesSidebarOpen = !notesSidebarOpen;
  document.getElementById('notesSidebar')?.classList.toggle('notes-sidebar--open', notesSidebarOpen);
  document.getElementById('notesToggleBtn')?.classList.toggle('open', notesSidebarOpen);
}

function renderNotesTree() {
  const container = document.getElementById('notesTreeBody');
  if (!container) return;
  container.innerHTML = '';
  if (!notesState.pages.length) {
    const empty = document.createElement('p');
    empty.className = 'notes-empty';
    empty.textContent = 'No pages yet';
    container.appendChild(empty);
    return;
  }
  renderNotesList(notesState.pages, container, 0);
}

function renderNotesList(pages, container, depth) {
  for (const page of pages) {
    const hasChildren = page.children?.length > 0;
    const canHaveChildren = depth < 2;
    const isExpanded = notesExpanded.has(page.id);

    const item = document.createElement('div');
    item.className = 'notes-tree-item';
    item.dataset.pageId = page.id;
    item.style.paddingLeft = (depth * 14 + 6) + 'px';

    item.innerHTML =
      `<button class="notes-toggle-btn${hasChildren ? '' : ' notes-toggle-btn--hidden'}" title="${isExpanded ? 'Collapse' : 'Expand'}">${isExpanded ? '▾' : '▸'}</button>` +
      `<span class="notes-item-title${depth === 0 ? ' notes-item-title--root' : ''}">${escHtml(page.title)}</span>` +
      `<div class="notes-item-btns">` +
        (canHaveChildren ? `<button class="notes-item-btn notes-item-btn--add" title="Add subpage">+</button>` : '') +
        `<button class="notes-item-btn notes-item-btn--del" title="Delete page">✕</button>` +
      `</div>`;

    item.querySelector('.notes-item-title').addEventListener('click', () => openNoteModal(page.id));

    const toggleBtn = item.querySelector('.notes-toggle-btn');
    if (hasChildren) {
      toggleBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (notesExpanded.has(page.id)) notesExpanded.delete(page.id); else notesExpanded.add(page.id);
        renderNotesTree();
      });
    }

    const addBtn = item.querySelector('.notes-item-btn--add');
    if (addBtn) {
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        notesExpanded.add(page.id);
        addNotePage(page.id);
      });
    }

    item.querySelector('.notes-item-btn--del').addEventListener('click', async e => {
      e.stopPropagation();
      const hasContent = page.description?.trim() || page.children?.length;
      const msg = page.children?.length
        ? `Delete "${page.title}" and all its subpages?`
        : `Delete page "${page.title}"?`;
      if (!hasContent || await showConfirm(msg, { okLabel: 'Delete', danger: true })) {
        if (noteModalPageId === page.id) closeNoteModal();
        deleteNotePage(page.id);
      }
    });

    container.appendChild(item);

    if (hasChildren && isExpanded) renderNotesList(page.children, container, depth + 1);
  }
}

// ---- Note Modal ----
let noteModalPageId = null;
let noteModalOrig = { title: '', desc: '', link: '' };

function openNoteModal(pageId) {
  const page = findNotePage(pageId, notesState.pages);
  if (!page) return;
  noteModalPageId = pageId;

  document.getElementById('notePageTitle').value = page.title;
  document.getElementById('notePageDesc').value = page.description || '';
  document.getElementById('notePageLink').value = page.link || '';

  noteModalOrig = { title: page.title, desc: page.description || '', link: page.link || '' };

  renderLinkedCards(page.linkedCards || []);

  const path = getNotePath(pageId, notesState.pages);
  const crumb = document.getElementById('noteModalBreadcrumb');
  if (crumb) {
    const isNested = path && path.length > 1;
    crumb.textContent = isNested ? path.map(p => p.title).join(' › ') : '';
    crumb.style.display = isNested ? '' : 'none';
  }

  if ((page.description || '').trim()) showNoteDescPreview();
  else showNoteDescEditor();

  // reset link button state
  _updateNoteLinkBtn();

  document.getElementById('noteModal').style.display = 'flex';
  const nt = document.getElementById('notePageTitle');
  nt.focus();
  nt.select();
  autoResizeTitle(nt);
}

function closeNoteModal() {
  document.getElementById('noteModal').style.display = 'none';
  document.getElementById('noteCreateCardForm').style.display = 'none';
  noteModalPageId = null;
}

function submitNote() {
  if (!noteModalPageId) return;
  const page = findNotePage(noteModalPageId, notesState.pages);
  if (!page) return;

  page.title       = document.getElementById('notePageTitle').value.trim() || 'Untitled';
  page.description = document.getElementById('notePageDesc').value;
  page.link        = document.getElementById('notePageLink').value.trim();

  noteModalOrig = { title: page.title, desc: page.description, link: page.link };

  const crumb = document.getElementById('noteModalBreadcrumb');
  const path = getNotePath(noteModalPageId, notesState.pages);
  if (crumb) {
    const isNested = path && path.length > 1;
    crumb.textContent = isNested ? path.map(p => p.title).join(' › ') : '';
    crumb.style.display = isNested ? '' : 'none';
  }

  renderNotesTree();
  scheduleSaveNotes();

  const msg = document.getElementById('noteModalSavedMsg');
  msg.textContent = '✓ saved';
  msg.classList.add('modal-saved-msg--visible');
  setTimeout(() => msg.classList.remove('modal-saved-msg--visible'), 1500);
}

function noteModalHasChanges() {
  if (!noteModalPageId) return false;
  return document.getElementById('notePageTitle').value        !== noteModalOrig.title ||
         document.getElementById('notePageDesc').value         !== noteModalOrig.desc  ||
         document.getElementById('notePageLink').value.trim()  !== noteModalOrig.link;
}

async function tryCloseNoteModal() {
  if (noteModalHasChanges()) {
    if (await showConfirm('Close without saving changes?', { okLabel: 'Close', danger: true }))
      closeNoteModal();
  } else {
    closeNoteModal();
  }
}

function showNoteDescPreview() {
  const text = document.getElementById('notePageDesc').value.trim();
  if (!text) { showNoteDescEditor(); return; }
  document.getElementById('notePageDescPreview').innerHTML = marked.parse(text, { breaks: true });
  document.getElementById('notePageDescPreview').style.display = '';
  document.getElementById('notePageDesc').style.display = 'none';
}

function showNoteDescEditor() {
  document.getElementById('notePageDescPreview').style.display = 'none';
  document.getElementById('notePageDesc').style.display = '';
}

// ---- Linked Cards ----
function renderLinkedCards(ids) {
  const container = document.getElementById('noteLinkedCardsList');
  if (!container) return;
  container.innerHTML = '';

  for (const id of ids) {
    let card = null, col = null;
    for (const c of (state.columns || [])) {
      const found = c.cards.find(k => k.id === id);
      if (found) { card = found; col = c; break; }
    }

    const mini = document.createElement('div');
    mini.className = 'note-mini-card';
    const color = card?.color || col?.color || 'var(--accent)';
    mini.style.setProperty('--card-color', color);

    const text = card ? card.text : `[card not found: ${id}]`;
    const isGone = !card;

    mini.innerHTML =
      `<div class="note-mini-card-body">` +
        (col ? `<span class="note-mini-card-col">${escHtml(col.title)}</span>` : '') +
        `<span class="note-mini-card-text${isGone ? ' note-mini-card-text--gone' : ''}">${escHtml(text)}</span>` +
      `</div>` +
      `<button class="note-mini-card-remove" title="Unlink card">✕</button>`;

    if (card && col) {
      mini.querySelector('.note-mini-card-body').addEventListener('click', () => { closeNoteModal(); openEditModal(col.id, card); });
    }
    mini.querySelector('.note-mini-card-remove').addEventListener('click', e => {
      e.stopPropagation();
      const page = findNotePage(noteModalPageId, notesState.pages);
      if (!page) return;
      page.linkedCards = (page.linkedCards || []).filter(c => c !== id);
      renderLinkedCards(page.linkedCards);
      scheduleSaveNotes();
    });

    container.appendChild(mini);
  }
}

// ---- Create card and link ----
function getOrCreateInbox() {
  const now = new Date();
  const withDate = state.settings?.inboxWithDate ?? false;
  const title = withDate
    ? `Inbox ${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.`
    : 'Inbox';

  // Exact match first (today's inbox or plain "Inbox")
  let inbox = state.columns.find(c => c.title === title);

  if (!inbox) {
    const inboxCols = state.columns.filter(c => /^inbox/i.test(c.title));
    if (inboxCols.length) {
      // Parse DD.MM. from title; columns without a date get epoch so dated ones win
      const parseDate = t => {
        const m = t.match(/(\d{2})\.(\d{2})\./);
        if (!m) return new Date(0);
        const d = new Date(now.getFullYear(), +m[2] - 1, +m[1]);
        // If the parsed date is more than a week in the future it belongs to last year
        if (d - now > 7 * 86400000) d.setFullYear(d.getFullYear() - 1);
        return d;
      };
      inbox = inboxCols.reduce((a, b) => parseDate(b.title) > parseDate(a.title) ? b : a);
    }
  }

  if (!inbox) {
    inbox = { id: uid(), title, cards: [], color: '#06b6d4' };
    state.columns.unshift(inbox);
    render();
  }
  return inbox;
}

function createAndLinkCard(text) {
  if (!text.trim()) return;
  const inbox  = getOrCreateInbox();
  const cardId = uid();
  inbox.cards.unshift({
    id:      cardId,
    text:    text.trim(),
    color:   inbox.color || '#06b6d4',
    created: new Date().toISOString().slice(0, 10),
  });
  schedulesSave();
  render();

  const target = findNotePage(noteModalPageId, notesState.pages);
  if (target && !(target.linkedCards || []).includes(cardId)) {
    (target.linkedCards ??= []).push(cardId);
    renderLinkedCards(target.linkedCards);
    scheduleSaveNotes();
  }
}

// ---- Card search for linking ----
function initNoteCardSearch() {
  const input   = document.getElementById('noteCardSearchInput');
  const results = document.getElementById('noteCardSearchResults');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    results.innerHTML = '';
    if (!q) { results.style.display = 'none'; return; }

    const matches = [];
    for (const col of (state.columns || [])) {
      for (const card of col.cards) {
        if (card.text.toLowerCase().includes(q)) matches.push({ id: card.id, text: card.text, col: col.title });
      }
    }

    if (!matches.length) { results.style.display = 'none'; return; }
    results.style.display = '';

    matches.slice(0, 8).forEach(card => {
      const item = document.createElement('div');
      item.className = 'note-card-search-result';
      const short = card.text.length > 60 ? card.text.slice(0, 60) + '…' : card.text;
      item.innerHTML =
        `<span class="note-card-search-col">${escHtml(card.col)}</span>` +
        `<span class="note-card-search-text">${escHtml(short)}</span>`;
      item.addEventListener('click', () => {
        const page = findNotePage(noteModalPageId, notesState.pages);
        if (!page) return;
        if (!page.linkedCards) page.linkedCards = [];
        if (!page.linkedCards.includes(card.id)) {
          page.linkedCards.push(card.id);
          renderLinkedCards(page.linkedCards);
          scheduleSaveNotes();
        }
        input.value = '';
        results.style.display = 'none';
      });
      results.appendChild(item);
    });
  });

  document.addEventListener('click', e => {
    if (!results.contains(e.target) && e.target !== input) results.style.display = 'none';
  });
}

// ---- Link open button for notes ----
function _updateNoteLinkBtn() {
  const url = document.getElementById('notePageLink')?.value.trim();
  document.getElementById('notePageLinkOpen')?.classList.toggle('has-url', !!url);
}

// ---- Card-onto-page drag tracking ----
// All listeners use capture (true) so they fire before any element handler,
// including the card's own dragstart stopPropagation.
let _notesDragCard     = null;
let _notesDragOverItem = null;

document.addEventListener('dragstart', e => {
  _notesDragCard     = null;
  _notesDragOverItem = null;
  const cardEl = e.target.closest('[data-card-id]');
  const colEl  = cardEl?.closest('[data-col-id]');
  if (cardEl && colEl)
    _notesDragCard = { cardId: cardEl.dataset.cardId, colId: colEl.dataset.colId };
}, true);

document.addEventListener('dragover', e => {
  if (!_notesDragCard) return;
  const item = e.target.closest('.notes-tree-item');
  if (_notesDragOverItem && _notesDragOverItem !== item) {
    _notesDragOverItem.classList.remove('notes-tree-item--drag-over');
    _notesDragOverItem = null;
  }
  if (!item) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_notesDragOverItem !== item) {
    item.classList.add('notes-tree-item--drag-over');
    _notesDragOverItem = item;
  }
}, true);

document.addEventListener('drop', async e => {
  const item = _notesDragOverItem;
  if (item) item.classList.remove('notes-tree-item--drag-over');
  _notesDragOverItem = null;
  if (!item || !_notesDragCard) return;      // not a notes drop — let normal handlers run
  e.preventDefault();
  e.stopPropagation();

  const { colId, cardId } = _notesDragCard;  // capture before any await
  _notesDragCard = null;

  const col  = state.columns.find(c => c.id === colId);
  const card = col?.cards.find(c => c.id === cardId);
  if (!card) return;

  const pageId = item.dataset.pageId;
  const target = findNotePage(pageId, notesState.pages);
  if (!target || (target.linkedCards || []).includes(cardId)) return;

  const label = card.text.length > 60 ? card.text.slice(0, 60) + '…' : card.text;
  if (!await showConfirm(`Link "${label}" to page "${target.title}"?`, { okLabel: 'Link card' })) return;

  (target.linkedCards ??= []).push(cardId);
  scheduleSaveNotes();
  if (noteModalPageId === pageId) renderLinkedCards(target.linkedCards);
}, true);

function initNotesDropZone() { /* wired above via document capture listeners */ }

// ---- DOMContentLoaded wiring ----
document.addEventListener('DOMContentLoaded', () => {
  initNotesDropZone();
  document.getElementById('notesToggleBtn')?.addEventListener('click', toggleNotesSidebar);
  document.getElementById('notesAddRootBtn')?.addEventListener('click', () => addNotePage(null));

  // Note modal backdrop click
  document.getElementById('noteModal')?.addEventListener('click', e => {
    if (e.target.id === 'noteModal') tryCloseNoteModal();
  });

  document.getElementById('noteModalCancelBtn')?.addEventListener('click', () => tryCloseNoteModal());
  document.getElementById('noteModalSaveBtn')?.addEventListener('click', () => { submitNote(); closeNoteModal(); });
  document.getElementById('noteModalDeleteBtn')?.addEventListener('click', async () => {
    if (!noteModalPageId) return;
    const page = findNotePage(noteModalPageId, notesState.pages);
    if (!page) return;
    const msg = page.children?.length
      ? `Delete "${page.title}" and all its subpages?`
      : `Delete page "${page.title}"?`;
    if (await showConfirm(msg, { okLabel: 'Delete', danger: true })) {
      const id = noteModalPageId;
      closeNoteModal();
      deleteNotePage(id);
    }
  });

  // Description preview / editor
  document.getElementById('notePageDescPreview')?.addEventListener('click', () => {
    showNoteDescEditor();
    document.getElementById('notePageDesc').focus();
  });
  document.getElementById('notePageDesc')?.addEventListener('blur', () => {
    if (document.getElementById('notePageDesc').value.trim()) showNoteDescPreview();
  });

  // Markdown shortcuts in description
  document.getElementById('notePageDesc')?.addEventListener('keydown', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    const markers = e.key === 'b' ? ['**','**'] : e.key === 'i' ? ['*','*'] : e.key === 'u' ? ['<u>','</u>'] : null;
    if (!markers) return;
    e.preventDefault();
    const ta = e.target, s = ta.selectionStart, en = ta.selectionEnd;
    ta.setRangeText(markers[0] + ta.value.slice(s, en) + markers[1], s, en, 'select');
    if (s === en) { const mid = s + markers[0].length; ta.setSelectionRange(mid, mid); }
  });

  // Title key handling
  document.getElementById('notePageTitle')?.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\n/g, ''); // no newlines in title
    autoResizeTitle(e.target);
  });
  document.getElementById('notePageTitle')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitNote(); document.getElementById('notePageDesc').focus(); }
    if (e.key === 'Escape') tryCloseNoteModal();
  });

  // Global Escape closes note modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('noteModal')?.style.display !== 'none') {
      // Only close if no other modal is on top
      const otherOpen = ['modal','settingsBackdrop','promptsBackdrop','searchBackdrop','cardInfoBackdrop','dialogBackdrop']
        .some(id => document.getElementById(id)?.style.display !== 'none');
      if (!otherOpen) tryCloseNoteModal();
    }
  });

  // Link open button
  document.getElementById('notePageLink')?.addEventListener('input', _updateNoteLinkBtn);
  document.getElementById('notePageLinkOpen')?.addEventListener('click', () => {
    const url = document.getElementById('notePageLink').value.trim();
    if (url) window.open(url, '_blank', 'noopener');
  });

  initNoteCardSearch();

  // Create-card inline form
  const createForm  = document.getElementById('noteCreateCardForm');
  const createInput = document.getElementById('noteNewCardText');

  document.getElementById('noteCreateCardBtn')?.addEventListener('click', () => {
    if (createForm.style.display === '') {
      createForm.style.display = 'none';
    } else {
      createForm.style.display = '';
      createInput.value = '';
      createInput.focus();
    }
  });

  document.getElementById('noteCreateCardCancel')?.addEventListener('click', () => {
    createForm.style.display = 'none';
  });

  function submitCreateCard() {
    const text = createInput.value.trim();
    if (!text) return;
    createAndLinkCard(text);
    createForm.style.display = 'none';
  }

  document.getElementById('noteCreateCardSubmit')?.addEventListener('click', submitCreateCard);

  createInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitCreateCard(); }
    if (e.key === 'Escape') { createForm.style.display = 'none'; }
  });
});
