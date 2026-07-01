// ---- Card context menu ----
let ctxColId = null;
let ctxCard  = null;
let _dashCtxBoard = null; // non-null when menu triggered from the dashboard

function showContextMenu(x, y, colId, card) {
  ctxColId = colId;
  ctxCard  = card;
  _dashCtxBoard = null;

  // Restore items that showDashboardContextMenu may have hidden
  document.getElementById('ctxDuplicate').style.display = '';
  document.querySelector('#contextMenu .ctx-submenu-trigger').style.display = '';

  document.getElementById('ctxDoneLabel').textContent = `  ${card.done ? 'Mark as undone' : 'Mark as done'}`;
  document.getElementById('ctxInfo').style.display = dateEditMode ? '' : 'none';
  document.getElementById('ctxCopyLink').style.display = card.link ? '' : 'none';
  document.getElementById('ctxColorRow').style.display = 'none';

  const submenu = document.getElementById('ctxMoveSubmenu');
  submenu.innerHTML = state.columns
    .filter(c => c.id !== colId)
    .map(c => `<button class="ctx-item" data-col-id="${escHtml(c.id)}">${escHtml(c.title)}</button>`)
    .join('');
  submenu.querySelectorAll('.ctx-item').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      moveCardToColumn(ctxColId, ctxCard.id, btn.dataset.colId);
      hideContextMenu();
    });
  });

  const menu = document.getElementById('contextMenu');
  menu.style.display = 'block';
  const mw = menu.offsetWidth || 140;
  const mh = menu.offsetHeight || 100;
  const edge = 4;
  const menuLeft = Math.max(edge, Math.min(x, window.innerWidth  - mw - edge));
  const menuTop  = Math.max(edge, Math.min(y, window.innerHeight - mh - edge));
  menu.style.left = menuLeft + 'px';
  menu.style.top  = menuTop  + 'px';

  const trigger = document.querySelector('#contextMenu .ctx-submenu-trigger');
  trigger.classList.toggle('ctx-submenu-left', menuLeft + mw + 160 > window.innerWidth - edge);
  const triggerRect = trigger.getBoundingClientRect();
  trigger.classList.toggle('ctx-submenu-up', triggerRect.bottom + 260 > window.innerHeight - edge);
}

function hideContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
  document.getElementById('ctxColorRow').style.display = 'none';
  document.getElementById('ctxPriorityRow').style.display = 'none';
  _dashCtxBoard = null;
  ctxColId = null;
  ctxCard  = null;
}

function showDashboardContextMenu(x, y, board, card) {
  _dashCtxBoard = board;
  ctxColId = null;
  ctxCard  = card;

  document.getElementById('ctxDoneLabel').textContent = `  ${card.done ? 'Mark as undone' : 'Mark as done'}`;
  document.getElementById('ctxInfo').style.display = 'none';
  document.getElementById('ctxCopyLink').style.display = card.link ? '' : 'none';
  document.getElementById('ctxColorRow').style.display = 'none';
  document.getElementById('ctxPriorityRow').style.display = 'none';
  document.getElementById('ctxDuplicate').style.display = 'none';

  // Populate Move to submenu asynchronously
  const submenu = document.getElementById('ctxMoveSubmenu');
  const trigger = document.querySelector('#contextMenu .ctx-submenu-trigger');
  submenu.innerHTML = '';
  trigger.style.display = 'none';

  fetch(`/api/${encodeURIComponent(board)}/board`)
    .then(r => r.json())
    .then(data => {
      let currentColId = null;
      for (const col of data.columns) {
        if (col.cards.some(c => c.id === card.id)) { currentColId = col.id; break; }
      }
      const cols = data.columns.filter(c => c.id !== currentColId);
      if (!cols.length) return;
      submenu.innerHTML = cols
        .map(c => `<button class="ctx-item" data-col-id="${escHtml(c.id)}">${escHtml(c.title)}</button>`)
        .join('');
      submenu.querySelectorAll('.ctx-item').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const b = _dashCtxBoard, cd = ctxCard;
          hideContextMenu();
          if (b && cd && currentColId) {
            _dashMoveCard(b, cd.id, currentColId, btn.dataset.colId).then(() => _reloadCardsPanel());
          }
        });
      });
      trigger.style.display = '';
      const menu = document.getElementById('contextMenu');
      trigger.classList.toggle('ctx-submenu-left', parseFloat(menu.style.left) + (menu.offsetWidth || 140) + 160 > window.innerWidth - 4);
      trigger.classList.toggle('ctx-submenu-up', trigger.getBoundingClientRect().bottom + 260 > window.innerHeight - 4);
    })
    .catch(() => { /* leave Move to hidden */ });

  const menu = document.getElementById('contextMenu');
  menu.style.display = 'block';
  const mw = menu.offsetWidth || 140;
  const mh = menu.offsetHeight || 100;
  const edge = 4;
  menu.style.left = Math.max(edge, Math.min(x, window.innerWidth  - mw - edge)) + 'px';
  menu.style.top  = Math.max(edge, Math.min(y, window.innerHeight - mh - edge)) + 'px';
}

