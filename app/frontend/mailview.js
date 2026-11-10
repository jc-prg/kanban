// ---- Mail view (folders / message list / reader / compose) — opened from the Focus mail panel ----
// Shares the overlay slot with the calendar view (calview.js): opening one replaces the other.

const _MV_COLLAPSED_KEY = 'mail-view-collapsed';
const _MV_SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
const _MV_NO_ROLLUP     = new Set(['\\Trash', '\\Junk']);   // unread counts not summed into collapsed parents
const _MV_WIDTHS_KEY    = 'mail-view-widths';
// Trash / spam folders offering "Empty folder" (same rules as isEmptyableFolder in backend/dashboard/mail.js)
const _MV_EMPTYABLE_USES  = new Set(['\\Trash', '\\Junk']);
const _MV_EMPTYABLE_NAMES = new Set([
  'trash', 'spam', 'junk', 'junk-e-mail', 'junk e-mail', 'junk-mail', 'gelöschte elemente',
  'gelöschte objekte', 'deleted items', 'deleted messages', 'papierkorb', 'bulk mail',
]);
const _MV_DEFAULT_W     = { folders: 210, list: 340 };
const _MV_MIN_W         = { folders: 120, list: 180 };

let _mvAccounts    = [];          // [{ accountId, label, color, webInterfaceUrl, own: [addr], canSend }]
let _mvFolders     = new Map();   // accountId → { list: [folder], error }
let _mvAccountId   = null;        // account of the open folder
let _mvFolder      = 'INBOX';     // open folder path
let _mvMsgs        = [];          // summaries of the loaded pages
let _mvTotal       = 0;
let _mvPage        = 0;
let _mvQuery       = '';
let _mvSelId       = null;        // uid of the message open in the reader
let _mvChecked     = new Set();   // uids marked in the list (Shift / Ctrl+click); the open one is always included
let _mvAnchor      = null;        // anchor of Shift+click ranges
let _mvMsg         = null;        // full selected message
let _mvCollapsed   = _mvLoadCollapsed();
let _mvPushed      = false;       // true when open() pushed a history entry
let _mvListSeq     = 0;           // discards responses of superseded list loads
let _mvPlain       = false;       // open message shown as plain text (HTML is the default)
let _mvMsgSeq      = 0;
let _mvCompose     = null;        // { files: [File], reply: { uid, folder } | null, dirty }
let _mvDashStale   = false;       // something changed → reload the dashboard mail panel on close
let _mvWidths      = _mvLoadWidths(); // requested column widths (px); applied clamped to the body width

// ---- Pure helpers (unit-tested) ----

function _mvParentPath(f) {
  const i = f.delimiter ? f.path.lastIndexOf(f.delimiter) : -1;
  return i > 0 ? f.path.slice(0, i) : '';
}

function _mvLeafName(path, delimiter) {
  const i = delimiter ? path.lastIndexOf(delimiter) : -1;
  return i >= 0 ? path.slice(i + delimiter.length) : path;
}

function _mvSpecialRank(f) {
  if (f.path.toUpperCase() === 'INBOX') return 0;
  const i = _MV_SPECIAL_ORDER.indexOf(f.specialUse);
  return i < 0 ? 99 : i;
}

