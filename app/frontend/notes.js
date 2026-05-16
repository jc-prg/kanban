// ---- Notes auto-save ----
let _noteAutoSaveTimer = null;

function _stopNoteAutoSave() {
  clearInterval(_noteAutoSaveTimer);
  _noteAutoSaveTimer = null;
}

function _startNoteAutoSave() {
  _stopNoteAutoSave();
  const ms = (state.settings?.autoSaveIntervalMin ?? 5) * 60 * 1000;
  _noteAutoSaveTimer = setInterval(() => {
    if (noteModalHasChanges()) submitNote();
  }, ms);
}

// ---- Notes State ----
let notesState     = { items: [], schemaVersion: 2 };
let baseNotesState = null; // snapshot from last server load/save — used for patch diffing
let notesEtag      = null;
let notesSaveTimer = null;
const NOTES_API        = API_BASE ? `${API_BASE}/notes`             : null;
const NOTES_ATTACH_API = API_BASE ? `${API_BASE}/notes/attachments` : null;
const NOTES_PAGES_API  = API_BASE ? `${API_BASE}/notes/pages`       : null;
const NOTES_FOLD_API   = API_BASE ? `${API_BASE}/notes/folders`     : null;


function _webdavActive() { return !!(window.WEBDAV_CFG?.enabled && NOTES_PAGES_API); }

// lastModified from frontmatter at the time each page was loaded — used for conflict detection
const _pageLoadedAt = new Map();

// Call a per-operation notes endpoint; returns parsed JSON or throws
async function _notesOp(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body:    body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// Apply a returned notes state from the server (used after per-op calls)
function _applyNotesResult(data) {
  if (data.notes) {
    notesState     = _normalizeNotes(data.notes);
    baseNotesState = JSON.parse(JSON.stringify(notesState));
  }
}

// ---- Notes Load / Save ----
function _normalizeNotes(data) {
  if (data && data.schemaVersion === 2 && Array.isArray(data.items)) return data;
  // v1 legacy: server should have migrated, but handle client-side just in case
  return { items: [], schemaVersion: 2 };
}

function _updateWebdavUi() {
  const webdavOn = !!(window.WEBDAV_CFG?.enabled);
  const labelEl  = document.getElementById('notesSidebarLabel');
  const syncBtn  = document.getElementById('notesSyncBtn');
  if (labelEl) labelEl.innerHTML = webdavOn
    ? _svgNetworkFolder(12, 12) + '\u00a0Notes'
    : 'Notes';
  if (syncBtn)  syncBtn.style.display = webdavOn ? '' : 'none';
}

async function loadNotes() {
  if (!NOTES_API) return;

  // Show loading indicator — GET /notes syncs WebDAV inline and can take a moment
  const treeBody = document.getElementById('notesTreeBody');
  if (treeBody) treeBody.innerHTML = '<p class="notes-empty notes-loading">Loading…</p>';
  const syncBtn = document.getElementById('notesSyncBtn');
  if (syncBtn) syncBtn.classList.add('notes-sync-btn--spinning');

  try {
    const r = await fetch(NOTES_API);
    if (!r.ok) { notesState = { items: [], schemaVersion: 2 }; }
    else {
      notesEtag  = r.headers.get('ETag');
      notesState = _normalizeNotes(await r.json());
    }
  } catch (e) { notesState = { items: [], schemaVersion: 2 }; }

  if (syncBtn) syncBtn.classList.remove('notes-sync-btn--spinning');
  _loadTreeOpenState();
  baseNotesState = JSON.parse(JSON.stringify(notesState));
  _updateWebdavUi();
  renderNotesTree();
  restoreNotesSidebar();
  render();
}

let _syncInProgress = false;

async function _runWebdavSync() {
  if (_syncInProgress) return;
  _syncInProgress = true;
  const btn = document.getElementById('notesSyncBtn');
  if (btn) btn.classList.add('notes-sync-btn--spinning');
  try {
    const data = await _notesOp('POST', `${NOTES_API}/sync`, { folderIds: [...notesExpanded] });
    if (data.notes) {
      notesState     = _normalizeNotes(data.notes);
      baseNotesState = JSON.parse(JSON.stringify(notesState));
      renderNotesTree();
    }
  } catch (e) { console.error('WebDAV sync error:', e.message); }
  finally {
    _syncInProgress = false;
    if (btn) btn.classList.remove('notes-sync-btn--spinning');
  }
}

async function syncNotesWithWebdav() {
  if (_syncInProgress || !window.WEBDAV_CFG?.enabled) return;
  await _runWebdavSync();
}

// DFS-flatten only pages (not folders) from the items tree.
// Returns a Map<id, pageFields> in DFS traversal order.
function _flattenNotePages(items, out = new Map()) {
  for (const item of items) {
    if (item.type === 'page') {
      const { children, ...own } = item;
      out.set(item.id, own);
    } else if (item.type === 'folder') {
      _flattenNotePages(item.children || [], out);
    } else {
      // v1 legacy: page without type field
      const { children, ...own } = item;
      out.set(item.id, own);
      if (item.children?.length) _flattenNotePages(item.children, out);
    }
  }
  return out;
}

// DFS item structure signature (type:id pairs) for structural comparison.
function _itemDFSStructure(items, out = []) {
  for (const item of items) {
    out.push((item.type || 'page')[0] + ':' + item.id);
    if (item.type === 'folder') _itemDFSStructure(item.children || [], out);
  }
  return out;
}

// Returns { updatedPages } for content-only changes, {} for no changes,
// or null when structure changed (add/remove/reorder/move) — caller should fall back to PUT.
function buildNotesPatch(base, current) {
  const baseItems = base.items || base.pages || [];
  const currItems = current.items || current.pages || [];

  const baseStruct = _itemDFSStructure(baseItems);
  const currStruct = _itemDFSStructure(currItems);
  if (JSON.stringify(baseStruct) !== JSON.stringify(currStruct)) return null;

  const baseFlat = _flattenNotePages(baseItems);
  const currFlat = _flattenNotePages(currItems);
  const updatedPages = [];
  for (const [id, curr] of currFlat) {
    if (JSON.stringify(curr) !== JSON.stringify(baseFlat.get(id))) updatedPages.push(curr);
  }
  return updatedPages.length ? { updatedPages } : {};
}

function scheduleSaveNotes() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(async () => {
    notesSaveTimer = null;
    if (!NOTES_API) return;
    try {
      let r;
      const headers = { 'Content-Type': 'application/json' };
      if (notesEtag) headers['If-Match'] = notesEtag;
      if (baseNotesState) {
        const patch = buildNotesPatch(baseNotesState, notesState);
        if (patch !== null) {
          if (!Object.keys(patch).length) return; // nothing changed
          r = await fetch(NOTES_API, { method: 'PATCH', headers, body: JSON.stringify(patch) });
        } else {
          r = await fetch(NOTES_API, { method: 'PUT', headers, body: JSON.stringify(notesState) });
        }
      } else {
        r = await fetch(NOTES_API, { method: 'PUT', headers, body: JSON.stringify(notesState) });
      }
      if (r.status === 409) {
        // On conflict: reload from server (remote wins) then re-queue save
        await loadNotes();
        scheduleSaveNotes();
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const newEtag = r.headers.get('ETag');
      if (newEtag) notesEtag = newEtag;
      baseNotesState = JSON.parse(JSON.stringify(notesState));
    } catch (e) { console.error('Notes save failed:', e.message); }
  }, 600);
}

// Remove an item (folder or page) by id from the items tree (mutates in place).
function _removeItem(id, items) {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === id) { items.splice(i, 1); return true; }
    if (items[i].type === 'folder' && items[i].children?.length && _removeItem(id, items[i].children)) return true;
  }
  return false;
}

// ---- Notes Tree Helpers ----

