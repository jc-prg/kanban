// ---- Shared description formatting helpers ----
function _descWrap(ta, open, close) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.setRangeText(open + ta.value.slice(s, e) + close, s, e, 'select');
  if (s === e) { const mid = s + open.length; ta.setSelectionRange(mid, mid); }
  ta.focus();
}

function _descLinePrefix(ta, prefix) {
  const s = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
  ta.setRangeText(prefix, lineStart, lineStart, 'end');
  ta.focus();
}

function _descInsertBlock(ta, text, cursorOffset) {
  const s = ta.selectionStart;
  const needsNewline = s > 0 && ta.value[s - 1] !== '\n';
  const insert = (needsNewline ? '\n' : '') + text;
  ta.setRangeText(insert, s, s, 'end');
  const pos = s + (needsNewline ? 1 : 0) + cursorOffset;
  ta.setSelectionRange(pos, pos);
  ta.focus();
}

function applyDescFormat(ta, action) {
  if (!ta) return;
  if (action === 'bold')      return _descWrap(ta, '**', '**');
  if (action === 'italic')    return _descWrap(ta, '*', '*');
  if (action === 'underline') return _descWrap(ta, '<u>', '</u>');
  if (action === 'mark')      return _descWrap(ta, '<mark>', '</mark>');
  if (action === 'h1')        return _descLinePrefix(ta, '# ');
  if (action === 'h2')        return _descLinePrefix(ta, '## ');
  if (action === 'h3')        return _descLinePrefix(ta, '### ');
  if (action === 'checkbox')  return _descLinePrefix(ta, '- [ ] ');
  if (action === 'code')      return _descInsertBlock(ta, '```\n\n```', 4);
  if (action === 'toc')       return _descInsertBlock(ta, '[toc]', 5);
  if (action === 'subpages')  return _descInsertBlock(ta, '[subpages]', 10);
}

// ---- Markdown preview enhancement (copy buttons + task checkboxes) ----
function enhanceMarkdownPreview(container) {
  // Interactive task-list checkboxes
  // marked renders "- [ ]" / "- [x]" as <input type="checkbox" disabled>
  container.querySelectorAll('input[type="checkbox"]').forEach((cb, idx) => {
    cb.removeAttribute('disabled');
    cb.addEventListener('click', e => {
      e.stopPropagation();
      let count = 0;
      const raw = container.dataset.rawText || '';
      const updated = raw.replace(/^(\s*[-*+] \[)([ x])(\])/gim, (match, before, _state, after) => {
        const hit = count++ === idx;
        return hit ? before + (cb.checked ? 'x' : ' ') + after : match;
      });
      container.dataset.rawText = updated;
      const taId = container.id === 'cardDescPreview' ? 'cardDesc' : 'notePageDesc';
      const ta = document.getElementById(taId);
      if (ta) ta.value = updated;
    });
  });

  container.querySelectorAll('pre').forEach(pre => {
    const btn = document.createElement('button');
    btn.className = 'md-copy-btn';
    btn.textContent = ICONS.copyCode;
    btn.title = 'Copy code';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const text = (pre.querySelector('code') || pre).textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = ICONS.done;
        setTimeout(() => { btn.textContent = ICONS.copyCode; }, 1500);
      });
    });
    pre.appendChild(btn);
  });

  const allBtn = document.createElement('button');
  allBtn.className = 'md-copy-all-btn';
  allBtn.textContent = ICONS.copyCode;
  allBtn.title = 'Copy full description';
  allBtn.addEventListener('click', e => {
    e.stopPropagation();
    navigator.clipboard.writeText(container.dataset.rawText || container.innerText).then(() => {
      allBtn.textContent = ICONS.done;
      setTimeout(() => { allBtn.textContent = ICONS.copyCode; }, 1500);
    });
  });
  container.appendChild(allBtn);
}

