/**
 * notes-webdav/frontend/notes.js
 *
 * Self-contained notes + WebDAV frontend module.
 * Call initNotes(cfg) once after the DOM is ready and auth is complete.
 *
 * @param {object} cfg
 * @param {string}   cfg.apiBase        - e.g. "/api/myboard"
 * @param {string}   [cfg.boardName]    - for document.title updates
 * @param {boolean}  [cfg.webdavEnabled] - initial WebDAV enabled state
 *
 * @param {object} cfg.hooks
 *   scheduleSave()                     - debounce-save the board state
 *   render()                           - re-render the board
 *   showConfirm(msg, opts)             - returns Promise<bool|string>
 *   escHtml(s)                         - HTML-escapes a string
 *   openEditModal(colId, card)         - open the card edit modal
 *   uid()                              - generate a unique ID (returns string)
 *   getColumns()                       - returns the current columns array
 *   getSettings()                      - returns the current settings object
 *   getCardAttachCount(cardId)         - returns number|null
 *   createCard(text)                   - creates a card in inbox, returns cardId
 *
 * @param {object} cfg.icons
 *   collapse, expand, done             - unicode/HTML strings
 *   svgNetworkFolder(w,h)
 *   svgFolder(w,h)
 *   svgDelete()
 *   svgClose()
 *   svgAttachment()
 *   svgFileImage(), svgFilePdf(), svgFileWeb()
 *   svgLink(w,h), svgLinkedCards(w,h), svgAttachmentSm(w,h)
 *
 * @param {object} cfg.markdown
 *   render(text)                       - returns safe HTML string
 *
 * @param {object} cfg.editor
 *   create(fieldId, opts)              - initialise markdown editor on <textarea id=fieldId>
 *   setValue(fieldId, text)
 *   getValue(fieldId)
 *   isActive(fieldId)
 *   focus(fieldId)
 *   applyFormat(fieldId, fmt)
 *
 * @param {object} cfg.print
 *   buildItem({ board, context, title, body, footerRows })  - returns HTML string
 *   trigger(rootEl)                    - open print dialog
 *   fmtDate(date)                      - format date for footer
 *
 * @returns {object} public API
 */
