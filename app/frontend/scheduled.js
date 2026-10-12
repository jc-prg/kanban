// Scheduled-column feature: one-time and recurring card scheduling

let _showScheduled      = false;
let _schedDialogColId   = null;  // null means "new card" mode
let _schedDialogCardId  = null;  // null means creating a new card

// ---- Helpers ----------------------------------------------------------------

function _getScheduledColId() {
  return state.settings?.scheduledColumnId || null;
}

function ensureScheduledColumn() {
  if (!state.settings) state.settings = {};

  const existingId = state.settings.scheduledColumnId;
  let official = existingId ? state.columns.find(c => c.id === existingId) : null;

  // If no official column yet, adopt an existing "⏰ Scheduled" one or create fresh
  if (!official) {
    official = state.columns.find(c => c.title === '⏰ Scheduled');
    if (official) {
      state.settings.scheduledColumnId = official.id;
    } else {
      const id = uid();
      official = { id, title: '⏰ Scheduled', color: '#6b7280', cards: [] };
      state.columns.unshift(official);
      state.settings.scheduledColumnId = id;
      schedulesSave();
      return id;
    }
  }

  // Absorb any stale duplicate "⏰ Scheduled" columns into the official one
  let changed = false;
  for (let i = state.columns.length - 1; i >= 0; i--) {
    const c = state.columns[i];
    if (c.id !== official.id && c.title === '⏰ Scheduled') {
      official.cards.push(...c.cards);
      state.columns.splice(i, 1);
      changed = true;
    }
  }

  // Ensure the official column is at position 0
  const idx = state.columns.indexOf(official);
  if (idx !== 0) { state.columns.splice(idx, 1); state.columns.unshift(official); changed = true; }

  if (changed) schedulesSave();
  return official.id;
}
window.ensureScheduledColumn = ensureScheduledColumn;

function toggleScheduledColumn() {
  _showScheduled = !_showScheduled;
  if (_showScheduled) ensureScheduledColumn();
  _updateMenuBtn();
  render();
}
window.toggleScheduledColumn = toggleScheduledColumn;

function _updateMenuBtn() {
  const btn = document.getElementById('menuScheduled');
  if (btn) btn.textContent = _showScheduled ? 'Hide scheduled' : 'Scheduled cards';
  const hdrBtn = document.getElementById('schedToggleBtn');
  if (hdrBtn) hdrBtn.classList.toggle('open', _showScheduled);
}

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _populateColSelect(selectEl, selectedId) {
  const scheduledColId = _getScheduledColId();
  selectEl.innerHTML = state.columns
    .filter(c => c.id !== scheduledColId)
    .map(c => `<option value="${escHtml(c.id)}"${c.id === selectedId ? ' selected' : ''}>${escHtml(c.title)}</option>`)
    .join('');
}

function _updateModeVisibility() {
  const onetime = document.getElementById('schedModeOnetime').checked;
  document.getElementById('schedOnetimePanel').style.display = onetime ? '' : 'none';
  document.getElementById('schedRecurPanel').style.display   = onetime ? 'none' : '';
}

function _updateRecurTypeVisibility() {
  const type = document.getElementById('schedRecurType').value;
  document.getElementById('schedRecurDowRow').style.display   = type === 'weekly'                      ? '' : 'none';
  document.getElementById('schedRecurDomRow').style.display   = (type === 'monthly' || type === 'yearly') ? '' : 'none';
  document.getElementById('schedRecurMonthRow').style.display = type === 'yearly'                      ? '' : 'none';
}

// ---- Badge rendering -------------------------------------------------------

function _describeRecurrenceBrief(recurrence) {
  if (!recurrence) return '';
  const r = recurrence;
  const DOW_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (r.type === 'daily')   return r.interval > 1 ? `every ${r.interval}d` : 'daily';
  if (r.type === 'weekly') {
    const days = (r.daysOfWeek || []).map(d => DOW_LABELS[d]).join(', ');
    return r.interval > 1 ? `every ${r.interval}w ${days}`.trim() : (days ? `weekly ${days}` : 'weekly');
  }
  if (r.type === 'monthly') return r.interval > 1 ? `every ${r.interval}mo` : 'monthly';
  if (r.type === 'yearly')  return 'yearly';
  return '';
}