// ---- Description markdown preview ----
function showDescPreview() {
  const text = document.getElementById('cardDesc').value.trim();
  if (!text) { showDescEditor(); return; }
  const el = document.getElementById('cardDescPreview');
  el.dataset.rawText = text;
  el.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true }));
  enhanceMarkdownPreview(el);
  if (editCardId && CARD_ATTACH_API) resolveCardAttachments(el);
  el.style.display = '';
  document.getElementById('cardDesc').style.display = 'none';
  document.getElementById('cardDescToolbar').style.display = 'none';
}

function previewScrollFrac(el, e) {
  const rect = el.getBoundingClientRect();
  const relY = e.clientY - rect.top + el.scrollTop;
  return Math.min(1, Math.max(0, relY / Math.max(1, el.scrollHeight)));
}

function applyEditorFrac(ta, frac) {
  ta.scrollTop = frac * Math.max(0, ta.scrollHeight - ta.clientHeight);
  const lines = ta.value.split('\n');
  const targetLine = Math.round(frac * (lines.length - 1));
  let pos = 0;
  for (let i = 0; i < targetLine; i++) pos += lines[i].length + 1;
  pos = Math.min(pos, ta.value.length);
  ta.setSelectionRange(pos, pos);
}

function showDescEditor() {
  document.getElementById('cardDescPreview').style.display = 'none';
  const ta = document.getElementById('cardDesc');
  ta.style.display = '';
  ta.scrollTop = 0;
  ta.setSelectionRange(0, 0);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('cardText').addEventListener('input', e => autoResizeTitle(e.target));

  document.getElementById('cardInfoBtn')?.addEventListener('click', () => {
    const col = state.columns.find(c => c.id === modalColId);
    const card = col?.cards.find(c => c.id === editCardId);
    if (card) openCardInfo(card);
  });

  document.getElementById('cardToggleDate')       ?.addEventListener('click', () => toggleCardSection('cardDateSection',        'cardToggleDate'));
  document.getElementById('cardTogglePriority')   ?.addEventListener('click', () => toggleCardSection('cardPrioritySection',   'cardTogglePriority'));
  document.getElementById('cardToggleColor')      ?.addEventListener('click', () => toggleCardSection('cardColorSection',      'cardToggleColor'));
  document.getElementById('cardToggleNotePages')  ?.addEventListener('click', () => toggleCardSection('cardNotePagesSection',  'cardToggleNotePages'));
  document.getElementById('cardToggleAttachments')?.addEventListener('click', () => toggleCardSection('cardAttachmentsSection','cardToggleAttachments'));

  document.getElementById('cardAttachInput')?.addEventListener('change', e => {
    if (editCardId) _handleCardAttachUpload(editCardId, e.target.files);
    e.target.value = '';
  });

  document.getElementById('cardDescPreview').addEventListener('click', e => {
    const preview = document.getElementById('cardDescPreview');
    const frac = previewScrollFrac(preview, e);
    showDescEditor();
    const ta = document.getElementById('cardDesc');
    requestAnimationFrame(() => applyEditorFrac(ta, frac));
    ta.focus();
  });
  document.getElementById('cardDesc').addEventListener('focus', () => {
    document.getElementById('cardDescToolbar').style.display = 'flex';
  });
  document.getElementById('cardDesc').addEventListener('blur', () => {
    document.getElementById('cardDescToolbar').style.display = 'none';
    if (document.getElementById('cardDesc').value.trim()) showDescPreview();
  });

  const _cardToolbar = document.getElementById('cardDescToolbar');
  _cardToolbar?.querySelectorAll('.note-tb-btn').forEach(btn => {
    btn.addEventListener('pointerdown', e => e.preventDefault());
    btn.addEventListener('click', () => applyDescFormat(document.getElementById('cardDesc'), btn.dataset.fmt));
  });
  document.getElementById('cardDesc').addEventListener('keydown', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    const markers = e.key === 'b' ? ['**','**'] : e.key === 'i' ? ['*','*'] : e.key === 'u' ? ['<u>','</u>'] : e.key === 'm' ? ['<mark>','</mark>'] : null;
    if (!markers) return;
    e.preventDefault();
    const ta = e.target;
    const [start, end] = [ta.selectionStart, ta.selectionEnd];
    const selected = ta.value.slice(start, end);
    const wrapped = markers[0] + selected + markers[1];
    ta.setRangeText(wrapped, start, end, 'select');
    if (!selected) {
      const mid = start + markers[0].length;
      ta.setSelectionRange(mid, mid);
    }
  });
});

