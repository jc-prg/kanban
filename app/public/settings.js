// ---- Title char animation ----
function initTitleChars() {
  const h1 = document.getElementById('appTitle');
  const chars = [];
  h1.childNodes.forEach(node => {
    const accent = node.nodeType === Node.ELEMENT_NODE;
    [...(node.textContent)].forEach(ch => chars.push({ ch, accent }));
  });
  h1.innerHTML = chars.map((c, i) =>
    `<span class="title-char${c.accent ? ' title-char-accent' : ''}" style="animation-delay:${i * 80}ms">${c.ch.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`
  ).join('');
}

// ---- Remote change polling ----
async function checkForUpdates() {
  if (!API || saveTimer) return;
  try {
    const r = await fetch(API);
    const remote = await r.json();
    if (JSON.stringify(remote) !== JSON.stringify(state)) {
      pendingRemote = remote;
      document.getElementById('appTitle').classList.add('has-updates');
    }
  } catch (e) { /* ignore network errors */ }
}

setInterval(checkForUpdates, 5000);

document.getElementById('appTitle').addEventListener('click', async () => {
  document.getElementById('appTitle').classList.remove('has-updates');
  if (pendingRemote && baseState) {
    clearTimeout(saveTimer);
    saveTimer = null;
    state = mergeStates(baseState, pendingRemote, state);
    baseState = JSON.parse(JSON.stringify(state));
    pendingRemote = null;
    render();
    schedulesSave();
  } else {
    await load();
  }
});

// ---- Auth ----
async function tryLogin(password) {
  const r = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const { ok, token } = await r.json();
  if (ok && token) {
    sessionStorage.setItem('kanban-auth', token);
    document.getElementById('loginBackdrop').style.display = 'none';
    await afterAuth();
  }
  return ok;
}

