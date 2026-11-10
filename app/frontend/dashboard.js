'use strict';

// ---- Dashboard ----

let _fetchedAtTimer = null;   // Today's "Refreshed at" indicator
let _mailCtxAccountId = null;
let _mailCtxMsgId     = null;
let _mailCtxUnread    = false;

// Map: accountId → folders array (cached per session)
const _folderCache = new Map();
// Recent folders per account, loaded from server on init and updated on move
let _serverRecentFolders = {};

// Map: "accountId\0uid" → event object — filled by the Today agenda / calendar view for instant detail view
const _calEventMap      = new Map();
// Dashboard config: default timezone for new calendar events
let _defaultTimezone    = '';
// Raw calendar account configs from /api/dashboard/config
let _calAccountsConfig  = [];
// Last-loaded account lists (Today, calendar / mail views)
let _mailAccountsMeta   = [];
let _calAccountsMeta    = [];
// Calendar event modal state
let _calModalMode    = 'create'; // 'create' | 'edit'
let _calModalAccId   = null;
let _calModalUid     = null;
let _calModalEtag    = null;
let _calModalHref    = null;
let _calModalCardRefs = null;   // hidden X-JC-KANBAN-CARD links of the edited event
let _calModalScope  = null;    // 'occurrence' | 'series' | null
let _calModalOccDate = null;    // ISO start of the occurrence being edited

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
  if (movedCard.unread) movedCard.unread = false;
  movedCard.moves = [...(movedCard.moves || []), { at: new Date().toISOString(), from: fromCol.title, to: toCol.title }];
  const actions = toCol.actions || [];
  const today = new Date().toISOString().slice(0, 10);
  if (actions.includes('markDone'))    { movedCard.done = true;  movedCard.doneAt = new Date().toISOString(); }
  if (actions.includes('markUndone'))  { movedCard.done = false; delete movedCard.doneAt; }
  if (actions.includes('setStartDate')) movedCard.startDate = today;
  if (actions.includes('setEndDate'))   movedCard.endDate   = today;
  toCol.cards.unshift(movedCard);
  await fetch(`/api/${encodeURIComponent(board)}/board`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updatedColumns: [fromCol, toCol] }),
  });
}

/** Card / mail changed from a context menu or the detail panel: refresh the Today tiles. */
function _reloadCardsPanel() { if (typeof _todayRefresh === 'function') _todayRefresh('cards'); return Promise.resolve(); }
function _reloadMailPanel()  { if (typeof _todayRefresh === 'function') _todayRefresh('mail');  return Promise.resolve(); }

/** Close / full-screen buttons of the detail panel (Today, calendar view, mail view). */
function _wireDetailPanel() {
  const close = document.getElementById('dashboardDetailClose');
  if (close.dataset.wired) return;
  close.dataset.wired = '1';
  close.addEventListener('click', _closeDetail);
  document.getElementById('dashboardDetailFsBtn').addEventListener('click', () => {
    document.querySelector('#dashboardDetail .modal').classList.toggle('modal--fullscreen');
  });
}

// ---- Overlay host on Today ----
// The calendar and mail views open directly over Today: #dashboard (which contains them and
// the detail panel) is shown while one of them is open.

/** Paths whose page hosts the calendar / mail overlays (URL state + back button). */
function _isOverlayHostPage() {
  return ROUTE === 'today';
}

let _overlayHostReady = null;
/** Today: prepare the overlays once — detail panel, config the views read from dashboard.js globals. */
function _initOverlayHost() {
  if (_overlayHostReady) return _overlayHostReady;
  document.getElementById('dashboard').classList.add('dashboard--overlay-host');
  _wireDetailPanel();
  _overlayHostReady = (async () => {
    try {
      const [cfg, recentFolders] = await Promise.all([
        fetch('/api/dashboard/config').then(r => r.json()),
        fetch('/api/dashboard/mail-recent-folders').then(r => r.ok ? r.json() : {}).catch(() => {}),
      ]);
      _defaultTimezone     = cfg.defaultTimezone || '';
      _calAccountsConfig   = cfg.calendarAccounts || [];
      _calAccountsMeta     = _calAccountsConfig.map(a => ({
        accountId: a.id, label: a.label, type: a.type || 'caldav', color: a.color || null,
        webInterfaceUrl: a.webInterfaceUrl || null, lookaheadDays: a.lookaheadDays || 7,
      }));
      _serverRecentFolders = recentFolders || {};
    } catch { /* the views fall back to their own config fetch */ }
  })();
  return _overlayHostReady;
}

/** Today: show the overlay host while the calendar or mail view is open, the page otherwise. */
function _syncOverlayHost() {
  if (ROUTE !== 'today') return;
  const open = _cvIsOpen() || _mvIsOpen();
  document.getElementById('dashboard').style.display = open ? 'flex' : 'none';
  document.getElementById('today').style.display     = open ? 'none' : 'flex';
  // Back on Today after working in a view: refresh what may have changed there
  if (!open && typeof loadToday === 'function' && _todayCfg) {
    setTimeout(() => { if (!_cvIsOpen() && !_mvIsOpen()) loadToday(); }, 0);   // not when switching views
  }
}

function _fmtRecentDate(at) {
  if (!at) return '';
  if (at.length <= 10) {
    const [y, m, d] = at.split('-');
    return `${d}.${m}.${y.slice(2)}`;
  }
  const d = new Date(at);
  if (isNaN(d)) return at.slice(0, 10);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `yesterday`;
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.`;
}

function _recentItemHtml(item) {
  const href = item.type === 'note'
    ? `${BASE_PATH}/board/${encodeURIComponent(item.board)}#note:${encodeURIComponent(item.id)}`
    : `${BASE_PATH}/board/${encodeURIComponent(item.board)}`;
  const icon = item.type === 'note' ? SVGICONS.notePages(10, 10) : SVGICONS.card(14, 10);
  const color = item.type === 'note' ? COLORS_NEUTRAL[0] : (item.color || '');
  const colorStyle = color ? ` style="--card-color:${escHtml(color)}"` : '';
  const contextLabel = item.type === 'note' ? escHtml(item.board) : `${escHtml(item.board)} \xb7 ${escHtml(item.context)}`;
  const metaHtml = `<div class="card-meta"><span class="dashboard-recent-icon">${icon}</span><span class="dashboard-recent-context">${contextLabel}</span><span class="card-date">${escHtml(_fmtRecentDate(item.at))}</span></div>`;
  return `<a class="dashboard-recent-item card" href="${href}"${colorStyle}>
    <div class="card-body">
      <div class="card-text">${escHtml(item.title)}</div>
      ${metaHtml}
    </div>
  </a>`;
}

const _mailCardRefs = new Map();   // `${accountId}\0${msgId}` → [{ board, cardId }] (Today mail rows)

function _splitAddresses(str) {
  const parts = [];
  let current = '', inQuote = false, inAngle = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if      (c === '\\' && inQuote)          { current += c + (str[++i] ?? ''); }   // escaped char in "…"
    else if (c === '"')                      { inQuote = !inQuote; current += c; }
    else if (c === '<')                      { inAngle = true;     current += c; }
    else if (c === '>')                      { inAngle = false;    current += c; }
    else if (c === ',' && !inQuote && !inAngle) {
      parts.push(current.trim()); current = '';
      if (str[i + 1] === ' ') i++;
    } else { current += c; }
  }
  if (current.trim()) parts.push(current.trim());
  // Unquoted "Doe, Jane <jane@x>" (older server responses): a fragment without any address
  // belongs to the next entry
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!/[@<]/.test(parts[i]) && i + 1 < parts.length && /</.test(parts[i + 1])) parts[i + 1] = `${parts[i]}, ${parts[i + 1]}`;
    else out.push(parts[i]);
  }
  return out;
}