// sessionStorage persistence for folder open/close state
function _treeStateKey() {
  return 'notes-tree-open-' + (API_BASE || 'local');
}
function _saveTreeOpenState() {
  try { sessionStorage.setItem(_treeStateKey(), JSON.stringify([...notesExpanded])); } catch (_) {}
}
function _loadTreeOpenState() {
  try {
    const saved = sessionStorage.getItem(_treeStateKey());
    if (saved) { notesExpanded.clear(); for (const id of JSON.parse(saved)) notesExpanded.add(id); }
  } catch (_) {}
}

// Find any item (folder or page) by id
function findNoteItem(id, items) {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.type === 'folder') { const f = findNoteItem(id, item.children || []); if (f) return f; }
  }
  return null;
}

// Find a page by id (skips folders)
function findNotePage(id, items) {
  for (const item of items) {
    if (item.type === 'page' && item.id === id) return item;
    if (item.type === 'folder') { const f = findNotePage(id, item.children || []); if (f) return f; }
    // v1 legacy: items without type
    if (!item.type && item.id === id) return item;
  }
  return null;
}

// Get breadcrumb path from root to the item with given id
function getNotePath(id, items, acc = []) {
  for (const item of items) {
    const p = [...acc, item];
    if (item.id === id) return p;
    if (item.type === 'folder') { const f = getNotePath(id, item.children || [], p); if (f) return f; }
  }
  return null;
}

// Count leaf pages recursively inside a list of items
function _countPages(items) {
  let n = 0;
  for (const item of items) {
    if (item.type === 'page') n++;
    else if (item.type === 'folder') n += _countPages(item.children || []);
  }
  return n;
}

function _noteUid(prefix) {
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');
}

async function addNotePage(parentId = null) {
  const page = {
    type: 'page',
    id: _noteUid('n-'),
    title: 'New Page', description: '', link: '', linkedCards: [],
    lastModified: new Date().toISOString(),
  };

  if (_webdavActive()) {
    try {
      const data = await _notesOp('POST', NOTES_PAGES_API, { page, parentId });
      _applyNotesResult(data);
      renderNotesTree();
      openNoteModal(page.id, true);
    } catch (e) {
      await showConfirm(`Could not create page: ${e.message}`, { okLabel: 'OK' });
    }
    return;
  }

  _pendingNewPage = { page, parentId };
  openNoteModal(page.id, true);
}

async function addNoteFolder(parentId = null) {
  const folder = {
    type: 'folder',
    id: _noteUid('f-'),
    title: 'New Folder',
    children: [],
  };

  if (_webdavActive()) {
    try {
      const data = await _notesOp('POST', NOTES_FOLD_API, { folder, parentId });
      _applyNotesResult(data);
      notesExpanded.add(folder.id);
      _saveTreeOpenState();
      renderNotesTree();
      const el = document.querySelector(`[data-item-id="${folder.id}"]`);
      if (el) _startFolderRename(el, findNoteItem(folder.id, notesState.items) || folder);
    } catch (e) {
      await showConfirm(`Could not create folder: ${e.message}`, { okLabel: 'OK' });
    }
    return;
  }

  if (!parentId) {
    notesState.items.push(folder);
  } else {
    const parent = findNoteItem(parentId, notesState.items);
    if (parent && parent.type === 'folder') {
      if (!parent.children) parent.children = [];
      parent.children.push(folder);
    }
  }
  notesExpanded.add(folder.id);
  _saveTreeOpenState();
  renderNotesTree();
  scheduleSaveNotes();
  const el = document.querySelector(`[data-item-id="${folder.id}"]`);
  if (el) _startFolderRename(el, folder);
}

async function deleteNoteItem(id) {
  if (_webdavActive()) {
    const item = findNoteItem(id, notesState.items);
    const isFolder = item?.type === 'folder';
    const apiUrl   = isFolder ? `${NOTES_FOLD_API}/${id}` : `${NOTES_PAGES_API}/${id}`;
    try {
      const data = await _notesOp('DELETE', apiUrl);
      _applyNotesResult(data);
      renderNotesTree();
    } catch (e) {
      await showConfirm(`Could not delete: ${e.message}`, { okLabel: 'OK' });
    }
    return;
  }
  _removeItem(id, notesState.items);
  renderNotesTree();
  scheduleSaveNotes();
}

// Alias for backward compatibility (used in note modal delete button)
function deleteNotePage(id) { return deleteNoteItem(id); }

// ---- Notes Sidebar ----
const notesExpanded = new Set();
let notesSidebarOpen = false;
let notesFontSize = 0; // 0=sm 1=md 2=lg
const SIDEBAR_MIN = 230;
function _sidebarMax() { return window.innerWidth <= 500 ? window.innerWidth - 80 : 460; }
let sidebarWidth = SIDEBAR_MIN;

function _applySidebarWidth(sidebar, w) {
  sidebar.style.width    = w + 'px';
  sidebar.style.minWidth = w + 'px';
}

function _saveNotesSidebarSettings() {
  if (!state) return;
  (state.settings ??= {}).notesSidebarOpen  = notesSidebarOpen;
  (state.settings ??= {}).notesSidebarWidth = sidebarWidth;
  schedulesSave();
}

function _applyNotesFontSize() {
  const sidebar = document.getElementById('notesSidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('notes-sidebar--font-md', notesFontSize === 1);
  sidebar.classList.toggle('notes-sidebar--font-lg', notesFontSize === 2);
}

function toggleNotesFontSize() {
  notesFontSize = (notesFontSize + 1) % 3;
  _applyNotesFontSize();
  (state.settings ??= {}).notesFontSize = notesFontSize;
  schedulesSave();
}

function restoreNotesSidebar() {
  const w    = state.settings?.notesSidebarWidth;
  const open = state.settings?.notesSidebarOpen;
  if (w >= SIDEBAR_MIN) sidebarWidth = Math.min(w, _sidebarMax());
  if (open && !notesSidebarOpen) toggleNotesSidebar();
  const fs = state.settings?.notesFontSize;
  if (typeof fs === 'number' && fs >= 0 && fs <= 2) notesFontSize = fs;
  _applyNotesFontSize();
}

function toggleNotesSidebar() {
  notesSidebarOpen = !notesSidebarOpen;
  const sidebar = document.getElementById('notesSidebar');
  if (sidebar) {
    if (notesSidebarOpen) _applySidebarWidth(sidebar, sidebarWidth);
    else { sidebar.style.width = ''; sidebar.style.minWidth = ''; }
  }
  sidebar?.classList.toggle('notes-sidebar--open', notesSidebarOpen);
  document.getElementById('notesToggleBtn')?.classList.toggle('open', notesSidebarOpen);
  _saveNotesSidebarSettings();
}

function initSidebarResize() {
  const sidebar = document.getElementById('notesSidebar');
  const resizer = document.getElementById('notesSidebarResizer');
  if (!sidebar || !resizer) return;

  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = sidebar.offsetWidth;
    sidebar.classList.add('notes-sidebar--resizing');

    function onMove(e) {
      const raw = startWidth + (e.clientX - startX);
      _applySidebarWidth(sidebar, Math.max(SIDEBAR_MIN, Math.min(_sidebarMax(), raw)));
    }

    function onUp(e) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      sidebar.classList.remove('notes-sidebar--resizing');

      const raw = startWidth + (e.clientX - startX);
      if (raw < SIDEBAR_MIN && startWidth === SIDEBAR_MIN) {
        sidebar.style.width    = '';
        sidebar.style.minWidth = '';
        notesSidebarOpen = false;
        sidebar.classList.remove('notes-sidebar--open');
        document.getElementById('notesToggleBtn')?.classList.remove('open');
      } else {
        sidebarWidth = Math.min(Math.max(raw, SIDEBAR_MIN), _sidebarMax());
        _applySidebarWidth(sidebar, sidebarWidth);
      }
      _saveNotesSidebarSettings();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  resizer.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const startX     = e.touches[0].clientX;
    const startWidth = sidebar.offsetWidth;
    sidebar.classList.add('notes-sidebar--resizing');

    function onMove(e) {
      const raw = startWidth + (e.touches[0].clientX - startX);
      _applySidebarWidth(sidebar, Math.max(SIDEBAR_MIN, Math.min(_sidebarMax(), raw)));
    }

    function onUp(e) {
      resizer.removeEventListener('touchmove',  onMove);
      resizer.removeEventListener('touchend',   onUp);
      resizer.removeEventListener('touchcancel', onUp);
      sidebar.classList.remove('notes-sidebar--resizing');

      const raw = startWidth + (e.changedTouches[0].clientX - startX);
      if (raw < SIDEBAR_MIN && startWidth === SIDEBAR_MIN) {
        sidebar.style.width    = '';
        sidebar.style.minWidth = '';
        notesSidebarOpen = false;
        sidebar.classList.remove('notes-sidebar--open');
        document.getElementById('notesToggleBtn')?.classList.remove('open');
      } else {
        sidebarWidth = Math.min(Math.max(raw, SIDEBAR_MIN), _sidebarMax());
        _applySidebarWidth(sidebar, sidebarWidth);
      }
      _saveNotesSidebarSettings();
    }

    resizer.addEventListener('touchmove',   onMove, { passive: false });
    resizer.addEventListener('touchend',    onUp,   { passive: true });
    resizer.addEventListener('touchcancel', onUp,   { passive: true });
  }, { passive: false });
}