/** Flat folder list → [{ folder, children }], inbox and special folders first, then by name. */
function _mvBuildTree(folders) {
  const nodes = new Map(folders.map(f => [f.path, { folder: f, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(_mvParentPath(node.folder));
    (parent && parent !== node ? parent.children : roots).push(node);
  }
  const sort = list => {
    list.sort((a, b) => _mvSpecialRank(a.folder) - _mvSpecialRank(b.folder)
      || (a.folder.name || a.folder.path).localeCompare(b.folder.name || b.folder.path, undefined, { sensitivity: 'base' }));
    list.forEach(n => sort(n.children));
    return list;
  };
  return sort(roots);
}

/** Unread messages in a subtree (Trash / Junk excluded below the top node). */
function _mvSubtreeUnseen(node, top = true) {
  if (!top && _MV_NO_ROLLUP.has(node.folder.specialUse)) return 0;
  return (node.folder.unseen || 0) + node.children.reduce((n, c) => n + _mvSubtreeUnseen(c, false), 0);
}

/** "Re: …" without stacking prefixes (also recognises German AW:). */
function _mvReplySubject(subject) {
  const s = (subject || '').trim();
  return /^(re|aw|antw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** "Fwd: …" without stacking prefixes (also recognises FW: and German WG:). */
function _mvForwardSubject(subject) {
  const s = (subject || '').trim();
  return /^(fwd?|wg)\s*:/i.test(s) ? s : `Fwd: ${s}`;
}

/** Split an address list on , or ; outside quotes and angle brackets. */
function _mvSplitAddrs(str) {
  const out = [];
  let cur = '', quoted = false, angle = false;
  let esc = false;
  for (const ch of str || '') {
    if (esc) { esc = false; cur += ch; continue; }
    if (ch === '\\' && quoted) { esc = true; cur += ch; continue; }   // \" inside a quoted name
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  // Unquoted "Doe, Jane <jane@x>" (older server responses): a fragment without any address belongs
  // to the next entry — rebuilt as a quoted name so replies stay valid
  for (let i = out.length - 2; i >= 0; i--) {
    const m = !/[@<]/.test(out[i]) && out[i + 1].match(/^([^"<]*?)\s*(<[^<>]+>)$/);
    if (m) out.splice(i, 2, `"${`${out[i]}, ${m[1]}`.trim().replace(/(["\\])/g, '\\$1')}" ${m[2]}`);
  }
  return out;
}

/** Bare lower-case address of "Name <a@b>" or "a@b". */
function _mvAddrOf(entry) {
  const m = (entry || '').match(/<([^<>]+)>\s*$/);
  return (m ? m[1] : entry || '').trim().toLowerCase();
}

/** Display name of "Name <a@b>" (falls back to the address). */
function _mvDisplayName(entry) {
  const first = _mvSplitAddrs(entry)[0] || '';
  const name  = first.replace(/<[^<>]*>\s*$/, '').trim().replace(/^"(.*)"$/, (m, q) => q.replace(/\\(.)/g, '$1'));
  return name || _mvAddrOf(first);
}

/** Sender addresses of an SMTP `fromAddress` ("a@x, Name <b@x>"), bare and de-duplicated; falls back to `fallback`. */
function _mvParseSenders(str, fallback) {
  const out = [];
  for (const e of _mvSplitAddrs(str)) {
    const a = _mvAddrOf(e);
    if (a.includes('@') && !out.includes(a)) out.push(a);
  }
  if (!out.length && fallback && fallback.includes('@')) out.push(fallback.trim().toLowerCase());
  return out;
}

/** Sender for a reply: the configured address the original was sent to (To, then Cc), else the first one. */
function _mvReplySender(msg, senders) {
  const rcpt = [..._mvSplitAddrs(msg?.to), ..._mvSplitAddrs(msg?.cc)].map(_mvAddrOf);
  return rcpt.find(a => senders.includes(a)) || senders[0] || '';
}

/**
 * Recipients, subject and threading headers for a reply.
 * `all` = reply all; `own` = the account's own addresses (never re-added).
 */
function _mvReplyFields(msg, all, own) {
  const ownSet  = new Set((own || []).map(a => a.toLowerCase()));
  let primary   = _mvSplitAddrs(msg.replyTo || msg.from);
  // Answering one's own sent mail: write to its recipients instead
  if (primary.length && primary.every(e => ownSet.has(_mvAddrOf(e))) && msg.to) primary = _mvSplitAddrs(msg.to);
  const seen = new Set(primary.map(_mvAddrOf));
  const keep = e => {
    const a = _mvAddrOf(e);
    if (!a || ownSet.has(a) || seen.has(a)) return false;
    seen.add(a);
    return true;
  };
  const to = all ? [...primary, ..._mvSplitAddrs(msg.to).filter(keep)] : primary;
  const cc = all ? _mvSplitAddrs(msg.cc).filter(keep) : [];
  const references = [...(msg.references || [])];
  if (msg.messageId && !references.includes(msg.messageId)) references.push(msg.messageId);
  return {
    to:         to.join(', '),
    cc:         cc.join(', '),
    subject:    _mvReplySubject(msg.subject),
    inReplyTo:  msg.messageId || '',
    references,
  };
}

/**
 * Body of the original as editor-safe HTML (no styles / classes leaking into the app).
 * The editor lives in the app document, so trackers and (unless the sender is trusted)
 * remote images are removed first — quoting must not load them.
 */
function _mvOriginalHtml(msg) {
  return msg.bodyHtml
    ? DOMPurify.sanitize(_mailPrivacyHtml(msg.bodyHtml, { loadImages: _mailImagesAllowed(msg) }).html,
        { FORBID_TAGS: ['style', 'link', 'meta', 'title'], FORBID_ATTR: ['class', 'id', 'data-jc-blocked'] })
    : escHtml(msg.body || '').replace(/\r?\n/g, '<br>');
}

/** Quoted original below an empty first line. */
function _mvQuoteHtml(msg) {
  const when = msg.date ? new Date(msg.date).toLocaleString() : '';
  const head = `On ${when}, ${msg.from || ''} wrote:`;
  return `<p><br></p><p>${escHtml(head)}</p><blockquote type="cite">${_mvOriginalHtml(msg)}</blockquote>`;
}

/** Forwarded original: header block (From / Date / Subject / To / Cc) followed by the body. */
function _mvForwardHtml(msg) {
  const rows = [
    ['From', msg.from], ['Date', msg.date ? new Date(msg.date).toLocaleString() : ''],
    ['Subject', msg.subject], ['To', msg.to], ['Cc', msg.cc],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${escHtml(v)}`);
  return `<p><br></p><p>-------- Forwarded message --------<br>${rows.join('<br>')}</p><br>${_mvOriginalHtml(msg)}`;
}

/** Same format as the dashboard mail panel: "hh:mm" today, else "dd.mm. hh:mm" (plus "yy" for other years). */
function _mvFmtListDate(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p2 = n => String(n).padStart(2, '0');
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  const year = d.getFullYear() === now.getFullYear() ? '' : p2(d.getFullYear() % 100);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${year} ${time}`;
}

function _mvFmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** True for trash / spam folders, which can be emptied. */
function _mvIsEmptyable(f, trashFolder) {
  if (_MV_EMPTYABLE_USES.has(f.specialUse)) return true;
  if (trashFolder && f.path === trashFolder) return true;
  return _MV_EMPTYABLE_NAMES.has(String(f.name || f.path).trim().toLowerCase());
}

/** Display name of a folder ("INBOX" → "Inbox"). */
function _mvFolderLabel(f) {
  return f.path.toUpperCase() === 'INBOX' ? 'Inbox' : (f.name || f.path);
}

/** { accountId, folder } from a query string; null when the mail view is not requested. */
function _mvParseUrl(search) {
  const params = new URLSearchParams(search);
  if (!params.has('mail')) return null;
  return { accountId: params.get('mail') || null, folder: params.get('folder') || 'INBOX', mid: params.get('mid') || null };
}

/**
 * Column widths that fit `total`: each column at least its minimum, folders + list
 * together at most half of the width so the reader keeps ≥ 50 %. The list gives way first.
 */
function _mvClampWidths(w, total) {
  const max = Math.floor(total / 2);
  const folders = Math.max(_MV_MIN_W.folders, Math.min(w.folders, max - _MV_MIN_W.list));
  const list    = Math.max(_MV_MIN_W.list, Math.min(w.list, max - folders));
  return { folders, list };
}

// ---- Persistence ----

function _mvLoadWidths() {
  try {
    const w = JSON.parse(localStorage.getItem(_MV_WIDTHS_KEY));
    if (w && Number.isFinite(w.folders) && Number.isFinite(w.list)) return { folders: w.folders, list: w.list };
  } catch { /* ignore */ }
  return { ..._MV_DEFAULT_W };
}

function _mvSaveWidths() {
  try { localStorage.setItem(_MV_WIDTHS_KEY, JSON.stringify(_mvWidths)); } catch { /* ignore */ }
}

/** Apply the requested widths, clamped to the current body width. */
function _mvApplyWidths() {
  const body = document.querySelector('#mailView .mailview-body');
  if (!body || !body.clientWidth) return;
  const w = _mvClampWidths(_mvWidths, body.clientWidth);
  body.style.setProperty('--mv-folders-w', `${w.folders}px`);
  body.style.setProperty('--mv-list-w', `${w.list}px`);
}

function _mvLoadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(_MV_COLLAPSED_KEY)) || []); } catch { return new Set(); }
}

function _mvToggleCollapsed(key) {
  if (_mvCollapsed.has(key)) _mvCollapsed.delete(key); else _mvCollapsed.add(key);
  try { localStorage.setItem(_MV_COLLAPSED_KEY, JSON.stringify([..._mvCollapsed])); } catch { /* ignore */ }
  _mvRenderTree();
}

// ---- Open / close / URL state ----

function _mvIsOpen() {
  const el = document.getElementById('mailView');
  return !!el && el.style.display !== 'none';
}

function _mvSetUrl(push) {
  const url = new URL(window.location.href);
  url.searchParams.delete('cal');
  url.searchParams.delete('date');
  url.searchParams.delete('mid');
  url.searchParams.set('mail', _mvAccountId || '');
  url.searchParams.set('folder', _mvFolder);
  if (push) history.pushState({ mailView: true }, '', url);
  else history.replaceState(history.state, '', url);
}

function openMailView(accountId, folder) {
  // Exclusive with the calendar view: take over its history entry instead of stacking another
  let push = true;
  if (_cvIsOpen()) {
    _mvPushed = _cvPushed;
    _cvPushed = false;
    _cvHide();
    push = false;
  } else {
    _mvPushed = true;
  }
  if (accountId) _mvAccountId = accountId;
  _mvFolder = folder || (accountId ? 'INBOX' : _mvFolder || 'INBOX');
  _mvSetUrl(push);
  _mvShow();
}

async function closeMailView() {
  if (!_mvIsOpen()) return;
  if (_mvCompose?.dirty && !(await showConfirm('Discard the message you are writing?', { okLabel: 'Discard', danger: true }))) return;
  _mvHide();
  if (_mvPushed) { _mvPushed = false; history.back(); return; }
  const url = new URL(window.location.href);
  url.searchParams.delete('mail');
  url.searchParams.delete('folder');
  url.searchParams.delete('mid');
  history.replaceState(history.state, '', url);
}

/** Open the mail view on the message with this Message-ID (e.g. from a card's mailRef). */
function openMailViewMessage(accountId, messageId, folderHint) {
  openMailView(accountId, folderHint || 'INBOX');
  _mvOpenByMessageId(accountId, messageId, folderHint);
}

/**
 * Locate a message by Message-ID, switch to its folder and open it. The hint folder is
 * checked first; if the mail was moved, all folders are searched behind a cancellable dialog.
 */
async function _mvOpenByMessageId(accountId, messageId, folderHint) {
  const locate = (scope, signal) => {
    const qs = new URLSearchParams({ messageId, ...(folderHint ? { folder: folderHint } : {}), ...(scope ? { scope } : {}) });
    return _mvJson(_mvApi(accountId, `/locate?${qs}`), signal ? { signal } : undefined);
  };
  let found = null;
  try {
    found = await locate('hint');
  } catch (err) {
    if (!/not found/i.test(err.message)) { showMessage(`Could not open the mail: ${err.message}`); return; }
  }
  if (!found) {
    if (!_mvIsOpen()) return;
    const ctrl = new AbortController();
    const dlg  = showProgress(`The mail is no longer in "${folderHint || 'INBOX'}" — searching all folders…`);
    dlg.cancelled.then(() => ctrl.abort());
    try {
      found = await locate('', ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      dlg.close();
      showMessage(/not found/i.test(err.message)
        ? 'The mail could not be found in any folder. It may have been deleted.'
        : `Could not search for the mail: ${err.message}`);
      return;
    }
    dlg.close();
  }
  if (!_mvIsOpen()) return;
  if (found.folder !== _mvFolder || accountId !== _mvAccountId) _mvSelectFolder(accountId, found.folder);
  _mvOpenMessage(found.uid);
}

function _mvShow() {
  _overlaySyncHeaderOffset();
  const view = document.getElementById('mailView');
  view.style.display = '';
  _syncOverlayHost();
  view.dataset.pane = 'list';
  _mvApplyWidths();
  document.body.classList.add('mailview-open');
  document.getElementById('dashboardMailBtn')?.classList.add('open');
  _mvReload();
}

function _mvHide() {
  const view = document.getElementById('mailView');
  if (!view) return;
  view.style.display = 'none';
  _syncOverlayHost();
  document.body.classList.remove('mailview-open');
  document.getElementById('dashboardMailBtn')?.classList.remove('open');
  _mvCompose = null;
  _mvClosePicker(null);
  if (_mvDashStale) { _mvDashStale = false; if (APP_PATH === '/focus') _reloadMailPanel(); }
}

/** Open the view if the URL asks for it (called once the dashboard is initialised). */
function _mvInitFromUrl() {
  const req = _mvParseUrl(window.location.search);
  if (!req) { if (_mvIsOpen()) _mvHide(); return; }
  const changed = req.accountId !== _mvAccountId || req.folder !== _mvFolder;
  _mvAccountId = req.accountId;
  _mvFolder    = req.folder;
  if (!_mvIsOpen()) _mvShow();
  else if (changed) _mvSelectFolder(_mvAccountId, _mvFolder, { url: false });
  if (req.mid && req.accountId) {
    _mvSetUrl(false);   // drop ?mid= so reloads / back navigation don't reopen it
    _mvOpenByMessageId(req.accountId, req.mid, req.folder);
  }
}

// ---- Data ----

function _mvApi(accountId, path = '') {
  return `/api/dashboard/mail/${encodeURIComponent(accountId)}${path}`;
}

function _mvFolderQs(folder = _mvFolder) {
  return `folder=${encodeURIComponent(folder)}`;
}

async function _mvJson(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Reload accounts, folder trees and the open folder. */
async function _mvReload() {
  _mvRenderTree();
  _mvRenderList();
  _mvRenderReader();
  try {
    const cfg = await _mvJson('/api/dashboard/config');
    _mvAccounts = (cfg.mailAccounts || []).map(a => ({
      accountId:       a.id,
      label:           a.label || a.user || a.id,
      color:           a.color || null,
      webInterfaceUrl: a.webInterfaceUrl || null,
      senders:         _mvParseSenders(a.smtp?.fromAddress, a.user),
      own:             [a.user, ..._mvParseSenders(a.smtp?.fromAddress)].filter(x => x && x.includes('@')),
      canSend:         !!a.smtp?.host,
      trashFolder:     a.trashFolder || null,
    }));
  } catch { _mvAccounts = []; }
  if (!_mvAccounts.some(a => a.accountId === _mvAccountId)) {
    _mvAccountId = _mvAccounts[0]?.accountId || null;
    _mvFolder    = 'INBOX';
    if (_mvAccountId) _mvSetUrl(false);
  }
  _mvRenderToolbar();
  await Promise.all([
    ..._mvAccounts.map(a => _mvLoadFolders(a.accountId)),
    _mvLoadList(0),
    _mvLoadFolderSize(),
  ]);
}

async function _mvLoadFolders(accountId) {
  try {
    const data = await _mvJson(_mvApi(accountId, '/folders?status=1'));
    _mvFolders.set(accountId, { list: data.folders || [], error: null });
  } catch (err) {
    _mvFolders.set(accountId, { list: _mvFolders.get(accountId)?.list || [], error: err.message });
  }
  _mvRenderTree();
  _mvRenderToolbar();
}

let _mvFolderTimer = null;
/** Refresh unread counts (and the open folder's size) shortly after a mutation (batched). */
function _mvRefreshFoldersSoon(accountId) {
  clearTimeout(_mvFolderTimer);
  _mvFolderTimer = setTimeout(() => {
    _mvLoadFolders(accountId);
    if (accountId === _mvAccountId) _mvLoadFolderSize();
  }, 800);
}

let _mvSizeSeq = 0;
/** Size of the open folder in the folder-column footer (sum of message sizes, fetched server-side). */
async function _mvLoadFolderSize() {
  const el = document.getElementById('mailViewFolderSize');
  if (!el) return;
  const seq = ++_mvSizeSeq;
  const accountId = _mvAccountId, folder = _mvFolder;
  if (!accountId) { el.textContent = ''; el.title = ''; return; }
  el.textContent = '\u2026';
  let data;
  try {
    data = await _mvJson(_mvApi(accountId, `/folder-size?${_mvFolderQs(folder)}`));
  } catch (err) {
    if (seq === _mvSizeSeq) { el.textContent = ''; el.title = err.message; }
    return;
  }
  if (seq !== _mvSizeSeq) return;
  const f = _mvFolderInfo(accountId, folder);
  const name = f ? _mvFolderLabel(f) : _mvLeafName(folder, '/');
  const size = data.size ?? 0, messages = data.messages ?? 0;
  el.textContent = `${name}: ${_mvFmtSize(size) || '0 B'}`;
  el.title = `${name}: ${messages} message${messages === 1 ? '' : 's'}, ${size.toLocaleString()} bytes`;
}

async function _mvLoadList(page) {
  if (!_mvAccountId) { _mvMsgs = []; _mvTotal = 0; _mvRenderList(); return; }
  const seq = ++_mvListSeq;
  const list = document.getElementById('mailViewList');
  list.classList.add('mailview-loading');
  let data;
  try {
    const q = _mvQuery ? `&q=${encodeURIComponent(_mvQuery)}` : '';
    data = await _mvJson(_mvApi(_mvAccountId, `/messages?${_mvFolderQs()}&page=${page}${q}`));
  } catch (err) {
    data = { messages: [], total: 0, error: err.message };
  }
  if (seq !== _mvListSeq) return;
  list.classList.remove('mailview-loading');
  _mvPage  = page;
  _mvTotal = data.total || 0;
  _mvMsgs  = page === 0 ? data.messages : [..._mvMsgs, ...data.messages];
  _mvChecked = new Set([..._mvChecked].filter(id => _mvMsgs.some(m => m.id === id)));
  _mvRenderList(data.error);
}

function _mvFolderInfo(accountId = _mvAccountId, path = _mvFolder) {
  return _mvFolders.get(accountId)?.list.find(f => f.path === path) || null;
}

function _mvAdjustUnseen(delta, accountId = _mvAccountId, path = _mvFolder) {
  const f = _mvFolderInfo(accountId, path);
  if (f && typeof f.unseen === 'number') f.unseen = Math.max(0, f.unseen + delta);
  _mvRenderTree();
}

// ---- Navigation ----

function _mvSelectFolder(accountId, path, { url = true } = {}) {
  _mvAccountId = accountId;
  _mvFolder    = path;
  _mvSelId     = null;
  _mvMsg       = null;
  _mvChecked   = new Set();
  _mvAnchor    = null;
  _mvMsgs      = [];
  _mvTotal     = 0;
  if (url) _mvSetUrl(false);
  if (!_mvCompose) _mvRenderReader();
  _mvSetPane('list');
  _mvRenderTree();
  _mvRenderToolbar();
  _mvRenderList();
  _mvLoadList(0);
  _mvLoadFolderSize();
}

/** Phones show one column at a time. */
function _mvSetPane(pane) {
  document.getElementById('mailView').dataset.pane = pane;
}

async function _mvOpenMessage(id) {
  if (_mvCompose?.dirty && !(await showConfirm('Discard the message you are writing?', { okLabel: 'Discard', danger: true }))) return;
  _mvCompose = null;
  _mvSelId = id;
  _mvMsg   = null;
  _mvPlain = false;
  _mvChecked = new Set([id]);
  _mvAnchor  = id;
  _mvRenderListSelection();
  _mvSetPane('reader');
  _mvRenderReader('loading');
  const seq = ++_mvMsgSeq;
  const accountId = _mvAccountId, folder = _mvFolder;
  let msg;
  try {
    msg = await _mvJson(_mvApi(accountId, `/message/${encodeURIComponent(id)}?${_mvFolderQs(folder)}`));
  } catch (err) {
    if (seq === _mvMsgSeq) _mvRenderReader('error', err.message);
    return;
  }
  if (seq !== _mvMsgSeq) return;
  _mvMsg = msg;
  _mvRenderReader();
  const summary = _mvMsgs.find(m => m.id === id);
  if (summary?.unread) _mvSetUnread([id], false);
}

function _mvMoveSelection(dir) {
  if (!_mvMsgs.length) return;
  const i = _mvMsgs.findIndex(m => m.id === _mvSelId);
  const next = _mvMsgs[Math.max(0, Math.min(_mvMsgs.length - 1, i < 0 ? 0 : i + dir))];
  if (next && next.id !== _mvSelId) {
    _mvOpenMessage(next.id);
    document.querySelector(`#mailViewList [data-mv-msg="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

// ---- Selection: click opens, Shift+click adds a range, Ctrl/Cmd+click toggles one ----

/** Ids from a to b (inclusive, either direction) in list order. */
function _mvRangeIds(ids, a, b) {
  const i = ids.indexOf(a), j = ids.indexOf(b);
  if (j < 0) return [];
  if (i < 0) return [b];
  return ids.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Selected ids in list order; falls back to the open message. */
function _mvSelectedIds() {
  const ids = _mvMsgs.filter(m => _mvChecked.has(m.id)).map(m => m.id);
  return ids.length ? ids : (_mvSelId ? [_mvSelId] : []);
}

function _mvClickMessage(e, id) {
  if (e.shiftKey && _mvAnchor) {
    for (const x of _mvRangeIds(_mvMsgs.map(m => m.id), _mvAnchor, id)) _mvChecked.add(x);
    _mvRenderListSelection();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (!_mvChecked.size && _mvSelId) _mvChecked.add(_mvSelId);
    if (_mvChecked.has(id)) _mvChecked.delete(id); else _mvChecked.add(id);
    _mvAnchor = id;
    _mvRenderListSelection();
    return;
  }
  _mvOpenMessage(id);
}

// ---- Message actions (all take a list of ids → one request with a UID set) ----

function _mvMessagesUrl(ids, suffix, folder) {
  return _mvApi(_mvAccountId, `/message/${ids.join(',')}${suffix}?${_mvFolderQs(folder)}`);
}

async function _mvSetUnread(ids, unread) {
  const changed = ids.map(id => _mvMsgs.find(x => x.id === id)).filter(m => m && m.unread !== unread);
  if (!changed.length) return;
  changed.forEach(m => { m.unread = unread; });
  _mvAdjustUnseen(unread ? changed.length : -changed.length);
  _mvRenderList();
  if (_mvMsg && ids.includes(_mvMsg.id)) _mvRenderReaderActions();
  _mvDashStale = true;
  try {
    await _mvJson(_mvMessagesUrl(changed.map(m => m.id), ''), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seen: !unread }),
    });
  } catch (err) {
    _mvFlash(`Could not update ${changed.length === 1 ? 'message' : 'messages'}: ${err.message}`, true);
    _mvLoadList(0);
  }
}

/**
 * Remove messages from the list; if the open one goes, open its neighbour
 * (`stay`: just close it and keep showing the list — swipe actions on phones).
 */
function _mvDropFromList(ids, { stay = false } = {}) {
  const drop = new Set(ids);
  const first = _mvMsgs.findIndex(m => drop.has(m.id));
  if (first < 0) return;
  const removed = _mvMsgs.filter(m => drop.has(m.id));
  _mvMsgs  = _mvMsgs.filter(m => !drop.has(m.id));
  _mvTotal = Math.max(0, _mvTotal - removed.length);
  const unread = removed.filter(m => m.unread).length;
  if (unread) _mvAdjustUnseen(-unread);
  ids.forEach(id => _mvChecked.delete(id));
  if (_mvSelId && drop.has(_mvSelId)) {
    const next = _mvMsgs[first] || _mvMsgs[first - 1];
    _mvSelId = null;
    _mvMsg   = null;
    if (next && !stay) _mvOpenMessage(next.id);
    else { _mvRenderReader(); _mvSetPane('list'); }
  }
  _mvRenderList();
}

async function _mvDeleteMessages(ids, opts = {}) {
  if (!ids.length) return;
  const accountId = _mvAccountId, folder = _mvFolder;
  const f = _mvFolderInfo();
  // Several messages out of trash / spam: deletion may be permanent → ask first
  if (ids.length > 1 && f && _mvIsEmptyable(f, _mvAccounts.find(a => a.accountId === accountId)?.trashFolder)
      && !(await showConfirm(`Delete ${ids.length} messages from "${_mvFolderLabel(f)}"? This cannot be undone.`, { okLabel: 'Delete', danger: true }))) return;
  _mvDropFromList(ids, opts);
  _mvDashStale = true;
  const n = ids.length === 1 ? 'Message' : `${ids.length} messages`;
  try {
    const res = await _mvJson(_mvMessagesUrl(ids, '', folder), { method: 'DELETE' });
    _mvFlash(res.permanent ? `${n} deleted permanently` : `${n} moved to trash`);
  } catch (err) {
    _mvFlash(`Delete failed: ${err.message}`, true);
    _mvLoadList(0);
  }
  _mvRefreshFoldersSoon(accountId);
}

async function _mvMoveMessages(ids, target, accountId = _mvAccountId, folder = _mvFolder, opts = {}) {
  if (!ids.length || target === folder) return;
  if (accountId === _mvAccountId && folder === _mvFolder) _mvDropFromList(ids, opts);
  _mvDashStale = true;
  try {
    await _mvJson(_mvApi(accountId, `/message/${ids.join(',')}/move?${_mvFolderQs(folder)}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: target }),
    });
    _addRecentFolder(accountId, target);
    const tf = _mvFolderInfo(accountId, target);
    _mvFlash(`${ids.length === 1 ? 'Moved' : `${ids.length} messages moved`} to ${tf ? _mvFolderLabel(tf) : target}`);
  } catch (err) {
    _mvFlash(`Move failed: ${err.message}`, true);
    _mvLoadList(0);
  }
  _mvRefreshFoldersSoon(accountId);
}

async function _mvPickAndMoveMessages(ids, opts = {}) {
  const title = ids.length === 1 ? 'Move message to…' : `Move ${ids.length} messages to…`;
  const target = await _mvPickFolder(_mvAccountId, title, { exclude: [_mvFolder], withRecents: true });
  if (target) _mvMoveMessages(ids, target, _mvAccountId, _mvFolder, opts);
}

let _mvBoardsCache = null;
/** Active (non-archived) board names for "Create card"; cached per page load. */
async function _mvBoards() {
  if (_mvBoardsCache) return _mvBoardsCache;
  try {
    const boards = await _mvJson('/api/boards');
    _mvBoardsCache = (Array.isArray(boards) ? boards : []).filter(b => !b.archived).map(b => b.name);
  } catch { return []; }
  return _mvBoardsCache;
}

/** Card from a mail via the dashboard's add-to-inbox modal; marks the mail read in this view afterwards. */
function _mvCreateCard(id, board = null) {
  const accountId = _mvAccountId, folder = _mvFolder;
  _createCardFromMail(accountId, id, board, {
    folder,
    markRead: () => { if (accountId === _mvAccountId && folder === _mvFolder) _mvSetUnread([id], false); },
    onLinked: ref => {
      if (accountId !== _mvAccountId || folder !== _mvFolder) return;
      for (const m of [_mvMsgs.find(x => x.id === id), _mvMsg?.id === id ? _mvMsg : null]) {
        if (m && !(m.cardRefs || []).some(r => r.cardId === ref.cardId)) m.cardRefs = [...(m.cardRefs || []), ref];
      }
      _mvRenderList();
      if (_mvMsg?.id === id) _mvRenderReader();
    },
  });
}

/** Bare lower-case address of a header link (mailto:…), '' if none. */
function _mvMailtoAddr(href) {
  const m = String(href || '').match(/^mailto:([^?]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).trim().toLowerCase(); } catch { return m[1].trim().toLowerCase(); }
}

/** Right-click on an address in the reader header: trust / untrust it (remote images). */
async function _mvAddressMenu(e, addr) {
  await _mailLoadTrusted();
  const trusted = !!_mailTrusted?.has(addr);
  const set = async on => {
    try {
      await _mailSetTrusted(addr, on);
      _mvFlash(on ? `${addr} is now a trusted sender` : `${addr} removed from trusted senders`);
      _mvRenderReader();   // the open mail reloads / blocks its images and updates the badge
    } catch (err) {
      _mvFlash(`Could not update trusted senders: ${err.message}`, true);
    }
  };
  openContextMenu(e, [trusted
    ? { labelHtml: `<span class="ctx-icon">${SVGICONS.shield()}</span>Remove from trusted senders`, action: () => set(false) }
    : { labelHtml: `<span class="ctx-icon">${SVGICONS.shieldCheck()}</span>Trust sender and load images`, action: () => set(true) }]);
}

/** Context menu: acts on the whole selection when the row is part of a multi-selection. */
async function _mvMessageMenu(e, id) {
  const m = _mvMsgs.find(x => x.id === id);
  if (!m) return;
  const multi = _mvChecked.size > 1 && _mvChecked.has(id);
  const ids   = multi ? _mvSelectedIds() : [id];
  const msgs  = ids.map(x => _mvMsgs.find(y => y.id === x)).filter(Boolean);
  const count = multi ? ` (${ids.length})` : '';
  const items = [];
  if (!multi && _mvAccounts.some(a => a.canSend)) {
    // Forwarding needs the full message (body + attachment list) → open it first
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.forward()}</span>Forward`, action: async () => {
      if (_mvMsg?.id !== id) await _mvOpenMessage(id);
      if (_mvMsg?.id === id) _mvOpenCompose('forward');
    } });
  }
  if (!multi) {
    const boards = await _mvBoards();
    items.push({
      labelHtml: `<span class="ctx-icon">${SVGICONS.card()}</span>Create card`,
      action:    () => _mvCreateCard(id),
      ...(boards.length ? { children: boards.map(b => ({ label: b, action: () => _mvCreateCard(id, b) })) } : {}),
    });
    const refs = m.cardRefs || [];
    if (refs.length === 1) {
      items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open card`, action: () => _openLinkedCard(refs[0].board, refs[0].cardId) });
    } else if (refs.length > 1) {
      items.push({
        labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open card`,
        children:  refs.map(r => ({ label: `${r.board} \u00b7 ${r.cardId}`, action: () => _openLinkedCard(r.board, r.cardId) })),
      });
    }
  }
  if (msgs.some(x => x.unread)) {
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.markRead()}</span>Mark as read${count}`, action: () => _mvSetUnread(ids, false) });
  }
  if (msgs.some(x => !x.unread)) {
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.markUnread()}</span>Mark as unread${count}`, action: () => _mvSetUnread(ids, true) });
  }
  items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.moveTo()}</span>Move to…${count}`, action: () => _mvPickAndMoveMessages(ids) });
  const recents = _getRecentFolders(_mvAccountId).filter(p => p !== _mvFolder && _mvFolderInfo(_mvAccountId, p));
  if (recents.length) {
    items.push({
      labelHtml: `<span class="ctx-icon">${SVGICONS.folder()}</span>Recent folders`,
      children:  recents.map(p => ({ label: _mvFolderLabel(_mvFolderInfo(_mvAccountId, p)), action: () => _mvMoveMessages(ids, p) })),
    });
  }
  items.push({ separator: true });
  items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.delete()}</span>Delete${count}`, danger: true, action: () => _mvDeleteMessages(ids) });
  openContextMenu(e, items);
}

// Attachments: same file types as card attachments (cards.js _attachType) —
// image / pdf → fullscreen viewer, html → new tab, everything else → download.

/** Icon per attachment type (as in renderCardAttachments). */
function _mvAttIcon(ft) {
  return (ft === 'image' || ft === 'svg') ? _svgFileImage(12, 12) : ft === 'pdf' ? _svgFilePdf(12, 12) : ft === 'html' ? _svgFileWeb(12, 12) : _svgAttachment(12, 12);
}

/** What a click on the attachment name does: 'view' | 'tab' | 'download'. */
function _mvAttAction(ft) {
  return ft === 'image' || ft === 'pdf' ? 'view' : ft === 'html' ? 'tab' : 'download';
}

async function _mvFetchAttachment(att) {
  const r = await fetch(_mvAttachmentUrl(att));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

function _mvSaveBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}

async function _mvDownloadAttachment(att) {
  try {
    _mvSaveBlob(await (await _mvFetchAttachment(att)).blob(), att.name);
  } catch (err) {
    _mvFlash(`Download failed: ${err.message}`, true);
  }
}

/** HTML attachments come from external senders: sanitised before opening (the blob tab shares the app origin). */
async function _mvOpenHtmlAttachment(att) {
  try {
    const html = DOMPurify.sanitize(await (await _mvFetchAttachment(att)).text(), { WHOLE_DOCUMENT: true });
    const u = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(u, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(u), 60_000);
  } catch (err) {
    _mvFlash(`Could not open attachment: ${err.message}`, true);
  }
}

function _mvOpenAttachment(att) {
  const ft = _attachType(att.name);
  const action = _mvAttAction(ft);
  if (action === 'view')     openAttachmentViewer(_mvAttachmentUrl(att), att.name, ft);
  else if (action === 'tab') _mvOpenHtmlAttachment(att);
  else                       _mvDownloadAttachment(att);
}

/** Switch the open message between its HTML and plain-text version. */
function _mvToggleFormat() {
  const body = document.querySelector('#mailViewReader .mv-reader-body');
  if (!_mvMsg || !body) return;
  _mvPlain = !_mvPlain;
  body.replaceChildren();
  _renderMailBody(body, _mvMsg, { plain: _mvPlain, toggle: false, attachments: _MV_BODY_ATTACHMENTS });
  _mvRenderReaderActions();
}

const _MV_SOURCE_MAX = 2 * 1024 * 1024;   // characters shown; the download always has everything

/** Raw source of the open message in the attachment viewer (plain text, downloadable as .eml). */
async function _mvOpenSource() {
  const msg = _mvMsg;
  const viewer  = document.getElementById('attachViewer');
  const content = document.getElementById('attachViewerContent');
  if (!msg || !viewer || !content) return;
  _wireFallbackViewer();
  const name = `${(msg.subject || 'message').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100)}.eml`;
  document.getElementById('attachViewerName').textContent = `Source: ${msg.subject || '(no subject)'}`;
  content.innerHTML = '<span class="note-attach-empty">Loading\u2026</span>';
  viewer.style.display = 'flex';
  let blob;
  try {
    const r = await fetch(_mvApi(_mvAccountId, `/message/${encodeURIComponent(msg.id)}/source?${_mvFolderQs()}`));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    blob = await r.blob();
  } catch (err) {
    content.innerHTML = `<span class="note-attach-empty">Failed to load the source (${escHtml(err.message)})</span>`;
    return;
  }
  const text = await blob.text();
  const pre = document.createElement('pre');
  pre.className = 'mv-source';
  pre.textContent = text.length > _MV_SOURCE_MAX
    ? `${text.slice(0, _MV_SOURCE_MAX)}\n\n[\u2026 truncated — download to see all ${_mvFmtSize(blob.size)}]`
    : text;
  content.innerHTML = '';
  content.appendChild(pre);
  document.getElementById('attachViewerDl').onclick = () =>
    _mvSaveBlob(new Blob([blob], { type: 'message/rfc822' }), name);
}

// Image attachments below the body (trusted senders): fetched / opened like the attachment chips
const _MV_BODY_ATTACHMENTS = { url: att => _mvAttachmentUrl(att), open: att => _mvOpenAttachment(att) };

function _mvAttachmentUrl(att) {
  return _mvApi(_mvAccountId, `/message/${encodeURIComponent(_mvMsg.id)}/attachment/${encodeURIComponent(att.part)}?${_mvFolderQs()}`);
}

// ---- Folder actions ----

function _mvDelimiter(accountId, parentPath) {
  const list = _mvFolders.get(accountId)?.list || [];
  return list.find(f => f.path === parentPath)?.delimiter || list[0]?.delimiter || '/';
}

async function _mvFolderOp(accountId, url, opts, okMsg) {
  try {
    await _mvJson(url, opts);
    _mvFlash(okMsg);
    return true;
  } catch (err) {
    _mvFlash(err.message, true);
    return false;
  } finally {
    _mvLoadFolders(accountId);
  }
}

async function _mvCreateFolder(accountId, parentPath) {
  const name = await _mvInlineInput(accountId, parentPath, 'new', '');
  if (!name) return;
  const delim = _mvDelimiter(accountId, parentPath);
  if (name.includes(delim)) { _mvFlash(`Folder names cannot contain "${delim}"`, true); return; }
  const path = parentPath ? `${parentPath}${delim}${name}` : name;
  if (parentPath) { _mvCollapsed.delete(`${accountId}\n${parentPath}`); }
  await _mvFolderOp(accountId, _mvApi(accountId, '/folders'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  }, `Created ${name}`);
}

/** Rename (same parent) or move (different parent) a folder; follows the open folder. */
async function _mvRenameFolderTo(accountId, from, to) {
  if (!to || to === from) return;
  const ok = await _mvFolderOp(accountId, _mvApi(accountId, '/folders/rename'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }),
  }, 'Folder updated');
  if (ok && accountId === _mvAccountId && (_mvFolder === from || _mvFolder.startsWith(from + _mvDelimiter(accountId, from)))) {
    _mvSelectFolder(accountId, to + _mvFolder.slice(from.length));
  }
}

async function _mvRenameFolder(accountId, path) {
  const f = _mvFolderInfo(accountId, path);
  const delim = f?.delimiter || '/';
  const name = await _mvInlineInput(accountId, path, 'rename', _mvLeafName(path, delim));
  if (!name) return;
  if (name.includes(delim)) { _mvFlash(`Folder names cannot contain "${delim}"`, true); return; }
  const parent = f ? _mvParentPath(f) : '';
  await _mvRenameFolderTo(accountId, path, parent ? `${parent}${delim}${name}` : name);
}

async function _mvMoveFolder(accountId, path, targetParent) {
  const f = _mvFolderInfo(accountId, path);
  const delim = f?.delimiter || '/';
  if (targetParent === null || targetParent === undefined) {
    const descendants = (_mvFolders.get(accountId)?.list || []).filter(x => x.path === path || x.path.startsWith(path + delim)).map(x => x.path);
    targetParent = await _mvPickFolder(accountId, 'Move folder into…', { exclude: descendants, allowRoot: true, allowNoselect: true });
    if (targetParent === null) return;
  }
  if (targetParent === path || targetParent.startsWith(path + delim)) return;
  const leaf = _mvLeafName(path, delim);
  await _mvRenameFolderTo(accountId, path, targetParent ? `${targetParent}${delim}${leaf}` : leaf);
}

async function _mvMarkFolderRead(accountId, path) {
  const f = _mvFolderInfo(accountId, path);
  // Optimistic: counts and the open list update immediately
  if (f) f.unseen = 0;
  if (accountId === _mvAccountId && path === _mvFolder) {
    _mvMsgs.forEach(m => { m.unread = false; });
    _mvRenderList();
    if (_mvMsg) _mvRenderReaderActions();
  }
  _mvRenderTree();
  _mvDashStale = true;
  try {
    await _mvJson(_mvApi(accountId, '/folders/mark-read'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    });
    _mvFlash(`All messages in "${f ? _mvFolderLabel(f) : path}" marked as read`);
  } catch (err) {
    _mvFlash(`Could not mark as read: ${err.message}`, true);
    if (accountId === _mvAccountId && path === _mvFolder) _mvLoadList(0);
  }
  _mvLoadFolders(accountId);
}

async function _mvEmptyFolder(accountId, path) {
  const f = _mvFolderInfo(accountId, path);
  const n = f?.messages;
  const what = typeof n === 'number' ? `all ${n} message${n === 1 ? '' : 's'}` : 'all messages';
  if (!(await showConfirm(`Permanently delete ${what} in "${f ? _mvFolderLabel(f) : path}"? This cannot be undone.`, { okLabel: 'Empty folder', danger: true }))) return;
  let res;
  try {
    res = await _mvJson(_mvApi(accountId, '/folders/empty'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    });
  } catch (err) {
    _mvFlash(`Could not empty folder: ${err.message}`, true);
    return;
  }
  _mvFlash(`Deleted ${res.deleted} message${res.deleted === 1 ? '' : 's'}`);
  _mvDashStale = true;
  if (accountId === _mvAccountId && path === _mvFolder) {
    _mvSelId = null;
    _mvMsg   = null;
    _mvRenderReader();
    _mvLoadList(0);
    _mvLoadFolderSize();
  }
  _mvLoadFolders(accountId);
}

async function _mvDeleteFolder(accountId, path) {
  const f = _mvFolderInfo(accountId, path);
  const delim = f?.delimiter || '/';
  const subs = (_mvFolders.get(accountId)?.list || []).filter(x => x.path.startsWith(path + delim)).length;
  const parts = [];
  if (f?.messages) parts.push(`${f.messages} message${f.messages === 1 ? '' : 's'}`);
  if (subs) parts.push(`${subs} subfolder${subs === 1 ? '' : 's'}`);
  const what = parts.length ? ` including ${parts.join(' and ')}` : '';
  if (!(await showConfirm(`Delete folder "${f ? _mvFolderLabel(f) : path}"${what}? This cannot be undone.`, { okLabel: 'Delete folder', danger: true }))) return;
  const ok = await _mvFolderOp(accountId, _mvApi(accountId, `/folders?path=${encodeURIComponent(path)}`), { method: 'DELETE' }, 'Folder deleted');
  if (ok && accountId === _mvAccountId && _mvFolder === path) _mvSelectFolder(accountId, 'INBOX');
}

function _mvFolderMenu(e, accountId, path) {
  const isInbox = path.toUpperCase() === 'INBOX';
  const items = [
    { labelHtml: `<span class="ctx-icon">${SVGICONS.create()}</span>New subfolder`, action: () => _mvCreateFolder(accountId, path) },
  ];
  const f = _mvFolderInfo(accountId, path);
  if (f && !f.noselect && f.unseen > 0) {
    items.unshift({ labelHtml: `<span class="ctx-icon">${SVGICONS.email()}</span>Mark all as read`, action: () => _mvMarkFolderRead(accountId, path) });
  }
  if (f && !f.noselect && _mvIsEmptyable(f, _mvAccounts.find(a => a.accountId === accountId)?.trashFolder)) {
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.delete()}</span>Empty folder`, danger: true, action: () => _mvEmptyFolder(accountId, path) });
  }
  if (!isInbox) {
    items.push(
      { labelHtml: `<span class="ctx-icon">${SVGICONS.edit()}</span>Rename`,    action: () => _mvRenameFolder(accountId, path) },
      { labelHtml: `<span class="ctx-icon">${SVGICONS.moveTo()}</span>Move to…`, action: () => _mvMoveFolder(accountId, path, null) },
      { separator: true },
      { labelHtml: `<span class="ctx-icon">${SVGICONS.delete()}</span>Delete folder`, danger: true, action: () => _mvDeleteFolder(accountId, path) },
    );
  }
  openContextMenu(e, items);
}