/** Display name of the first address ("Doe, Jane" <j@x> → Doe, Jane); the address when there is no name. */
function _mailDisplayName(str) {
  const first = _splitAddresses(String(str || ''))[0] || '';
  const m = first.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|([^"<]*?))\s*<([^>]+)>\s*$/);
  if (!m) return first;
  return (m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]).trim() || m[3].trim();
}

function _fmtAddress(addr) {
  // "Name" <a@b> (quoted, may contain commas and \-escapes) or Name <a@b>
  const m = addr.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|([^"<]*?))\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2];
    const email = m[3].trim();
    return `<a href="mailto:${escHtml(email)}" title="${escHtml(email)}">${escHtml(name.trim() || email)}</a>`;
  }
  if (addr.includes('@')) return `<a href="mailto:${escHtml(addr)}">${escHtml(addr)}</a>`;
  return escHtml(addr);
}

function _foldAddresses(str) {
  const addrs = _splitAddresses(str).map(_fmtAddress);
  if (addrs.length <= 3) return addrs.join(', ');
  const shown  = addrs.slice(0, 3).join(', ');
  const hidden = addrs.slice(3).join(', ');
  return `${shown}<span class="dash-addr-ellipsis">, \u2026</span><span class="dash-addr-rest" hidden>, ${hidden}</span> <a href="#" class="dash-addr-toggle">more</a>`;
}

function _openMailDetail(accountId, msgId, webUrl) {
  const detail    = document.getElementById('dashboardDetail');
  const body      = document.getElementById('dashboardDetailBody');
  const webUrlBtn = document.getElementById('dashboardDetailWebUrl');
  detail.querySelector('.dash-detail-footer')?.remove();
  const _mailAccColor = _mailAccountsMeta.find(a => a.accountId === accountId)?.color;
  const _mailTitlebar = detail.querySelector('.dashboard-detail-titlebar');
  if (_mailAccColor) _mailTitlebar.style.setProperty('--detail-accent', _mailAccColor);
  else _mailTitlebar.style.removeProperty('--detail-accent');
  document.getElementById('dashboardDetailEditBtn').style.display = 'none';
  document.getElementById('dashboardDetailTitle').textContent = 'Loading\u2026';
  body.innerHTML = '';
  if (webUrl) {
    webUrlBtn.href = webUrl;
    webUrlBtn.title = 'Open in Webmail';
    webUrlBtn.style.display = '';
  } else {
    webUrlBtn.style.display = 'none';
  }
  detail.style.display = '';
  { const modal = detail.querySelector('.modal');
    const maxH  = modal.offsetHeight;
    modal.style.height    = 'auto';
    modal.style.minHeight = '450px';
    modal.style.maxHeight = maxH + 'px'; }

  fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}`)
    .then(r => r.ok ? r.json() : null)
    .then(msg => {
      if (!msg) { body.innerHTML = '<p class="dashboard-empty">Message not found.</p>'; return; }
      document.getElementById('dashboardDetailTitle').textContent = msg.subject;

      const rows = [];
      if (msg.from)    rows.push(['From',    _foldAddresses(msg.from) + _mailTrustedBadgeHtml(msg)]);
      if (msg.to)      rows.push(['To',      _foldAddresses(msg.to)]);
      if (msg.cc)      rows.push(['Cc',      _foldAddresses(msg.cc)]);
      if (msg.date)    rows.push(['Date',    escHtml(new Date(msg.date).toLocaleString())]);
      if (msg.attachments?.length) {
        const base = `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}/attachment/`;
        const links = msg.attachments.map(a => {
          const ft = _attachType(a.name);
          const ftAttr = (ft === 'image' || ft === 'pdf') ? ` data-ft="${ft}" data-name="${escHtml(a.name)}"` : '';
          return `<a href="${escHtml(base + encodeURIComponent(a.part))}" download="${escHtml(a.name)}" class="dash-attachment-link"${ftAttr}>${escHtml(a.name)}</a>`;
        }).join('');
        rows.push(['Attachments', links]);
      }
      if (msg.cardRefs?.length) rows.push([msg.cardRefs.length > 1 ? 'Cards' : 'Card', _linkedCardLinksHtml(msg.cardRefs)]);

      body.innerHTML = `<table class="dashboard-detail-table">${
        rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
      }</table>`;
      _resolveLinkedCardLinks(body);

      body.querySelectorAll('.dash-attachment-link[data-ft]').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          openAttachmentViewer(a.href, a.dataset.name, a.dataset.ft);
        });
      });

      body.querySelectorAll('.dash-addr-toggle').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const rest     = a.previousElementSibling;
          const ellipsis = rest.previousElementSibling;
          rest.hidden     = !rest.hidden;
          ellipsis.hidden = !ellipsis.hidden;
          a.textContent = rest.hidden ? 'more' : 'less';
        });
      });

      const attBase = `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}/attachment/`;
      _renderMailBody(body, msg, { attachments: {
        url:  a => attBase + encodeURIComponent(a.part),
        open: a => openAttachmentViewer(attBase + encodeURIComponent(a.part), a.name, 'image'),
      } });

    })
    .catch(() => { body.innerHTML = '<p class="dashboard-empty">Failed to load message.</p>'; });
}

/**
 * Append a mail body to `container`: HTML in a sandboxed, auto-sized iframe
 * (DOMPurify-sanitised, no scripts), plain text in a <pre>.
 * Used by the dashboard detail panel and the mail view.
 */
function _renderMailBody(container, msg, { plain = false, toggle = true, attachments = null, gallery = true } = {}) {
  // Trusted-sender badge in the From row (rendered hidden; shown once the list is known)
  if (_mailTrusted) _mailSyncTrustedBadges();
  else _mailLoadTrusted().then(_mailSyncTrustedBadges);
  // Both versions present: own TXT ⇄ </> toggle above the body (the mail view puts it in its toolbar)
  if (toggle && _mailHasBothParts(msg)) {
    const btn    = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'btn mail-format-toggle';
    const holder = document.createElement('div');
    const show = () => {
      holder.replaceChildren();
      _renderMailBody(holder, msg, { plain, toggle: false, gallery: false });
      const t = _mailFormatToggle(plain);
      btn.textContent = t.label;
      btn.title       = t.title;
      btn.setAttribute('aria-pressed', String(plain));
    };
    btn.addEventListener('click', () => { plain = !plain; show(); });
    container.append(btn, holder);
    show();
    if (gallery) _mailAppendGallery(container, msg, attachments);
    return;
  }
  if (msg.bodyHtml && !(plain && msg.body)) {
    // Own wrapper: toggling trust re-renders only the body (the detail panel container also holds the headers)
    const wrap = document.createElement('div');
    wrap.className = 'mail-body-wrap';
    container.appendChild(wrap);
    if (_mailTrusted) _renderMailHtml(wrap, msg);
    else _mailLoadTrusted().then(() => _renderMailHtml(wrap, msg));
  } else if (msg.body) {
    const pre = document.createElement('pre');
    pre.className = 'dashboard-mail-body';
    pre.textContent = msg.body;
    container.appendChild(pre);
  }
  if (gallery) _mailAppendGallery(container, msg, attachments);
}

// ---- Image attachments of trusted senders, shown below the body ----

const _MAIL_GALLERY_MAX = 30;
const _mailImgCache = new Map();   // attachment URL → object URL (oldest revoked beyond 60)

function _mailImageAttachments(msg) {
  return (msg?.attachments || []).filter(a => _attachType(a.name || '') === 'image' || /^image\//i.test(a.contentType || a.type || ''));
}

/**
 * Add the (initially empty) gallery after the body. `attachments` = { url(att), open(att) } of the
 * calling view; it fills itself once the sender is known to be trusted (see _mailRenderGallery).
 */
function _mailAppendGallery(container, msg, attachments) {
  if (!attachments || !_mailImageAttachments(msg).length) return;
  const el = document.createElement('div');
  el.className = 'mail-att-gallery';
  el.hidden = true;
  el._mailGallery = { msg, attachments };
  container.appendChild(el);
  if (_mailTrusted) _mailRenderGallery(el);
  else _mailLoadTrusted().then(() => _mailRenderGallery(el));
}

async function _mailImageUrl(url) {
  if (_mailImgCache.has(url)) return _mailImgCache.get(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const obj = URL.createObjectURL(await r.blob());
  _mailImgCache.set(url, obj);
  while (_mailImgCache.size > 60) {
    const [oldest, oldObj] = _mailImgCache.entries().next().value;
    URL.revokeObjectURL(oldObj);
    _mailImgCache.delete(oldest);
  }
  return obj;
}

/** Show the images when the sender is trusted, hide them otherwise (re-run on every trust change). */
function _mailRenderGallery(el) {
  if (!el.isConnected || !el._mailGallery) return;
  const { msg, attachments } = el._mailGallery;
  const trusted = _mailSenderTrusted(msg);
  if (el.dataset.trusted === String(trusted)) return;
  el.dataset.trusted = String(trusted);
  el.replaceChildren();
  el.hidden = !trusted;
  if (!trusted) return;
  for (const att of _mailImageAttachments(msg).slice(0, _MAIL_GALLERY_MAX)) {
    const fig = document.createElement('figure');
    fig.className = 'mail-att-figure';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mail-att-img';
    btn.title = `Open ${att.name}`;
    const img = document.createElement('img');
    img.alt = att.name || '';
    btn.appendChild(img);
    btn.addEventListener('click', () => attachments.open(att));
    const cap = document.createElement('figcaption');
    cap.textContent = att.name || '';
    fig.append(btn, cap);
    el.appendChild(fig);
    _mailImageUrl(attachments.url(att))
      .then(obj => { img.src = obj; })
      .catch(() => { fig.classList.add('mail-att-failed'); cap.textContent = `${att.name} — could not be loaded`; });
  }
}

// ---- Privacy: remote images and tracking elements ----

let _mailTrusted = null;            // Set of trusted (lower-case) sender addresses; null until loaded
let _mailTrustedLoading = null;

/** Load the trusted senders once (a failure leaves the cache empty for this session's next try). */
function _mailLoadTrusted() {
  if (_mailTrusted) return Promise.resolve(_mailTrusted);
  if (!_mailTrustedLoading) {
    _mailTrustedLoading = fetch('/api/dashboard/mail-trusted-senders')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => (_mailTrusted = new Set(d.senders || [])))
      .catch(() => new Set())
      .finally(() => { _mailTrustedLoading = null; });
  }
  return _mailTrustedLoading.then(set => _mailTrusted || set);
}

async function _mailSetTrusted(address, trusted) {
  const r = await fetch('/api/dashboard/mail-trusted-senders', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, trusted }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  _mailTrusted = new Set((await r.json()).senders || []);
  _mailSyncTrustedBadges();
}

/** Small icon after the sender in a From row; hidden until _mailSyncTrustedBadges finds the sender trusted. */
function _mailTrustedBadgeHtml(msg) {
  const addr = _mailSenderAddr(msg);
  if (!addr) return '';
  return `<span class="mail-trusted-badge" data-mail-sender="${escHtml(addr)}" title="Trusted sender — remote images are loaded" aria-label="Trusted sender"`
    + `${_mailTrusted?.has(addr) ? '' : ' hidden'}>${SVGICONS.shieldCheck(12, 12)}</span>`;
}

/** Show / hide every trusted-sender badge on the page according to the cached list. */
function _mailSyncTrustedBadges() {
  document.querySelectorAll('.mail-trusted-badge[data-mail-sender]').forEach(el => {
    el.hidden = !_mailTrusted?.has(el.dataset.mailSender);
  });
  document.querySelectorAll('.mail-att-gallery').forEach(_mailRenderGallery);   // image attachments follow the trust
}

/** Bare lower-case address of the first sender ("Name <a@b>" or "a@b"), '' if none. */
function _mailSenderAddr(msg) {
  const from = String(msg?.from || '');
  const m = from.match(/<([^<>\s]+@[^<>\s]+)>/) || from.match(/[^\s<>",;]+@[^\s<>",;]+/);
  return m ? (m[1] || m[0]).toLowerCase() : '';
}

/** True when the sender of `msg` is trusted (remote images may load). */
function _mailSenderTrusted(msg) {
  const addr = _mailSenderAddr(msg);
  return !!addr && !!_mailTrusted?.has(addr);
}

/**
 * Remote images of `msg` may load: trusted sender, or "Load images" ticked for this mail only
 * (`_jcLoadImages` lives on the message object — reopening the mail blocks them again).
 */
function _mailImagesAllowed(msg) {
  return !!msg?._jcLoadImages || _mailSenderTrusted(msg);
}

const _MAIL_REMOTE_RE       = /^\s*(https?:)?\/\//i;
// Hosts that only serve open/click tracking (image CDNs of the same providers are not listed)
const _MAIL_TRACKER_HOST_RE = /(^|\.)(list-manage\.com|sendgrid\.net|mandrillapp\.com|mailgun\.org|mailjet\.com|mjt\.lu|sparkpostmail\.com|hubspotemail\.net|hs-analytics\.net|exct\.net|exacttarget\.com|doubleclick\.net|google-analytics\.com|mailtrack\.io|mixmax\.com|yesware\.com|getnotify\.com|bananatag\.com|returnpath\.net|emltrk\.com|litmus\.com|cmail\d+\.com|createsend\d*\.com|mlsend\.com|klclick\d*\.com|rs6\.net|ct\.sendgrid\.net)$|^(track|tracking|trk|pixel|beacon|open|opens|email-open|click|clicks|links?)\./i;
const _MAIL_TRACKER_PATH_RE = /\/(open|opens|track|tracking|trk|pixel|beacon|wf\/open)(\/|\.gif|\.png|\?|$)|\/(open|pixel|track|beacon|spacer|blank|t)\.(gif|png)(\?|$)/i;

function _mailUrlHost(url) {
  try { return new URL(url.trim().replace(/^\/\//, 'https://')).hostname; } catch { return ''; }
}

/** Reason when a remote URL / element looks like a tracker, else ''. */
function _mailTrackerReason(url, el) {
  const host = _mailUrlHost(url);
  if (host && _MAIL_TRACKER_HOST_RE.test(host)) return 'tracker host';
  if (el && el.tagName === 'IMG') {
    const dim = name => {
      const attr = el.getAttribute(name);
      const css  = (el.getAttribute('style') || '').match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, 'i'));
      const v = css ? css[1] : attr;
      return v != null && /^\s*\d+(\.\d+)?\s*(px)?\s*$/i.test(v) ? parseFloat(v) : null;
    };
    const w = dim('width'), h = dim('height');
    if ((w !== null || h !== null) && (w === null || w <= 2) && (h === null || h <= 2)) return w === 0 || h === 0 ? 'invisible image' : '1×1 pixel';
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (/(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0*)?\s*(;|$)|max-(height|width)\s*:\s*0(px)?\s*(;|$))/i.test(n.getAttribute('style') || '')) return 'hidden image';
    }
  }
  if (_MAIL_TRACKER_PATH_RE.test(url.replace(/^[^/]*\/\/[^/]+/, ''))) return 'tracking URL';
  return '';
}

/**
 * Remove remote / tracking resources from CSS text. Trackers are always
 * removed, other remote url() only when !loadImages; @import is always dropped.
 */
function _mailScrubCss(css, loadImages, out) {
  return String(css || '')
    .replace(/@import\s+(url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi, (m, target) => {
      // Imported stylesheets are always dropped; listed with the blocked URLs but not counted as images
      out.urls.add(target.replace(/^url\(\s*|\s*\)$/g, '').replace(/^(['"])(.*)\1$/, '$2'));
      return '';
    })
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, url) => {
      if (!_MAIL_REMOTE_RE.test(url)) return m;
      const reason = _mailTrackerReason(url, null);
      if (reason) { out.trackers.push({ host: _mailUrlHost(url), reason: 'CSS ' + reason }); return 'none'; }
      out.remote++;
      if (!loadImages) { out.blocked++; out.urls.add(url.trim()); return 'none'; }
      return m;
    });
}

/**
 * Sanitise mail HTML for display: DOMPurify, then remove every tracking element
 * (always) and remote images / backgrounds / CSS urls (unless `loadImages`).
 * Returns { html, styles, bodyClass, remote, blocked, blockedUrls, trackers: [{ host, reason }] }:
 * `remote` = remote images / backgrounds in the mail (loaded or not), `blocked` = those removed.
 */
function _mailPrivacyHtml(html, { loadImages = false } = {}) {
  const out = { remote: 0, blocked: 0, urls: new Set(), trackers: [] };
  let styles = '', bodyClass = '';
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    styles    = [...parsed.querySelectorAll('style')].map(st => st.textContent).join('\n');
    bodyClass = parsed.body.className || '';
  } catch { /* keep defaults */ }
  styles = _mailScrubCss(styles, loadImages, out);

  const body = DOMPurify.sanitize(html, { FORCE_BODY: true, RETURN_DOM: true });
  body.querySelectorAll('style').forEach(st => st.remove());   // already collected (and scrubbed) above
  const record = (url, reason) => out.trackers.push({ host: _mailUrlHost(url) || url.slice(0, 60), reason });

  for (const el of [...body.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    if (el.tagName === 'A') el.setAttribute('rel', 'noopener noreferrer');   // DOMPurify already drops `ping`
    let counted = false;   // one remote image per element (src + srcset of the same <img> count once)
    for (const attr of ['src', 'srcset', 'poster', 'background', 'data', 'dynsrc', 'lowsrc']) {
      const val = el.getAttribute(attr);
      if (val == null) continue;
      const urls = attr === 'srcset' ? val.split(',').map(p => p.trim().split(/\s+/)[0]) : [val];
      const remote = urls.filter(u => _MAIL_REMOTE_RE.test(u));
      if (!remote.length) continue;
      const reason = remote.map(u => _mailTrackerReason(u, el)).find(Boolean);
      if (reason) {
        record(remote[0], reason);
        if (el.tagName === 'IMG' || el.tagName === 'SOURCE') { el.remove(); break; }
        el.removeAttribute(attr);
        continue;
      }
      const counts = !counted && attr !== 'data' && attr !== 'dynsrc' && attr !== 'lowsrc';
      if (counts) { counted = true; out.remote++; }
      if (!loadImages) {
        el.removeAttribute(attr);
        remote.forEach(u => out.urls.add(u.trim()));
        if (counts) out.blocked++;
        if (el.tagName === 'IMG') {
          el.setAttribute('data-jc-blocked', '');
          // Placeholder tooltip: which image was blocked
          if (attr === 'src') el.setAttribute('title', `Blocked: ${remote[0].trim()}${el.getAttribute('title') ? `\n${el.getAttribute('title')}` : ''}`);
        }
      }
    }
    if (!el.isConnected) continue;
    const style = el.getAttribute('style');
    if (style && /url\(/i.test(style)) el.setAttribute('style', _mailScrubCss(style, loadImages, out));
  }
  return { html: body.innerHTML, styles, bodyClass, remote: out.remote, blocked: out.blocked, blockedUrls: [...out.urls], trackers: out.trackers };
}

/** Content-Security-Policy of the mail iframe — the safety net behind _mailPrivacyHtml. */
function _mailCsp(loadImages) {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: cid:${loadImages ? ' https: http:' : ''}; font-src data:${loadImages ? ' https:' : ''}`;
}

