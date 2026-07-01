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
  handleSessionExpired();
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

  // API_BASE is non-null only on real board pages (/board/<name>); null on overview + dashboard.
  const _isBoard = !!API_BASE;

  if (_isBoard) {
    document.getElementById('settingsTitle').textContent = `Board settings: ${BOARD_NAME}`;
    document.getElementById('menuSettings').textContent  = 'Board settings';
    document.getElementById('boardRenameSection').style.display = '';
    document.getElementById('importSection').style.display = '';
    document.getElementById('archiveSection').style.display = '';
    document.getElementById('boardDeleteSection').style.display = '';
    document.getElementById('boardExportSection').style.display = '';
    document.getElementById('dbSection').style.display = 'none';
    document.getElementById('apiKeySection').style.display = 'none';
    document.getElementById('promptsSection').style.display = 'none';
    document.getElementById('iconLibrarySection').style.display = 'none';
    document.getElementById('accountsSection').style.display = 'none';
    document.getElementById('dashboardSection').style.display = 'none';
  } else {
    document.getElementById('menuSettings').textContent = 'Global settings';
    document.getElementById('webdavSection').style.display = 'none';
    document.getElementById('webhookSection').style.display = 'none';
    document.getElementById('aboutSection').style.display = '';
    document.getElementById('accountsSection').style.display = '';
    document.getElementById('dashboardSection').style.display = '';
  }

  // ---- Prompts tabs (overview only) ----
  const promptsSection = document.getElementById('promptsSection');
  promptsSection.querySelectorAll('.prompts-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      promptsSection.querySelectorAll('.prompts-tab').forEach(t => t.classList.remove('active'));
      promptsSection.querySelectorAll('.prompts-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      promptsSection.querySelector(`.prompts-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  // ---- Accounts tabs (overview only) ----
  const accountsSection = document.getElementById('accountsSection');
  accountsSection.querySelectorAll('.prompts-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      accountsSection.querySelectorAll('.prompts-tab').forEach(t => t.classList.remove('active'));
      accountsSection.querySelectorAll('.prompts-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      accountsSection.querySelector(`.prompts-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  // ---- Dashboard tabs (overview only) ----
  const dashboardSection = document.getElementById('dashboardSection');
  dashboardSection.querySelectorAll('.prompts-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      dashboardSection.querySelectorAll('.prompts-tab').forEach(t => t.classList.remove('active'));
      dashboardSection.querySelectorAll('.prompts-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      dashboardSection.querySelector(`.prompts-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  async function loadPrompts() {
    try {
      const r = await fetch('/api/prompts');
      if (!r.ok) return;
      const data = await r.json();
      document.getElementById('promptSearchProfile').value   = data.searchProfile   || '';
      document.getElementById('promptCriteriaInclude').value = data.criteriaInclude || '';
      document.getElementById('promptCriteriaExclude').value = data.criteriaExclude || '';
      document.getElementById('promptSearchRadius').value    = data.searchRadius    || '';
    } catch {}
  }

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
      if (r.ok) flashIndicator(`${ICONS.done} saved`);
    } catch {}
  });

  // ---- Nav (desktop) & accordion (mobile) ----

  function selectSettingsSection(id) {
    document.querySelectorAll('#settingsContent > .settings-section').forEach(s => {
      s.classList.toggle('settings-section--active', s.id === id);
    });
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.classList.toggle('settings-nav-item--active', btn.dataset.target === id);
    });
  }

  function buildSettingsNav() {
    const navList = document.getElementById('settingsNavList');
    const search  = document.getElementById('settingsSearch');
    navList.innerHTML = '';
    search.value = '';

    document.querySelectorAll('#settingsContent > .settings-section').forEach(s => {
      s.classList.remove('settings-section--active');
    });

    const visible = [...document.querySelectorAll('#settingsContent > .settings-section')]
      .filter(s => s.style.display !== 'none' && s.dataset.settingsLabel);

    visible.forEach(section => {
      const btn = document.createElement('button');
      btn.className = 'settings-nav-item';
      btn.textContent = section.dataset.settingsLabel;
      btn.dataset.target = section.id;
      btn.addEventListener('click', () => selectSettingsSection(section.id));
      navList.appendChild(btn);
    });

    const isDesktop = window.matchMedia('(min-width: 640px)').matches;
    if (isDesktop) {
      if (visible.length > 0) selectSettingsSection(visible[0].id);
    } else {
      visible.forEach(s => s.classList.add('settings-section--collapsed'));
    }
  }

  document.getElementById('settingsSearch').addEventListener('input', function () {
    const q = this.value.toLowerCase().trim();
    let firstMatch = null;
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
      const match = !q || btn.textContent.toLowerCase().includes(q);
      btn.style.display = match ? '' : 'none';
      if (match && !firstMatch) firstMatch = btn.dataset.target;
    });
    if (firstMatch) selectSettingsSection(firstMatch);
  });

  // Mobile accordion — toggle button collapses/expands section body
  document.querySelectorAll('.settings-section-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.settings-section').classList.toggle('settings-section--collapsed');
    });
  });

  async function loadApiKey() {
    const input = document.getElementById('apiKeyDisplay');
    document.getElementById('apiKeyCopyBtn').style.display = 'none';
    try {
      const r = await fetch('/api/settings');
      const { apiKeyConfigured, version, branch, repository } = await r.json();
      input.value = '';
      input.placeholder = apiKeyConfigured ? 'configured — see .env' : 'not configured — set API_KEY in .env';
      if (version) document.getElementById('appVersion').textContent = version;
      if (branch) document.getElementById('appBranch').textContent = branch;
      if (repository) {
        const a = document.getElementById('appGithub');
        a.href = repository;
        a.textContent = repository;
      }
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

      const notesItems = typeof notesState !== 'undefined' ? (notesState.items || notesState.pages || []) : [];
      function countItems(items) {
        let n = 0;
        for (const it of items) { if (it.type === 'folder') n += countItems(it.children || []); else n++; }
        return n;
      }
      const totalPages = countItems(notesItems);

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

  window.openSettings = openSettings;
  function openSettings() {
    if (_isBoard) {
      document.getElementById('boardDescription').value = state.settings?.description || '';
      document.getElementById('boardRenameInput').value = BOARD_NAME;
      document.getElementById('boardRenameError').style.display = 'none';
      document.getElementById('inboxDateToggle').checked       = state.settings?.inboxWithDate     ?? false;
      document.getElementById('persistCollapseToggle').checked  = state.settings?.persistCollapse   ?? false;
      document.getElementById('boardArchivedToggle').checked    = state.settings?.archived           ?? false;
      document.getElementById('autoSaveDialogsToggle').checked    = state.settings?.autoSaveDialogs     ?? false;
      document.getElementById('autoSaveIntervalInput').value      = state.settings?.autoSaveIntervalMin  ?? 5;
      document.getElementById('hideDoneInOverviewToggle').checked = state.settings?.hideDoneInOverview   ?? true;
      renderTrackedCols();
    }
    loadApiKey();
    if (_isBoard) {
      loadWebdavSettings();
      loadWebhookSettings();
    }
    if (!_isBoard) { loadPrompts(); renderIconLibrary(); loadCardSourcesSettings(); loadWebdavAccountsSettings(); loadMailSettings(); loadCalendarSettings(); }
    buildSettingsNav();
    backdrop.style.display = 'flex';
  }

  function closeSettings() { backdrop.style.display = 'none'; }

  // ---- WebDAV Notes config (board-only, references a global account) ----

  function _webdavFieldsVisible(show) {
    document.getElementById('webdavFields').style.display = show ? '' : 'none';
  }

  async function _populateWebdavAccountDropdown(selectedId) {
    const sel = document.getElementById('webdavAccount');
    try {
      const accounts = await fetch('/api/webdav-accounts').then(r => r.json());
      sel.innerHTML = '<option value="">— select account —</option>' +
        accounts.map(a => `<option value="${escHtml(a.id)}"${a.id === selectedId ? ' selected' : ''}>${escHtml(a.label || a.url || a.id)}</option>`).join('');
    } catch {
      sel.innerHTML = '<option value="">Could not load accounts</option>';
    }
  }

  async function loadWebdavSettings() {
    try {
      const r = await fetch(`/api/${BOARD_NAME}/webdav-config`);
      if (!r.ok) return;
      const cfg = await r.json();
      document.getElementById('webdavEnabledToggle').checked = cfg.enabled;
      await _populateWebdavAccountDropdown(cfg.accountId || '');
      document.getElementById('webdavSubfolder').value = cfg.subfolder || '';
      _webdavFieldsVisible(cfg.enabled);
      window.WEBDAV_CFG = cfg.enabled && cfg.accountId ? { enabled: true } : null;
    } catch (_) {}
  }

  function flashIndicator(text) {
    const el = document.getElementById('settingsSaveIndicator');
    if (!el) return;
    el.textContent = text;
    el.classList.add('settings-save-indicator--visible');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; el.classList.remove('settings-save-indicator--visible'); }, 2000);
  }

  document.getElementById('webdavEnabledToggle').addEventListener('change', function () {
    _webdavFieldsVisible(this.checked);
  });

  function _showWebdavTestResult(ok, message) {
    const el = document.getElementById('webdavTestResult');
    el.textContent = (ok ? '✓ ' : '✗ ') + message;
    el.className   = 'settings-webdav-result ' + (ok ? 'settings-webdav-result--ok' : 'settings-webdav-result--err');
    el.style.display = '';
  }

  document.getElementById('webdavTestBtn').addEventListener('click', async () => {
    const btn       = document.getElementById('webdavTestBtn');
    const resultEl  = document.getElementById('webdavTestResult');
    const accountId = document.getElementById('webdavAccount').value;
    const subfolder = document.getElementById('webdavSubfolder').value.trim();

    if (!accountId) {
      _showWebdavTestResult(false, 'Select an account first.');
      return;
    }
    btn.disabled    = true;
    btn.textContent = 'Testing…';
    resultEl.style.display = 'none';
    try {
      const r    = await fetch(`/api/${BOARD_NAME}/webdav-config/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, subfolder }),
      });
      const data = await r.json();
      _showWebdavTestResult(data.ok, data.ok ? data.message : data.error);
    } catch (e) {
      _showWebdavTestResult(false, 'Request failed: ' + e.message);
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Test connection';
    }
  });

  document.getElementById('webdavSaveBtn').addEventListener('click', async () => {
    const enabled   = document.getElementById('webdavEnabledToggle').checked;
    const accountId = document.getElementById('webdavAccount').value;
    const subfolder = document.getElementById('webdavSubfolder').value.trim();
    try {
      const r = await fetch(`/api/${BOARD_NAME}/webdav-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, accountId, subfolder }),
      });
      if (!r.ok) { flashIndicator(' error'); return; }
      await loadWebdavSettings();
      flashIndicator(`${ICONS.done} saved`);
    } catch (_) { flashIndicator(' error'); }
  });

  // Expose global loader so afterAuth can prime window.WEBDAV_CFG at startup
  window.loadWebdavSettings = loadWebdavSettings;

  // ---- WebDAV Accounts (global settings) ----

  let _wdaAccounts = [];
  let _wdaEditIdx  = -1;

  function _renderWdaList() {
    const list = document.getElementById('webdavAccountsList');
    if (!_wdaAccounts.length) {
      list.innerHTML = '<p class="settings-item-desc" style="margin:4px 0 8px">No WebDAV accounts configured.</p>';
      return;
    }
    list.innerHTML = _wdaAccounts.map((acc, i) => `
      <div class="calendar-account-row">
        <div class="calendar-account-info">
          <strong>${escHtml(acc.label || '(no label)')}</strong>
          <span class="settings-item-desc">${escHtml(acc.url || '')} · ${escHtml(acc.user || '')}</span>
        </div>
        <div class="calendar-account-actions">
          <button class="btn btn--icon" data-wda-edit="${i}" title="Edit">${SVGICONS.edit(14, 14)}</button>
          <button class="btn btn--icon" data-wda-del="${i}" title="Delete">${ICONS.close}</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-wda-edit]').forEach(btn => {
      btn.addEventListener('click', () => _openWdaForm(parseInt(btn.dataset.wdaEdit, 10)));
    });
    list.querySelectorAll('[data-wda-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.wdaDel, 10);
        const id  = _wdaAccounts[idx]?.id;
        if (!id) return;
        await fetch(`/api/webdav-accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        _wdaAccounts.splice(idx, 1);
        _renderWdaList();
        flashIndicator(`${ICONS.done} deleted`);
      });
    });
  }

  function _openWdaForm(idx) {
    _wdaEditIdx = idx;
    const acc = idx >= 0 ? _wdaAccounts[idx] : {};
    document.getElementById('wdaEditId').value   = acc.id    || '';
    document.getElementById('wdaLabel').value    = acc.label || '';
    document.getElementById('wdaUrl').value      = acc.url   || '';
    document.getElementById('wdaUser').value     = acc.user  || '';
    document.getElementById('wdaPass').value     = '';
    document.getElementById('wdaPass').placeholder = acc.hasPassword ? '••••••••' : 'password';
    document.getElementById('wdaTestResult').style.display = 'none';
    document.getElementById('webdavAccountForm').style.display = '';
  }

  function _closeWdaForm() {
    document.getElementById('webdavAccountForm').style.display = 'none';
    _wdaEditIdx = -1;
  }

  async function loadWebdavAccountsSettings() {
    try {
      _wdaAccounts = await fetch('/api/webdav-accounts').then(r => r.json());
    } catch { _wdaAccounts = []; }
    _renderWdaList();
    _closeWdaForm();
  }

  document.getElementById('webdavAccountAddBtn').addEventListener('click', () => _openWdaForm(-1));
  document.getElementById('wdaCancelBtn').addEventListener('click', _closeWdaForm);

  document.getElementById('wdaSaveBtn').addEventListener('click', async () => {
    const id    = document.getElementById('wdaEditId').value;
    const label = document.getElementById('wdaLabel').value.trim();
    const url   = document.getElementById('wdaUrl').value.trim();
    const user  = document.getElementById('wdaUser').value.trim();
    const pass  = document.getElementById('wdaPass').value;
    const body  = { label, url, user };
    if (pass) body.password = pass;
    try {
      let r;
      if (id) {
        r = await fetch(`/api/webdav-accounts/${encodeURIComponent(id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } else {
        r = await fetch('/api/webdav-accounts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await r.json();
        if (data.id) document.getElementById('wdaEditId').value = data.id;
      }
      if (!r.ok) { flashIndicator(' error'); return; }
      await loadWebdavAccountsSettings();
      flashIndicator(`${ICONS.done} saved`);
    } catch { flashIndicator(' error'); }
  });

  document.getElementById('wdaTestBtn').addEventListener('click', async () => {
    const btn      = document.getElementById('wdaTestBtn');
    const resultEl = document.getElementById('wdaTestResult');
    const id       = document.getElementById('wdaEditId').value;
    if (!id) {
      resultEl.textContent = '✗ Save the account first to test connectivity.';
      resultEl.className   = 'settings-webdav-result settings-webdav-result--err';
      resultEl.style.display = '';
      return;
    }
    btn.disabled    = true;
    btn.textContent = 'Testing…';
    resultEl.style.display = 'none';
    try {
      const r = await fetch(`/api/webdav-accounts/${encodeURIComponent(id)}/test`, { method: 'POST' });
      const d = await r.json();
      resultEl.textContent = d.ok ? `✓ ${d.message || 'Connection successful'}` : `✗ ${d.error || 'Failed'}`;
      resultEl.className   = 'settings-webdav-result ' + (d.ok ? 'settings-webdav-result--ok' : 'settings-webdav-result--err');
    } catch {
      resultEl.textContent = '✗ Request failed';
      resultEl.className   = 'settings-webdav-result settings-webdav-result--err';
    }
    resultEl.style.display = '';
    btn.disabled    = false;
    btn.textContent = 'Test connection';
  });

  // ---- Webhook config (board-only, stored server-side) ----

  function _updateWebhookMenuItem(cfg) {
    const btn = document.getElementById('menuWebhook');
    if (cfg.enabled && cfg.name && cfg.url) {
      btn.textContent  = cfg.name;
      btn.style.display = '';
    } else {
      btn.style.display = 'none';
    }
  }

  async function loadWebhookSettings() {
    if (!API_BASE) return;
    try {
      const r = await fetch(`/api/${BOARD_NAME}/webhook-config`);
      if (!r.ok) return;
      const cfg = await r.json();
      document.getElementById('webhookEnabledToggle').checked = cfg.enabled;
      document.getElementById('webhookName').value            = cfg.name   || '';
      document.getElementById('webhookUrl').value             = cfg.url    || '';
      document.getElementById('webhookMethod').value          = cfg.method || 'POST';
      _updateWebhookMenuItem(cfg);
    } catch (_) {}
  }

  window.loadWebhookSettings = loadWebhookSettings;

  document.getElementById('webhookSaveBtn').addEventListener('click', async () => {
    const enabled = document.getElementById('webhookEnabledToggle').checked;
    const name    = document.getElementById('webhookName').value.trim();
    const url     = document.getElementById('webhookUrl').value.trim();
    const method  = document.getElementById('webhookMethod').value;
    const resultEl = document.getElementById('webhookSaveResult');
    resultEl.style.display = 'none';
    try {
      const r = await fetch(`/api/${BOARD_NAME}/webhook-config`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled, name, url, method }),
      });
      const data = await r.json();
      if (!r.ok) {
        resultEl.textContent = '✗ ' + (data.error || 'Failed to save');
        resultEl.className   = 'settings-webdav-result settings-webdav-result--err';
        resultEl.style.display = '';
        return;
      }
      _updateWebhookMenuItem({ enabled, name, url });
      flashIndicator(`${ICONS.done} saved`);
    } catch (_) { flashIndicator(' error'); }
  });

  // ---- Card sources (global / dashboard view) ----

  let _cardSources = [];
  let _csEditIdx   = -1;

  let _csDragIdx = null;

  function _renderCardSourcesList() {
    const list = document.getElementById('cardSourcesList');
    if (!_cardSources.length) {
      list.innerHTML = '<p class="settings-item-desc" style="margin:4px 0 8px">No card sources configured.</p>';
      return;
    }
    list.innerHTML = _cardSources.map((cs, i) => `
      <div class="calendar-account-row cs-source-row" draggable="true" data-cs-idx="${i}">
        <span class="cs-drag-handle" title="Drag to reorder">${ICONS.dragHandle}</span>
        <div class="calendar-account-info">
          <strong>${escHtml(cs.board || '(no board)')}</strong>
          <span class="settings-item-desc">${escHtml((cs.columns || []).join(', ') || 'all columns')}</span>
        </div>
        <div class="calendar-account-actions">
          <button class="btn btn--icon" data-cs-edit="${i}" title="Edit">${SVGICONS.edit(14, 14)}</button>
          <button class="btn btn--icon" data-cs-del="${i}" title="Delete">${ICONS.close}</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-cs-edit]').forEach(btn => {
      btn.addEventListener('click', () => _openCsForm(parseInt(btn.dataset.csEdit, 10)));
    });
    list.querySelectorAll('[data-cs-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        _cardSources.splice(parseInt(btn.dataset.csDel, 10), 1);
        _renderCardSourcesList();
        _saveCardSourcesConfig();
      });
    });

    list.querySelectorAll('.cs-source-row').forEach(row => {
      const i = parseInt(row.dataset.csIdx, 10);

      row.addEventListener('dragstart', e => {
        _csDragIdx = i;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => row.classList.add('cs-row-dragging'), 0);
      });
      row.addEventListener('dragend', () => {
        _csDragIdx = null;
        list.querySelectorAll('.cs-source-row').forEach(r => r.classList.remove('cs-row-dragging', 'cs-row-drag-over'));
      });
      row.addEventListener('dragover', e => {
        if (_csDragIdx === null || _csDragIdx === i) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.cs-source-row').forEach(r => r.classList.remove('cs-row-drag-over'));
        row.classList.add('cs-row-drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('cs-row-drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        if (_csDragIdx === null || _csDragIdx === i) return;
        const [moved] = _cardSources.splice(_csDragIdx, 1);
        _cardSources.splice(i, 0, moved);
        _renderCardSourcesList();
        _saveCardSourcesConfig();
      });
    });
  }

  async function _loadCsColumns(boardName, selectedCols) {
    const colsList = document.getElementById('csColumnsList');
    colsList.innerHTML = '<span class="settings-item-desc">Loading…</span>';
    try {
      const data = await fetch(`/api/${encodeURIComponent(boardName)}/all-columns`).then(r => r.ok ? r.json() : null);
      if (!data) { colsList.innerHTML = '<span class="settings-item-desc">Could not load columns.</span>'; return; }
      const titles = Object.keys(data);
      if (!titles.length) { colsList.innerHTML = '<span class="settings-item-desc">No columns found.</span>'; return; }
      colsList.innerHTML = titles.map(t => {
        const checked = selectedCols.includes(t) ? ' checked' : '';
        return `<label><input type="checkbox" value="${escHtml(t)}"${checked}> ${escHtml(t)}</label>`;
      }).join('');
    } catch {
      colsList.innerHTML = '<span class="settings-item-desc">Could not load columns.</span>';
    }
  }

  async function _openCsForm(idx) {
    _csEditIdx = idx;
    const cs = idx >= 0 ? _cardSources[idx] : {};
    document.getElementById('csEditId').value = cs.id || '';
    document.getElementById('cardSourcesForm').style.display = '';

    // Populate board select
    const boardSel = document.getElementById('csBoard');
    boardSel.innerHTML = '<option value="">Loading…</option>';
    try {
      const boards = await fetch('/api/boards').then(r => r.json());
      boardSel.innerHTML = boards
        .filter(b => !b.archived)
        .map(b => `<option value="${escHtml(b.name)}"${b.name === cs.board ? ' selected' : ''}>${escHtml(b.name)}</option>`)
        .join('');
    } catch {
      boardSel.innerHTML = '<option value="">Could not load boards</option>';
    }

    const board = boardSel.value;
    if (board) await _loadCsColumns(board, cs.columns || []);
    else document.getElementById('csColumnsList').innerHTML = '<span class="settings-item-desc">Select a board first.</span>';
  }

  function _closeCsForm() {
    document.getElementById('cardSourcesForm').style.display = 'none';
    _csEditIdx = -1;
  }

  async function _saveCardSourcesConfig() {
    try {
      const cfg = await fetch('/api/dashboard/config').then(r => r.json());
      await fetch('/api/dashboard/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfg, cardSources: _cardSources }),
      });
      flashIndicator(`${ICONS.done} saved`);
    } catch { flashIndicator(' error'); }
  }

  async function loadCardSourcesSettings() {
    try {
      const cfg = await fetch('/api/dashboard/config').then(r => r.json());
      _cardSources = (cfg.cardSources || []).map(cs => ({ ...cs }));
      const sel = document.getElementById('dashboardAutoRefresh');
      const ms  = cfg.autoRefreshMs || 0;
      // Select the closest matching option
      const options = [...sel.options].map(o => parseInt(o.value, 10));
      sel.value = options.includes(ms) ? String(ms) : '0';
      // Panel visibility toggles (default: enabled)
      document.getElementById('dashPanelBoards').checked   = cfg.panelBoards   !== false;
      document.getElementById('dashPanelCards').checked    = cfg.panelCards    !== false;
      document.getElementById('dashPanelMail').checked     = cfg.panelMail     !== false;
      document.getElementById('dashPanelCalendar').checked = cfg.panelCalendar !== false;
    } catch {
      _cardSources = [];
    }
    _renderCardSourcesList();
    _closeCsForm();
  }

  document.getElementById('dashboardAutoRefresh').addEventListener('change', async function () {
    try {
      const cfg = await fetch('/api/dashboard/config').then(r => r.json());
      await fetch('/api/dashboard/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfg, autoRefreshMs: parseInt(this.value, 10) }),
      });
      flashIndicator(`${ICONS.done} saved`);
    } catch { flashIndicator(' error'); }
  });

  ['dashPanelBoards', 'dashPanelCards', 'dashPanelMail', 'dashPanelCalendar'].forEach(id => {
    document.getElementById(id).addEventListener('change', async function () {
      try {
        const cfg = await fetch('/api/dashboard/config').then(r => r.json());
        const key = id === 'dashPanelBoards' ? 'panelBoards' : id === 'dashPanelCards' ? 'panelCards' : id === 'dashPanelMail' ? 'panelMail' : 'panelCalendar';
        await fetch('/api/dashboard/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...cfg, [key]: this.checked }),
        });
        applyDashboardPanelVisibility({ ...cfg, [key]: this.checked });
        flashIndicator(`${ICONS.done} saved`);
      } catch { flashIndicator(' error'); }
    });
  });

  document.getElementById('cardSourcesAddBtn').addEventListener('click', () => _openCsForm(-1));
  document.getElementById('csCancelBtn').addEventListener('click', _closeCsForm);

  document.getElementById('csBoard').addEventListener('change', () => {
    const board = document.getElementById('csBoard').value;
    if (board) _loadCsColumns(board, []);
    else document.getElementById('csColumnsList').innerHTML = '<span class="settings-item-desc">Select a board first.</span>';
  });

  document.getElementById('csSaveBtn').addEventListener('click', () => {
    const id      = document.getElementById('csEditId').value || ('cs-' + Math.random().toString(36).slice(2, 10));
    const board   = document.getElementById('csBoard').value;
    if (!board) return;
    const columns = [...document.getElementById('csColumnsList').querySelectorAll('input[type=checkbox]:checked')]
      .map(cb => cb.value);
    const cs = { id, board, columns };
    if (_csEditIdx >= 0) {
      _cardSources[_csEditIdx] = cs;
    } else {
      _cardSources.push(cs);
    }
    _closeCsForm();
    _renderCardSourcesList();
    _saveCardSourcesConfig();
  });

  // ---- Mail accounts (global / dashboard view) ----

  let _mailAccounts = [];
  let _mailEditIdx  = -1;
  let _mailDragIdx  = null;
  let _mailColor    = COLORS[0];

  function _renderMailColorRow() {
    document.getElementById('mailColorRow').innerHTML = COLORS.map(c =>
      `<div class="color-swatch${c === _mailColor ? ' selected' : ''}" style="background:${c}" data-mail-color="${c}"></div>`
    ).join('');
  }

  document.getElementById('mailColorRow').addEventListener('click', e => {
    const swatch = e.target.closest('[data-mail-color]');
    if (!swatch) return;
    _mailColor = swatch.dataset.mailColor;
    _renderMailColorRow();
  });

  function _renderMailList() {
    const list = document.getElementById('mailAccountsList');
    if (!_mailAccounts.length) {
      list.innerHTML = '<p class="settings-item-desc" style="margin:4px 0 8px">No mail accounts configured.</p>';
      return;
    }
    list.innerHTML = _mailAccounts.map((acc, i) => `
      <div class="calendar-account-row cs-source-row" draggable="true" data-mail-idx="${i}">
        <span class="cs-drag-handle" title="Drag to reorder">${ICONS.dragHandle}</span>
        <div class="calendar-account-info">
          <strong>${escHtml(acc.label || '(no label)')}</strong>
          <span class="settings-item-desc">${escHtml(acc.host || '')}:${escHtml(String(acc.port || 993))} · ${escHtml(acc.user || '')}</span>
        </div>
        <div class="calendar-account-actions">
          <button class="btn btn--icon" data-mail-edit="${i}" title="Edit">${SVGICONS.edit(14, 14)}</button>
          <button class="btn btn--icon" data-mail-del="${i}" title="Delete">${ICONS.close}</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-mail-edit]').forEach(btn => {
      btn.addEventListener('click', () => _openMailForm(parseInt(btn.dataset.mailEdit, 10)));
    });
    list.querySelectorAll('[data-mail-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        _mailAccounts.splice(parseInt(btn.dataset.mailDel, 10), 1);
        _renderMailList();
        _saveMailConfig();
      });
    });

    list.querySelectorAll('.cs-source-row').forEach(row => {
      const i = parseInt(row.dataset.mailIdx, 10);

      row.addEventListener('dragstart', e => {
        _mailDragIdx = i;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => row.classList.add('cs-row-dragging'), 0);
      });
      row.addEventListener('dragend', () => {
        _mailDragIdx = null;
        list.querySelectorAll('.cs-source-row').forEach(r => r.classList.remove('cs-row-dragging', 'cs-row-drag-over'));
      });
      row.addEventListener('dragover', e => {
        if (_mailDragIdx === null || _mailDragIdx === i) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.cs-source-row').forEach(r => r.classList.remove('cs-row-drag-over'));
        row.classList.add('cs-row-drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('cs-row-drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        if (_mailDragIdx === null || _mailDragIdx === i) return;
        const [moved] = _mailAccounts.splice(_mailDragIdx, 1);
        _mailAccounts.splice(i, 0, moved);
        _renderMailList();
        _saveMailConfig();
      });
    });
  }

  function _openMailForm(idx) {
    _mailEditIdx = idx;
    const acc = idx >= 0 ? _mailAccounts[idx] : {};
    document.getElementById('mailEditId').value      = acc.id || '';
    document.getElementById('mailLabel').value       = acc.label || '';
    document.getElementById('mailHost').value        = acc.host || '';
    document.getElementById('mailPort').value        = acc.port ?? 993;
    document.getElementById('mailTls').checked       = acc.tls !== false;
    document.getElementById('mailUser').value        = acc.user || '';
    document.getElementById('mailPass').value        = '';
    document.getElementById('mailPass').placeholder  = acc.hasPassword ? '••••••••' : 'password';
    document.getElementById('mailFolder').value      = acc.folder || '';
    document.getElementById('mailMaxMessages').value = acc.maxMessages ?? 20;
    document.getElementById('mailWebUrl').value      = acc.webInterfaceUrl || '';
    _mailColor = acc.color || COLORS[0];
    _renderMailColorRow();
    document.getElementById('mailTestResult').style.display = 'none';
    document.getElementById('mailAccountForm').style.display = '';
  }

  function _closeMailForm() {
    document.getElementById('mailAccountForm').style.display = 'none';
    _mailEditIdx = -1;
  }

  async function _saveMailConfig() {
    try {
      const cfg = await fetch('/api/dashboard/config').then(r => r.json());
      await fetch('/api/dashboard/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfg, mailAccounts: _mailAccounts }),
      });
      flashIndicator(`${ICONS.done} saved`);
    } catch { flashIndicator(' error'); }
  }

  async function loadMailSettings() {
    try {
      const cfg = await fetch('/api/dashboard/config').then(r => r.json());
      _mailAccounts = (cfg.mailAccounts || []).map(a => ({ ...a }));
    } catch {
      _mailAccounts = [];
    }
    _renderMailList();
    _closeMailForm();
  }

  document.getElementById('mailAddBtn').addEventListener('click', () => _openMailForm(-1));
  document.getElementById('mailCancelAccountBtn').addEventListener('click', _closeMailForm);

  document.getElementById('mailSaveAccountBtn').addEventListener('click', () => {
    const id   = document.getElementById('mailEditId').value || ('ma-' + Math.random().toString(36).slice(2, 10));
    const pass = document.getElementById('mailPass').value;
    const acc  = {
      id,
      label:          document.getElementById('mailLabel').value.trim(),
      host:           document.getElementById('mailHost').value.trim(),
      port:           parseInt(document.getElementById('mailPort').value, 10) || 993,
      tls:            document.getElementById('mailTls').checked,
      user:           document.getElementById('mailUser').value.trim(),
      folder:         document.getElementById('mailFolder').value.trim() || undefined,
      maxMessages:    parseInt(document.getElementById('mailMaxMessages').value, 10) || 20,
      webInterfaceUrl: document.getElementById('mailWebUrl').value.trim() || undefined,
      color:          _mailColor,
    };
    if (pass) acc.password = pass;

    if (_mailEditIdx >= 0) {
      _mailAccounts[_mailEditIdx] = acc;
    } else {
      _mailAccounts.push(acc);
    }
    _closeMailForm();
    _renderMailList();
    _saveMailConfig();
  });

  document.getElementById('mailTestAccountBtn').addEventListener('click', async () => {
    const btn      = document.getElementById('mailTestAccountBtn');
    const resultEl = document.getElementById('mailTestResult');
    const id = document.getElementById('mailEditId').value;
    if (!id) {
      resultEl.textContent = '✗ Save the account first to test connectivity.';
      resultEl.className   = 'settings-webdav-result settings-webdav-result--err';
      resultEl.style.display = '';
      return;
    }
    btn.disabled    = true;
    btn.textContent = 'Testing…';
    resultEl.style.display = 'none';
    try {
      const r = await fetch(`/api/dashboard/mail/${encodeURIComponent(id)}/test`, { method: 'POST' });
      const d = await r.json();
      resultEl.textContent = d.ok ? '✓ Connection successful' : `✗ ${d.error || 'Failed'}`;
      resultEl.className   = 'settings-webdav-result ' + (d.ok ? 'settings-webdav-result--ok' : 'settings-webdav-result--err');
    } catch {
      resultEl.textContent = '✗ Request failed';
      resultEl.className   = 'settings-webdav-result settings-webdav-result--err';
    }
    resultEl.style.display = '';
    btn.disabled    = false;
    btn.textContent = 'Test connection';
  });

  // ---- Calendar accounts (global / dashboard view) ----

  let _calAccounts = [];   // in-memory list while settings modal is open
  let _calEditIdx  = -1;   // index of account being edited, -1 = new
  let _calColor    = COLORS[0];

  function _renderCalColorRow() {
    document.getElementById('calColorRow').innerHTML = COLORS.map(c =>
      `<div class="color-swatch${c === _calColor ? ' selected' : ''}" style="background:${c}" data-cal-color="${c}"></div>`
    ).join('');
  }

  document.getElementById('calColorRow').addEventListener('click', e => {
    const swatch = e.target.closest('[data-cal-color]');
    if (!swatch) return;
    _calColor = swatch.dataset.calColor;
    _renderCalColorRow();
  });

  function _renderCalendarList() {
    const list = document.getElementById('calendarAccountsList');
    if (!_calAccounts.length) {
      list.innerHTML = '<p class="settings-item-desc" style="margin:4px 0 8px">No calendar accounts configured.</p>';
      return;
    }
    list.innerHTML = _calAccounts.map((acc, i) => `
      <div class="calendar-account-row">
        <div class="calendar-account-info">
          <strong>${escHtml(acc.label || '(no label)')}</strong>
          <span class="settings-item-desc">${escHtml(acc.type === 'ical-url' ? 'iCal URL' : 'CalDAV')} · ${escHtml(acc.url || '')}</span>
        </div>
        <div class="calendar-account-actions">
          <button class="btn btn--icon" data-cal-edit="${i}" title="Edit">${SVGICONS.edit(14, 14)}</button>
          <button class="btn btn--icon" data-cal-del="${i}" title="Delete">${ICONS.close}</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-cal-edit]').forEach(btn => {
      btn.addEventListener('click', () => _openCalForm(parseInt(btn.dataset.calEdit, 10)));
    });
    list.querySelectorAll('[data-cal-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        _calAccounts.splice(parseInt(btn.dataset.calDel, 10), 1);
        _renderCalendarList();
        _saveCalendarConfig();
      });
    });
  }

  function _openCalForm(idx) {
    _calEditIdx = idx;
    const acc = idx >= 0 ? _calAccounts[idx] : {};
    document.getElementById('calEditId').value        = acc.id || '';
    document.getElementById('calLabel').value         = acc.label || '';
    document.getElementById('calType').value          = acc.type || 'caldav';
    document.getElementById('calUrl').value           = acc.url || '';
    document.getElementById('calCalendarName').value  = acc.calendarName || '';
    document.getElementById('calUser').value          = acc.user || '';
    document.getElementById('calPass').value          = '';
    document.getElementById('calPass').placeholder    = acc.hasPassword ? '••••••••' : 'password';
    document.getElementById('calWebUrl').value        = acc.webInterfaceUrl || '';
    document.getElementById('calLookahead').value     = acc.lookaheadDays ?? 7;
    _calColor = acc.color || COLORS[0];
    _renderCalColorRow();
    document.getElementById('calTestResult').style.display = 'none';
    document.getElementById('calendarAccountForm').style.display = '';
  }

  function _closeCalForm() {
    document.getElementById('calendarAccountForm').style.display = 'none';
    _calEditIdx = -1;
  }

  async function _saveCalendarConfig() {
    try {
      const cfg = await fetch('/api/dashboard/config').then(r => r.json());
      await fetch('/api/dashboard/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfg, calendarAccounts: _calAccounts }),
      });
      flashIndicator(`${ICONS.done} saved`);
    } catch { flashIndicator(' error'); }
  }

  async function loadCalendarSettings() {
    try {
      const cfg = await fetch('/api/dashboard/config').then(r => r.json());
      _calAccounts = (cfg.calendarAccounts || []).map(a => ({ ...a }));
    } catch {
      _calAccounts = [];
    }
    _renderCalendarList();
    _closeCalForm();
  }

  document.getElementById('calendarAddBtn').addEventListener('click', () => _openCalForm(-1));
  document.getElementById('calCancelAccountBtn').addEventListener('click', _closeCalForm);

  document.getElementById('calSaveAccountBtn').addEventListener('click', () => {
    const id    = document.getElementById('calEditId').value || ('ca-' + Math.random().toString(36).slice(2, 10));
    const pass  = document.getElementById('calPass').value;
    const acc   = {
      id,
      label:          document.getElementById('calLabel').value.trim(),
      type:           document.getElementById('calType').value,
      url:            document.getElementById('calUrl').value.trim(),
      calendarName:   document.getElementById('calCalendarName').value.trim() || undefined,
      user:           document.getElementById('calUser').value.trim(),
      webInterfaceUrl: document.getElementById('calWebUrl').value.trim() || undefined,
      lookaheadDays:  parseInt(document.getElementById('calLookahead').value, 10) || 7,
      color:          _calColor,
    };
    if (pass) acc.password = pass;
    // else omit — server merges existing password

    if (_calEditIdx >= 0) {
      _calAccounts[_calEditIdx] = acc;
    } else {
      _calAccounts.push(acc);
    }
    _closeCalForm();
    _renderCalendarList();
    _saveCalendarConfig();
  });

  document.getElementById('calTestAccountBtn').addEventListener('click', async () => {
    const btn      = document.getElementById('calTestAccountBtn');
    const resultEl = document.getElementById('calTestResult');
    const id = document.getElementById('calEditId').value;
    if (!id) {
      resultEl.textContent = '✗ Save the account first to test connectivity.';
      resultEl.className   = 'settings-webdav-result settings-webdav-result--err';
      resultEl.style.display = '';
      return;
    }
    btn.disabled    = true;
    btn.textContent = 'Testing…';
    resultEl.style.display = 'none';
    try {
      const r = await fetch(`/api/dashboard/calendar/${encodeURIComponent(id)}/test`, { method: 'POST' });
      const d = await r.json();
      resultEl.textContent = d.ok
        ? `✓ ${d.detail || 'Connection successful'}`
        : `✗ ${d.error || 'Failed'}`;
      resultEl.className   = 'settings-webdav-result ' + (d.ok ? 'settings-webdav-result--ok' : 'settings-webdav-result--err');
    } catch {
      resultEl.textContent = '✗ Request failed';
      resultEl.className   = 'settings-webdav-result settings-webdav-result--err';
    }
    resultEl.style.display = '';
    btn.disabled    = false;
    btn.textContent = 'Test connection';
  });

  document.getElementById('menuSettings').addEventListener('click', () => {
    hideMenu();
    openSettings();
  });
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeSettings(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop.style.display !== 'none') closeSettings();
  });

  if (_isBoard) {
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
        window.location.replace(`/board/${newName}`);
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

    function flashSaved() {
      const el = document.getElementById('settingsSaveIndicator');
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
        flashSaved();
      }, 600);
    });

    document.getElementById('dateEditToggle').addEventListener('change', e => {
      dateEditMode = e.target.checked;
    });

    document.getElementById('inboxDateToggle').addEventListener('change', e => {
      (state.settings ??= {}).inboxWithDate = e.target.checked || undefined;
      schedulesSave();
      flashSaved();
    });

    document.getElementById('boardArchivedToggle').addEventListener('change', e => {
      (state.settings ??= {}).archived = e.target.checked || undefined;
      schedulesSave();
      flashSaved();
    });

    document.getElementById('persistCollapseToggle').addEventListener('change', e => {
      (state.settings ??= {}).persistCollapse = e.target.checked || undefined;
      if (!e.target.checked) state.settings.collapsedColumnIds = undefined;
      persistCollapseState();
      schedulesSave();
      flashSaved();
    });

    document.getElementById('autoSaveDialogsToggle').addEventListener('change', e => {
      (state.settings ??= {}).autoSaveDialogs = e.target.checked || undefined;
      schedulesSave();
      flashSaved();
    });

    document.getElementById('hideDoneInOverviewToggle').addEventListener('change', e => {
      // default is true — only store explicitly when false
      (state.settings ??= {}).hideDoneInOverview = e.target.checked ? undefined : false;
      schedulesSave();
      flashSaved();
    });

    document.getElementById('autoSaveIntervalInput').addEventListener('change', e => {
      const val = Math.max(1, Math.min(60, parseInt(e.target.value) || 5));
      e.target.value = val;
      (state.settings ??= {}).autoSaveIntervalMin = val === 5 ? undefined : val;
      schedulesSave();
      flashSaved();
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
          flashSaved();
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
    if (findNotePage(noteId, notesState.items || notesState.pages || [])) {
      openNoteModal(noteId);
    } else {
      document.getElementById('noteModal').style.display = 'none';
      const loadingEl = document.getElementById('noteModalLoading');
      if (loadingEl) loadingEl.style.display = 'none';
    }
  }
}