document.getElementById('ctxInfo').addEventListener('click', async () => {
  const card = ctxCard;
  hideContextMenu();
  if (card) openCardInfo(card);
});

document.getElementById('ctxEdit').addEventListener('click', () => {
  const board = _dashCtxBoard, colId = ctxColId, card = ctxCard;
  hideContextMenu();
  if (board && card) {
    window.location.href = `/board/${encodeURIComponent(board)}#card:${card.id}`;
  } else if (colId && card) {
    openEditModal(colId, card);
  }
});

document.getElementById('ctxDone').addEventListener('click', () => {
  const board = _dashCtxBoard, colId = ctxColId, card = ctxCard;
  hideContextMenu();
  if (!card) return;
  const newDone = !card.done;
  if (board) {
    _dashPatchCard(board, card.id, c => {
      c.done = newDone;
      if (newDone) c.doneAt = new Date().toISOString(); else delete c.doneAt;
    }).then(() => _reloadCardsPanel());
  } else if (colId) {
    updateCardFull(colId, card.id, { ...card, done: newDone, doneAt: newDone ? new Date().toISOString() : null });
  }
});

document.getElementById('ctxDuplicate').addEventListener('click', () => {
  const colId = ctxColId, card = ctxCard;
  hideContextMenu();
  if (!colId || !card) return;
  const col = state.columns.find(c => c.id === colId);
  if (!col) return;
  const idx = col.cards.findIndex(c => c.id === card.id);
  const copy = { ...JSON.parse(JSON.stringify(card)), id: uid(), text: '(copy) ' + card.text, lastModified: new Date().toISOString() };
  col.cards.splice(idx + 1, 0, copy);
  render();
  schedulesSave();
});

document.getElementById('ctxCopyLink').addEventListener('click', () => {
  const link = ctxCard?.link;
  hideContextMenu();
  if (link) navigator.clipboard.writeText(link);
});

document.getElementById('ctxColor').addEventListener('click', e => {
  e.stopPropagation();
  const row = document.getElementById('ctxColorRow');
  if (row.style.display !== 'none') { row.style.display = 'none'; return; }
  document.getElementById('ctxPriorityRow').style.display = 'none';
  const card = ctxCard;
  row.innerHTML = COLORS.map(c =>
    `<div class="color-swatch ctx-color-swatch${card?.color === c ? ' selected' : ''}"
          style="background:${c}" data-color="${c}"></div>`
  ).join('');
  row.querySelectorAll('.ctx-color-swatch').forEach(s => {
    s.addEventListener('click', ev => {
      ev.stopPropagation();
      const board = _dashCtxBoard, cardId = ctxCard?.id, color = s.dataset.color;
      if (board && cardId) {
        hideContextMenu();
        _dashPatchCard(board, cardId, c => { c.color = color; c.lastModified = new Date().toISOString(); })
          .then(() => _reloadCardsPanel());
      } else {
        const col = state.columns.find(c => c.id === ctxColId);
        const target = col?.cards.find(c => c.id === ctxCard?.id);
        if (target) { target.color = color; target.lastModified = new Date().toISOString(); render(); schedulesSave(); }
        hideContextMenu();
      }
    });
  });
  row.style.display = 'flex';
});