/** Tooltip text of the tracker shield: "3 tracking elements blocked:\n• 1×1 pixel — host". */
function _mailTrackerTitle(trackers) {
  const counts = new Map();
  for (const t of trackers) {
    const key = `${t.reason} — ${t.host}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const lines = [...counts].map(([k, n]) => `• ${k}${n > 1 ? ` (×${n})` : ''}`);
  return `${trackers.length} tracking element${trackers.length > 1 ? 's' : ''} blocked:\n${lines.join('\n')}`;
}

/** HTML body in a sandboxed iframe, with the privacy bar (trust toggle, tracker shield) above it. */
function _renderMailHtml(wrap, msg) {
  wrap.replaceChildren();
  const sender  = _mailSenderAddr(msg);
  const trusted = _mailSenderTrusted(msg);
  const load    = trusted || !!msg._jcLoadImages;
  const res     = _mailPrivacyHtml(msg.bodyHtml, { loadImages: load });

  // Only mails with remote images get the images part (count / "Images loaded" + checkboxes), trusted or not
  const hasImages = res.remote > 0;
  if (hasImages || res.trackers.length || res.blockedUrls.length) {
    const bar = document.createElement('div');
    bar.className = 'mail-privacy-bar';
    if (res.trackers.length) {
      const shield = document.createElement('span');
      shield.className = 'mail-privacy-shield';
      shield.innerHTML = SVGICONS.shield(14, 14);
      shield.title = _mailTrackerTitle(res.trackers);
      shield.setAttribute('aria-label', shield.title);
      shield.tabIndex = 0;
      bar.appendChild(shield);
    }
    // With blocked content the text is a toggle that lists the blocked URLs (plain text — never fetched)
    const text = document.createElement(res.blockedUrls.length ? 'button' : 'span');
    text.className = 'mail-privacy-text';
    if (res.blocked) {
      // "N remote images blocked"; phones hide the middle part → "N blocked"
      const long = document.createElement('span');
      long.className = 'mail-privacy-long';
      long.textContent = ` remote image${res.blocked > 1 ? 's' : ''}`;
      text.append(String(res.blocked), long, ' blocked');
      text.setAttribute('aria-label', `${res.blocked}${long.textContent} blocked`);
    } else if (load && hasImages) {
      // "Images loaded (trusted sender)" / "(this time)"; phones → "Images loaded"
      const long = document.createElement('span');
      long.className = 'mail-privacy-long';
      long.textContent = trusted ? ' (trusted sender)' : ' (this time)';
      text.append('Images loaded', long);
    } else {
      text.textContent = res.trackers.length ? 'Tracking blocked' : 'Remote styles blocked';
    }
    bar.appendChild(text);
    let urlList = null;
    if (res.blockedUrls.length) {
      text.type = 'button';
      text.classList.add('mail-privacy-toggle');
      text.title = 'Show the blocked URLs';
      text.setAttribute('aria-expanded', 'false');
      urlList = document.createElement('ul');
      urlList.className = 'mail-privacy-urls';
      urlList.hidden = true;
      for (const u of res.blockedUrls) {
        const li = document.createElement('li');
        li.textContent = u;
        urlList.appendChild(li);
      }
      text.addEventListener('click', () => {
        urlList.hidden = !urlList.hidden;
        text.setAttribute('aria-expanded', String(!urlList.hidden));
      });
    }
    if (hasImages) {
      // "Load images" (this mail only); once ticked, "Trust sender" (always, saved) appears next to it
      const opts = document.createElement('span');
      opts.className = 'mail-privacy-opts';
      const checkbox = (cls, label, title, checked, onChange) => {
        const el = document.createElement('label');
        el.className = `mail-privacy-trust ${cls}`;
        el.title = title;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.addEventListener('change', () => onChange(cb));
        el.append(cb, document.createTextNode(` ${label}`));
        opts.appendChild(el);
        return cb;
      };
      const loadCb = checkbox('mail-privacy-load', 'Load images',
        trusted ? 'Always loaded for trusted senders' : 'Load the remote images of this mail once', load, cb => {
          msg._jcLoadImages = cb.checked;
          _renderMailHtml(wrap, msg);
        });
      loadCb.disabled = trusted;   // a trusted sender's images always load — untrust first
      if (load) {
        const trustCb = checkbox('mail-privacy-trust-sender', 'Trust sender',
          sender ? `Always load remote images from ${sender}` : 'No sender address', trusted, async cb => {
            cb.disabled = true;
            try {
              await _mailSetTrusted(sender, cb.checked);
              msg._jcLoadImages = true;   // untrusting keeps this mail's images loaded
              _renderMailHtml(wrap, msg);
            } catch {
              cb.checked  = !cb.checked;
              cb.disabled = false;
              text.textContent = 'Could not save the trusted sender';
            }
          });
        trustCb.disabled = !sender;
      }
      bar.appendChild(opts);
    }
    if (urlList) bar.appendChild(urlList);
    wrap.appendChild(bar);
  }

  const iframe = document.createElement('iframe');
  iframe.className = 'dashboard-mail-iframe';
  // allow-same-origin lets us write content and read scrollHeight;
  // scripts are still blocked (no allow-scripts), so this is safe.
  iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox allow-same-origin');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  wrap.appendChild(iframe);
  const baseStyle = 'body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#222;background:white;padding:8px;margin:0;word-break:break-word}'
    + ' a{color:#4f46e5} img{max-width:100%;height:auto}'
    + ' img[data-jc-blocked]{display:inline-block;min-width:16px;min-height:16px;background:#f0f0f0;outline:1px dashed #ccc;outline-offset:-1px}'
    + ' blockquote{border-left:3px solid #ddd;margin:8px 0;padding:0 12px;color:#555}'
    + ' pre,code{font-family:monospace;font-size:0.88em;background:#f0f0f0;padding:2px 5px;border-radius:3px}';
  const emailStyleTag = res.styles ? `<style>${res.styles.replace(/<\/style/gi, '<\\/style')}</style>` : '';
  const bodyAttr = res.bodyClass ? ` class="${res.bodyClass.replace(/"/g, '&quot;')}"` : '';
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${_mailCsp(load)}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${baseStyle}</style>${emailStyleTag}</head><body${bodyAttr}>${res.html}</body></html>`;
  const resize = () => { iframe.style.height = (iframe.contentDocument.body.scrollHeight + 16) + 'px'; };
  iframe.addEventListener('load', resize);
}

/** True when a mail has both an HTML and a non-empty plain-text part. */
function _mailHasBothParts(msg) {
  return !!(msg?.bodyHtml && msg.body && msg.body.trim());
}

/** Label / tooltip of the format toggle: shows the version a click switches to. */
function _mailFormatToggle(plain) {
  return plain
    ? { label: '</>', title: 'Show HTML version' }
    : { label: 'TXT', title: 'Show plain-text version' };
}

// ---- Detail panel ----

async function _resolveDashCardAttachments(container, board, cardId) {
  const base = `/api/${encodeURIComponent(board)}/cards/attachments/${encodeURIComponent(cardId)}`;
  for (const img of container.querySelectorAll('img[src^="attachment:"]')) {
    const fn = img.getAttribute('src').slice('attachment:'.length);
    try {
      const r = await fetch(`${base}/${encodeURIComponent(fn)}`);
      if (!r.ok) continue;
      const obj = URL.createObjectURL(await r.blob());
      if (_attachType(fn) === 'pdf') {
        const embed = document.createElement('embed');
        embed.src = obj; embed.type = 'application/pdf'; embed.className = 'md-pdf-embed';
        img.replaceWith(embed);
      } else {
        img.src = obj;
      }
    } catch { /* ignore */ }
  }
  for (const a of container.querySelectorAll('a[href^="attachment:"]')) {
    const fn = a.getAttribute('href').slice('attachment:'.length);
    const url = `${base}/${encodeURIComponent(fn)}`;
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
    const ft = _attachType(fn);
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (ft === 'image' || ft === 'pdf') openAttachmentViewer(url, fn, ft);
      else _downloadAttachment(url, fn);
    });
  }
}

function _dashMarkRead(board, card) {
  if (!card.unread) return;
  card.unread = false;
  document.querySelectorAll(`.dashboard-card-item[data-card-id="${CSS.escape(card.id)}"]`).forEach(el => el.classList.remove('card--unread'));
  _dashPatchCard(board, card.id, c => { c.unread = false; }).catch(() => {});
}

async function _openCardDetail(board, card) {
  _dashMarkRead(board, card);
  const detail    = document.getElementById('dashboardDetail');
  const body      = document.getElementById('dashboardDetailBody');
  const editBtn   = document.getElementById('dashboardDetailEditBtn');
  const webUrlBtn = document.getElementById('dashboardDetailWebUrl');
  detail.querySelector('.dash-detail-footer')?.remove();
  const _cardTitlebar = detail.querySelector('.dashboard-detail-titlebar');
  if (card.color) _cardTitlebar.style.setProperty('--detail-accent', card.color);
  else _cardTitlebar.style.removeProperty('--detail-accent');

  document.getElementById('dashboardDetailTitle').textContent = card.text || '';
  // href kept for middle-click / new tab; a plain click edits in place (Today)
  editBtn.href = `${BASE_PATH}/board/${encodeURIComponent(board)}#card:${encodeURIComponent(card.id)}`;
  editBtn.onclick = e => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    _closeDetail();
    _todayEditCard(board, card.id);
  };
  editBtn.style.display = '';
  webUrlBtn.style.display = 'none';
  body.innerHTML = '';
  detail.style.display = '';
  { const modal = detail.querySelector('.modal');
    const maxH  = modal.offsetHeight;
    modal.style.height    = 'auto';
    modal.style.minHeight = '450px';
    modal.style.maxHeight = maxH + 'px'; }

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  rows.push(['Board', escHtml(board)]);

  if (card.priority) {
    const pc = PRIORITY_COLORS[card.priority];
    const pl = PRIORITY_LABELS[card.priority];
    rows.push(['Priority', `<span class="priority-badge" style="background:${pc}22;color:${pc}">${escHtml(pl)}</span>`]);
  }

  if (card.startDate || card.endDate) {
    let dateStr;
    if (card.startDate && card.endDate) dateStr = `${fmtDate(card.startDate)} \u2192 ${fmtDate(card.endDate)}`;
    else if (card.startDate)            dateStr = `${fmtDate(card.startDate)} \u2192`;
    else                                dateStr = `\u2192 ${fmtDate(card.endDate)}`;
    const isOverdue = card.endDate && card.endDate < today && !card.done;
    rows.push(['Date', `<span${isOverdue ? ' style="color:#ef4444"' : ''}>${escHtml(dateStr)}</span>`]);
  }

  if (card.done) {
    rows.push(['Status', `<span class="card-done-mark">${ICONS.done} done</span>`]);
  }

  if (card.created) {
    rows.push(['Created', escHtml(fmtDate(card.created))]);
  }

  if (card.link) {
    const safe = safeLink(card.link);
    if (safe) rows.push(['Link', `<a href="${escHtml(safe)}" target="_blank" rel="noopener noreferrer">${escHtml(card.link)}</a>`]);
  }

  body.innerHTML = `<table class="dashboard-detail-table">${
    rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
  }</table>`;

  // Fetch full card (description is a boolean flag in dashboard API), attachments and linked notes in parallel
  const [boardData, attachments, notesDoc] = await Promise.all([
    fetch(`/api/${encodeURIComponent(board)}/board`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`/api/${encodeURIComponent(board)}/cards/attachments/${encodeURIComponent(card.id)}`)
      .then(r => r.ok ? r.json() : []).catch(() => []),
    card.hasLinkedNotes
      ? fetch(`/api/${encodeURIComponent(board)}/notes`).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Get full description from board data
  let fullDescription = '';
  if (boardData) {
    for (const col of boardData.columns || []) {
      const found = col.cards.find(c => c.id === card.id);
      if (found) { fullDescription = found.description || ''; break; }
    }
  }

  if (fullDescription) {
    const div = document.createElement('div');
    div.className = 'cm-preview card-desc-preview dash-card-desc-preview';
    div.innerHTML = renderMarkdown(fullDescription);
    body.appendChild(div);
    // buildToc is exposed by the notes module, which isn't initialised in focus mode
    if (window.buildToc) window.buildToc(div);
    _resolveDashCardAttachments(div, board, card.id);
  }

  const fullCard = (boardData?.columns || []).flatMap(c => c.cards || []).find(c => c.id === card.id);
  // Mail the card was created from
  const mailRef = fullCard?.mailRef;
  if (mailRef) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th>Mail</th><td><a href="${escHtml(mailRefUrl(mailRef))}" class="dash-linked-mail">${escHtml(mailRef.subject || '(no subject)')}</a></td>`;
    tr.querySelector('a').addEventListener('click', e => {
      if (typeof openMailViewMessage !== 'function') return;   // fall back to navigation
      e.preventDefault();
      _closeDetail();
      openMailViewMessage(mailRef.accountId, mailRef.messageId, mailRef.folder);
    });
    body.querySelector('.dashboard-detail-table tbody, .dashboard-detail-table')?.appendChild(tr);
  }

  // Calendar event the card was created from
  const calRef = fullCard?.calEvent;
  if (calRef) {
    const cached = _calEventMap.get(`${calRef.accountId}\0${calRef.uid}`);
    const tr = document.createElement('tr');
    tr.innerHTML = `<th>Event</th><td><a href="#" class="dash-linked-event">${escHtml(cached?.title || 'Open event')}</a></td>`;
    tr.querySelector('a').addEventListener('click', e => {
      e.preventDefault();
      _openEventDetail(calRef.accountId, calRef.uid, cached?._webUrl || '');
    });
    body.querySelector('.dashboard-detail-table tbody, .dashboard-detail-table')?.appendChild(tr);
  }

  // Collect pages that link to this card
  const linkedPages = [];
  function _collectLinked(items) {
    for (const item of items || []) {
      if (item.type === 'page' && item.linkedCards?.includes(card.id)) linkedPages.push(item);
      if (item.children) _collectLinked(item.children);
    }
  }
  _collectLinked(notesDoc?.items);

  if (attachments.length) {
    const fmtSize = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
    const section = document.createElement('div');
    section.className = 'dash-card-detail-section';
    section.innerHTML = '<div class="dash-card-detail-section-hdr">Attachments</div>' +
      attachments.map(a => {
        const url = `/api/${encodeURIComponent(board)}/cards/attachments/${encodeURIComponent(card.id)}/${encodeURIComponent(a.name)}`;
        return `<a class="dash-card-attach-item" href="${escHtml(url)}" download="${escHtml(a.name)}">${SVGICONS.attachment(12, 12)} ${escHtml(a.name)}<span class="dash-card-attach-size">${fmtSize(a.size)}</span></a>`;
      }).join('');
    body.appendChild(section);
  }

  if (linkedPages.length) {
    const section = document.createElement('div');
    section.className = 'dash-card-detail-section';
    section.innerHTML = '<div class="dash-card-detail-section-hdr">Linked notes</div>' +
      linkedPages.map(p => {
        const href = `${BASE_PATH}/board/${encodeURIComponent(board)}#note:${encodeURIComponent(p.id)}`;
        return `<a class="dash-card-note-link" href="${escHtml(href)}" data-page-id="${escHtml(p.id)}">${SVGICONS.noteDoc(9, 11)} ${escHtml(p.title || 'Untitled')}</a>`;
      }).join('');
    section.addEventListener('click', e => {
      const a = e.target.closest('.dash-card-note-link');
      if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      _closeDetail();
      _todayEditNote(board, a.dataset.pageId);
    });
    body.appendChild(section);
  }
}

