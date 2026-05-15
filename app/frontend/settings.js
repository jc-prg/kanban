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
  if (!API) return;
  try {
    const headers = boardEtag ? { 'If-None-Match': boardEtag } : {};
    const r = await fetch(API, { headers });
    if (r.status === 304) return;
    if (!r.ok) return;
    boardEtag = r.headers.get('ETag');
    const remote = await r.json();
    if (JSON.stringify(remote) === JSON.stringify(state)) return;
    if (saveTimer) {
      state = mergeStates(baseState, remote, state);
      baseState = JSON.parse(JSON.stringify(remote));
      render();
      schedulesSave();
    } else {
      state = remote;
      baseState = JSON.parse(JSON.stringify(remote));
      render();
    }
  } catch (e) { /* ignore network errors */ }
}

setInterval(checkForUpdates, 5000);

document.getElementById('appTitle').addEventListener('click', async () => {
  await load();
});

// ---- Session expiry ----
function handleSessionExpired() {
  // Avoid triggering multiple times while the login modal is already open
  if (document.getElementById('loginBackdrop').style.display !== 'none') return;
  const msg = document.getElementById('loginSessionMsg');
  if (msg) msg.style.display = '';
  document.getElementById('loginBackdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('loginPassword').focus(), 50);
}

// Periodically verify the session is still valid (every 60 s)
setInterval(async () => {
  if (document.getElementById('loginBackdrop').style.display !== 'none') return;
  try {
    const r = await fetch('/api/auth/verify');
    const { ok } = await r.json();
    if (!ok) handleSessionExpired();
  } catch { /* ignore network errors */ }
}, 60000);

// ---- Auth ----
async function tryLogin(password) {
  const r = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await r.json();
  if (r.status === 429) {
    document.getElementById('loginError').textContent = data.error || 'Too many attempts. Try again later.';
    document.getElementById('loginError').style.display = 'block';
    return false;
  }
  const { ok } = data;
  if (ok) {
    document.getElementById('loginBackdrop').style.display = 'none';
    document.getElementById('loginError').textContent = 'Wrong password.';
    await afterAuth();
  }
  return ok;
}

async function checkAuth() {
  const r = await fetch('/api/auth/verify');
  const { ok } = await r.json();
  if (ok) { afterAuth(); return; }
  document.getElementById('loginBackdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('loginPassword').focus(), 50);
}

document.getElementById('loginForm').addEventListener('submit', async () => {
  const pwd = document.getElementById('loginPassword').value;
  document.getElementById('loginError').textContent = 'Wrong password.';
  const ok = await tryLogin(pwd);
  if (!ok) {
    document.getElementById('loginError').style.display = 'block';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginPassword').focus();
  }
});

document.getElementById('loginPassword').addEventListener('focus', () => {
  const msg = document.getElementById('loginSessionMsg');
  if (msg) msg.style.display = 'none';
});

document.getElementById('loginPassword').addEventListener('keydown', () => {
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

  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const dbSection = document.getElementById('dbSection');
  if (isLocal) {
    document.getElementById('fauxton-link').href =
      `${window.location.protocol}//${window.location.hostname}:5984/_utils`;
  } else {
    dbSection.style.display = 'none';
  }

  if (BOARD_NAME) {
    document.getElementById('settingsTitle').textContent = `Board settings: ${BOARD_NAME}`;
    document.getElementById('menuSettings').textContent  = 'Board settings';
    document.getElementById('boardDescSection').style.display = '';
    document.getElementById('boardRenameSection').style.display = '';
    document.getElementById('importSection').style.display = '';
    document.getElementById('archiveSection').style.display = '';
    document.getElementById('boardDeleteSection').style.display = '';
    document.getElementById('boardExportSection').style.display = '';
    document.getElementById('dbSection').style.display = 'none';
    document.getElementById('apiKeySection').style.display = 'none';
  }

  async function loadApiKey() {
    const input = document.getElementById('apiKeyDisplay');
    document.getElementById('apiKeyCopyBtn').style.display = 'none';
    try {
      const r = await fetch('/api/settings');
      const { apiKeyConfigured } = await r.json();
      input.value = '';
      input.placeholder = apiKeyConfigured ? 'configured — see .env' : 'not configured — set API_KEY in .env';
    } catch {
      input.placeholder = 'failed to load';
    }
  }

  window.openStatsDialog = async function () {
    const el = document.getElementById('statsContent');
    el.innerHTML = '<span class="card-info-loading">Loading…</span>';
    document.getElementById('statsBackdrop').style.display = 'flex';

    function fmtSize(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      return (b / (1024 * 1024)).toFixed(1) + ' MB';
    }

    let rows;

    if (!BOARD_NAME) {
      // Overview: aggregate across all boards
      let boards = [];
      try {
        const r = await fetch('/api/boards');
        if (r.ok) boards = await r.json();
      } catch {}
      const active   = boards.filter(b => !b.archived);
      const archived = boards.filter(b =>  b.archived);
      const totalCards      = boards.reduce((s, b) => s + (b.totalCards      || 0), 0);
      const inboxCount      = boards.reduce((s, b) => s + (b.inboxCount      || 0), 0);
      const todoCount       = boards.reduce((s, b) => s + (b.todoCount       || 0), 0);
      const inProgressCount = boards.reduce((s, b) => s + (b.inProgressCount || 0), 0);

      const totalAttachSize = boards.reduce((s, b) => s + (b.attachSize || 0), 0);

      let dbSize = 0;
      try {
        const r = await fetch('/api/db-size');
        if (r.ok) ({ size: dbSize } = await r.json());
      } catch {}

      rows = [
        ['Boards',         active.length],
        ['Archived',       archived.length],
        ['Total cards',    totalCards],
        ['Attachments',    fmtSize(totalAttachSize)],
        ['Database size',  fmtSize(dbSize)],
        null, // separator
        ['Inbox',          inboxCount],
        ['Todo',           todoCount],
        ['In progress',    inProgressCount],
      ];
    } else {
      // Board view: show stats for this board only
      const totalCards = (state.columns || []).reduce((s, c) => s + c.cards.filter(card => !card.text?.startsWith('#')).length, 0);

      function countPages(pages) {
        return (pages || []).reduce((s, p) => s + 1 + countPages(p.children), 0);
      }
      const totalPages = countPages(typeof notesState !== 'undefined' ? notesState.pages : []);

      let attachCount = 0, attachSize = 0;
      try {
        const r = await fetch(`${API_BASE}/attachment-stats`);
        if (r.ok) ({ count: attachCount, size: attachSize } = await r.json());
      } catch {}

      rows = [
        ['Board',       BOARD_NAME],
        ['Cards',       totalCards],
        ['Note pages',  totalPages],
        ['Attachments', attachCount],
        ['Total size',  fmtSize(attachSize)],
      ];
    }

    el.innerHTML = `<table class="card-info-table"><tbody>${
      rows.map((row, i) => {
        if (row === null) return '';
        const sep = (i > 0 && rows[i - 1] === null) ? ' class="stats-sep"' : '';
        return `<tr${sep}><th>${row[0]}</th><td>${row[1]}</td></tr>`;
      }).join('')
    }</tbody></table>`;
  };

  function openSettings() {
    if (BOARD_NAME) {
      document.getElementById('boardDescription').value = state.settings?.description || '';
      document.getElementById('boardRenameInput').value = BOARD_NAME;
      document.getElementById('boardRenameError').style.display = 'none';
      document.getElementById('inboxDateToggle').checked       = state.settings?.inboxWithDate     ?? false;
      document.getElementById('persistCollapseToggle').checked  = state.settings?.persistCollapse   ?? false;
      document.getElementById('boardArchivedToggle').checked    = state.settings?.archived           ?? false;
      document.getElementById('autoSaveDialogsToggle').checked  = state.settings?.autoSaveDialogs   ?? false;
      document.getElementById('autoSaveIntervalInput').value    = state.settings?.autoSaveIntervalMin ?? 5;
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

    function flashSaved(indicatorId) {
      const el = document.getElementById(indicatorId);
      if (!el) return;
      el.textContent = `${ICONS.done} saved`;
      el.classList.add('settings-save-indicator--visible');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('settings-save-indicator--visible'), 1500);
    }

    let descTimer = null;
    document.getElementById('boardDescription').addEventListener('input', () => {
      clearTimeout(descTimer);
      descTimer = setTimeout(() => {
        (state.settings ??= {}).description = document.getElementById('boardDescription').value.trim() || undefined;
        schedulesSave();
        flashSaved('descSaveIndicator');
      }, 600);
    });

    document.getElementById('dateEditToggle').addEventListener('change', e => {
      dateEditMode = e.target.checked;
    });

    document.getElementById('inboxDateToggle').addEventListener('change', e => {
      (state.settings ??= {}).inboxWithDate = e.target.checked || undefined;
      schedulesSave();
      flashSaved('importSaveIndicator');
    });

    document.getElementById('boardArchivedToggle').addEventListener('change', e => {
      (state.settings ??= {}).archived = e.target.checked || undefined;
      schedulesSave();
      flashSaved('archiveSaveIndicator');
    });

    document.getElementById('persistCollapseToggle').addEventListener('change', e => {
      (state.settings ??= {}).persistCollapse = e.target.checked || undefined;
      if (!e.target.checked) state.settings.collapsedColumnIds = undefined;
      persistCollapseState();
      schedulesSave();
      flashSaved('importSaveIndicator');
    });

    document.getElementById('autoSaveDialogsToggle').addEventListener('change', e => {
      (state.settings ??= {}).autoSaveDialogs = e.target.checked || undefined;
      schedulesSave();
      flashSaved('importSaveIndicator');
    });

    document.getElementById('autoSaveIntervalInput').addEventListener('change', e => {
      const val = Math.max(1, Math.min(60, parseInt(e.target.value) || 5));
      e.target.value = val;
      (state.settings ??= {}).autoSaveIntervalMin = val === 5 ? undefined : val;
      schedulesSave();
      flashSaved('importSaveIndicator');
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

    document.getElementById('boardImportBtn').addEventListener('click', () => {
      // Open file picker synchronously inside the user-gesture handler — any await
      // before input.click() causes Firefox to revoke the file reference.
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;

        let rawText;
        try {
          rawText = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file, 'utf-8');
          });
        } catch (err) {
          alert(
            'The file could not be read.\n\n' +
            'This is usually a browser permission issue — your browser may not have access to files in this location.\n\n' +
            'Try copying the file to your home directory or Downloads folder and importing from there.'
          );
          return;
        }

        let data;
        try { data = JSON.parse(rawText); }
        catch (err) { alert('Invalid JSON file: ' + err.message); return; }

        if (isTrelloExport(data)) {
          const listCount = (data.lists || []).filter(l => !l.closed).length;
          const cardCount = (data.cards || []).filter(c => !c.closed).length;
          if (!await showConfirm(
            `Trello export detected: ${listCount} lists, ${cardCount} cards. Convert and import?`,
            { okLabel: 'Import' }
          )) return;
          data = convertTrelloExport(data);
        } else {
          if (!await showConfirm(
            `Import will overwrite all data in "${BOARD_NAME}". This cannot be undone.`,
            { okLabel: 'Import', danger: true }
          )) return;
        }

        const r = await fetch(API, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (!r.ok) { alert('Server error: ' + await r.text()); return; }
        closeSettings();
        await load();
      });
      input.click();
    });

    document.getElementById('settingsNotesExportBtn').addEventListener('click', async () => {
      if (!API_BASE) return;
      const r = await fetch(`${API_BASE}/notes/export`);
      if (!r.ok) { console.error('Export failed', r.status); return; }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `notes-${BOARD_NAME}.zip`;
      a.click();
      URL.revokeObjectURL(url);
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
          flashSaved('importSaveIndicator');
        });
      });
    }

  }
})();

