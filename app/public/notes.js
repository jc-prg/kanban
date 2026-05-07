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
let notesState     = { pages: [] };
let baseNotesState = null; // snapshot from last server load/save — the merge ancestor
let notesEtag      = null;
let notesSaveTimer = null;
const NOTES_API        = API_BASE ? `${API_BASE}/notes`             : null;
const NOTES_ATTACH_API = API_BASE ? `${API_BASE}/notes/attachments` : null;

// ---- Notes Load / Save ----
async function loadNotes() {
  if (!NOTES_API) return;
  try {
    const r = await fetch(NOTES_API);
    if (!r.ok) { notesState = { pages: [] }; }
    else {
      notesEtag  = r.headers.get('ETag');
      notesState = await r.json();
      if (!notesState.pages) notesState.pages = [];
    }
  } catch (e) { notesState = { pages: [] }; }
  baseNotesState = JSON.parse(JSON.stringify(notesState));
  renderNotesTree();
  restoreNotesSidebar();
  render();
}

// DFS-flatten note pages, stripping `children` from each entry.
// Returns a Map<id, pageOwnFields> in DFS traversal order.
function _flattenNotePages(pages, out = new Map()) {
  for (const p of pages) {
    const { children, ...own } = p;
    out.set(p.id, own);
    if (children?.length) _flattenNotePages(children, out);
  }
  return out;
}

// Returns { updatedPages } for content-only changes, {} for no changes,
// or null when structure changed (add/remove/reorder) — caller should fall back to PUT.
function buildNotesPatch(base, current) {
  const baseFlat = _flattenNotePages(base.pages);
  const currFlat = _flattenNotePages(current.pages);

  // Same set of IDs in same DFS order?
  const baseIds = [...baseFlat.keys()];
  const currIds = [...currFlat.keys()];
  if (JSON.stringify(baseIds) !== JSON.stringify(currIds)) return null;

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
        const localSnapshot = JSON.parse(JSON.stringify(notesState));
        const baseSnapshot  = JSON.parse(JSON.stringify(baseNotesState));
        await loadNotes();
        notesState = mergeNotesStates(baseSnapshot, notesState, localSnapshot);
        renderNotesTree();
        render();
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

// Remove a page by id from any level of a page tree (mutates in place).
function _removePage(id, pages) {
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].id === id) { pages.splice(i, 1); return true; }
    if (pages[i].children?.length && _removePage(id, pages[i].children)) return true;
  }
  return false;
}

// 3-way merge: remote wins for structure, local wins for own-field edits.
// When both sides changed the same page, newer lastModified wins.
function mergeNotesStates(base, remote, local) {
  const merged    = JSON.parse(JSON.stringify(remote));
  const baseFlat  = _flattenNotePages(base.pages);
  const localFlat = _flattenNotePages(local.pages);
  const remoteFlat = _flattenNotePages(remote.pages);

  // Pages new in local but not in base and not in remote → append to root
  for (const [id] of localFlat) {
    if (!baseFlat.has(id) && !remoteFlat.has(id)) {
      const p = findNotePage(id, local.pages);
      if (p) merged.pages.push(JSON.parse(JSON.stringify(p)));
    }
  }

  // Pages deleted in local (present in base, absent in local) → remove from merged
  for (const [id] of baseFlat) {
    if (!localFlat.has(id)) _removePage(id, merged.pages);
  }

  // Field-level merge for pages present in both local and base
  for (const [id, localPage] of localFlat) {
    const basePage = baseFlat.get(id);
    if (!basePage) continue; // new in local, handled above
    const mergedPageRef = findNotePage(id, merged.pages);
    if (!mergedPageRef) continue; // removed in remote → remote wins
    if (JSON.stringify(localPage) === JSON.stringify(basePage)) continue; // no local change

    const remotePage   = remoteFlat.get(id);
    const remoteChanged = remotePage && JSON.stringify(remotePage) !== JSON.stringify(basePage);

    if (!remoteChanged) {
      // Only local changed → apply local own fields (children preserved in mergedPageRef)
      for (const key of Object.keys(localPage)) mergedPageRef[key] = localPage[key];
    } else {
      // Both changed → newer lastModified wins
      if ((localPage.lastModified || '') > (remotePage.lastModified || '')) {
        for (const key of Object.keys(localPage)) mergedPageRef[key] = localPage[key];
      }
    }
  }

  return merged;
}

