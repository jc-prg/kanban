if (BOARD_NAME) {
  document.getElementById('appTitle').innerHTML = `jc://<span>${escHtml(BOARD_NAME)}</span>/`;
}
initTitleChars();
checkAuth();

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
