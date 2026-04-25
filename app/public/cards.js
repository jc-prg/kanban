// ---- Modal state ----
let modalColId      = null;
let modalMode       = 'add'; // 'add' | 'edit'
let editCardId      = null;
let selectedColor   = COLORS[0];
let selectedPriority = 0;

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
  document.getElementById('modalTitle').textContent      = 'Add Card';
  document.getElementById('modalSubmitBtn').textContent  = 'Add Card';
  renderColorRow();
  renderPriorityRow();
  document.getElementById('modal').style.display = 'flex';
  document.getElementById('cardText').focus();
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
  document.getElementById('modalTitle').textContent     = 'Edit Card';
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