async function checkForNotesUpdates() {
  if (!NOTES_API || notesSaveTimer || !baseNotesState) return;
  try {
    const headers = notesEtag ? { 'If-None-Match': notesEtag } : {};
    const r = await fetch(NOTES_API, { headers });
    if (r.status === 304) return;
    if (!r.ok) return;
    notesEtag = r.headers.get('ETag');
    const remote = await r.json();
    if (JSON.stringify(remote) === JSON.stringify(notesState)) return;
    notesState    = mergeNotesStates(baseNotesState, remote, notesState);
    baseNotesState = JSON.parse(JSON.stringify(remote));
    renderNotesTree();
    render();
    scheduleSaveNotes(); // persist any local changes that survived the merge
  } catch (e) { /* ignore network errors */ }
}

setInterval(checkForNotesUpdates, 5000);

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
    lastModified: new Date().toISOString(),
  };
  if (!parentId) {
    notesState.pages.push(page);
  } else {
    const parent = findNotePage(parentId, notesState.pages);
    if (parent) { if (!parent.children) parent.children = []; parent.children.push(page); }
  }
  renderNotesTree();
  scheduleSaveNotes();
  openNoteModal(page.id, true);
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
    item.dataset.depth = depth;
    item.draggable = true;
    item.style.paddingLeft = (depth * 14 + 6) + 'px';

    const hasLink        = !!page.link?.trim();
    const hasCards       = page.linkedCards?.length > 0;
    const hasAttachments = !!page.hasAttachments;
    const indicators =
      (hasLink        ? `<span class="notes-item-indicator" title="Has link">${SVGICONS.link(9, 9)}</span>` : '') +
      (hasCards       ? `<span class="notes-item-indicator" title="${page.linkedCards.length} linked card(s)">${SVGICONS.linkedCards(9, 9)}</span>` : '') +
      (hasAttachments ? `<span class="notes-item-indicator" title="Has attachments">${SVGICONS.attachment(9, 9)}</span>` : '');

    item.innerHTML =
      `<button class="notes-toggle-btn${hasChildren ? '' : ' notes-toggle-btn--hidden'}" title="${isExpanded ? 'Collapse' : 'Expand'}">${isExpanded ? ICONS.collapse : ICONS.expand}</button>` +
      `<span class="notes-item-title-wrap">` +
        `<span class="notes-item-title${depth === 0 ? ' notes-item-title--root' : ''}">${escHtml(page.title)}</span>` +
        (indicators ? `<span class="notes-item-indicators">${indicators}</span>` : '') +
      `</span>` +
      `<div class="notes-item-btns">` +
        (canHaveChildren ? `<button class="notes-item-btn notes-item-btn--add" title="Add subpage">+</button>` : '') +
        `<button class="notes-item-btn notes-item-btn--del" title="Delete page">${ICONS.close}</button>` +
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
      const msg = page.children?.length
        ? `Delete "${page.title}" and all its subpages?`
        : `Delete page "${page.title}"?`;
      if (await showConfirm(msg, { okLabel: 'Delete', danger: true })) {
        if (noteModalPageId === page.id) closeNoteModal();
        deleteNotePage(page.id);
      }
    });

    container.appendChild(item);

    if (hasChildren && isExpanded) renderNotesList(page.children, container, depth + 1);
  }
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