function _mvAccountMenu(e, accountId) {
  const acc = _mvAccounts.find(a => a.accountId === accountId);
  const items = [
    { labelHtml: `<span class="ctx-icon">${SVGICONS.create()}</span>New folder`, action: () => _mvCreateFolder(accountId, '') },
    { labelHtml: `<span class="ctx-icon">${SVGICONS.sync()}</span>Reload folders`, action: () => _mvLoadFolders(accountId) },
  ];
  if (acc?.webInterfaceUrl) {
    items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.openLink()}</span>Open webmail`, action: () => window.open(acc.webInterfaceUrl, '_blank', 'noopener,noreferrer') });
  }
  items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.settings()}</span>Mail settings`, action: () => openSettingsDialog('mail-accounts') });
  openContextMenu(e, items);
}

// ---- Inline name input (new / rename folder) ----

let _mvInline = null;   // { accountId, path, mode, value, resolve }

function _mvInlineInput(accountId, path, mode, value) {
  _mvInline?.resolve(null);
  return new Promise(resolve => {
    _mvInline = { accountId, path, mode, value, resolve: v => { _mvInline = null; resolve(v); _mvRenderTree(); } };
    if (mode === 'new' && path) _mvCollapsed.delete(`${accountId}\n${path}`);
    if (mode === 'new' && !path) _mvCollapsed.delete(`${accountId}\n`);
    _mvRenderTree();
    const input = document.querySelector('#mailViewFolders .mv-inline-input');
    if (!input) return;
    input.focus();
    input.select();
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter')  { e.preventDefault(); _mvInline?.resolve(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); _mvInline?.resolve(null); }
    });
    input.addEventListener('blur', () => _mvInline?.resolve(input.value.trim() || null));
  });
}

