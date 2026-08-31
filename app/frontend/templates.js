// ---- Card templates (global settings) ----

let _tplEditId   = null;   // null = add mode, string = edit mode
let _tplColor    = '';
let _tplPriority = null;

// ---------------------------------------------------------------------------
// Render list
// ---------------------------------------------------------------------------

function renderTemplatesList() {
  const list = document.getElementById('templatesList');
  if (!list) return;
  if (templates.length === 0) {
    list.innerHTML = '<li class="settings-item-desc" style="padding:4px 0">No templates defined.</li>';
    return;
  }
  list.innerHTML = templates.map(t => {
    const dot = t.color
      ? `<span class="tpl-color-dot" style="background:${escHtml(t.color)}"></span>`
      : `<span class="tpl-color-dot tpl-color-dot--none"></span>`;
    const meta = [
      t.text    ? escHtml(t.text.slice(0, 40))    : '<em>no title prefill</em>',
      t.priority ? `P${t.priority}` : '',
    ].filter(Boolean).join(' · ');
    return `<li class="tpl-list-item" data-id="${escHtml(t.id)}">
      ${dot}
      <div class="tpl-item-info">
        <div class="tpl-item-name">${escHtml(t.name)}</div>
        <div class="tpl-item-meta">${meta}</div>
      </div>
      <button class="recurring-item-btn tpl-edit-btn" title="Edit">✎</button>
      <button class="recurring-item-btn tpl-delete-btn" title="Delete">${_svgDelete()}</button>
    </li>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Color / priority pickers
// ---------------------------------------------------------------------------

function _buildTplColorPicker() {
  const colors = ['', ...COLORS];
  const row    = document.getElementById('tplColorRow');
  if (!row) return;
  row.innerHTML = colors.map(c => c
    ? `<button type="button" class="recurring-color-btn" data-color="${c}" style="background:${c}" title="${c}"></button>`
    : `<button type="button" class="recurring-color-btn recurring-color-none" data-color="" title="No color">—</button>`
  ).join('');
  row.querySelectorAll('.recurring-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _tplColor = btn.dataset.color;
      row.querySelectorAll('.recurring-color-btn').forEach(b => b.classList.remove('recurring-color-btn--selected'));
      btn.classList.add('recurring-color-btn--selected');
    });
  });
}

function _buildTplPriorityPicker() {
  const row = document.getElementById('tplPriorityRow');
  if (!row) return;
  row.innerHTML = [0, 1, 2, 3, 4, 5].map(p => p === 0
    ? `<button type="button" class="recurring-priority-btn" data-priority="">—</button>`
    : `<button type="button" class="recurring-priority-btn" data-priority="${p}">${p}</button>`
  ).join('');
  row.querySelectorAll('.recurring-priority-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _tplPriority = btn.dataset.priority ? parseInt(btn.dataset.priority, 10) : null;
      row.querySelectorAll('.recurring-priority-btn').forEach(b => b.classList.remove('recurring-priority-btn--selected'));
      btn.classList.add('recurring-priority-btn--selected');
    });
  });
}

function _setTplColorSelected(color) {
  _tplColor = color || '';
  document.querySelectorAll('#tplColorRow .recurring-color-btn').forEach(b => {
    b.classList.toggle('recurring-color-btn--selected', b.dataset.color === _tplColor);
  });
}

function _setTplPrioritySelected(priority) {
  _tplPriority = priority || null;
  const val = priority ? String(priority) : '';
  document.querySelectorAll('#tplPriorityRow .recurring-priority-btn').forEach(b => {
    b.classList.toggle('recurring-priority-btn--selected', b.dataset.priority === val);
  });
}

// ---------------------------------------------------------------------------
// Open / close form
// ---------------------------------------------------------------------------

function openTemplateForm(tpl) {
  _tplEditId = tpl ? tpl.id : null;

  if (tpl) {
    document.getElementById('tplName').value = tpl.name || '';
    document.getElementById('tplText').value = tpl.text || '';
    document.getElementById('tplLink').value = tpl.link || '';
    document.getElementById('tplDesc').value = tpl.description || '';
    _setTplColorSelected(tpl.color);
    _setTplPrioritySelected(tpl.priority);
  } else {
    document.getElementById('tplName').value = '';
    document.getElementById('tplText').value = '';
    document.getElementById('tplLink').value = '';
    document.getElementById('tplDesc').value = '';
    _setTplColorSelected('');
    _setTplPrioritySelected(null);
  }

  const errEl = document.getElementById('tplFormError');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  const deleteBtn = document.getElementById('tplDeleteBtn');
  if (deleteBtn) deleteBtn.style.display = _tplEditId ? '' : 'none';

  document.getElementById('tplForm').hidden = false;
  document.getElementById('tplName').focus();
}

function _closeTplForm() {
  document.getElementById('tplForm').hidden = true;
  _tplEditId = null;
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function _submitTemplate() {
  const errEl = document.getElementById('tplFormError');
  const name  = document.getElementById('tplName').value.trim();

  function showErr(msg) { errEl.textContent = msg; errEl.hidden = false; }

  if (!name) return showErr('Template name is required.');

  const tpl = { id: _tplEditId || tplUid(), name };
  const text = document.getElementById('tplText').value.trim();
  const link = document.getElementById('tplLink').value.trim();
  const desc = document.getElementById('tplDesc').value.trim();
  if (text)        tpl.text        = text;
  if (link)        tpl.link        = link;
  if (desc)        tpl.description = desc;
  if (_tplColor)   tpl.color       = _tplColor;
  if (_tplPriority) tpl.priority   = _tplPriority;

  const updated = _tplEditId
    ? templates.map(t => t.id === _tplEditId ? tpl : t)
    : [...templates, tpl];

  await saveTemplates(updated);
  renderTemplatesList();
  _closeTplForm();
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function _deleteTemplate(id) {
  const tpl = templates.find(t => t.id === id);
  if (!tpl) return;
  const confirmed = await showConfirm(`Delete template "${tpl.name}"?`);
  if (!confirmed) return;
  await saveTemplates(templates.filter(t => t.id !== id));
  renderTemplatesList();
  _closeTplForm();
}

// ---------------------------------------------------------------------------
// Open template form pre-filled from a card (used from edit modal)
// ---------------------------------------------------------------------------

function openTemplateFormFromCard(card) {
  // Switch to Settings > Templates, then open the form
  if (typeof openSettingsDialog === 'function') openSettingsDialog('templatesSection');
  openTemplateForm(null);
  // Pre-fill from the card's fields
  document.getElementById('tplName').value = (card.text || '').slice(0, 40);
  document.getElementById('tplText').value = card.text || '';
  document.getElementById('tplLink').value = card.link || '';
  document.getElementById('tplDesc').value = card.description || '';
  _setTplColorSelected(card.color);
  _setTplPrioritySelected(card.priority);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const addBtn    = document.getElementById('templatesAddBtn');
  const saveBtn   = document.getElementById('tplSaveBtn');
  const cancelBtn = document.getElementById('tplCancelBtn');
  const deleteBtn = document.getElementById('tplDeleteBtn');
  const list      = document.getElementById('templatesList');

  if (!addBtn) return;

  _buildTplColorPicker();
  _buildTplPriorityPicker();

  addBtn.addEventListener('click', () => {
    if (!document.getElementById('tplForm').hidden && _tplEditId === null) {
      _closeTplForm();
    } else {
      openTemplateForm(null);
    }
  });

  saveBtn.addEventListener('click', _submitTemplate);
  cancelBtn.addEventListener('click', _closeTplForm);
  deleteBtn.addEventListener('click', () => { if (_tplEditId) _deleteTemplate(_tplEditId); });

  list.addEventListener('click', e => {
    const item = e.target.closest('.tpl-list-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.tpl-edit-btn')) {
      const tpl = templates.find(t => t.id === id);
      if (tpl) openTemplateForm(tpl);
    } else if (e.target.closest('.tpl-delete-btn')) {
      _deleteTemplate(id);
    }
  });

  document.getElementById('tplForm').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      _submitTemplate();
    }
    if (e.key === 'Escape') _closeTplForm();
  });
});