async function _crumbNavigate(pageId) {
  if (noteModalHasChanges()) {
    const result = await showConfirm('Save changes before navigating?', { okLabel: 'Save', altLabel: "Don't save", cancelLabel: 'Cancel' });
    if (result === false) return;  // Cancel — stay on page
    if (result === true) submitNote();
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

function openNoteModal(pageId, focusTitle = false) {
  const page = findNotePage(pageId, notesState.pages);
  if (!page) return;
  noteModalPageId = pageId;

  document.getElementById('notePageTitle').value = page.title;
  document.getElementById('notePageDesc').value = page.description || '';
  document.getElementById('notePageLink').value = page.link || '';

  noteModalOrig = { title: page.title, desc: page.description || '', link: page.link || '' };

  renderLinkedCards(page.linkedCards || []);

  const path = getNotePath(pageId, notesState.pages);
  _renderCrumb(path);

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
  history.replaceState(null, '', '#note:' + pageId);
  const nt = document.getElementById('notePageTitle');
  autoResizeTitle(nt);
  if (focusTitle) requestAnimationFrame(() => { nt.focus(); nt.select(); });
}

function closeNoteModal() {
  _stopNoteAutoSave();
  if (location.hash.startsWith('#note:')) history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('noteModal').style.display = 'none';
  document.getElementById('noteCreateCardForm').style.display = 'none';
  noteModalPageId = null;
}

function submitNote() {
  if (!noteModalPageId) return;
  const page = findNotePage(noteModalPageId, notesState.pages);
  if (!page) return;

  page.title        = document.getElementById('notePageTitle').value.trim() || 'Untitled';
  page.description  = document.getElementById('notePageDesc').value;
  page.link         = document.getElementById('notePageLink').value.trim();
  page.lastModified = new Date().toISOString();

  noteModalOrig = { title: page.title, desc: page.description, link: page.link };

  _renderCrumb(getNotePath(noteModalPageId, notesState.pages));

  renderNotesTree();
  scheduleSaveNotes();

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

function buildSubpages(el) {
  const placeholder = [...el.querySelectorAll('p')].find(p => p.textContent.trim().toLowerCase() === '[subpages]');
  if (!placeholder) return;

  const page = findNotePage(noteModalPageId, notesState.pages);
  const children = page?.children?.length ? page.children : [];

  const wrap = document.createElement('div');
  wrap.className = 'md-subpages';
  const label = document.createElement('span');
  label.className = 'md-toc-label';
  label.textContent = 'Subpages';
  wrap.appendChild(label);

  function _buildItem(child, depth) {
    const hasLink        = !!child.link?.trim();
    const hasCards       = child.linkedCards?.length > 0;
    const hasAttachments = !!child.hasAttachments;
    const grandchildren  = child.children?.length ? child.children : [];

    const li = document.createElement('li');
    li.className = `md-subpages-item md-subpages-depth-${depth}`;

    const row = document.createElement('div');
    row.className = 'md-subpages-row';

    const a = document.createElement('a');
    a.className = 'md-subpages-title';
    a.textContent = child.title;
    a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); _crumbNavigate(child.id); });
    row.appendChild(a);

    const meta = document.createElement('span');
    meta.className = 'md-subpages-meta';
    if (hasCards)       meta.insertAdjacentHTML('beforeend', `<span class="notes-item-indicator" title="${child.linkedCards.length} linked card(s)">${SVGICONS.linkedCards(9, 9)}</span>`);
    if (hasLink)        meta.insertAdjacentHTML('beforeend', `<span class="notes-item-indicator" title="Has link">${SVGICONS.link(9, 9)}</span>`);
    if (hasAttachments) meta.insertAdjacentHTML('beforeend', `<span class="notes-item-indicator" title="Has attachments">${SVGICONS.attachment(9, 9)}</span>`);
    if (meta.children.length) row.appendChild(meta);
    li.appendChild(row);

    if (depth < 2 && grandchildren.length) {
      const sub = document.createElement('ul');
      sub.className = 'md-subpages-children';
      grandchildren.forEach(gc => sub.appendChild(_buildItem(gc, depth + 1)));
      li.appendChild(sub);
    }

    return li;
  }

  if (!children.length) {
    const empty = document.createElement('span');
    empty.className = 'md-subpages-empty';
    empty.textContent = 'No subpages yet';
    wrap.appendChild(empty);
  } else {
    const ul = document.createElement('ul');
    children.forEach(child => ul.appendChild(_buildItem(child, 1)));
    wrap.appendChild(ul);
  }

  placeholder.replaceWith(wrap);
}

function _applyNoteFormat(action) {
  applyDescFormat(document.getElementById('notePageDesc'), action);
}