/**
 * Parse the UNTIL value from an RRULE string into a localised date string.
 * UNTIL can be a date-only value ("20261231") or a UTC datetime ("20261231T235959Z").
 */
function _parseUntilRRule(untilStr) {
  if (!untilStr) return null;
  try {
    const d = untilStr.length === 8
      ? new Date(Date.UTC(+untilStr.slice(0, 4), +untilStr.slice(4, 6) - 1, +untilStr.slice(6, 8)))
      : new Date(untilStr.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/, '$1-$2-$3T$4:$5:$6Z'));
    return isNaN(d) ? untilStr : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return untilStr; }
}

/**
 * Convert a raw RRULE value string (e.g. "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2")
 * into a human-readable recurrence description.
 * seriesStart is the ISO date/datetime string for the first occurrence (DTSTART).
 */
function _formatRRule(rruleStr, seriesStart) {
  if (!rruleStr) return 'Recurring event';
  const parts = {};
  for (const seg of rruleStr.split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).toUpperCase()] = seg.slice(i + 1);
  }
  const freq     = parts.FREQ || '';
  const interval = parseInt(parts.INTERVAL || '1', 10) || 1;
  const count    = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  const until    = parts.UNTIL ? _parseUntilRRule(parts.UNTIL) : null;
  const byday    = parts.BYDAY    ? parts.BYDAY.split(',')    : [];
  const bymonthday = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map(Number) : [];
  const bymonth  = parts.BYMONTH  ? parts.BYMONTH.split(',').map(Number)  : [];

  const DAY_NAMES  = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
  const MON_NAMES  = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function ordinal(n) {
    if (n === -1) return 'last';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = Math.abs(n) % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  let str = '';
  if (freq === 'DAILY') {
    str = interval === 1 ? 'Every day' : `Every ${interval} days`;
  } else if (freq === 'WEEKLY') {
    str = interval === 1 ? 'Every week' : `Every ${interval} weeks`;
    if (byday.length) {
      const names = byday.map(d => {
        const m = d.match(/^[+-]?\d*(SU|MO|TU|WE|TH|FR|SA)$/);
        return m ? (DAY_NAMES[m[1]] || m[1]) : d;
      });
      str += ' on ' + names.join(', ');
    }
  } else if (freq === 'MONTHLY') {
    str = interval === 1 ? 'Every month' : `Every ${interval} months`;
    if (bymonthday.length) {
      str += ' on the ' + bymonthday.map(ordinal).join(', ');
    } else if (byday.length) {
      const m = byday[0].match(/^([+-]?\d+)(SU|MO|TU|WE|TH|FR|SA)$/);
      if (m) str += ` on the ${ordinal(parseInt(m[1], 10))} ${DAY_NAMES[m[2]] || m[2]}`;
    }
  } else if (freq === 'YEARLY') {
    str = interval === 1 ? 'Every year' : `Every ${interval} years`;
    if (bymonth.length && bymonthday.length) str += ` on ${MON_NAMES[bymonth[0]]} ${bymonthday[0]}`;
    else if (bymonth.length) str += ` in ${MON_NAMES[bymonth[0]]}`;
  } else if (freq === 'HOURLY') {
    str = interval === 1 ? 'Every hour' : `Every ${interval} hours`;
  } else {
    str = 'Recurring';
  }

  if (count)        str += `, ${count} time${count !== 1 ? 's' : ''}`;
  else if (until)   str += `, until ${until}`;

  if (seriesStart) {
    try {
      const d = new Date(seriesStart);
      if (!isNaN(d)) {
        const dateStr    = d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
        const weekdayStr = d.toLocaleDateString([], { weekday: 'long' });
        str += `, started ${dateStr} (${weekdayStr})`;
      }
    } catch { /* ignore */ }
  }

  return str;
}