function initNotes(cfg) {
  // ---- Resolved cfg helpers ----
  const _icons    = cfg.icons    || {};
  const _editor   = cfg.editor   || {};
  const _print    = cfg.print    || {};
  const _markdown = cfg.markdown || {};
  const _hooks    = cfg.hooks    || {};

  function _escHtml(s)               { return _hooks.escHtml ? _hooks.escHtml(s) : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _showConfirm(msg, opts)   { return _hooks.showConfirm ? _hooks.showConfirm(msg, opts) : Promise.resolve(window.confirm(msg)); }
  function _scheduleSave()           { if (_hooks.scheduleSave) _hooks.scheduleSave(); }
  function _render()                 { if (_hooks.render) _hooks.render(); }
  function _openEditModal(colId, c)  { if (_hooks.openEditModal) _hooks.openEditModal(colId, c); }
  function _uid()                    { return _hooks.uid ? _hooks.uid() : Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2,'0')).join(''); }
  function _getColumns()             { return _hooks.getColumns ? _hooks.getColumns() : []; }
  function _getSettings()            { return _hooks.getSettings ? _hooks.getSettings() : {}; }
  function _getCardAttachCount(id)   { return _hooks.getCardAttachCount ? _hooks.getCardAttachCount(id) : null; }
  async function _createCard(text)   { return _hooks.createCard ? _hooks.createCard(text) : null; }

  function autoResizeTitle(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

  // ---- WebDAV enabled state ----
  let _webdavEnabled = !!(cfg.webdavEnabled);

  function updateWebdavEnabled(enabled) {
    _webdavEnabled = !!enabled;
    _updateWebdavUi();
  }

  // ---- API URLs ----
  const _base         = cfg.apiBase || null;
  const NOTES_API        = _base ? `${_base}/notes`             : null;
  const NOTES_ATTACH_API = _base ? `${_base}/notes/attachments` : null;
  const NOTES_PAGES_API  = _base ? `${_base}/notes/pages`       : null;
  const NOTES_FOLD_API   = _base ? `${_base}/notes/folders`     : null;

  function _webdavActive() { return !!(_webdavEnabled && NOTES_PAGES_API); }

  // ---- Notes auto-save ----
  let _noteAutoSaveTimer = null;

  function _stopNoteAutoSave() {
    clearInterval(_noteAutoSaveTimer);
    _noteAutoSaveTimer = null;
  }

  function _startNoteAutoSave() {
    _stopNoteAutoSave();
    const ms = (_getSettings()?.autoSaveIntervalMin ?? 5) * 60 * 1000;
    _noteAutoSaveTimer = setInterval(() => {
      if (noteModalHasChanges()) submitNote();
    }, ms);
  }

  // ---- Notes State ----
  let notesState     = { items: [], schemaVersion: 2 };
  let baseNotesState = null;
  let notesEtag      = null;
  let notesSaveTimer    = null;
  let _notesSaving      = false;
  let _notesSavePending = false;

  // lastModified from frontmatter at the time each page was loaded — used for conflict detection
  const _pageLoadedAt = new Map();

  // Reference-counted sync-button spinner
  let _webdavPending = 0;
  function _webdavBtnSpin(delta) {
    _webdavPending = Math.max(0, _webdavPending + delta);
    const btn = document.getElementById('notesSyncBtn');
    if (btn) btn.classList.toggle('notes-sync-btn--spinning', _webdavPending > 0);
  }

  // Call a per-operation notes endpoint; returns parsed JSON or throws
  async function _notesOp(method, url, body) {
    _webdavBtnSpin(+1);
    try {
      const r = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body:    body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    } finally {
      _webdavBtnSpin(-1);
    }
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
    return { items: [], schemaVersion: 2 };
  }

  function _updateWebdavUi() {
    const webdavOn = _webdavEnabled;
    const labelEl  = document.getElementById('notesSidebarLabel');
    const syncBtn  = document.getElementById('notesSyncBtn');
    if (labelEl) labelEl.innerHTML = webdavOn
      ? (_icons.svgNetworkFolder ? _icons.svgNetworkFolder(12, 12) : '') + '\u00a0Notes'
      : 'Notes';
    if (syncBtn)  syncBtn.style.display = webdavOn ? '' : 'none';
  }

  async function loadNotes() {
    if (!NOTES_API) return;

    const treeBody = document.getElementById('notesTreeBody');
    if (treeBody) treeBody.innerHTML = '<p class="notes-empty notes-loading">Loading\u2026</p>';
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
    _render();
  }

  let _syncInProgress = false;

  async function _runWebdavSync() {
    if (_syncInProgress) return;
    _syncInProgress = true;
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
    }
  }

  async function syncNotesWithWebdav() {
    if (_syncInProgress || !_webdavEnabled) return;
    await _runWebdavSync();
  }

  // DFS-flatten only pages from the items tree → Map<id, pageFields>
  function _flattenNotePages(items, out = new Map()) {
    for (const item of items) {
      if (item.type === 'page') {
        const { children, ...own } = item;
        out.set(item.id, own);
      } else if (item.type === 'folder') {
        _flattenNotePages(item.children || [], out);
      } else {
        const { children, ...own } = item;
        out.set(item.id, own);
        if (item.children?.length) _flattenNotePages(item.children, out);
      }
    }
    return out;
  }

  function _itemDFSStructure(items, out = []) {
    for (const item of items) {
      out.push((item.type || 'page')[0] + ':' + item.id);
      if (item.type === 'folder') _itemDFSStructure(item.children || [], out);
    }
    return out;
  }

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
    if (_notesSaving) { _notesSavePending = true; return; }
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(async () => {
      notesSaveTimer = null;
      if (!NOTES_API) return;
      _notesSaving = true;
      try {
        let r;
        const headers = { 'Content-Type': 'application/json' };
        if (notesEtag) headers['If-Match'] = notesEtag;
        if (baseNotesState) {
          const patch = buildNotesPatch(baseNotesState, notesState);
          if (patch !== null) {
            if (!Object.keys(patch).length) return;
            r = await fetch(NOTES_API, { method: 'PATCH', headers, body: JSON.stringify(patch) });
          } else {
            r = await fetch(NOTES_API, { method: 'PUT', headers, body: JSON.stringify(notesState) });
          }
        } else {
          r = await fetch(NOTES_API, { method: 'PUT', headers, body: JSON.stringify(notesState) });
        }
        if (r.status === 409) {
          await loadNotes();
          scheduleSaveNotes();
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const newEtag = r.headers.get('ETag');
        if (newEtag) notesEtag = newEtag;
        baseNotesState = JSON.parse(JSON.stringify(notesState));
      } catch (e) { console.error('Notes save failed:', e.message); }
      finally {
        _notesSaving = false;
        if (_notesSavePending) { _notesSavePending = false; scheduleSaveNotes(); }
      }
    }, 600);
  }

  function _removeItem(id, items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === id) { items.splice(i, 1); return true; }
      if (items[i].type === 'folder' && items[i].children?.length && _removeItem(id, items[i].children)) return true;
    }
    return false;
  }

  // ---- Notes Tree Helpers ----

  function _treeStateKey() {
    return 'notes-tree-open-' + (_base || 'local');
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

  function findNoteItem(id, items) {
    for (const item of items) {
      if (item.id === id) return item;
      if (item.type === 'folder') { const f = findNoteItem(id, item.children || []); if (f) return f; }
    }
    return null;
  }

  function findNotePage(id, items) {
    for (const item of items) {
      if (item.type === 'page' && item.id === id) return item;
      if (item.type === 'folder') { const f = findNotePage(id, item.children || []); if (f) return f; }
      if (!item.type && item.id === id) return item;
    }
    return null;
  }

  function _getParentId(id, items, parentId = null) {
    for (const item of items) {
      if (item.id === id) return parentId;
      if (item.type === 'folder') {
        const r = _getParentId(id, item.children || [], item.id);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }

  function getNotePath(id, items, acc = []) {
    for (const item of items) {
      const p = [...acc, item];
      if (item.id === id) return p;
      if (item.type === 'folder') { const f = getNotePath(id, item.children || [], p); if (f) return f; }
    }
    return null;
  }

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
        await _showConfirm(`Could not create folder: ${e.message}`, { okLabel: 'OK' });
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
        await _showConfirm(`Could not delete: ${e.message}`, { okLabel: 'OK' });
      }
      return;
    }
    _removeItem(id, notesState.items);
    renderNotesTree();
    scheduleSaveNotes();
  }

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
    const settings = _getSettings();
    if (!settings) return;
    settings.notesSidebarOpen  = notesSidebarOpen;
    settings.notesSidebarWidth = sidebarWidth;
    _scheduleSave();
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
    const settings = _getSettings();
    if (settings) settings.notesFontSize = notesFontSize;
    _scheduleSave();
  }

  function restoreNotesSidebar() {
    const settings = _getSettings();
    const w    = settings?.notesSidebarWidth;
    const open = settings?.notesSidebarOpen;
    if (w >= SIDEBAR_MIN) sidebarWidth = Math.min(w, _sidebarMax());
    if (open && !notesSidebarOpen) toggleNotesSidebar();
    const fs = settings?.notesFontSize;
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
        resizer.removeEventListener('touchmove',   onMove);
        resizer.removeEventListener('touchend',    onUp);
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

  // ---------------------------------------------------------------------------
  // Orphan repair context menu
  // ---------------------------------------------------------------------------

  let _orphanMenuEl   = null;
  let _orphanTargetId = null;
  let _orphanTargetType = null;

  function _closeOrphanMenu() {
    if (_orphanMenuEl) _orphanMenuEl.style.display = 'none';
    _orphanTargetId = null;
  }

  function _ensureOrphanMenu() {
    if (_orphanMenuEl) return;
    _orphanMenuEl = document.createElement('div');
    _orphanMenuEl.className = 'context-menu notes-orphan-ctx';
    _orphanMenuEl.style.display = 'none';
    _orphanMenuEl.innerHTML =
      `<div class="notes-orphan-ctx__reason"></div>` +
      `<div class="ctx-separator"></div>` +
      `<button class="ctx-item notes-orphan-ctx__upload"><span class="ctx-icon">&#x2191;</span>Upload to WebDAV</button>` +
      `<button class="ctx-item ctx-danger notes-orphan-ctx__delete"><span class="ctx-icon">&#xd7;</span>Delete from database</button>`;
    document.body.appendChild(_orphanMenuEl);

    _orphanMenuEl.querySelector('.notes-orphan-ctx__upload').addEventListener('click', async () => {
      const id = _orphanTargetId;
      _closeOrphanMenu();
      if (!id || !NOTES_API) return;
      try {
        const data = await _notesOp('POST', `${NOTES_API}/repair-orphan`, { itemId: id, action: 'upload' });
        _applyNotesResult(data);
      } catch (e) {
        await _showConfirm(`Upload failed: ${e.message}`, { okLabel: 'OK' });
      }
      renderNotesTree();
    });

    _orphanMenuEl.querySelector('.notes-orphan-ctx__delete').addEventListener('click', async () => {
      const id   = _orphanTargetId;
      const type = _orphanTargetType;
      _closeOrphanMenu();
      if (!id) return;
      const it = findNoteItem(id, notesState.items);
      if (!it) return;
      const label = type === 'folder' ? `folder "${it.title}"` : `page "${it.title}"`;
      if (!await _showConfirm(`Delete ${label} from database?`, { okLabel: 'Delete', danger: true })) return;
      if (!NOTES_API) return;
      try {
        const data = await _notesOp('POST', `${NOTES_API}/repair-orphan`, { itemId: id, action: 'delete' });
        if (noteModalPageId === id) closeNoteModal();
        _applyNotesResult(data);
      } catch (e) {
        await _showConfirm(`Delete failed: ${e.message}`, { okLabel: 'OK' });
      }
      renderNotesTree();
    });

    document.addEventListener('mousedown', e => {
      if (_orphanMenuEl?.style.display !== 'none' && !_orphanMenuEl.contains(e.target)) {
        _closeOrphanMenu();
      }
    }, true);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && _orphanMenuEl?.style.display !== 'none') _closeOrphanMenu();
    });
  }

  function _showOrphanMenu(e, item) {
    e.preventDefault();
    e.stopPropagation();
    _ensureOrphanMenu();
    _orphanTargetId   = item.id;
    _orphanTargetType = item.type;

    const reason = (item.orphaned === true || !item.orphaned) ? 'Item not on WebDAV' : String(item.orphaned);
    _orphanMenuEl.querySelector('.notes-orphan-ctx__reason').textContent = '\u26a0 ' + reason;

    // Items orphaned because their parent folder is missing can't be individually re-uploaded.
    const isChildOrphan = typeof item.orphaned === 'string' && item.orphaned.startsWith('Parent folder');
    _orphanMenuEl.querySelector('.notes-orphan-ctx__upload').style.display = isChildOrphan ? 'none' : '';

    _orphanMenuEl.style.display = 'block';
    const x = e.clientX, y = e.clientY;
    const w = _orphanMenuEl.offsetWidth  || 240;
    const h = _orphanMenuEl.offsetHeight || 100;
    _orphanMenuEl.style.left = (x + w > window.innerWidth  ? x - w : x) + 'px';
    _orphanMenuEl.style.top  = (y + h > window.innerHeight ? y - h : y) + 'px';
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

    const collapse = _icons.collapse || '\u25be';
    const expand   = _icons.expand   || '\u25b8';
    const svgFolder = _icons.svgFolder ? _icons.svgFolder(10, 10) : '';
    const svgDelete = _icons.svgDelete ? _icons.svgDelete() : '\u00d7';

    el.innerHTML =
      `<button class="notes-toggle-btn${hasChildren ? '' : ' notes-toggle-btn--hidden'}" title="${isExpanded ? 'Collapse' : 'Expand'}">${isExpanded ? collapse : expand}</button>` +
      `<span class="notes-item-title notes-item-folder-title${depth === 0 ? ' notes-item-title--root' : ''}">${_escHtml(folder.title)}</span>` +
      `<div class="notes-item-btns">` +
        (depth < 2 ? `<button class="notes-item-btn notes-item-btn--add-folder" title="Add subfolder">${svgFolder}</button>` : '') +
        `<button class="notes-item-btn notes-item-btn--add" title="Add page to folder">+</button>` +
        `<button class="notes-item-btn notes-item-btn--del" title="Delete folder">${svgDelete}</button>` +
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
      if (await _showConfirm(msg, { okLabel: 'Delete', danger: true })) {
        deleteNoteItem(folder.id);
      }
    });

    if (_webdavActive() && folder.orphaned) {
      el.addEventListener('contextmenu', e => _showOrphanMenu(e, folder));
    }

    container.appendChild(el);

    if (isExpanded) renderNotesList(folder.children || [], container, depth + 1);
  }

  function _renderPageItem(page, container, depth) {
    const el = document.createElement('div');
    el.className = 'notes-tree-item notes-tree-item--page';
    if (_webdavActive() && page.orphaned) el.classList.add('notes-tree-item--orphaned');
    el.dataset.itemId   = page.id;
    el.dataset.pageId   = page.id;
    el.dataset.itemType = 'page';
    el.dataset.depth    = depth;
    el.draggable = true;
    el.style.paddingLeft = (depth * 14 + 6) + 'px';

    const hasLink        = !!page.link?.trim();
    const hasCards       = (page.linkedCards || []).length > 0;
    const hasAttachments = !!page.hasAttachments;
    const svgLink        = _icons.svgLink        ? _icons.svgLink(9, 9)        : '';
    const svgLinkedCards = _icons.svgLinkedCards  ? _icons.svgLinkedCards(9, 9) : '';
    const svgAttachSm   = _icons.svgAttachmentSm ? _icons.svgAttachmentSm(9, 9) : (_icons.svgAttachment ? _icons.svgAttachment(9, 9) : '');
    const svgDelete      = _icons.svgDelete ? _icons.svgDelete() : '\u00d7';
    const indicators =
      (hasLink        ? `<span class="notes-item-indicator" title="Has link">${svgLink}</span>` : '') +
      (hasCards       ? `<span class="notes-item-indicator" title="${page.linkedCards.length} linked card(s)">${svgLinkedCards}</span>` : '') +
      (hasAttachments ? `<span class="notes-item-indicator" title="${page.attachmentCount ? page.attachmentCount + ' attachment' + (page.attachmentCount > 1 ? 's' : '') : 'Has attachments'}">${svgAttachSm}${page.attachmentCount ? `<span class="attach-count">${page.attachmentCount}</span>` : ''}</span>` : '');

    el.innerHTML =
      `<span class="notes-toggle-btn notes-toggle-btn--hidden"></span>` +
      `<span class="notes-item-title-wrap">` +
        `<span class="notes-item-title${depth === 0 ? ' notes-item-title--root' : ''}">${_escHtml(page.title)}</span>` +
        (indicators ? `<span class="notes-item-indicators">${indicators}</span>` : '') +
      `</span>` +
      `<div class="notes-item-btns">` +
        `<button class="notes-item-btn notes-item-btn--del" title="Delete page">${svgDelete}</button>` +
      `</div>`;

    el.querySelector('.notes-item-title').addEventListener('click', () => openNoteModal(page.id));

    el.querySelector('.notes-item-btn--del').addEventListener('click', async e => {
      e.stopPropagation();
      if (await _showConfirm(`Delete page "${page.title}"?`, { okLabel: 'Delete', danger: true })) {
        if (noteModalPageId === page.id) closeNoteModal();
        deleteNoteItem(page.id);
      }
    });

    if (_webdavActive() && page.orphaned) {
      el.addEventListener('contextmenu', e => _showOrphanMenu(e, page));
    }

    container.appendChild(el);
  }

  function _startFolderRename(itemEl, folder) {
    const titleEl = itemEl.querySelector('.notes-item-folder-title');
    if (!titleEl || titleEl.querySelector('input')) return;
    const prev = folder.title;

    const input = document.createElement('input');
    input.type      = 'text';
    input.value     = prev;
    input.className = 'notes-folder-rename-input';
    titleEl.innerHTML = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();

    async function _commit() {
      const val = input.value.trim() || prev;
      titleEl.textContent = val;
      if (val === prev) { renderNotesTree(); return; }
      folder.title = val;
      if (_webdavActive()) {
        try {
          const data = await _notesOp('PATCH', `${NOTES_FOLD_API}/${folder.id}`, { title: val });
          _applyNotesResult(data);
        } catch (e) {
          folder.title = prev;
          await _showConfirm(`Could not rename folder: ${e.message}`, { okLabel: 'OK' });
        }
      } else {
        scheduleSaveNotes();
      }
      renderNotesTree();
    }

    input.addEventListener('blur', _commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = prev; input.removeEventListener('blur', _commit); titleEl.textContent = prev; renderNotesTree(); }
    });
  }

  function _updateNoteToggleCount(btnId, count) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const countEl = btn.querySelector('.notes-toggle-count');
    if (countEl) countEl.textContent = count > 0 ? ` (${count})` : '';
  }

  function setNoteSection(sectionId, btnId, open) {
    document.getElementById(sectionId)?.classList.toggle('note-section--open', open);
    document.getElementById(btnId)?.classList.toggle('note-toggle--open', open);
  }
  function toggleNoteSection(sectionId, btnId) {
    const el = document.getElementById(sectionId);
    if (!el) return;
    const open = !el.classList.contains('note-section--open');
    setNoteSection(sectionId, btnId, open);
  }
  function resetNoteSections() {
    setNoteSection('noteLinkSection',        'noteToggleLink',        false);
    setNoteSection('noteLinkedCardsSection', 'noteToggleLinkedCards', false);
    setNoteSection('noteAttachmentsSection', 'noteToggleAttachments', false);
  }

  // ---- Note Modal ----
  let noteModalPageId = null;
  let noteModalOrig = { title: '', desc: '', link: '' };
  let _pendingNewPage = null;
  let _noteFullscreen = false;

  function toggleNoteFullscreen() {
    _noteFullscreen = !_noteFullscreen;
    document.getElementById('noteModal')?.classList.toggle('modal--fullscreen', _noteFullscreen);
  }

  function _exitNoteFullscreen() {
    if (!_noteFullscreen) return;
    _noteFullscreen = false;
    document.getElementById('noteModal')?.classList.remove('modal--fullscreen');
  }

  async function _crumbNavigate(pageId) {
    if (noteModalHasChanges()) {
      const result = await _showConfirm('Save changes before navigating?', { okLabel: 'Save', altLabel: "Don't save", cancelLabel: 'Cancel' });
      if (result === false) return; // cancelled
      if (result === true) await submitNote();
    }
    openNoteModal(pageId);
  }

  function _renderCrumb(path, currentTitle = null) {
    const el = document.getElementById('noteCrumb');
    if (!el) return;
    if (!path || path.length <= 1) { el.innerHTML = ''; return; }
    el.innerHTML = path.slice(0, -1).map((item, i) => {
      const label = _escHtml(item.title);
      return `<span class="note-crumb-item" data-id="${item.id}">${label}</span><span class="note-crumb-sep">\u203a</span>`;
    }).join('') + `<span class="note-crumb-item note-crumb-item--current">${_escHtml(currentTitle ?? path[path.length - 1].title)}</span>`;
    el.querySelectorAll('.note-crumb-item[data-id]').forEach(span => {
      span.addEventListener('click', () => _crumbNavigate(span.dataset.id));
    });
  }

  async function openNoteModal(pageId, focusTitle = false) {
    let page = findNotePage(pageId, notesState.items);
    if (!page && _pendingNewPage?.page.id === pageId) page = _pendingNewPage.page;
    if (!page) return;
    noteModalPageId = pageId;

    document.getElementById('notePageTitle').value = page.title;
    if (_editor.setValue) _editor.setValue('notePageDesc', page.description || '');
    document.getElementById('notePageLink').value = page.link || '';

    noteModalOrig = { title: page.title, desc: page.description || '', link: page.link || '' };

    renderLinkedCards(page.linkedCards || []);

    const notePath = getNotePath(pageId, notesState.items);
    _renderCrumb(notePath);

    _updateNoteLinkBtn();
    resetNoteSections();
    if (NOTES_ATTACH_API) loadAttachments(pageId);

    const noteAutoSaveEl = document.getElementById('noteAutoSave');
    if (noteAutoSaveEl) {
      noteAutoSaveEl.checked = _getSettings()?.autoSaveDialogs ?? false;
      if (noteAutoSaveEl.checked) _startNoteAutoSave(); else _stopNoteAutoSave();
    }
    const _wdInfoBtn = document.getElementById('noteWdInfoBtn');
    const _wdInfoPop = document.getElementById('noteWdInfoPopover');
    if (_wdInfoBtn) {
      _wdInfoBtn.style.display = _webdavActive() ? '' : 'none';
      if (_wdInfoPop) _wdInfoPop.style.display = 'none';
      if (_webdavActive()) {
        document.getElementById('noteWdInfoId').textContent   = page.id;
        document.getElementById('noteWdInfoPath').textContent = page.wdPath || '(not yet synced)';
      }
    }

    if (cfg.boardName) document.title = `${cfg.boardName} - ${page.title} (note)`;
    document.getElementById('noteModal').style.display = 'flex';
    if (!_pendingNewPage) history.replaceState(null, '', '#note:' + pageId);
    const nt = document.getElementById('notePageTitle');
    autoResizeTitle(nt);
    if (focusTitle) requestAnimationFrame(() => { nt.focus(); nt.select(); });

    const loadingEl = document.getElementById('noteModalLoading');

    if (_webdavActive() && _pendingNewPage?.page.id !== pageId) {
      if (loadingEl) loadingEl.style.display = 'flex';
      try {
        const data = await fetch(`${NOTES_PAGES_API}/${pageId}/content`).then(r => r.ok ? r.json() : null);
        if (data) {
          if (_editor.setValue) _editor.setValue('notePageDesc', data.content || '');
          noteModalOrig.desc = data.content || '';
          page.description   = data.content || '';
          _pageLoadedAt.set(pageId, data.lastModified || null);
        }
      } catch { /* fall back to cached */ }
      finally {
        if (loadingEl) loadingEl.style.display = 'none';
      }
    } else {
      if (loadingEl) loadingEl.style.display = 'none';
    }
  }

  function closeNoteModal() {
    _exitNoteFullscreen();
    _stopNoteAutoSave();
    if (cfg.boardName) document.title = `jc://${cfg.boardName}/`;
    const _wdInfoPop = document.getElementById('noteWdInfoPopover');
    if (_wdInfoPop) _wdInfoPop.style.display = 'none';
    if (location.hash.startsWith('#note:')) history.replaceState(null, '', location.pathname + location.search);
    document.getElementById('noteModal').style.display = 'none';
    document.getElementById('noteCreateCardForm').style.display = 'none';
    noteModalPageId = null;
    _pendingNewPage = null;
  }

  let _noteSubmitSaving = false;

  async function submitNote() {
    if (!noteModalPageId || _noteSubmitSaving) return;
    let page = findNotePage(noteModalPageId, notesState.items);
    if (!page && _pendingNewPage?.page.id === noteModalPageId) page = _pendingNewPage.page;
    if (!page) return;

    const newTitle = document.getElementById('notePageTitle').value.trim() || 'Untitled';
    const newDesc  = _editor.getValue ? _editor.getValue('notePageDesc') : '';
    const newLink  = document.getElementById('notePageLink').value.trim();

    const saveBtn = document.getElementById('noteModalSaveBtn');
    const saveBtnLabel = saveBtn?.querySelector('.btn-label');
    if (saveBtnLabel) saveBtnLabel.textContent = 'Saving\u2026';
    if (saveBtn) saveBtn.disabled = true;
    _noteSubmitSaving = true;
    try { await _submitNote(newTitle, newDesc, newLink, page); }
    finally {
      _noteSubmitSaving = false;
      if (saveBtnLabel) saveBtnLabel.textContent = 'Save';
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function _submitNote(newTitle, newDesc, newLink, page) {
    let _handledByPost = false;

    if (_pendingNewPage && _pendingNewPage.page.id === page.id) {
      const { parentId } = _pendingNewPage;
      if (_webdavActive()) {
        page.title = newTitle; page.description = newDesc; page.link = newLink;
        page.lastModified = new Date().toISOString();
        _pendingNewPage = null;
        history.replaceState(null, '', '#note:' + page.id);
        try {
          const data = await _notesOp('POST', NOTES_PAGES_API, { page, parentId });
          _applyNotesResult(data);
          const savedPage = findNoteItem(noteModalPageId, notesState.items);
          if (savedPage) _pageLoadedAt.set(noteModalPageId, savedPage.lastModified || null);
          _handledByPost = true;
        } catch (e) {
          _pendingNewPage = { page, parentId };
          await _showConfirm(`Could not save page: ${e.message}`, { okLabel: 'OK' });
          return;
        }
      } else {
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
        renderNotesTree();
        history.replaceState(null, '', '#note:' + page.id);
      }
    }

    if (!_handledByPost) {
      if (_webdavActive()) {
        const loadedAt = _pageLoadedAt.get(noteModalPageId);
        if (loadedAt) {
          try {
            const r = await fetch(`${NOTES_PAGES_API}/${noteModalPageId}/content`);
            if (r.ok) {
              const { lastModified: serverLM } = await r.json();
              const serverTime = serverLM ? new Date(serverLM).getTime() : 0;
              const localTime  = new Date(loadedAt).getTime();
              if (serverTime > localTime) {
                const overwrite = await _showConfirm(
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
          const savedPage = findNoteItem(noteModalPageId, notesState.items);
          if (savedPage) _pageLoadedAt.set(noteModalPageId, savedPage.lastModified || null);
        } catch (e) {
          await _showConfirm(`Could not save page: ${e.message}`, { okLabel: 'OK' });
          return;
        }
      } else {
        page.lastModified = new Date().toISOString();
        scheduleSaveNotes();
      }
    }

    page.title       = newTitle;
    page.description = newDesc;
    page.link        = newLink;
    noteModalOrig    = { title: newTitle, desc: newDesc, link: newLink };

    _renderCrumb(getNotePath(noteModalPageId, notesState.items));
    renderNotesTree();

    const msg = document.getElementById('noteModalSavedMsg');
    if (msg) {
      msg.textContent = `${_icons.done || '\u2713'} saved`;
      msg.classList.add('modal-saved-msg--visible');
      setTimeout(() => msg.classList.remove('modal-saved-msg--visible'), 1500);
    }
  }

  function noteModalHasChanges() {
    if (!noteModalPageId) return false;
    const descVal = _editor.getValue ? _editor.getValue('notePageDesc') : (document.getElementById('notePageDesc')?.value || '');
    return document.getElementById('notePageTitle').value        !== noteModalOrig.title ||
           descVal                                               !== noteModalOrig.desc  ||
           document.getElementById('notePageLink').value.trim()  !== noteModalOrig.link;
  }

  async function tryCloseNoteModal() {
    if (noteModalHasChanges()) {
      if (await _showConfirm('Close without saving changes?', { okLabel: 'Close', danger: true }))
        closeNoteModal();
    } else {
      closeNoteModal();
    }
  }

  // ---- Table of Contents ----
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
    headings.forEach(h => {
      const li = document.createElement('li');
      li.className = `md-toc-item md-toc-${h.tagName.toLowerCase()}`;
      const a = document.createElement('a');
      a.textContent = h.textContent;
      a.href = '#' + h.id;
      a.addEventListener('click', e => { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth' }); });
      li.appendChild(a);
      ul.appendChild(li);
    });
    nav.appendChild(ul);
    placeholder.replaceWith(nav);
  }

  // ---- Linked Cards ----
  async function _saveLinkedCards(page) {
    if (_webdavActive()) {
      try {
        await _notesOp('PATCH', `${NOTES_PAGES_API}/${page.id}`, {
          title: page.title, description: page.description || '',
          link: page.link || '', linkedCards: page.linkedCards || [],
        });
      } catch (e) { console.error('Failed to save linked cards:', e.message); }
    } else {
      page.lastModified = new Date().toISOString();
      scheduleSaveNotes();
    }
  }

  function renderLinkedCards(ids) {
    const container = document.getElementById('noteLinkedCardsList');
    if (!container) return;
    container.innerHTML = '';
    _updateNoteToggleCount('noteToggleLinkedCards', ids.length);

    const svgAttachSm = _icons.svgAttachmentSm ? _icons.svgAttachmentSm(9, 9) : (_icons.svgAttachment ? _icons.svgAttachment(9, 9) : '');
    const svgClose    = _icons.svgClose ? _icons.svgClose() : '\u00d7';

    for (const id of ids) {
      let card = null, col = null;
      for (const c of _getColumns()) {
        const found = c.cards.find(k => k.id === id);
        if (found) { card = found; col = c; break; }
      }

      const mini = document.createElement('div');
      mini.className = 'note-mini-card';
      const color = card?.color || col?.color || 'var(--accent)';
      mini.style.setProperty('--card-color', color);

      const text = card ? card.text : `[card not found: ${id}]`;
      const isGone = !card;

      const attachCount = card ? _getCardAttachCount(card.id) : null;
      const attachBadge = attachCount
        ? `<span class="note-mini-card-attach" title="${attachCount} attachment${attachCount > 1 ? 's' : ''}">${svgAttachSm}<span class="attach-count">${attachCount}</span></span>`
        : '';
      mini.innerHTML =
        `<div class="note-mini-card-body">` +
          (col ? `<span class="note-mini-card-col">${_escHtml(col.title)}</span>` : '') +
          `<span class="note-mini-card-text${isGone ? ' note-mini-card-text--gone' : ''}" title="${_escHtml(text)}">${_escHtml(text)}</span>` +
        `</div>` +
        attachBadge +
        `<button class="note-mini-card-remove" title="Unlink card">${svgClose}</button>`;

      if (card && col) {
        mini.querySelector('.note-mini-card-body').addEventListener('click', () => { closeNoteModal(); _openEditModal(col.id, card); });
      }
      mini.querySelector('.note-mini-card-remove').addEventListener('click', async e => {
        e.stopPropagation();
        const page = findNotePage(noteModalPageId, notesState.items);
        if (!page) return;
        page.linkedCards  = (page.linkedCards || []).filter(c => c !== id);
        page.lastModified = new Date().toISOString();
        renderLinkedCards(page.linkedCards);
        _render();
        await _saveLinkedCards(page);
      });

      container.appendChild(mini);
    }
  }

  // ---- Link card to page (called from kanban drag/touch handlers) ----
  async function linkCardToPage(cardId, pageId) {
    const target = findNotePage(pageId, notesState.items);
    if (!target || (target.linkedCards || []).includes(cardId)) return;
    (target.linkedCards ??= []).push(cardId);
    target.lastModified = new Date().toISOString();
    if (noteModalPageId === pageId) renderLinkedCards(target.linkedCards);
    _render();
    await _saveLinkedCards(target);
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
      for (const col of _getColumns()) {
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
        const short = card.text.length > 60 ? card.text.slice(0, 60) + '\u2026' : card.text;
        item.innerHTML =
          `<span class="note-card-search-col">${_escHtml(card.col)}</span>` +
          `<span class="note-card-search-text">${_escHtml(short)}</span>`;
        item.addEventListener('click', async () => {
          const page = findNotePage(noteModalPageId, notesState.items);
          if (!page) return;
          if (!page.linkedCards) page.linkedCards = [];
          if (!page.linkedCards.includes(card.id)) {
            page.linkedCards.push(card.id);
            page.lastModified = new Date().toISOString();
            renderLinkedCards(page.linkedCards);
            _render();
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

  function _updateNoteLinkBtn() {
    const url = document.getElementById('notePageLink')?.value.trim();
    document.getElementById('notePageLinkOpen')?.classList.toggle('has-url', !!url);
  }

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
    if (page) {
      const hadAttach = page.hasAttachments;
      const prevCount = page.attachmentCount;
      page.hasAttachments = files.length > 0;
      page.attachmentCount = files.length;
      if (!!hadAttach !== page.hasAttachments || prevCount !== files.length) {
        if (!!hadAttach !== page.hasAttachments) page.lastModified = new Date().toISOString();
        scheduleSaveNotes();
        renderNotesTree();
      }
    }

    _updateNoteToggleCount('noteToggleAttachments', files.length);
    if (!files.length) return;

    const svgAttach   = _icons.svgAttachment   ? _icons.svgAttachment()   : '';
    const svgFileImg  = _icons.svgFileImage     ? _icons.svgFileImage()    : svgAttach;
    const svgFilePdf  = _icons.svgFilePdf       ? _icons.svgFilePdf()      : svgAttach;
    const svgFileWeb  = _icons.svgFileWeb       ? _icons.svgFileWeb()      : svgAttach;
    const svgDelete   = _icons.svgDelete        ? _icons.svgDelete()       : '\u00d7';

    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() || '';
      const ft  = ['jpg','jpeg','png','gif','webp','avif','bmp','ico','tiff','svg'].includes(ext) ? 'image'
                : ext === 'svg' ? 'svg'
                : ext === 'pdf' ? 'pdf'
                : ['html','htm'].includes(ext) ? 'html'
                : 'other';
      const icon = (ft === 'image' || ft === 'svg') ? svgFileImg : ft === 'pdf' ? svgFilePdf : ft === 'html' ? svgFileWeb : svgAttach;
      const url  = `${NOTES_ATTACH_API}/${pageId}/${encodeURIComponent(f.name)}`;

      const item = document.createElement('div');
      item.className = 'note-attach-item';
      item.innerHTML =
        `<span class="note-attach-icon">${icon}</span>` +
        `<span class="note-attach-name" title="${_escHtml(f.name)}">${_escHtml(f.name)}</span>` +
        `<span class="note-attach-size">${_fmtFileSize(f.size)}</span>` +
        `<div class="note-attach-actions">` +
          `<button class="note-attach-btn" data-act="insert" title="Insert link">&#x2b;</button>` +
          `<button class="note-attach-btn" data-act="view"   title="Open/view">&#x1f441;</button>` +
          `<button class="note-attach-btn note-attach-btn--del" data-act="delete" title="Delete">${svgDelete}</button>` +
        `</div>`;

      item.querySelector('[data-act="insert"]').addEventListener('click', () => {
        _insertAttachmentMd(f.name, ft);
      });
      item.querySelector('[data-act="view"]').addEventListener('click', () => {
        openAttachmentViewer(url, f.name, ft);
      });
      item.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!await _showConfirm(`Delete "${f.name}"?`, { okLabel: 'Delete', danger: true })) return;
        try {
          await fetch(url, { method: 'DELETE' });
          loadAttachments(pageId);
        } catch (e) { console.error('Delete failed:', e.message); }
      });
      list.appendChild(item);
    }
  }

  function _fmtFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  async function _handleAttachUpload(pageId, fileList, atCursor = false) {
    if (!NOTES_ATTACH_API || !fileList?.length) return;
    for (const file of fileList) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch(`${NOTES_ATTACH_API}/${pageId}`, { method: 'POST', body: fd });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          await _showConfirm(data.error || 'Upload failed.', { okLabel: 'OK' });
          continue;
        }
        const ext = data.name.split('.').pop()?.toLowerCase() || '';
        const ft  = ['jpg','jpeg','png','gif','webp','avif','bmp','ico','tiff','svg'].includes(ext) ? 'image'
                  : ext === 'svg' ? 'svg'
                  : ext === 'pdf' ? 'pdf'
                  : ['html','htm'].includes(ext) ? 'html'
                  : 'other';
        if (atCursor) _insertAttachmentMd(data.name, ft);
        loadAttachments(pageId);
      } catch (e) { console.error('Upload error:', e.message); }
    }
  }

  function _insertAttachmentMd(name, type) {
    const rel = `_attachments/${noteModalPageId}_${name}`;
    const md  = (type === 'image' || type === 'svg') ? `![${name}](${rel})` : `[${name}](${rel})`;
    if (_editor.isActive && _editor.isActive('notePageDesc')) {
      if (_editor.applyFormat) _editor.applyFormat('notePageDesc', { insert: md });
    } else {
      const ta = document.getElementById('notePageDesc');
      if (ta) {
        const pos = ta.selectionStart;
        ta.value = ta.value.slice(0, pos) + md + ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = pos + md.length;
        ta.dispatchEvent(new Event('input'));
      }
    }
  }

  async function _downloadAttachment(url, name) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      _triggerBlobDownload(blob, name);
    } catch (e) { console.error('Download failed:', e.message); }
  }

  function _triggerBlobDownload(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  }

  async function resolveAttachments(container) {
    if (!noteModalPageId || !NOTES_ATTACH_API) return;
    const imgs = [...container.querySelectorAll('img[src]')];
    const links = [...container.querySelectorAll('a[href]')];

    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (!src.startsWith('_attachments/')) continue;
      const fname = src.replace('_attachments/', '').replace(`${noteModalPageId}_`, '');
      const url = `${NOTES_ATTACH_API}/${noteModalPageId}/${encodeURIComponent(fname)}`;
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const blob = await r.blob();
        img.src = URL.createObjectURL(blob);
      } catch { /* leave original src */ }
    }

    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href.startsWith('_attachments/')) continue;
      const fname = href.replace('_attachments/', '').replace(`${noteModalPageId}_`, '');
      const url = `${NOTES_ATTACH_API}/${noteModalPageId}/${encodeURIComponent(fname)}`;
      const ext = fname.split('.').pop()?.toLowerCase() || '';
      const isViewable = ['jpg','jpeg','png','gif','webp','bmp','svg','pdf','html','htm'].includes(ext);
      if (isViewable) {
        a.addEventListener('click', e => { e.preventDefault(); openAttachmentViewer(url, fname, ext); });
      } else {
        a.addEventListener('click', e => { e.preventDefault(); _downloadAttachment(url, fname); });
      }
    }
  }

  let _viewerBlob = null;

  async function openAttachmentViewer(url, name, type) {
    const viewer = document.getElementById('attachViewer');
    if (!viewer) return;
    const iframe = document.getElementById('attachViewerFrame');
    const img    = document.getElementById('attachViewerImg');
    if (!iframe || !img) return;

    viewer.style.display = 'flex';
    document.getElementById('attachViewerName').textContent = name;

    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (_viewerBlob) URL.revokeObjectURL(_viewerBlob);
      _viewerBlob = URL.createObjectURL(blob);

      const isImage = ['jpg','jpeg','png','gif','webp','bmp','svg','image'].includes(type);
      const isPdf   = type === 'pdf';
      const isHtml  = ['html','htm'].includes(type);

      img.style.display    = isImage ? '' : 'none';
      iframe.style.display = (isPdf || isHtml) ? '' : 'none';

      if (isImage)        img.src    = _viewerBlob;
      else if (isPdf || isHtml) iframe.src = _viewerBlob;
    } catch (e) {
      document.getElementById('attachViewerName').textContent = `Error: ${e.message}`;
    }
  }

  function closeAttachmentViewer() {
    const viewer = document.getElementById('attachViewer');
    if (viewer) viewer.style.display = 'none';
    if (_viewerBlob) { URL.revokeObjectURL(_viewerBlob); _viewerBlob = null; }
  }

  // ---- Notes tree drag-drop (within the sidebar) ----
  let _treeDragId = null;
  let _treeMoveInProgress = false;

  function _setTreeMoveLock(locked) {
    _treeMoveInProgress = locked;
  }

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

      _clearTreeDrop();
      if      (ratio < 0.3)  item.classList.add('notes-tree-item--drop-before');
      else if (ratio > 0.7)  item.classList.add('notes-tree-item--drop-after');
      else if (isFolder)     item.classList.add('notes-tree-item--drop-into');
      else if (ratio <= 0.5) item.classList.add('notes-tree-item--drop-before');
      else                   item.classList.add('notes-tree-item--drop-after');
      ttOverItem = item;
    }

    container.addEventListener('touchstart', e => {
      if (_treeMoveInProgress) return;
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

      const ttTargetId     = item.dataset.itemId;
      const targetParentId = _getParentId(ttTargetId, notesState.items) ?? null;
      const dragged = _removeFromTree(savedId, notesState.items);
      if (!dragged) return;
      if (position === 'into') { notesExpanded.add(ttTargetId); _saveTreeOpenState(); }
      _insertIntoTree(dragged, ttTargetId, position, notesState.items);

      if (_webdavActive()) {
        _setTreeMoveLock(true);
        const isFolder  = dragged.type === 'folder';
        const moveApi   = isFolder ? `${NOTES_FOLD_API}/${dragged.id}/move` : `${NOTES_PAGES_API}/${dragged.id}/move`;
        const newParent = position === 'into' ? ttTargetId : targetParentId;
        const body = position === 'into'
          ? { folderId: newParent, parentId: newParent }
          : { folderId: newParent, parentId: newParent, targetId: ttTargetId, position };
        _notesOp('POST', moveApi, body)
          .then(data => { _applyNotesResult(data); renderNotesTree(); })
          .catch(async e => {
            await _showConfirm(`Could not move item: ${e.message}`, { okLabel: 'OK' });
            await loadNotes();
          })
          .finally(() => _setTreeMoveLock(false));
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
      if (_treeMoveInProgress) { e.preventDefault(); return; }
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
      const targetParentId = _getParentId(targetId, notesState.items) ?? null;
      const dragged  = _removeFromTree(_treeDragId, notesState.items);
      if (!dragged) return;

      if (position === 'into') { notesExpanded.add(targetId); _saveTreeOpenState(); }
      _insertIntoTree(dragged, targetId, position, notesState.items);

      if (_webdavActive()) {
        _setTreeMoveLock(true);
        const isFolder  = dragged.type === 'folder';
        const moveApi   = isFolder ? `${NOTES_FOLD_API}/${dragged.id}/move` : `${NOTES_PAGES_API}/${dragged.id}/move`;
        const newParent = position === 'into' ? targetId : targetParentId;
        const body = position === 'into'
          ? { folderId: newParent, parentId: newParent }
          : { folderId: newParent, parentId: newParent, targetId, position };
        _notesOp('POST', moveApi, body)
          .then(data => { _applyNotesResult(data); renderNotesTree(); })
          .catch(async e => {
            await _showConfirm(`Could not move item: ${e.message}`, { okLabel: 'OK' });
            await loadNotes();
          })
          .finally(() => _setTreeMoveLock(false));
      } else {
        scheduleSaveNotes();
      }
      renderNotesTree();
    });
  }

  // ---- Create card and link ----
  async function _createAndLinkCard(text) {
    if (!text.trim()) return;
    const cardId = await _createCard(text);
    if (!cardId) return;

    const target = findNotePage(noteModalPageId, notesState.items);
    if (target && !(target.linkedCards || []).includes(cardId)) {
      (target.linkedCards ??= []).push(cardId);
      target.lastModified = new Date().toISOString();
      renderLinkedCards(target.linkedCards);
      await _saveLinkedCards(target);
    }
  }

  // ---- Print note page ----
  async function printNote(pageId) {
    if (!pageId) return;
    const page = findNotePage(pageId, notesState.items);
    if (!page) return;

    const board   = cfg.boardName || 'kanban';
    const path    = getNotePath(pageId, notesState.items);
    const context = path && path.length > 1
      ? path.slice(0, -1).map(p => p.title).join(' \u203a ')
      : '';

    const rows = [];
    if (page.lastModified) rows.push(['Last modified', new Date(page.lastModified).toLocaleDateString()]);
    if (page.link)         rows.push(['Link', page.link]);

    const linkedCards = page.linkedCards || [];
    if (linkedCards.length) {
      const titles = linkedCards.map(id => {
        const card = _getColumns().flatMap(c => c.cards).find(c => c.id === id);
        return card ? card.text : `${id} (removed)`;
      });
      rows.push(['Linked cards', titles.join(', ')]);
    }

    if (page.hasAttachments && NOTES_ATTACH_API) {
      try {
        const r = await fetch(`${NOTES_ATTACH_API}/${pageId}`);
        const files = r.ok ? await r.json() : [];
        if (files.length) rows.push(['Attachments', files.map(f => f.name).join(', ')]);
      } catch { rows.push(['Attachments', '(unavailable)']); }
    }

    rows.push(['ID', page.id]);
    rows.push(['URL', location.href.split('#')[0] + '#note:' + page.id]);
    if (_print.fmtDate) rows.push(['Status', _print.fmtDate(new Date())]);

    const root = document.getElementById('print-root');
    if (!root || !_print.buildItem) return;
    const body = page.description && _markdown.render ? _markdown.render(page.description) : (page.description || '');
    root.innerHTML = _print.buildItem({ board, context, title: page.title, body, footerRows: rows });
    buildToc(root);
    await resolveAttachments(root);
    if (_print.trigger) await _print.trigger(root);
  }

  // ---- DOMContentLoaded wiring ----
  function _init() {
    document.getElementById('noteAutoSave')?.addEventListener('change', e => {
      if (e.target.checked) _startNoteAutoSave(); else _stopNoteAutoSave();
    });

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

    document.getElementById('noteAttachInput')?.addEventListener('change', e => {
      if (noteModalPageId) _handleAttachUpload(noteModalPageId, e.target.files);
      e.target.value = '';
    });

    // File drag-and-drop onto note modal
    let _noteFileDragDepth = 0;
    let _noteDragAtCursor = false;
    const _noteModalEl = document.getElementById('noteModal');
    if (_noteModalEl) {
      _noteModalEl.addEventListener('dragenter', e => {
        if (!noteModalPageId || !NOTES_ATTACH_API) return;
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        if (++_noteFileDragDepth === 1) {
          _noteDragAtCursor = _editor.isActive ? _editor.isActive('notePageDesc') : false;
          _noteModalEl.classList.add('modal--file-drag');
        }
      }, { capture: true });
      _noteModalEl.addEventListener('dragleave', () => {
        if (--_noteFileDragDepth <= 0) {
          _noteFileDragDepth = 0;
          _noteDragAtCursor = false;
          _noteModalEl.classList.remove('modal--file-drag');
        }
      }, { capture: true });
      _noteModalEl.addEventListener('dragover', e => {
        if (!noteModalPageId || !NOTES_ATTACH_API) return;
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
      }, { capture: true });
      _noteModalEl.addEventListener('drop', e => {
        _noteFileDragDepth = 0;
        _noteModalEl.classList.remove('modal--file-drag');
        if (!noteModalPageId || !NOTES_ATTACH_API) return;
        const files = e.dataTransfer?.files;
        if (!files?.length) return;
        e.preventDefault();
        e.stopPropagation();
        _handleAttachUpload(noteModalPageId, files, _noteDragAtCursor);
        _noteDragAtCursor = false;
      }, { capture: true });
      // Paste image upload
      _noteModalEl.addEventListener('paste', e => {
        if (!noteModalPageId || !NOTES_ATTACH_API) return;
        const items = Array.from(e.clipboardData?.items || []);
        const imageItems = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
        if (!imageItems.length) return;
        e.preventDefault();
        const files = imageItems.map(it => {
          const ext = it.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
          return new File([it.getAsFile()], `pasted-${Date.now()}.${ext}`, { type: it.type });
        });
        _handleAttachUpload(noteModalPageId, files);
      });
    }

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

    document.getElementById('noteWdInfoBtn')?.addEventListener('click', () => {
      const pop = document.getElementById('noteWdInfoPopover');
      if (pop) pop.style.display = pop.style.display === 'none' ? '' : 'none';
    });

    document.getElementById('noteFullscreenBtn')?.addEventListener('click', () => toggleNoteFullscreen());
    document.getElementById('noteModalPrintBtn')?.addEventListener('click', () => printNote(noteModalPageId));
    document.getElementById('noteModalCancelBtn')?.addEventListener('click', () => tryCloseNoteModal());
    document.getElementById('noteModalSaveBtn')?.addEventListener('click', async () => { await submitNote(); closeNoteModal(); });
    document.getElementById('noteModalDeleteBtn')?.addEventListener('click', async () => {
      if (!noteModalPageId) return;
      const page = findNotePage(noteModalPageId, notesState.items);
      if (!page) return;
      if (await _showConfirm(`Delete page "${page.title}"?`, { okLabel: 'Delete', danger: true })) {
        const id = noteModalPageId;
        closeNoteModal();
        deleteNoteItem(id);
      }
    });

    if (_editor.create) {
      _editor.create('notePageDesc', { onPreview: el => resolveAttachments(el) });
    }

    // Title key handling
    document.getElementById('notePageTitle')?.addEventListener('focus', e => {
      if (e.target.value === 'New Page') { e.target.value = ''; autoResizeTitle(e.target); }
    });
    document.getElementById('notePageTitle')?.addEventListener('blur', e => {
      if (!e.target.value.trim()) { e.target.value = 'New Page'; autoResizeTitle(e.target); }
    });
    document.getElementById('notePageTitle')?.addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\n/g, '');
      autoResizeTitle(e.target);
      const path = getNotePath(noteModalPageId, notesState.items);
      if (path && path.length > 1) {
        const live = e.target.value.trim() || 'New Page';
        _renderCrumb(path, live);
      }
    });
    document.getElementById('notePageTitle')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitNote(); if (_editor.focus) _editor.focus('notePageDesc'); }
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (_noteFullscreen) { _exitNoteFullscreen(); return; }
        tryCloseNoteModal();
      }
    });

    // Global Escape / F11 / Ctrl+S / Ctrl+P
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('attachViewer')?.style.display !== 'none') {
        closeAttachmentViewer(); return;
      }
      if (e.key === 'Escape' && document.getElementById('noteModal')?.style.display !== 'none') {
        const otherOpen = ['modal','settingsBackdrop','promptsBackdrop','searchBackdrop','cardInfoBackdrop','dialogBackdrop']
          .some(id => document.getElementById(id)?.style.display !== 'none');
        if (!otherOpen) {
          if (_noteFullscreen) { _exitNoteFullscreen(); return; }
          tryCloseNoteModal();
        }
      }
      if (e.key === 'F11' && document.getElementById('noteModal')?.style.display !== 'none') {
        e.preventDefault();
        toggleNoteFullscreen();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && document.getElementById('noteModal')?.style.display !== 'none') {
        e.preventDefault();
        submitNote();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'p' && document.getElementById('noteModal')?.style.display !== 'none') {
        e.preventDefault();
        printNote(noteModalPageId);
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
    _toolbar?.querySelectorAll('.note-tb-btn').forEach(btn => {
      btn.addEventListener('pointerdown', e => e.preventDefault());
      btn.addEventListener('click', () => { if (_editor.applyFormat) _editor.applyFormat('notePageDesc', btn.dataset.fmt); });
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
      _createAndLinkCard(text);
      createForm.style.display = 'none';
    }

    document.getElementById('noteCreateCardSubmit')?.addEventListener('click', submitCreateCard);

    createInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitCreateCard(); }
      if (e.key === 'Escape') { createForm.style.display = 'none'; }
    });

    // Expose buildToc for editor preview rendering
    window.buildToc = buildToc;
  }

  // Run wiring immediately (initNotes is called after DOM ready)
  _init();

  // ---- Public API ----
  return {
    loadNotes,
    updateWebdavEnabled,
    syncNotesWithWebdav,
    toggleNotesSidebar,
    restoreNotesSidebar,
    openNoteModal,
    closeNoteModal,
    linkCardToPage,
    printNote,
    buildToc,
    resolveAttachments,
    // Exposed for testing / advanced use
    renderNotesTree,
    findNotePage,
    findNoteItem,
    getNotesState: () => notesState,
  };
}