// ---- Folder picker ----

let _mvPicker = null;   // { resolve }

/** Resolves with a folder path, '' for "top level" (allowRoot) or null when cancelled. */
function _mvPickFolder(accountId, title, { exclude = [], allowRoot = false, allowNoselect = false, withRecents = false } = {}) {
  _mvClosePicker(null);
  const box = document.getElementById('mailViewPicker');
  const list = (_mvFolders.get(accountId)?.list || []).filter(f => !exclude.includes(f.path) && (allowNoselect || !f.noselect));
  const recents = withRecents ? _getRecentFolders(accountId).filter(p => list.some(f => f.path === p)) : [];
  const row = (path, label, depth, extra = '') =>
    `<button class="mv-picker-item${extra}" data-mv-pick="${escHtml(path)}" style="--mv-depth:${depth}">${SVGICONS.folder(12, 12)}<span>${escHtml(label)}</span></button>`;
  const flat = [];
  (function walk(nodes, depth) {
    for (const n of nodes) {
      if (list.includes(n.folder)) flat.push({ f: n.folder, depth });
      walk(n.children, depth + 1);
    }
  })(_mvBuildTree(_mvFolders.get(accountId)?.list || []), 0);

  box.querySelector('.mv-picker-title').textContent = title;
  box.querySelector('.mv-picker-filter').value = '';
  box.querySelector('.mv-picker-list').innerHTML =
    (allowRoot ? row('', '(top level)', 0, ' mv-picker-root') : '')
    + (recents.length ? recents.map(p => row(p, _mvFolderLabel(list.find(f => f.path === p)), 0, ' mv-picker-recent')).join('') + '<div class="ctx-separator"></div>' : '')
    + flat.map(({ f, depth }) => row(f.path, _mvFolderLabel(f), depth)).join('');
  box.hidden = false;
  box.querySelector('.mv-picker-filter').focus();
  return new Promise(resolve => { _mvPicker = { resolve }; });
}

function _mvClosePicker(value) {
  const box = document.getElementById('mailViewPicker');
  if (box) box.hidden = true;
  const p = _mvPicker;
  _mvPicker = null;
  p?.resolve(value);
}

// ---- Render ----

function _mvRenderToolbar() {
  const acc = _mvAccounts.find(a => a.accountId === _mvAccountId);
  const f   = _mvFolderInfo();
  const title = document.getElementById('mailViewTitle');
  title.innerHTML = acc
    ? `<span class="mv-title-folder">${escHtml(f ? _mvFolderLabel(f) : _mvLeafName(_mvFolder, '/'))}</span><span class="mv-title-acc" style="${acc.color ? `--card-color:${escHtml(acc.color)}` : ''}">${escHtml(acc.label)}</span>`
    : 'Mail';
  // Phones: the folders button carries the account colour (the swatch is hidden there)
  const foldersBtn = document.getElementById('mailViewFoldersBtn');
  if (acc?.color) foldersBtn.style.setProperty('--mv-acc-color', acc.color);
  else foldersBtn.style.removeProperty('--mv-acc-color');
  document.getElementById('mailViewCompose').disabled = !_mvAccounts.some(a => a.canSend);
  document.getElementById('mailViewCompose').title = _mvAccounts.some(a => a.canSend)
    ? 'New message (c)' : 'Configure an SMTP server in the mail settings to write messages';
}

function _mvTreeNodeHtml(accountId, node, depth) {
  const f = node.folder;
  const key = `${accountId}\n${f.path}`;
  const hasKids = node.children.length > 0 || (_mvInline?.mode === 'new' && _mvInline.accountId === accountId && _mvInline.path === f.path);
  const collapsed = hasKids && _mvCollapsed.has(key);
  const active = accountId === _mvAccountId && f.path === _mvFolder;
  const unseen = collapsed ? _mvSubtreeUnseen(node) : (f.unseen || 0);
  const special = (f.specialUse || (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : '')).replace('\\', '').toLowerCase();
  const editing = _mvInline?.mode === 'rename' && _mvInline.accountId === accountId && _mvInline.path === f.path;
  const label = editing
    ? `<input class="mv-inline-input" value="${escHtml(_mvInline.value)}" maxlength="120" spellcheck="false">`
    : `<span class="mv-folder-name">${escHtml(_mvFolderLabel(f))}</span>`;
  let html = `<div class="mv-folder${active ? ' active' : ''}${f.noselect ? ' mv-noselect' : ''}${special ? ` mv-special-${escHtml(special)}` : ''}"
      data-mv-acc="${escHtml(accountId)}" data-mv-folder="${escHtml(f.path)}" style="--mv-depth:${depth}"
      ${f.path.toUpperCase() !== 'INBOX' && !editing ? 'draggable="true"' : ''} title="${escHtml(f.path)}">
      <button class="mv-twisty${hasKids ? '' : ' mv-twisty-none'}" data-mv-toggle="${escHtml(key)}" tabindex="-1" aria-label="${collapsed ? 'Expand' : 'Collapse'}">${hasKids ? (collapsed ? '▸' : '▾') : ''}</button>
      <span class="mv-folder-icon">${SVGICONS.folder(12, 12)}</span>${label}
      ${unseen ? `<span class="mv-badge${collapsed && !f.unseen ? ' mv-badge-rollup' : ''}">${unseen}</span>` : ''}
    </div>`;
  if (!collapsed) {
    html += node.children.map(c => _mvTreeNodeHtml(accountId, c, depth + 1)).join('');
    if (_mvInline?.mode === 'new' && _mvInline.accountId === accountId && _mvInline.path === f.path) {
      html += _mvNewInputHtml(depth + 1);
    }
  }
  return html;
}