// ---- Link open button ----
(function () {
  function updateLinkBtn() {
    const url = document.getElementById('cardLink').value.trim();
    document.getElementById('cardLinkOpen').classList.toggle('has-url', !!url);
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('cardLink').addEventListener('input', updateLinkBtn);
    document.getElementById('cardLinkOpen').addEventListener('click', () => {
      const url = document.getElementById('cardLink').value.trim();
      if (url) window.open(url, '_blank', 'noopener');
    });
  });
  window._updateLinkBtn = updateLinkBtn;
})();

// ---- Card attachment constants & helpers ----
const CARD_ATTACH_API = API_BASE ? `${API_BASE}/cards/attachments` : null;

let cardAttachSet = new Set();

async function loadCardAttachSet() {
  if (!CARD_ATTACH_API) return;
  try {
    const r = await fetch(CARD_ATTACH_API);
    cardAttachSet = new Set(r.ok ? await r.json() : []);
  } catch { cardAttachSet = new Set(); }
  render();
}

function _fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function _attachType(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['html','htm'].includes(ext)) return 'html';
  return 'other';
}

async function _openInNewTab(url) {
  const r = await fetch(url);
  if (!r.ok) return;
  window.open(URL.createObjectURL(await r.blob()), '_blank');
}

// ---- Card attachment functions ----
async function loadCardAttachments(cardId) {
  const list = document.getElementById('cardAttachList');
  if (!list || !CARD_ATTACH_API) return;
  try {
    const r = await fetch(`${CARD_ATTACH_API}/${cardId}`);
    renderCardAttachments(cardId, r.ok ? await r.json() : []);
  } catch { renderCardAttachments(cardId, []); }
}

function renderCardAttachments(cardId, files) {
  const list = document.getElementById('cardAttachList');
  if (!list) return;
  list.innerHTML = '';
  const hadAttach = cardAttachSet.has(cardId);
  if (files.length) cardAttachSet.add(cardId); else cardAttachSet.delete(cardId);
  if (hadAttach !== cardAttachSet.has(cardId)) render();
  if (!files.length) {
    const p = document.createElement('p');
    p.className = 'note-attach-empty';
    p.textContent = 'No attachments yet';
    list.appendChild(p);
    return;
  }
  for (const f of files) {
    const ft  = _attachType(f.name);
    const url = `${CARD_ATTACH_API}/${cardId}/${encodeURIComponent(f.name)}`;
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
      item.querySelector('[data-act="view"]').addEventListener('click',     () => openAttachmentViewer(url, f.name, ft));
    else if (ft === 'html')
      item.querySelector('[data-act="view"]').addEventListener('click',     () => _openInNewTab(url));
    item.querySelector('[data-act="insert"]').addEventListener('click',     () => _insertCardAttachMd(f.name, ft));
    item.querySelector('[data-act="download"]').addEventListener('click',   () => _downloadAttachment(url, f.name));
    item.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!await showConfirm(`Delete "${f.name}"?`, { okLabel: 'Delete', danger: true })) return;
      await fetch(`${CARD_ATTACH_API}/${cardId}/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
      loadCardAttachments(cardId);
    });
    list.appendChild(item);
  }
}

function _appendAttachMd(taId, name) {
  const ft = _attachType(name);
  const md = ft === 'image' ? `![${name}](attachment:${name})` : `[${name}](attachment:${name})`;
  const ta = document.getElementById(taId);
  if (!ta) return;
  if (ta.value) {
    const sep = ta.value.endsWith('\n\n') ? '' : ta.value.endsWith('\n') ? '\n' : '\n\n';
    ta.value += sep + md;
  } else {
    ta.value = md;
  }
  const previewId = taId === 'cardDesc' ? 'cardDescPreview' : 'notePageDescPreview';
  const preview = document.getElementById(previewId);
  if (preview && preview.style.display !== 'none') {
    if (taId === 'cardDesc') showDescPreview();
    else if (typeof showNoteDescPreview === 'function') showNoteDescPreview();
  }
}

async function _handleCardAttachUpload(cardId, fileList) {
  if (!CARD_ATTACH_API || !fileList.length) return;
  for (const file of Array.from(fileList)) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${CARD_ATTACH_API}/${cardId}`, { method: 'POST', body: fd });
    if (r.ok) _appendAttachMd('cardDesc', (await r.json()).name);
  }
  loadCardAttachments(cardId);
}