// First date >= fromDate that matches the recurrence (mirrors backend computeNextDueDate), or ''.
function _nextOccurrence(recurrence, startDate, endDate, fromDate) {
  if (!recurrence || !startDate) return '';
  const { type, interval = 1, daysOfWeek = [], dayOfMonth = 1, month = 1 } = recurrence;
  const DAY = 86400000;
  const startD = new Date(startDate + 'T00:00:00Z');
  // Anchor the interval cycle on the first date >= startDate that fits the rule (as in the backend)
  let anchor = startD;
  if (type === 'weekly') {
    for (let i = 0; i < 7; i++) {
      const c = new Date(startD.getTime() + i * DAY);
      if (daysOfWeek.includes(c.getUTCDay())) { anchor = c; break; }
    }
  } else if (type === 'monthly' || type === 'yearly') {
    for (let i = 0; i < 3700; i++) {
      const c = new Date(startD.getTime() + i * DAY);
      const cl = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 0)).getUTCDate();
      if (c.getUTCDate() === Math.min(dayOfMonth, cl) && (type === 'monthly' || c.getUTCMonth() + 1 === month)) { anchor = c; break; }
    }
  }
  const startWeek = anchor.getTime() - anchor.getUTCDay() * DAY;
  let d = new Date((fromDate > startDate ? fromDate : startDate) + 'T00:00:00Z');
  for (let i = 0; i < 3700 * Math.max(1, interval); i++, d = new Date(d.getTime() + DAY)) {
    const iso = d.toISOString().slice(0, 10);
    if (endDate && iso > endDate) return '';
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const lastDom = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const domOk = d.getUTCDate() === Math.min(dayOfMonth, lastDom);
    let ok = false;
    if (type === 'daily') {
      ok = Math.round((d - startD) / DAY) % interval === 0;
    } else if (type === 'weekly') {
      const wk = Math.round((d.getTime() - d.getUTCDay() * DAY - startWeek) / (7 * DAY));
      ok = daysOfWeek.includes(d.getUTCDay()) && wk % interval === 0;
    } else if (type === 'monthly') {
      const months = (y - anchor.getUTCFullYear()) * 12 + (m - 1 - anchor.getUTCMonth());
      ok = domOk && months % interval === 0;
    } else if (type === 'yearly') {
      ok = m === month && domOk && (y - anchor.getUTCFullYear()) % interval === 0;
    }
    if (ok) return iso;
  }
  return '';
}

// Date a scheduled card is next due: next occurrence for recurring cards, else the scheduled date.
function _schedSortKey(card) {
  if (!card.recurrence) return card.scheduledFor || '';
  const today = _today();
  if (card.nextDueDate && card.nextDueDate >= today) return card.nextDueDate;
  const from = card.lastCreatedDate === today ? new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10) : today;
  return _nextOccurrence(card.recurrence, card.scheduledFor, card.scheduledEndDate, from);
}

// Splits cards into one-time and recurring groups, each sorted earliest first (undated last, stable).
function sortScheduledCards(cards) {
  const byDate = (a, b) => {
    const ka = _schedSortKey(a), kb = _schedSortKey(b);
    if (ka === kb) return 0;
    if (!ka) return 1;
    if (!kb) return -1;
    return ka < kb ? -1 : 1;
  };
  return {
    oneTime:   cards.filter(c => !c.recurrence).sort(byDate),
    recurring: cards.filter(c =>  c.recurrence).sort(byDate),
  };
}
window.sortScheduledCards = sortScheduledCards;

// Recurring items: rhythm badge ("↻ every 3mo") + badge with next date and target ("5 Nov → Column")
function _recurBadgeHtml(recurrence, nextDate, targetName, disabled) {
  const rhythm = `↻ ${_describeRecurrenceBrief(recurrence)}`;
  const next   = nextDate ? fmtDate(nextDate) : (disabled ? 'disabled' : 'none');
  const target = `${next} → ${targetName}`;
  return `<span class="card-sched-badge card-sched-badge--recur" title="Recurrence: ${escHtml(rhythm)}">${escHtml(rhythm)}</span>`
       + `<span class="card-sched-badge" title="Next: ${escHtml(target)}">${escHtml(target)}</span>`;
}

