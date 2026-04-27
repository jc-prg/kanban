// ---- Description markdown preview ----
function showDescPreview() {
  const text = document.getElementById('cardDesc').value.trim();
  if (!text) { showDescEditor(); return; }
  document.getElementById('cardDescPreview').innerHTML = marked.parse(text, { breaks: true });
  document.getElementById('cardDescPreview').style.display = '';
  document.getElementById('cardDesc').style.display = 'none';
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

  document.getElementById('cardToggleDate')    ?.addEventListener('click', () => toggleCardSection('cardDateSection',     'cardToggleDate'));
  document.getElementById('cardTogglePriority')?.addEventListener('click', () => toggleCardSection('cardPrioritySection', 'cardTogglePriority'));
  document.getElementById('cardToggleColor')   ?.addEventListener('click', () => toggleCardSection('cardColorSection',    'cardToggleColor'));

  document.getElementById('cardDescPreview').addEventListener('click', () => {
    showDescEditor();
    document.getElementById('cardDesc').focus();
  });
  document.getElementById('cardDesc').addEventListener('blur', () => {
    if (document.getElementById('cardDesc').value.trim()) showDescPreview();
  });
  document.getElementById('cardDesc').addEventListener('keydown', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    const markers = e.key === 'b' ? ['**','**'] : e.key === 'i' ? ['*','*'] : e.key === 'u' ? ['<u>','</u>'] : null;
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

// ---- Modal state ----
let modalColId       = null;
let modalMode        = 'add'; // 'add' | 'edit' | 'inbox'
let editCardId       = null;
let selectedColor    = COLORS[0];
let selectedPriority = 0;
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
         selectedPriority !== o.priority || selectedColor !== o.color;
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
  setCardSection('cardDateSection',     'cardToggleDate',     false);
  setCardSection('cardPrioritySection', 'cardTogglePriority', false);
  setCardSection('cardColorSection',    'cardToggleColor',    false);
}

// ---- Linked note pages on a card ----
function renderCardLinkedPages(cardId) {
  const field = document.getElementById('cardLinkedPagesField');
  const list  = document.getElementById('cardLinkedPagesList');
  if (!field || !list) return;

  const linked = [];
  (function search(pages) {
    for (const p of pages) {
      if ((p.linkedCards || []).includes(cardId)) linked.push(p);
      if (p.children?.length) search(p.children);
    }
  })(typeof notesState !== 'undefined' ? notesState.pages : []);

  field.style.display = linked.length ? '' : 'none';
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
  ct.focus();
  autoResizeTitle(ct);
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
  _updateLinkBtn();
  if (card.description) showDescPreview(); else showDescEditor();
  document.getElementById('modalTitle').textContent     = 'Edit Card';
  document.getElementById('modalSubmitBtn').textContent = 'Save';
  document.getElementById('modalDeleteBtn').style.display = '';
  resetCardSections();
  renderColorRow();
  renderPriorityRow();
  renderCardLinkedPages(card.id);
  captureModalOriginal();
  document.getElementById('modal').style.display = 'flex';
  const ct = document.getElementById('cardText');
  ct.focus();
  autoResizeTitle(ct);
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
  document.getElementById('modalBoardField').style.display    = 'none';
  document.getElementById('modalStatusMsg').style.display     = 'none';
  document.getElementById('modalGoBoardBtn').style.display    = 'none';
  document.getElementById('modalDeleteBtn').style.display     = 'none';
  document.getElementById('cardLinkedPagesField').style.display = 'none';
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
    priority:    selectedPriority || null,
    description: document.getElementById('cardDesc').value.trim()  || null,
    link:        document.getElementById('cardLink').value.trim()   || null,
    startDate:   document.getElementById('cardStart').value         || null,
    endDate:     document.getElementById('cardEnd').value           || null,
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
  document.getElementById('cardText').focus();
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
    priority:    selectedPriority || null,
    description: document.getElementById('cardDesc').value.trim()  || null,
    link:        document.getElementById('cardLink').value.trim()   || null,
    startDate:   document.getElementById('cardStart').value         || null,
    endDate:     document.getElementById('cardEnd').value           || null,
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
