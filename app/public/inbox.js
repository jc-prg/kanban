async function initInbox() {
  document.querySelector('.board-wrapper').style.display = 'none';
  document.getElementById('saveIndicator').closest('.header-actions').style.display = 'none';
  document.querySelector('.header-menu').style.marginLeft = 'auto';
  ['menuInbox', 'menuPrompts', 'menuStatistics', 'menuSettings'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });

  document.getElementById('overview').style.display = 'flex';
  try {
    const boards = await fetch('/api/boards').then(r => r.json());
    renderBoardGrid(boards);
  } catch {
    document.getElementById('boardGrid').innerHTML = '<p class="new-board-error">Failed to load boards.</p>';
  }

  const preselect = new URLSearchParams(location.search).get('board');
  await openInboxModal(preselect);
}