function _insertCardAttachMd(name, type) {
  const ta = document.getElementById('cardDesc');
  if (!ta) return;
  showDescEditor();
  ta.focus();
  const md = type === 'image' ? `![${name}](attachment:${name})` : `[${name}](attachment:${name})`;
  const s = ta.selectionStart ?? ta.value.length;
  ta.setRangeText(md, s, ta.selectionEnd ?? s, 'end');
}

async function resolveCardAttachments(container) {
  if (!editCardId || !CARD_ATTACH_API) return;
  const base = `${CARD_ATTACH_API}/${editCardId}`;
  for (const img of container.querySelectorAll('img[src^="attachment:"]')) {
    const fn = img.getAttribute('src').slice('attachment:'.length);
    try {
      const r = await fetch(`${base}/${encodeURIComponent(fn)}`);
      if (r.ok) img.src = URL.createObjectURL(await r.blob());
    } catch {}
  }
  for (const a of container.querySelectorAll('a[href^="attachment:"]')) {
    const fn = a.getAttribute('href').slice('attachment:'.length);
    const url = `${base}/${encodeURIComponent(fn)}`;
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
    if (_attachType(fn) === 'html')
      a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); _openInNewTab(url); });
    else
      a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); _downloadAttachment(url, fn); });
  }
}

// ---- Modal state ----
let modalColId       = null;
let modalMode        = 'add'; // 'add' | 'edit' | 'inbox'
let editCardId       = null;
let selectedColor    = COLORS[0];
let selectedPriority = 0;
let modalDone        = false;
let modalOriginalData = null;

function captureModalOriginal() {
  modalOriginalData = {
    text:     document.getElementById('cardText').value,
    desc:     document.getElementById('cardDesc').value,
    link:     document.getElementById('cardLink').value,
    start:    document.getElementById('cardStart').value,
    end:      document.getElementById('cardEnd').value,
    priority: selectedPriority,
    color:    selectedColor,
    done:     modalDone,
  };
}

function hasModalChanges() {
  if (!modalOriginalData) return false;
  const o = modalOriginalData;
  return document.getElementById('cardText').value  !== o.text  ||
         document.getElementById('cardDesc').value  !== o.desc  ||
         document.getElementById('cardLink').value  !== o.link  ||
         document.getElementById('cardStart').value !== o.start ||
         document.getElementById('cardEnd').value   !== o.end   ||
         selectedPriority !== o.priority || selectedColor !== o.color ||
         modalDone !== o.done;
}

function setModalDone(val) {
  modalDone = !!val;
  document.getElementById('cardDoneBtn').classList.toggle('done', modalDone);
}

function toggleModalDone() {
  setModalDone(!modalDone);
}

async function tryCloseModal() {
  if (modalMode !== 'inbox' && hasModalChanges()) {
    if (await showConfirm('Close without saving changes?', { okLabel: 'Close', danger: true }))
      closeModal();
  } else {
    closeModal();
  }
}

