'use strict';

// ---- Dashboard ----

let _refreshTimer   = null;
let _fetchedAtTimer = null;
let _dragCardId     = null;
let _dragCardGroup  = null;
let _dragCardBoard  = null;
let _mailCtxAccountId = null;
let _mailCtxMsgId     = null;
let _mailCtxUnread    = false;
let _dashAchOffset  = 0;

// Map: accountId → folders array (cached per session)
const _folderCache = new Map();
// Recent folders per account, loaded from server on init and updated on move
let _serverRecentFolders = {};

// Map: cardId → { card, board } — populated on each render for context menu
const _dashCardMap      = new Map();
const _collapsedGroups  = new Set(); // keyed by "board\0column"
const _seededGroups     = new Set(); // groups already seeded from config
let _dashRecentLimit    = 10;

const _PANEL_FAILED  = '<p class="dashboard-empty">Failed to load.</p>';

const _DASH_STATE_KEY = 'dash-group-state';
function _loadGroupState() {
  try {
    const navType = performance.getEntriesByType?.('navigation')[0]?.type;
    if (navType === 'reload') { localStorage.removeItem(_DASH_STATE_KEY); return; }
    const stored = JSON.parse(localStorage.getItem(_DASH_STATE_KEY));
    if (stored && typeof stored === 'object') {
      for (const [key, collapsed] of Object.entries(stored)) {
        _seededGroups.add(key);          // skip config seeding for stored groups
        if (collapsed) _collapsedGroups.add(key);
      }
    }
  } catch { /* ignore */ }
}
function _persistGroupState(key, collapsed) {
  try {
    const stored = JSON.parse(localStorage.getItem(_DASH_STATE_KEY)) || {};
    stored[key] = collapsed;
    localStorage.setItem(_DASH_STATE_KEY, JSON.stringify(stored));
  } catch { /* ignore */ }
}
_loadGroupState();
// Map: "accountId\0uid" → event object — populated on each calendar render for instant detail view
const _calEventMap      = new Map();
// Map: accountId → current lookahead days (persisted in localStorage across reloads)
const _calLookahead     = new Map();
const _CAL_LOOKAHEAD_KEY = 'cal-lookahead';
(function _loadCalLookahead() {
  try {
    const navType = performance.getEntriesByType?.('navigation')[0]?.type;
    if (navType === 'reload') { localStorage.removeItem(_CAL_LOOKAHEAD_KEY); return; }
    const stored = JSON.parse(localStorage.getItem(_CAL_LOOKAHEAD_KEY));
    if (stored && typeof stored === 'object') {
      for (const [k, v] of Object.entries(stored)) {
        if (typeof v === 'number' && v > 0) _calLookahead.set(k, v);
      }
    }
  } catch { /* ignore */ }
})();
function _setCalLookahead(accountId, days) {
  _calLookahead.set(accountId, days);
  try {
    const obj = Object.fromEntries(_calLookahead);
    localStorage.setItem(_CAL_LOOKAHEAD_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}
// Dashboard config: default timezone for new calendar events
let _defaultTimezone    = '';
// Raw calendar account configs from /api/dashboard/config — used to build per-account fetch URLs
let _calAccountsConfig  = [];
/// Calendar display mode: true = grouped per account, false = unified chronological
let _calGrouped         = true;
// Cards display mode: true = grouped by board, false = flat list
let _cardGrouped        = true;
// Last-rendered accounts lists; used by panel header context menus
let _cardSourcesMeta    = [];   // unique boards from last-rendered card sources
let _mailAccountsMeta   = [];
let _calAccountsMeta    = [];
// Calendar event modal state
let _calModalMode   = 'create'; // 'create' | 'edit'
let _calModalAccId  = null;
let _calModalUid    = null;
let _calModalEtag   = null;
let _calModalHref   = null;

async function _dashPatchCard(board, cardId, patchFn) {
  const data = await fetch(`/api/${encodeURIComponent(board)}/board`).then(r => r.json());
  let foundCol = null;
  for (const col of data.columns) {
    const card = col.cards.find(c => c.id === cardId);
    if (card) { patchFn(card); foundCol = col; break; }
  }
  if (!foundCol) return;
  await fetch(`/api/${encodeURIComponent(board)}/board`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updatedColumns: [foundCol] }),
  });
}

async function _dashDeleteCard(board, cardId) {
  const data = await fetch(`/api/${encodeURIComponent(board)}/board`).then(r => r.json());
  let foundCol = null;
  for (const col of data.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx >= 0) { col.cards.splice(idx, 1); foundCol = col; break; }
  }
  if (!foundCol) return;
  await fetch(`/api/${encodeURIComponent(board)}/board`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updatedColumns: [foundCol] }),
  });
}

async function _dashMoveCardCrossGroup(board, cardId, fromColTitle, toColTitle, newToColOrder) {
  try {
    const data = await fetch(`/api/${encodeURIComponent(board)}/board`).then(r => r.json());
    const fromCol = data.columns.find(c => c.title === fromColTitle);
    const toCol   = data.columns.find(c => c.title === toColTitle);
    if (!fromCol || !toCol) return;
    const cardIdx = fromCol.cards.findIndex(c => c.id === cardId);
    if (cardIdx < 0) return;
    const [movedCard] = fromCol.cards.splice(cardIdx, 1);
    movedCard.moves = [...(movedCard.moves || []), { at: new Date().toISOString(), from: fromCol.title, to: toCol.title }];
    const actions = toCol.actions || [];
    const today = new Date().toISOString().slice(0, 10);
    if (actions.includes('markDone'))     { movedCard.done = true;  movedCard.doneAt = new Date().toISOString(); }
    if (actions.includes('markUndone'))   { movedCard.done = false; delete movedCard.doneAt; }
    if (actions.includes('setStartDate')) movedCard.startDate = today;
    if (actions.includes('setEndDate'))   movedCard.endDate   = today;
    const byId = new Map(toCol.cards.map(c => [c.id, c]));
    byId.set(cardId, movedCard);
    toCol.cards = [
      ...newToColOrder.map(id => byId.get(id)).filter(Boolean),
      ...toCol.cards.filter(c => !newToColOrder.includes(c.id)),
    ];
    await fetch(`/api/${encodeURIComponent(board)}/board`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedColumns: [fromCol, toCol] }),
    });
  } catch { /* ignore */ }
}

async function _dashMoveCard(board, cardId, fromColId, toColId) {
  const data = await fetch(`/api/${encodeURIComponent(board)}/board`).then(r => r.json());
  let fromCol = null, toCol = null;
  for (const col of data.columns) {
    if (col.id === fromColId) fromCol = col;
    if (col.id === toColId)   toCol   = col;
  }
  if (!fromCol || !toCol) return;
  const idx = fromCol.cards.findIndex(c => c.id === cardId);
  if (idx < 0) return;
  const [movedCard] = fromCol.cards.splice(idx, 1);
  movedCard.moves = [...(movedCard.moves || []), { at: new Date().toISOString(), from: fromCol.title, to: toCol.title }];
  const actions = toCol.actions || [];
  const today = new Date().toISOString().slice(0, 10);
  if (actions.includes('markDone'))    { movedCard.done = true;  movedCard.doneAt = new Date().toISOString(); }
  if (actions.includes('markUndone'))  { movedCard.done = false; delete movedCard.doneAt; }
  if (actions.includes('setStartDate')) movedCard.startDate = today;
  if (actions.includes('setEndDate'))   movedCard.endDate   = today;
  toCol.cards.unshift(movedCard);
  await fetch(`/api/${encodeURIComponent(board)}/board`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updatedColumns: [fromCol, toCol] }),
  });
}

function applyDashboardPanelVisibility(cfg) {
  const panels = [
    { id: 'dashboardBoardsPanel',   visible: cfg.panelBoards   !== false },
    { id: 'dashboardCardsPanel',    visible: cfg.panelCards    !== false },
    { id: 'dashboardMailPanel',     visible: cfg.panelMail     !== false },
    { id: 'dashboardCalendarPanel', visible: cfg.panelCalendar !== false },
  ];
  let visible = 0;
  for (const { id, visible: show } of panels) {
    document.getElementById(id).closest('.dashboard-panel').style.display = show ? '' : 'none';
    if (show) visible++;
  }
  document.querySelector('.dashboard-grid').style.setProperty('--dash-panel-count', visible || 1);
}

async function _dashReorderColumn(board, columnTitle, newCardIdOrder) {
  try {
    const data = await fetch(`/api/${encodeURIComponent(board)}/board`).then(r => r.json());
    const col = data.columns.find(c => c.title === columnTitle);
    if (!col) return;
    const byId = new Map(col.cards.map(c => [c.id, c]));
    col.cards = [
      ...newCardIdOrder.map(id => byId.get(id)).filter(Boolean),
      ...col.cards.filter(c => !newCardIdOrder.includes(c.id)),
    ];
    await fetch(`/api/${encodeURIComponent(board)}/board`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedColumns: [col] }),
    });
  } catch { /* ignore */ }
}

function _initCardsDragDrop() {
  const panel = document.getElementById('dashboardCardsPanel');

  panel.addEventListener('dragstart', e => {
    const card = e.target.closest('.dashboard-card-item[data-card-id]');
    if (!card) return;
    _dragCardId    = card.dataset.cardId;
    _dragCardGroup = card.closest('.dashboard-card-group');
    _dragCardBoard = _dragCardGroup.dataset.board;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => card.classList.add('dragging'), 0);
  });

  panel.addEventListener('dragend', () => {
    panel.querySelectorAll('.dashboard-card-item.dragging').forEach(el => el.classList.remove('dragging'));
    panel.querySelectorAll('.dash-drop-indicator').forEach(el => el.remove());
    panel.querySelectorAll('.dashboard-group-header--drag-over').forEach(el => el.classList.remove('dashboard-group-header--drag-over'));
    _dragCardId    = null;
    _dragCardGroup = null;
    _dragCardBoard = null;
  });

  panel.addEventListener('dragover', e => {
    if (!_dragCardId) return;
    const header = e.target.closest('.dashboard-group-header');
    const card   = !header && e.target.closest('.dashboard-card-item[data-card-id]');
    const group  = header
      ? header.closest('.dashboard-card-group')
      : card
        ? card.closest('.dashboard-card-group')
        : e.target.closest('.dashboard-card-group');
    if (!group || group.dataset.board !== _dragCardBoard) return;
    if (card && card.dataset.cardId === _dragCardId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    panel.querySelectorAll('.dash-drop-indicator').forEach(el => el.remove());
    panel.querySelectorAll('.dashboard-group-header--drag-over').forEach(el => el.classList.remove('dashboard-group-header--drag-over'));
    const ind = document.createElement('div');
    ind.className = 'dash-drop-indicator';
    if (header) {
      header.classList.add('dashboard-group-header--drag-over');
      header.after(ind);
    } else if (card) {
      const rect   = card.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      if (before) card.before(ind); else card.after(ind);
    } else {
      group.appendChild(ind);
    }
  });

  panel.addEventListener('drop', e => {
    e.preventDefault();
    panel.querySelectorAll('.dashboard-group-header--drag-over').forEach(el => el.classList.remove('dashboard-group-header--drag-over'));
    const ind = panel.querySelector('.dash-drop-indicator');
    if (!ind || !_dragCardId || !_dragCardGroup) { ind?.remove(); return; }
    const targetGroup = ind.closest('.dashboard-card-group');
    if (!targetGroup) { ind.remove(); return; }
    const src = _dragCardGroup.querySelector(`.dashboard-card-item[data-card-id="${_dragCardId}"]`);
    if (!src) { ind.remove(); return; }
    ind.replaceWith(src);
    // Expand target group if it was collapsed
    if (targetGroup.classList.contains('dashboard-card-group--collapsed')) {
      const key = `${targetGroup.dataset.board}\0${targetGroup.dataset.column}`;
      _collapsedGroups.delete(key);
      targetGroup.classList.remove('dashboard-card-group--collapsed');
      _persistGroupState(key, false);
    }
    if (targetGroup === _dragCardGroup) {
      const newOrder = [..._dragCardGroup.querySelectorAll('.dashboard-card-item[data-card-id]')]
        .map(el => el.dataset.cardId);
      _dashReorderColumn(_dragCardGroup.dataset.board, _dragCardGroup.dataset.column, newOrder);
    } else {
      const newToColOrder = [...targetGroup.querySelectorAll('.dashboard-card-item[data-card-id]')]
        .map(el => el.dataset.cardId);
      _dashMoveCardCrossGroup(
        _dragCardBoard,
        _dragCardId,
        _dragCardGroup.dataset.column,
        targetGroup.dataset.column,
        newToColOrder,
      );
    }
  });
}

