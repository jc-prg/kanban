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

// Map: cardId → { card, board } — populated on each render for context menu
const _dashCardMap      = new Map();
const _collapsedGroups  = new Set(); // keyed by "board\0column"
const _seededGroups     = new Set(); // groups already seeded from config
let _dashRecentLimit    = 10;

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
  ['menuFindCard', 'menuWebhook', 'menuDashboardSettings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.getElementById('menuInbox').style.display = '';

  document.getElementById('dashboardRefreshBtn').addEventListener('click', loadDashboard);
  document.getElementById('dashboardDetailClose').addEventListener('click', _closeDetail);
  document.getElementById('dashboardDetailFsBtn').addEventListener('click', () => {
    document.querySelector('#dashboardDetail .modal').classList.toggle('modal--fullscreen');
  });

  // Calendar event click → detail panel
  document.getElementById('dashboardCalendarPanel').addEventListener('click', e => {
    const item = e.target.closest('[data-uid]');
    if (!item) return;
    _openEventDetail(item.dataset.accountId, item.dataset.uid, item.dataset.webUrl || '');
  });

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

  // Card click → navigate to the board and open the card's edit modal (skipped on touch; handled by touchend below)
  document.getElementById('dashboardCardsPanel').addEventListener('click', e => {
    const item = e.target.closest('[data-card-id]');
    if (!item) return;
    if (lastInputWasTouch) return;
    window.location.href = `/board/${encodeURIComponent(item.dataset.board)}#card:${item.dataset.cardId}`;
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

  // Card touch: single tap → navigate, double tap → context menu
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
      if (_cardTap && _cardTap.el === item) {
        clearTimeout(_cardTap.timer);
        _cardTap = null;
        const entry = _dashCardMap.get(item.dataset.cardId);
        if (!entry) return;
        showDashboardContextMenu(t.clientX, t.clientY, entry.board, entry.card);
      } else {
        clearTimeout(_cardTap?.timer);
        _cardTap = { el: item, timer: setTimeout(() => {
          _cardTap = null;
          window.location.href = `/board/${encodeURIComponent(item.dataset.board)}#card:${item.dataset.cardId}`;
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

  // Fetch config first: apply panel visibility before loading any data
  try {
    const cfg = await fetch('/api/dashboard/config').then(r => r.json());
    applyDashboardPanelVisibility(cfg);
    _dashRecentLimit = cfg.recentLimit || 10;
    if (cfg.autoRefreshMs > 0) {
      _refreshTimer = setInterval(loadDashboard, cfg.autoRefreshMs);
      window.addEventListener('pagehide', () => clearInterval(_refreshTimer), { once: true });
    }
  } catch { /* ignore */ }

  _initCardsDragDrop();
  await loadDashboard();
}

async function _reloadCardsPanel() {
  try {
    const res = await fetch('/api/dashboard/cards');
    if (!res.ok) throw new Error('Failed');
    _renderCardsPanel(await res.json());
  } catch {
    document.getElementById('dashboardCardsPanel').innerHTML = '<p class="dashboard-empty">Failed to load.</p>';
  }
}

function _panelShown(id) {
  return document.getElementById(id).closest('.dashboard-panel').style.display !== 'none';
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
    ]).then(([d, a]) => _renderBoardsPanel(d, a).then(() => true)).catch(() => { document.getElementById('dashboardBoardsPanel').innerHTML = '<p class="dashboard-empty">Failed to load.</p>'; return false; }) : true,
    showCards    ? fetch('/api/dashboard/cards').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { _renderCardsPanel(d);    return true; }).catch(() => { document.getElementById('dashboardCardsPanel').innerHTML    = '<p class="dashboard-empty">Failed to load.</p>'; return false; }) : true,
    showMail     ? fetch('/api/dashboard/mail').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { _renderMailPanel(d);     return true; }).catch(() => { document.getElementById('dashboardMailPanel').innerHTML     = '<p class="dashboard-empty">Failed to load.</p>'; return false; }) : true,
    showCalendar ? fetch('/api/dashboard/calendar').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { _renderCalendarPanel(d); return true; }).catch(() => { document.getElementById('dashboardCalendarPanel').innerHTML = '<p class="dashboard-empty">Failed to load.</p>'; return false; }) : true,
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
  const panel = document.getElementById('dashboardCardsPanel');
  _dashCardMap.clear();
  const total = groups.reduce((s, g) => s + (g.cards?.filter(c => !c.text?.startsWith('#')).length || 0), 0);
  document.getElementById('dashCardsCount').textContent = total || '';
  if (!groups.length) {
    panel.innerHTML = '<p class="dashboard-empty">No card sources configured.</p>';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  panel.innerHTML = groups.map(group => {
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
    const warnD = new Date(); warnD.setDate(warnD.getDate() + 2);
    const warnDate      = warnD.toISOString().slice(0, 10);
    const hasOverdue    = visibleCards.some(c => !c.done && c.endDate && c.endDate < today);
    const hasWarning    = !hasOverdue && visibleCards.some(c => !c.done && c.endDate && c.endDate >= today && c.endDate <= warnDate);
    const countClass    = hasOverdue ? ' dash-group-count--overdue' : hasWarning ? ' dash-group-count--warning' : '';
    const groupHeader =
      `<div class="dashboard-group-header dashboard-group-header--collapsible" data-board="${escHtml(group.board)}" data-column="${escHtml(group.column)}">` +
      `<a class="dashboard-group-board-link" href="/board/${encodeURIComponent(group.board)}">${escHtml(group.board)}</a> \xb7 ${escHtml(group.column)}` +
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
  }).join('');
}

function _renderMailPanel(accounts) {
  const panel = document.getElementById('dashboardMailPanel');
  const total = accounts.reduce((s, a) => s + (a.messages?.length || 0), 0);
  document.getElementById('dashMailCount').textContent = total || '';

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
        const d = new Date(msg.date);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${dd}.${mm}. ${hh}:${mi}`;
      })() : '';
      const metaParts = [];
      if (msg.from) metaParts.push(`<span class="dashboard-mail-from">${escHtml(msg.from)}</span>`);
      if (dateStr)  metaParts.push(`<span class="card-date">${escHtml(dateStr)}</span>`);
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

function _openMailDetail(accountId, msgId, webUrl) {
  const detail    = document.getElementById('dashboardDetail');
  const body      = document.getElementById('dashboardDetailBody');
  const webUrlBtn = document.getElementById('dashboardDetailWebUrl');
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

  fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}`)
    .then(r => r.ok ? r.json() : null)
    .then(msg => {
      if (!msg) { body.innerHTML = '<p class="dashboard-empty">Message not found.</p>'; return; }
      document.getElementById('dashboardDetailTitle').textContent = msg.subject;

      const rows = [];
      if (msg.from)    rows.push(['From',    escHtml(msg.from)]);
      if (msg.to)      rows.push(['To',      escHtml(msg.to)]);
      if (msg.cc)      rows.push(['Cc',      escHtml(msg.cc)]);
      if (msg.date)    rows.push(['Date',    escHtml(new Date(msg.date).toLocaleString())]);

      body.innerHTML = `<table class="dashboard-detail-table">${
        rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
      }</table>`;

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

function _renderCalendarPanel(accounts) {
  const panel = document.getElementById('dashboardCalendarPanel');
  const total = accounts.reduce((s, a) => s + (a.events?.length || 0), 0);
  document.getElementById('dashCalendarCount').textContent = total || '';

  if (!accounts.length) {
    panel.innerHTML = '<p class="dashboard-empty">No calendar accounts configured.</p>';
    return;
  }

  // Flatten events tagged with account info
  const allEvents = [];
  const errors    = [];
  _calEventMap.clear();
  for (const acc of accounts) {
    if (acc.error) {
      errors.push(`<div class="dashboard-source-error">\u26a0 ${escHtml(acc.label)}: ${escHtml(acc.error)}</div>`);
      continue;
    }
    for (const ev of (acc.events || [])) {
      const tagged = { ...ev, _label: acc.label, _accountId: acc.accountId, _webUrl: acc.webInterfaceUrl, _color: acc.color };
      allEvents.push(tagged);
      _calEventMap.set(`${acc.accountId}\0${ev.uid}`, tagged);
    }
  }

  // Sort by start
  allEvents.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  const todayStr    = new Date().toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  function _dayLabel(dateStr) {
    if (dateStr === todayStr)    return 'Today';
    if (dateStr === tomorrowStr) return 'Tomorrow';
    return new Date(dateStr).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Group by day, expanding multi-day events across every day they span.
  // All-day DTEND is exclusive in iCal, so subtract one day for those.
  const groups = new Map(); // YYYY-MM-DD → ev[]
  for (const ev of allEvents) {
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
    let cur = new Date(startDay + 'T00:00:00Z');
    const last = new Date(endDay + 'T00:00:00Z');
    while (cur <= last) {
      const dayStr = cur.toISOString().slice(0, 10);
      if (!groups.has(dayStr)) groups.set(dayStr, []);
      groups.get(dayStr).push(ev);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  function _fmtTime(ev, dayStr) {
    if (ev.allDay) return '';
    if (dayStr !== (ev.start || '').slice(0, 10)) return 'continues';
    try {
      return new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  const groupHtml = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayStr, evs]) => {
      const day    = _dayLabel(dayStr);
      const header = `<div class="dashboard-group-header">${escHtml(day)}</div>`;
      const now = new Date();
      const items  = evs.map(ev => {
        const isPast = ev.end && new Date(ev.end) < now;
        const colorStyle = ev._color ? ` style="--card-color:${escHtml(ev._color)}"` : '';
        const metaHtml = `<div class="card-meta"><span class="card-date">${escHtml(_fmtTime(ev, dayStr))}</span><span class="dashboard-event-label">${escHtml(ev._label)}</span></div>`;
        return `<div class="dashboard-event-item card${isPast ? ' card--done' : ''}" data-account-id="${escHtml(ev._accountId)}" data-uid="${escHtml(ev.uid)}" data-web-url="${escHtml(ev._webUrl || '')}"${colorStyle}>
          <div class="card-body">
            <div class="card-text">${escHtml(ev.title)}</div>
            ${metaHtml}
          </div>
        </div>`;
      }).join('');
      return header + items;
    }).join('');

  panel.innerHTML = errors.join('') + (groupHtml || '<p class="dashboard-empty">No upcoming events.</p>');
}

// ---- Detail panel ----

function _openEventDetail(accountId, uid, webUrl) {
  const detail    = document.getElementById('dashboardDetail');
  const body      = document.getElementById('dashboardDetailBody');
  const webUrlBtn = document.getElementById('dashboardDetailWebUrl');
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
    if (ev.location)  rows.push(['Where',    escHtml(ev.location)]);
    if (ev.status)    rows.push(['Status',   escHtml(ev.status)]);
    if (ev.organizer) rows.push(['Organiser',escHtml(ev.organizer)]);
    if (ev._label)    rows.push(['Calendar', escHtml(ev._label)]);
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
  menu.style.left = Math.max(edge, Math.min(x, window.innerWidth  - mw - edge)) + 'px';
  menu.style.top  = Math.max(edge, Math.min(y, window.innerHeight - mh - edge)) + 'px';
}

function hideMailContextMenu() {
  document.getElementById('mailContextMenu').style.display = 'none';
  _mailCtxAccountId = null;
  _mailCtxMsgId     = null;
  _mailCtxUnread    = false;
}

async function _reloadMailPanel() {
  try {
    const res = await fetch('/api/dashboard/mail');
    if (!res.ok) throw new Error('Failed');
    _renderMailPanel(await res.json());
  } catch {
    document.getElementById('dashboardMailPanel').innerHTML = '<p class="dashboard-empty">Failed to load.</p>';
  }
}

function _populateFolderList(folders, listEl) {
  if (!folders.length) {
    listEl.innerHTML = '<p class="ctx-folder-loading">No folders found.</p>';
    return;
  }
  listEl.innerHTML = folders
    .map(f => `<button class="ctx-item" data-folder="${escHtml(f.path)}">${escHtml(f.name || f.path)}</button>`)
    .join('');
  listEl.querySelectorAll('[data-folder]').forEach(btn => {
    btn.addEventListener('click', () => {
      const accountId = _mailCtxAccountId;
      const msgId     = _mailCtxMsgId;
      hideMailContextMenu();
      if (accountId && msgId) _mailMove(accountId, msgId, btn.dataset.folder);
    });
  });
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
  } catch {
    _reloadMailPanel();
  }
}

async function _createCardFromMail(accountId, msgId) {
  let prefill = { text: '', description: '' };
  try {
    const msg = await fetch(
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

  await openInboxModal(null, prefill, () => _mailDelete(accountId, msgId));
}

document.getElementById('mailCtxWebmail').addEventListener('click', () => hideMailContextMenu());

document.getElementById('mailCtxCreateCard').addEventListener('click', async () => {
  const accountId = _mailCtxAccountId;
  const msgId     = _mailCtxMsgId;
  hideMailContextMenu();
  if (accountId && msgId) await _createCardFromMail(accountId, msgId);
});

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