document.getElementById('ctxPriority').addEventListener('click', e => {
  e.stopPropagation();
  const row = document.getElementById('ctxPriorityRow');
  if (row.style.display !== 'none') { row.style.display = 'none'; return; }
  document.getElementById('ctxColorRow').style.display = 'none';
  const card = ctxCard;
  row.innerHTML = PRIORITY_LABELS.map((label, i) => {
    const color = PRIORITY_COLORS[i];
    const selected = (card?.priority ?? 0) === i;
    const style = color ? `background:${color};border-color:${color};color:#fff` : '';
    return `<button class="priority-btn${selected ? ' selected' : ''}" data-priority="${i}"
      style="${selected && color ? style : color ? `color:${color};border-color:${color}` : ''}">${escHtml(label)}</button>`;
  }).join('');
  row.querySelectorAll('.priority-btn').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const board = _dashCtxBoard, cardId = ctxCard?.id, p = parseInt(btn.dataset.priority, 10);
      if (board && cardId) {
        hideContextMenu();
        _dashPatchCard(board, cardId, c => {
          if (p === 0) delete c.priority; else c.priority = p;
          c.lastModified = new Date().toISOString();
        }).then(() => _reloadCardsPanel());
      } else {
        const col = state.columns.find(c => c.id === ctxColId);
        const target = col?.cards.find(c => c.id === ctxCard?.id);
        if (target) {
          if (p === 0) delete target.priority; else target.priority = p;
          target.lastModified = new Date().toISOString();
          render();
          schedulesSave();
        }
        hideContextMenu();
      }
    });
  });
  row.style.display = 'flex';
});

document.getElementById('ctxDelete').addEventListener('click', async () => {
  const board = _dashCtxBoard, colId = ctxColId, card = ctxCard;
  hideContextMenu();
  if (!card) return;
  if (board) {
    if (await showConfirm(`Delete card "${card.text}"?`, { okLabel: 'Delete', danger: true })) {
      await _dashDeleteCard(board, card.id);
      _reloadCardsPanel();
    }
  } else if (colId && await showConfirm(`Delete card "${card.text}"?`, { okLabel: 'Delete', danger: true })) {
    deleteCard(colId, card.id);
  }
});

// ---- Column context menu ----
let ctxHeaderColId = null;

function showColContextMenu(x, y, colId) {
  ctxHeaderColId = colId;

  const collapsed = colCollapsed.has(colId);
  const toggleIcon = document.getElementById('colCtxToggleContent').querySelector('[data-icon]');
  const toggleKey = collapsed ? 'expand' : 'collapse';
  toggleIcon.dataset.icon = toggleKey;
  toggleIcon.textContent = ICONS[toggleKey];
  document.getElementById('colCtxToggleLabel').textContent = `  ${collapsed ? 'Show content' : 'Hide content'}`;

  const hideWhenCollapsed = display => ['colCtxSettings','colCtxFilterBy','colCtxDeleteCards','colCtxPrint'].forEach(id =>
    document.getElementById(id).style.display = display);
  document.querySelector('#colContextMenu .ctx-submenu-trigger').style.display = collapsed ? 'none' : '';
  hideWhenCollapsed(collapsed ? 'none' : '');

  const col = state.columns.find(c => c.id === colId);
  const hasDuplicates = col?.cards.some(c => c.duplicate || c.text?.startsWith('(copy) '));
  document.getElementById('colCtxDeleteDuplicates').style.display = hasDuplicates ? '' : 'none';

  const dupFilterBtn = document.getElementById('colCtxFilterDuplicates');
  dupFilterBtn.style.display = hasDuplicates ? '' : 'none';
  if (hasDuplicates) {
    const isActive = colDupFilter.has(colId);
    dupFilterBtn.querySelector('[data-icon]').nextSibling.textContent = isActive ? '  ✓ Duplicates' : '  Duplicates';
  }

  const submenu = document.getElementById('colCtxMoveSubmenu');
  submenu.innerHTML = state.columns
    .filter(c => c.id !== colId)
    .map(c => `<button class="ctx-item" data-col-id="${escHtml(c.id)}">${escHtml(c.title)}</button>`)
    .join('');
  submenu.querySelectorAll('.ctx-item').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      moveAllCards(ctxHeaderColId, btn.dataset.colId);
      hideColContextMenu();
    });
  });

  const menu = document.getElementById('colContextMenu');
  menu.style.display = 'block';
  const mw = menu.offsetWidth || 160;
  const mh = menu.offsetHeight || 80;
  const edge = 4;
  const menuLeft = Math.max(edge, Math.min(x, window.innerWidth  - mw - edge));
  const menuTop  = Math.max(edge, Math.min(y, window.innerHeight - mh - edge));
  menu.style.left = menuLeft + 'px';
  menu.style.top  = menuTop  + 'px';

  document.querySelectorAll('#colContextMenu > .ctx-submenu-trigger').forEach(trigger => {
    trigger.classList.toggle('ctx-submenu-left', menuLeft + mw + 160 > window.innerWidth - edge);
    const triggerRect = trigger.getBoundingClientRect();
    trigger.classList.toggle('ctx-submenu-up', triggerRect.bottom + 260 > window.innerHeight - edge);
  });
}

