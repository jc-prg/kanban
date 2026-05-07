if (BOARD_NAME) {
  document.getElementById('appTitle').innerHTML = `jc://<span>${escHtml(BOARD_NAME)}</span>/`;
}
initTitleChars();
checkAuth();

document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
  const wrapper = document.querySelector('.board-wrapper');
  if (!wrapper) return;
  wrapper.scrollBy({ left: e.key === 'ArrowRight' ? 320 : -320, behavior: 'smooth' });
});