function _mvNewInputHtml(depth) {
  return `<div class="mv-folder mv-folder-new" style="--mv-depth:${depth}"><span class="mv-twisty mv-twisty-none"></span>
    <span class="mv-folder-icon">${SVGICONS.folder(12, 12)}</span><input class="mv-inline-input" placeholder="Folder name" maxlength="120" spellcheck="false"></div>`;
}

function _mvRenderTree() {
  const el = document.getElementById('mailViewFolders');
  if (!el) return;
  if (!_mvAccounts.length) {
    el.innerHTML = `<p class="dashboard-empty">No mail accounts configured.</p>
      <button class="btn mv-settings-link" data-mv-settings="1">${SVGICONS.settings(12, 12)} Mail settings</button>`;
    return;
  }
  // Keep a focused inline input alive while counts refresh in the background
  if (_mvInline && el.querySelector('.mv-inline-input:focus')) return;
  el.innerHTML = _mvAccounts.map(acc => {
    const state = _mvFolders.get(acc.accountId);
    const rootKey = `${acc.accountId}\n`;
    const collapsed = _mvCollapsed.has(rootKey);
    const tree = _mvBuildTree(state?.list || []);
    const inboxUnseen = (state?.list || []).find(f => f.path.toUpperCase() === 'INBOX')?.unseen || 0;
    let body = '';
    if (!collapsed) {
      if (!state) body = '<p class="mv-tree-note">Loading…</p>';
      else if (state.error && !state.list.length) body = `<p class="mv-tree-note mv-tree-error">${escHtml(state.error)}</p>`;
      else body = tree.map(n => _mvTreeNodeHtml(acc.accountId, n, 1)).join('');
      if (_mvInline?.mode === 'new' && _mvInline.accountId === acc.accountId && !_mvInline.path) body += _mvNewInputHtml(1);
    }
    return `<div class="mv-account" style="${acc.color ? `--card-color:${escHtml(acc.color)}` : ''}">
      <div class="mv-account-head" data-mv-account="${escHtml(acc.accountId)}">
        <button class="mv-twisty" data-mv-toggle="${escHtml(rootKey)}" tabindex="-1">${collapsed ? '▸' : '▾'}</button>
        <span class="mv-account-swatch"></span><span class="mv-account-label">${escHtml(acc.label)}</span>
        ${collapsed && inboxUnseen ? `<span class="mv-badge">${inboxUnseen}</span>` : ''}
        <button class="mv-account-more" data-mv-account-menu="${escHtml(acc.accountId)}" title="Account actions">${SVGICONS.moreOptions(12, 12)}</button>
      </div>${body}</div>`;
  }).join('');
}

function _mvListItemHtml(m) {
  const special = _mvFolderInfo()?.specialUse;
  const who = special === '\\Sent' || special === '\\Drafts' ? `To: ${_mvDisplayName(m.to)}` : _mvDisplayName(m.from);
  // Same markup classes as the dashboard mail panel items (card-text / card-meta)
  const meta = [];
  if (m.answered)       meta.push('<span class="dashboard-mail-attach mv-msg-answered" title="Answered">\u21a9</span>');
  if (m.forwarded)      meta.push('<span class="dashboard-mail-attach mv-msg-answered" title="Forwarded">\u21aa</span>');
  if (m.hasAttachments) meta.push(`<span class="dashboard-mail-attach" title="Has attachments">${SVGICONS.attachment(11, 11)}</span>`);
  if (m.cardRefs?.length) meta.push(`<span class="dashboard-mail-attach" title="Linked to a card">${SVGICONS.card(13, 9)}</span>`);
  if (who)              meta.push(`<span class="dashboard-mail-from">${escHtml(who)}</span>`);
  const date = _mvFmtListDate(m.date);
  if (date)             meta.push(`<span class="card-date">${escHtml(date)}</span>`);
  const selected = _mvChecked.size > 1 && _mvChecked.has(m.id);
  // Wrapper: on phones the row slides inside it to reveal the swipe actions
  return `<div class="mv-msg-wrap"><div class="mv-msg${m.unread ? ' mv-unread' : ''}${m.id === _mvSelId ? ' active' : ''}${selected ? ' selected' : ''}" data-mv-msg="${escHtml(m.id)}" draggable="true">
      <div class="card-text">${m.unread ? `<strong>${escHtml(m.subject)}</strong>` : escHtml(m.subject)}</div>
      ${meta.length ? `<div class="card-meta">${meta.join('')}</div>` : ''}
    </div></div>`;
}

// ---- Swipe actions on phones: left → Move + Delete, right → Mark read / unread ----

const _MV_SWIPE_BTN = 64;   // px per action button
let _mvSwipe = null;        // { row, offset } of the row that is currently swiped open

/**
 * Where a released row snaps to: open to the left (-endW), open to the right
 * (+startW) or closed (0). Past half of an action area it opens.
 */
function _mvSwipeSnap(offset, startW, endW) {
  if (endW && offset <= -endW / 2) return -endW;
  if (startW && offset >= startW / 2) return startW;
  return 0;
}

/** Action layers next to a row: `end` (revealed by a left swipe) and `start` (right swipe). */
function _mvSwipeLayers(row) {
  const wrap = row.parentElement;
  let end   = wrap.querySelector('.mv-swipe-actions--end');
  let start = wrap.querySelector('.mv-swipe-actions--start');
  if (!end) {
    const m = _mvMsgs.find(x => x.id === row.dataset.mvMsg);
    const btn = (act, icon, label, cls) =>
      `<button type="button" class="mv-swipe-btn mv-swipe-btn--${cls}" data-mv-swipe="${act}" title="${label}" aria-label="${label}">${icon}</button>`;
    wrap.insertAdjacentHTML('afterbegin',
      `<div class="mv-swipe-actions mv-swipe-actions--start">${m?.unread
        ? btn('read', SVGICONS.markRead(20, 20), 'Mark as read', 'read')
        : btn('unread', SVGICONS.markUnread(20, 20), 'Mark as unread', 'read')}</div>`
      + `<div class="mv-swipe-actions mv-swipe-actions--end">${btn('move', SVGICONS.moveTo(20, 20), 'Move', 'move')}`
      + `${btn('delete', SVGICONS.delete(20, 20), 'Delete', 'delete')}</div>`);
    end   = wrap.querySelector('.mv-swipe-actions--end');
    start = wrap.querySelector('.mv-swipe-actions--start');
  }
  return { start, end, startW: _MV_SWIPE_BTN, endW: end.children.length * _MV_SWIPE_BTN };
}

/** Move a row to `offset` px; each action layer fills exactly the space the row frees. */
function _mvSwipeSet(row, offset, animate) {
  const { start, end } = _mvSwipeLayers(row);
  row.classList.toggle('mv-swipe-anim', !!animate);
  for (const el of [start, end]) el.classList.toggle('mv-swipe-anim', !!animate);
  row.style.transform = offset ? `translateX(${offset}px)` : '';
  start.style.width = `${Math.max(0, offset)}px`;
  end.style.width   = `${Math.max(0, -offset)}px`;
}

function _mvSwipeClose(animate = true) {
  if (!_mvSwipe) return;
  const { row } = _mvSwipe;
  _mvSwipe = null;
  if (!row.isConnected) return;
  _mvSwipeSet(row, 0, animate);
  // Drop the layers once closed so the row needs no opaque background
  setTimeout(() => { if (_mvSwipe?.row !== row) row.parentElement?.querySelectorAll('.mv-swipe-actions').forEach(el => el.remove()); }, animate ? 220 : 0);
}

function _mvSwipeAction(act, id) {
  _mvSwipeClose(false);
  const m = _mvMsgs.find(x => x.id === id);
  if (!m) return;
  if (act === 'read' || act === 'unread') _mvSetUnread([id], act === 'unread');
  // Swipe actions keep the list in view (no jump to the next message)
  else if (act === 'delete') _mvDeleteMessages([id], { stay: true });
  else if (act === 'move') _mvPickAndMoveMessages([id], { stay: true });
}

/** Touch swipe on the message list (phone layout only). */
function _mvWireSwipe(list) {
  let g = null;   // gesture: { row, id, x0, y0, base, mode: 'pending' | 'swipe', startW, endW, offset }
  let suppressClick = 0;
  list.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !_cvIsPhone() || e.target.closest('.mv-swipe-actions')) return;
    const row = e.target.closest('.mv-msg');
    if (!row) return;
    // Touching another row while one is open only closes the open one (unless it turns into a swipe)
    const closedOther = !!_mvSwipe && _mvSwipe.row !== row;
    if (closedOther) _mvSwipeClose();
    g = { row, x0: e.clientX, y0: e.clientY, base: _mvSwipe?.row === row ? _mvSwipe.offset : 0, mode: 'pending', offset: 0, closedOther };
  });
  list.addEventListener('pointermove', e => {
    if (!g || e.pointerType !== 'touch') return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.mode === 'pending') {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }   // vertical: let the list scroll
      if (Math.abs(dx) < 10) return;
      g.mode = 'swipe';
      Object.assign(g, _mvSwipeLayers(g.row));
    }
    // Resist beyond the action area (rubber band)
    const raw = g.base + dx;
    const max = raw > 0 ? g.startW : g.endW;
    const over = Math.abs(raw) - max;
    g.offset = over > 0 ? Math.sign(raw) * (max + over / 4) : raw;
    _mvSwipeSet(g.row, g.offset, false);
  });
  const end = e => {
    if (!g || e.pointerType !== 'touch') return;
    const done = g;
    g = null;
    if (done.mode !== 'swipe') {
      // Tap on an open row closes it instead of opening the message
      if (_mvSwipe?.row === done.row) { suppressClick = Date.now(); _mvSwipeClose(); }
      else if (done.closedOther) suppressClick = Date.now();
      return;
    }
    suppressClick = Date.now();
    const target = e.type === 'pointercancel' ? 0 : _mvSwipeSnap(done.offset, done.startW, done.endW);
    if (target) {
      _mvSwipe = { row: done.row, offset: target };
      _mvSwipeSet(done.row, target, true);
    } else {
      _mvSwipe = { row: done.row, offset: 0 };
      _mvSwipeClose();
    }
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
  // Capture: a swipe or the closing tap must not also open the message
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-mv-swipe]');
    if (btn) {
      e.stopPropagation();
      _mvSwipeAction(btn.dataset.mvSwipe, btn.closest('.mv-msg-wrap').querySelector('[data-mv-msg]').dataset.mvMsg);
      return;
    }
    if (Date.now() - suppressClick < 400) { e.stopPropagation(); e.preventDefault(); return; }
    if (_mvSwipe) { e.stopPropagation(); _mvSwipeClose(); }
  }, true);
  list.addEventListener('scroll', () => { if (_mvSwipe && !g) _mvSwipeClose(); }, { passive: true });
}

function _mvRenderList(error) {
  const el = document.getElementById('mailViewList');
  if (!el) return;
  _mvRenderCount();
  if (error) { el.innerHTML = `<p class="dashboard-source-error">${escHtml(error)}</p>`; return; }
  if (!_mvAccountId) { el.innerHTML = ''; return; }
  if (!_mvMsgs.length) {
    el.innerHTML = el.classList.contains('mailview-loading') || _mvListSeq === 0
      ? '<p class="dashboard-empty">Loading…</p>'
      : `<p class="dashboard-empty">${_mvQuery ? 'No messages match the search.' : 'No messages.'}</p>`;
    return;
  }
  _mvSwipe = null;
  el.innerHTML = _mvMsgs.map(_mvListItemHtml).join('')
    + (_mvMsgs.length < _mvTotal ? `<button class="btn mv-load-more" data-mv-more="1">Load more (${_mvTotal - _mvMsgs.length})</button>` : '');
}

function _mvRenderListSelection() {
  const multi = _mvChecked.size > 1;
  document.querySelectorAll('#mailViewList .mv-msg').forEach(el => {
    el.classList.toggle('active', el.dataset.mvMsg === _mvSelId);
    el.classList.toggle('selected', multi && _mvChecked.has(el.dataset.mvMsg));
  });
  _mvRenderCount();
}

function _mvRenderCount() {
  const count = document.getElementById('mailViewCount');
  if (!count) return;
  const total = _mvTotal ? `${_mvTotal} ${_mvQuery ? 'found' : 'messages'}` : '';
  count.textContent = _mvChecked.size > 1 ? `${total} \u00b7 ${_mvChecked.size} selected` : total;
}