async function initDashboard() {
  document.querySelector('.board-area').style.display = 'none';
  document.getElementById('saveIndicator').style.display = 'none';
  document.getElementById('dashboardFetchedAt').style.display = '';
  document.querySelector('.header-menu').style.marginLeft = 'auto';
  document.getElementById('dashboard').style.display = 'flex';

  // Show board-switch wrap (headerHomeBtn) and refresh button for navigation
  document.getElementById('boardSwitchWrap').style.display = '';
  document.getElementById('dashboardRefreshBtn').style.display = '';

  // Match overview menu: hide board-specific items; Inbox/Analyze/Settings stay visible
  ['menuWebhook', 'menuDashboardSettings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.getElementById('dashboardRefreshBtn').addEventListener('click', loadDashboard);
  document.getElementById('dashCardsMenuBtn').addEventListener('click', e => {
    e.stopPropagation();
    const boards = _cardSourcesMeta;
    const items  = [];
    if (boards.length === 1) {
      items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open board`, action: () => window.open(`/board/${encodeURIComponent(boards[0])}`, '_blank', 'noopener,noreferrer') });
    } else if (boards.length > 1) {
      items.push({
        labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open board`,
        action:    () => window.open(`/board/${encodeURIComponent(boards[0])}`, '_blank', 'noopener,noreferrer'),
        children:  boards.map(b => ({ label: b, action: () => window.open(`/board/${encodeURIComponent(b)}`, '_blank', 'noopener,noreferrer') })),
      });
    }
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.sync()}</span>Reload`, action: () => _reloadCardsPanel() });
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Edit sources`, action: () => openSettingsDialog('card-sources') });
    openContextMenu(e, items);
  });
  document.getElementById('dashMailMenuBtn').addEventListener('click', e => {
    e.stopPropagation();
    const accounts = _mailAccountsMeta;
    const urlAccs  = accounts.filter(a => a.webInterfaceUrl);
    const items    = [];
    if (urlAccs.length === 1) {
      items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open webmail`, action: () => window.open(urlAccs[0].webInterfaceUrl, '_blank', 'noopener,noreferrer') });
    } else if (urlAccs.length > 1) {
      items.push({
        labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open webmail`,
        action:    () => window.open(urlAccs[0].webInterfaceUrl, '_blank', 'noopener,noreferrer'),
        children:  urlAccs.map(a => ({ label: a.label || a.accountId, action: () => window.open(a.webInterfaceUrl, '_blank', 'noopener,noreferrer') })),
      });
    }
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.sync()}</span>Reload`, action: () => _reloadMailPanel() });
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Edit accounts`, action: () => openSettingsDialog('mail-accounts') });
    openContextMenu(e, items);
  });
  document.getElementById('dashCalendarMenuBtn').addEventListener('click', e => {
    e.stopPropagation();
    const accounts = _calAccountsMeta;
    const caldavAccs = accounts.filter(a => (a.type || 'caldav') !== 'ical-url');
    const urlAccs    = accounts.filter(a => a.webInterfaceUrl);
    const items = [];
    if (caldavAccs.length === 1) {
      items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.create()}</span>New event`, action: () => openCalEventModal(caldavAccs[0].accountId, null, caldavAccs[0]) });
    } else if (caldavAccs.length > 1) {
      items.push({
        labelHtml: `<span class="ctx-icon">${SVGICONS.create()}</span>New event`,
        action:    () => openCalEventModal(caldavAccs[0].accountId, null, caldavAccs[0]),
        children: caldavAccs.map(a => ({ label: a.label || a.accountId, action: () => openCalEventModal(a.accountId, null, a) })),
      });
    }
    if (urlAccs.length === 1) {
      items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open calendar`, action: () => window.open(urlAccs[0].webInterfaceUrl, '_blank', 'noopener,noreferrer') });
    } else if (urlAccs.length > 1) {
      items.push({
        labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open calendar`,
        action:    () => window.open(urlAccs[0].webInterfaceUrl, '_blank', 'noopener,noreferrer'),
        children:  urlAccs.map(a => ({ label: a.label || a.accountId, action: () => window.open(a.webInterfaceUrl, '_blank', 'noopener,noreferrer') })),
      });
    }
    const lookaheads = accounts.map(a => _calLookahead.get(a.accountId) ?? (a.lookaheadDays || 7));
    const minDays = lookaheads.length ? Math.min(...lookaheads) : 7;
    items.push(
      { labelHtml: `<span class="ctx-icon">+1</span>week (now: ${minDays} days)`,  action: () => _loadMoreCalEventsAll(7) },
      { labelHtml: `<span class="ctx-icon">+1</span>month (now: ${minDays} days)`, action: () => _loadMoreCalEventsAll(30) },
      { labelHtml: `<span class="ctx-icon">${SVGICONS.sync()}</span>Reload`, action: () => _fetchCalendarData().then(_renderCalendarPanel).catch(() => { document.getElementById('dashboardCalendarPanel').innerHTML = _PANEL_FAILED; }) },
      { labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Edit accounts`, action: () => openSettingsDialog('calendar-accounts') },
    );
    openContextMenu(e, items);
  });
  document.getElementById('dashboardDetailClose').addEventListener('click', _closeDetail);
  document.getElementById('dashboardDetailFsBtn').addEventListener('click', () => {
    document.querySelector('#dashboardDetail .modal').classList.toggle('modal--fullscreen');
  });

  // Calendar event click → detail panel (skipped on touch; handled by touchend below)
  document.getElementById('dashboardCalendarPanel').addEventListener('click', e => {
    const item = e.target.closest('[data-uid]');
    if (!item) return;
    if (lastInputWasTouch) return;
    _openEventDetail(item.dataset.accountId, item.dataset.uid, item.dataset.webUrl || '');
  });

  // Calendar event right-click → context menu
  document.getElementById('dashboardCalendarPanel').addEventListener('contextmenu', e => {
    const item = e.target.closest('[data-uid]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    _showCalEventContextMenu(e, item.dataset.accountId, item.dataset.uid, item.dataset.webUrl || '');
  });

  // Calendar event touch: single tap → open detail, double tap → context menu
  { let _calTap = null; let _calTouchMoved = false;
    const _calPanel = document.getElementById('dashboardCalendarPanel');
    _calPanel.addEventListener('touchstart', () => { _calTouchMoved = false; }, { passive: true });
    _calPanel.addEventListener('touchmove',  () => { _calTouchMoved = true;  }, { passive: true });
    _calPanel.addEventListener('touchend', e => {
      if (_calTouchMoved) return;
      const item = e.target.closest('[data-uid]');
      if (!item) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      if (_calTap && _calTap.el === item) {
        clearTimeout(_calTap.timer);
        _calTap = null;
        _showCalEventContextMenu({ clientX: t.clientX, clientY: t.clientY },
          item.dataset.accountId, item.dataset.uid, item.dataset.webUrl || '');
      } else {
        clearTimeout(_calTap?.timer);
        _calTap = { el: item, timer: setTimeout(() => {
          _calTap = null;
          _openEventDetail(item.dataset.accountId, item.dataset.uid, item.dataset.webUrl || '');
        }, 280) };
      }
    }, { passive: false }); }

  // Mail message click → detail panel (skipped on touch; handled by touchend below)
  document.getElementById('dashboardMailPanel').addEventListener('click', e => {
    const item = e.target.closest('[data-msg-id]');
    if (!item) return;
    if (lastInputWasTouch) return;
    _openMailDetail(item.dataset.accountId, item.dataset.msgId, item.dataset.webUrl || '');
  });

  // Mail message right-click → mail context menu
  document.getElementById('dashboardMailPanel').addEventListener('contextmenu', e => {
    const item = e.target.closest('[data-msg-id]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    _showMailContextMenu(e.clientX, e.clientY, item.dataset.accountId, item.dataset.msgId, item.dataset.unread === '1', item.dataset.webUrl || '');
  });

  // Mail message touch: single tap → open detail, double tap → context menu
  { let _mailTap = null; let _mailTouchMoved = false;
    const _mailPanel = document.getElementById('dashboardMailPanel');
    _mailPanel.addEventListener('touchstart', () => { _mailTouchMoved = false; }, { passive: true });
    _mailPanel.addEventListener('touchmove',  () => { _mailTouchMoved = true;  }, { passive: true });
    _mailPanel.addEventListener('touchend', e => {
      if (_mailTouchMoved) return;
      const item = e.target.closest('[data-msg-id]');
      if (!item) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      if (_mailTap && _mailTap.el === item) {
        clearTimeout(_mailTap.timer);
        _mailTap = null;
        _showMailContextMenu(t.clientX, t.clientY, item.dataset.accountId, item.dataset.msgId, item.dataset.unread === '1', item.dataset.webUrl || '');
      } else {
        clearTimeout(_mailTap?.timer);
        _mailTap = { el: item, timer: setTimeout(() => {
          _mailTap = null;
          _openMailDetail(item.dataset.accountId, item.dataset.msgId, item.dataset.webUrl || '');
        }, 280) };
      }
    }, { passive: false }); }

  // Card click → open detail panel (skipped on touch; handled by touchend below)
  document.getElementById('dashboardCardsPanel').addEventListener('click', e => {
    const item = e.target.closest('[data-card-id]');
    if (!item) return;
    if (lastInputWasTouch) return;
    const entry = _dashCardMap.get(item.dataset.cardId);
    if (!entry) return;
    _openCardDetail(entry.board, entry.card);
  });

  // Card right-click → card context menu (same as on the board)
  document.getElementById('dashboardCardsPanel').addEventListener('contextmenu', e => {
    const item = e.target.closest('[data-card-id]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const entry = _dashCardMap.get(item.dataset.cardId);
    if (!entry) return;
    showDashboardContextMenu(e.clientX, e.clientY, entry.board, entry.card);
  });

  // Card touch: single tap → open detail panel, double tap → context menu
  { let _cardTap = null; let _cardTouchMoved = false;
    const _cardsPanel = document.getElementById('dashboardCardsPanel');
    _cardsPanel.addEventListener('touchstart', () => { _cardTouchMoved = false; }, { passive: true });
    _cardsPanel.addEventListener('touchmove',  () => { _cardTouchMoved = true;  }, { passive: true });
    _cardsPanel.addEventListener('touchend', e => {
      if (_cardTouchMoved) return;
      const item = e.target.closest('[data-card-id]');
      if (!item) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      const entry = _dashCardMap.get(item.dataset.cardId);
      if (!entry) return;
      if (_cardTap && _cardTap.el === item) {
        clearTimeout(_cardTap.timer);
        _cardTap = null;
        showDashboardContextMenu(t.clientX, t.clientY, entry.board, entry.card);
      } else {
        clearTimeout(_cardTap?.timer);
        _cardTap = { el: item, timer: setTimeout(() => {
          _cardTap = null;
          _openCardDetail(entry.board, entry.card);
        }, 280) };
      }
    }, { passive: false }); }

  // Card group collapse toggle
  document.getElementById('dashboardCardsPanel').addEventListener('click', e => {
    const hdr = e.target.closest('.dashboard-group-header--collapsible');
    if (!hdr || e.target.closest('a')) return;
    const key   = `${hdr.dataset.board}\0${hdr.dataset.column}`;
    const group = hdr.closest('.dashboard-card-group');
    if (_collapsedGroups.has(key)) {
      _collapsedGroups.delete(key);
      group.classList.remove('dashboard-card-group--collapsed');
      _persistGroupState(key, false);
    } else {
      _collapsedGroups.add(key);
      group.classList.add('dashboard-card-group--collapsed');
      _persistGroupState(key, true);
    }
  });

  // Card group header right-click context menu
  document.getElementById('dashboardCardsPanel').addEventListener('contextmenu', e => {
    const hdr = e.target.closest('.dashboard-group-header--collapsible');
    if (!hdr) return;
    e.preventDefault();
    const board  = hdr.dataset.board;
    const column = hdr.dataset.column;
    const key    = `${board}\0${column}`;
    const isCollapsed = _collapsedGroups.has(key);
    openContextMenu(e, [
      {
        labelHtml: `<span class="ctx-icon">${ICONS[isCollapsed ? 'expand' : 'collapse']}</span>${isCollapsed ? 'Open' : 'Close'}`,
        action: () => {
          const group = document.querySelector(`.dashboard-card-group[data-board="${CSS.escape(board)}"][data-column="${CSS.escape(column)}"]`);
          if (!group) return;
          if (_collapsedGroups.has(key)) {
            _collapsedGroups.delete(key);
            group.classList.remove('dashboard-card-group--collapsed');
            _persistGroupState(key, false);
          } else {
            _collapsedGroups.add(key);
            group.classList.add('dashboard-card-group--collapsed');
            _persistGroupState(key, true);
          }
        },
      },
      {
        labelHtml: `<span class="ctx-icon">${SVGICONS.create()}</span>Add card`,
        action: () => openInboxModal(board, null, null, column),
      },
    ]);
  });

  // Board item right-click context menu
  document.getElementById('dashboardBoardsPanel').addEventListener('contextmenu', e => {
    const item = e.target.closest('.dashboard-board-item');
    if (!item) return;
    e.preventDefault();
    const name = decodeURIComponent(item.href.split('/board/')[1] || '');
    if (!name) return;
    openContextMenu(e, [
      {
        labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open board`,
        action: () => { window.location.href = `/board/${encodeURIComponent(name)}`; },
      },
      {
        labelHtml: `<span class="ctx-icon">${ICONS.moreOptions}</span>Board settings`,
        action: () => { window.location.href = `/board/${encodeURIComponent(name)}#settings`; },
      },
    ]);
  });

  // Mobile accordion: clicking a panel header opens it and closes others
  const _dashPanels = document.querySelectorAll('.dashboard-grid .dashboard-panel');
  _dashPanels.forEach(panel => {
    panel.querySelector('.dashboard-panel-header').addEventListener('click', () => {
      const isOpen = panel.classList.contains('dashboard-panel--open');
      _dashPanels.forEach(p => p.classList.remove('dashboard-panel--open'));
      if (!isOpen) panel.classList.add('dashboard-panel--open');
    });
  });
  // Default: Boards panel open (only has visual effect on mobile)
  document.getElementById('dashboardBoardsPanel').closest('.dashboard-panel').classList.add('dashboard-panel--open');

  // Fetch config + recent folders in parallel before loading any data
  try {
    const [cfg, recentFolders] = await Promise.all([
      fetch('/api/dashboard/config').then(r => r.json()),
      fetch('/api/dashboard/mail-recent-folders').then(r => r.ok ? r.json() : {}).catch(() => {}),
    ]);
    applyDashboardPanelVisibility(cfg);
    _dashRecentLimit       = cfg.recentLimit || 10;
    _defaultTimezone       = cfg.defaultTimezone || '';
    _calGrouped            = cfg.calendarGrouped !== false;
    _cardGrouped           = cfg.cardGrouped !== false;
    _calAccountsConfig     = cfg.calendarAccounts || [];
    _serverRecentFolders   = recentFolders || {};
    if (cfg.autoRefreshMs > 0) {
      _refreshTimer = setInterval(loadDashboard, cfg.autoRefreshMs);
    }
    window.addEventListener('pagehide', () => { clearInterval(_refreshTimer); }, { once: true });
  } catch { /* ignore */ }

  _initCardsDragDrop();
  await loadDashboard();
}

async function _reloadPanel(url, renderFn, panelId) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed');
    renderFn(await res.json());
  } catch {
    document.getElementById(panelId).innerHTML = _PANEL_FAILED;
  }
}