// ---- Trello import ----
function isTrelloExport(data) {
  return Array.isArray(data.lists) && Array.isArray(data.cards) && !Array.isArray(data.columns);
}

function convertTrelloExport(trello) {
  const COLOR_MAP = {
    yellow: '#f59e0b', blue: '#3b82f6', green: '#10b981', orange: '#f97316',
    purple: '#7c6af7', red: '#ef4444', pink: '#ec4899', sky: '#06b6d4',
    lime: '#84cc16', black: '#374151',
  };

  const cardsByList = {};
  for (const card of (trello.cards || [])) {
    if (card.closed) continue;
    (cardsByList[card.idList] ??= []).push(card);
  }

  const columns = [...(trello.lists || [])]
    .filter(l => !l.closed)
    .sort((a, b) => a.pos - b.pos)
    .map(list => ({
      id:    'id-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join(''),
      title: list.name,
      cards: [...(cardsByList[list.id] || [])]
        .sort((a, b) => a.pos - b.pos)
        .map(card => {
          const created = new Date(parseInt(card.id.slice(0, 8), 16) * 1000)
            .toISOString().slice(0, 10);
          const color = card.labels?.[0]?.color
            ? COLOR_MAP[card.labels[0].color] || null : null;
          const c = { id: 'id-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join(''), text: card.name, created };
          if (card.desc)                c.description = card.desc;
          if (card.due)                 c.endDate     = card.due.slice(0, 10);
          if (card.dueComplete)         c.done        = true;
          if (color)                    c.color       = color;
          if (card.url && !c.text.startsWith('#')) c.link = card.url;
          return c;
        }),
    }));

  return { columns };
}

// ---- URL hash routing ----
function handleUrlHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  if (hash.startsWith('card:')) {
    const cardId = hash.slice(5);
    for (const col of state.columns) {
      const card = col.cards.find(c => c.id === cardId);
      if (card) { openEditModal(col.id, card); return; }
    }
  } else if (hash.startsWith('note:')) {
    const noteId = hash.slice(5);
    if (findNotePage(noteId, notesState.pages)) openNoteModal(noteId);
  }
}