function hideColContextMenu() {
  document.getElementById('colContextMenu').style.display = 'none';
  document.getElementById('colCtxColorRow').style.display = 'none';
  document.getElementById('colCtxActionsRow').style.display = 'none';
  document.getElementById('colCtxDeleteColorRow').style.display = 'none';
  document.getElementById('colCtxFilterColorRow').style.display = 'none';
  document.getElementById('colCtxFilterPriorityRow').style.display = 'none';
  ctxHeaderColId = null;
}

function moveAllCards(fromColId, toColId) {
  const fromCol = state.columns.find(c => c.id === fromColId);
  const toCol   = state.columns.find(c => c.id === toColId);
  if (!fromCol || !toCol) return;
  const _now = new Date().toISOString();
  fromCol.cards.forEach(c => {
    recordMove(c, fromCol.title, toCol.title);
    c.lastModified = _now;
  });
  toCol.cards.push(...fromCol.cards);
  fromCol.cards = [];
  render();
  schedulesSave();
}

document.getElementById('colCtxColor').addEventListener('click', e => {
  e.stopPropagation();
  const row = document.getElementById('colCtxColorRow');
  const visible = row.style.display !== 'none';
  if (visible) { row.style.display = 'none'; return; }
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  row.innerHTML = COLORS.map(c =>
    `<div class="color-swatch ctx-color-swatch${col?.color === c ? ' selected' : ''}"
          style="background:${c}" data-color="${c}"></div>`
  ).join('');
  row.querySelectorAll('.ctx-color-swatch').forEach(s => {
    s.addEventListener('click', ev => {
      ev.stopPropagation();
      const target = state.columns.find(c => c.id === ctxHeaderColId);
      if (target) { target.color = s.dataset.color; render(); schedulesSave(); }
      hideColContextMenu();
    });
  });
  row.style.display = 'flex';
});

const COL_ACTIONS = [
  { id: 'markDone',     label: 'Mark as done' },
  { id: 'markUndone',   label: 'Mark as undone' },
  { id: 'setStartDate', label: 'Set start date → today' },
  { id: 'setEndDate',   label: 'Set end date → today' },
];

