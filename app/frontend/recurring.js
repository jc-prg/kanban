// ---- Recurring tasks (board settings) ----

let _recurringTasks = [];
let _rtEditId       = null;   // null = add mode, string = edit mode
let _rtColor        = '';
let _rtPriority     = null;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function loadRecurringTasks() {
  if (!API_BASE) return;
  try {
    const r = await fetch(`${API_BASE}/recurring-tasks`);
    if (!r.ok) return;
    const data = await r.json();
    _recurringTasks = data.tasks || [];
  } catch { /* ignore */ }
}

async function _saveRecurringTasks() {
  if (!API_BASE) return;
  try {
    const r = await fetch(`${API_BASE}/recurring-tasks`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tasks: _recurringTasks }),
    });
    const data = await r.json();
    if (data.tasks) _recurringTasks = data.tasks;  // server may update nextDueDate
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function _formatNextDue(task) {
  if (!task.enabled)     return 'disabled';
  const nd = task.nextDueDate;
  if (!nd)               return 'no future occurrence';
  const today = new Date().toISOString().slice(0, 10);
  if (nd < today)        return 'overdue';
  if (nd === today)      return 'today';
  const diff = Math.round((new Date(nd + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  if (diff === 1)        return 'tomorrow';
  if (diff < 7)         return `in ${diff} days`;
  const d = new Date(nd + 'T00:00:00Z');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const label  = `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === new Date().getUTCFullYear() ? label : `${label}, ${d.getUTCFullYear()}`;
}

function _describeRecurrence(task) {
  const r   = task.recurrence;
  const n   = r.interval || 1;
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  switch (r.type) {
    case 'daily':
      return n === 1 ? 'daily' : `every ${n} days`;
    case 'weekly': {
      const dn = (r.daysOfWeek || []).map(d => days[d]).join(', ');
      return n === 1 ? `weekly ${dn}` : `every ${n} weeks on ${dn}`;
    }
    case 'monthly':
      return n === 1 ? `monthly on day ${r.dayOfMonth}` : `every ${n} months on day ${r.dayOfMonth}`;
    case 'yearly': {
      const mns = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `yearly on ${mns[(r.month || 1) - 1]} ${r.dayOfMonth}`;
    }
    default: return r.type;
  }
}

// ---------------------------------------------------------------------------
// Render list
// ---------------------------------------------------------------------------

function renderRecurringList() {
  const list = document.getElementById('recurringList');
  if (!list) return;
  if (_recurringTasks.length === 0) {
    list.innerHTML = '<li class="settings-item-desc" style="padding:4px 0">No recurring tasks defined.</li>';
    return;
  }
  list.innerHTML = _recurringTasks.map(t => {
    const isOn = t.enabled !== false;
    const desc = _describeRecurrence(t) + ' · next: ' + _formatNextDue(t) + ' · → ' + t.targetColumn;
    return `<li class="recurring-item" data-id="${escHtml(t.id)}">
      <label class="settings-toggle recurring-toggle" title="${isOn ? 'Disable' : 'Enable'}">
        <input type="checkbox" class="recurring-toggle-chk"${isOn ? ' checked' : ''}>
        <span class="settings-toggle-track"></span>
      </label>
      <div class="recurring-item-info">
        <div class="recurring-item-text">${escHtml(t.card.text)}</div>
        <div class="recurring-item-meta">${escHtml(desc)}</div>
      </div>
      <button class="recurring-item-btn recurring-run-btn"    title="Run now">▷</button>
      <button class="recurring-item-btn recurring-edit-btn"   title="Edit">✎</button>
      <button class="recurring-item-btn recurring-delete-btn" title="Delete">✕</button>
    </li>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

function _updateRecurrenceControls() {
  const type = document.getElementById('rtType').value;
  document.getElementById('rtDaysRow').style.display      = type === 'weekly'  ? '' : 'none';
  document.getElementById('rtDayOfMonthRow').style.display = (type === 'monthly' || type === 'yearly') ? '' : 'none';
  document.getElementById('rtMonthRow').style.display     = type === 'yearly'  ? '' : 'none';

  const units = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' };
  document.getElementById('rtIntervalUnit').textContent = units[type] || 'unit(s)';
}

function _buildColorPicker() {
  const colors = ['', ...COLORS];  // '' = no color
  const row    = document.getElementById('rtColorRow');
  if (!row) return;
  row.innerHTML = colors.map(c => c
    ? `<button type="button" class="recurring-color-btn" data-color="${c}" style="background:${c}" title="${c}"></button>`
    : `<button type="button" class="recurring-color-btn recurring-color-none" data-color="" title="No color">—</button>`
  ).join('');
  row.querySelectorAll('.recurring-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _rtColor = btn.dataset.color;
      row.querySelectorAll('.recurring-color-btn').forEach(b => b.classList.remove('recurring-color-btn--selected'));
      btn.classList.add('recurring-color-btn--selected');
    });
  });
}

function _buildPriorityPicker() {
  const row = document.getElementById('rtPriorityRow');
  if (!row) return;
  row.innerHTML = [0, 1, 2, 3, 4, 5].map(p => p === 0
    ? `<button type="button" class="recurring-priority-btn" data-priority="">—</button>`
    : `<button type="button" class="recurring-priority-btn" data-priority="${p}">${p}</button>`
  ).join('');
  row.querySelectorAll('.recurring-priority-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _rtPriority = btn.dataset.priority ? parseInt(btn.dataset.priority, 10) : null;
      row.querySelectorAll('.recurring-priority-btn').forEach(b => b.classList.remove('recurring-priority-btn--selected'));
      btn.classList.add('recurring-priority-btn--selected');
    });
  });
}