async function checkAuth() {
  const params = new URLSearchParams(location.search);
  const urlPwd = params.get('login');
  if (urlPwd) {
    history.replaceState({}, '', location.pathname);
    if (await tryLogin(urlPwd)) return;
  }
  const token = sessionStorage.getItem('kanban-auth');
  if (token) {
    const r = await fetch('/api/auth/verify', { headers: { 'x-auth-token': token } });
    const { ok } = await r.json();
    if (ok) { afterAuth(); return; }
    sessionStorage.removeItem('kanban-auth');
  }
  document.getElementById('loginBackdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('loginPassword').focus(), 50);
}

document.getElementById('loginSubmitBtn').addEventListener('click', async () => {
  const pwd = document.getElementById('loginPassword').value;
  const ok = await tryLogin(pwd);
  if (!ok) {
    document.getElementById('loginError').style.display = 'block';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginPassword').focus();
  }
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginSubmitBtn').click();
  document.getElementById('loginError').style.display = 'none';
});

// ---- Prompts dialog ----
(function () {
  const backdrop = document.getElementById('promptsBackdrop');
  const saveMsg  = document.getElementById('promptsSaveMsg');

  backdrop.querySelectorAll('.prompts-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      backdrop.querySelectorAll('.prompts-tab').forEach(t => t.classList.remove('active'));
      backdrop.querySelectorAll('.prompts-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      backdrop.querySelector(`.prompts-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  function setMsg(text, isError) {
    saveMsg.textContent = text;
    saveMsg.className = 'prompts-save-msg' + (isError ? ' prompts-save-msg-error' : ' prompts-save-msg-ok');
    if (text) setTimeout(() => { saveMsg.textContent = ''; saveMsg.className = 'prompts-save-msg'; }, 3000);
  }

  window.openPromptsDialog = async function () {
    backdrop.querySelectorAll('.prompts-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
    backdrop.querySelectorAll('.prompts-panel').forEach((p, i) => p.classList.toggle('active', i === 0));
    saveMsg.textContent = '';
    saveMsg.className = 'prompts-save-msg';
    document.getElementById('promptSearchProfile').value   = '';
    document.getElementById('promptCriteriaInclude').value = '';
    document.getElementById('promptCriteriaExclude').value = '';
    document.getElementById('promptSearchRadius').value    = '';
    backdrop.style.display = 'flex';
    try {
      const r = await fetch('/api/prompts');
      if (!r.ok) throw new Error();
      const data = await r.json();
      document.getElementById('promptSearchProfile').value   = data.searchProfile   || '';
      document.getElementById('promptCriteriaInclude').value = data.criteriaInclude || '';
      document.getElementById('promptCriteriaExclude').value = data.criteriaExclude || '';
      document.getElementById('promptSearchRadius').value    = data.searchRadius    || '';
    } catch {
      setMsg('Failed to load prompts.', true);
    }
  };

  function closePromptsDialog() { backdrop.style.display = 'none'; }

  document.getElementById('promptsCancelBtn').addEventListener('click', closePromptsDialog);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closePromptsDialog(); });

  document.getElementById('promptsSaveBtn').addEventListener('click', async () => {
    const body = {
      searchProfile:   document.getElementById('promptSearchProfile').value,
      criteriaInclude: document.getElementById('promptCriteriaInclude').value,
      criteriaExclude: document.getElementById('promptCriteriaExclude').value,
      searchRadius:    document.getElementById('promptSearchRadius').value,
    };
    try {
      const r = await fetch('/api/prompts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error();
      setMsg('Saved.', false);
    } catch {
      setMsg('Failed to save.', true);
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop.style.display !== 'none') closePromptsDialog();
  });
})();

// ---- Settings dialog ----
(function () {
  const backdrop = document.getElementById('settingsBackdrop');

  document.getElementById('fauxton-link').href =
    `${window.location.protocol}//${window.location.hostname}:5984/_utils`;

  if (BOARD_NAME) {
    document.getElementById('settingsTitle').textContent = `Board settings: ${BOARD_NAME}`;
    document.getElementById('menuSettings').textContent  = 'Board settings';
    document.getElementById('boardDescSection').style.display = '';
    document.getElementById('boardDescSaveBtn').style.display = '';
    document.getElementById('boardRenameSection').style.display = '';
    document.getElementById('importSection').style.display = '';
    document.getElementById('boardDeleteSection').style.display = '';
    document.getElementById('boardExportSection').style.display = '';
    document.getElementById('dbSection').style.display = 'none';
    document.getElementById('apiKeySection').style.display = 'none';
  }

  async function loadApiKey() {
    const input = document.getElementById('apiKeyDisplay');
    try {
      const r = await fetch('/api/settings');
      const { apiKey } = await r.json();
      input.value = apiKey || '';
      input.placeholder = apiKey ? '' : 'not configured — set API_KEY in .env';
    } catch {
      input.placeholder = 'failed to load';
    }
  }

  document.getElementById('apiKeyCopyBtn').addEventListener('click', () => {
    const val = document.getElementById('apiKeyDisplay').value;
    if (!val) return;
    navigator.clipboard.writeText(val).then(() => {
      const btn = document.getElementById('apiKeyCopyBtn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });

  function openSettings() {
    if (BOARD_NAME) {
      document.getElementById('boardDescription').value = state.settings?.description || '';
      document.getElementById('boardRenameInput').value = BOARD_NAME;
      document.getElementById('boardRenameError').style.display = 'none';
      document.getElementById('inboxDateToggle').checked = state.settings?.inboxWithDate ?? false;
      document.getElementById('persistCollapseToggle').checked = state.settings?.persistCollapse ?? false;
      renderTrackedCols();
    }
    loadApiKey();
    backdrop.style.display = 'flex';
  }

  function closeSettings() { backdrop.style.display = 'none'; }

  document.getElementById('menuSettings').addEventListener('click', () => {
    hideMenu();
    openSettings();
  });
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeSettings(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop.style.display !== 'none') closeSettings();
  });

  if (BOARD_NAME) {
    document.getElementById('boardRenameBtn').addEventListener('click', async () => {
      const input  = document.getElementById('boardRenameInput');
      const errEl  = document.getElementById('boardRenameError');
      const newName = input.value.trim().toLowerCase();
      errEl.style.display = 'none';
      if (!newName || newName === BOARD_NAME) return;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) {
        errEl.textContent = 'Only lowercase letters, digits and hyphens.';
        errEl.style.display = 'block';
        return;
      }
      if (newName === 'inbox') {
        errEl.textContent = '"inbox" is a reserved name.';
        errEl.style.display = 'block';
        return;
      }
      backdrop.style.display = 'none';
      if (!await showConfirm(`Rename board "${BOARD_NAME}" to "${newName}"?`, { okLabel: 'Rename' })) {
        backdrop.style.display = 'flex';
        return;
      }
      try {
        const r = await fetch(`/api/boards/${encodeURIComponent(BOARD_NAME)}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newName }),
        });
        const data = await r.json();
        if (!r.ok) { backdrop.style.display = 'flex'; errEl.textContent = data.error || 'Failed to rename.'; errEl.style.display = 'block'; return; }
        window.location.replace(`/${newName}`);
      } catch (e) {
        backdrop.style.display = 'flex'; errEl.textContent = 'Failed to rename.'; errEl.style.display = 'block';
      }
    });

    document.getElementById('boardDeleteBtn').addEventListener('click', async () => {
      backdrop.style.display = 'none';
      if (await showConfirm(`Delete board "${BOARD_NAME}" and all its cards? This cannot be undone.`, { okLabel: 'Delete', danger: true })) {
        await fetch(`/api/boards/${encodeURIComponent(BOARD_NAME)}`, { method: 'DELETE' });
        window.location.href = '/';
      } else {
        backdrop.style.display = 'flex';
      }
    });

    const saveMsg = document.getElementById('boardDescSaveMsg');
    document.getElementById('boardDescSaveBtn').addEventListener('click', () => {
      (state.settings ??= {}).description = document.getElementById('boardDescription').value.trim() || undefined;
      schedulesSave();
      saveMsg.textContent = 'Saved.';
      saveMsg.className = 'prompts-save-msg prompts-save-msg-ok';
      setTimeout(() => { saveMsg.textContent = ''; saveMsg.className = 'prompts-save-msg'; }, 2000);
    });

    document.getElementById('inboxDateToggle').addEventListener('change', e => {
      (state.settings ??= {}).inboxWithDate = e.target.checked || undefined;
      schedulesSave();
    });

    document.getElementById('persistCollapseToggle').addEventListener('change', e => {
      (state.settings ??= {}).persistCollapse = e.target.checked || undefined;
      if (!e.target.checked) state.settings.collapsedColumnIds = undefined;
      persistCollapseState();
      schedulesSave();
    });

    document.getElementById('boardExportBtn').addEventListener('click', async () => {
      const r = await fetch(API);
      const data = await r.json();
      const dt = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
      const filename = `jc-kanban-${BOARD_NAME}-${dt}.json`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    document.getElementById('boardImportBtn').addEventListener('click', async () => {
      backdrop.style.display = 'none';
      if (!await showConfirm(`Import will overwrite all data in "${BOARD_NAME}". This cannot be undone.`, { okLabel: 'Import', danger: true })) {
        backdrop.style.display = 'flex';
        return;
      }
      document.getElementById('boardImportFile').click();
    });

    function renderTrackedCols() {
      const list    = document.getElementById('trackedColsList');
      const tracked = new Set(state.settings?.trackedColumns || []);
      const defaultCol = t => /inbox/i.test(t) || /^todo$/i.test(t) || /^in.?progress$/i.test(t) || /^doing$/i.test(t);
      list.innerHTML = state.columns.filter(col => !defaultCol(col.title)).map(col => `
        <label class="tracked-col-item">
          <input type="checkbox" class="tracked-col-cb" value="${escHtml(col.title)}"${tracked.has(col.title) ? ' checked' : ''}>
          <span class="tracked-col-dot" style="background:${escHtml(col.color || 'var(--text-muted)')}"></span>
          <span class="tracked-col-name">${escHtml(col.title)}</span>
        </label>`).join('');
      list.querySelectorAll('.tracked-col-cb').forEach(cb => {
        cb.addEventListener('change', () => {
          const selected = [...list.querySelectorAll('.tracked-col-cb:checked')].map(c => c.value);
          (state.settings ??= {}).trackedColumns = selected.length ? selected : undefined;
          schedulesSave();
        });
      });
    }

    document.getElementById('boardImportFile').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); }
      catch { alert('Invalid JSON file.'); return; }
      await fetch(API, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      closeSettings();
      await load();
    });
  }
})();

// ---- After-auth routing ----
async function afterAuth() {
  if (BOARD_NAME === 'inbox') { await initInbox(); return; }
  if (BOARD_NAME) await load();
  else initOverview();
}

// ---- Overview ----
async function initOverview() {
  document.querySelector('.board-wrapper').style.display = 'none';
  document.getElementById('saveIndicator').closest('.header-actions').style.display = 'none';
  document.querySelector('.header-menu').style.marginLeft = 'auto';
  document.getElementById('menuAllBoards').style.display = 'none';
  document.getElementById('menuInbox').style.display = '';
  document.getElementById('overview').style.display = 'flex';

  try {
    const r = await fetch('/api/boards');
    const boards = await r.json();
    renderBoardGrid(boards);
  } catch (e) {
    document.getElementById('boardGrid').innerHTML = '<p class="new-board-error">Failed to load boards.</p>';
  }
}

function renderBoardGrid(boards) {
  const grid = document.getElementById('boardGrid');
  const newBoardItem = grid.querySelector('.new-board-item');
  grid.querySelectorAll('.board-card, .board-grid-empty').forEach(el => el.remove());
  if (boards.length) {
    boards.forEach(({ name, description, inboxCount, todoCount, inProgressCount, trackedCounts = [] }) => {
      const trackedBadges = trackedCounts
        .filter(t => t.count > 0)
        .map(t => {
          const style = t.color ? `background:${t.color}22;color:${t.color}` : '';
          return `<span class="board-card-count board-card-count-tracked" style="${style}">${escHtml(t.title)} ${t.count}</span>`;
        });
      const badges = [
        inboxCount      ? `<span class="board-card-count board-card-count-inbox">inbox ${inboxCount}</span>`           : '',
        todoCount       ? `<span class="board-card-count board-card-count-todo">todo ${todoCount}</span>`              : '',
        inProgressCount ? `<span class="board-card-count board-card-count-inprogress">doing ${inProgressCount}</span>` : '',
        ...trackedBadges,
      ].filter(Boolean).join('');
      const a = document.createElement('a');
      a.className = 'board-card';
      a.href = `/${escHtml(name)}`;
      a.innerHTML = `
        <div class="board-card-info">
          <span class="board-card-name">${escHtml(name)}</span>
          ${description ? `<span class="board-card-desc">${escHtml(description)}</span>` : ''}
          ${badges ? `<div class="board-card-counts">${badges}</div>` : ''}
        </div>
        <span class="board-card-arrow">→</span>`;
      grid.insertBefore(a, newBoardItem);
    });
  } else {
    const p = document.createElement('p');
    p.className = 'board-grid-empty';
    p.textContent = 'No boards yet — create one below.';
    grid.insertBefore(p, newBoardItem);
  }
}

document.getElementById('newBoardBtn').addEventListener('click', async () => {
  const input = document.getElementById('newBoardInput');
  const errEl = document.getElementById('newBoardError');
  const name  = input.value.trim().toLowerCase();
  errEl.style.display = 'none';
  if (!name) return;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    errEl.textContent = 'Use only lowercase letters, digits and hyphens.';
    errEl.style.display = 'block';
    return;
  }
  if (name === 'inbox') {
    errEl.textContent = '"inbox" is a reserved name.';
    errEl.style.display = 'block';
    return;
  }
  try {
    const r = await fetch(`/api/boards/${encodeURIComponent(name)}`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Failed to create board.'; errEl.style.display = 'block'; return; }
    window.location.href = `/${name}`;
  } catch (e) {
    errEl.textContent = 'Failed to create board.'; errEl.style.display = 'block';
  }
});

document.getElementById('newBoardInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('newBoardBtn').click();
});