// evOverride: a specific occurrence (calendar view) — _calEventMap holds only one entry per uid
async function _showCalEventContextMenu(e, accountId, uid, webUrl, evOverride) {
  const ev          = evOverride || _calEventMap.get(`${accountId}\0${uid}`);
  const isIcal      = (ev?._accountType || 'caldav') === 'ical-url';
  const isRecurring = !!ev?.hasRrule;
  const boards      = await _dashActiveBoards();
  const items = [
    { labelHtml: `<span class="ctx-icon">${SVGICONS.cardInfo()}</span>Open`, action: () => _openEventDetail(accountId, uid, webUrl, evOverride) },
  ];
  if (ev) {
    items.push({
      labelHtml: `<span class="ctx-icon">${SVGICONS.card()}</span>Create card`,
      action:    () => _createCardFromEvent(accountId, ev),
      ...(boards.length ? { children: boards.map(b => ({ label: b, action: () => _createCardFromEvent(accountId, ev, b) })) } : {}),
    });
  }
  const refs = ev?.cardRefs || [];
  if (refs.length === 1) {
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open card`, action: () => _openLinkedCard(refs[0].board, refs[0].cardId) });
  } else if (refs.length > 1) {
    items.push({
      labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open card`,
      children:  refs.map(r => ({ label: `${r.board} \u00b7 ${r.cardId}`, action: () => _openLinkedCard(r.board, r.cardId) })),
    });
  }
  if (!isIcal) {
    if (isRecurring) {
      items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Edit this occurrence`, action: () => openCalEventModal(accountId, ev, null, 'occurrence') });
      items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Edit entire series`,    action: () => openCalEventModal(accountId, ev, null, 'series') });
      items.push({ labelHtml: `<span class="ctx-icon">${_svgDelete()}</span>Delete this occurrence`, danger: true, action: () => _deleteCalEvent(accountId, uid, ev?.etag, ev?.href, 'occurrence', ev?.start) });
      items.push({ labelHtml: `<span class="ctx-icon">${_svgDelete()}</span>Delete entire series`,   danger: true, action: () => _deleteCalEvent(accountId, uid, ev?.etag, ev?.href, 'series') });
    } else {
      items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Edit`,             action: () => openCalEventModal(accountId, ev) });
      items.push({ labelHtml: `<span class="ctx-icon">${_svgDelete()}</span>Delete`, danger: true, action: () => _deleteCalEvent(accountId, uid, ev?.etag, ev?.href) });
    }
  }
  openContextMenu(e, items);
}

/** Human-readable date/time range of an event ("When" row, card description). */
function _calEventWhen(ev) {
  // All-day dates are 'YYYY-MM-DD' (end exclusive) \u2192 local midnight, not UTC
  const day = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const dateFmt = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  const timeFmt = { hour: '2-digit', minute: '2-digit' };
  if (ev.allDay) {
    const s = day(ev.start);
    const last = ev.end ? new Date(day(ev.end).getTime() - 86_400_000) : s;
    return last > s
      ? `${s.toLocaleDateString([], dateFmt)} \u2013 ${last.toLocaleDateString([], dateFmt)}`
      : s.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  const s = new Date(ev.start), e = ev.end ? new Date(ev.end) : null;
  const startStr = s.toLocaleString([], { ...dateFmt, ...timeFmt });
  // Multi-day: full date + time on both ends; same day: end time only
  return !e ? startStr
    : new Date(e - 1).toDateString() !== s.toDateString() ?   // ending at midnight still counts as one day
     `${startStr} \u2013 ${e.toLocaleString([], { ...dateFmt, ...timeFmt })}`
    : `${startStr} \u2013 ${e.toLocaleTimeString([], timeFmt)}`;
}

let _dashBoardsCache = null;
/** Active (non-archived) board names for "Create card" submenus; cached per page load. */
async function _dashActiveBoards() {
  if (_dashBoardsCache) return _dashBoardsCache;
  try {
    const boards = await fetch('/api/boards').then(r => r.ok ? r.json() : []);
    _dashBoardsCache = (Array.isArray(boards) ? boards : []).filter(b => !b.archived).map(b => b.name);
  } catch { return []; }
  return _dashBoardsCache;
}

/**
 * Card fields prefilled from a calendar event: title, details as Markdown, start/end date,
 * location as link (http/https only) and the hidden reference back to the event (calEvent).
 */
function _calEventCardPrefill(accountId, ev) {
  const lines = [];
  if (ev.start)     lines.push(`**When:** ${_calEventWhen(ev)}`);
  if (ev.location)  lines.push(`**Where:** ${ev.location}`);
  if (ev._label)    lines.push(`**Calendar:** ${ev._label}`);
  if (ev.organizer) lines.push(`**Organiser:** ${String(ev.organizer).replace(/^mailto:/i, '')}`);
  let bodyText = '';
  if (ev.description) {
    bodyText = /<[a-z][\s\S]*>/i.test(ev.description)
      ? (() => { try { return new DOMParser().parseFromString(ev.description, 'text/html').body.innerText.trim(); } catch { return ev.description; } })()
      : ev.description.trim();
  }

  let startDate = '', endDate = '';
  if (ev.start) {
    if (ev.allDay) {
      startDate = ev.start.slice(0, 10);
      if (ev.end) {
        const [y, m, d] = ev.end.slice(0, 10).split('-').map(Number);
        endDate = _ymdLocal(new Date(y, m - 1, d - 1));   // DTEND is exclusive
      }
    } else {
      startDate = _ymdLocal(new Date(ev.start));
      if (ev.end) endDate = _ymdLocal(new Date(new Date(ev.end).getTime() - 1));
    }
    if (endDate && endDate <= startDate) endDate = '';
  }

  return {
    text:        ev.title || '',
    description: lines.join('  \n') + (bodyText ? '\n\n---\n\n' + bodyText : ''),
    link:        safeLink(ev.location || '') ? ev.location : '',
    startDate,
    endDate,
    extra:       { calEvent: { accountId, uid: ev.uid } },
  };
}

/**
 * Open the add-to-inbox modal prefilled from a calendar event. After the card was saved the
 * event gets a hidden X-JC-KANBAN-CARD reference (CalDAV only; iCal-URL feeds are read-only).
 */
async function _createCardFromEvent(accountId, ev, boardName = null) {
  const writable = (ev._accountType || 'caldav') !== 'ical-url';
  await openInboxModal(boardName, _calEventCardPrefill(accountId, ev), async (board, cardId) => {
    if (!writable || !board || !cardId) return;
    try {
      const res = await fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(ev.uid)}/cards`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board, cardId, ...(ev.href ? { href: ev.href } : {}) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await _refreshCalendarAccount(accountId);
      if (_cvIsOpen()) _cvLoad();
    } catch (err) {
      showMessage(`Card created, but linking it to the event failed: ${err.message}`);
    }
  });
}

/** Board data per name for resolving linked cards; short-lived (one detail render). */
async function _findBoardCard(board, cardId, cache = new Map()) {
  if (!cache.has(board)) {
    cache.set(board, fetch(`/api/${encodeURIComponent(board)}/board`).then(r => r.ok ? r.json() : null).catch(() => null));
  }
  const data = await cache.get(board);
  for (const col of data?.columns || []) {
    const card = (col.cards || []).find(c => c.id === cardId);
    if (card) return { card, column: col.title };
  }
  return null;
}

/** Placeholder links for linked cards ([{ board, cardId }]); resolved by _resolveLinkedCardLinks. */
function _linkedCardLinksHtml(refs) {
  return refs.map(r =>
    `<a href="#" class="dash-linked-card" data-board="${escHtml(r.board)}" data-card-id="${escHtml(r.cardId)}">${escHtml(r.board)}</a>`
  ).join('<br>');
}

/** Replace the board-name placeholders of `.dash-linked-card` links with the card titles; wire clicks. */
function _resolveLinkedCardLinks(container) {
  const cache = new Map();
  for (const a of container.querySelectorAll('.dash-linked-card')) {
    const { board, cardId } = a.dataset;
    a.addEventListener('click', e => { e.preventDefault(); _openLinkedCard(board, cardId); });
    _findBoardCard(board, cardId, cache).then(found => {
      if (found) a.textContent = `${found.card.text || '(untitled)'} \u00b7 ${board} / ${found.column}`;
      else { a.textContent = `${board}: card not found`; a.classList.add('dash-linked-card--missing'); }
    });
  }
}

/** Open a card referenced by a calendar event in the detail panel. */
async function _openLinkedCard(board, cardId) {
  const found = await _findBoardCard(board, cardId);
  if (!found) { showMessage('The linked card no longer exists.'); return; }
  const c = found.card;
  _openCardDetail(board, { ...c, description: !!c.description });
}

function _openEventDetail(accountId, uid, webUrl, evOverride) {
  const detail    = document.getElementById('dashboardDetail');
  const body      = document.getElementById('dashboardDetailBody');
  const webUrlBtn = document.getElementById('dashboardDetailWebUrl');
  document.getElementById('dashboardDetailEditBtn').style.display = 'none';
  document.getElementById('dashboardDetailTitle').textContent = 'Loading\u2026';
  if (webUrl) {
    webUrlBtn.href = webUrl;
    webUrlBtn.title = 'Open in Calendar';
    webUrlBtn.style.display = '';
  } else {
    webUrlBtn.style.display = 'none';
  }
  body.innerHTML = '';
  detail.style.display = '';
  const modal = detail.querySelector('.modal');
  const maxH  = modal.offsetHeight;
  modal.style.height    = 'auto';
  modal.style.minHeight = '450px';
  modal.style.maxHeight = maxH + 'px';

  function _renderEventDetail(ev) {
    document.getElementById('dashboardDetailTitle').textContent = ev.title;
    const titlebar = detail.querySelector('.dashboard-detail-titlebar');
    if (ev._color) titlebar.style.setProperty('--detail-accent', ev._color);
    else titlebar.style.removeProperty('--detail-accent');
    const rows = [];
    if (ev.start) rows.push(['When', escHtml(_calEventWhen(ev))]);
    if (ev.location) {
      const locSafe = safeLink(ev.location);
      const locHtml = locSafe
        ? `<a href="${locSafe}" target="_blank" rel="noopener noreferrer">${escHtml(ev.location)}</a>`
        : escHtml(ev.location);
      rows.push(['Where', locHtml]);
    }
    if (ev.status)    rows.push(['Status',     escHtml(ev.status)]);
    if (ev.organizer) rows.push(['Organiser',  escHtml(ev.organizer)]);
    if (ev._label)    rows.push(['Calendar',   escHtml(ev._label)]);
    if (ev.hasRrule)  rows.push(['Recurrence', escHtml(_formatRRule(ev.rruleStr || null, ev.seriesStart || ev.start))]);
    const cardRefs = ev.cardRefs || [];
    if (cardRefs.length) {
      rows.push([cardRefs.length > 1 ? 'Cards' : 'Card', _linkedCardLinksHtml(cardRefs)]);
    }
    body.innerHTML = `<table class="dashboard-detail-table">${
      rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')
    }</table>`;
    _resolveLinkedCardLinks(body);
    if (ev.description) {
      const iframe = document.createElement('iframe');
      iframe.className = 'dashboard-mail-iframe';
      iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox allow-same-origin');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      body.appendChild(iframe);
      const baseStyle = 'body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#222;background:white;padding:8px;margin:0;word-break:break-word}'
        + ' a{color:#4f46e5} img{max-width:100%;height:auto}'
        + ' blockquote{border-left:3px solid #ddd;margin:8px 0;padding:0 12px;color:#555}'
        + ' pre,code{font-family:monospace;font-size:0.88em;background:#f0f0f0;padding:2px 5px;border-radius:3px}';
      let descSrc = /<p[\s>]|<br[\s/>]/i.test(ev.description)
        ? ev.description
        : ev.description.replace(/\n/g, '<br/>');
      // Linkify bare URLs not already inside an href attribute
      descSrc = descSrc.replace(/(href=["'][^"']*["'])|(https?:\/\/[^\s<>"')\]]+)/g,
        (m, attr, url) => attr ? attr : `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      const safeHtml = DOMPurify.sanitize(descSrc, { FORCE_BODY: true, ADD_ATTR: ['target', 'rel'] });
      iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${baseStyle}</style></head><body>${safeHtml}</body></html>`;
      const resize = () => {
        const natural = iframe.contentDocument.body.scrollHeight + 16;
        iframe.style.height = Math.max(450, Math.min(natural, body.clientHeight)) + 'px';
      };
      iframe.addEventListener('load', resize);
    }

    // Edit / Delete footer — only for CalDAV accounts, hidden for iCal-URL or recurring events
    const existingFooter = detail.querySelector('.dash-detail-footer');
    if (existingFooter) existingFooter.remove();

    const isReadOnly  = (ev._accountType || 'caldav') === 'ical-url';
    const isRecurring = !!ev.hasRrule;

    if (!isReadOnly) {
      const footer = document.createElement('div');
      footer.className = 'dash-detail-footer';

      if (isRecurring) {
        // Two rows: occurrence actions, series actions
        const occRow = document.createElement('div');
        occRow.className = 'dash-detail-footer-row';
        const occLabel = document.createElement('span');
        occLabel.className = 'dash-detail-footer-scope-label';
        occLabel.textContent = 'This occurrence:';
        const delOccBtn = document.createElement('button');
        delOccBtn.className = 'btn btn-secondary';
        delOccBtn.style.color = 'var(--danger)';
        delOccBtn.textContent = 'Delete';
        delOccBtn.addEventListener('click', () => _deleteCalEvent(ev._accountId, ev.uid, ev.etag, ev.href, 'occurrence', ev.start));
        const editOccBtn = document.createElement('button');
        editOccBtn.className = 'btn btn-primary';
        editOccBtn.textContent = 'Edit';
        editOccBtn.addEventListener('click', () => openCalEventModal(ev._accountId, ev, null, 'occurrence'));
        occRow.append(occLabel, delOccBtn, editOccBtn);

        const serRow = document.createElement('div');
        serRow.className = 'dash-detail-footer-row';
        const serLabel = document.createElement('span');
        serLabel.className = 'dash-detail-footer-scope-label';
        serLabel.textContent = 'Entire series:';
        const delSerBtn = document.createElement('button');
        delSerBtn.className = 'btn btn-secondary';
        delSerBtn.style.color = 'var(--danger)';
        delSerBtn.textContent = 'Delete';
        delSerBtn.addEventListener('click', () => _deleteCalEvent(ev._accountId, ev.uid, ev.etag, ev.href, 'series'));
        const editSerBtn = document.createElement('button');
        editSerBtn.className = 'btn btn-primary';
        editSerBtn.textContent = 'Edit';
        editSerBtn.addEventListener('click', () => openCalEventModal(ev._accountId, ev, null, 'series'));
        serRow.append(serLabel, delSerBtn, editSerBtn);

        footer.append(occRow, serRow);
      } else {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-secondary';
        deleteBtn.style.color = 'var(--danger)';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => _deleteCalEvent(ev._accountId, ev.uid, ev.etag, ev.href));

        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-primary';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openCalEventModal(ev._accountId, ev));

        footer.append(deleteBtn, editBtn);
      }

      detail.querySelector('.modal').appendChild(footer);
    }
  }

  // Use cached event data if available — avoids a full CalDAV round-trip
  const cached = evOverride || _calEventMap.get(`${accountId}\0${uid}`);
  if (cached) { _renderEventDetail(cached); return; }

  fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(uid)}`)
    .then(r => r.ok ? r.json() : null)
    .then(ev => {
      if (!ev) { body.innerHTML = '<p class="dashboard-empty">Event not found.</p>'; return; }
      _renderEventDetail(ev);
    })
    .catch(() => { body.innerHTML = '<p class="dashboard-empty">Failed to load event.</p>'; });
}

function _closeDetail() {
  document.getElementById('dashboardDetail').style.display = 'none';
  const modal = document.querySelector('#dashboardDetail .modal');
  if (modal) {
    modal.classList.remove('modal--fullscreen');
    modal.style.height = modal.style.minHeight = modal.style.maxHeight = '';
  }
}

// ---- Mail context menu ----

function _showMailContextMenu(x, y, accountId, msgId, unread, webUrl) {
  _closeAllContextMenus();
  _mailCtxAccountId = accountId;
  _mailCtxMsgId     = msgId;
  _mailCtxUnread    = !!unread;
  document.getElementById('mailCtxToggleReadLabel').textContent = unread ? 'Mark as read' : 'Mark as unread';
  const webmailEl = document.getElementById('mailCtxWebmail');
  if (webUrl) { webmailEl.href = webUrl; webmailEl.style.display = ''; }
  else        { webmailEl.style.display = 'none'; }
  const refs = _mailCardRefs.get(`${accountId}\0${msgId}`) || [];
  const openWrap = document.getElementById('mailCtxOpenCardWrap');
  openWrap.style.display = refs.length ? '' : 'none';
  const openList = document.getElementById('mailCtxOpenCardList');
  openList.innerHTML = '';
  for (const r of refs) {
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.textContent = `${r.board} \u00b7 ${r.cardId}`;
    btn.addEventListener('click', e => { e.stopPropagation(); hideMailContextMenu(); _openLinkedCard(r.board, r.cardId); });
    openList.appendChild(btn);
    _findBoardCard(r.board, r.cardId).then(f => { if (f) btn.textContent = `${f.card.text || '(untitled)'} \u00b7 ${r.board}`; });
  }
  openWrap.onclick = e => {
    if (e.target.closest('.ctx-submenu') || !refs.length) return;
    hideMailContextMenu();
    _openLinkedCard(refs[0].board, refs[0].cardId);
  };
  const menu = document.getElementById('mailContextMenu');
  menu.style.display = 'block';
  const mw   = menu.offsetWidth  || 160;
  const mh   = menu.offsetHeight || 40;
  const edge = 4;
  const menuLeft = Math.max(edge, Math.min(x, window.innerWidth  - mw - edge));
  const menuTop  = Math.max(edge, Math.min(y, window.innerHeight - mh - edge));
  menu.style.left = menuLeft + 'px';
  menu.style.top  = menuTop  + 'px';
  const toLeft = menuLeft + mw + 160 > window.innerWidth - edge;
  document.getElementById('mailCtxMoveWrap').classList.toggle('ctx-submenu-left', toLeft);
  document.getElementById('mailCtxCreateCardWrap').classList.toggle('ctx-submenu-left', toLeft);
  document.getElementById('mailCtxOpenCardWrap').classList.toggle('ctx-submenu-left', toLeft);
}

function hideMailContextMenu() {
  document.getElementById('mailContextMenu').style.display = 'none';
  _mailCtxAccountId = null;
  _mailCtxMsgId     = null;
  _mailCtxUnread    = false;
}

function _getRecentFolders(accountId) {
  const list = _serverRecentFolders[accountId];
  return Array.isArray(list) ? list : [];
}

function _addRecentFolder(accountId, folder) {
  const current = _getRecentFolders(accountId);
  _serverRecentFolders[accountId] = [folder, ...current.filter(f => f !== folder)].slice(0, 3);
  // Persist to server (fire & forget)
  fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/recent-folders`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) }
  ).catch(() => {});
}