function _reloadCardsPanel() { return _reloadPanel('/api/dashboard/cards', _renderCardsPanel, 'dashboardCardsPanel'); }
function _reloadMailPanel()  { return _reloadPanel('/api/dashboard/mail',  _renderMailPanel,  'dashboardMailPanel');  }

function _panelShown(id) {
  return document.getElementById(id).closest('.dashboard-panel').style.display !== 'none';
}

async function _fetchCalendarData() {
  if (!_calLookahead.size || !_calAccountsConfig.length) {
    const r = await fetch('/api/dashboard/calendar');
    if (!r.ok) throw new Error();
    return r.json();
  }
  const settled = await Promise.allSettled(
    _calAccountsConfig.map(acc => {
      const days = _calLookahead.get(acc.id) ?? (acc.lookaheadDays || 7);
      return fetch(`/api/dashboard/calendar/${encodeURIComponent(acc.id)}?days=${days}`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error('Failed')))
        .then(data => ({
          accountId: acc.id, label: acc.label, type: acc.type || 'caldav',
          color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null,
          lookaheadDays: acc.lookaheadDays || 7,
          ...data,
        }));
    })
  );
  return settled.map((r, i) => {
    const acc = _calAccountsConfig[i];
    const base = { accountId: acc.id, label: acc.label, type: acc.type || 'caldav', color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null };
    return r.status === 'fulfilled' ? r.value : { ...base, events: [], error: r.reason?.message || 'Failed to load' };
  });
}

async function loadDashboard() {
  const fetchedAt = document.getElementById('dashboardFetchedAt');
  clearTimeout(_fetchedAtTimer);
  fetchedAt.classList.add('show');
  fetchedAt.textContent = 'Loading\u2026';
  const loadingHtml = '<p class="dashboard-loading">Loading\u2026</p>';

  const showBoards   = _panelShown('dashboardBoardsPanel');
  const showCards    = _panelShown('dashboardCardsPanel');
  const showMail     = _panelShown('dashboardMailPanel');
  const showCalendar = _panelShown('dashboardCalendarPanel');

  if (showBoards)   { document.getElementById('dashboardBoardsPanel').innerHTML = loadingHtml;   document.getElementById('dashBoardsCount').textContent   = ''; }
  if (showCards)    { document.getElementById('dashboardCardsPanel').innerHTML = loadingHtml;     document.getElementById('dashCardsCount').textContent     = ''; }
  if (showMail)     { document.getElementById('dashboardMailPanel').innerHTML = loadingHtml;      document.getElementById('dashMailCount').textContent      = ''; }
  if (showCalendar) { document.getElementById('dashboardCalendarPanel').innerHTML = loadingHtml;  document.getElementById('dashCalendarCount').textContent  = ''; }

  const resolved = await Promise.all([
    showBoards   ? Promise.all([
      fetch('/api/boards').then(r => { if (!r.ok) throw new Error(); return r.json(); }),
      (() => { const d = new Date(); d.setDate(d.getDate() + _dashAchOffset); return fetch(`/api/achievements/today?date=${d.toISOString().slice(0,10)}`).then(r => r.ok ? r.json() : null).catch(() => null); })(),
    ]).then(([d, a]) => _renderBoardsPanel(d, a).then(() => true)).catch(() => { document.getElementById('dashboardBoardsPanel').innerHTML = _PANEL_FAILED; return false; }) : true,
    showCards    ? fetch('/api/dashboard/cards').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { _renderCardsPanel(d);    return true; }).catch(() => { document.getElementById('dashboardCardsPanel').innerHTML    = _PANEL_FAILED; return false; }) : true,
    showMail     ? fetch('/api/dashboard/mail').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { _renderMailPanel(d);     return true; }).catch(() => { document.getElementById('dashboardMailPanel').innerHTML     = _PANEL_FAILED; return false; }) : true,
    showCalendar ? _fetchCalendarData().then(d => { _renderCalendarPanel(d); return true; }).catch(() => { document.getElementById('dashboardCalendarPanel').innerHTML = _PANEL_FAILED; return false; }) : true,
  ]);

  const anyError = resolved.some((ok, i) => !ok && [showBoards, showCards, showMail, showCalendar][i]);
  fetchedAt.textContent = (anyError ? 'Partial load \u2014 ' : 'Refreshed at ') +
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  _fetchedAtTimer = setTimeout(() => fetchedAt.classList.remove('show'), 10000);
}

function _boardItemHtml(b) {
  const { name, description, columnBadges = [] } = b;
  const badges = columnBadges.filter(b => b.count > 0).map(b => {
    if (b.type === 'inbox')      return `<span class="board-card-count board-card-count-inbox">inbox ${b.count}</span>`;
    if (b.type === 'todo')       return `<span class="board-card-count board-card-count-todo">todo ${b.count}</span>`;
    if (b.type === 'inprogress') return `<span class="board-card-count board-card-count-inprogress">doing ${b.count}</span>`;
    const style = b.color ? `background:${b.color}22;color:${b.color}` : '';
    return `<span class="board-card-count board-card-count-tracked" style="${style}">${escHtml(b.title)} ${b.count}</span>`;
  }).join('');
  return `<a class="dashboard-board-item" href="/board/${encodeURIComponent(name)}">
    <div class="board-card-info">
      <span class="board-card-name">${escHtml(name)}</span>
      ${description ? `<span class="board-card-desc">${escHtml(description)}</span>` : ''}
      ${badges ? `<div class="board-card-counts">${badges}</div>` : ''}
    </div>
    <span class="board-card-arrow">\u2192</span>
  </a>`;
}

function _dashAchDateLabel(offset) {
  if (offset === 0)  return 'Today';
  if (offset === -1) return 'Yesterday';
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function _renderDashAchTiles(data, offset) {
  const section = document.getElementById('dashAchSection');
  if (!section) return;
  const { done = 0, moved = 0, created = 0, inboxCreated = 0,
          doneCards = [], movedCards = [], createdCards = [], inboxCreatedCards = [],
          hasPast = false } = data || {};

  document.getElementById('dashAchLabel').textContent = _dashAchDateLabel(offset);
  document.getElementById('dashAchPrev').disabled   = !hasPast;
  document.getElementById('dashAchNext').disabled   = offset >= 0;
  document.getElementById('dashAchToday').style.display = offset < 0 ? '' : 'none';

  if (done + moved + created === 0 && offset === 0) { section.style.display = 'none'; return; }
  section.style.display = '';

  const _tip = cards => {
    const lines = cards.slice(0, 8).map(({ board, text }) => {
      const short = text.length > 35 ? text.slice(0, 35) + '\u2026' : text;
      return `${board}: ${short}`;
    });
    if (cards.length > 8) lines.push(`${cards.length - 8} further cards \u2026`);
    return lines.join('\n');
  };
  const _tile = (value, label, cls, cards) => {
    const tip = cards.length ? ` data-tooltip="${escHtml(_tip(cards))}"` : '';
    return `<div class="achievement-item ${cls}"${tip}><span class="achievement-value">${value}</span><span class="achievement-label">${label}</span></div>`;
  };
  document.getElementById('dashAchTiles').innerHTML = `<div class="dashboard-achievement-tiles">
    ${_tile(inboxCreated,           'cards<br>inbox',   'dash-ach--inbox',   inboxCreatedCards)}
    ${_tile(created - inboxCreated, 'cards<br>created', 'dash-ach--created', createdCards)}
    ${_tile(moved,                  'cards<br>moved',   'dash-ach--moved',   movedCards)}
    ${_tile(done,                   'cards<br>done',    'dash-ach--done',    doneCards)}
  </div>`;
}

async function _loadDashAchievements(offset) {
  _dashAchOffset = offset;
  const d = new Date();
  d.setDate(d.getDate() + offset);
  try {
    const res = await fetch(`/api/achievements/today?date=${d.toISOString().slice(0, 10)}`);
    _renderDashAchTiles(res.ok ? await res.json() : {}, offset);
  } catch { /* ignore */ }
}

function _fmtRecentDate(at) {
  if (!at) return '';
  if (at.length <= 10) {
    const [y, m, d] = at.split('-');
    return `${d}.${m}.${y.slice(2)}`;
  }
  const d = new Date(at);
  if (isNaN(d)) return at.slice(0, 10);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `yesterday`;
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.`;
}

function _recentItemHtml(item) {
  const href = item.type === 'note'
    ? `/board/${encodeURIComponent(item.board)}#note:${encodeURIComponent(item.id)}`
    : `/board/${encodeURIComponent(item.board)}`;
  const icon = item.type === 'note' ? SVGICONS.notePages(10, 10) : SVGICONS.card(14, 10);
  const color = item.type === 'note' ? COLORS_NEUTRAL[0] : (item.color || '');
  const colorStyle = color ? ` style="--card-color:${escHtml(color)}"` : '';
  const contextLabel = item.type === 'note' ? escHtml(item.board) : `${escHtml(item.board)} \xb7 ${escHtml(item.context)}`;
  const metaHtml = `<div class="card-meta"><span class="dashboard-recent-icon">${icon}</span><span class="dashboard-recent-context">${contextLabel}</span><span class="card-date">${escHtml(_fmtRecentDate(item.at))}</span></div>`;
  return `<a class="dashboard-recent-item card" href="${href}"${colorStyle}>
    <div class="card-body">
      <div class="card-text">${escHtml(item.title)}</div>
      ${metaHtml}
    </div>
  </a>`;
}

async function _renderBoardsPanel(boards, achievements) {
  const panel = document.getElementById('dashboardBoardsPanel');
  const active   = boards.filter(b => !b.archived);
  const archived = boards.filter(b =>  b.archived);
  document.getElementById('dashBoardsCount').textContent = active.length || '';

  let html = '<div class="dashboard-group-header">Active boards</div>';
  html += active.length
    ? active.map(_boardItemHtml).join('')
    : '<p class="dashboard-empty">No boards yet.</p>';

  html += `<div id="dashAchSection" style="display:none;margin-top:10px">
    <div class="dashboard-group-header dash-ach-header">
      <span id="dashAchLabel">Today</span>
      <span class="dash-ach-nav">
        <button id="dashAchToday" class="ach-nav-btn" style="display:none" title="Jump to today"></button>
        <button id="dashAchPrev" class="ach-nav-btn" title="Previous day">&#8249;</button>
        <button id="dashAchNext" class="ach-nav-btn" disabled title="Next day">&#8250;</button>
      </span>
    </div>
    <div id="dashAchTiles"></div>
  </div>`;

  html += `<button class="dashboard-boards-archived-btn" aria-expanded="false">
    Create board<span class="dashboard-boards-chevron">\u203A</span>
  </button>
  <div class="dashboard-boards-archived-list" style="display:none">
    <div class="dash-new-board-inner">
      <div class="new-board-row">
        <input id="dashNewBoardInput" class="new-board-input" type="text" placeholder="my-board" maxlength="64" spellcheck="false" autocomplete="off">
        <button id="dashNewBoardBtn" class="btn btn-accent">+&nbsp;new</button>
      </div>
      <p id="dashNewBoardError" class="new-board-error" style="display:none"></p>
    </div>
  </div>`;

  if (archived.length) {
    html += `<button class="dashboard-boards-archived-btn" aria-expanded="false">
      Archived boards<span class="dash-group-right"><span class="column-count">${archived.length}</span><span class="dashboard-boards-chevron">\u203A</span></span>
    </button>`;
    html += `<div class="dashboard-boards-archived-list" style="display:none">${archived.map(_boardItemHtml).join('')}</div>`;
  }

  const recent = await fetch(`/api/dashboard/recent?limit=${_dashRecentLimit}`).then(r => r.ok ? r.json() : []).catch(() => []);
  html += `<button class="dashboard-boards-archived-btn" aria-expanded="false">
    Last edited<span class="dash-group-right"><span class="column-count">${recent.length}</span><span class="dashboard-boards-chevron">\u203A</span></span>
  </button>`;
  html += `<div class="dashboard-boards-archived-list" style="display:none">${recent.length ? recent.map(_recentItemHtml).join('') : '<p class="dashboard-empty">No items yet.</p>'}</div>`;

  panel.innerHTML = html;

  document.getElementById('dashAchToday').innerHTML = SVGICONS.sync(10, 10);

  document.getElementById('dashNewBoardBtn').addEventListener('click', async () => {
    const input = document.getElementById('dashNewBoardInput');
    const errEl = document.getElementById('dashNewBoardError');
    const name  = input.value.trim().toLowerCase();
    errEl.style.display = 'none';
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      errEl.textContent = 'Use only lowercase letters, digits and hyphens.';
      errEl.style.display = '';
      return;
    }
    if (name === 'inbox') {
      errEl.textContent = '"inbox" is a reserved name.';
      errEl.style.display = '';
      return;
    }
    try {
      const r    = await fetch(`/api/boards/${encodeURIComponent(name)}`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) { errEl.textContent = data.error || 'Failed to create board.'; errEl.style.display = ''; return; }
      window.location.href = `/board/${name}`;
    } catch {
      errEl.textContent = 'Failed to create board.'; errEl.style.display = '';
    }
  });
  document.getElementById('dashNewBoardInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('dashNewBoardBtn').click();
  });

  _renderDashAchTiles(achievements, _dashAchOffset);

  document.getElementById('dashAchPrev').addEventListener('click',  () => _loadDashAchievements(_dashAchOffset - 1));
  document.getElementById('dashAchNext').addEventListener('click',  () => _loadDashAchievements(_dashAchOffset + 1));
  document.getElementById('dashAchToday').addEventListener('click', () => _loadDashAchievements(0));

  panel.querySelectorAll('.dashboard-boards-archived-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      const list    = this.nextElementSibling;
      const chevron = this.querySelector('.dashboard-boards-chevron');
      const isOpen  = list.style.display !== 'none';
      list.style.display      = isOpen ? 'none' : '';
      chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
      this.setAttribute('aria-expanded', String(!isOpen));
    });
  });
}