function _mvRenderReaderActions() {
  const bar = document.getElementById('mailViewReaderActions');
  if (!bar || !_mvMsg) return;
  const acc = _mvAccounts.find(a => a.accountId === _mvAccountId);
  const unread = _mvMsgs.find(m => m.id === _mvMsg.id)?.unread;
  // Icon + label; below 670 px toolbar width only the icon (CSS container query; label stays as tooltip / aria-label)
  const btn = (act, icon, label, { key = '', disabled = '', cls = '' } = {}) => {
    const tip = disabled || (key ? `${label} (${key})` : label);
    return `<button class="btn${cls}" data-mv-act="${act}" title="${escHtml(tip)}" aria-label="${escHtml(label)}"${disabled ? ' disabled' : ''}>`
      + `${icon(12, 12)}<span class="mv-act-label">${label}</span></button>`;
  };
  const noSmtp = acc?.canSend ? '' : 'No SMTP server configured for this account';
  const noFwd  = _mvAccounts.some(a => a.canSend) ? '' : 'No SMTP server configured';
  bar.innerHTML = [
    btn('reply',    SVGICONS.reply,    'Reply',     { key: 'r', disabled: noSmtp }),
    btn('replyall', SVGICONS.replyAll, 'Reply all', { key: 'a', disabled: noSmtp }),
    btn('forward',  SVGICONS.forward,  'Forward',   { key: 'f', disabled: noFwd }),
    unread ? btn('unread', SVGICONS.markRead, 'Mark read', { key: 'u' }) : btn('unread', SVGICONS.markUnread, 'Mark unread', { key: 'u' }),
    btn('move',     SVGICONS.moveTo,   'Move'),
    btn('delete',   SVGICONS.delete,   'Delete',    { key: 'Del', cls: ' btn-danger-soft' }),
    `<button class="btn btn--icon mv-source-btn" data-mv-act="source" title="Show source" aria-label="Show source">${SVGICONS.cardInfo(12, 12)}</button>`,
    _mailHasBothParts(_mvMsg) ? (t => `<button class="btn mv-format-btn" data-mv-act="format" title="${t.title}" aria-label="${t.title}" aria-pressed="${_mvPlain}">${escHtml(t.label)}</button>`)(_mailFormatToggle(_mvPlain)) : '',
  ].join('');
}

function _mvRenderReader(mode, error) {
  const el = document.getElementById('mailViewReader');
  if (!el || _mvCompose) return;
  if (mode === 'loading') { el.innerHTML = '<p class="dashboard-empty">Loading…</p>'; return; }
  if (mode === 'error')   { el.innerHTML = `<p class="dashboard-source-error">${escHtml(error)}</p>`; return; }
  if (!_mvMsg) {
    el.innerHTML = `<div class="mv-reader-empty">${SVGICONS.email(32, 32)}<p>${_mvMsgs.length ? 'Select a message' : ''}</p></div>`;
    return;
  }
  const msg = _mvMsg;
  const rows = [];
  rows.push(['From', _foldAddresses(msg.from) + _mailTrustedBadgeHtml(msg)]);
  if (msg.to) rows.push(['To', _foldAddresses(msg.to)]);
  if (msg.cc) rows.push(['Cc', _foldAddresses(msg.cc)]);
  if (msg.date) rows.push(['Date', escHtml(new Date(msg.date).toLocaleString())]);
  if (msg.cardRefs?.length) rows.push([msg.cardRefs.length > 1 ? 'Cards' : 'Card', _linkedCardLinksHtml(msg.cardRefs)]);
  const atts = (msg.attachments || []).map((a, i) => {
    const ft = _attachType(a.name);
    const action = _mvAttAction(ft);
    const verb = action === 'view' ? 'View' : action === 'tab' ? 'Open in new tab:' : 'Download';
    const extra = action === 'view'
      ? `<button class="mv-att-dl" data-mv-att-view="${i}" title="View fullscreen">${_svgFullscreen(12, 12)}</button>`
      : action === 'tab' ? `<button class="mv-att-dl" data-mv-att-view="${i}" title="Open in new tab">${_svgOpenLink(12, 12)}</button>` : '';
    return `<span class="mv-att">
        <button class="mv-att-name" data-mv-att-view="${i}" title="${verb} ${escHtml(a.name)}">${_mvAttIcon(ft)}<span>${escHtml(a.name)}</span>${a.size ? `<span class="mv-att-size">${_mvFmtSize(a.size)}</span>` : ''}</button>
        ${extra}<button class="mv-att-dl" data-mv-att-dl="${i}" title="Download">${SVGICONS.download(12, 12)}</button>
      </span>`;
  }).join('');
  el.innerHTML = `
    <div class="mv-reader-head">
      <button class="btn mv-back" data-mv-back="list" title="Back">‹</button>
      <h2 class="mv-subject">${escHtml(msg.subject)}</h2>
    </div>
    <div class="mv-reader-actions" id="mailViewReaderActions"></div>
    <table class="dashboard-detail-table mv-headers">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
    ${atts ? `<div class="mv-atts">${atts}</div>` : ''}
    <div class="mv-reader-body"></div>`;
  _mvRenderReaderActions();
  _resolveLinkedCardLinks(el.querySelector('.mv-headers'));
  _renderMailBody(el.querySelector('.mv-reader-body'), msg, { plain: _mvPlain, toggle: false, attachments: _MV_BODY_ATTACHMENTS });
}

// ---- Compose ----

function _mvOpenCompose(mode) {
  const sendable = _mvAccounts.filter(a => a.canSend);
  if (!sendable.length) { _mvFlash('Configure an SMTP server in the mail settings first', true); return; }
  const reply   = (mode === 'reply' || mode === 'replyall') && _mvMsg ? _mvMsg : null;
  const forward = mode === 'forward' && _mvMsg ? _mvMsg : null;
  const fields  = reply ? _mvReplyFields(reply, mode === 'replyall', _mvAccounts.find(a => a.accountId === _mvAccountId)?.own)
    : forward ? { to: '', cc: '', subject: _mvForwardSubject(forward.subject) } : null;
  const fromAcc  = sendable.find(a => a.accountId === _mvAccountId) || sendable[0];
  const fromAddr = reply && fromAcc.accountId === _mvAccountId ? _mvReplySender(reply, fromAcc.senders) : fromAcc.senders[0];
  // One option per (account, sender address): the address with the account's colour swatch
  const fromOpts = sendable.flatMap(a => (a.senders.length ? a.senders : ['']).map(addr => ({ acc: a, addr })));
  const fromSel  = fromOpts.find(o => o.acc === fromAcc && o.addr === (fromAddr || '')) || fromOpts[0];
  _mvCompose = {
    files:  [],
    dirty:  false,
    reply:  reply ? { uid: reply.id, folder: _mvFolder, accountId: _mvAccountId } : null,
    // Original attachments are attached server-side; removing a chip drops it from `atts`
    forward: forward ? { uid: forward.id, folder: _mvFolder, accountId: _mvAccountId, atts: [...(forward.attachments || [])] } : null,
    inReplyTo:  fields?.inReplyTo || '',
    references: fields?.references || [],
  };
  _mvSetPane('reader');
  const el = document.getElementById('mailViewReader');
  el.innerHTML = `
    <form class="mv-compose" autocomplete="off">
      <div class="mv-reader-head">
        <button type="button" class="btn mv-back" data-mv-back="list" title="Back">‹</button>
        <h2 class="mv-subject">${reply ? 'Reply' : forward ? 'Forward' : 'New message'}</h2>
      </div>
      <div class="mv-compose-fields">
        <label>From</label>
        ${_mvFromPickerHtml(fromOpts, fromSel)}
        <label>To</label>
        <input class="modal-input" name="to" type="text" spellcheck="false" value="${escHtml(fields?.to || '')}">
        <label>Cc</label>
        <div class="mv-cc-row"><input class="modal-input" name="cc" type="text" spellcheck="false" value="${escHtml(fields?.cc || '')}">
          <button type="button" class="btn mv-bcc-toggle" data-mv-bcc="1">Bcc</button></div>
        <label class="mv-bcc" hidden>Bcc</label>
        <input class="modal-input mv-bcc" name="bcc" type="text" spellcheck="false" hidden>
        <label>Subject</label>
        <input class="modal-input" name="subject" type="text" maxlength="998" value="${escHtml(fields?.subject || '')}">
      </div>
      <div class="mv-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" data-mv-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button type="button" data-mv-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button type="button" data-mv-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <span class="mv-toolbar-sep"></span>
        <button type="button" data-mv-cmd="insertUnorderedList" title="Bulleted list">• List</button>
        <button type="button" data-mv-cmd="insertOrderedList" title="Numbered list">1. List</button>
        <button type="button" data-mv-cmd="formatBlock:blockquote" title="Quote">❝</button>
        <button type="button" data-mv-cmd="link" title="Link">${SVGICONS.link(12, 12)}</button>
        <button type="button" data-mv-cmd="removeFormat" title="Clear formatting">T̸</button>
        <span class="mv-toolbar-sep"></span>
        <span class="mv-emoji-wrap">
          <button type="button" class="mv-emoji-toggle" data-mv-emoji-toggle="1" title="Insert emoji" aria-label="Insert emoji" aria-haspopup="true" aria-expanded="false">😊</button>
          <div class="mv-emoji-pop" role="dialog" aria-label="Emoji" hidden></div>
        </span>
      </div>
      <div class="mv-editor" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true">${reply ? _mvQuoteHtml(reply) : forward ? _mvForwardHtml(forward) : '<p><br></p>'}</div>
      <div class="mv-compose-files"></div>
      <div class="mv-compose-foot">
        <button type="submit" class="btn btn-accent mv-send">Send</button>
        <button type="button" class="btn" data-mv-attach="1">${SVGICONS.attachment(12, 12)} Attach</button>
        <input type="file" multiple hidden class="mv-file-input">
        <span class="mv-compose-status"></span>
        <button type="button" class="btn mv-discard" data-mv-discard="1">Discard</button>
      </div>
    </form>`;
  const form = el.querySelector('.mv-compose');
  form.addEventListener('input', () => { if (_mvCompose) _mvCompose.dirty = true; });
  form.addEventListener('submit', e => { e.preventDefault(); _mvSend(form); });
  _mvWireFromPicker(form.querySelector('.mv-from'));
  const editor = form.querySelector('.mv-editor');
  // Remember the caret so the emoji picker inserts at the last position in the text
  for (const ev of ['keyup', 'mouseup', 'input', 'blur']) editor.addEventListener(ev, _mvSaveEditorRange);
  editor.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); _mvAddFiles(files); }
  });
  form.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); form.classList.add('mv-drop'); } });
  form.addEventListener('dragleave', e => { if (!form.contains(e.relatedTarget)) form.classList.remove('mv-drop'); });
  form.addEventListener('drop', e => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    form.classList.remove('mv-drop');
    _mvAddFiles([...e.dataTransfer.files]);
  });
  form.querySelector('.mv-file-input').addEventListener('change', e => { _mvAddFiles([...e.target.files]); e.target.value = ''; });
  _mvRenderComposeFiles();
  if (reply) { editor.focus(); const r = document.createRange(); r.setStart(editor, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); }
  else form.querySelector('[name="to"]').focus();
}

/** Inner HTML of a sender entry: account colour swatch + address (account label as fallback). */
function _mvFromOptHtml({ acc, addr }) {
  return `<span class="mv-account-swatch" style="${acc.color ? `--card-color:${escHtml(acc.color)}` : ''}"></span>`
    + `<span class="mv-from-addr">${escHtml(addr || acc.label)}</span>`;
}

/**
 * Sender picker of the compose form. A native <select> cannot show the account
 * colour, so this is a button + listbox; the choice lives in the hidden
 * `from` (account ID) and `fromAddr` inputs read by _mvSend.
 */
function _mvFromPickerHtml(opts, sel) {
  return `<div class="mv-from">
      <input type="hidden" name="from" value="${escHtml(sel.acc.accountId)}">
      <input type="hidden" name="fromAddr" value="${escHtml(sel.addr)}">
      <button type="button" class="modal-input mv-from-btn" aria-haspopup="listbox" aria-expanded="false"
        title="${escHtml(sel.acc.label)}" ${opts.length < 2 ? 'disabled' : ''}>${_mvFromOptHtml(sel)}<span class="mv-from-caret" aria-hidden="true">▾</span></button>
      <ul class="mv-from-list" role="listbox" hidden>${opts.map(o =>
        `<li role="option" tabindex="-1" title="${escHtml(o.acc.label)}" data-acc="${escHtml(o.acc.accountId)}" data-addr="${escHtml(o.addr)}"
          aria-selected="${o === sel}">${_mvFromOptHtml(o)}</li>`).join('')}</ul>
    </div>`;
}

function _mvWireFromPicker(root) {
  const btn  = root.querySelector('.mv-from-btn');
  const list = root.querySelector('.mv-from-list');
  const items = () => [...list.querySelectorAll('[role="option"]')];
  const open = show => {
    list.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show) (items().find(li => li.getAttribute('aria-selected') === 'true') || items()[0])?.focus();
  };
  const choose = li => {
    root.querySelector('[name="from"]').value     = li.dataset.acc;
    root.querySelector('[name="fromAddr"]').value = li.dataset.addr;
    items().forEach(x => x.setAttribute('aria-selected', String(x === li)));
    btn.innerHTML = li.innerHTML + '<span class="mv-from-caret" aria-hidden="true">▾</span>';
    btn.title = li.title;
    if (_mvCompose) _mvCompose.dirty = true;
    open(false);
    btn.focus();
  };
  btn.addEventListener('click', () => open(list.hidden));
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(true); }
  });
  list.addEventListener('click', e => { const li = e.target.closest('[role="option"]'); if (li) choose(li); });
  list.addEventListener('keydown', e => {
    const all = items(), i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      all[e.key === 'Home' ? 0 : all.length - 1].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (i >= 0) choose(all[i]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      open(false);
      if (e.key === 'Escape') btn.focus();
    }
  });
  // Close when focus leaves the picker (click elsewhere, Tab)
  root.addEventListener('focusout', e => { if (!root.contains(e.relatedTarget)) open(false); });
}