function _makeFolderBtn(path, label) {
  const btn = document.createElement('button');
  btn.className = 'ctx-item';
  btn.dataset.folder = path;
  btn.textContent = label;
  btn.addEventListener('click', () => {
    const accountId = _mailCtxAccountId;
    const msgId     = _mailCtxMsgId;
    hideMailContextMenu();
    if (accountId && msgId) _mailMove(accountId, msgId, path);
  });
  return btn;
}

function _populateFolderList(folders, listEl) {
  if (!folders.length) {
    listEl.innerHTML = '<p class="ctx-folder-loading">No folders found.</p>';
    return;
  }
  listEl.innerHTML = '';
  const folderMap = Object.fromEntries(folders.map(f => [f.path, f.name || f.path]));
  const recents = _getRecentFolders(_mailCtxAccountId)
    .filter(path => path in folderMap);
  if (recents.length) {
    recents.forEach(path => listEl.appendChild(_makeFolderBtn(path, folderMap[path])));
    const sep = document.createElement('div');
    sep.className = 'ctx-separator';
    listEl.appendChild(sep);
  }
  folders.forEach(f => listEl.appendChild(_makeFolderBtn(f.path, f.name || f.path)));
  listEl.scrollTop = 0;
}

async function _mailToggleRead(accountId, msgId, unread) {
  const seen = unread; // unread=true → mark as seen; unread=false → mark as unseen
  try {
    const res = await fetch(
      `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seen }) }
    );
    if (!res.ok) throw new Error('Failed');
    // Today lists unread mails only: a read one leaves the list, an unread one may join it
    if (seen) _todayDropMail(accountId, msgId);
    _todayRefresh('mail');
  } catch {
    _reloadMailPanel();
  }
}

function _mailRemoveItem(accountId, msgId) {
  _todayDropMail(accountId, msgId);
}

async function _mailDelete(accountId, msgId) {
  _mailRemoveItem(accountId, msgId);
  try {
    const res = await fetch(
      `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error('Failed');
    _todayRefresh('mail');
  } catch {
    _reloadMailPanel();
  }
}

async function _mailMove(accountId, msgId, folder) {
  _mailRemoveItem(accountId, msgId);
  try {
    const res = await fetch(
      `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}/move`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) }
    );
    if (!res.ok) throw new Error('Failed');
    _addRecentFolder(accountId, folder);
    _todayRefresh('mail');
  } catch {
    _reloadMailPanel();
  }
}

/**
 * Open the add-to-inbox modal prefilled from a mail (subject, headers, body; attachments copied to the card).
 * `folder` = IMAP folder of the message (default: the account's folder);
 * `markRead` replaces the default "mark read in the dashboard panel" after the card was created.
 */
async function _createCardFromMail(accountId, msgId, boardName = null, { folder = null, markRead = null, onLinked = null } = {}) {
  let prefill = { text: '', description: '' };
  let msg = null;
  const folderQs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
  try {
    msg = await fetch(
      `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}${folderQs}`
    ).then(r => r.ok ? r.json() : null);

    if (msg) {
      prefill.text = msg.subject || '';

      const headerLines = [];
      if (msg.from)    headerLines.push(`**From:** ${msg.from}`);
      if (msg.to)      headerLines.push(`**To:** ${msg.to}`);
      if (msg.cc)      headerLines.push(`**Cc:** ${msg.cc}`);
      if (msg.date)    headerLines.push(`**Date:** ${new Date(msg.date).toLocaleString()}`);
      if (msg.subject) headerLines.push(`**Subject:** ${msg.subject}`);

      let bodyText = '';
      if (msg.bodyHtml) {
        try {
          bodyText = new DOMParser()
            .parseFromString(msg.bodyHtml, 'text/html')
            .body.innerText.trim();
        } catch {
          bodyText = msg.body || '';
        }
      } else {
        bodyText = msg.body || '';
      }

      prefill.description = headerLines.join('  \n') +
        (bodyText ? '\n\n---\n\n' + bodyText : '');
      // Hidden reference to the mail: Message-ID survives folder moves (IMAP UIDs don't)
      if (msg.messageId) {
        prefill.extra = { mailRef: {
          accountId, messageId: msg.messageId,
          ...(folder ? { folder } : {}),   // only a search hint; the panel shows the account's folder
          subject: (msg.subject || '').slice(0, 1000),
        } };
      }
    }
  } catch { /* proceed with empty prefill */ }

  const attachments = msg?.attachments || [];

  // If the target board is already known, pre-upload to a temp card ID so the
  // inbox modal shows the attachments immediately (background — modal opens in parallel).
  let preTempCardId = null;
  if (boardName && attachments.length) {
    preTempCardId = uid();
    _uploadMailAttachmentsToCard(accountId, msgId, attachments, boardName, preTempCardId, folder)
      .then(() => { if (typeof _inboxTempCardId !== 'undefined' && _inboxTempCardId === preTempCardId) loadCardAttachments(preTempCardId); });
  }

  await openInboxModal(boardName, prefill, async (board, cardId) => {
    if (markRead) markRead(); else _mailToggleRead(accountId, msgId, true);
    if (msg?.messageId && board && cardId) _linkMailToCard(accountId, msgId, folder, board, cardId, onLinked);
    // Re-upload only if board was changed (new cardId differs from pre-uploaded temp)
    if (attachments.length && board && cardId && cardId !== preTempCardId) {
      await _uploadMailAttachmentsToCard(accountId, msgId, attachments, board, cardId, folder);
    }
  }, null, preTempCardId);
}

/** Store the mail → card link server-side (keyed by Message-ID) and mark the mail in the panel. */
async function _linkMailToCard(accountId, msgId, folder, board, cardId, onLinked) {
  const folderQs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
  try {
    const res = await fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}/cards${folderQs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board, cardId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    showMessage(`Card created, but linking it to the mail failed: ${err.message}`);
    return;
  }
  const ref = { board, cardId };
  if (!folder) {
    const key = `${accountId}\0${msgId}`;
    _mailCardRefs.set(key, [...(_mailCardRefs.get(key) || []), ref]);
  }
  if (onLinked) onLinked(ref);
}

async function _uploadMailAttachmentsToCard(accountId, msgId, attachments, board, cardId, folder = null) {
  const base = `/api/dashboard/mail/${encodeURIComponent(accountId)}/message/${encodeURIComponent(msgId)}/attachment/`;
  const folderQs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
  for (const att of attachments) {
    try {
      const blob = await fetch(base + encodeURIComponent(att.part) + folderQs).then(r => r.ok ? r.blob() : null);
      if (!blob) continue;
      const form = new FormData();
      form.append('file', blob, att.name);
      await fetch(`/api/${encodeURIComponent(board)}/cards/attachments/${encodeURIComponent(cardId)}`, {
        method: 'POST', body: form,
      });
    } catch { /* skip failed attachment */ }
  }
}

document.getElementById('mailCtxWebmail').addEventListener('click', () => hideMailContextMenu());

{ // Create card — click opens inbox modal; submenu lets user pick a board directly
  let _boardListCache = null;

  document.getElementById('mailCtxCreateCardWrap').addEventListener('click', async e => {
    // Ignore clicks that originated from inside the submenu (board buttons)
    if (e.target.closest('.ctx-submenu')) return;
    const accountId = _mailCtxAccountId;
    const msgId     = _mailCtxMsgId;
    hideMailContextMenu();
    if (accountId && msgId) await _createCardFromMail(accountId, msgId);
  });

  document.getElementById('mailCtxCreateCardWrap').addEventListener('mouseenter', async () => {
    const listEl = document.getElementById('mailCtxBoardList');
    if (_boardListCache) { _populateBoardList(_boardListCache, listEl); return; }
    listEl.innerHTML = '<p class="ctx-folder-loading">Loading\u2026</p>';
    try {
      const boards = await fetch('/api/boards').then(r => r.json());
      _boardListCache = boards.filter(b => !b.archived);
      _populateBoardList(_boardListCache, listEl);
    } catch {
      listEl.innerHTML = '<p class="ctx-folder-loading">Failed to load.</p>';
    }
  });
}