function _populateColumnDropdown() {
  const sel = document.getElementById('rtTargetColumn');
  if (!sel) return;
  sel.innerHTML = (state.columns || []).map(c =>
    `<option value="${escHtml(c.title)}">${escHtml(c.title)}</option>`
  ).join('');
}

function _setColorSelected(color) {
  _rtColor = color || '';
  document.querySelectorAll('#rtColorRow .recurring-color-btn').forEach(b => {
    b.classList.toggle('recurring-color-btn--selected', b.dataset.color === _rtColor);
  });
}

function _setPrioritySelected(priority) {
  _rtPriority = priority || null;
  const val = priority ? String(priority) : '';
  document.querySelectorAll('#rtPriorityRow .recurring-priority-btn').forEach(b => {
    b.classList.toggle('recurring-priority-btn--selected', b.dataset.priority === val);
  });
}

function _setDaySelected(daysOfWeek) {
  document.querySelectorAll('#rtDaysOfWeek .recurring-day-btn').forEach(b => {
    b.classList.toggle('recurring-day-btn--selected', (daysOfWeek || []).includes(parseInt(b.dataset.day, 10)));
  });
}

function _getSelectedDays() {
  return [...document.querySelectorAll('#rtDaysOfWeek .recurring-day-btn--selected')]
    .map(b => parseInt(b.dataset.day, 10));
}

// ---------------------------------------------------------------------------
// Open / close form
// ---------------------------------------------------------------------------

function openRecurringForm(task) {
  _rtEditId = task ? task.id : null;

  // Populate columns
  _populateColumnDropdown();

  const today = new Date().toISOString().slice(0, 10);

  if (task) {
    document.getElementById('rtCardText').value         = task.card.text || '';
    document.getElementById('rtCardDesc').value         = task.card.description || '';
    document.getElementById('rtCardLink').value         = task.card.link || '';
    document.getElementById('rtTargetColumn').value     = task.targetColumn || '';
    document.getElementById('rtType').value             = task.recurrence.type || 'weekly';
    document.getElementById('rtInterval').value         = task.recurrence.interval || 1;
    document.getElementById('rtDayOfMonth').value       = task.recurrence.dayOfMonth || 1;
    document.getElementById('rtMonth').value            = task.recurrence.month || 1;
    document.getElementById('rtStartDate').value        = task.startDate || today;
    document.getElementById('rtEndDate').value          = task.endDate || '';
    _setColorSelected(task.card.color);
    _setPrioritySelected(task.card.priority);
    _setDaySelected(task.recurrence.daysOfWeek);
  } else {
    document.getElementById('rtCardText').value     = '';
    document.getElementById('rtCardDesc').value     = '';
    document.getElementById('rtCardLink').value     = '';
    document.getElementById('rtTargetColumn').selectedIndex = 0;
    document.getElementById('rtType').value         = 'weekly';
    document.getElementById('rtInterval').value     = 1;
    document.getElementById('rtDayOfMonth').value   = 1;
    document.getElementById('rtMonth').value        = '1';
    document.getElementById('rtStartDate').value    = today;
    document.getElementById('rtEndDate').value      = '';
    _setColorSelected('');
    _setPrioritySelected(null);
    _setDaySelected([1]);  // Monday by default
  }

  const errEl = document.getElementById('rtFormError');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  _updateRecurrenceControls();
  document.getElementById('recurringForm').hidden = false;
  document.getElementById('rtCardText').focus();
}