function _mvAddFiles(files) {
  if (!_mvCompose) return;
  const total = [..._mvCompose.files, ...files];
  if (total.length > 10) { _mvFlash('At most 10 attachments', true); return; }
  if (files.some(f => f.size > 25 * 1024 * 1024)) { _mvFlash('Attachments are limited to 25 MB each', true); return; }
  _mvCompose.files = total;
  _mvCompose.dirty = true;
  _mvRenderComposeFiles();
}

function _mvRenderComposeFiles() {
  const el = document.querySelector('#mailViewReader .mv-compose-files');
  if (!el || !_mvCompose) return;
  const chip = (name, size, attr) =>
    `<span class="mv-att"><span class="mv-att-name">${SVGICONS.attachment(11, 11)}<span>${escHtml(name)}</span><span class="mv-att-size">${_mvFmtSize(size)}</span></span>
      <button type="button" class="mv-att-dl" ${attr} title="Remove">${SVGICONS.close(10, 10)}</button></span>`;
  el.innerHTML = (_mvCompose.forward?.atts || []).map((a, i) => chip(a.name, a.size, `data-mv-unforward="${i}"`)).join('')
    + _mvCompose.files.map((f, i) => chip(f.name, f.size, `data-mv-unattach="${i}"`)).join('');
}

// ---- Emoji picker (compose toolbar) ----

const _MV_EMOJI = [
  ['Smileys', '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🤧 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖'],
  ['Gestures', '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 👀 🧠 🙋 🙆 🙅 🤷 🤦 🙇 💁'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💋 😻 🌹 🌷 🌸 💐'],
  ['Nature', '☀️ 🌤️ ⛅ 🌧️ ⛈️ 🌩️ ❄️ ☃️ 🌈 🌙 ⭐ 🌟 ✨ ⚡ 🔥 💧 🌊 🌍 🌲 🌳 🌴 🌵 🍀 🍁 🍂 🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳'],
  ['Food', '☕ 🍵 🍺 🍻 🥂 🍷 🍸 🍹 🥤 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🥐 🍞 🥨 🧀 🥚 🍳 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🍝 🍜 🍣 🍱 🍰 🎂 🧁 🍪 🍫 🍬 🍦'],
  ['Activities', '🎉 🎊 🎈 🎁 🎀 🏆 🥇 🥈 🥉 🏅 ⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 ⛳ 🎯 🎳 🎮 🎲 🧩 🎨 🎭 🎬 🎤 🎧 🎵 🎶 🎸 🎹 🥁 🚴 🏃 🧘 🏊 ⛷️ 🏄'],
  ['Travel', '🚗 🚕 🚌 🚎 🚑 🚒 🚚 🚲 🛴 🏍️ ✈️ 🚀 🚁 ⛵ 🚢 🚆 🚇 🚉 🗺️ 🧭 🏔️ 🏖️ 🏝️ 🏠 🏡 🏢 🏥 🏦 🏨 🏫 ⛪ 🏰 🗼 🗽 ⛺ 🌆 🌉 🎡'],
  ['Objects', '📧 📨 📩 📤 📥 📦 📫 📮 📝 📄 📃 📑 📊 📈 📉 📅 📆 🗓️ 📌 📍 📎 🖇️ ✂️ 🗂️ 📁 📂 🗃️ 🗑️ 🔒 🔓 🔑 🔨 🛠️ ⚙️ 🔧 💡 🔦 🔋 🔌 💻 🖥️ 🖨️ ⌨️ 🖱️ 📱 ☎️ 📞 📷 🎥 📺 ⏰ ⌛ ⏳ 💰 💶 💳 🧾 ✉️ 🎓 📚 📖 ✏️ 🖊️ 🖍️'],
  ['Symbols', '✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ❓ ❔ ❗ ❕ ‼️ ⁉️ ⚠️ 🚫 ⛔ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🔺 🔻 🔸 🔹 ▶️ ⏸️ ⏹️ ⏩ ⏪ 🔁 🔄 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↩️ ↪️ 💯 🆗 🆕 🆓 🔝 ℹ️ ©️ ®️ ™️ #️⃣ 🔢 💤 💬 💭 🗨️ 🔔 🔕 📣 ♻️ ⭕ 🏁 🚩'],
].map(([name, list]) => [name, list.split(' ')]);
const _MV_EMOJI_RECENT_KEY = 'mail-emoji-recent';
let _mvEmojiTab = null;   // category shown last (null = Recent if any, else the first)

function _mvEmojiRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(_MV_EMOJI_RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter(x => typeof x === 'string').slice(0, 24) : [];
  } catch { return []; }
}

function _mvEmojiRemember(ch) {
  try { localStorage.setItem(_MV_EMOJI_RECENT_KEY, JSON.stringify([ch, ..._mvEmojiRecent().filter(x => x !== ch)].slice(0, 24))); }
  catch { /* storage unavailable — recent list is a convenience only */ }
}

/** Remember the editor selection (only while it lies inside the editor). */
function _mvSaveEditorRange() {
  const editor = document.querySelector('#mailViewReader .mv-editor');
  const sel = getSelection();
  if (!_mvCompose || !editor || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (editor.contains(r.commonAncestorContainer)) _mvCompose.range = r.cloneRange();
}

function _mvRenderEmojiPop(pop) {
  const recent = _mvEmojiRecent();
  const tabs = [...(recent.length ? [['Recent', recent]] : []), ..._MV_EMOJI];
  const cur  = tabs.find(([n]) => n === _mvEmojiTab) || tabs[0];
  pop.innerHTML = `
    <div class="mv-emoji-tabs" role="tablist">${tabs.map(([n, list]) =>
      `<button type="button" role="tab" data-mv-emoji-tab="${n}" title="${n}" aria-selected="${n === cur[0]}">${n === 'Recent' ? '🕘' : list[0]}</button>`).join('')}</div>
    <div class="mv-emoji-name">${cur[0]}</div>
    <div class="mv-emoji-grid">${cur[1].map(ch => `<button type="button" data-mv-emoji="${escHtml(ch)}" title="${escHtml(ch)}">${escHtml(ch)}</button>`).join('')}</div>`;
}

function _mvToggleEmojiPop(show) {
  const pop = document.querySelector('#mailViewReader .mv-emoji-pop');
  if (!pop) return;
  show ??= pop.hidden;
  if (show) { _mvSaveEditorRange(); _mvRenderEmojiPop(pop); }
  pop.hidden = !show;
  document.querySelector('#mailViewReader [data-mv-emoji-toggle]')?.setAttribute('aria-expanded', String(show));
}

/** Insert `ch` at the last caret position in the editor (end of the text if there is none). */
function _mvInsertEmoji(ch) {
  const editor = document.querySelector('#mailViewReader .mv-editor');
  if (!editor || !_mvCompose) return;
  editor.focus();
  const sel = getSelection();
  let range = _mvCompose.range;
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
  // insertText keeps the browser's undo history; fall back to a manual insert
  if (!document.execCommand('insertText', false, ch)) {
    range.deleteContents();
    const node = document.createTextNode(ch);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  _mvSaveEditorRange();
  _mvCompose.dirty = true;
  _mvEmojiRemember(ch);
}

function _mvExecCmd(cmd) {
  const editor = document.querySelector('#mailViewReader .mv-editor');
  if (!editor) return;
  editor.focus();
  if (cmd === 'link') {
    const url = (window.prompt('Link URL (https://…)') || '').trim();
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url)) { _mvFlash('Only http(s) and mailto links are allowed', true); return; }
    if (getSelection().isCollapsed) document.execCommand('insertHTML', false, `<a href="${escHtml(url)}">${escHtml(url)}</a>`);
    else document.execCommand('createLink', false, url);
  } else if (cmd.startsWith('formatBlock:')) {
    document.execCommand('formatBlock', false, cmd.split(':')[1]);
  } else {
    document.execCommand(cmd, false, null);
  }
  if (_mvCompose) _mvCompose.dirty = true;
}

async function _mvDiscardCompose() {
  if (_mvCompose?.dirty && !(await showConfirm('Discard the message you are writing?', { okLabel: 'Discard', danger: true }))) return;
  _mvCompose = null;
  _mvRenderReader();
  _mvSetPane(_mvMsg ? 'reader' : 'list');
}

async function _mvSend(form) {
  const v = name => form.querySelector(`[name="${name}"]`).value.trim();
  const to = v('to');
  if (!to) { _mvFlash('Please enter a recipient', true); form.querySelector('[name="to"]').focus(); return; }
  if (!v('subject') && !(await showConfirm('Send this message without a subject?', { okLabel: 'Send' }))) return;
  const editor = form.querySelector('.mv-editor');
  const c = _mvCompose;
  const accountId = form.querySelector('[name="from"]').value;
  const payload = { to, subject: v('subject'), html: DOMPurify.sanitize(editor.innerHTML), text: editor.innerText };
  const fromAddr = form.querySelector('[name="fromAddr"]').value;
  if (fromAddr) payload.from = fromAddr;
  if (v('cc'))  payload.cc  = v('cc');
  if (v('bcc')) payload.bcc = v('bcc');
  if (c.inReplyTo) payload.inReplyTo = c.inReplyTo;
  if (c.references.length) payload.references = c.references.slice(-50);
  if (c.reply && c.reply.accountId === accountId) { payload.replyUid = c.reply.uid; payload.replyFolder = c.reply.folder; }
  if (c.forward) {
    payload.forwardUid    = c.forward.uid;
    payload.forwardFolder = c.forward.folder;
    if (c.forward.accountId !== accountId) payload.forwardAccount = c.forward.accountId;
    if (c.forward.atts.length) payload.forwardParts = c.forward.atts.map(a => a.part);
  }

  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  c.files.forEach(f => fd.append('files', f, f.name));

  const btn = form.querySelector('.mv-send');
  const status = form.querySelector('.mv-compose-status');
  btn.disabled = true;
  status.textContent = 'Sending…';
  let res;
  try {
    res = await _mvJson(_mvApi(accountId, '/send'), { method: 'POST', body: fd });
  } catch (err) {
    btn.disabled = false;
    status.textContent = '';
    _mvFlash(`Sending failed: ${err.message}`, true);
    return;
  }
  if (_mvCompose !== c) return;
  _mvCompose = null;
  _mvFlash(res.warning || 'Message sent', !!res.warning);
  if (c.forward && c.forward.accountId === accountId && c.forward.accountId === _mvAccountId && c.forward.folder === _mvFolder) {
    const m = _mvMsgs.find(x => x.id === c.forward.uid);
    if (m) m.forwarded = true;
    _mvRenderList();
  }
  if (c.reply) {
    const m = _mvMsgs.find(x => x.id === c.reply.uid);
    if (m && c.reply.accountId === _mvAccountId && c.reply.folder === _mvFolder) m.answered = true;
    _mvRenderList();
  }
  _mvRenderReader();
  _mvSetPane(_mvMsg ? 'reader' : 'list');
  _mvRefreshFoldersSoon(accountId);
}

// ---- Status line ----