function _populateBoardList(boards, listEl) {
  if (!boards.length) { listEl.innerHTML = '<p class="ctx-folder-loading">No boards.</p>'; return; }
  listEl.innerHTML = '';
  boards.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.textContent = b.name;
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const accountId = _mailCtxAccountId;
      const msgId     = _mailCtxMsgId;
      hideMailContextMenu();
      if (accountId && msgId) await _createCardFromMail(accountId, msgId, b.name);
    });
    listEl.appendChild(btn);
  });
}

document.getElementById('mailCtxToggleRead').addEventListener('click', async () => {
  const accountId = _mailCtxAccountId;
  const msgId     = _mailCtxMsgId;
  const unread    = _mailCtxUnread;
  hideMailContextMenu();
  if (accountId && msgId) await _mailToggleRead(accountId, msgId, unread);
});

document.getElementById('mailCtxDelete').addEventListener('click', async () => {
  const accountId = _mailCtxAccountId;
  const msgId     = _mailCtxMsgId;
  hideMailContextMenu();
  if (!accountId || !msgId) return;
  const ok = await showConfirm('Move this message to trash?', { okLabel: 'Delete', danger: true });
  if (ok) await _mailDelete(accountId, msgId);
});

// Populate folder list on hover — fetch once per account then serve from cache
document.getElementById('mailCtxMoveWrap').addEventListener('mouseenter', async () => {
  const accountId = _mailCtxAccountId;
  if (!accountId) return;
  const listEl = document.getElementById('mailCtxFolderList');
  if (_folderCache.has(accountId)) {
    _populateFolderList(_folderCache.get(accountId), listEl);
    return;
  }
  listEl.innerHTML = '<p class="ctx-folder-loading">Loading\u2026</p>';
  try {
    const res = await fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/folders`);
    if (!res.ok) throw new Error('Failed');
    const { folders } = await res.json();
    _folderCache.set(accountId, folders);
    _populateFolderList(folders, listEl);
  } catch {
    listEl.innerHTML = '<p class="ctx-folder-loading">Failed to load.</p>';
  }
});

document.addEventListener('click', () => hideMailContextMenu());

// ---- Calendar event write ----

/** Populate a <select> with grouped IANA timezone options. */
function _populateTzSelect(sel, selected) {
  sel.innerHTML = '';
  try {
    const tzs = Intl.supportedValuesOf('timeZone');
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = '\u2014 Browser default \u2014';
    sel.appendChild(blank);
    const groups = {};
    for (const tz of tzs) {
      const region = tz.includes('/') ? tz.split('/')[0] : 'Other';
      if (!groups[region]) groups[region] = [];
      groups[region].push(tz);
    }
    for (const [region, tzList] of Object.entries(groups).sort()) {
      const og = document.createElement('optgroup');
      og.label = region;
      for (const tz of tzList) {
        const opt = document.createElement('option');
        opt.value = tz; opt.textContent = tz;
        if (tz === selected) opt.selected = true;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
  } catch {
    // Intl.supportedValuesOf not available — add a text input fallback
    sel.innerHTML = `<option value="${escHtml(selected || '')}">${escHtml(selected || 'UTC')}</option>`;
  }
  if (selected) sel.value = selected;
}

/**
 * Open the calendar event creation/edit modal.
 * accountId + acc: create mode (acc is the account config object for type check).
 * accountId + ev:  edit mode (ev is the cached event from _calEventMap).
 * scope: 'occurrence' | 'series' | null — for recurring event edits.
 */
/**
 * Start / end shown when editing an entire series: the series start (DTSTART) plus the clicked
 * occurrence's duration. The server writes these values back as the master's DTSTART / DTEND,
 * so prefilling the occurrence would move the series start and drop all earlier occurrences.
 */
function _calSeriesDates(ev) {
  if (!ev.seriesStart || !ev.start) return { start: ev.start, end: ev.end };
  const dur = (ev.end ? new Date(ev.end) : new Date(ev.start)) - new Date(ev.start);
  const end = new Date(new Date(ev.seriesStart).getTime() + dur).toISOString();
  return { start: ev.seriesStart, end: ev.allDay ? end.slice(0, 10) : end };
}

// prefill (create mode only): { start: Date, end: Date, allDay } — e.g. a slot picked in the calendar view
async function openCalEventModal(accountId, ev, acc, scope, prefill) {
  const modal      = document.getElementById('calEventModal');
  const titleEl    = document.getElementById('calEventModalTitle');
  const accField   = document.getElementById('calEventAccountField');
  const accSel     = document.getElementById('calEventAccount');
  const titleInput = document.getElementById('calEventTitle');
  const allDayCb   = document.getElementById('calEventAllDay');
  const startDate  = document.getElementById('calEventStartDate');
  const startTime  = document.getElementById('calEventStartTime');
  const endDate    = document.getElementById('calEventEndDate');
  const endTime    = document.getElementById('calEventEndTime');
  const locInput   = document.getElementById('calEventLocation');
  const tzSel      = document.getElementById('calEventTimezone');
  const tzRow      = document.getElementById('calEventTzRow');
  const descInput  = document.getElementById('calEventDescription');
  const errEl      = document.getElementById('calEventError');
  const saveBtn    = document.getElementById('calEventSaveBtn');
  const scopeRow          = document.getElementById('calEventScopeRow');
  const scopeLabel        = document.getElementById('calEventScopeLabel');
  const recurRow          = document.getElementById('calEventRecurRow');
  const recurInfo         = document.getElementById('calEventRecurInfo');
  const repeatToggleRow   = document.getElementById('calEventRepeatToggleRow');

  errEl.hidden = true; errEl.textContent = '';
  saveBtn.textContent = 'Save event'; saveBtn.disabled = false;
  scopeRow.hidden = true;
  recurRow.hidden = true;
  _resetRepeatUi();

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (ev) {
    // Edit mode — populate from cache immediately, fetch fresh etag/href in background
    _calModalMode    = 'edit';
    _calModalAccId   = ev._accountId || accountId;
    _calModalUid     = ev.uid;
    _calModalEtag    = ev.etag || null;
    _calModalHref    = ev.href || null;
    _calModalCardRefs = ev.cardRefs || null;
    _calModalScope   = (ev.hasRrule && scope) ? scope : null;
    _calModalOccDate = (_calModalScope === 'occurrence') ? (ev.start || null) : null;

    // Title
    if (ev.hasRrule && scope === 'occurrence') titleEl.textContent = 'Edit occurrence';
    else if (ev.hasRrule && scope === 'series') titleEl.textContent = 'Edit series';
    else titleEl.textContent = 'Edit event';

    accField.style.display = 'none';

    // Scope info row for recurring events
    if (ev.hasRrule && scope) {
      scopeRow.hidden = false;
      if (scope === 'occurrence') {
        const dateStr = ev.start ? new Date(ev.start).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : '';
        scopeLabel.textContent = `This occurrence${dateStr ? ' \u2014 ' + dateStr : ''}`;
      } else {
        scopeLabel.textContent = 'All occurrences';
      }
      if (ev.rruleStr || ev.hasRrule) {
        recurRow.hidden = false;
        recurInfo.textContent = _formatRRule(ev.rruleStr || null, ev.seriesStart || ev.start);
      }
    }

    // Repeat section: show for series edits (populated from rrule), hide for occurrence edits
    if (scope === 'occurrence') {
      repeatToggleRow.hidden = true;
    } else {
      repeatToggleRow.hidden = false;
      if (ev.rruleStr) _parseRRuleToUi(ev.rruleStr);
    }

    titleInput.value = ev.title || '';
    allDayCb.checked = !!ev.allDay;
    locInput.value   = ev.location || '';
    descInput.value  = ev.description || '';

    // Fetch fresh etag/href in background — disable save until ready
    saveBtn.disabled = true; saveBtn.textContent = 'Loading\u2026';
    fetch(`/api/dashboard/calendar/${encodeURIComponent(_calModalAccId)}/event/${encodeURIComponent(ev.uid)}`)
      .then(r => r.ok ? r.json() : null)
      .then(fresh => { if (fresh) { _calModalEtag = fresh.etag ?? _calModalEtag; _calModalHref = fresh.href ?? _calModalHref; _calModalCardRefs = fresh.cardRefs || null; } })
      .catch(() => { /* keep cached values */ })
      .finally(() => { if (modal.open) { saveBtn.disabled = false; saveBtn.textContent = 'Save event'; } });

    // Dates — a series edit shows the series start, not the clicked occurrence (see _calSeriesDates)
    const { start: evStart, end: evEnd } = _calModalScope === 'series' ? _calSeriesDates(ev) : { start: ev.start, end: ev.end };
    const startDt  = evStart ? new Date(evStart) : new Date();
    const endDt    = evEnd   ? new Date(evEnd)   : new Date(startDt.getTime() + 3600000);
    const isoLocal = dt => {
      const y = dt.getFullYear(), mo = dt.getMonth() + 1, d = dt.getDate();
      const h = dt.getHours(), mi = dt.getMinutes();
      return {
        date: `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
        time: `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`,
      };
    };
    if (ev.allDay) {
      startDate.value = (evStart || '').slice(0, 10);
      endDate.value   = (evEnd   || '').slice(0, 10) || startDate.value;
    } else {
      const s = isoLocal(startDt), e = isoLocal(endDt);
      startDate.value = s.date; startTime.value = s.time;
      endDate.value   = e.date; endTime.value   = e.time;
    }

    const tz = ev.timezone || _defaultTimezone || browserTz;
    _populateTzSelect(tzSel, tz);
  } else {
    // Create mode
    _calModalMode    = 'create';
    _calModalAccId   = accountId;
    _calModalUid     = null;
    _calModalEtag    = null;
    _calModalCardRefs = null;
    _calModalScope   = null;
    _calModalOccDate = null;
    titleEl.textContent = 'New event';
    repeatToggleRow.hidden = false;

    // Populate account selector
    accField.style.display = '';
    accSel.innerHTML = '';
    const allAccounts = _calAccountsMeta.filter(a => (a.type || 'caldav') !== 'ical-url');
    for (const a of allAccounts) {
      const opt = document.createElement('option');
      opt.value = a.accountId; opt.textContent = a.label || a.accountId;
      if (a.accountId === accountId) opt.selected = true;
      accSel.appendChild(opt);
    }

    titleInput.value = '';
    allDayCb.checked = false;
    locInput.value   = '';
    descInput.value  = '';

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const startH = now.getHours() + 1;
    startDate.value = todayDate; startTime.value = `${pad(startH % 24)}:00`;
    endDate.value   = todayDate; endTime.value   = `${pad((startH + 1) % 24)}:00`;
    if (prefill) {
      const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const hm  = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      allDayCb.checked = !!prefill.allDay;
      startDate.value  = ymd(prefill.start); endDate.value = ymd(prefill.end);
      if (!prefill.allDay) { startTime.value = hm(prefill.start); endTime.value = hm(prefill.end); }
    }

    _populateTzSelect(tzSel, _defaultTimezone || browserTz);
  }

  // Show/hide time fields based on all-day
  const toggleAllDay = () => {
    const ad = allDayCb.checked;
    startTime.style.display = ad ? 'none' : '';
    endTime.style.display   = ad ? 'none' : '';
    tzRow.style.display     = ad ? 'none' : '';
  };
  allDayCb.onchange = toggleAllDay;
  toggleAllDay();

  // Shifting the start moves the end by the same amount (keeps the duration)
  const pad2 = n => String(n).padStart(2, '0');
  const readDt = (d, t) => d.value ? new Date(`${d.value}T${t.value || '00:00'}`) : null;
  let prevStart = readDt(startDate, startTime);
  const shiftEnd = () => {
    const newStart = readDt(startDate, startTime);
    if (!newStart || isNaN(newStart)) return;
    const end = readDt(endDate, endTime);
    if (prevStart && !isNaN(prevStart) && end && !isNaN(end)) {
      const e = new Date(end.getTime() + (newStart - prevStart));
      endDate.value = `${e.getFullYear()}-${pad2(e.getMonth() + 1)}-${pad2(e.getDate())}`;
      if (endTime.value) endTime.value = `${pad2(e.getHours())}:${pad2(e.getMinutes())}`;
    }
    prevStart = newStart;
  };
  startDate.onchange = shiftEnd;
  startTime.onchange = shiftEnd;

  modal.showModal();
}