// ---- After-auth routing ----
async function afterAuth() {
  if (location.hash.startsWith('#note:')) {
    document.getElementById('noteModal').style.display = 'flex';
    const loadingEl = document.getElementById('noteModalLoading');
    if (loadingEl) loadingEl.style.display = 'flex';
  }
  // Prime WebDAV and webhook config at startup (board-only)
  if (API_BASE && typeof loadWebdavSettings  === 'function') await loadWebdavSettings();
  if (API_BASE && typeof loadWebhookSettings === 'function') await loadWebhookSettings();
  if (BOARD_NAME === 'dashboard') { await initDashboard(); return; }
  if (BOARD_NAME === 'inbox') { await initInbox(); return; }
  if (BOARD_NAME) {
    document.title = `jc://${BOARD_NAME}/`;
    document.getElementById('boardSwitchWrap').style.display = '';
    document.getElementById('notesToggleBtn').style.display = '';
    if (window.matchMedia('(min-width: 640px)').matches)
      document.getElementById('dashboardBtn').style.display = '';
    await load();
    // If the sidebar was open on last visit, open it immediately and show a
    // loading indicator so the panel is visible while notes are being fetched.
    if (state.settings?.notesSidebarOpen) {
      const w = state.settings?.notesSidebarWidth;
      if (w >= SIDEBAR_MIN) sidebarWidth = Math.min(w, _sidebarMax());
      toggleNotesSidebar();
      const treeBody = document.getElementById('notesTreeBody');
      if (treeBody) treeBody.innerHTML = '<p class="notes-empty notes-loading">Loading\u2026</p>';
    }
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
  document.getElementById('dashboardBtn').style.display = '';
  document.getElementById('overview').style.display = 'flex';

  document.getElementById('achPrev').onclick  = () => loadAchievements(achDayOffset - 1);
  document.getElementById('achNext').onclick  = () => loadAchievements(achDayOffset + 1);
  document.getElementById('achToday').onclick = () => loadAchievements(0);

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
  document.getElementById('achNext').disabled          = offset >= 0;
  document.getElementById('achToday').style.display    = offset < 0 ? '' : 'none';
  document.getElementById('achPrev').disabled = true;
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const date = d.toISOString().slice(0, 10);
  try {
    const res = await fetch(`/api/achievements/today?date=${date}`);
    const ach = res.ok ? await res.json() : { created: 0, inboxCreated: 0, moved: 0, done: 0, hasPast: false };
    document.getElementById('achPrev').disabled = !ach.hasPast;
    renderAchievements(ach, offset);
  } catch (e) { /* ignore */ }
}

function cardsTooltip(cards) {
  const lines = cards.slice(0, 8).map(({ board, text }) => {
    const short = text.length > 35 ? text.slice(0, 35) + '…' : text;
    return `${board}: ${short}`;
  });
  if (cards.length > 8) lines.push(`${cards.length - 8} further cards …`);
  return lines.join('\n');
}

function renderAchievements({ created = 0, inboxCreated = 0, moved = 0, done = 0, createdBoards = {}, inboxCreatedBoards = {}, movedBoards = {}, doneBoards = {}, createdCards = [], inboxCreatedCards = [], movedCards = [], doneCards = [] }, offset = 0) {
  const section = document.getElementById('achievementsSection');
  if (created === 0 && moved === 0 && done === 0 && offset === 0) { section.style.display = 'none'; return; }
  const achCreated      = document.getElementById('achCreated');
  const achInboxCreated = document.getElementById('achInboxCreated');
  const achMoved        = document.getElementById('achMoved');
  const achDone         = document.getElementById('achDone');
  const displayCreated  = created - inboxCreated;
  achCreated.textContent      = displayCreated;
  achInboxCreated.textContent = inboxCreated;
  achMoved.textContent        = moved;
  achDone.textContent         = done;
  const setTileTooltip = (el, cards) => {
    const tile = el.closest('.achievement-item');
    if (cards.length) tile.dataset.tooltip = cardsTooltip(cards); else delete tile.dataset.tooltip;
  };
  setTileTooltip(achCreated,      createdCards);
  setTileTooltip(achInboxCreated, inboxCreatedCards);
  setTileTooltip(achMoved,        movedCards);
  setTileTooltip(achDone,         doneCards);
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
  a.href = `/board/${escHtml(name)}`;
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
    window.location.href = `/board/${name}`;
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
      const isDashboard = window.location.pathname === '/dashboard';
      const isDesktop = window.matchMedia('(min-width: 640px)').matches;
      const dashEntry = isDashboard || isDesktop ? '' : '<a class="board-switch-item" href="/dashboard">Dashboard</a>';
      const allEntry  = '<a class="board-switch-item" href="/">all boards</a>';
      const sep = others.length ? '<div class="header-dd-separator"></div>' : '';
      menu.innerHTML = dashEntry + allEntry + sep + others
        .map(b => `<a class="board-switch-item" href="/board/${encodeURIComponent(b.name)}">${escHtml(b.name)}</a>`)
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
