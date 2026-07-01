'use strict';

// ---- Dashboard ----

let _refreshTimer = null;

// Map: cardId → { card, board } — populated on each render for context menu
const _dashCardMap = new Map();

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
  toCol.cards.unshift(movedCard);
  await fetch(`/api/${encodeURIComponent(board)}/board`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updatedColumns: [fromCol, toCol] }),
  });
}

async function initDashboard() {
  document.querySelector('.board-area').style.display = 'none';
  document.getElementById('saveIndicator').closest('.header-actions').style.display = 'none';
  document.querySelector('.header-menu').style.marginLeft = 'auto';
  document.getElementById('dashboard').style.display = 'flex';

  // Show board-switch wrap (headerHomeBtn) for navigation
  document.getElementById('boardSwitchWrap').style.display = '';

  // Show only Dashboard settings + Log out in the menu dropdown
  ['menuDashboard', 'menuInbox', 'menuFindCard', 'menuAnalytics',
   'menuStatistics', 'menuWebhook', 'menuSettings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const menuDashboardSettings = document.getElementById('menuDashboardSettings');
  menuDashboardSettings.style.display = '';
  menuDashboardSettings.addEventListener('click', () => {
    window.hideMenu();
    window.openSettings();
  });

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

  // Mail message click → detail panel
  document.getElementById('dashboardMailPanel').addEventListener('click', e => {
    const item = e.target.closest('[data-msg-id]');
    if (!item) return;
    _openMailDetail(item.dataset.accountId, item.dataset.msgId, item.dataset.webUrl || '');
  });

  // Card click → navigate to the board and open the card's edit modal
  document.getElementById('dashboardCardsPanel').addEventListener('click', e => {
    const item = e.target.closest('[data-card-id]');
    if (!item) return;
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

  await loadDashboard();

  // Set up auto-refresh based on config
  try {
    const cfg = await fetch('/api/dashboard/config').then(r => r.json());
    if (cfg.autoRefreshMs > 0) {
      _refreshTimer = setInterval(loadDashboard, cfg.autoRefreshMs);
      window.addEventListener('pagehide', () => clearInterval(_refreshTimer), { once: true });
    }
  } catch { /* ignore */ }
}

async function loadDashboard() {
  document.getElementById('dashboardFetchedAt').textContent = 'Loading\u2026';
  try {
    const res = await fetch('/api/dashboard/data');
    if (!res.ok) throw new Error('Failed');
    const { cards, mail, calendar } = await res.json();
    _renderCardsPanel(cards);
    _renderMailPanel(mail);
    _renderCalendarPanel(calendar);
    document.getElementById('dashboardFetchedAt').textContent =
      'Refreshed at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    document.getElementById('dashboardFetchedAt').textContent = 'Failed to load';
  }
}

function _renderCardsPanel(groups) {
  const panel = document.getElementById('dashboardCardsPanel');
  _dashCardMap.clear();
  if (!groups.length) {
    panel.innerHTML = '<p class="dashboard-empty">No card sources configured.</p>';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  panel.innerHTML = groups.map(group => {
    if (group.error) {
      return `<div class="dashboard-source-error">\u26a0 ${escHtml(group.board)}: ${escHtml(group.error)}</div>`;
    }
    const groupHeader =
      `<div class="dashboard-group-header">${escHtml(group.board)} \xb7 ${escHtml(group.column)}</div>`;
    if (!group.cards.length) {
      return groupHeader + '<p class="dashboard-empty">No cards.</p>';
    }
    const items = group.cards.map(card => {
      _dashCardMap.set(card.id, { card, board: group.board });
      const isOverdue = card.endDate && card.endDate < today && !card.done;
      const colorStyle = card.color ? ` style="--card-color:${escHtml(card.color)}"` : '';

      const metaParts = [];
      if (card.priority) {
        const pc = PRIORITY_COLORS[card.priority];
        metaParts.push(`<span class="priority-badge" style="background:${pc}22;color:${pc}">${PRIORITY_LABELS[card.priority]}</span>`);
      }
      if (card.description) {
        metaParts.push(`<span class="card-desc" title="Has description">${SVGICONS.description()}</span>`);
      }
      if (card.startDate || card.endDate) {
        const cls = 'card-date' + (isOverdue ? ' card-date--overdue' : '');
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

      return `<div class="dashboard-card-item card${card.done ? ' card--done' : ''}"
          data-card-id="${escHtml(card.id || '')}" data-board="${escHtml(group.board)}"${colorStyle}>
        <div class="card-body">
          <div class="card-text">${escHtml(card.text || '')}</div>
          ${metaHtml}
        </div>
      </div>`;
    }).join('');
    return groupHeader + items;
  }).join('');
}

function _renderMailPanel(accounts) {
  const panel = document.getElementById('dashboardMailPanel');

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

    const items = acc.messages.map(msg => {
      const dateStr = msg.date ? (() => {
        const d = new Date(msg.date);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}.${mm}.`;
      })() : '';
      const metaParts = [];
      if (msg.from) metaParts.push(`<span class="dashboard-mail-from">${escHtml(msg.from)}</span>`);
      if (dateStr)  metaParts.push(`<span class="card-date">${escHtml(dateStr)}</span>`);
      const metaHtml = metaParts.length ? `<div class="card-meta">${metaParts.join('')}</div>` : '';
      return `<div class="dashboard-mail-item card"
          data-account-id="${escHtml(acc.accountId)}" data-msg-id="${escHtml(msg.id)}" data-web-url="${escHtml(acc.webInterfaceUrl || '')}">
        <div class="card-body">
          <div class="card-text">${escHtml(msg.subject)}</div>
          ${metaHtml}
        </div>
      </div>`;
    }).join('');

    return header + items;
  }).join('');
}

function _openMailDetail(accountId, msgId, webUrl) {
  const detail = document.getElementById('dashboardDetail');
  const body   = document.getElementById('dashboardDetailBody');
  document.getElementById('dashboardDetailTitle').textContent = 'Loading\u2026';
  body.innerHTML = '';
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
        const baseStyle = 'body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#e2e8f0;background:#1e1e2e;padding:8px;margin:0;word-break:break-word}'
          + ' a{color:#7c6af7} img{max-width:100%;height:auto}'
          + ' blockquote{border-left:3px solid #4a4a6a;margin:8px 0;padding:0 12px;color:#94a3b8}'
          + ' pre,code{font-family:monospace;font-size:0.88em;background:#2a2a3e;padding:2px 5px;border-radius:3px}';
        const doc = iframe.contentDocument;
        doc.open();
        const safeHtml = DOMPurify.sanitize(msg.bodyHtml, { FORCE_BODY: true });
        doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head><body>${safeHtml}</body></html>`);
        doc.close();
        const resize = () => { iframe.style.height = (iframe.contentDocument.body.scrollHeight + 16) + 'px'; };
        iframe.addEventListener('load', resize);
        resize();
      } else if (msg.body) {
        const pre = document.createElement('pre');
        pre.className = 'dashboard-mail-body';
        pre.textContent = msg.body;
        body.appendChild(pre);
      }

      if (webUrl) {
        const link = document.createElement('a');
        link.href = webUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.className = 'btn'; link.style.marginTop = '12px'; link.style.display = 'inline-block';
        link.textContent = 'Open in Webmail \u2197';
        body.appendChild(link);
      }
    })
    .catch(() => { body.innerHTML = '<p class="dashboard-empty">Failed to load message.</p>'; });
}

function _renderCalendarPanel(accounts) {
  const panel = document.getElementById('dashboardCalendarPanel');

  if (!accounts.length) {
    panel.innerHTML = '<p class="dashboard-empty">No calendar accounts configured.</p>';
    return;
  }

  // Flatten events tagged with account info
  const allEvents = [];
  const errors    = [];
  for (const acc of accounts) {
    if (acc.error) {
      errors.push(`<div class="dashboard-source-error">\u26a0 ${escHtml(acc.label)}: ${escHtml(acc.error)}</div>`);
      continue;
    }
    for (const ev of (acc.events || [])) {
      allEvents.push({ ...ev, _label: acc.label, _accountId: acc.accountId, _webUrl: acc.webInterfaceUrl, _color: acc.color });
    }
  }

  // Sort by start
  allEvents.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  // Group by day label
  const todayStr    = new Date().toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  function _dayKey(ev) {
    const s = (ev.start || '').slice(0, 10);
    if (s === todayStr)    return 'Today';
    if (s === tomorrowStr) return 'Tomorrow';
    return new Date(s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  const groups = new Map();
  for (const ev of allEvents) {
    const key = _dayKey(ev);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  function _fmtTime(ev) {
    if (ev.allDay) return 'all day';
    try {
      return new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  const groupHtml = [...groups.entries()].map(([day, evs]) => {
    const header = `<div class="dashboard-group-header">${escHtml(day)}</div>`;
    const items  = evs.map(ev => {
      const colorStyle = ev._color ? ` style="--card-color:${escHtml(ev._color)}"` : '';
      const metaHtml = `<div class="card-meta"><span class="card-date">${escHtml(_fmtTime(ev))}</span><span class="dashboard-event-label">${escHtml(ev._label)}</span></div>`;
      return `<div class="dashboard-event-item card" data-account-id="${escHtml(ev._accountId)}" data-uid="${escHtml(ev.uid)}" data-web-url="${escHtml(ev._webUrl || '')}"${colorStyle}>
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
  const detail = document.getElementById('dashboardDetail');
  const body   = document.getElementById('dashboardDetailBody');
  document.getElementById('dashboardDetailTitle').textContent = 'Loading\u2026';
  body.innerHTML = '';
  detail.style.display = '';

  fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(uid)}`)
    .then(r => r.ok ? r.json() : null)
    .then(ev => {
      if (!ev) { body.innerHTML = '<p class="dashboard-empty">Event not found.</p>'; return; }
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
      if (ev.location)    rows.push(['Where',       escHtml(ev.location)]);
      if (ev.status)      rows.push(['Status',      escHtml(ev.status)]);
      if (ev.organizer)   rows.push(['Organiser',   escHtml(ev.organizer)]);
      if (ev.description) rows.push(['Description', escHtml(ev.description).replace(/\n/g, '<br>')]);

      body.innerHTML = `<table class="dashboard-detail-table">${
        rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
      }</table>`;

      if (webUrl) {
        const link = document.createElement('a');
        link.href = webUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.className = 'btn'; link.style.marginTop = '12px'; link.style.display = 'inline-block';
        link.textContent = 'Open in Calendar \u2197';
        body.appendChild(link);
      }
    })
    .catch(() => { body.innerHTML = '<p class="dashboard-empty">Failed to load event.</p>'; });
}

function _closeDetail() {
  document.getElementById('dashboardDetail').style.display = 'none';
  document.querySelector('#dashboardDetail .modal')?.classList.remove('modal--fullscreen');
}