// ---- Collapsible card sections ----
function setCardSection(sectionId, btnId, open) {
  const section = document.getElementById(sectionId);
  const btn     = document.getElementById(btnId);
  if (section) section.style.display = open ? '' : 'none';
  if (btn)     btn.classList.toggle('card-section-toggle--active', open);
}

function toggleCardSection(sectionId, btnId) {
  const section = document.getElementById(sectionId);
  setCardSection(sectionId, btnId, section?.style.display === 'none');
}

function resetCardSections() {
  const wide = window.innerWidth >= 1200;
  setCardSection('cardDateSection',     'cardToggleDate',     wide);
  setCardSection('cardPrioritySection', 'cardTogglePriority', wide);
  setCardSection('cardColorSection',    'cardToggleColor',    wide);
  const canAttach = modalMode === 'edit' && !!editCardId && !!CARD_ATTACH_API;
  const attachToggle = document.getElementById('cardToggleAttachments');
  if (attachToggle) attachToggle.style.display = canAttach ? '' : 'none';
  setCardSection('cardAttachmentsSection', 'cardToggleAttachments', canAttach && wide);
}

// ---- Linked note pages on a card ----
function renderCardLinkedPages(cardId) {
  const section = document.getElementById('cardNotePagesSection');
  const toggle  = document.getElementById('cardToggleNotePages');
  const list    = document.getElementById('cardLinkedPagesList');
  if (!list) return;

  const linked = [];
  (function search(pages) {
    for (const p of pages) {
      if ((p.linkedCards || []).includes(cardId)) linked.push(p);
      if (p.children?.length) search(p.children);
    }
  })(typeof notesState !== 'undefined' ? notesState.pages : []);

  const hasLinked = linked.length > 0;
  const wide = window.innerWidth >= 1200;
  if (toggle)  toggle.style.display = hasLinked ? '' : 'none';
  setCardSection('cardNotePagesSection', 'cardToggleNotePages', hasLinked && wide);

  list.innerHTML = '';
  linked.forEach(page => {
    const chip = document.createElement('button');
    chip.className = 'card-linked-page-chip';
    chip.textContent = page.title;
    const path = typeof getNotePath === 'function'
      ? getNotePath(page.id, notesState.pages)
      : null;
    chip.title = path ? path.map(p => p.title).join(' › ') : page.title;
    chip.addEventListener('click', () => { closeModal(); openNoteModal(page.id); });
    list.appendChild(chip);
  });
}