async function _submitCalEvent() {
  const allDayCb  = document.getElementById('calEventAllDay');
  const startDate = document.getElementById('calEventStartDate');
  const startTime = document.getElementById('calEventStartTime');
  const endDate   = document.getElementById('calEventEndDate');
  const endTime   = document.getElementById('calEventEndTime');
  const errEl     = document.getElementById('calEventError');
  const saveBtn   = document.getElementById('calEventSaveBtn');

  const title    = document.getElementById('calEventTitle').value.trim();
  const allDay   = allDayCb.checked;
  const location = document.getElementById('calEventLocation').value.trim();
  const timezone = allDay ? '' : (document.getElementById('calEventTimezone').value || '');
  const desc     = document.getElementById('calEventDescription').value.trim();

  if (!title) { errEl.textContent = 'Title is required.'; errEl.hidden = false; return; }
  if (!startDate.value) { errEl.textContent = 'Start date is required.'; errEl.hidden = false; return; }

  const start = allDay
    ? startDate.value
    : `${startDate.value}T${startTime.value || '00:00'}:00`;
  const end = allDay
    ? (endDate.value || startDate.value)
    : `${endDate.value || startDate.value}T${endTime.value || '00:00'}:00`;

  errEl.hidden = true;
  saveBtn.textContent = 'Saving\u2026';
  saveBtn.disabled = true;

  const accountId = _calModalMode === 'edit'
    ? _calModalAccId
    : (document.getElementById('calEventAccount').value || _calModalAccId);

  const body = { title, allDay, start, end };
  if (location) body.location = location;
  if (desc)     body.description = desc;
  if (timezone) body.timezone = timezone;
  if (_calModalMode === 'edit' && _calModalEtag)    body.etag = _calModalEtag;
  if (_calModalMode === 'edit' && _calModalHref)    body.href = _calModalHref;
  if (_calModalMode === 'edit' && _calModalScope)   body.editScope = _calModalScope;
  if (_calModalMode === 'edit' && _calModalOccDate) body.occurrenceDate = _calModalOccDate;
  // Non-recurring edits rebuild the ICS — carry the hidden card links over
  if (_calModalMode === 'edit' && _calModalCardRefs?.length) body.cardRefs = _calModalCardRefs;
  // Include rrule for create mode and series edits (not for single-occurrence edits)
  if (_calModalScope !== 'occurrence') {
    const rrule = _buildRRule();
    if (rrule) body.rrule = rrule;
    else if (_calModalMode === 'edit' && _calModalScope === 'series') body.rrule = ''; // signal to remove RRULE
  }

  try {
    let res;
    if (_calModalMode === 'edit') {
      res = await fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(_calModalUid)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || `Error ${res.status}`;
      errEl.hidden = false;
      saveBtn.textContent = 'Save event'; saveBtn.disabled = false;
      return;
    }

    document.getElementById('calEventModal').close();
    await _refreshCalendarAccount(accountId);
    _closeDetail();
    if (_cvIsOpen()) _cvLoad();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    saveBtn.textContent = 'Save event'; saveBtn.disabled = false;
  }
}

async function _deleteCalEvent(accountId, uid, etag, href, scope, occurrenceDate) {
  // Show confirm immediately from cached data — no network wait
  const ev      = _calEventMap.get(`${accountId}\0${uid}`);
  const title   = ev?.title || 'this event';
  const dateStr = occurrenceDate
    ? fmtDate(new Date(occurrenceDate).toISOString().slice(0, 10))
    : (ev?.start ? fmtDate(ev.start.slice(0, 10)) : '');

  let msg;
  if (scope === 'occurrence') {
    msg = dateStr ? `Delete this occurrence of \u201c${title}\u201d on ${dateStr}?` : `Delete this occurrence of \u201c${title}\u201d?`;
  } else if (scope === 'series') {
    msg = `Delete the entire series \u201c${title}\u201d and all its occurrences?`;
  } else {
    msg = dateStr ? `Delete \u201c${title}\u201d on ${dateStr}?` : `Delete \u201c${title}\u201d?`;
  }

  const ok = await showConfirm(msg, { okLabel: 'Delete', danger: true });
  if (!ok) return;

  // Fetch fresh etag/href now that user has confirmed
  try {
    const fresh = await fetch(
      `/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(uid)}`
    ).then(r => r.ok ? r.json() : null);
    if (fresh) { etag = fresh.etag ?? etag; href = fresh.href ?? href; }
  } catch { /* fall back to cached values */ }

  const headers = {};
  if (etag) headers['If-Match'] = etag;
  const qp = new URLSearchParams();
  if (href) qp.set('href', href);
  if (scope === 'occurrence' && occurrenceDate) {
    qp.set('editScope', 'occurrence');
    qp.set('occurrenceDate', occurrenceDate);
  }
  const qs = qp.toString() ? '?' + qp.toString() : '';
  try {
    const res = await fetch(
      `/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(uid)}${qs}`,
      { method: 'DELETE', headers }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      await showConfirm(data.error || `Delete failed (${res.status})`, { okLabel: 'OK', hideCancel: true });
      return;
    }
    _closeDetail();
    await _refreshCalendarAccount(accountId);
    if (_cvIsOpen()) _cvLoad();
  } catch (err) {
    await showConfirm(err.message, { okLabel: 'OK', hideCancel: true });
  }
}

/** After an event was created / changed / deleted: reload the Today agenda (calendar view reloads itself). */
async function _refreshCalendarAccount() {
  if (typeof _todayRefresh === 'function') _todayRefresh('calendar');
}

// ---- Recurrence helpers ----

/** Update interval unit label and show/hide BYDAY row based on frequency. */
function _updateFreqUi(freq) {
  const units = { DAILY: 'day(s)', WEEKLY: 'week(s)', MONTHLY: 'month(s)', YEARLY: 'year(s)' };
  document.getElementById('calEventIntervalUnit').textContent = units[freq] || 'occurrence(s)';
  document.getElementById('calEventBydayRow').hidden = freq !== 'WEEKLY';
}

/** Pre-select the day-of-week checkbox that matches the current start date. */
function _preselectStartDay() {
  const val = document.getElementById('calEventStartDate').value;
  if (!val) return;
  const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const dow = dayNames[new Date(val + 'T12:00:00').getDay()];
  for (const cb of document.querySelectorAll('#calEventBydayRow .cal-event-day-btn input')) {
    cb.checked = cb.value === dow;
  }
}

/**
 * Build an RRULE string from the current repeat UI state.
 * Returns '' when the Repeat checkbox is unchecked.
 */
function _buildRRule() {
  if (!document.getElementById('calEventRepeat').checked) return '';
  const freq     = document.getElementById('calEventFreq').value;
  const interval = Math.max(1, parseInt(document.getElementById('calEventInterval').value, 10) || 1);

  let rrule = `FREQ=${freq}`;
  if (interval > 1) rrule += `;INTERVAL=${interval}`;

  if (freq === 'WEEKLY') {
    const days = [...document.querySelectorAll('#calEventBydayRow .cal-event-day-btn input:checked')]
      .map(cb => cb.value);
    if (days.length > 0) rrule += `;BYDAY=${days.join(',')}`;
  }

  const endsVal = document.querySelector('input[name="calEventEnds"]:checked')?.value || 'never';
  if (endsVal === 'count') {
    const count = Math.max(1, parseInt(document.getElementById('calEventCount').value, 10) || 10);
    rrule += `;COUNT=${count}`;
  } else if (endsVal === 'until') {
    const until = document.getElementById('calEventUntil').value; // YYYY-MM-DD
    if (until) {
      const allDay = document.getElementById('calEventAllDay').checked;
      if (allDay) {
        rrule += `;UNTIL=${until.replace(/-/g, '')}`;
      } else {
        // Timed events: UNTIL in UTC datetime format (end of that day)
        const d = new Date(until + 'T23:59:59Z');
        rrule += `;UNTIL=${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
      }
    }
  }

  return rrule;
}

/**
 * Populate the repeat UI from an existing RRULE string.
 * e.g. "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2"
 */
function _parseRRuleToUi(rruleStr) {
  if (!rruleStr) return;
  const parts = {};
  for (const part of rruleStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0) parts[part.substring(0, eq).toUpperCase()] = part.substring(eq + 1);
  }

  document.getElementById('calEventRepeat').checked = true;
  document.getElementById('calEventRepeatSection').hidden = false;

  const freq = parts.FREQ || 'WEEKLY';
  document.getElementById('calEventFreq').value = freq;
  document.getElementById('calEventInterval').value = parts.INTERVAL || '1';
  _updateFreqUi(freq);

  if (freq === 'WEEKLY' && parts.BYDAY) {
    const days = parts.BYDAY.split(',').map(d => d.trim().toUpperCase());
    for (const cb of document.querySelectorAll('#calEventBydayRow .cal-event-day-btn input')) {
      cb.checked = days.includes(cb.value);
    }
  }

  if (parts.COUNT) {
    document.querySelector('input[name="calEventEnds"][value="count"]').checked = true;
    document.getElementById('calEventCount').value = parts.COUNT;
  } else if (parts.UNTIL) {
    document.querySelector('input[name="calEventEnds"][value="until"]').checked = true;
    const u = parts.UNTIL;
    document.getElementById('calEventUntil').value =
      `${u.substring(0, 4)}-${u.substring(4, 6)}-${u.substring(6, 8)}`;
  } else {
    document.querySelector('input[name="calEventEnds"][value="never"]').checked = true;
  }
}

/** Reset the repeat section to its default empty state. */
function _resetRepeatUi() {
  document.getElementById('calEventRepeat').checked = false;
  document.getElementById('calEventRepeatSection').hidden = true;
  document.getElementById('calEventFreq').value = 'WEEKLY';
  document.getElementById('calEventInterval').value = '1';
  _updateFreqUi('WEEKLY');
  for (const cb of document.querySelectorAll('#calEventBydayRow .cal-event-day-btn input')) cb.checked = false;
  document.querySelector('input[name="calEventEnds"][value="never"]').checked = true;
  document.getElementById('calEventCount').value = '10';
  document.getElementById('calEventUntil').value = '';
}

// ---- Calendar event modal wiring ----

(function _initCalEventModal() {
  const modal    = document.getElementById('calEventModal');
  const closeBtn = document.getElementById('calEventModalClose');
  const cancelBtn = document.getElementById('calEventCancelBtn');
  const saveBtn  = document.getElementById('calEventSaveBtn');

  closeBtn.addEventListener('click',  () => modal.close());
  cancelBtn.addEventListener('click', () => modal.close());
  saveBtn.addEventListener('click',   () => _submitCalEvent());

  // Keyboard: Enter submits (except in textarea), Escape closes (native for dialog)
  modal.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      _submitCalEvent();
    }
  });

  // Repeat toggle
  document.getElementById('calEventRepeat').addEventListener('change', function () {
    document.getElementById('calEventRepeatSection').hidden = !this.checked;
    if (this.checked && document.getElementById('calEventFreq').value === 'WEEKLY') {
      _preselectStartDay();
    }
  });

  // Frequency change → update unit label + BYDAY visibility
  document.getElementById('calEventFreq').addEventListener('change', function () {
    _updateFreqUi(this.value);
    if (this.value === 'WEEKLY') _preselectStartDay();
  });

  // Clicking "After" or "On" radio selects it automatically via the label,
  // but clicking the nested input shouldn't propagate to the label radio
  for (const inp of document.querySelectorAll('.cal-event-ends-input')) {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('focus', function () {
      const radio = this.closest('.cal-event-ends-row')?.querySelector('input[type=radio]');
      if (radio) radio.checked = true;
    });
  }
})();