function _closeRecurringForm() {
  document.getElementById('recurringForm').hidden = true;
  _rtEditId = null;
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function _submitRecurringTask() {
  const errEl   = document.getElementById('rtFormError');
  const text    = document.getElementById('rtCardText').value.trim();
  const type    = document.getElementById('rtType').value;
  const interval = parseInt(document.getElementById('rtInterval').value, 10) || 1;
  const startDate = document.getElementById('rtStartDate').value;
  const endDate   = document.getElementById('rtEndDate').value || null;

  function showErr(msg) {
    errEl.textContent = msg; errEl.hidden = false;
  }

  if (!text)      return showErr('Card text is required.');
  if (!startDate) return showErr('Start date is required.');
  if (endDate && endDate < startDate) return showErr('End date must be on or after start date.');
  if (type === 'weekly' && _getSelectedDays().length === 0)
    return showErr('Select at least one day of the week.');

  const recurrence = { type, interval };
  if (type === 'weekly') recurrence.daysOfWeek = _getSelectedDays();
  if (type === 'monthly' || type === 'yearly') {
    recurrence.dayOfMonth = parseInt(document.getElementById('rtDayOfMonth').value, 10) || 1;
  }
  if (type === 'yearly') {
    recurrence.month = parseInt(document.getElementById('rtMonth').value, 10) || 1;
  }

  const card = { text };
  const desc = document.getElementById('rtCardDesc').value.trim();
  const link = document.getElementById('rtCardLink').value.trim();
  if (desc)       card.description = desc;
  if (_rtColor)   card.color       = _rtColor;
  if (_rtPriority) card.priority   = _rtPriority;
  if (link)       card.link        = link;

  const targetColumn = document.getElementById('rtTargetColumn').value;

  const existingTask = _rtEditId ? _recurringTasks.find(t => t.id === _rtEditId) : null;
  const task = {
    id:              _rtEditId || undefined,
    enabled:         existingTask ? existingTask.enabled : true,
    card,
    targetColumn,
    recurrence,
    startDate,
    endDate,
    lastCreatedDate: existingTask?.lastCreatedDate || null,
    nextDueDate:     existingTask?.nextDueDate     || null,
  };
  // Remove undefined id (server assigns for new tasks)
  if (!task.id) delete task.id;

  if (_rtEditId) {
    const idx = _recurringTasks.findIndex(t => t.id === _rtEditId);
    if (idx >= 0) _recurringTasks[idx] = task;
  } else {
    _recurringTasks.push(task);
  }

  await _saveRecurringTasks();
  renderRecurringList();
  _closeRecurringForm();
}

// ---------------------------------------------------------------------------
// Toggle / delete / run-now
// ---------------------------------------------------------------------------

async function _toggleRecurringTask(id) {
  const task = _recurringTasks.find(t => t.id === id);
  if (!task) return;
  task.enabled = !task.enabled;
  await _saveRecurringTasks();
  renderRecurringList();
}

async function _deleteRecurringTask(id) {
  const task = _recurringTasks.find(t => t.id === id);
  if (!task) return;
  const confirmed = await showConfirm(`Delete recurring task "${task.card.text}"?`);
  if (!confirmed) return;
  _recurringTasks = _recurringTasks.filter(t => t.id !== id);
  await _saveRecurringTasks();
  renderRecurringList();
}

async function _runTaskNow(id) {
  if (!API_BASE) return;
  const task = _recurringTasks.find(t => t.id === id);
  if (!task) return;
  try {
    const r    = await fetch(`${API_BASE}/recurring-tasks/${encodeURIComponent(id)}/run`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) {
      alert(data.error || 'Failed to run task');
      return;
    }
    if (data.created > 0) {
      await load();  // refresh board
    }
    // Reload updated nextDueDate
    await loadRecurringTasks();
    renderRecurringList();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Event wiring (runs once on DOMContentLoaded)
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const addBtn    = document.getElementById('addRecurringBtn');
  const saveBtn   = document.getElementById('rtSaveBtn');
  const cancelBtn = document.getElementById('rtCancelBtn');
  const typeEl    = document.getElementById('rtType');
  const list      = document.getElementById('recurringList');

  if (!addBtn) return;  // not on a page with recurring section

  _buildColorPicker();
  _buildPriorityPicker();

  addBtn.addEventListener('click', () => {
    if (!document.getElementById('recurringForm').hidden && _rtEditId === null) {
      _closeRecurringForm();
    } else {
      openRecurringForm(null);
    }
  });

  saveBtn.addEventListener('click', _submitRecurringTask);

  cancelBtn.addEventListener('click', _closeRecurringForm);

  typeEl.addEventListener('change', _updateRecurrenceControls);

  // Day-of-week toggle
  document.getElementById('rtDaysOfWeek').addEventListener('click', e => {
    const btn = e.target.closest('.recurring-day-btn');
    if (btn) btn.classList.toggle('recurring-day-btn--selected');
  });

  // List: toggle (change event on checkbox)
  list.addEventListener('change', e => {
    const chk = e.target.closest('.recurring-toggle-chk');
    if (!chk) return;
    const item = chk.closest('.recurring-item');
    if (item) _toggleRecurringTask(item.dataset.id);
  });

  // List: edit / delete / run
  list.addEventListener('click', e => {
    const item = e.target.closest('.recurring-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.recurring-edit-btn'))   {
      const task = _recurringTasks.find(t => t.id === id);
      if (task) openRecurringForm(task);
    }
    else if (e.target.closest('.recurring-delete-btn')) _deleteRecurringTask(id);
    else if (e.target.closest('.recurring-run-btn'))    _runTaskNow(id);
  });

  // Keyboard: Enter submits, Escape cancels
  document.getElementById('recurringForm').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      _submitRecurringTask();
    }
    if (e.key === 'Escape') _closeRecurringForm();
  });
});
