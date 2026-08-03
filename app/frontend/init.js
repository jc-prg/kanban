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
document.getElementById('noteFullscreenBtn').addEventListener('click', () => toggleNoteFullscreen());
document.getElementById('noteDescScrollTop').addEventListener('click', () => scrollEditorToTop('notePageDesc'));
document.getElementById('noteModalPrintBtn').addEventListener('click', () => printNote(noteModalPageId));

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