// ---- After-auth routing ----
async function afterAuth() {
  if (BOARD_NAME === 'inbox') { await initInbox(); return; }
  if (BOARD_NAME) {
    document.title = `jc://${BOARD_NAME}/`;
    document.getElementById('boardSwitchWrap').style.display = '';
    document.getElementById('notesToggleBtn').style.display = '';
    await load();
    await loadNotes();
    loadCardAttachSet();
    handleUrlHash();
  } else initOverview();
}

// ---- Overview ----
async function initOverview() {
  document.querySelector('.board-area').style.display = 'none';
  document.getElementById('saveIndicator').closest('.header-actions').style.display = 'none';
  document.querySelector('.header-menu').style.marginLeft = 'auto';
  document.getElementById('menuInbox').style.display = '';
  document.getElementById('menuFindCard').style.display = 'none';
  document.getElementById('overview').style.display = 'flex';

  document.getElementById('achPrev').onclick = () => loadAchievements(achDayOffset - 1);
  document.getElementById('achNext').onclick = () => loadAchievements(achDayOffset + 1);

  try {
    const boardsRes = await fetch('/api/boards');
    const boards = await boardsRes.json();
    renderBoardGrid(boards);
  } catch (e) {
    document.getElementById('boardGrid').innerHTML = '<p class="new-board-error">Failed to load boards.</p>';
  }
  loadAchievements(0);
}