function renderNotesTree() {
  const container = document.getElementById('notesTreeBody');
  if (!container) return;
  container.innerHTML = '';
  if (!notesState.items.length) {
    const empty = document.createElement('p');
    empty.className = 'notes-empty';
    empty.textContent = 'No pages yet';
    container.appendChild(empty);
    return;
  }
  renderNotesList(notesState.items, container, 0);
}

function renderNotesList(items, container, depth) {
  for (const item of items) {
    if (item.type === 'folder') {
      _renderFolderItem(item, container, depth);
    } else {
      _renderPageItem(item, container, depth);
    }
  }
}

function _renderFolderItem(folder, container, depth) {
  const isExpanded  = notesExpanded.has(folder.id);
  const hasChildren = (folder.children || []).length > 0 || _webdavActive();

  const el = document.createElement('div');
  el.className = 'notes-tree-item notes-tree-item--folder';
  if (_webdavActive() && folder.orphaned) el.classList.add('notes-tree-item--orphaned');
  el.dataset.itemId   = folder.id;
  el.dataset.itemType = 'folder';
  el.dataset.depth    = depth;
  el.draggable = true;
  el.style.paddingLeft = (depth * 14 + 6) + 'px';

  el.innerHTML =
    `<button class="notes-toggle-btn${hasChildren ? '' : ' notes-toggle-btn--hidden'}" title="${isExpanded ? 'Collapse' : 'Expand'}">${isExpanded ? ICONS.collapse : ICONS.expand}</button>` +
    `<span class="notes-item-title notes-item-folder-title${depth === 0 ? ' notes-item-title--root' : ''}">${escHtml(folder.title)}</span>` +
    `<div class="notes-item-btns">` +
      (depth < 2 ? `<button class="notes-item-btn notes-item-btn--add-folder" title="Add subfolder">${_svgFolder(10, 10)}</button>` : '') +
      `<button class="notes-item-btn notes-item-btn--add" title="Add page to folder">+</button>` +
      `<button class="notes-item-btn notes-item-btn--del" title="Delete folder">${ICONS.close}</button>` +
    `</div>`;

  el.querySelector('.notes-toggle-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const expanding = !notesExpanded.has(folder.id);
    if (expanding) notesExpanded.add(folder.id); else notesExpanded.delete(folder.id);
    _saveTreeOpenState();
    if (expanding && _webdavActive()) {
      el.classList.add('notes-tree-item--loading');
      try {
        const data = await _notesOp('POST', `${NOTES_FOLD_API}/${folder.id}/sync`);
        _applyNotesResult(data);
      } catch { /* fall back to cached content */ }
    }
    renderNotesTree();
  });

  el.querySelector('.notes-item-folder-title').addEventListener('click', e => {
    e.stopPropagation();
    _startFolderRename(el, folder);
  });

  el.querySelector('.notes-item-btn--add-folder')?.addEventListener('click', e => {
    e.stopPropagation();
    notesExpanded.add(folder.id);
    _saveTreeOpenState();
    addNoteFolder(folder.id);
  });

  el.querySelector('.notes-item-btn--add').addEventListener('click', e => {
    e.stopPropagation();
    notesExpanded.add(folder.id);
    _saveTreeOpenState();
    addNotePage(folder.id);
  });

  el.querySelector('.notes-item-btn--del').addEventListener('click', async e => {
    e.stopPropagation();
    const count = _countPages(folder.children || []);
    const msg = count > 0
      ? `Delete folder "${folder.title}" and its ${count} page${count !== 1 ? 's' : ''}?`
      : `Delete folder "${folder.title}"?`;
    if (await showConfirm(msg, { okLabel: 'Delete', danger: true })) {
      deleteNoteItem(folder.id);
    }
  });

  container.appendChild(el);

  if (isExpanded) renderNotesList(folder.children || [], container, depth + 1);
}

function _renderPageItem(page, container, depth) {
  const el = document.createElement('div');
  el.className = 'notes-tree-item notes-tree-item--page';
  if (_webdavActive() && page.orphaned) el.classList.add('notes-tree-item--orphaned');
  el.dataset.itemId   = page.id;
  el.dataset.pageId   = page.id; // kept for card-drag-drop compatibility
  el.dataset.itemType = 'page';
  el.dataset.depth    = depth;
  el.draggable = true;
  el.style.paddingLeft = (depth * 14 + 6) + 'px';

  const hasLink        = !!page.link?.trim();
  const hasCards       = (page.linkedCards || []).length > 0;
  const hasAttachments = !!page.hasAttachments;
  const indicators =
    (hasLink        ? `<span class="notes-item-indicator" title="Has link">${SVGICONS.link(9, 9)}</span>` : '') +
    (hasCards       ? `<span class="notes-item-indicator" title="${page.linkedCards.length} linked card(s)">${SVGICONS.linkedCards(9, 9)}</span>` : '') +
    (hasAttachments ? `<span class="notes-item-indicator" title="Has attachments">${SVGICONS.attachment(9, 9)}</span>` : '');

  el.innerHTML =
    `<span class="notes-toggle-btn notes-toggle-btn--hidden"></span>` +
    `<span class="notes-item-title-wrap">` +
      `<span class="notes-item-title${depth === 0 ? ' notes-item-title--root' : ''}">${escHtml(page.title)}</span>` +
      (indicators ? `<span class="notes-item-indicators">${indicators}</span>` : '') +
    `</span>` +
    `<div class="notes-item-btns">` +
      `<button class="notes-item-btn notes-item-btn--del" title="Delete page">${ICONS.close}</button>` +
    `</div>`;

  el.querySelector('.notes-item-title').addEventListener('click', () => openNoteModal(page.id));

  el.querySelector('.notes-item-btn--del').addEventListener('click', async e => {
    e.stopPropagation();
    if (await showConfirm(`Delete page "${page.title}"?`, { okLabel: 'Delete', danger: true })) {
      if (noteModalPageId === page.id) closeNoteModal();
      deleteNoteItem(page.id);
    }
  });

  container.appendChild(el);
}

function _startFolderRename(itemEl, folder) {
  const titleEl = itemEl.querySelector('.notes-item-folder-title');
  if (!titleEl || titleEl.querySelector('input')) return; // already renaming
  const prev = folder.title;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'notes-folder-rename-input';
  input.value = prev;
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  async function commit() {
    const next = input.value.trim() || prev;
    folder.title = next;
    renderNotesTree();
    if (next !== prev) {
      if (_webdavActive()) {
        try {
          const data = await _notesOp('PATCH', `${NOTES_FOLD_API}/${folder.id}`, { title: next });
          _applyNotesResult(data);
          renderNotesTree();
        } catch (e) {
          folder.title = prev; // rollback
          renderNotesTree();
          await showConfirm(`Could not rename folder: ${e.message}`, { okLabel: 'OK' });
        }
      } else {
        scheduleSaveNotes();
      }
    }
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = prev; input.removeEventListener('blur', commit); titleEl.textContent = prev; }
  });
}