document.getElementById('colCtxActions').addEventListener('click', e => {
  e.stopPropagation();
  const row = document.getElementById('colCtxActionsRow');
  if (row.style.display !== 'none') { row.style.display = 'none'; return; }

  const colId = ctxHeaderColId; // capture before any click handler can null it
  const col = state.columns.find(c => c.id === colId);
  const active = col?.actions || [];

  row.innerHTML = COL_ACTIONS.map(a =>
    `<label class="ctx-action-item${active.includes(a.id) ? ' active' : ''}">
      <input type="checkbox" data-action="${escHtml(a.id)}"${active.includes(a.id) ? ' checked' : ''}>
      <span>${escHtml(a.label)}</span>
    </label>`
  ).join('');

  // prevent label clicks from bubbling to document and closing the menu
  row.onclick = e => e.stopPropagation();

  row.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const col = state.columns.find(c => c.id === colId);
      if (!col) return;
      col.actions = col.actions || [];
      const action = cb.dataset.action;
      if (cb.checked) {
        const opposite = action === 'markDone' ? 'markUndone' : action === 'markUndone' ? 'markDone' : null;
        if (opposite) {
          col.actions = col.actions.filter(a => a !== opposite);
          const oppCb = row.querySelector(`[data-action="${opposite}"]`);
          if (oppCb) { oppCb.checked = false; oppCb.closest('.ctx-action-item').classList.remove('active'); }
        }
        if (!col.actions.includes(action)) col.actions.push(action);
        cb.closest('.ctx-action-item').classList.add('active');
      } else {
        col.actions = col.actions.filter(a => a !== action);
        cb.closest('.ctx-action-item').classList.remove('active');
      }
      if (!col.actions.length) delete col.actions;
      schedulesSave();
    });
  });

  row.style.display = 'flex';
});

document.getElementById('colCtxToggleContent').addEventListener('click', () => {
  const colId = ctxHeaderColId;
  hideColContextMenu();
  if (colCollapsed.has(colId)) colCollapsed.delete(colId);
  else colCollapsed.add(colId);
  persistCollapseState();
  render();
});

document.getElementById('colCtxFilterByColor').addEventListener('click', e => {
  e.stopPropagation();
  const colorRow = document.getElementById('colCtxFilterColorRow');
  if (colorRow.style.display !== 'none') { colorRow.style.display = 'none'; return; }
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  if (!col) return;
  const activeFilter = colColorFilter[col.id];
  const colColors = [...new Set(col.cards.map(c => c.color).filter(Boolean))];
  let html = colColors.map(c =>
    `<div class="color-swatch ctx-color-swatch${activeFilter === c ? ' selected' : ''}"
          style="background:${escHtml(c)}" data-color="${escHtml(c)}"
          title="${col.cards.filter(card => card.color === c).length} card(s)"></div>`
  ).join('');
  if (activeFilter) html += `<button class="ctx-item" id="colCtxFilterClear" style="font-size:0.72rem;padding:4px 6px;width:auto">clear</button>`;
  colorRow.innerHTML = html;
  colorRow.querySelectorAll('.ctx-color-swatch').forEach(s => {
    s.addEventListener('click', ev => {
      ev.stopPropagation();
      const colId = ctxHeaderColId;
      hideColContextMenu();
      colColorFilter[colId] = s.dataset.color;
      render();
    });
  });
  const clearBtn = colorRow.querySelector('#colCtxFilterClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      const colId = ctxHeaderColId;
      hideColContextMenu();
      delete colColorFilter[colId];
      render();
    });
  }
  colorRow.style.display = 'flex';
});

document.getElementById('colCtxFilterDuplicates').addEventListener('click', () => {
  const colId = ctxHeaderColId;
  hideColContextMenu();
  if (colDupFilter.has(colId)) colDupFilter.delete(colId);
  else colDupFilter.add(colId);
  render();
});

document.getElementById('colCtxFilterByPriority').addEventListener('click', e => {
  e.stopPropagation();
  const priorityRow = document.getElementById('colCtxFilterPriorityRow');
  if (priorityRow.style.display !== 'none') { priorityRow.style.display = 'none'; return; }
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  if (!col) return;
  const active = colPriorityFilter[col.id];
  let html = [1, 2, 3, 4, 5].map(p =>
    `<div class="ctx-priority-swatch${active === p ? ' selected' : ''}"
          style="background:${PRIORITY_COLORS[p]}" data-priority="${p}"
          title="${col.cards.filter(c => c.priority === p).length} card(s)">${PRIORITY_LABELS[p]}</div>`
  ).join('');
  if (active) html += `<button class="ctx-item" id="colCtxFilterPriorityClear" style="font-size:0.72rem;padding:4px 6px;width:auto">clear</button>`;
  priorityRow.innerHTML = html;
  priorityRow.querySelectorAll('.ctx-priority-swatch').forEach(s => {
    s.addEventListener('click', ev => {
      ev.stopPropagation();
      const colId = ctxHeaderColId;
      hideColContextMenu();
      colPriorityFilter[colId] = Number(s.dataset.priority);
      render();
    });
  });
  const clearBtn = priorityRow.querySelector('#colCtxFilterPriorityClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      const colId = ctxHeaderColId;
      hideColContextMenu();
      delete colPriorityFilter[colId];
      render();
    });
  }
  priorityRow.style.display = 'flex';
});