let achDayOffset = 0;

function achDateLabel(offset) {
  if (offset === 0)  return "Today's Achievements";
  if (offset === -1) return "Yesterday's Achievements";
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? `Achievements ${dd}.${mm}.` : `Achievements ${dd}.${mm}.${d.getFullYear()}`;
}

async function loadAchievements(offset) {
  achDayOffset = offset;
  document.getElementById('achDateLabel').textContent = achDateLabel(offset);
  document.getElementById('achNext').disabled = offset >= 0;
  document.getElementById('achPrev').disabled = true;
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const date = d.toISOString().slice(0, 10);
  try {
    const res = await fetch(`/api/achievements/today?date=${date}`);
    const ach = res.ok ? await res.json() : { created: 0, moved: 0, done: 0, hasPast: false };
    document.getElementById('achPrev').disabled = !ach.hasPast;
    renderAchievements(ach, offset);
  } catch (e) { /* ignore */ }
}

function boardsTooltip(map) {
  return Object.entries(map).map(([b, n]) => `${b}: ${n}`).join('\n');
}

function renderAchievements({ created = 0, moved = 0, done = 0, createdBoards = {}, movedBoards = {}, doneBoards = {} }, offset = 0) {
  const section = document.getElementById('achievementsSection');
  if (created === 0 && moved === 0 && done === 0 && offset === 0) { section.style.display = 'none'; return; }
  const achCreated = document.getElementById('achCreated');
  const achMoved   = document.getElementById('achMoved');
  const achDone    = document.getElementById('achDone');
  achCreated.textContent = created;
  achMoved.textContent   = moved;
  achDone.textContent    = done;
  if (created) achCreated.dataset.tooltip = boardsTooltip(createdBoards); else delete achCreated.dataset.tooltip;
  if (moved)   achMoved.dataset.tooltip   = boardsTooltip(movedBoards);   else delete achMoved.dataset.tooltip;
  if (done)    achDone.dataset.tooltip    = boardsTooltip(doneBoards);     else delete achDone.dataset.tooltip;
  section.style.display = '';
}