// ---- Collapsible note sections ----
function setNoteSection(sectionId, btnId, open) {
  const section = document.getElementById(sectionId);
  const btn     = document.getElementById(btnId);
  if (section) section.style.display = open ? '' : 'none';
  if (btn)     btn.classList.toggle('card-section-toggle--active', open);
}

function toggleNoteSection(sectionId, btnId) {
  const section = document.getElementById(sectionId);
  setNoteSection(sectionId, btnId, section?.style.display === 'none');
}

function resetNoteSections() {
  const wide = window.innerWidth >= 1200;
  setNoteSection('noteLinkSection',        'noteToggleLink',         wide);
  setNoteSection('noteLinkedCardsSection', 'noteToggleLinkedCards',  wide);
  setNoteSection('noteAttachmentsSection', 'noteToggleAttachments',  wide);
}

// ---- Note Modal ----
let noteModalPageId = null;
let noteModalOrig = { title: '', desc: '', link: '' };
let _pendingNewPage = null; // { page, parentId } — set when "+" is clicked, inserted on first save

async function _crumbNavigate(pageId) {
  if (noteModalHasChanges()) {
    const result = await showConfirm('Save changes before navigating?', { okLabel: 'Save', altLabel: "Don't save", cancelLabel: 'Cancel' });
    if (result === false) return;  // Cancel — stay on page
    if (result === true) await submitNote();
    // null → Don't save, navigate without saving
  }
  openNoteModal(pageId);
}

function _renderCrumb(path, currentTitle = null) {
  const crumb = document.getElementById('noteModalBreadcrumb');
  if (!crumb) return;
  const isNested = path && path.length > 1;
  crumb.style.display = isNested ? '' : 'none';
  crumb.innerHTML = '';
  if (!isNested) return;
  path.forEach((p, i) => {
    if (i > 0) crumb.insertAdjacentHTML('beforeend', '<span class="note-crumb-sep"> › </span>');
    if (i < path.length - 1) {
      const a = document.createElement('a');
      a.className = 'note-crumb-link';
      a.textContent = p.title;
      a.href = '#';
      a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); _crumbNavigate(p.id); });
      crumb.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.textContent = currentTitle ?? p.title;
      crumb.appendChild(span);
    }
  });
}

async function openNoteModal(pageId, focusTitle = false) {
  let page = findNotePage(pageId, notesState.items);
  if (!page && _pendingNewPage?.page.id === pageId) page = _pendingNewPage.page;
  if (!page) return;
  noteModalPageId = pageId;

  document.getElementById('notePageTitle').value = page.title;
  document.getElementById('notePageDesc').value = page.description || '';
  document.getElementById('notePageLink').value = page.link || '';

  noteModalOrig = { title: page.title, desc: page.description || '', link: page.link || '' };

  renderLinkedCards(page.linkedCards || []);

  const notePath = getNotePath(pageId, notesState.items);
  _renderCrumb(notePath);

  if ((page.description || '').trim()) showNoteDescPreview();
  else showNoteDescEditor();

  _updateNoteLinkBtn();
  resetNoteSections();
  if (NOTES_ATTACH_API) loadAttachments(pageId);

  const noteAutoSaveEl = document.getElementById('noteAutoSave');
  if (noteAutoSaveEl) {
    noteAutoSaveEl.checked = state.settings?.autoSaveDialogs ?? false;
    if (noteAutoSaveEl.checked) _startNoteAutoSave(); else _stopNoteAutoSave();
  }
  document.getElementById('noteModal').style.display = 'flex';
  if (!_pendingNewPage) history.replaceState(null, '', '#note:' + pageId);
  const nt = document.getElementById('notePageTitle');
  autoResizeTitle(nt);
  if (focusTitle) requestAnimationFrame(() => { nt.focus(); nt.select(); });

  const loadingEl = document.getElementById('noteModalLoading');

  // WebDAV: fetch fresh content from server
  if (_webdavActive()) {
    const descEl = document.getElementById('notePageDesc');
    if (loadingEl) loadingEl.style.display = 'flex';
    try {
      const data = await fetch(`${NOTES_PAGES_API}/${pageId}/content`).then(r => r.ok ? r.json() : null);
      if (data) {
        descEl.value = data.content || '';
        noteModalOrig.desc = data.content || '';
        page.description   = data.content || '';
        _pageLoadedAt.set(pageId, data.lastModified || null);
      }
    } catch { /* fall back to cached */ }
    finally {
      if (loadingEl) loadingEl.style.display = 'none';
    }
    if (descEl.value.trim()) showNoteDescPreview();
    else showNoteDescEditor();
  } else {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

function closeNoteModal() {
  _stopNoteAutoSave();
  if (location.hash.startsWith('#note:')) history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('noteModal').style.display = 'none';
  document.getElementById('noteCreateCardForm').style.display = 'none';
  noteModalPageId = null;
  _pendingNewPage = null;
}

async function submitNote() {
  if (!noteModalPageId) return;
  let page = findNotePage(noteModalPageId, notesState.items);
  if (!page && _pendingNewPage?.page.id === noteModalPageId) page = _pendingNewPage.page;
  if (!page) return;

  const newTitle = document.getElementById('notePageTitle').value.trim() || 'Untitled';
  const newDesc  = document.getElementById('notePageDesc').value;
  const newLink  = document.getElementById('notePageLink').value.trim();

  const saveBtn = document.getElementById('noteModalSaveBtn');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }
  try { await _submitNote(newTitle, newDesc, newLink, page); }
  finally { if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; } }
}

async function _submitNote(newTitle, newDesc, newLink, page) {

  // First save of a new (pending) page: insert it into state now
  if (_pendingNewPage && _pendingNewPage.page.id === page.id) {
    const { parentId } = _pendingNewPage;
    if (!parentId) {
      notesState.items.push(page);
    } else {
      const parent = findNoteItem(parentId, notesState.items);
      if (parent && parent.type === 'folder') {
        if (!parent.children) parent.children = [];
        parent.children.push(page);
      } else {
        notesState.items.push(page);
      }
    }
    _pendingNewPage = null;
    if (!_webdavActive()) renderNotesTree();
    history.replaceState(null, '', '#note:' + page.id);
  }

  if (_webdavActive()) {
    // Conflict check: re-read the MD file and compare frontmatter lastModified
    const loadedAt = _pageLoadedAt.get(noteModalPageId);
    if (loadedAt) {
      try {
        const r = await fetch(`${NOTES_PAGES_API}/${noteModalPageId}/content`);
        if (r.ok) {
          const { lastModified: serverLM } = await r.json();
          const serverTime = serverLM ? new Date(serverLM).getTime() : 0;
          const localTime  = new Date(loadedAt).getTime();
          if (serverTime > localTime) {
            const overwrite = await showConfirm(
              'A newer version exists on the server. Overwrite it with your changes?',
              { okLabel: 'Overwrite', cancelLabel: 'Cancel' }
            );
            if (!overwrite) return;
          }
        }
      } catch { /* network error — proceed */ }
    }

    try {
      const data = await _notesOp('PATCH', `${NOTES_PAGES_API}/${noteModalPageId}`, {
        title: newTitle, description: newDesc, link: newLink,
        linkedCards: page.linkedCards || [],
      });
      _applyNotesResult(data);
      // Update cache with new server time

    } catch (e) {
      await showConfirm(`Could not save page: ${e.message}`, { okLabel: 'OK' });
      return;
    }
  } else {
    page.lastModified = new Date().toISOString();
    scheduleSaveNotes();
  }

  page.title       = newTitle;
  page.description = newDesc;
  page.link        = newLink;
  noteModalOrig    = { title: newTitle, desc: newDesc, link: newLink };

  _renderCrumb(getNotePath(noteModalPageId, notesState.items));
  renderNotesTree();

  const msg = document.getElementById('noteModalSavedMsg');
  msg.textContent = `${ICONS.done} saved`;
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

function _tocSlug(text, used) {
  let base = text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-') || 'section';
  let slug = base, n = 1;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

function buildToc(el) {
  const placeholder = [...el.querySelectorAll('p')].find(p => p.textContent.trim().toLowerCase() === '[toc]');
  if (!placeholder) return;

  const headings = [...el.querySelectorAll('h1, h2, h3')];
  if (!headings.length) { placeholder.remove(); return; }

  const used = new Set();
  headings.forEach(h => { h.id = 'toc-' + _tocSlug(h.textContent, used); });

  const nav = document.createElement('nav');
  nav.className = 'md-toc';
  const label = document.createElement('span');
  label.className = 'md-toc-label';
  label.textContent = 'Contents';
  nav.appendChild(label);

  const ul = document.createElement('ul');
  headings.forEach((h, i) => {
    const li = document.createElement('li');
    li.className = `md-toc-item md-toc-${h.tagName.toLowerCase()}`;
    const a = document.createElement('a');
    a.textContent = h.textContent;
    a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    li.appendChild(a);
    ul.appendChild(li);
  });
  nav.appendChild(ul);
  placeholder.replaceWith(nav);

  // Highlight the active section while scrolling
  const links = [...nav.querySelectorAll('a')];
  const scrollRoot = el.closest('.note-modal-body') || el.parentElement;
  const obs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const idx = headings.indexOf(entry.target);
      if (idx === -1) return;
      links[idx]?.classList.toggle('md-toc-active', entry.isIntersecting);
    });
  }, { root: scrollRoot, rootMargin: '-8px 0px -80% 0px', threshold: 0 });
  headings.forEach(h => obs.observe(h));
}


