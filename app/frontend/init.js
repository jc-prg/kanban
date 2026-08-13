if (BOARD_NAME) {
  document.getElementById('appTitle').innerHTML = `jc://<span>${escHtml(BOARD_NAME)}</span>/`;
}
initTitleChars();
checkAuth();

// Wire up buttons that previously used inline onclick/onsubmit attributes.
document.getElementById('cardFullscreenBtn').addEventListener('click', () => toggleCardFullscreen());
document.getElementById('cardDoneBtn').addEventListener('click', () => toggleModalDone());
document.getElementById('cardDescScrollTop').addEventListener('click', () => scrollEditorToTop('cardDesc'));
document.getElementById('modalPrintBtn').addEventListener('click', () => printCardFromModal());
document.getElementById('modalCloseBtn').addEventListener('click', () => tryCloseModal());
document.getElementById('modalDeleteBtn').addEventListener('click', () => deleteCardFromModal());
document.getElementById('modalSubmitBtn').addEventListener('click', () => submitCard());
document.getElementById('loginForm').addEventListener('submit', e => e.preventDefault());
document.getElementById('twoFactorForm').addEventListener('submit', e => e.preventDefault());
document.getElementById('searchCloseBtn').addEventListener('click', () => closeSearch());
document.getElementById('cardInfoCloseBtn').addEventListener('click', () => closeCardInfo());
document.getElementById('analyticsCloseBtn').addEventListener('click', () => closeAnalytics());
document.getElementById('achHistoryCloseBtn').addEventListener('click', () => closeAchievementHistory());
document.getElementById('noteDescScrollTop').addEventListener('click', () => scrollEditorToTop('notePageDesc'));

let _hScrollTarget = 0;
let _hScrollRafId = null;

function _hScrollStep() {
  const wrapper = document.querySelector('.board-wrapper');
  if (!wrapper) { _hScrollRafId = null; return; }
  const diff = _hScrollTarget - wrapper.scrollLeft;
  if (Math.abs(diff) < 1) {
    wrapper.scrollLeft = _hScrollTarget;
    _hScrollRafId = null;
    return;
  }
  wrapper.scrollLeft += diff * 0.18;
  _hScrollRafId = requestAnimationFrame(_hScrollStep);
}

document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
  const wrapper = document.querySelector('.board-wrapper');
  if (!wrapper) return;
  if (!_hScrollRafId) _hScrollTarget = wrapper.scrollLeft;
  _hScrollTarget += e.key === 'ArrowRight' ? 320 : -320;
  const max = wrapper.scrollWidth - wrapper.clientWidth;
  _hScrollTarget = Math.max(0, Math.min(max, _hScrollTarget));
  if (!_hScrollRafId) _hScrollRafId = requestAnimationFrame(_hScrollStep);
});

document.addEventListener('wheel', e => {
  const wrapper = document.querySelector('.board-wrapper');
  if (!wrapper) return;
  if (e.target !== wrapper) return;
  const max = wrapper.scrollWidth - wrapper.clientWidth;
  if (max <= 0) return;
  e.preventDefault();
  if (!_hScrollRafId) _hScrollTarget = wrapper.scrollLeft;
  _hScrollTarget += e.deltaY !== 0 ? e.deltaY : e.deltaX;
  _hScrollTarget = Math.max(0, Math.min(max, _hScrollTarget));
  if (!_hScrollRafId) _hScrollRafId = requestAnimationFrame(_hScrollStep);
}, { passive: false });

// ---- Card-onto-notes-page drag linking ----
// Delegates to the notes module; listeners must live here (not in the module)
// because they reference kanban's touchDrag state from drag.js.
let _notesDragCard     = null;
let _notesDragOverItem = null;

document.addEventListener('dragstart', e => {
  _notesDragCard     = null;
  _notesDragOverItem = null;
  const cardEl = e.target.closest('[data-card-id]');
  const colEl  = cardEl?.closest('[data-col-id]');
  if (cardEl && colEl) _notesDragCard = { cardId: cardEl.dataset.cardId };
}, true);

document.addEventListener('dragover', e => {
  if (!_notesDragCard) return;
  const item = e.target.closest('.notes-tree-item--page');
  if (_notesDragOverItem && _notesDragOverItem !== item) {
    _notesDragOverItem.classList.remove('notes-tree-item--drag-over');
    _notesDragOverItem = null;
  }
  if (!item) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_notesDragOverItem !== item) {
    item.classList.add('notes-tree-item--drag-over');
    _notesDragOverItem = item;
  }
}, true);

document.addEventListener('drop', async e => {
  const item = _notesDragOverItem;
  if (item) item.classList.remove('notes-tree-item--drag-over');
  _notesDragOverItem = null;
  if (!item || !_notesDragCard) return;
  e.preventDefault();
  e.stopPropagation();
  const { cardId } = _notesDragCard;
  _notesDragCard = null;
  const pageId = item.dataset.itemId || item.dataset.pageId;
  await window._notesModule?.linkCardToPage(cardId, pageId);
}, true);

document.addEventListener('touchmove', e => {
  if (!touchDrag || touchDrag.type !== 'card') return;
  const t = e.touches[0];
  touchDrag.ghost.el.style.display = 'none';
  const under = document.elementFromPoint(t.clientX, t.clientY);
  touchDrag.ghost.el.style.display = '';
  const item = under?.closest('.notes-tree-item--page');
  if (_notesDragOverItem && _notesDragOverItem !== item) {
    _notesDragOverItem.classList.remove('notes-tree-item--drag-over');
    _notesDragOverItem = null;
  }
  if (item && _notesDragOverItem !== item) {
    item.classList.add('notes-tree-item--drag-over');
    _notesDragOverItem = item;
  }
}, { capture: true, passive: true });

document.addEventListener('touchend', e => {
  if (!touchDrag || touchDrag.type !== 'card') return;
  const item = _notesDragOverItem;
  _notesDragOverItem = null;
  if (!item) return;
  const { cardId } = touchDrag;
  const pageId = item.dataset.itemId || item.dataset.pageId;
  window._notesModule?.linkCardToPage(cardId, pageId);
}, true);
