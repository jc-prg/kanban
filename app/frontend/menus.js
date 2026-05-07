// ---- Card context menu ----
let ctxColId = null;
let ctxCard  = null;

function showContextMenu(x, y, colId, card) {
  ctxColId = colId;
  ctxCard  = card;

  document.getElementById('ctxDoneLabel').textContent = `  ${card.done ? 'Mark as undone' : 'Mark as done'}`;
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
  ctxColId = null;
  ctxCard  = null;
}

document.getElementById('ctxInfo').addEventListener('click', async () => {
  const card = ctxCard;
  hideContextMenu();
  if (card) openCardInfo(card);
});

document.getElementById('ctxEdit').addEventListener('click', () => {
  if (ctxColId && ctxCard) openEditModal(ctxColId, ctxCard);
  hideContextMenu();
});

document.getElementById('ctxDone').addEventListener('click', () => {
  const colId = ctxColId, card = ctxCard;
  hideContextMenu();
  if (!colId || !card) return;
  const newDone = !card.done;
  updateCardFull(colId, card.id, { ...card, done: newDone, doneAt: newDone ? new Date().toISOString() : null });
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

document.getElementById('ctxColor').addEventListener('click', e => {
  e.stopPropagation();
  const row = document.getElementById('ctxColorRow');
  if (row.style.display !== 'none') { row.style.display = 'none'; return; }
  const card = ctxCard;
  row.innerHTML = COLORS.map(c =>
    `<div class="color-swatch ctx-color-swatch${card?.color === c ? ' selected' : ''}"
          style="background:${c}" data-color="${c}"></div>`
  ).join('');
  row.querySelectorAll('.ctx-color-swatch').forEach(s => {
    s.addEventListener('click', ev => {
      ev.stopPropagation();
      const col = state.columns.find(c => c.id === ctxColId);
      const target = col?.cards.find(c => c.id === ctxCard?.id);
      if (target) { target.color = s.dataset.color; target.lastModified = new Date().toISOString(); render(); schedulesSave(); }
      hideContextMenu();
    });
  });
  row.style.display = 'flex';
});

document.getElementById('ctxDelete').addEventListener('click', async () => {
  const colId = ctxColId, card = ctxCard;
  hideContextMenu();
  if (colId && card && await showConfirm(`Delete card "${card.text}"?`, { okLabel: 'Delete', danger: true }))
    deleteCard(colId, card.id);
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

  const hideWhenCollapsed = display => ['colCtxColor','colCtxActions','colCtxClear','colCtxDelete'].forEach(id =>
    document.getElementById(id).style.display = display);
  document.querySelector('#colContextMenu .ctx-submenu-trigger').style.display = collapsed ? 'none' : '';
  hideWhenCollapsed(collapsed ? 'none' : '');

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

  const trigger = document.querySelector('#colContextMenu .ctx-submenu-trigger');
  trigger.classList.toggle('ctx-submenu-left', menuLeft + mw + 160 > window.innerWidth - edge);
  const triggerRect = trigger.getBoundingClientRect();
  trigger.classList.toggle('ctx-submenu-up', triggerRect.bottom + 260 > window.innerHeight - edge);
}

function hideColContextMenu() {
  document.getElementById('colContextMenu').style.display = 'none';
  document.getElementById('colCtxColorRow').style.display = 'none';
  document.getElementById('colCtxActionsRow').style.display = 'none';
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

document.getElementById('colCtxClear').addEventListener('click', async () => {
  const col = state.columns.find(c => c.id === ctxHeaderColId);
  hideColContextMenu();
  if (col && col.cards.length > 0 &&
      await showConfirm(`Remove all ${col.cards.length} card(s) from "${col.title}"?`, { okLabel: 'Clear', danger: true })) {
    col.cards = [];
    render();
    schedulesSave();
  }
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

  document.getElementById('menuFindCard').addEventListener('click', () => { closeMenu(); openSearch(); });
  document.getElementById('menuPrompts').addEventListener('click', () => { closeMenu(); openPromptsDialog(); });
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