function _renderCardsPanel(groups) {
  const panel   = document.getElementById('dashboardCardsPanel');
  const menuBtn = document.getElementById('dashCardsMenuBtn');
  _dashCardMap.clear();
  const total = groups.reduce((s, g) => s + (g.cards?.filter(c => !c.text?.startsWith('#')).length || 0), 0);
  document.getElementById('dashCardsCount').textContent = total || '';
  _cardSourcesMeta = [...new Set(groups.filter(g => !g.error).map(g => g.board))];
  menuBtn.style.display = groups.length ? '' : 'none';
  if (!groups.length) {
    panel.innerHTML = '<p class="dashboard-empty">No card sources configured.</p>';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const warnD = new Date(); warnD.setDate(warnD.getDate() + 2);
  const warnDate = warnD.toISOString().slice(0, 10);

  function renderOneGroup(group) {
    if (group.error) {
      return `<div class="dashboard-source-error">\u26a0 ${escHtml(group.board)}: ${escHtml(group.error)}</div>`;
    }
    const groupKey   = `${group.board}\0${group.column}`;
    if (!_seededGroups.has(groupKey)) {
      _seededGroups.add(groupKey);
      if (group.initiallyCollapsed) {
        _collapsedGroups.add(groupKey);
        _persistGroupState(groupKey, true);
      }
    }
    const collapsed     = _collapsedGroups.has(groupKey);
    const visibleCards  = group.cards.filter(c => !c.text?.startsWith('#'));
    const cardCount     = visibleCards.length;
    const hasOverdue    = visibleCards.some(c => !c.done && c.endDate && c.endDate < today);
    const hasWarning    = !hasOverdue && visibleCards.some(c => !c.done && c.endDate && c.endDate >= today && c.endDate <= warnDate);
    const countClass    = hasOverdue ? ' dash-group-count--overdue' : hasWarning ? ' dash-group-count--warning' : '';
    const headerLabel   = _cardGrouped
      ? `\xb7 ${escHtml(group.column)}`
      : `<a class="dashboard-group-board-link" href="/board/${encodeURIComponent(group.board)}">${escHtml(group.board)}</a> \xb7 ${escHtml(group.column)}`;
    const groupHeader =
      `<div class="dashboard-group-header dashboard-group-header--collapsible" data-board="${escHtml(group.board)}" data-column="${escHtml(group.column)}">` +
      headerLabel +
      `<span class="dash-group-right"><span class="column-count dash-group-count${countClass}">${cardCount}</span><span class="dashboard-boards-chevron">\u203a</span></span></div>`;
    const collapsedClass = collapsed ? ' dashboard-card-group--collapsed' : '';
    const groupAttrs = `class="dashboard-card-group${collapsedClass}" data-board="${escHtml(group.board)}" data-column="${escHtml(group.column)}"`;
    if (!group.cards.length) {
      return `<div ${groupAttrs}>${groupHeader}<p class="dashboard-empty">No cards.</p></div>`;
    }
    const items = group.cards.map(card => {
      _dashCardMap.set(card.id, { card, board: group.board });
      const isLabel   = (card.text || '').startsWith('#');
      const isOverdue = !isLabel && card.endDate && card.endDate < today && !card.done;
      const isWarning = !isLabel && !isOverdue && card.endDate && card.endDate >= today && card.endDate <= warnDate && !card.done;
      const colorStyle = card.color ? ` style="--card-color:${escHtml(card.color)}"` : '';

      if (isLabel) {
        const displayText = card.text.slice(1).trimStart();
        return `<div class="dashboard-card-item card card--label" draggable="true"
            data-card-id="${escHtml(card.id || '')}" data-board="${escHtml(group.board)}"${colorStyle}>
          <div class="card-body">
            <div class="card-label-text">${escHtml(displayText)}</div>
          </div>
        </div>`;
      }

      const metaParts = [];
      if (card.priority) {
        const pc = PRIORITY_COLORS[card.priority];
        metaParts.push(`<span class="priority-badge" style="background:${pc}22;color:${pc}">${PRIORITY_LABELS[card.priority]}</span>`);
      }
      if (card.description) {
        metaParts.push(`<span class="card-desc" title="Has description">${SVGICONS.description()}</span>`);
      }
      if (card.hasLinkedNotes) {
        metaParts.push(`<span class="card-note-badge" title="Linked in notes">${SVGICONS.noteDoc(9, 11)}</span>`);
      }
      if (card.startDate || card.endDate) {
        const cls = 'card-date' + (isOverdue ? ' card-date--overdue' : isWarning ? ' card-date--warning' : '');
        if (card.startDate && card.endDate)
          metaParts.push(`<span class="${cls}">${fmtDate(card.startDate)} \u2192 ${fmtDate(card.endDate)}</span>`);
        else if (card.startDate)
          metaParts.push(`<span class="${cls}">${fmtDate(card.startDate)} \u2192</span>`);
        else
          metaParts.push(`<span class="${cls}">\u2192 ${fmtDate(card.endDate)}</span>`);
      }
      if (card.done) {
        metaParts.push(`<span class="card-done-mark">${ICONS.done} done</span>`);
      }
      if (card.link) {
        const safeLinkHref = safeLink(card.link);
        if (safeLinkHref) metaParts.push(getLinkBadgeHtml(card.link, safeLinkHref));
      }
      const metaHtml = metaParts.length ? `<div class="card-meta">${metaParts.join('')}</div>` : '';

      return `<div class="dashboard-card-item card${card.done ? ' card--done' : ''}${isOverdue ? ' card--overdue' : ''}" draggable="true"
          data-card-id="${escHtml(card.id || '')}" data-board="${escHtml(group.board)}"${colorStyle}>
        <div class="card-body">
          <div class="card-text">${escHtml(card.text || '')}</div>
          ${metaHtml}
        </div>
      </div>`;
    }).join('');
    return `<div ${groupAttrs}>${groupHeader}${items}</div>`;
  }

  if (_cardGrouped) {
    const boardMap = new Map();
    groups.forEach(g => {
      if (!boardMap.has(g.board)) boardMap.set(g.board, []);
      boardMap.get(g.board).push(g);
    });
    panel.innerHTML = [...boardMap.entries()].map(([board, bGroups]) => {
      const boardHeader = `<div class="dashboard-group-header dashboard-group-header--board">` +
        `<a class="dashboard-group-board-link" href="/board/${encodeURIComponent(board)}">${escHtml(board)}</a></div>`;
      return `<div class="dashboard-board-group">${boardHeader}${bGroups.map(renderOneGroup).join('')}</div>`;
    }).join('');
  } else {
    panel.innerHTML = groups.map(renderOneGroup).join('');
  }
}

function _renderMailPanel(accounts) {
  const panel   = document.getElementById('dashboardMailPanel');
  const menuBtn = document.getElementById('dashMailMenuBtn');
  const total   = accounts.reduce((s, a) => s + (a.messages?.length || 0), 0);
  document.getElementById('dashMailCount').textContent = total || '';

  _mailAccountsMeta = accounts;
  menuBtn.style.display = accounts.length ? '' : 'none';

  if (!accounts.length) {
    panel.innerHTML = '<p class="dashboard-empty">No mail accounts configured.</p>';
    return;
  }

  panel.innerHTML = accounts.map(acc => {
    const header = `<div class="dashboard-group-header">${escHtml(acc.label)}</div>`;

    if (acc.error) {
      return header + `<div class="dashboard-source-error">\u26a0 ${escHtml(acc.error)}</div>`;
    }
    if (!acc.messages?.length) {
      return header + '<p class="dashboard-empty">No messages.</p>';
    }

    const colorStyle = acc.color ? ` style="--card-color:${escHtml(acc.color)}"` : '';
    const items = acc.messages.map(msg => {
      const dateStr = msg.date ? (() => {
        const d   = new Date(msg.date);
        const now = new Date();
        const hh  = String(d.getHours()).padStart(2, '0');
        const mi  = String(d.getMinutes()).padStart(2, '0');
        const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        if (isToday) return `${hh}:${mi}`;
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}.${mm}. ${hh}:${mi}`;
      })() : '';
      const fromStr = msg.from ? (msg.from.match(/^(.+?)\s*<[^>]+>$/) || [])[1]?.trim() || msg.from : '';
      const metaParts = [];
      if (msg.hasAttachments) metaParts.push(`<span class="dashboard-mail-attach" title="Has attachments">${_svgAttachment(11, 11)}</span>`);
      if (fromStr) metaParts.push(`<span class="dashboard-mail-from">${escHtml(fromStr)}</span>`);
      if (dateStr) metaParts.push(`<span class="card-date">${escHtml(dateStr)}</span>`);
      const metaHtml = metaParts.length ? `<div class="card-meta">${metaParts.join('')}</div>` : '';
      return `<div class="dashboard-mail-item card"${colorStyle}
          data-account-id="${escHtml(acc.accountId)}" data-msg-id="${escHtml(msg.id)}" data-unread="${msg.unread ? '1' : '0'}" data-web-url="${escHtml(acc.webInterfaceUrl || '')}">
        <div class="card-body">
          <div class="card-text">${msg.unread ? `<strong>${escHtml(msg.subject)}</strong>` : escHtml(msg.subject)}</div>
          ${metaHtml}
        </div>
      </div>`;
    }).join('');

    return header + items;
  }).join('');
}

function _splitAddresses(str) {
  const parts = [];
  let current = '', inQuote = false, inAngle = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if      (c === '"')                      { inQuote = !inQuote; current += c; }
    else if (c === '<')                      { inAngle = true;     current += c; }
    else if (c === '>')                      { inAngle = false;    current += c; }
    else if (c === ',' && !inQuote && !inAngle) {
      parts.push(current.trim()); current = '';
      if (str[i + 1] === ' ') i++;
    } else { current += c; }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function _fmtAddress(addr) {
  const m = addr.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (m) return `<a href="mailto:${escHtml(m[2].trim())}">${escHtml(m[1].trim())}</a>`;
  if (addr.includes('@')) return `<a href="mailto:${escHtml(addr)}">${escHtml(addr)}</a>`;
  return escHtml(addr);
}

function _foldAddresses(str) {
  const addrs = _splitAddresses(str).map(_fmtAddress);
  if (addrs.length <= 3) return addrs.join(', ');
  const shown  = addrs.slice(0, 3).join(', ');
  const hidden = addrs.slice(3).join(', ');
  return `${shown}<span class="dash-addr-ellipsis">, \u2026</span><span class="dash-addr-rest" hidden>, ${hidden}</span> <a href="#" class="dash-addr-toggle">more</a>`;
}

function _openMailDetail(accountId, msgId, webUrl) {
  const detail    = document.getElementById('dashboardDetail');
  const body      = document.getElementById('dashboardDetailBody');
  const webUrlBtn = document.getElementById('dashboardDetailWebUrl');
  document.getElementById('dashboardDetailEditBtn').style.display = 'none';
  document.getElementById('dashboardDetailTitle').textContent = 'Loading\u2026';
  body.innerHTML = '';
  if (webUrl) {
    webUrlBtn.href = webUrl;
    webUrlBtn.title = 'Open in Webmail';
    webUrlBtn.style.display = '';
  } else {
    webUrlBtn.style.display = 'none';
  }
  detail.style.display = '';
  { const modal = detail.querySelector('.modal');
    const maxH  = modal.offsetHeight;
    modal.style.height    = 'auto';
    modal.style.minHeight = '450px';
    modal.style.maxHeight = maxH + 'px'; }

  fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}`)
    .then(r => r.ok ? r.json() : null)
    .then(msg => {
      if (!msg) { body.innerHTML = '<p class="dashboard-empty">Message not found.</p>'; return; }
      document.getElementById('dashboardDetailTitle').textContent = msg.subject;

      const rows = [];
      if (msg.from)    rows.push(['From',    _foldAddresses(msg.from)]);
      if (msg.to)      rows.push(['To',      _foldAddresses(msg.to)]);
      if (msg.cc)      rows.push(['Cc',      _foldAddresses(msg.cc)]);
      if (msg.date)    rows.push(['Date',    escHtml(new Date(msg.date).toLocaleString())]);
      if (msg.attachments?.length) {
        const base = `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}/attachment/`;
        const links = msg.attachments.map(a =>
          `<a href="${escHtml(base + encodeURIComponent(a.part))}" download="${escHtml(a.name)}" class="dash-attachment-link">${escHtml(a.name)}</a>`
        ).join('');
        rows.push(['Attachments', links]);
      }

      body.innerHTML = `<table class="dashboard-detail-table">${
        rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
      }</table>`;

      body.querySelectorAll('.dash-addr-toggle').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const rest     = a.previousElementSibling;
          const ellipsis = rest.previousElementSibling;
          rest.hidden     = !rest.hidden;
          ellipsis.hidden = !ellipsis.hidden;
          a.textContent = rest.hidden ? 'more' : 'less';
        });
      });

      if (msg.bodyHtml) {
        const iframe = document.createElement('iframe');
        iframe.className = 'dashboard-mail-iframe';
        // allow-same-origin lets us write content and read scrollHeight;
        // scripts are still blocked (no allow-scripts), so this is safe.
        iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox allow-same-origin');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        body.appendChild(iframe);
        const baseStyle = 'body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#222;background:white;padding:8px;margin:0;word-break:break-word}'
          + ' a{color:#4f46e5} img{max-width:100%;height:auto}'
          + ' blockquote{border-left:3px solid #ddd;margin:8px 0;padding:0 12px;color:#555}'
          + ' pre,code{font-family:monospace;font-size:0.88em;background:#f0f0f0;padding:2px 5px;border-radius:3px}';
        const { emailStyles, bodyClass } = (() => {
          try {
            const parsed = new DOMParser().parseFromString(msg.bodyHtml, 'text/html');
            return {
              emailStyles: [...parsed.querySelectorAll('style')].map(s => s.textContent).join('\n'),
              bodyClass:   parsed.body.className || '',
            };
          } catch { return { emailStyles: '', bodyClass: '' }; }
        })();
        const safeHtml    = DOMPurify.sanitize(msg.bodyHtml, { FORCE_BODY: true });
        const emailStyleTag = emailStyles ? `<style>${emailStyles}</style>` : '';
        const bodyAttr    = bodyClass ? ` class="${bodyClass.replace(/"/g, '&quot;')}"` : '';
        iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${baseStyle}</style>${emailStyleTag}</head><body${bodyAttr}>${safeHtml}</body></html>`;
        const resize = () => { iframe.style.height = (iframe.contentDocument.body.scrollHeight + 16) + 'px'; };
        iframe.addEventListener('load', resize);
      } else if (msg.body) {
        const pre = document.createElement('pre');
        pre.className = 'dashboard-mail-body';
        pre.textContent = msg.body;
        body.appendChild(pre);
      }

    })
    .catch(() => { body.innerHTML = '<p class="dashboard-empty">Failed to load message.</p>'; });
}

function _calDayGroupsHtml(events, accColor, accAccountId, accWebUrl, maxDay) {
  const todayStr    = new Date().toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  function _dayLabel(dateStr) {
    if (dateStr === todayStr)    return 'Today';
    if (dateStr === tomorrowStr) return 'Tomorrow';
    return new Date(dateStr).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function _fmtTime(ev, dayStr) {
    if (ev.allDay) return '';
    if (dayStr !== (ev.start || '').slice(0, 10)) return 'continues';
    try {
      const startStr = new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (!ev.end) return startStr;
      const endStr = new Date(ev.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `${startStr} \u2013 ${endStr}`;
    } catch { return ''; }
  }

  const groups = new Map();
  // All-day events first within each day, then by start time
  const sorted = [...events].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (a.start || '').localeCompare(b.start || '');
  });
  for (const ev of sorted) {
    const startDay = (ev.start || '').slice(0, 10);
    if (!startDay) continue;
    let endDay = startDay;
    if (ev.end) {
      const endDateStr = ev.end.slice(0, 10);
      if (ev.allDay) {
        const d = new Date(endDateStr + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        endDay = d.toISOString().slice(0, 10);
      } else {
        endDay = endDateStr;
      }
    }
    const effectiveStart = startDay < todayStr ? todayStr : startDay;
    const effectiveEnd = maxDay && endDay > maxDay ? maxDay : endDay;
    let cur = new Date(effectiveStart + 'T00:00:00Z');
    const last = new Date(effectiveEnd + 'T00:00:00Z');
    while (cur <= last) {
      const dayStr = cur.toISOString().slice(0, 10);
      if (!groups.has(dayStr)) groups.set(dayStr, []);
      groups.get(dayStr).push(ev);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  const now = new Date();
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayStr, evs]) => {
      const header = `<div class="dashboard-group-header">${escHtml(_dayLabel(dayStr))}</div>`;
      const items = evs.map(ev => {
        const isPast      = ev.end && new Date(ev.end) < now;
        const evColor     = ev._color     || accColor;
        const evAccountId = ev._accountId || accAccountId;
        const evWebUrl    = ev._webUrl    || accWebUrl;
        const colorStyle  = evColor ? ` style="--card-color:${escHtml(evColor)}"` : '';
        const evStartDay  = (ev.start || '').slice(0, 10);
        let evEndDay = evStartDay;
        if (ev.end) {
          const endDateStr = ev.end.slice(0, 10);
          if (ev.allDay) {
            const d = new Date(endDateStr + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() - 1);
            evEndDay = d.toISOString().slice(0, 10);
          } else {
            evEndDay = endDateStr;
          }
        }
        const isMultiday = evStartDay && evEndDay && evStartDay !== evEndDay;
        const metaText   = isMultiday
          ? `${fmtDate(evStartDay)} \u2192 ${fmtDate(evEndDay)}`
          : _fmtTime(ev, dayStr);
        // All-day events: show date range as tooltip, keep the element single-line
        const tooltipAttr = ev.allDay && metaText ? ` title="${escHtml(metaText)}"` : '';
        const timeHtml    = (!ev.allDay && metaText) ? `<div class="card-meta"><span class="card-date">${escHtml(metaText)}</span></div>` : '';
        return `<div class="dashboard-event-item card${isPast ? ' card--done' : ''}${ev.allDay ? ' cal-event--allday' : ''}${ev._provisional ? ' cal-event--provisional' : ''}" data-account-id="${escHtml(evAccountId)}" data-uid="${escHtml(ev.uid)}" data-web-url="${escHtml(evWebUrl || '')}"${colorStyle}${tooltipAttr}>
          <div class="card-body"><div class="card-text">${escHtml(ev.title)}</div>${timeHtml}</div>
        </div>`;
      }).join('');
      return header + items;
    }).join('');
}

function _renderCalendarPanel(accounts) {
  const panel   = document.getElementById('dashboardCalendarPanel');
  const menuBtn = document.getElementById('dashCalendarMenuBtn');
  const total   = accounts.reduce((s, a) => s + (a.events?.length || 0), 0);
  document.getElementById('dashCalendarCount').textContent = total || '';

  _calAccountsMeta = accounts;

  if (!accounts.length) {
    panel.innerHTML = '<p class="dashboard-empty">No calendar accounts configured.</p>';
    menuBtn.style.display = 'none';
    return;
  }

  // Tag all events in _calEventMap (needed in both modes for the detail panel)
  _calEventMap.clear();
  for (const acc of accounts) {
    for (const ev of (acc.events || [])) {
      _calEventMap.set(`${acc.accountId}\0${ev.uid}`, {
        ...ev,
        _label: acc.label, _accountId: acc.accountId,
        _webUrl: acc.webInterfaceUrl, _color: acc.color,
        _accountType: acc.type || 'caldav',
      });
    }
  }

  panel.innerHTML = '';

  if (!_calGrouped) {
    // ---- Unified chronological view ----
    menuBtn.style.display = '';

    const allEvents = [];
    for (const acc of accounts) {
      if (acc.error) continue;
      for (const ev of (acc.events || [])) {
        allEvents.push({ ...ev, _color: acc.color, _accountId: acc.accountId, _webUrl: acc.webInterfaceUrl || '' });
      }
    }

    const errAccounts = accounts.filter(a => a.error);
    if (errAccounts.length) {
      for (const acc of errAccounts) {
        panel.innerHTML += `<div class="dashboard-source-error">\u26a0 ${escHtml(acc.label || acc.accountId)}: ${escHtml(acc.error)}</div>`;
      }
    }

    // Unified lookahead note (show max of all accounts)
    const lookaheads = accounts.map(a => _calLookahead.get(a.accountId) ?? (a.lookaheadDays || 7));
    const maxLookahead = lookaheads.length ? Math.max(...lookaheads) : 7;
    const maxDayUnified = new Date(); maxDayUnified.setDate(maxDayUnified.getDate() + maxLookahead - 1);
    const groupsHtml = _calDayGroupsHtml(allEvents, '', '', '', maxDayUnified.toISOString().slice(0, 10));
    panel.innerHTML += groupsHtml || '<p class="dashboard-empty">No upcoming events.</p>';

    if (maxLookahead > 7) {
      const noteEl = document.createElement('p');
      noteEl.className = 'dash-cal-lookahead-note';
      noteEl.textContent = `Showing next ${maxLookahead} days`;
      panel.appendChild(noteEl);
    }
    return;
  }

  // ---- Grouped per-account view (default) ----
  menuBtn.style.display = 'none';

  for (const acc of accounts) {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'dash-cal-account';
    sectionEl.dataset.accountId = acc.accountId;

    // Header with col-btn
    const headerEl = document.createElement('div');
    headerEl.className = 'dash-cal-account-header';
    const labelEl = document.createElement('span');
    labelEl.className = 'dash-cal-account-label';
    labelEl.textContent = acc.label || acc.accountId;
    if (acc.color) labelEl.style.setProperty('--card-color', acc.color);
    const accMenuBtn = document.createElement('button');
    accMenuBtn.className = 'col-btn';
    accMenuBtn.title = 'Calendar options';
    accMenuBtn.dataset.accountId = acc.accountId;
    accMenuBtn.textContent = '\u22ee';
    headerEl.append(labelEl, accMenuBtn);
    sectionEl.appendChild(headerEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'dash-cal-account-body';

    if (acc.error) {
      bodyEl.innerHTML = `<div class="dashboard-source-error">\u26a0 ${escHtml(acc.error)}</div>`;
    } else {
      const lookahead = _calLookahead.get(acc.accountId) ?? (acc.lookaheadDays || 7);
      const maxDayAcc = new Date(); maxDayAcc.setDate(maxDayAcc.getDate() + lookahead - 1);
      const groupsHtml = _calDayGroupsHtml(acc.events || [], acc.color, acc.accountId, acc.webInterfaceUrl, maxDayAcc.toISOString().slice(0, 10));
      bodyEl.innerHTML = groupsHtml || '<p class="dashboard-empty">No upcoming events.</p>';

      // Lookahead note
      const noteEl = document.createElement('p');
      noteEl.className = 'dash-cal-lookahead-note';
      if (_calLookahead.get(acc.accountId)) noteEl.textContent = `Showing next ${lookahead} days`;
      else noteEl.hidden = true;
      bodyEl.appendChild(noteEl);
    }

    sectionEl.appendChild(bodyEl);

    // Col-btn click → context menu
    accMenuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const days = _calLookahead.get(acc.accountId) ?? (acc.lookaheadDays || 7);
      const items = [];
      if ((acc.type || 'caldav') !== 'ical-url') {
        items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.create()}</span>New event`, action: () => openCalEventModal(acc.accountId, null, acc) });
      }
      items.push(
        { labelHtml: `<span class="ctx-icon">+1</span>week (now: ${days} days)`,  action: () => _loadMoreCalEvents(acc.accountId, 7,  acc) },
        { labelHtml: `<span class="ctx-icon">+1</span>month (now: ${days} days)`, action: () => _loadMoreCalEvents(acc.accountId, 30, acc) },
        { labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Edit accounts`, action: () => openSettingsDialog('calendar-accounts') },
      );
      openContextMenu(e, items);
    });

    panel.appendChild(sectionEl);
  }
}

// ---- Detail panel ----

async function _resolveDashCardAttachments(container, board, cardId) {
  const base = `/api/${encodeURIComponent(board)}/cards/attachments/${encodeURIComponent(cardId)}`;
  for (const img of container.querySelectorAll('img[src^="attachment:"]')) {
    const fn = img.getAttribute('src').slice('attachment:'.length);
    try {
      const r = await fetch(`${base}/${encodeURIComponent(fn)}`);
      if (!r.ok) continue;
      const obj = URL.createObjectURL(await r.blob());
      if (_attachType(fn) === 'pdf') {
        const embed = document.createElement('embed');
        embed.src = obj; embed.type = 'application/pdf'; embed.className = 'md-pdf-embed';
        img.replaceWith(embed);
      } else {
        img.src = obj;
      }
    } catch { /* ignore */ }
  }
  for (const a of container.querySelectorAll('a[href^="attachment:"]')) {
    const fn = a.getAttribute('href').slice('attachment:'.length);
    const url = `${base}/${encodeURIComponent(fn)}`;
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
    const ft = _attachType(fn);
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (ft === 'image' || ft === 'pdf') openAttachmentViewer(url, fn, ft);
      else _downloadAttachment(url, fn);
    });
  }
}

async function _openCardDetail(board, card) {
  const detail    = document.getElementById('dashboardDetail');
  const body      = document.getElementById('dashboardDetailBody');
  const editBtn   = document.getElementById('dashboardDetailEditBtn');
  const webUrlBtn = document.getElementById('dashboardDetailWebUrl');

  document.getElementById('dashboardDetailTitle').textContent = card.text || '';
  editBtn.href = `/board/${encodeURIComponent(board)}#card:${encodeURIComponent(card.id)}`;
  editBtn.style.display = '';
  webUrlBtn.style.display = 'none';
  body.innerHTML = '';
  detail.style.display = '';
  { const modal = detail.querySelector('.modal');
    const maxH  = modal.offsetHeight;
    modal.style.height    = 'auto';
    modal.style.minHeight = '450px';
    modal.style.maxHeight = maxH + 'px'; }

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  rows.push(['Board', escHtml(board)]);

  if (card.priority) {
    const pc = PRIORITY_COLORS[card.priority];
    const pl = PRIORITY_LABELS[card.priority];
    rows.push(['Priority', `<span class="priority-badge" style="background:${pc}22;color:${pc}">${escHtml(pl)}</span>`]);
  }

  if (card.startDate || card.endDate) {
    let dateStr;
    if (card.startDate && card.endDate) dateStr = `${fmtDate(card.startDate)} \u2192 ${fmtDate(card.endDate)}`;
    else if (card.startDate)            dateStr = `${fmtDate(card.startDate)} \u2192`;
    else                                dateStr = `\u2192 ${fmtDate(card.endDate)}`;
    const isOverdue = card.endDate && card.endDate < today && !card.done;
    rows.push(['Date', `<span${isOverdue ? ' style="color:#ef4444"' : ''}>${escHtml(dateStr)}</span>`]);
  }

  if (card.done) {
    rows.push(['Status', `<span class="card-done-mark">${ICONS.done} done</span>`]);
  }

  if (card.created) {
    rows.push(['Created', escHtml(fmtDate(card.created))]);
  }

  if (card.link) {
    const safe = safeLink(card.link);
    if (safe) rows.push(['Link', `<a href="${escHtml(safe)}" target="_blank" rel="noopener noreferrer">${escHtml(card.link)}</a>`]);
  }

  body.innerHTML = `<table class="dashboard-detail-table">${
    rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
  }</table>`;

  // Fetch full card (description is a boolean flag in dashboard API), attachments and linked notes in parallel
  const [boardData, attachments, notesDoc] = await Promise.all([
    fetch(`/api/${encodeURIComponent(board)}/board`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`/api/${encodeURIComponent(board)}/cards/attachments/${encodeURIComponent(card.id)}`)
      .then(r => r.ok ? r.json() : []).catch(() => []),
    card.hasLinkedNotes
      ? fetch(`/api/${encodeURIComponent(board)}/notes`).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Get full description from board data
  let fullDescription = '';
  if (boardData) {
    for (const col of boardData.columns || []) {
      const found = col.cards.find(c => c.id === card.id);
      if (found) { fullDescription = found.description || ''; break; }
    }
  }

  if (fullDescription) {
    const div = document.createElement('div');
    div.className = 'cm-preview card-desc-preview dash-card-desc-preview';
    div.innerHTML = renderMarkdown(fullDescription);
    body.appendChild(div);
    buildToc(div);
    _resolveDashCardAttachments(div, board, card.id);
  }

  // Collect pages that link to this card
  const linkedPages = [];
  function _collectLinked(items) {
    for (const item of items || []) {
      if (item.type === 'page' && item.linkedCards?.includes(card.id)) linkedPages.push(item);
      if (item.children) _collectLinked(item.children);
    }
  }
  _collectLinked(notesDoc?.items);

  if (attachments.length) {
    const fmtSize = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
    const section = document.createElement('div');
    section.className = 'dash-card-detail-section';
    section.innerHTML = '<div class="dash-card-detail-section-hdr">Attachments</div>' +
      attachments.map(a => {
        const url = `/api/${encodeURIComponent(board)}/cards/attachments/${encodeURIComponent(card.id)}/${encodeURIComponent(a.name)}`;
        return `<a class="dash-card-attach-item" href="${escHtml(url)}" download="${escHtml(a.name)}">${SVGICONS.attachment(12, 12)} ${escHtml(a.name)}<span class="dash-card-attach-size">${fmtSize(a.size)}</span></a>`;
      }).join('');
    body.appendChild(section);
  }

  if (linkedPages.length) {
    const section = document.createElement('div');
    section.className = 'dash-card-detail-section';
    section.innerHTML = '<div class="dash-card-detail-section-hdr">Linked notes</div>' +
      linkedPages.map(p => {
        const href = `/board/${encodeURIComponent(board)}#note:${encodeURIComponent(p.id)}`;
        return `<a class="dash-card-note-link" href="${escHtml(href)}">${SVGICONS.noteDoc(9, 11)} ${escHtml(p.title || 'Untitled')}</a>`;
      }).join('');
    body.appendChild(section);
  }
}

/**
 * Parse the UNTIL value from an RRULE string into a localised date string.
 * UNTIL can be a date-only value ("20261231") or a UTC datetime ("20261231T235959Z").
 */
function _parseUntilRRule(untilStr) {
  if (!untilStr) return null;
  try {
    const d = untilStr.length === 8
      ? new Date(Date.UTC(+untilStr.slice(0, 4), +untilStr.slice(4, 6) - 1, +untilStr.slice(6, 8)))
      : new Date(untilStr.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/, '$1-$2-$3T$4:$5:$6Z'));
    return isNaN(d) ? untilStr : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return untilStr; }
}

/**
 * Convert a raw RRULE value string (e.g. "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2")
 * into a human-readable recurrence description.
 * seriesStart is the ISO date/datetime string for the first occurrence (DTSTART).
 */
function _formatRRule(rruleStr, seriesStart) {
  if (!rruleStr) return 'Recurring event';
  const parts = {};
  for (const seg of rruleStr.split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).toUpperCase()] = seg.slice(i + 1);
  }
  const freq     = parts.FREQ || '';
  const interval = parseInt(parts.INTERVAL || '1', 10) || 1;
  const count    = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  const until    = parts.UNTIL ? _parseUntilRRule(parts.UNTIL) : null;
  const byday    = parts.BYDAY    ? parts.BYDAY.split(',')    : [];
  const bymonthday = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map(Number) : [];
  const bymonth  = parts.BYMONTH  ? parts.BYMONTH.split(',').map(Number)  : [];

  const DAY_NAMES  = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
  const MON_NAMES  = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function ordinal(n) {
    if (n === -1) return 'last';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = Math.abs(n) % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  let str = '';
  if (freq === 'DAILY') {
    str = interval === 1 ? 'Every day' : `Every ${interval} days`;
  } else if (freq === 'WEEKLY') {
    str = interval === 1 ? 'Every week' : `Every ${interval} weeks`;
    if (byday.length) {
      const names = byday.map(d => {
        const m = d.match(/^[+-]?\d*(SU|MO|TU|WE|TH|FR|SA)$/);
        return m ? (DAY_NAMES[m[1]] || m[1]) : d;
      });
      str += ' on ' + names.join(', ');
    }
  } else if (freq === 'MONTHLY') {
    str = interval === 1 ? 'Every month' : `Every ${interval} months`;
    if (bymonthday.length) {
      str += ' on the ' + bymonthday.map(ordinal).join(', ');
    } else if (byday.length) {
      const m = byday[0].match(/^([+-]?\d+)(SU|MO|TU|WE|TH|FR|SA)$/);
      if (m) str += ` on the ${ordinal(parseInt(m[1], 10))} ${DAY_NAMES[m[2]] || m[2]}`;
    }
  } else if (freq === 'YEARLY') {
    str = interval === 1 ? 'Every year' : `Every ${interval} years`;
    if (bymonth.length && bymonthday.length) str += ` on ${MON_NAMES[bymonth[0]]} ${bymonthday[0]}`;
    else if (bymonth.length) str += ` in ${MON_NAMES[bymonth[0]]}`;
  } else if (freq === 'HOURLY') {
    str = interval === 1 ? 'Every hour' : `Every ${interval} hours`;
  } else {
    str = 'Recurring';
  }

  if (count)        str += `, ${count} time${count !== 1 ? 's' : ''}`;
  else if (until)   str += `, until ${until}`;

  if (seriesStart) {
    try {
      const d = new Date(seriesStart);
      if (!isNaN(d)) {
        const dateStr    = d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
        const weekdayStr = d.toLocaleDateString([], { weekday: 'long' });
        str += `, started ${dateStr} (${weekdayStr})`;
      }
    } catch { /* ignore */ }
  }

  return str;
}

function _showCalEventContextMenu(e, accountId, uid, webUrl) {
  const ev          = _calEventMap.get(`${accountId}\0${uid}`);
  const isIcal      = (ev?._accountType || 'caldav') === 'ical-url';
  const isRecurring = !!ev?.hasRrule;
  const items = [
    { labelHtml: `<span class="ctx-icon">${SVGICONS.cardInfo()}</span>Open`,   action: () => _openEventDetail(accountId, uid, webUrl) },
  ];
  if (!isIcal && !isRecurring) {
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Edit`,             action: () => openCalEventModal(accountId, ev) });
    items.push({ labelHtml: `<span class="ctx-icon">${ICONS.close}</span>Delete`, danger: true, action: () => _deleteCalEvent(accountId, uid, ev?.etag, ev?.href) });
  }
  openContextMenu(e, items);
}

function _openEventDetail(accountId, uid, webUrl) {
  const detail    = document.getElementById('dashboardDetail');
  const body      = document.getElementById('dashboardDetailBody');
  const webUrlBtn = document.getElementById('dashboardDetailWebUrl');
  document.getElementById('dashboardDetailEditBtn').style.display = 'none';
  document.getElementById('dashboardDetailTitle').textContent = 'Loading\u2026';
  if (webUrl) {
    webUrlBtn.href = webUrl;
    webUrlBtn.title = 'Open in Calendar';
    webUrlBtn.style.display = '';
  } else {
    webUrlBtn.style.display = 'none';
  }
  body.innerHTML = '';
  detail.style.display = '';
  const modal = detail.querySelector('.modal');
  const maxH  = modal.offsetHeight;
  modal.style.height    = 'auto';
  modal.style.minHeight = '450px';
  modal.style.maxHeight = maxH + 'px';

  function _renderEventDetail(ev) {
    document.getElementById('dashboardDetailTitle').textContent = ev.title;
    const rows = [];
    if (ev.start) {
      const startStr = ev.allDay
        ? new Date(ev.start).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : new Date(ev.start).toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const endStr = (!ev.allDay && ev.end)
        ? '\u2013 ' + new Date(ev.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      rows.push(['When', escHtml(startStr + endStr)]);
    }
    if (ev.location)  rows.push(['Where',      escHtml(ev.location)]);
    if (ev.status)    rows.push(['Status',     escHtml(ev.status)]);
    if (ev.organizer) rows.push(['Organiser',  escHtml(ev.organizer)]);
    if (ev._label)    rows.push(['Calendar',   escHtml(ev._label)]);
    if (ev.hasRrule)  rows.push(['Recurrence', escHtml(_formatRRule(ev.rruleStr || null, ev.seriesStart || ev.start))]);
    body.innerHTML = `<table class="dashboard-detail-table">${
      rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
    }</table>`;
    if (ev.description) {
      const iframe = document.createElement('iframe');
      iframe.className = 'dashboard-mail-iframe';
      iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox allow-same-origin');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      body.appendChild(iframe);
      const baseStyle = 'body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#222;background:white;padding:8px;margin:0;word-break:break-word}'
        + ' a{color:#4f46e5} img{max-width:100%;height:auto}'
        + ' blockquote{border-left:3px solid #ddd;margin:8px 0;padding:0 12px;color:#555}'
        + ' pre,code{font-family:monospace;font-size:0.88em;background:#f0f0f0;padding:2px 5px;border-radius:3px}';
      let descSrc = /<p[\s>]|<br[\s/>]/i.test(ev.description)
        ? ev.description
        : ev.description.replace(/\n/g, '<br/>');
      // Linkify bare URLs not already inside an href attribute
      descSrc = descSrc.replace(/(href=["'][^"']*["'])|(https?:\/\/[^\s<>"')\]]+)/g,
        (m, attr, url) => attr ? attr : `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      const safeHtml = DOMPurify.sanitize(descSrc, { FORCE_BODY: true, ADD_ATTR: ['target', 'rel'] });
      iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${baseStyle}</style></head><body>${safeHtml}</body></html>`;
      const resize = () => {
        const natural = iframe.contentDocument.body.scrollHeight + 16;
        iframe.style.height = Math.max(450, Math.min(natural, body.clientHeight)) + 'px';
      };
      iframe.addEventListener('load', resize);
    }

    // Edit / Delete footer — only for CalDAV accounts, hidden for iCal-URL or recurring events
    const existingFooter = detail.querySelector('.dash-detail-footer');
    if (existingFooter) existingFooter.remove();

    const isReadOnly  = (ev._accountType || 'caldav') === 'ical-url';
    const isRecurring = !!ev.hasRrule;

    if (!isReadOnly) {
      const footer = document.createElement('div');
      footer.className = 'dash-detail-footer';

      if (isRecurring) {
        const note = document.createElement('span');
        note.style.cssText = 'font-size:0.8rem;color:var(--text-muted);flex:1';
        note.textContent = 'Recurring event \u2014 editing not supported.';
        footer.appendChild(note);
      } else {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-secondary';
        deleteBtn.style.color = 'var(--danger)';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => _deleteCalEvent(ev._accountId, ev.uid, ev.etag, ev.href));

        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-primary';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openCalEventModal(ev._accountId, ev));

        footer.append(deleteBtn, editBtn);
      }

      detail.querySelector('.modal').appendChild(footer);
    }
  }

  // Use cached event data if available — avoids a full CalDAV round-trip
  const cached = _calEventMap.get(`${accountId}\0${uid}`);
  if (cached) { _renderEventDetail(cached); return; }

  fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(uid)}`)
    .then(r => r.ok ? r.json() : null)
    .then(ev => {
      if (!ev) { body.innerHTML = '<p class="dashboard-empty">Event not found.</p>'; return; }
      _renderEventDetail(ev);
    })
    .catch(() => { body.innerHTML = '<p class="dashboard-empty">Failed to load event.</p>'; });
}

function _closeDetail() {
  document.getElementById('dashboardDetail').style.display = 'none';
  const modal = document.querySelector('#dashboardDetail .modal');
  if (modal) {
    modal.classList.remove('modal--fullscreen');
    modal.style.height = modal.style.minHeight = modal.style.maxHeight = '';
  }
}

// ---- Mail context menu ----

function _showMailContextMenu(x, y, accountId, msgId, unread, webUrl) {
  _closeAllContextMenus();
  _mailCtxAccountId = accountId;
  _mailCtxMsgId     = msgId;
  _mailCtxUnread    = !!unread;
  document.getElementById('mailCtxToggleReadLabel').textContent = unread ? 'Mark as read' : 'Mark as unread';
  const webmailEl = document.getElementById('mailCtxWebmail');
  if (webUrl) { webmailEl.href = webUrl; webmailEl.style.display = ''; }
  else        { webmailEl.style.display = 'none'; }
  const menu = document.getElementById('mailContextMenu');
  menu.style.display = 'block';
  const mw   = menu.offsetWidth  || 160;
  const mh   = menu.offsetHeight || 40;
  const edge = 4;
  const menuLeft = Math.max(edge, Math.min(x, window.innerWidth  - mw - edge));
  const menuTop  = Math.max(edge, Math.min(y, window.innerHeight - mh - edge));
  menu.style.left = menuLeft + 'px';
  menu.style.top  = menuTop  + 'px';
  const toLeft = menuLeft + mw + 160 > window.innerWidth - edge;
  document.getElementById('mailCtxMoveWrap').classList.toggle('ctx-submenu-left', toLeft);
  document.getElementById('mailCtxCreateCardWrap').classList.toggle('ctx-submenu-left', toLeft);
}

function hideMailContextMenu() {
  document.getElementById('mailContextMenu').style.display = 'none';
  _mailCtxAccountId = null;
  _mailCtxMsgId     = null;
  _mailCtxUnread    = false;
}

function _getRecentFolders(accountId) {
  const list = _serverRecentFolders[accountId];
  return Array.isArray(list) ? list : [];
}

function _addRecentFolder(accountId, folder) {
  const current = _getRecentFolders(accountId);
  _serverRecentFolders[accountId] = [folder, ...current.filter(f => f !== folder)].slice(0, 3);
  // Persist to server (fire & forget)
  fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/recent-folders`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) }
  ).catch(() => {});
}

function _makeFolderBtn(path, label) {
  const btn = document.createElement('button');
  btn.className = 'ctx-item';
  btn.dataset.folder = path;
  btn.textContent = label;
  btn.addEventListener('click', () => {
    const accountId = _mailCtxAccountId;
    const msgId     = _mailCtxMsgId;
    hideMailContextMenu();
    if (accountId && msgId) _mailMove(accountId, msgId, path);
  });
  return btn;
}

function _populateFolderList(folders, listEl) {
  if (!folders.length) {
    listEl.innerHTML = '<p class="ctx-folder-loading">No folders found.</p>';
    return;
  }
  listEl.innerHTML = '';
  const folderMap = Object.fromEntries(folders.map(f => [f.path, f.name || f.path]));
  const recents = _getRecentFolders(_mailCtxAccountId)
    .filter(path => path in folderMap);
  if (recents.length) {
    recents.forEach(path => listEl.appendChild(_makeFolderBtn(path, folderMap[path])));
    const sep = document.createElement('div');
    sep.className = 'ctx-separator';
    listEl.appendChild(sep);
  }
  folders.forEach(f => listEl.appendChild(_makeFolderBtn(f.path, f.name || f.path)));
  listEl.scrollTop = 0;
}

async function _mailToggleRead(accountId, msgId, unread) {
  const seen = unread; // unread=true → mark as seen; unread=false → mark as unseen
  const item = document.querySelector(
    `.dashboard-mail-item[data-account-id="${CSS.escape(accountId)}"][data-msg-id="${CSS.escape(msgId)}"]`
  );
  try {
    const res = await fetch(
      `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seen }) }
    );
    if (!res.ok) throw new Error('Failed');
    if (item) {
      const textEl = item.querySelector('.card-text');
      if (textEl) {
        if (seen) {
          // Was unread → now read: remove bold
          const strong = textEl.querySelector('strong');
          textEl.textContent = strong ? strong.textContent : textEl.textContent;
        } else {
          // Was read → now unread: add bold
          textEl.innerHTML = `<strong>${escHtml(textEl.textContent)}</strong>`;
        }
      }
      item.dataset.unread = seen ? '0' : '1';
    }
  } catch {
    _reloadMailPanel();
  }
}