function getScheduledBadgeHtml(card) {
  if (!card.scheduledFor && !card.recurrence) return '';
  const targetCol  = state.columns.find(c => c.id === card.scheduledTarget);
  const targetName = targetCol ? targetCol.title : (card.scheduledTarget ? '?' : '—');

  if (card.recurrence) return _recurBadgeHtml(card.recurrence, _schedSortKey(card), targetName, false);

  const isOverdue = card.scheduledFor < _today();
  const datePart = (isOverdue ? '⚠ ' : '') + fmtDate(card.scheduledFor);
  return `<span class="card-sched-badge" title="${escHtml(datePart)} → ${escHtml(targetName)}">${escHtml(datePart)} → ${escHtml(targetName)}</span>`;
}
window.getScheduledBadgeHtml = getScheduledBadgeHtml;

// ---- Virtual recurring task cards ------------------------------------------

// Context menu for virtual cards built from the recurring-task settings
function _showRecurringTaskMenu(e, task, editTask) {
  const schedId = state.settings?.scheduledColumnId;
  const targets = state.columns.filter(c => c.id !== schedId && c.title !== task.targetColumn);
  // Same icons as the card context menu (#contextMenu)
  const lbl = (icon, text) => `<span data-icon="${icon}">${SVGICONS[icon]()}</span>  ${text}`;
  openContextMenu(e, [
    { labelHtml: lbl('edit', 'Edit'), action: editTask },
    {
      labelHtml: lbl('duplicate', 'Duplicate'),
      action: async () => {
        const copy = JSON.parse(JSON.stringify(task));
        delete copy.id;
        copy.card.text = '(copy) ' + copy.card.text;
        copy.lastCreatedDate = null;
        copy.nextDueDate = null;
        _recurringTasks.push(copy);
        await _saveRecurringTasks();
        if (typeof renderRecurringList === 'function') renderRecurringList();
        render();
      },
    },
    {
      labelHtml: lbl('moveTo', 'Move to'),
      children: targets.map(c => ({
        label: c.title,
        action: async () => {
          task.targetColumn = c.title;
          await _saveRecurringTasks();
          if (typeof renderRecurringList === 'function') renderRecurringList();
          render();
        },
      })),
    },
    {
      labelHtml: lbl('delete', 'Delete'),
      danger: true,
      action: async () => {
        await _deleteRecurringTask(task.id);
        render();
      },
    },
  ].filter(item => !item.children || item.children.length));
}

function appendRecurringTaskCards(cardsEl) {
  if (typeof _recurringTasks === 'undefined' || !_recurringTasks.length) return;

  const divider = document.createElement('div');
  divider.className = 'sched-recur-divider';
  divider.textContent = 'Recurring tasks (settings)';
  cardsEl.appendChild(divider);

  for (const task of _recurringTasks) {
    const cardEl = document.createElement('div');
    cardEl.className = 'card card--recur-virtual';
    if (task.card.color) cardEl.style.setProperty('--card-color', task.card.color);

    const enabled = task.enabled !== false;

    cardEl.innerHTML = `
      <div class="card-body">
        <div class="card-text">${escHtml(task.card.text)}</div>
        <div class="card-meta">
          ${_recurBadgeHtml(task.recurrence, task.nextDueDate, task.targetColumn, !enabled)}
          ${!enabled ? '<span class="card-done-mark">disabled</span>' : ''}
        </div>
      </div>`;

    cardEl.title = 'Recurring task — click to edit in settings';
    const editTask = () => {
      if (typeof openRecurringForm === 'function') {
        if (typeof openSettingsDialog === 'function') openSettingsDialog('recurringSection');
        setTimeout(() => { if (typeof openRecurringForm === 'function') openRecurringForm(task); }, 150);
      }
    };
    cardEl.addEventListener('click', editTask);
    cardEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      _showRecurringTaskMenu(e, task, editTask);
    });
    cardsEl.appendChild(cardEl);
  }
}
window.appendRecurringTaskCards = appendRecurringTaskCards;

// ---- Dialog ----------------------------------------------------------------

/**
 * Open the scheduling dialog.
 * colId/cardId: existing card to schedule. Pass colId=null, cardId=null to create a new card.
 * prefillTargetId: pre-select this column as target.
 */