// ---- Auto-resize for title textareas ----
function autoResizeTitle(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// ---- Card add/edit modal ----
function openModal(colId) {
  modalMode = 'add';
  modalColId = colId;
  editCardId = null;
  selectedColor = COLORS[0];
  selectedPriority = 0;
  document.getElementById('cardText').value  = '';
  document.getElementById('cardDesc').value  = '';
  document.getElementById('cardLink').value  = '';
  document.getElementById('cardStart').value = '';
  document.getElementById('cardEnd').value   = '';
  document.getElementById('cardDoneBtn').style.display = 'none';
  document.getElementById('cardInfoBtn').style.display  = 'none';
  _updateLinkBtn();
  showDescEditor();
  document.getElementById('modalTitle').textContent      = 'Add Card';
  document.getElementById('modalSubmitBtn').textContent  = 'Add Card';
  resetCardSections();
  renderColorRow();
  renderPriorityRow();
  captureModalOriginal();
  document.getElementById('modal').style.display = 'flex';
  const ct = document.getElementById('cardText');
  autoResizeTitle(ct);
  requestAnimationFrame(() => ct.focus());
}

function openEditModal(colId, card) {
  modalMode = 'edit';
  modalColId = colId;
  editCardId = card.id;
  selectedColor    = card.color    || COLORS[0];
  selectedPriority = card.priority || 0;
  document.getElementById('cardText').value  = card.text        || '';
  document.getElementById('cardDesc').value  = card.description || '';
  document.getElementById('cardLink').value  = card.link        || '';
  document.getElementById('cardStart').value = card.startDate   || '';
  document.getElementById('cardEnd').value   = card.endDate     || '';
  document.getElementById('cardDoneBtn').style.display  = '';
  document.getElementById('cardInfoBtn').style.display  = '';
  setModalDone(card.done || false);
  _updateLinkBtn();
  if (card.description) showDescPreview(); else showDescEditor();
  document.getElementById('modalTitle').textContent     = 'Edit Card';
  document.getElementById('modalSubmitBtn').textContent = 'Save';
  document.getElementById('modalDeleteBtn').style.display = '';
  resetCardSections();
  renderColorRow();
  renderPriorityRow();
  renderCardLinkedPages(card.id);
  if (CARD_ATTACH_API) loadCardAttachments(card.id);
  captureModalOriginal();
  document.getElementById('modal').style.display = 'flex';
  history.replaceState(null, '', '#card:' + card.id);
  const ct = document.getElementById('cardText');
  autoResizeTitle(ct);
}

function closeModal() {
  if (location.hash.startsWith('#card:')) history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('modal').style.display = 'none';
  document.getElementById('modalBoardField').style.display    = 'none';
  document.getElementById('modalStatusMsg').style.display     = 'none';
  document.getElementById('modalGoBoardBtn').style.display    = 'none';
  document.getElementById('modalDeleteBtn').style.display     = 'none';
  setCardSection('cardNotePagesSection', 'cardToggleNotePages', false);
  const noteToggle = document.getElementById('cardToggleNotePages');
  if (noteToggle) noteToggle.style.display = 'none';
  resetCardSections();
  showDescEditor();
}

function submitCard() {
  if (modalMode === 'inbox') { submitInboxCard(); return; }
  const text = document.getElementById('cardText').value.trim();
  if (!text) return;
  const data = {
    text,
    color:       selectedColor,
    priority:    selectedPriority || undefined,
    description: document.getElementById('cardDesc').value.trim()  || undefined,
    link:        document.getElementById('cardLink').value.trim()   || undefined,
    startDate:   document.getElementById('cardStart').value         || undefined,
    endDate:     document.getElementById('cardEnd').value           || undefined,
    done:        modalMode === 'edit' ? modalDone : undefined,
  };
  if (modalMode === 'add') addCard(modalColId, data);
  else updateCardFull(modalColId, editCardId, data);
  closeModal();
}

async function openInboxModal(preselectedBoard) {
  modalMode = 'inbox';
  selectedColor    = COLORS[0];
  selectedPriority = 0;
  document.getElementById('cardText').value  = '';
  document.getElementById('cardDesc').value  = '';
  document.getElementById('cardLink').value  = '';
  document.getElementById('cardStart').value = '';
  document.getElementById('cardEnd').value   = '';
  _updateLinkBtn();
  modalOriginalData = null;
  document.getElementById('modalTitle').textContent     = 'Add to Inbox';
  document.getElementById('modalSubmitBtn').textContent = 'Add to Inbox';
  document.getElementById('modalStatusMsg').style.display  = 'none';
  document.getElementById('modalGoBoardBtn').style.display = 'none';
  renderColorRow();
  renderPriorityRow();

  const field  = document.getElementById('modalBoardField');
  const select = document.getElementById('modalBoardSelect');
  field.style.display = '';
  try {
    const boards = await fetch('/api/boards').then(r => r.json());
    select.innerHTML = boards.length
      ? boards.map(b => `<option value="${escHtml(b.name)}">${escHtml(b.name)}</option>`).join('')
      : '<option value="">No boards available</option>';
    if (preselectedBoard) select.value = preselectedBoard;
  } catch {
    select.innerHTML = '<option value="">Failed to load boards</option>';
  }

  document.getElementById('modal').style.display = 'flex';
}

async function submitInboxCard() {
  document.getElementById('modalGoBoardBtn').style.display = 'none';
  const board = document.getElementById('modalBoardSelect').value;
  const text  = document.getElementById('cardText').value.trim();
  if (!board) { showModalStatus('Select a board.', true); return; }
  if (!text)  { showModalStatus('Text is required.', true); return; }

  const card = {
    text,
    color:       selectedColor,
    priority:    selectedPriority || null,
    description: document.getElementById('cardDesc').value.trim()  || null,
    link:        document.getElementById('cardLink').value.trim()   || null,
    startDate:   document.getElementById('cardStart').value         || null,
    endDate:     document.getElementById('cardEnd').value           || null,
  };
  try {
    const r    = await fetch(`/api/${encodeURIComponent(board)}/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([card]),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Request failed');
    if (data.relevant > 0) {
      showModalStatus('Card added.', false);
      document.getElementById('cardText').value  = '';
      document.getElementById('cardDesc').value  = '';
      document.getElementById('cardLink').value  = '';
      document.getElementById('cardStart').value = '';
      document.getElementById('cardEnd').value   = '';
      _updateLinkBtn();
      selectedColor = COLORS[0]; selectedPriority = 0;
      renderColorRow(); renderPriorityRow();
      const goBtn = document.getElementById('modalGoBoardBtn');
      goBtn.href = `/${encodeURIComponent(board)}`;
      goBtn.style.display = '';
      document.getElementById('cardText').focus();
    } else {
      showModalStatus('Card already exists in this board.', true);
    }
  } catch (e) {
    showModalStatus(e.message || 'Failed to add card.', true);
  }
}

function showModalStatus(text, isError) {
  const el = document.getElementById('modalStatusMsg');
  el.textContent = text;
  el.className   = 'inbox-msg ' + (isError ? 'inbox-msg-error' : 'inbox-msg-ok');
  el.style.display = '';
  if (!isError) setTimeout(() => { if (el.textContent === text) el.style.display = 'none'; }, 3000);
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
  if (e.target === document.getElementById('modal')) tryCloseModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('modal').style.display !== 'none') tryCloseModal();
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && document.getElementById('modal').style.display !== 'none') {
    e.preventDefault();
    saveCardInPlace();
    return;
  }
  if (e.key === 'Enter' && document.getElementById('modal').style.display !== 'none' && !e.shiftKey) {
    if (document.activeElement.id === 'cardDesc') return;
    e.preventDefault();
    submitCard();
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.getElementById('modal').style.display !== 'none') {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const preview = document.getElementById('cardDescPreview');
    const target = preview?.style.display !== 'none' ? preview : null;
    if (!target) return;
    e.preventDefault();
    target.scrollTop += e.key === 'ArrowDown' ? 80 : -80;
  }
});

async function deleteCardFromModal() {
  const ok = await showConfirm('Delete this card?', { okLabel: 'Delete' });
  if (!ok) return;
  deleteCard(modalColId, editCardId);
  closeModal();
}

function saveCardInPlace() {
  const text = document.getElementById('cardText').value.trim();
  if (!text || modalMode === 'inbox') return;
  const data = {
    text,
    color:       selectedColor,
    priority:    selectedPriority || undefined,
    description: document.getElementById('cardDesc').value.trim()  || undefined,
    link:        document.getElementById('cardLink').value.trim()   || undefined,
    startDate:   document.getElementById('cardStart').value         || undefined,
    endDate:     document.getElementById('cardEnd').value           || undefined,
    done:        modalMode === 'edit' ? modalDone : undefined,
  };
  if (modalMode === 'edit') updateCardFull(modalColId, editCardId, data);
  else if (modalMode === 'add') addCard(modalColId, data);
  captureModalOriginal();
  const msg = document.getElementById('modalSavedMsg');
  msg.textContent = 'saved';
  msg.classList.add('modal-saved-msg--visible');
  setTimeout(() => { msg.textContent = ''; msg.classList.remove('modal-saved-msg--visible'); }, 2000);
}

// ---- Card info dialog ----
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
      if (card.lastModified) html += `<tr><th>Last modified</th><td>${escHtml(new Date(card.lastModified).toLocaleString())}</td></tr>`;
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