async function _mailDelete(accountId, msgId) {
  const item = document.querySelector(
    `.dashboard-mail-item[data-account-id="${CSS.escape(accountId)}"][data-msg-id="${CSS.escape(msgId)}"]`
  );
  item?.remove();
  try {
    const res = await fetch(
      `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error('Failed');
  } catch {
    _reloadMailPanel();
  }
}

async function _mailMove(accountId, msgId, folder) {
  const item = document.querySelector(
    `.dashboard-mail-item[data-account-id="${CSS.escape(accountId)}"][data-msg-id="${CSS.escape(msgId)}"]`
  );
  item?.remove();
  try {
    const res = await fetch(
      `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}/move`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) }
    );
    if (!res.ok) throw new Error('Failed');
    _addRecentFolder(accountId, folder);
  } catch {
    _reloadMailPanel();
  }
}

async function _createCardFromMail(accountId, msgId, boardName = null) {
  let prefill = { text: '', description: '' };
  let msg = null;
  try {
    msg = await fetch(
      `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}`
    ).then(r => r.ok ? r.json() : null);

    if (msg) {
      prefill.text = msg.subject || '';

      const headerLines = [];
      if (msg.from)    headerLines.push(`**From:** ${msg.from}`);
      if (msg.to)      headerLines.push(`**To:** ${msg.to}`);
      if (msg.cc)      headerLines.push(`**Cc:** ${msg.cc}`);
      if (msg.date)    headerLines.push(`**Date:** ${new Date(msg.date).toLocaleString()}`);
      if (msg.subject) headerLines.push(`**Subject:** ${msg.subject}`);

      let bodyText = '';
      if (msg.bodyHtml) {
        try {
          bodyText = new DOMParser()
            .parseFromString(msg.bodyHtml, 'text/html')
            .body.innerText.trim();
        } catch {
          bodyText = msg.body || '';
        }
      } else {
        bodyText = msg.body || '';
      }

      prefill.description = headerLines.join('  \n') +
        (bodyText ? '\n\n---\n\n' + bodyText : '');
    }
  } catch { /* proceed with empty prefill */ }

  const attachments = msg?.attachments || [];

  // If the target board is already known, pre-upload to a temp card ID so the
  // inbox modal shows the attachments immediately (background — modal opens in parallel).
  let preTempCardId = null;
  if (boardName && attachments.length) {
    preTempCardId = uid();
    _uploadMailAttachmentsToCard(accountId, msgId, attachments, boardName, preTempCardId)
      .then(() => { if (typeof _inboxTempCardId !== 'undefined' && _inboxTempCardId === preTempCardId) loadCardAttachments(preTempCardId); });
  }

  await openInboxModal(boardName, prefill, async (board, cardId) => {
    // Re-upload only if board was changed (new cardId differs from pre-uploaded temp)
    if (attachments.length && board && cardId && cardId !== preTempCardId) {
      await _uploadMailAttachmentsToCard(accountId, msgId, attachments, board, cardId);
    }
  }, null, preTempCardId);
}

async function _uploadMailAttachmentsToCard(accountId, msgId, attachments, board, cardId) {
  const base = `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}/attachment/`;
  for (const att of attachments) {
    try {
      const blob = await fetch(base + encodeURIComponent(att.part)).then(r => r.ok ? r.blob() : null);
      if (!blob) continue;
      const form = new FormData();
      form.append('file', blob, att.name);
      await fetch(`/api/${encodeURIComponent(board)}/cards/attachments/${encodeURIComponent(cardId)}`, {
        method: 'POST', body: form,
      });
    } catch { /* skip failed attachment */ }
  }
}

document.getElementById('mailCtxWebmail').addEventListener('click', () => hideMailContextMenu());

{ // Create card — click opens inbox modal; submenu lets user pick a board directly
  let _boardListCache = null;

  document.getElementById('mailCtxCreateCardWrap').addEventListener('click', async e => {
    // Ignore clicks that originated from inside the submenu (board buttons)
    if (e.target.closest('.ctx-submenu')) return;
    const accountId = _mailCtxAccountId;
    const msgId     = _mailCtxMsgId;
    hideMailContextMenu();
    if (accountId && msgId) await _createCardFromMail(accountId, msgId);
  });

  document.getElementById('mailCtxCreateCardWrap').addEventListener('mouseenter', async () => {
    const listEl = document.getElementById('mailCtxBoardList');
    if (_boardListCache) { _populateBoardList(_boardListCache, listEl); return; }
    listEl.innerHTML = '<p class="ctx-folder-loading">Loading\u2026</p>';
    try {
      const boards = await fetch('/api/boards').then(r => r.json());
      _boardListCache = boards.filter(b => !b.archived);
      _populateBoardList(_boardListCache, listEl);
    } catch {
      listEl.innerHTML = '<p class="ctx-folder-loading">Failed to load.</p>';
    }
  });
}

function _populateBoardList(boards, listEl) {
  if (!boards.length) { listEl.innerHTML = '<p class="ctx-folder-loading">No boards.</p>'; return; }
  listEl.innerHTML = '';
  boards.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.textContent = b.name;
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const accountId = _mailCtxAccountId;
      const msgId     = _mailCtxMsgId;
      hideMailContextMenu();
      if (accountId && msgId) await _createCardFromMail(accountId, msgId, b.name);
    });
    listEl.appendChild(btn);
  });
}

document.getElementById('mailCtxToggleRead').addEventListener('click', async () => {
  const accountId = _mailCtxAccountId;
  const msgId     = _mailCtxMsgId;
  const unread    = _mailCtxUnread;
  hideMailContextMenu();
  if (accountId && msgId) await _mailToggleRead(accountId, msgId, unread);
});

document.getElementById('mailCtxDelete').addEventListener('click', async () => {
  const accountId = _mailCtxAccountId;
  const msgId     = _mailCtxMsgId;
  hideMailContextMenu();
  if (!accountId || !msgId) return;
  const ok = await showConfirm('Move this message to trash?', { okLabel: 'Delete', danger: true });
  if (ok) await _mailDelete(accountId, msgId);
});

// Populate folder list on hover — fetch once per account then serve from cache
document.getElementById('mailCtxMoveWrap').addEventListener('mouseenter', async () => {
  const accountId = _mailCtxAccountId;
  if (!accountId) return;
  const listEl = document.getElementById('mailCtxFolderList');
  if (_folderCache.has(accountId)) {
    _populateFolderList(_folderCache.get(accountId), listEl);
    return;
  }
  listEl.innerHTML = '<p class="ctx-folder-loading">Loading\u2026</p>';
  try {
    const res = await fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/folders`);
    if (!res.ok) throw new Error('Failed');
    const { folders } = await res.json();
    _folderCache.set(accountId, folders);
    _populateFolderList(folders, listEl);
  } catch {
    listEl.innerHTML = '<p class="ctx-folder-loading">Failed to load.</p>';
  }
});