function openScheduleDialog(colId, cardId, prefillTargetId) {
  _schedDialogColId  = colId;
  _schedDialogCardId = cardId;

  const isNew = !cardId;
  const col   = colId ? state.columns.find(c => c.id === colId) : null;
  const card  = (!isNew && col) ? col.cards.find(c => c.id === cardId) : null;

  // Card text row — shown when creating a new card
  const textRow = document.getElementById('schedCardTextRow');
  if (textRow) textRow.style.display = isNew ? '' : 'none';
  const editBtn = document.getElementById('schedEditCardBtn');
  if (editBtn) editBtn.style.display = isNew ? 'none' : '';
  if (isNew) {
    document.getElementById('schedCardText').value = '';
    document.getElementById('schedDialogTitle').textContent = 'Schedule new card';
  } else {
    document.getElementById('schedDialogTitle').textContent = 'Schedule: ' + (card?.text || '').slice(0, 60) + ((card?.text?.length || 0) > 60 ? '…' : '');
  }

  const isRecurring = !!(card?.recurrence);
  document.getElementById('schedModeOnetime').checked   = !isRecurring;
  document.getElementById('schedModeRecurring').checked = isRecurring;

  // One-time
  document.getElementById('schedDate').value = card?.scheduledFor || _today();

  // Target selects
  const defaultTarget = prefillTargetId || card?.scheduledTarget || '';
  _populateColSelect(document.getElementById('schedTarget'),      defaultTarget);
  _populateColSelect(document.getElementById('schedRecurTarget'), defaultTarget);

  // Recurring fields
  const r = card?.recurrence || {};
  document.getElementById('schedRecurType').value        = r.type      || 'weekly';
  document.getElementById('schedRecurInterval').value    = r.interval  || 1;
  document.getElementById('schedRecurFrom').value        = card?.scheduledFor || _today();
  document.getElementById('schedRecurUntil').value       = card?.scheduledEndDate || '';
  document.getElementById('schedRecurDayOfMonth').value  = r.dayOfMonth || 1;
  document.getElementById('schedRecurMonth').value       = r.month      || 1;
  document.querySelectorAll('.sched-dow-btn').forEach(btn => {
    btn.classList.toggle('active', (r.daysOfWeek || []).includes(+btn.dataset.dow));
  });

  _updateModeVisibility();
  _updateRecurTypeVisibility();

  document.getElementById('schedDialogBackdrop').style.display = 'flex';
}
window.openScheduleDialog = openScheduleDialog;

function closeScheduleDialog() {
  document.getElementById('schedDialogBackdrop').style.display = 'none';
  _schedDialogColId  = null;
  _schedDialogCardId = null;
}
window.closeScheduleDialog = closeScheduleDialog;

function _submitScheduleDialog() {
  const isOnetime      = document.getElementById('schedModeOnetime').checked;
  const isNew          = !_schedDialogCardId;
  const scheduledColId = ensureScheduledColumn();

  let card;
  if (isNew) {
    const text = document.getElementById('schedCardText').value.trim();
    if (!text) { alert('Please enter card text.'); return; }
    // Create card directly in the scheduled column
    const schedCol = state.columns.find(c => c.id === scheduledColId);
    if (!schedCol) { closeScheduleDialog(); return; }
    card = { id: uid(), text, created: _today(), lastModified: new Date().toISOString() };
    schedCol.cards.push(card);
    _schedDialogColId  = scheduledColId;
    _schedDialogCardId = card.id;
  } else {
    const col = state.columns.find(c => c.id === _schedDialogColId);
    card = col?.cards.find(c => c.id === _schedDialogCardId);
    if (!card) { closeScheduleDialog(); return; }
  }

  if (isOnetime) {
    const scheduledFor    = document.getElementById('schedDate').value;
    const scheduledTarget = document.getElementById('schedTarget').value;
    if (!scheduledFor)    { alert('Please enter a trigger date.'); return; }
    if (!scheduledTarget) { alert('Please select a target column.'); return; }

    delete card.recurrence;
    delete card.scheduledEndDate;
    delete card.nextDueDate;
    delete card.lastCreatedDate;
    card.scheduledFor    = scheduledFor;
    card.scheduledTarget = scheduledTarget;

  } else {
    const type            = document.getElementById('schedRecurType').value;
    const interval        = Math.max(1, parseInt(document.getElementById('schedRecurInterval').value, 10) || 1);
    const from            = document.getElementById('schedRecurFrom').value;
    const until           = document.getElementById('schedRecurUntil').value;
    const scheduledTarget = document.getElementById('schedRecurTarget').value;
    if (!from)            { alert('Please enter a start date.'); return; }
    if (!scheduledTarget) { alert('Please select a target column.'); return; }

    const recurrence = { type, interval };
    if (type === 'weekly') {
      const dows = [...document.querySelectorAll('.sched-dow-btn.active')].map(b => +b.dataset.dow);
      if (dows.length === 0) { alert('Please select at least one day of the week.'); return; }
      recurrence.daysOfWeek = dows;
    } else if (type === 'monthly' || type === 'yearly') {
      recurrence.dayOfMonth = Math.max(1, parseInt(document.getElementById('schedRecurDayOfMonth').value, 10) || 1);
    }
    if (type === 'yearly') {
      recurrence.month = Math.max(1, parseInt(document.getElementById('schedRecurMonth').value, 10) || 1);
    }

    card.scheduledFor    = from;
    card.scheduledTarget = scheduledTarget;
    card.recurrence      = recurrence;
    if (until) card.scheduledEndDate = until; else delete card.scheduledEndDate;
    delete card.nextDueDate;
    delete card.lastCreatedDate;
  }

  card.lastModified = new Date().toISOString();

  const fromColId = _schedDialogColId;
  closeScheduleDialog();

  if (fromColId !== scheduledColId) {
    moveCardToColumn(fromColId, card.id, scheduledColId);
  } else {
    schedulesSave();
    render();
  }
  _showScheduled = true;
  _updateMenuBtn();
}