function showNoteDescPreview() {
  showMarkdownPreview('notePageDesc', 'notePageDescPreview', 'noteDescToolbar', showNoteDescEditor,
    el => { buildToc(el); buildSubpages(el); resolveAttachments(el); });
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
        `<span class="note-mini-card-text${isGone ? ' note-mini-card-text--gone' : ''}" title="${escHtml(text)}">${escHtml(text)}</span>` +
      `</div>` +
      `<button class="note-mini-card-remove" title="Unlink card">${ICONS.close}</button>`;

    if (card && col) {
      mini.querySelector('.note-mini-card-body').addEventListener('click', () => { closeNoteModal(); openEditModal(col.id, card); });
    }
    mini.querySelector('.note-mini-card-remove').addEventListener('click', e => {
      e.stopPropagation();
      const page = findNotePage(noteModalPageId, notesState.pages);
      if (!page) return;
      page.linkedCards  = (page.linkedCards || []).filter(c => c !== id);
      page.lastModified = new Date().toISOString();
      renderLinkedCards(page.linkedCards);
      scheduleSaveNotes();
      render();
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
    target.lastModified = new Date().toISOString();
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

    const page = findNotePage(noteModalPageId, notesState.pages);
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
      item.addEventListener('click', () => {
        const page = findNotePage(noteModalPageId, notesState.pages);
        if (!page) return;
        if (!page.linkedCards) page.linkedCards = [];
        if (!page.linkedCards.includes(card.id)) {
          page.linkedCards.push(card.id);
          page.lastModified = new Date().toISOString();
          renderLinkedCards(page.linkedCards);
          scheduleSaveNotes();
          render();
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
  target.lastModified = new Date().toISOString();
  scheduleSaveNotes();
  if (noteModalPageId === pageId) renderLinkedCards(target.linkedCards);
  render();
}, true);

function initNotesDropZone() { /* wired above via document capture listeners */ }

// ---- Touch: card → notes page link ----
document.addEventListener('touchmove', e => {
  if (!touchDrag || touchDrag.type !== 'card') return;
  const t = e.touches[0];
  touchDrag.ghost.el.style.display = 'none';
  const under = document.elementFromPoint(t.clientX, t.clientY);
  touchDrag.ghost.el.style.display = '';
  const item = under?.closest('.notes-tree-item');
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
    const pageId = item.dataset.pageId;
    const target = findNotePage(pageId, notesState.pages);
    if (!target || (target.linkedCards || []).includes(cardId)) return;
    const label = card.text.length > 60 ? card.text.slice(0, 60) + '…' : card.text;
    if (!await showConfirm(`Link "${label}" to page "${target.title}"?`, { okLabel: 'Link card' })) return;
    (target.linkedCards ??= []).push(cardId);
    target.lastModified = new Date().toISOString();
    scheduleSaveNotes();
    if (noteModalPageId === pageId) renderLinkedCards(target.linkedCards);
    render();
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

  const page = findNotePage(pageId, notesState.pages);
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
    const icon = ft === 'image' ? ICONS.fileImage : ft === 'pdf' ? ICONS.filePdf : ft === 'html' ? ICONS.fileWeb : ICONS.fileGeneric;
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
  for (const file of Array.from(fileList)) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${NOTES_ATTACH_API}/${pageId}`, { method: 'POST', body: fd });
    if (r.ok) _appendAttachMd('notePageDesc', (await r.json()).name);
  }
  loadAttachments(pageId);
}

function _insertAttachmentMd(name, type) {
  const ta = document.getElementById('notePageDesc');
  if (!ta) return;
  showNoteDescEditor();
  ta.focus();
  const md = type === 'image' ? `![${name}](attachment:${name})` : `[${name}](attachment:${name})`;
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

  for (const img of container.querySelectorAll('img[src^="attachment:"]')) {
    const fn = img.getAttribute('src').slice('attachment:'.length);
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

  for (const a of container.querySelectorAll('a[href^="attachment:"]')) {
    const fn = a.getAttribute('href').slice('attachment:'.length);
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

function _subtreeHeight(page) {
  if (!page.children?.length) return 0;
  return 1 + Math.max(...page.children.map(_subtreeHeight));
}

function _removeFromTree(id, pages) {
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].id === id) return pages.splice(i, 1)[0];
    const r = _removeFromTree(id, pages[i].children || []);
    if (r) return r;
  }
  return null;
}

function _insertIntoTree(page, targetId, position, pages) {
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].id === targetId) {
      if (position === 'before') { pages.splice(i, 0, page); return true; }
      if (position === 'after')  { pages.splice(i + 1, 0, page); return true; }
      if (position === 'into')   {
        if (!pages[i].children) pages[i].children = [];
        pages[i].children.unshift(page);
        return true;
      }
    }
    if (_insertIntoTree(page, targetId, position, pages[i].children || [])) return true;
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
    if (!item || item.dataset.pageId === ttDragId) return;

    const draggedPage = findNotePage(ttDragId, notesState.pages);
    if (!draggedPage) return;
    const dragHeight  = _subtreeHeight(draggedPage);
    const targetDepth = +item.dataset.depth;
    const rect        = item.getBoundingClientRect();
    const ratio       = (y - rect.top) / rect.height;
    const canBefore   = targetDepth + dragHeight <= 2;
    const canInto     = targetDepth < 2 && targetDepth + 1 + dragHeight <= 2;

    _clearTreeDrop();
    if      (canBefore && ratio < 0.3)  item.classList.add('notes-tree-item--drop-before');
    else if (canBefore && ratio > 0.7)  item.classList.add('notes-tree-item--drop-after');
    else if (canInto)                   item.classList.add('notes-tree-item--drop-into');
    else if (canBefore && ratio <= 0.5) item.classList.add('notes-tree-item--drop-before');
    else if (canBefore)                 item.classList.add('notes-tree-item--drop-after');
    ttOverItem = item;
  }

  container.addEventListener('touchstart', e => {
    const item = e.target.closest('.notes-tree-item');
    if (!item || e.target.closest('button')) return;
    ttDragId  = item.dataset.pageId;
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
    if (!item || item.dataset.pageId === savedId) { _clearTreeDrop(); return; }

    const position = item.classList.contains('notes-tree-item--drop-before') ? 'before'
                   : item.classList.contains('notes-tree-item--drop-after')  ? 'after'
                   : item.classList.contains('notes-tree-item--drop-into')   ? 'into'
                   : null;
    _clearTreeDrop();
    if (!position) return;

    const page = _removeFromTree(savedId, notesState.pages);
    if (!page) return;
    if (position === 'into') notesExpanded.add(item.dataset.pageId);
    _insertIntoTree(page, item.dataset.pageId, position, notesState.pages);
    scheduleSaveNotes();
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
    _treeDragId = item.dataset.pageId;
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
    if (!item || item.dataset.pageId === _treeDragId) { _clearTreeDrop(); return; }

    const draggedPage = findNotePage(_treeDragId, notesState.pages);
    if (!draggedPage) return;
    const dragHeight  = _subtreeHeight(draggedPage);
    const targetDepth = +item.dataset.depth;

    const rect  = item.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;

    const canBefore = targetDepth + dragHeight <= 2;
    const canInto   = targetDepth < 2 && targetDepth + 1 + dragHeight <= 2;
    const canAfter  = canBefore;

    _clearTreeDrop();
    if (canBefore && ratio < 0.3) {
      item.classList.add('notes-tree-item--drop-before');
    } else if (canAfter && ratio > 0.7) {
      item.classList.add('notes-tree-item--drop-after');
    } else if (canInto) {
      item.classList.add('notes-tree-item--drop-into');
    } else if (canBefore && ratio <= 0.5) {
      item.classList.add('notes-tree-item--drop-before');
    } else if (canAfter) {
      item.classList.add('notes-tree-item--drop-after');
    }

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
    if (!item || item.dataset.pageId === _treeDragId) { _clearTreeDrop(); return; }

    const position = item.classList.contains('notes-tree-item--drop-before') ? 'before'
                   : item.classList.contains('notes-tree-item--drop-after')  ? 'after'
                   : item.classList.contains('notes-tree-item--drop-into')   ? 'into'
                   : null;
    _clearTreeDrop();
    if (!position) return;

    const targetId = item.dataset.pageId;
    const page = _removeFromTree(_treeDragId, notesState.pages);
    if (!page) return;

    if (position === 'into') notesExpanded.add(targetId);
    _insertIntoTree(page, targetId, position, notesState.pages);
    scheduleSaveNotes();
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
  document.getElementById('notesSidebarFontBtn')?.addEventListener('click', toggleNotesFontSize);

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
    const path = getNotePath(noteModalPageId, notesState.pages);
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