function _applyNoteFormat(action) {
  applyDescFormat(document.getElementById('notePageDesc'), action);
}

function showNoteDescPreview() {
  showMarkdownPreview('notePageDesc', 'notePageDescPreview', 'noteDescToolbar', showNoteDescEditor,
    el => { buildToc(el); resolveAttachments(el); });
}

function showNoteDescEditor() {
  document.getElementById('notePageDescPreview').style.display = 'none';
  document.getElementById('notePageDesc').style.display = '';
}

// Save a linkedCards change: PATCH via WebDAV if active, otherwise schedule CouchDB save.
async function _saveLinkedCards(page) {
  if (_webdavActive()) {
    try {
      const data = await _notesOp('PATCH', `${NOTES_PAGES_API}/${page.id}`, {
        linkedCards: page.linkedCards,
      });
      _applyNotesResult(data);
    } catch (e) {
      console.warn('WebDAV linked cards save failed, using CouchDB:', e.message);
      scheduleSaveNotes();
    }
  } else {
    scheduleSaveNotes();
  }
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
        `<span class="note-mini-card-text${isGone ? ' note-mini-card-text--gone' : ''}" title="${escHtml(text)}">${escHtml(text)}</span>` +
      `</div>` +
      `<button class="note-mini-card-remove" title="Unlink card">${ICONS.close}</button>`;

    if (card && col) {
      mini.querySelector('.note-mini-card-body').addEventListener('click', () => { closeNoteModal(); openEditModal(col.id, card); });
    }
    mini.querySelector('.note-mini-card-remove').addEventListener('click', async e => {
      e.stopPropagation();
      const page = findNotePage(noteModalPageId, notesState.items);
      if (!page) return;
      page.linkedCards  = (page.linkedCards || []).filter(c => c !== id);
      page.lastModified = new Date().toISOString();
      renderLinkedCards(page.linkedCards);
      render();
      await _saveLinkedCards(page);
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

async function createAndLinkCard(text) {
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

  const target = findNotePage(noteModalPageId, notesState.items);
  if (target && !(target.linkedCards || []).includes(cardId)) {
    (target.linkedCards ??= []).push(cardId);
    target.lastModified = new Date().toISOString();
    renderLinkedCards(target.linkedCards);
    await _saveLinkedCards(target);
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

    const page = findNotePage(noteModalPageId, notesState.items);
    const linked = new Set(page?.linkedCards || []);
    const matches = [];
    for (const col of (state.columns || [])) {
      for (const card of col.cards) {
        if (!linked.has(card.id) && card.text.toLowerCase().includes(q))
          matches.push({ id: card.id, text: card.text, col: col.title });
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
      item.addEventListener('click', async () => {
        const page = findNotePage(noteModalPageId, notesState.items);
        if (!page) return;
        if (!page.linkedCards) page.linkedCards = [];
        if (!page.linkedCards.includes(card.id)) {
          page.linkedCards.push(card.id);
          page.lastModified = new Date().toISOString();
          renderLinkedCards(page.linkedCards);
          render();
          await _saveLinkedCards(page);
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
  const item = e.target.closest('.notes-tree-item--page');
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

  const pageId = item.dataset.itemId || item.dataset.pageId;
  const target = findNotePage(pageId, notesState.items);
  if (!target || (target.linkedCards || []).includes(cardId)) return;

  const label = card.text.length > 60 ? card.text.slice(0, 60) + '…' : card.text;
  if (!await showConfirm(`Link "${label}" to page "${target.title}"?`, { okLabel: 'Link card' })) return;

  (target.linkedCards ??= []).push(cardId);
  target.lastModified = new Date().toISOString();
  if (noteModalPageId === pageId) renderLinkedCards(target.linkedCards);
  render();
  await _saveLinkedCards(target);
}, true);

function initNotesDropZone() { /* wired above via document capture listeners */ }

// ---- Touch: card → notes page link ----
document.addEventListener('touchmove', e => {
  if (!touchDrag || touchDrag.type !== 'card') return;
  const t = e.touches[0];
  touchDrag.ghost.el.style.display = 'none';
  const under = document.elementFromPoint(t.clientX, t.clientY);
  touchDrag.ghost.el.style.display = '';
  const item = under?.closest('.notes-tree-item--page');
  if (_notesDragOverItem && _notesDragOverItem !== item) {
    _notesDragOverItem.classList.remove('notes-tree-item--drag-over');
    _notesDragOverItem = null;
  }
  if (item && _notesDragOverItem !== item) {
    item.classList.add('notes-tree-item--drag-over');
    _notesDragOverItem = item;
  }
}, { capture: true, passive: true });

document.addEventListener('touchend', e => {
  if (!touchDrag || touchDrag.type !== 'card') return;
  const item = _notesDragOverItem;
  _notesDragOverItem = null;
  if (!item) return;
  const { colId, cardId } = touchDrag;
  (async () => {
    const col  = state.columns.find(c => c.id === colId);
    const card = col?.cards.find(c => c.id === cardId);
    if (!card) return;
    const pageId = item.dataset.itemId || item.dataset.pageId;
    const target = findNotePage(pageId, notesState.items);
    if (!target || (target.linkedCards || []).includes(cardId)) return;
    const label = card.text.length > 60 ? card.text.slice(0, 60) + '…' : card.text;
    if (!await showConfirm(`Link "${label}" to page "${target.title}"?`, { okLabel: 'Link card' })) return;
    (target.linkedCards ??= []).push(cardId);
    target.lastModified = new Date().toISOString();
    if (noteModalPageId === pageId) renderLinkedCards(target.linkedCards);
    render();
    await _saveLinkedCards(target);
  })();
}, true);

// ---- Attachments ----


async function loadAttachments(pageId) {
  const list = document.getElementById('noteAttachList');
  if (!list || !NOTES_ATTACH_API) return;
  try {
    const r = await fetch(`${NOTES_ATTACH_API}/${pageId}`);
    renderAttachments(pageId, r.ok ? await r.json() : []);
  } catch { renderAttachments(pageId, []); }
}

function renderAttachments(pageId, files) {
  const list = document.getElementById('noteAttachList');
  if (!list) return;
  list.innerHTML = '';

  const page = findNotePage(pageId, notesState.items);
  if (page && !!page.hasAttachments !== (files.length > 0)) {
    page.hasAttachments = files.length > 0;
    page.lastModified   = new Date().toISOString();
    scheduleSaveNotes();
    renderNotesTree();
  }
  if (!files.length) {
    const p = document.createElement('p');
    p.className = 'note-attach-empty';
    p.textContent = 'No attachments yet';
    list.appendChild(p);
    return;
  }
  for (const f of files) {
    const ft  = _attachType(f.name);
    const url = `${NOTES_ATTACH_API}/${pageId}/${encodeURIComponent(f.name)}`;
    const item = document.createElement('div');
    item.className = 'note-attach-item';
    const icon = (ft === 'image' || ft === 'svg') ? ICONS.fileImage : ft === 'pdf' ? ICONS.filePdf : ft === 'html' ? ICONS.fileWeb : ICONS.fileGeneric;
    item.innerHTML =
      `<span class="note-attach-icon">${icon}</span>` +
      `<span class="note-attach-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>` +
      `<span class="note-attach-size">${_fmtSize(f.size)}</span>` +
      `<div class="note-attach-btns">` +
        (ft === 'image' || ft === 'pdf' ? `<button class="note-attach-btn" data-act="view" title="View fullscreen">⛶</button>` : '') +
        (ft === 'html' ? `<button class="note-attach-btn" data-act="view" title="Open in new tab">⛶</button>` : '') +
        `<button class="note-attach-btn" data-act="insert"   title="Insert in description">⌅</button>` +
        `<button class="note-attach-btn" data-act="download" title="Download">${ICONS.download}</button>` +
        `<button class="note-attach-btn note-attach-btn--del" data-act="delete" title="Delete">${ICONS.close}</button>` +
      `</div>`;

    if (ft === 'image' || ft === 'pdf')
      item.querySelector('[data-act="view"]').addEventListener('click', () => openAttachmentViewer(url, f.name, ft));
    else if (ft === 'html')
      item.querySelector('[data-act="view"]').addEventListener('click', () => _openInNewTab(url));
    item.querySelector('[data-act="insert"]').addEventListener('click',   () => _insertAttachmentMd(f.name, ft));
    item.querySelector('[data-act="download"]').addEventListener('click', () => _downloadAttachment(url, f.name));
    item.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!await showConfirm(`Delete "${f.name}"?`, { okLabel: 'Delete', danger: true })) return;
      await fetch(`${NOTES_ATTACH_API}/${pageId}/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
      loadAttachments(pageId);
    });
    list.appendChild(item);
  }
}

async function _handleAttachUpload(pageId, fileList) {
  if (!NOTES_ATTACH_API || !fileList.length) return;
  const label = document.querySelector('label[for="noteAttachInput"]');
  const input = document.getElementById('noteAttachInput');
  if (label) label.textContent = 'Uploading…';
  if (input) input.disabled = true;
  try {
    for (const file of Array.from(fileList)) {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`${NOTES_ATTACH_API}/${pageId}`, { method: 'POST', body: fd });
      if (r.ok) {
        _appendAttachMd('notePageDesc', (await r.json()).name, `_attachments/${pageId}_`);
      } else {
        const data = await r.json().catch(() => ({}));
        await showConfirm(data.error || 'Upload failed.', { okLabel: 'OK' });
      }
    }
  } finally {
    if (label) label.textContent = '+ Upload';
    if (input) input.disabled = false;
    loadAttachments(pageId);
  }
}

function _insertAttachmentMd(name, type) {
  const ta = document.getElementById('notePageDesc');
  if (!ta) return;
  showNoteDescEditor();
  ta.focus();
  const pfx = `_attachments/${noteModalPageId}_`;
  const md = (type === 'image' || type === 'svg') ? `![${name}](${pfx}${name})` : `[${name}](${pfx}${name})`;
  const s = ta.selectionStart ?? ta.value.length;
  ta.setRangeText(md, s, ta.selectionEnd ?? s, 'end');
}

async function _downloadAttachment(url, name) {
  const r = await fetch(url);
  if (!r.ok) return;
  _triggerBlobDownload(await r.blob(), name);
}

function _triggerBlobDownload(blob, name) {
  const obj = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = obj; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(obj), 1000);
}

// Resolve attachment: links/images in rendered markdown using blob URLs (auth-safe)
async function resolveAttachments(container) {
  if (!noteModalPageId || !NOTES_ATTACH_API) return;
  const base = `${NOTES_ATTACH_API}/${noteModalPageId}`;

  const attachPfx = `_attachments/${noteModalPageId}_`;

  for (const img of container.querySelectorAll('img[src^="_attachments/"]')) {
    const fn = img.getAttribute('src').slice(attachPfx.length);
    try {
      const r = await fetch(`${base}/${encodeURIComponent(fn)}`);
      if (!r.ok) continue;
      const obj = URL.createObjectURL(await r.blob());
      if (_attachType(fn) === 'pdf') {
        const embed = document.createElement('embed');
        embed.src = obj;
        embed.type = 'application/pdf';
        embed.className = 'md-pdf-embed';
        img.replaceWith(embed);
      } else {
        img.src = obj;
      }
    } catch {}
  }

  for (const a of container.querySelectorAll('a[href^="_attachments/"]')) {
    const fn = a.getAttribute('href').slice(attachPfx.length);
    const url = `${base}/${encodeURIComponent(fn)}`;
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
    const ft = _attachType(fn);
    if (ft === 'image' || ft === 'pdf')
      a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openAttachmentViewer(url, fn, ft); });
    else if (ft === 'html')
      a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); _openInNewTab(url); });
    else
      a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); _downloadAttachment(url, fn); });
  }
}

// ---- Attachment fullscreen viewer ----
let _viewerBlob = null;

async function openAttachmentViewer(url, name, type) {
  const viewer  = document.getElementById('attachViewer');
  const content = document.getElementById('attachViewerContent');
  document.getElementById('attachViewerName').textContent = name;
  content.innerHTML = '<span class="note-attach-empty">Loading…</span>';
  viewer.style.display = 'flex';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Failed');
    _viewerBlob = await r.blob();
    const obj = URL.createObjectURL(_viewerBlob);
    content.innerHTML = '';
    if (type === 'image') {
      const img = document.createElement('img');
      img.src = obj; img.className = 'attach-viewer-img';
      content.appendChild(img);
    } else {
      const iframe = document.createElement('iframe');
      iframe.src = obj; iframe.className = 'attach-viewer-iframe';
      if (type !== 'pdf') iframe.sandbox = 'allow-scripts allow-same-origin';
      content.appendChild(iframe);
    }
    document.getElementById('attachViewerDl').onclick = () => _triggerBlobDownload(_viewerBlob, name);
  } catch {
    content.innerHTML = '<span class="note-attach-empty">Failed to load file</span>';
  }
}

function closeAttachmentViewer() {
  document.getElementById('attachViewer').style.display = 'none';
  document.getElementById('attachViewerContent').innerHTML = '';
  _viewerBlob = null;
}

// ---- Notes tree drag & drop ----
let _treeDragId = null;

function _removeFromTree(id, items) {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === id) return items.splice(i, 1)[0];
    if (items[i].type === 'folder') {
      const r = _removeFromTree(id, items[i].children || []);
      if (r) return r;
    }
  }
  return null;
}

function _insertIntoTree(dragged, targetId, position, items) {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === targetId) {
      if (position === 'before') { items.splice(i, 0, dragged); return true; }
      if (position === 'after')  { items.splice(i + 1, 0, dragged); return true; }
      if (position === 'into' && items[i].type === 'folder') {
        if (!items[i].children) items[i].children = [];
        items[i].children.unshift(dragged);
        return true;
      }
    }
    if (items[i].type === 'folder' && _insertIntoTree(dragged, targetId, position, items[i].children || [])) return true;
  }
  return false;
}

function _clearTreeDrop() {
  document.querySelectorAll(
    '.notes-tree-item--drop-before,.notes-tree-item--drop-after,.notes-tree-item--drop-into'
  ).forEach(el => el.classList.remove(
    'notes-tree-item--drop-before', 'notes-tree-item--drop-after', 'notes-tree-item--drop-into'
  ));
}

function _initTreeTouchDragDrop() {
  const container = document.getElementById('notesTreeBody');
  if (!container) return;

  let ttDragId   = null;
  let ttDragEl   = null;
  let ttGhost    = null;
  let ttOverItem = null;
  let ttStartX   = 0;
  let ttStartY   = 0;
  let ttActive   = false;

  function _ttClearGhost() {
    if (ttGhost) { ttGhost.remove(); ttGhost = null; }
    if (ttDragEl) { ttDragEl.classList.remove('notes-tree-item--dragging'); }
  }

  function _ttUpdateDrop(x, y) {
    if (ttGhost) ttGhost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (ttGhost) ttGhost.style.display = '';

    const item = el?.closest('.notes-tree-item');
    if (ttOverItem && ttOverItem !== item) { _clearTreeDrop(); ttOverItem = null; }
    if (!item || item.dataset.itemId === ttDragId) return;

    const rect     = item.getBoundingClientRect();
    const ratio    = (y - rect.top) / rect.height;
    const isFolder = item.dataset.itemType === 'folder';
    const canInto  = isFolder;

    _clearTreeDrop();
    if      (ratio < 0.3)             item.classList.add('notes-tree-item--drop-before');
    else if (ratio > 0.7)             item.classList.add('notes-tree-item--drop-after');
    else if (canInto)                 item.classList.add('notes-tree-item--drop-into');
    else if (ratio <= 0.5)            item.classList.add('notes-tree-item--drop-before');
    else                              item.classList.add('notes-tree-item--drop-after');
    ttOverItem = item;
  }

  container.addEventListener('touchstart', e => {
    const item = e.target.closest('.notes-tree-item');
    if (!item || e.target.closest('button')) return;
    ttDragId  = item.dataset.itemId;
    ttDragEl  = item;
    ttStartX  = e.touches[0].clientX;
    ttStartY  = e.touches[0].clientY;
    ttActive  = false;
  }, { passive: true });

  container.addEventListener('touchmove', e => {
    if (!ttDragId) return;
    const t  = e.touches[0];
    const dx = t.clientX - ttStartX;
    const dy = t.clientY - ttStartY;

    if (!ttActive) {
      if (Math.hypot(dx, dy) < 10) return;
      ttActive = true;
      const rect = ttDragEl.getBoundingClientRect();
      ttGhost = ttDragEl.cloneNode(true);
      Object.assign(ttGhost.style, {
        position: 'fixed',
        left: rect.left + 'px',
        top: rect.top + 'px',
        width: rect.width + 'px',
        margin: '0',
        zIndex: '9999',
        opacity: '0.85',
        pointerEvents: 'none',
        transform: 'scale(1.02)',
        boxShadow: '0 8px 32px rgba(0,0,0,.45)',
        transition: 'none',
      });
      document.body.appendChild(ttGhost);
      ttDragEl.classList.add('notes-tree-item--dragging');
    }

    e.preventDefault();
    ttGhost.style.left = (t.clientX - (ttStartX - parseFloat(ttGhost.style.left))) + 'px';
    ttGhost.style.top  = (t.clientY - (ttStartY - parseFloat(ttGhost.style.top)))  + 'px';
    ttStartX = t.clientX;
    ttStartY = t.clientY;

    // Auto-scroll the sidebar
    const sidebar = document.getElementById('notesSidebar');
    const sr = sidebar?.getBoundingClientRect();
    if (sr) {
      if (t.clientY < sr.top + 60)    sidebar.scrollTop -= 8;
      if (t.clientY > sr.bottom - 60) sidebar.scrollTop += 8;
    }

    _ttUpdateDrop(t.clientX, t.clientY);
  }, { passive: false });

  function _ttEnd(e) {
    if (!ttDragId) return;
    const savedId = ttDragId;
    const wasActive = ttActive;
    ttDragId  = null;
    ttActive  = false;
    _ttClearGhost();
    ttDragEl  = null;

    if (!wasActive) { _clearTreeDrop(); ttOverItem = null; return; }

    const item = ttOverItem;
    ttOverItem = null;
    if (!item || item.dataset.itemId === savedId) { _clearTreeDrop(); return; }

    const position = item.classList.contains('notes-tree-item--drop-before') ? 'before'
                   : item.classList.contains('notes-tree-item--drop-after')  ? 'after'
                   : item.classList.contains('notes-tree-item--drop-into')   ? 'into'
                   : null;
    _clearTreeDrop();
    if (!position) return;

    const dragged = _removeFromTree(savedId, notesState.items);
    if (!dragged) return;
    if (position === 'into') { notesExpanded.add(item.dataset.itemId); _saveTreeOpenState(); }
    _insertIntoTree(dragged, item.dataset.itemId, position, notesState.items);

    if (_webdavActive()) {
      const isFolder  = dragged.type === 'folder';
      const moveApi   = isFolder ? `${NOTES_FOLD_API}/${dragged.id}/move` : `${NOTES_PAGES_API}/${dragged.id}/move`;
      const newParent = position === 'into' ? item.dataset.itemId : null;
      _notesOp('POST', moveApi, { folderId: newParent, parentId: newParent })
        .then(data => { _applyNotesResult(data); renderNotesTree(); })
        .catch(async e => {
          await showConfirm(`Could not move item: ${e.message}`, { okLabel: 'OK' });
          await loadNotes();
        });
    } else {
      scheduleSaveNotes();
    }
    renderNotesTree();
  }

  container.addEventListener('touchend',    _ttEnd, { passive: true });
  container.addEventListener('touchcancel', _ttEnd, { passive: true });
}

function _initTreeDragDrop() {
  const container = document.getElementById('notesTreeBody');
  if (!container) return;

  container.addEventListener('dragstart', e => {
    const item = e.target.closest('.notes-tree-item');
    if (!item) return;
    _treeDragId = item.dataset.itemId;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => item.classList.add('notes-tree-item--dragging'), 0);
  });

  container.addEventListener('dragend', () => {
    _treeDragId = null;
    _clearTreeDrop();
    container.querySelectorAll('.notes-tree-item--dragging')
      .forEach(el => el.classList.remove('notes-tree-item--dragging'));
  });

  container.addEventListener('dragover', e => {
    if (!_treeDragId) return;
    const item = e.target.closest('.notes-tree-item');
    if (!item || item.dataset.itemId === _treeDragId) { _clearTreeDrop(); return; }

    const rect     = item.getBoundingClientRect();
    const ratio    = (e.clientY - rect.top) / rect.height;
    const isFolder = item.dataset.itemType === 'folder';

    _clearTreeDrop();
    if      (ratio < 0.3)  item.classList.add('notes-tree-item--drop-before');
    else if (ratio > 0.7)  item.classList.add('notes-tree-item--drop-after');
    else if (isFolder)     item.classList.add('notes-tree-item--drop-into');
    else if (ratio <= 0.5) item.classList.add('notes-tree-item--drop-before');
    else                   item.classList.add('notes-tree-item--drop-after');

    if (item.classList.contains('notes-tree-item--drop-before') ||
        item.classList.contains('notes-tree-item--drop-after')  ||
        item.classList.contains('notes-tree-item--drop-into')) {
      e.preventDefault();
    }
  });

  container.addEventListener('dragleave', e => {
    if (!container.contains(e.relatedTarget)) _clearTreeDrop();
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    if (!_treeDragId) return;
    const item = e.target.closest('.notes-tree-item');
    if (!item || item.dataset.itemId === _treeDragId) { _clearTreeDrop(); return; }

    const position = item.classList.contains('notes-tree-item--drop-before') ? 'before'
                   : item.classList.contains('notes-tree-item--drop-after')  ? 'after'
                   : item.classList.contains('notes-tree-item--drop-into')   ? 'into'
                   : null;
    _clearTreeDrop();
    if (!position) return;

    const targetId = item.dataset.itemId;
    const dragged  = _removeFromTree(_treeDragId, notesState.items);
    if (!dragged) return;

    if (position === 'into') { notesExpanded.add(targetId); _saveTreeOpenState(); }
    _insertIntoTree(dragged, targetId, position, notesState.items);

    if (_webdavActive()) {
      const isFolder  = dragged.type === 'folder';
      const moveApi   = isFolder ? `${NOTES_FOLD_API}/${dragged.id}/move` : `${NOTES_PAGES_API}/${dragged.id}/move`;
      // Determine new parent: 'into' → targetId is the folder; before/after → parent of target
      const newParent = position === 'into' ? targetId : null;
      _notesOp('POST', moveApi, { folderId: newParent, parentId: newParent })
        .then(data => { _applyNotesResult(data); renderNotesTree(); })
        .catch(async e => {
          await showConfirm(`Could not move item: ${e.message}`, { okLabel: 'OK' });
          await loadNotes(); // reload to undo optimistic update
        });
    } else {
      scheduleSaveNotes();
    }
    renderNotesTree();
  });
}

// ---- DOMContentLoaded wiring ----
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('noteAutoSave')?.addEventListener('change', e => {
    if (e.target.checked) _startNoteAutoSave(); else _stopNoteAutoSave();
  });

  initNotesDropZone();
  _initTreeDragDrop();
  _initTreeTouchDragDrop();
  initSidebarResize();
  document.getElementById('notesToggleBtn')?.addEventListener('click', toggleNotesSidebar);
  document.getElementById('notesAddRootBtn')?.addEventListener('click', () => addNotePage(null));
  document.getElementById('notesAddFolderBtn')?.addEventListener('click', () => addNoteFolder(null));
  document.getElementById('notesSidebarFontBtn')?.addEventListener('click', toggleNotesFontSize);
  document.getElementById('notesSyncBtn')?.addEventListener('click', syncNotesWithWebdav);

  document.getElementById('noteToggleLink')        ?.addEventListener('click', () => toggleNoteSection('noteLinkSection',        'noteToggleLink'));
  document.getElementById('noteToggleLinkedCards') ?.addEventListener('click', () => toggleNoteSection('noteLinkedCardsSection', 'noteToggleLinkedCards'));
  document.getElementById('noteToggleAttachments') ?.addEventListener('click', () => toggleNoteSection('noteAttachmentsSection', 'noteToggleAttachments'));
  // Attachment upload
  document.getElementById('noteAttachInput')?.addEventListener('change', e => {
    if (noteModalPageId) _handleAttachUpload(noteModalPageId, e.target.files);
    e.target.value = '';
  });

  // Attachment viewer
  document.getElementById('attachViewerClose')?.addEventListener('click', closeAttachmentViewer);
  document.getElementById('attachViewer')?.addEventListener('click', e => {
    if (e.target === document.getElementById('attachViewer')) closeAttachmentViewer();
  });

  // Note modal backdrop click
  let _noteModalMousedown = false;
  document.getElementById('noteModal')?.addEventListener('mousedown', e => {
    _noteModalMousedown = e.target.id === 'noteModal';
  });
  document.getElementById('noteModal')?.addEventListener('click', e => {
    if (_noteModalMousedown && e.target.id === 'noteModal') tryCloseNoteModal();
  });

  document.getElementById('noteModalCancelBtn')?.addEventListener('click', () => tryCloseNoteModal());
  document.getElementById('noteModalSaveBtn')?.addEventListener('click', async () => { await submitNote(); closeNoteModal(); });
  document.getElementById('noteModalDeleteBtn')?.addEventListener('click', async () => {
    if (!noteModalPageId) return;
    const page = findNotePage(noteModalPageId, notesState.items);
    if (!page) return;
    if (await showConfirm(`Delete page "${page.title}"?`, { okLabel: 'Delete', danger: true })) {
      const id = noteModalPageId;
      closeNoteModal();
      deleteNoteItem(id);
    }
  });

  // Description preview / editor
  document.getElementById('notePageDescPreview')?.addEventListener('click', e => {
    clickPreviewToEditor(document.getElementById('notePageDescPreview'), 'notePageDesc', showNoteDescEditor, e);
  });
  document.getElementById('notePageDesc')?.addEventListener('blur', () => {
    if (document.getElementById('notePageDesc').value.trim()) showNoteDescPreview();
  });

  // Markdown shortcuts in description
  document.getElementById('notePageDesc')?.addEventListener('keydown', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    const markers = e.key === 'b' ? ['**','**'] : e.key === 'i' ? ['*','*'] : e.key === 'u' ? ['<u>','</u>'] : e.key === 'm' ? ['<mark>','</mark>'] : null;
    if (!markers) return;
    e.preventDefault();
    const ta = e.target, s = ta.selectionStart, en = ta.selectionEnd;
    ta.setRangeText(markers[0] + ta.value.slice(s, en) + markers[1], s, en, 'select');
    if (s === en) { const mid = s + markers[0].length; ta.setSelectionRange(mid, mid); }
  });

  // Title key handling
  document.getElementById('notePageTitle')?.addEventListener('focus', e => {
    if (e.target.value === 'New Page') { e.target.value = ''; autoResizeTitle(e.target); }
  });
  document.getElementById('notePageTitle')?.addEventListener('blur', e => {
    if (!e.target.value.trim()) { e.target.value = 'New Page'; autoResizeTitle(e.target); }
  });
  document.getElementById('notePageTitle')?.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\n/g, ''); // no newlines in title
    autoResizeTitle(e.target);
    const path = getNotePath(noteModalPageId, notesState.items);
    if (path && path.length > 1) {
      const live = e.target.value.trim() || 'New Page';
      _renderCrumb(path, live);
    }
  });
  document.getElementById('notePageTitle')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitNote(); document.getElementById('notePageDesc').focus(); }
    if (e.key === 'Escape') tryCloseNoteModal();
  });

  // Global Escape closes note modal (or viewer if open)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('attachViewer')?.style.display !== 'none') {
      closeAttachmentViewer(); return;
    }
    if (e.key === 'Escape' && document.getElementById('noteModal')?.style.display !== 'none') {
      // Only close if no other modal is on top
      const otherOpen = ['modal','settingsBackdrop','promptsBackdrop','searchBackdrop','cardInfoBackdrop','dialogBackdrop']
        .some(id => document.getElementById(id)?.style.display !== 'none');
      if (!otherOpen) tryCloseNoteModal();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && document.getElementById('noteModal')?.style.display !== 'none') {
      e.preventDefault();
      submitNote();
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.getElementById('noteModal')?.style.display !== 'none') {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const preview = document.getElementById('notePageDescPreview');
      const target = preview?.style.display !== 'none' ? preview : null;
      if (!target) return;
      e.preventDefault();
      target.scrollTop += e.key === 'ArrowDown' ? 80 : -80;
    }
  });

  // Link open button
  document.getElementById('notePageLink')?.addEventListener('input', _updateNoteLinkBtn);
  document.getElementById('notePageLinkOpen')?.addEventListener('click', () => {
    const url = document.getElementById('notePageLink').value.trim();
    if (url) window.open(url, '_blank', 'noopener');
  });

  // Description toolbar
  const _toolbar = document.getElementById('noteDescToolbar');
  const _descTa  = document.getElementById('notePageDesc');
  _descTa?.addEventListener('focus', () => { if (_toolbar) _toolbar.style.display = 'flex'; });
  _descTa?.addEventListener('blur',  () => { if (_toolbar) _toolbar.style.display = 'none'; });
  _toolbar?.querySelectorAll('.note-tb-btn').forEach(btn => {
    btn.addEventListener('pointerdown', e => e.preventDefault()); // keep focus on textarea
    btn.addEventListener('click', () => _applyNoteFormat(btn.dataset.fmt));
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