function removeSchedule(colId, cardId) {
  const col  = state.columns.find(c => c.id === colId);
  const card = col?.cards.find(c => c.id === cardId);
  if (!card) return;

  const targetColId    = card.scheduledTarget;
  const scheduledColId = _getScheduledColId();

  delete card.scheduledFor;
  delete card.scheduledTarget;
  delete card.recurrence;
  delete card.scheduledEndDate;
  delete card.nextDueDate;
  delete card.lastCreatedDate;
  card.lastModified = new Date().toISOString();

  const targetCol = state.columns.find(c => c.id === targetColId && c.id !== scheduledColId)
    || state.columns.find(c => c.id !== scheduledColId);

  if (targetCol) moveCardToColumn(colId, cardId, targetCol.id);
  else { render(); schedulesSave(); }
}
window.removeSchedule = removeSchedule;

// ---- DOMContentLoaded wiring -----------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const menuBtn = document.getElementById('menuScheduled');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      if (typeof hideMenu === 'function') hideMenu();
      toggleScheduledColumn();
    });
  }

  document.getElementById('schedToggleBtn')?.addEventListener('click', toggleScheduledColumn);

  document.getElementById('schedModeOnetime')?.addEventListener('change',   _updateModeVisibility);
  document.getElementById('schedModeRecurring')?.addEventListener('change',  _updateModeVisibility);
  document.getElementById('schedRecurType')?.addEventListener('change',      _updateRecurTypeVisibility);

  document.querySelectorAll('.sched-dow-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  document.getElementById('schedCancelBtn')?.addEventListener('click',  closeScheduleDialog);
  document.getElementById('schedSubmitBtn')?.addEventListener('click',  _submitScheduleDialog);
  document.getElementById('schedEditCardBtn')?.addEventListener('click', () => {
    const colId  = _schedDialogColId;
    const cardId = _schedDialogCardId;
    closeScheduleDialog();
    if (colId && cardId && typeof openEditModal === 'function') {
      const col  = state.columns.find(c => c.id === colId);
      const card = col?.cards.find(c => c.id === cardId);
      if (card) openEditModal(colId, card);
    }
  });

  document.getElementById('schedDialogBackdrop')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeScheduleDialog();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('schedDialogBackdrop')?.style.display === 'flex') {
      closeScheduleDialog();
    }
  });

  // "Open scheduled column" link in recurring section
  document.getElementById('recurringOpenScheduled')?.addEventListener('click', e => {
    e.preventDefault();
    if (typeof closeSettings === 'function') closeSettings();
    if (!_showScheduled) toggleScheduledColumn();
  });

  // Context menu wiring
  document.getElementById('ctxSchedule')?.addEventListener('click', () => {
    const colId = window._ctxColId, card = window._ctxCard;
    hideContextMenu();
    if (colId && card) openScheduleDialog(colId, card.id, colId);
  });
  document.getElementById('ctxEditSchedule')?.addEventListener('click', () => {
    const colId = window._ctxColId, card = window._ctxCard;
    hideContextMenu();
    if (colId && card) openScheduleDialog(colId, card.id);
  });
  document.getElementById('ctxRemoveSchedule')?.addEventListener('click', () => {
    const colId = window._ctxColId, card = window._ctxCard;
    hideContextMenu();
    if (colId && card) removeSchedule(colId, card.id);
  });
});
