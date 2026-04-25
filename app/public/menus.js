// ---- Card context menu ----
let ctxColId = null;
let ctxCard  = null;

function showContextMenu(x, y, colId, card) {
  ctxColId = colId;
  ctxCard  = card;

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

  const trigger = document.querySelector('#contextMenu .ctx-submenu-trigger');
  trigger.classList.toggle('ctx-submenu-left', x > window.innerWidth / 2);

  const menu = document.getElementById('contextMenu');
  menu.style.display = 'block';
  const mw = menu.offsetWidth || 140;
  const mh = menu.offsetHeight || 100;
  menu.style.left = (x + mw > window.innerWidth  ? x - mw : x) + 'px';
  menu.style.top  = (y + mh > window.innerHeight ? y - mh : y) + 'px';

  const triggerRect = trigger.getBoundingClientRect();
  trigger.classList.toggle('ctx-submenu-up', triggerRect.bottom + 260 > window.innerHeight);
}

function hideContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
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
  document.getElementById('colCtxToggleContent').textContent = collapsed ? '▸  Show content' : '▾  Hide content';

  const hideWhenCollapsed = display => ['colCtxClear','colCtxDelete'].forEach(id =>
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

  const trigger = document.querySelector('#colContextMenu .ctx-submenu-trigger');
  trigger.classList.toggle('ctx-submenu-left', x > window.innerWidth / 2);

  const menu = document.getElementById('colContextMenu');
  menu.style.display = 'block';
  const mw = menu.offsetWidth || 160;
  const mh = menu.offsetHeight || 80;
  menu.style.left = (x + mw > window.innerWidth  ? x - mw : x) + 'px';
  menu.style.top  = (y + mh > window.innerHeight ? y - mh : y) + 'px';

  const triggerRect = trigger.getBoundingClientRect();
  trigger.classList.toggle('ctx-submenu-up', triggerRect.bottom + 260 > window.innerHeight);
}

function hideColContextMenu() {
  document.getElementById('colContextMenu').style.display = 'none';
  ctxHeaderColId = null;
}

function moveAllCards(fromColId, toColId) {
  const fromCol = state.columns.find(c => c.id === fromColId);
  const toCol   = state.columns.find(c => c.id === toColId);
  if (!fromCol || !toCol) return;
  toCol.cards.push(...fromCol.cards);
  fromCol.cards = [];
  render();
  schedulesSave();
}

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

  if (BOARD_NAME) document.getElementById('menuInbox').href = `/inbox?board=${encodeURIComponent(BOARD_NAME)}`;

  document.getElementById('menuPrompts').addEventListener('click', () => { closeMenu(); openPromptsDialog(); });
  document.getElementById('menuStatistics').addEventListener('click', () => { closeMenu(); alert('Statistics — coming soon'); });
})();