document.getElementById('colCtxDeleteDuplicates').addEventListener('click', async e => {
  e.stopPropagation();
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  const count = col?.cards.filter(c => c.duplicate).length || 0;
  hideColContextMenu();
  if (!col || !count) return;
  if (await showConfirm(`Delete ${count} duplicate card(s) from "${col.title}"?`, { okLabel: 'Delete', danger: true })) {
    col.cards = col.cards.filter(c => !c.duplicate);
    render();
    schedulesSave();
  }
});

document.getElementById('colCtxDeleteAll').addEventListener('click', async e => {
  e.stopPropagation();
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  hideColContextMenu();
  if (col && col.cards.length > 0 &&
      await showConfirm(`Delete all ${col.cards.length} card(s) from "${col.title}"?`, { okLabel: 'Delete', danger: true })) {
    col.cards = [];
    render();
    schedulesSave();
  }
});

document.getElementById('colCtxDeleteByColor').addEventListener('click', e => {
  e.stopPropagation();
  const colorRow = document.getElementById('colCtxDeleteColorRow');
  if (colorRow.style.display !== 'none') { colorRow.style.display = 'none'; return; }
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  if (!col) return;
  const colColors = [...new Set(col.cards.map(c => c.color).filter(Boolean))];
  if (!colColors.length) return;
  colorRow.innerHTML = colColors.map(c =>
    `<div class="color-swatch ctx-color-swatch" style="background:${escHtml(c)}" data-color="${escHtml(c)}"
          title="${col.cards.filter(card => card.color === c).length} card(s)"></div>`
  ).join('');
  colorRow.querySelectorAll('.ctx-color-swatch').forEach(s => {
    s.addEventListener('click', async ev => {
      ev.stopPropagation();
      const color = s.dataset.color;
      const colRef = state.columns.find(c => c.id === ctxHeaderColId);
      const count = colRef?.cards.filter(c => c.color === color).length || 0;
      hideColContextMenu();
      if (colRef && count > 0 &&
          await showConfirm(`Delete ${count} card(s) with this color from "${colRef.title}"?`, { okLabel: 'Delete', danger: true })) {
        colRef.cards = colRef.cards.filter(c => c.color !== color);
        render();
        schedulesSave();
      }
    });
  });
  colorRow.style.display = 'flex';
});

document.getElementById('colCtxDeleteByDate').addEventListener('click', e => {
  e.stopPropagation();
  const dateRow = document.getElementById('colCtxDeleteDateRow');
  if (dateRow.style.display !== 'none') { dateRow.style.display = 'none'; return; }
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  if (!col) return;
  dateRow.innerHTML = [1, 2, 3, 4, 5, 6].map(m =>
    `<div class="ctx-month-swatch" data-months="${m}" title="Delete cards created more than ${m} month${m > 1 ? 's' : ''} ago">${m}mo</div>`
  ).join('');
  dateRow.querySelectorAll('.ctx-month-swatch').forEach(s => {
    s.addEventListener('click', async ev => {
      ev.stopPropagation();
      const months = parseInt(s.dataset.months, 10);
      const colRef = state.columns.find(c => c.id === ctxHeaderColId);
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - months);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const includeNoDate = months === 6;
      const count = colRef?.cards.filter(c => (c.created && c.created < cutoffStr) || (includeNoDate && !c.created)).length || 0;
      hideColContextMenu();
      if (!colRef || count === 0) {
        await showConfirm(`No cards older than ${months} month${months > 1 ? 's' : ''} in "${colRef?.title}".`, { okLabel: 'OK' });
        return;
      }
      const confirmMsg = includeNoDate
        ? `Delete ${count} card(s) created more than ${months} months ago (including cards without a creation date) from "${colRef.title}"?`
        : `Delete ${count} card(s) created more than ${months} month${months > 1 ? 's' : ''} ago from "${colRef.title}"?`;
      if (await showConfirm(confirmMsg, { okLabel: 'Delete', danger: true })) {
        colRef.cards = colRef.cards.filter(c => {
          if (!c.created) return !includeNoDate;
          return c.created >= cutoffStr;
        });
        render();
        schedulesSave();
      }
    });
  });
  dateRow.style.display = 'flex';
});