let _mvFlashTimer = null;
function _mvFlash(text, isError = false) {
  const el = document.getElementById('mailViewFlash');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('mv-flash-error', isError);
  el.hidden = false;
  clearTimeout(_mvFlashTimer);
  _mvFlashTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

// ---- Wiring ----

document.addEventListener('DOMContentLoaded', () => {
  const view = document.getElementById('mailView');
  if (!view) return;
  const folders = document.getElementById('mailViewFolders');
  const list    = document.getElementById('mailViewList');
  const reader  = document.getElementById('mailViewReader');
  const search  = document.getElementById('mailViewSearch');

  document.getElementById('mailViewClose').addEventListener('click', closeMailView);
  document.getElementById('mailViewRefresh').addEventListener('click', () => _mvReload());
  document.getElementById('mailViewCompose').addEventListener('click', () => _mvOpenCompose('new'));
  document.getElementById('mailViewSettings').addEventListener('click', () => openSettingsDialog('mail-accounts'));
  document.getElementById('mailViewFoldersBtn').addEventListener('click', () => _mvSetPane('folders'));

  // Column resizing (drag the right edge of the folder / list column)
  const body = view.querySelector('.mailview-body');
  let resize = null;   // { which, startX, start: { folders, list }, handle }
  body.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-mv-resize]');
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    resize = { which: handle.dataset.mvResize, startX: e.clientX, start: _mvClampWidths(_mvWidths, body.clientWidth), handle };
    handle.classList.add('mv-resizing');
    view.classList.add('mv-col-resizing');
  });
  body.addEventListener('pointermove', e => {
    if (!resize) return;
    const dx = e.clientX - resize.startX;
    const next = { ...resize.start };
    if (resize.which === 'folders') {
      next.folders = resize.start.folders + dx;
      // Widening the folders squeezes the list before the reader drops below half
      next.list = Math.min(resize.start.list, Math.floor(body.clientWidth / 2) - Math.max(_MV_MIN_W.folders, next.folders));
    } else {
      next.list = resize.start.list + dx;
    }
    _mvWidths = _mvClampWidths(next, body.clientWidth);
    _mvApplyWidths();
  });
  const endResize = () => {
    if (!resize) return;
    resize.handle.classList.remove('mv-resizing');
    view.classList.remove('mv-col-resizing');
    resize = null;
    _mvSaveWidths();
  };
  body.addEventListener('pointerup', endResize);
  body.addEventListener('pointercancel', endResize);
  body.addEventListener('dblclick', e => {
    if (!e.target.closest('[data-mv-resize]')) return;
    _mvWidths = { ..._MV_DEFAULT_W };
    _mvSaveWidths();
    _mvApplyWidths();
  });
  window.addEventListener('resize', () => { if (_mvIsOpen()) _mvApplyWidths(); });

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      _mvQuery = search.value.trim();
      _mvSelId = null;
      _mvLoadList(0);
    }, 300);
  });
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      e.stopPropagation();
      search.value = '';
      _mvQuery = '';
      _mvLoadList(0);
    }
  });

  // Folder tree
  folders.addEventListener('click', e => {
    if (e.target.closest('.mv-inline-input')) return;
    if (e.target.closest('[data-mv-settings]')) { openSettingsDialog('mail-accounts'); return; }
    const toggle = e.target.closest('[data-mv-toggle]');
    if (toggle && !toggle.classList.contains('mv-twisty-none')) { e.stopPropagation(); _mvToggleCollapsed(toggle.dataset.mvToggle); return; }
    const more = e.target.closest('[data-mv-account-menu]');
    if (more) { e.stopPropagation(); _mvAccountMenu(e, more.dataset.mvAccountMenu); return; }
    const head = e.target.closest('[data-mv-account]');
    if (head) { _mvToggleCollapsed(`${head.dataset.mvAccount}\n`); return; }
    const row = e.target.closest('.mv-folder[data-mv-folder]');
    if (!row) return;
    if (row.classList.contains('mv-noselect')) { _mvToggleCollapsed(`${row.dataset.mvAcc}\n${row.dataset.mvFolder}`); return; }
    _mvSelectFolder(row.dataset.mvAcc, row.dataset.mvFolder);
  });
  folders.addEventListener('contextmenu', e => {
    const row = e.target.closest('.mv-folder[data-mv-folder]');
    const head = e.target.closest('[data-mv-account]');
    if (!row && !head) return;
    e.preventDefault();
    e.stopPropagation();
    if (row) _mvFolderMenu(e, row.dataset.mvAcc, row.dataset.mvFolder);
    else _mvAccountMenu(e, head.dataset.mvAccount);
  });

  // Drag messages / folders onto folders
  let dragData = null;
  list.addEventListener('dragstart', e => {
    const row = e.target.closest('[data-mv-msg]');
    if (!row) return;
    const id = row.dataset.mvMsg;
    // Dragging a row of a multi-selection moves the whole selection
    const ids = _mvChecked.size > 1 && _mvChecked.has(id) ? _mvSelectedIds() : [id];
    dragData = { kind: 'msg', accountId: _mvAccountId, folder: _mvFolder, ids };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.querySelector('.card-text')?.textContent || '');
  });
  folders.addEventListener('dragstart', e => {
    const row = e.target.closest('.mv-folder[draggable="true"]');
    if (!row) return;
    dragData = { kind: 'folder', accountId: row.dataset.mvAcc, path: row.dataset.mvFolder };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.mvFolder);
  });
  document.addEventListener('dragend', () => {
    dragData = null;
    folders.querySelectorAll('.mv-drop-target').forEach(el => el.classList.remove('mv-drop-target'));
  });
  const dropTarget = e => {
    if (!dragData) return null;
    const row = e.target.closest('.mv-folder[data-mv-folder], [data-mv-account]');
    if (!row) return null;
    const accountId = row.dataset.mvAcc || row.dataset.mvAccount;
    const path = row.dataset.mvFolder ?? '';
    if (accountId !== dragData.accountId) return null;
    if (dragData.kind === 'msg') return path && path !== dragData.folder && !row.classList.contains('mv-noselect') ? { row, path } : null;
    const delim = _mvDelimiter(accountId, dragData.path);
    if (path === dragData.path || path.startsWith(dragData.path + delim) || path === _mvParentPath({ path: dragData.path, delimiter: delim })) return null;
    return { row, path };
  };
  folders.addEventListener('dragover', e => {
    const t = dropTarget(e);
    folders.querySelectorAll('.mv-drop-target').forEach(el => { if (el !== t?.row) el.classList.remove('mv-drop-target'); });
    if (!t) return;
    e.preventDefault();
    t.row.classList.add('mv-drop-target');
  });
  folders.addEventListener('drop', e => {
    const t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    const d = dragData;
    dragData = null;
    t.row.classList.remove('mv-drop-target');
    if (d.kind === 'msg') _mvMoveMessages(d.ids, t.path, d.accountId, d.folder);
    else _mvMoveFolder(d.accountId, d.path, t.path);
  });

  // Message list
  list.addEventListener('click', e => {
    if (e.target.closest('[data-mv-more]')) { _mvLoadList(_mvPage + 1); return; }
    const row = e.target.closest('[data-mv-msg]');
    if (row) _mvClickMessage(e, row.dataset.mvMsg);
  });
  _mvWireSwipe(list);
  // Shift+click must not select text
  list.addEventListener('mousedown', e => { if (e.shiftKey && e.target.closest('[data-mv-msg]')) e.preventDefault(); });
  list.addEventListener('contextmenu', e => {
    const row = e.target.closest('[data-mv-msg]');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    _mvMessageMenu(e, row.dataset.mvMsg);
  });

  // Reader + compose
  reader.addEventListener('click', e => {
    const back = e.target.closest('[data-mv-back]');
    if (back) { _mvSetPane(back.dataset.mvBack); return; }
    const act = e.target.closest('[data-mv-act]');
    if (act && _mvMsg) {
      const id = _mvMsg.id;
      if (act.dataset.mvAct === 'reply')    _mvOpenCompose('reply');
      if (act.dataset.mvAct === 'replyall') _mvOpenCompose('replyall');
      if (act.dataset.mvAct === 'forward')  _mvOpenCompose('forward');
      if (act.dataset.mvAct === 'unread')   _mvSetUnread([id], !_mvMsgs.find(m => m.id === id)?.unread);
      if (act.dataset.mvAct === 'move')     _mvPickAndMoveMessages([id]);
      if (act.dataset.mvAct === 'delete')   _mvDeleteMessages([id]);
      if (act.dataset.mvAct === 'source')   _mvOpenSource();
      if (act.dataset.mvAct === 'format')   _mvToggleFormat();
      return;
    }
    const view = e.target.closest('[data-mv-att-view]');
    if (view && _mvMsg) { _mvOpenAttachment(_mvMsg.attachments[+view.dataset.mvAttView]); return; }
    const dl = e.target.closest('[data-mv-att-dl]');
    if (dl && _mvMsg) { _mvDownloadAttachment(_mvMsg.attachments[+dl.dataset.mvAttDl]); return; }
    const toggle = e.target.closest('.dash-addr-toggle');
    if (toggle) {
      e.preventDefault();
      const rest = toggle.previousElementSibling;
      rest.hidden = !rest.hidden;
      rest.previousElementSibling.hidden = !rest.hidden;
      toggle.textContent = rest.hidden ? 'more' : 'less';
      return;
    }
    // Emoji picker: closes on any click outside it
    if (!e.target.closest('.mv-emoji-pop, [data-mv-emoji-toggle]')) _mvToggleEmojiPop(false);
    if (e.target.closest('[data-mv-emoji-toggle]')) { _mvToggleEmojiPop(); return; }
    const emTab = e.target.closest('[data-mv-emoji-tab]');
    if (emTab) { _mvEmojiTab = emTab.dataset.mvEmojiTab; _mvRenderEmojiPop(emTab.closest('.mv-emoji-pop')); return; }
    const em = e.target.closest('[data-mv-emoji]');
    if (em) { _mvInsertEmoji(em.dataset.mvEmoji); _mvToggleEmojiPop(e.shiftKey); return; }   // Shift+click keeps the picker open
    const cmd = e.target.closest('[data-mv-cmd]');
    if (cmd) { _mvExecCmd(cmd.dataset.mvCmd); return; }
    if (e.target.closest('[data-mv-bcc]')) {
      reader.querySelectorAll('.mv-bcc').forEach(el => { el.hidden = false; });
      e.target.closest('[data-mv-bcc]').hidden = true;
      reader.querySelector('[name="bcc"]').focus();
      return;
    }
    if (e.target.closest('[data-mv-attach]')) { reader.querySelector('.mv-file-input').click(); return; }
    const unf = e.target.closest('[data-mv-unforward]');
    if (unf && _mvCompose?.forward) { _mvCompose.forward.atts.splice(+unf.dataset.mvUnforward, 1); _mvCompose.dirty = true; _mvRenderComposeFiles(); return; }
    const un = e.target.closest('[data-mv-unattach]');
    if (un && _mvCompose) { _mvCompose.files.splice(+un.dataset.mvUnattach, 1); _mvRenderComposeFiles(); return; }
    if (e.target.closest('[data-mv-discard]')) _mvDiscardCompose();
  });
  // Right-click on an address in the header: trust / untrust
  reader.addEventListener('contextmenu', e => {
    const a = e.target.closest('.mv-headers a[href^="mailto:"]');
    const addr = a && _mvMailtoAddr(a.getAttribute('href'));
    if (!addr) return;
    e.preventDefault();
    e.stopPropagation();
    _mvAddressMenu(e, addr);
  });
  // Toolbar buttons must not steal the editor selection
  reader.addEventListener('mousedown', e => { if (e.target.closest('[data-mv-cmd], [data-mv-emoji-toggle], .mv-emoji-pop')) e.preventDefault(); });

  // Folder picker
  const picker = document.getElementById('mailViewPicker');
  picker.addEventListener('click', e => {
    if (e.target === picker || e.target.closest('[data-mv-pick-cancel]')) { _mvClosePicker(null); return; }
    const item = e.target.closest('[data-mv-pick]');
    if (item) _mvClosePicker(item.dataset.mvPick);
  });
  picker.querySelector('.mv-picker-filter').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    picker.querySelectorAll('.mv-picker-item').forEach(el => {
      el.hidden = !!q && !el.dataset.mvPick.toLowerCase().includes(q);
    });
    picker.querySelectorAll('.ctx-separator').forEach(el => { el.hidden = !!q; });
  });
  picker.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _mvClosePicker(null); }
    if (e.key === 'Enter') {
      const first = [...picker.querySelectorAll('.mv-picker-item')].find(el => !el.hidden);
      if (first) { e.preventDefault(); _mvClosePicker(first.dataset.mvPick); }
    }
  });

  // Capture phase: runs before modal handlers, so a modal that closes itself on Escape
  // is still visible here and the view stays open
  window.addEventListener('keydown', e => {
    if (!_mvIsOpen()) return;
    // Leave keys to dialogs / menus stacked above the view
    if (document.querySelector('dialog[open]')) return;
    // Any modal above the view (card / inbox modal, confirm dialog, mail detail, attachment viewer)
    if ([...document.querySelectorAll('.modal-backdrop')].some(m => getComputedStyle(m).display !== 'none')) return;
    if (!picker.hidden) return;
    if (document.querySelector('#mailViewReader .mv-from-list:not([hidden])')) return;   // sender list handles its keys
    if (document.querySelector('#mailViewReader .mv-emoji-pop:not([hidden])')) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _mvToggleEmojiPop(false); }
      return;
    }
    if ([...document.querySelectorAll('.context-menu')].some(m => getComputedStyle(m).display !== 'none')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) {
      if (e.key === 'Escape' && _mvCompose && e.target.closest('.mv-compose')) { e.preventDefault(); _mvDiscardCompose(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (_mvCompose) _mvDiscardCompose();
      else if (_mvChecked.size > 1) { _mvChecked = new Set(_mvSelId ? [_mvSelId] : []); _mvAnchor = _mvSelId; _mvRenderListSelection(); }
      else closeMailView();
    } else if (_mvCompose) {
      return;
    } else if ((e.key === 'Delete' || e.key === '#') && _mvSelectedIds().length) { e.preventDefault(); _mvDeleteMessages(_mvSelectedIds()); }
    else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); _mvMoveSelection(1); }
    else if (e.key === 'ArrowUp'   || e.key === 'k') { e.preventDefault(); _mvMoveSelection(-1); }
    else if (e.key === 'r' && _mvMsg) _mvOpenCompose('reply');
    else if (e.key === 'a' && _mvMsg) _mvOpenCompose('replyall');
    else if (e.key === 'f' && _mvMsg) _mvOpenCompose('forward');
    else if (e.key === 'c') _mvOpenCompose('new');
    else if (e.key === 'u' && _mvSelectedIds().length) {
      const ids = _mvSelectedIds();
      _mvSetUnread(ids, !_mvMsgs.find(m => m.id === ids[0])?.unread);
    }
    else if (e.key === '/') { e.preventDefault(); _mvSetPane('list'); search.focus(); }
  }, true);

  window.addEventListener('popstate', () => {
    if (!_isOverlayHostPage()) return;
    if (!_mvParseUrl(window.location.search)) { _mvPushed = false; if (_mvIsOpen()) _mvHide(); return; }
    _mvInitFromUrl();
  });
});