function makeBoardCard({ name, description, inboxCount, todoCount, inProgressCount, trackedCounts = [], archived = false }) {
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
  a.className = 'board-card' + (archived ? ' board-card--archived' : '');
  a.href = `/${escHtml(name)}`;
  a.innerHTML = `
    <div class="board-card-info">
      <span class="board-card-name">${escHtml(name)}</span>
      ${description ? `<span class="board-card-desc">${escHtml(description)}</span>` : ''}
      ${badges ? `<div class="board-card-counts">${badges}</div>` : ''}
    </div>
    <span class="board-card-arrow">→</span>`;
  return a;
}

function renderBoardGrid(boards) {
  const grid         = document.getElementById('boardGrid');
  const newBoardItem = grid.querySelector('.new-board-item');
  grid.querySelectorAll('.board-card, .board-grid-empty').forEach(el => el.remove());

  const active   = boards.filter(b => !b.archived);
  const archived = boards.filter(b =>  b.archived);

  if (active.length) {
    active.forEach(b => grid.insertBefore(makeBoardCard(b), newBoardItem));
  } else {
    const p = document.createElement('p');
    p.className = 'board-grid-empty';
    p.textContent = 'No boards yet — create one below.';
    grid.insertBefore(p, newBoardItem);
  }

  const section      = document.getElementById('archivedSection');
  const archivedGrid = document.getElementById('archivedGrid');
  if (archived.length) {
    section.style.display = '';
    archivedGrid.innerHTML = '';
    archived.forEach(b => archivedGrid.appendChild(makeBoardCard({ ...b, archived: true })));
  } else {
    section.style.display = 'none';
  }
}

document.getElementById('archivedSectionBtn')?.addEventListener('click', () => {
  const grid = document.getElementById('archivedGrid');
  const icon = document.getElementById('archivedSectionIcon');
  const open = grid.style.display === '';
  grid.style.display = open ? 'none' : '';
  icon.textContent   = open ? ICONS.expand : ICONS.collapse;
});

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

// ---- Board switcher click menu ----
(function () {
  const wrap = document.getElementById('boardSwitchWrap');
  const btn  = document.getElementById('headerHomeBtn');
  const menu = document.getElementById('boardSwitchMenu');

  async function toggleBoardMenu(e) {
    e.preventDefault();
    if (menu.classList.contains('open')) {
      menu.classList.remove('open');
      btn.classList.remove('open');
      return;
    }
    try {
      const boards = await fetch('/api/boards').then(r => r.json());
      const others = boards.filter(b => !b.archived && b.name !== BOARD_NAME);
      const allEntry = '<a class="board-switch-item" href="/">all boards</a>';
      const sep = others.length ? '<div class="header-dd-separator"></div>' : '';
      menu.innerHTML = allEntry + sep + others
        .map(b => `<a class="board-switch-item" href="/${encodeURIComponent(b.name)}">${escHtml(b.name)}</a>`)
        .join('');
    } catch { return; }
    menu.classList.add('open');
    btn.classList.add('open');
  }

  btn.addEventListener('click', toggleBoardMenu);

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) {
      menu.classList.remove('open');
      btn.classList.remove('open');
    }
  });
})();