document.getElementById('colCtxDelete').addEventListener('click', async () => {
  const colId = ctxHeaderColId;
  const col   = state.columns.find(c => c.id === colId);
  hideColContextMenu();
  if (!col) return;
  const msg = col.cards.length
    ? `Delete column "${col.title}" and its ${col.cards.length} card(s)?`
    : `Delete column "${col.title}"?`;
  if (await showConfirm(msg, { okLabel: 'Delete', danger: true })) deleteColumn(colId);
});

document.getElementById('colCtxPrint').addEventListener('click', () => {
  const colId = ctxHeaderColId;
  hideColContextMenu();
  printColumn(colId);
});

document.addEventListener('click', () => { hideContextMenu(); hideColContextMenu(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideContextMenu(); hideColContextMenu(); closeCardInfo(); }
});

// ---- Header menu ----
(function () {
  const btn      = document.getElementById('headerMenuBtn');
  const dropdown = document.getElementById('headerDropdown');

  function openMenu()  { dropdown.classList.add('open');    btn.classList.add('open'); }
  function closeMenu() { dropdown.classList.remove('open'); btn.classList.remove('open'); }
  function toggleMenu(e) { e.stopPropagation(); dropdown.classList.contains('open') ? closeMenu() : openMenu(); }
  window.hideMenu = closeMenu;

  btn.addEventListener('click', toggleMenu);
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  if (BOARD_NAME) {
    const menuInbox = document.getElementById('menuInbox');
    menuInbox.addEventListener('click', e => {
      e.preventDefault();
      closeMenu();
      openInboxModal(BOARD_NAME);
    });
  }

  document.getElementById('menuWebhook').addEventListener('click', async () => {
    closeMenu();
    const btn = document.getElementById('menuWebhook');
    const origText = btn.textContent;
    btn.disabled    = true;
    btn.textContent = 'Sending…';
    let msg;
    try {
      const r    = await fetch(`/api/${BOARD_NAME}/webhook/trigger`, { method: 'POST' });
      const data = await r.json();
      msg = data.ok
        ? `✓ Webhook sent successfully (HTTP ${data.status}).`
        : `✗ Webhook failed:\n${data.error || 'Unknown error'}`;
    } catch (err) {
      msg = `✗ Request error:\n${err.message}`;
    }
    btn.textContent = '';
    btn.disabled    = false;
    btn.textContent = origText;
    await showMessage(msg);
  });

  document.getElementById('menuFindCard').addEventListener('click', () => { closeMenu(); openSearch(); });
  document.getElementById('menuAnalytics').addEventListener('click', () => { closeMenu(); if (API) openAnalytics(); else openAchievementHistory(); });
document.getElementById('menuStatistics').addEventListener('click', () => { closeMenu(); openStatsDialog(); });
  document.getElementById('statsCloseBtn').addEventListener('click', () => { document.getElementById('statsBackdrop').style.display = 'none'; });
  document.getElementById('menuLogout').addEventListener('click', async () => {
    closeMenu();
    await fetch('/api/auth/logout', { method: 'POST' });
    const pwd = document.getElementById('loginPassword');
    pwd.value = '';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('loginBackdrop').style.display = 'flex';
    setTimeout(() => pwd.focus(), 50);
  });
})();