document.addEventListener('click', () => hideMailContextMenu());

// ---- Calendar event write ----

/** Populate a <select> with grouped IANA timezone options. */
function _populateTzSelect(sel, selected) {
  sel.innerHTML = '';
  try {
    const tzs = Intl.supportedValuesOf('timeZone');
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = '\u2014 Browser default \u2014';
    sel.appendChild(blank);
    const groups = {};
    for (const tz of tzs) {
      const region = tz.includes('/') ? tz.split('/')[0] : 'Other';
      if (!groups[region]) groups[region] = [];
      groups[region].push(tz);
    }
    for (const [region, tzList] of Object.entries(groups).sort()) {
      const og = document.createElement('optgroup');
      og.label = region;
      for (const tz of tzList) {
        const opt = document.createElement('option');
        opt.value = tz; opt.textContent = tz;
        if (tz === selected) opt.selected = true;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
  } catch {
    // Intl.supportedValuesOf not available — add a text input fallback
    sel.innerHTML = `<option value="${escHtml(selected || '')}">${escHtml(selected || 'UTC')}</option>`;
  }
  if (selected) sel.value = selected;
}

/**
 * Open the calendar event creation/edit modal.
 * accountId + acc: create mode (acc is the account config object for type check).
 * accountId + ev:  edit mode (ev is the cached event from _calEventMap).
 */
async function openCalEventModal(accountId, ev, acc) {
  const modal      = document.getElementById('calEventModal');
  const titleEl    = document.getElementById('calEventModalTitle');
  const accField   = document.getElementById('calEventAccountField');
  const accSel     = document.getElementById('calEventAccount');
  const titleInput = document.getElementById('calEventTitle');
  const allDayCb   = document.getElementById('calEventAllDay');
  const startDate  = document.getElementById('calEventStartDate');
  const startTime  = document.getElementById('calEventStartTime');
  const endDate    = document.getElementById('calEventEndDate');
  const endTime    = document.getElementById('calEventEndTime');
  const locInput   = document.getElementById('calEventLocation');
  const tzSel      = document.getElementById('calEventTimezone');
  const tzRow      = document.getElementById('calEventTzRow');
  const descInput  = document.getElementById('calEventDescription');
  const errEl      = document.getElementById('calEventError');
  const saveBtn    = document.getElementById('calEventSaveBtn');

  errEl.hidden = true; errEl.textContent = '';
  saveBtn.textContent = 'Save event'; saveBtn.disabled = false;

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (ev) {
    // Edit mode — populate from cache immediately, fetch fresh etag/href in background
    _calModalMode  = 'edit';
    _calModalAccId = ev._accountId || accountId;
    _calModalUid   = ev.uid;
    _calModalEtag  = ev.etag || null;
    _calModalHref  = ev.href || null;
    titleEl.textContent = 'Edit event';
    accField.style.display = 'none';

    titleInput.value = ev.title || '';
    allDayCb.checked = !!ev.allDay;
    locInput.value   = ev.location || '';
    descInput.value  = ev.description || '';

    // Fetch fresh etag/href in background — disable save until ready
    saveBtn.disabled = true; saveBtn.textContent = 'Loading\u2026';
    fetch(`/api/dashboard/calendar/${encodeURIComponent(_calModalAccId)}/event/${encodeURIComponent(ev.uid)}`)
      .then(r => r.ok ? r.json() : null)
      .then(fresh => { if (fresh) { _calModalEtag = fresh.etag ?? _calModalEtag; _calModalHref = fresh.href ?? _calModalHref; } })
      .catch(() => { /* keep cached values */ })
      .finally(() => { if (modal.open) { saveBtn.disabled = false; saveBtn.textContent = 'Save event'; } });

    // Dates
    const startDt  = ev.start ? new Date(ev.start) : new Date();
    const endDt    = ev.end   ? new Date(ev.end)   : new Date(startDt.getTime() + 3600000);
    const isoLocal = dt => {
      const y = dt.getFullYear(), mo = dt.getMonth() + 1, d = dt.getDate();
      const h = dt.getHours(), mi = dt.getMinutes();
      return {
        date: `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
        time: `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`,
      };
    };
    if (ev.allDay) {
      startDate.value = (ev.start || '').slice(0, 10);
      endDate.value   = (ev.end   || '').slice(0, 10) || startDate.value;
    } else {
      const s = isoLocal(startDt), e = isoLocal(endDt);
      startDate.value = s.date; startTime.value = s.time;
      endDate.value   = e.date; endTime.value   = e.time;
    }

    const tz = ev.timezone || _defaultTimezone || browserTz;
    _populateTzSelect(tzSel, tz);
  } else {
    // Create mode
    _calModalMode  = 'create';
    _calModalAccId = accountId;
    _calModalUid   = null;
    _calModalEtag  = null;
    titleEl.textContent = 'New event';

    // Populate account selector
    accField.style.display = '';
    accSel.innerHTML = '';
    const allAccounts = _calAccountsMeta.filter(a => (a.type || 'caldav') !== 'ical-url');
    for (const a of allAccounts) {
      const opt = document.createElement('option');
      opt.value = a.accountId; opt.textContent = a.label || a.accountId;
      if (a.accountId === accountId) opt.selected = true;
      accSel.appendChild(opt);
    }

    titleInput.value = '';
    allDayCb.checked = false;
    locInput.value   = '';
    descInput.value  = '';

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const startH = now.getHours() + 1;
    startDate.value = todayDate; startTime.value = `${pad(startH % 24)}:00`;
    endDate.value   = todayDate; endTime.value   = `${pad((startH + 1) % 24)}:00`;

    _populateTzSelect(tzSel, _defaultTimezone || browserTz);
  }

  // Show/hide time fields based on all-day
  const toggleAllDay = () => {
    const ad = allDayCb.checked;
    startTime.style.display = ad ? 'none' : '';
    endTime.style.display   = ad ? 'none' : '';
    tzRow.style.display     = ad ? 'none' : '';
  };
  allDayCb.onchange = toggleAllDay;
  toggleAllDay();

  modal.showModal();
}

async function _submitCalEvent() {
  const allDayCb  = document.getElementById('calEventAllDay');
  const startDate = document.getElementById('calEventStartDate');
  const startTime = document.getElementById('calEventStartTime');
  const endDate   = document.getElementById('calEventEndDate');
  const endTime   = document.getElementById('calEventEndTime');
  const errEl     = document.getElementById('calEventError');
  const saveBtn   = document.getElementById('calEventSaveBtn');

  const title    = document.getElementById('calEventTitle').value.trim();
  const allDay   = allDayCb.checked;
  const location = document.getElementById('calEventLocation').value.trim();
  const timezone = allDay ? '' : (document.getElementById('calEventTimezone').value || '');
  const desc     = document.getElementById('calEventDescription').value.trim();

  if (!title) { errEl.textContent = 'Title is required.'; errEl.hidden = false; return; }
  if (!startDate.value) { errEl.textContent = 'Start date is required.'; errEl.hidden = false; return; }

  const start = allDay
    ? startDate.value
    : `${startDate.value}T${startTime.value || '00:00'}:00`;
  const end = allDay
    ? (endDate.value || startDate.value)
    : `${endDate.value || startDate.value}T${endTime.value || '00:00'}:00`;

  errEl.hidden = true;
  saveBtn.textContent = 'Saving\u2026';
  saveBtn.disabled = true;

  const accountId = _calModalMode === 'edit'
    ? _calModalAccId
    : (document.getElementById('calEventAccount').value || _calModalAccId);

  const body = { title, allDay, start, end };
  if (location) body.location = location;
  if (desc)     body.description = desc;
  if (timezone) body.timezone = timezone;
  if (_calModalMode === 'edit' && _calModalEtag) body.etag = _calModalEtag;
  if (_calModalMode === 'edit' && _calModalHref) body.href = _calModalHref;

  try {
    let res;
    if (_calModalMode === 'edit') {
      res = await fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(_calModalUid)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || `Error ${res.status}`;
      errEl.hidden = false;
      saveBtn.textContent = 'Save event'; saveBtn.disabled = false;
      return;
    }

    document.getElementById('calEventModal').close();
    await _refreshCalendarAccount(accountId);
    _closeDetail();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    saveBtn.textContent = 'Save event'; saveBtn.disabled = false;
  }
}

async function _deleteCalEvent(accountId, uid, etag, href) {
  // Show confirm immediately from cached data — no network wait
  const ev      = _calEventMap.get(`${accountId}\0${uid}`);
  const title   = ev?.title || 'this event';
  const dateStr = ev?.start ? fmtDate(ev.start.slice(0, 10)) : '';
  const msg     = dateStr ? `Delete \u201c${title}\u201d on ${dateStr}?` : `Delete \u201c${title}\u201d?`;

  const ok = await showConfirm(msg, { okLabel: 'Delete', danger: true });
  if (!ok) return;

  // Fetch fresh etag/href now that user has confirmed
  try {
    const fresh = await fetch(
      `/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(uid)}`
    ).then(r => r.ok ? r.json() : null);
    if (fresh) { etag = fresh.etag ?? etag; href = fresh.href ?? href; }
  } catch { /* fall back to cached values */ }

  const headers = {};
  if (etag) headers['If-Match'] = etag;
  const qs = href ? `?href=${encodeURIComponent(href)}` : '';
  try {
    const res = await fetch(
      `/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(uid)}${qs}`,
      { method: 'DELETE', headers }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      await showConfirm(data.error || `Delete failed (${res.status})`, { okLabel: 'OK', hideCancel: true });
      return;
    }
    _closeDetail();
    await _refreshCalendarAccount(accountId);
  } catch (err) {
    await showConfirm(err.message, { okLabel: 'OK', hideCancel: true });
  }
}

async function _loadMoreCalEvents(accountId, extraDays, acc) {
  const configured = acc?.lookaheadDays || 7;
  const current    = _calLookahead.get(accountId) ?? configured;
  const newDays    = Math.min(365, current + extraDays);

  // Disable this account's col-btn during load
  const btn = document.querySelector(`.dash-cal-account[data-account-id="${CSS.escape(accountId)}"] .col-btn`);
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}?days=${newDays}`);
    if (!res.ok) return;
    const data = await res.json();

    _setCalLookahead(accountId, newDays);

    // Merge new events for this account into _calEventMap
    for (const key of [..._calEventMap.keys()]) {
      if (key.startsWith(`${accountId}\0`)) _calEventMap.delete(key);
    }
    const freshAcc = { ...acc, ...data, accountId, events: data.events || [] };
    for (const ev of freshAcc.events) {
      _calEventMap.set(`${accountId}\0${ev.uid}`, {
        ...ev,
        _label: acc?.label, _accountId: accountId,
        _webUrl: acc?.webInterfaceUrl, _color: acc?.color,
        _accountType: acc?.type || 'caldav',
      });
    }

    // Re-render just this account section
    const sectionEl = document.querySelector(`.dash-cal-account[data-account-id="${CSS.escape(accountId)}"]`);
    if (sectionEl) {
      const bodyEl = sectionEl.querySelector('.dash-cal-account-body');
      if (bodyEl) {
        const groupsHtml = _calDayGroupsHtml(freshAcc.events, acc?.color, accountId, acc?.webInterfaceUrl);
        bodyEl.innerHTML = groupsHtml || '<p class="dashboard-empty">No upcoming events.</p>';
        const noteEl = document.createElement('p');
        noteEl.className = 'dash-cal-lookahead-note';
        noteEl.textContent = `Showing next ${newDays} days`;
        bodyEl.appendChild(noteEl);
      }
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _loadMoreCalEventsAll(extraDays) {
  const headerBtn = document.getElementById('dashCalendarMenuBtn');
  if (headerBtn) headerBtn.disabled = true;

  const accounts = _calAccountsMeta;
  const fetches  = accounts.map(async acc => {
    const configured = acc.lookaheadDays || 7;
    const current    = _calLookahead.get(acc.accountId) ?? configured;
    const newDays    = Math.min(365, current + extraDays);
    _setCalLookahead(acc.accountId, newDays);
    try {
      const res = await fetch(`/api/dashboard/calendar/${encodeURIComponent(acc.accountId)}?days=${newDays}`);
      if (!res.ok) return acc;
      const data = await res.json();
      for (const key of [..._calEventMap.keys()]) {
        if (key.startsWith(`${acc.accountId}\0`)) _calEventMap.delete(key);
      }
      const freshAcc = { ...acc, ...data, accountId: acc.accountId, events: data.events || [] };
      for (const ev of freshAcc.events) {
        _calEventMap.set(`${acc.accountId}\0${ev.uid}`, {
          ...ev, _label: acc.label, _accountId: acc.accountId,
          _webUrl: acc.webInterfaceUrl, _color: acc.color, _accountType: acc.type || 'caldav',
        });
      }
      return freshAcc;
    } catch { return acc; }
  });

  const freshAccounts = await Promise.all(fetches);
  _renderCalendarPanel(freshAccounts);
  if (headerBtn) headerBtn.disabled = false;
}

async function _refreshCalendarAccount(accountId) {
  const days = _calLookahead.get(accountId);
  const url  = days
    ? `/api/dashboard/calendar/${encodeURIComponent(accountId)}?days=${days}`
    : `/api/dashboard/calendar/${encodeURIComponent(accountId)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();

    // Update _calEventMap for this account
    for (const key of [..._calEventMap.keys()]) {
      if (key.startsWith(`${accountId}\0`)) _calEventMap.delete(key);
    }

    // Look up account meta from the last-rendered accounts list (reliable in both grouped and ungrouped mode)
    const accMeta   = _calAccountsMeta.find(a => a.accountId === accountId) || {};
    const accLabel  = accMeta.label || '';
    const accColor  = accMeta.color || '';
    const accWebUrl = accMeta.webInterfaceUrl || '';
    const accType   = data.type || accMeta.type || 'caldav';
    const sectionEl = document.querySelector(`.dash-cal-account[data-account-id="${CSS.escape(accountId)}"]`);

    for (const ev of (data.events || [])) {
      _calEventMap.set(`${accountId}\0${ev.uid}`, {
        ...ev,
        _label: accLabel, _accountId: accountId,
        _webUrl: accWebUrl, _color: accColor,
        _accountType: accType,
      });
    }

    const lookahead = _calLookahead.get(accountId) ?? (data.lookaheadDays || 7);
    const maxDayD = new Date(); maxDayD.setDate(maxDayD.getDate() + lookahead - 1);
    const maxDay  = maxDayD.toISOString().slice(0, 10);

    if (!_calGrouped) {
      // Unified view — rebuild the whole panel from the updated _calEventMap
      const allEvents = [..._calEventMap.values()];
      const panel = document.getElementById('dashboardCalendarPanel');
      const maxLookahead = Math.max(..._calAccountsMeta.map(a => _calLookahead.get(a.accountId) ?? (a.lookaheadDays || 7)));
      const maxDayAllD = new Date(); maxDayAllD.setDate(maxDayAllD.getDate() + maxLookahead - 1);
      const groupsHtml = _calDayGroupsHtml(allEvents, '', '', '', maxDayAllD.toISOString().slice(0, 10));
      // Replace only the day-group content (keep any error banners at the top)
      const errBanners = [...panel.querySelectorAll('.dashboard-source-error')].map(el => el.outerHTML).join('');
      panel.innerHTML = errBanners + (groupsHtml || '<p class="dashboard-empty">No upcoming events.</p>');
      if (maxLookahead > 7) {
        const noteEl = document.createElement('p');
        noteEl.className = 'dash-cal-lookahead-note';
        noteEl.textContent = `Showing next ${maxLookahead} days`;
        panel.appendChild(noteEl);
      }
    } else if (sectionEl) {
      // Grouped view — update just this account's section
      const bodyEl = sectionEl.querySelector('.dash-cal-account-body');
      if (bodyEl) {
        const groupsHtml = _calDayGroupsHtml(data.events || [], accColor || null, accountId, accWebUrl || null, maxDay);
        bodyEl.innerHTML = groupsHtml || '<p class="dashboard-empty">No upcoming events.</p>';
        if (_calLookahead.get(accountId)) {
          const noteEl = document.createElement('p');
          noteEl.className = 'dash-cal-lookahead-note';
          noteEl.textContent = `Showing next ${lookahead} days`;
          bodyEl.appendChild(noteEl);
        }
      }
    }
  } catch { /* ignore — stale UI is better than a crash */ }
}

// ---- Calendar event modal wiring ----

(function _initCalEventModal() {
  const modal    = document.getElementById('calEventModal');
  const closeBtn = document.getElementById('calEventModalClose');
  const cancelBtn = document.getElementById('calEventCancelBtn');
  const saveBtn  = document.getElementById('calEventSaveBtn');

  closeBtn.addEventListener('click',  () => modal.close());
  cancelBtn.addEventListener('click', () => modal.close());
  saveBtn.addEventListener('click',   () => _submitCalEvent());

  // Keyboard: Enter submits (except in textarea), Escape closes (native for dialog)
  modal.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      _submitCalEvent();
    }
  });
})();
