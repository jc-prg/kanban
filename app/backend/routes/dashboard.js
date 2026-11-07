'use strict';
const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { writeRateLimit, uploadRateLimit }         = require('../auth');
const { getDashboardConfig, saveDashboardConfig, getMailAccount, getCalAccount, getRecentFolders, addRecentFolder,
        getMailCardLinks, addMailCardLink } = require('../global-db');
const { getCouch, withHandler }                   = require('../db');
const { DB_PREFIX, DOC_ID, NOTES_DOC_ID }         = require('../config');
const { fetchCalendarAccount, fetchRawEvents, testCalendarAccount, clearCalendarUrlCache,
        buildIcs, fetchRawIcs, patchMasterIcs, buildOccurrenceOverrideIcs, buildDeleteOccurrenceIcs,
        addCardRefIcs, resolveEventUrl, hrefToUrl } = require('../dashboard/calendar');
const { validateCalendarEvent, validateCalendarCardLink, validateMailCardLink, validateMailSend, validMailFolderPath, schemaError } = require('../schemas');
const { fetchMailAccount, fetchMailMessage, fetchMessageId, findMailByMessageId, fetchMailSource, fetchMailAttachment, fetchMailAttachments, fetchFolderMessages, fetchFolderSize, testMailAccount,
        listMailFolders, createMailFolder, deleteMailFolder, renameMailFolder, emptyMailFolder,
        markMailMessage, markFolderRead, moveMailMessage, deleteMailMessage, sendMail } = require('../dashboard/mail');

// ---- Password utilities (also exported for unit tests) ----

function stripPasswords(config) {
  return {
    ...config,
    mailAccounts: (config.mailAccounts || []).map(({ password, ...a }) => {
      const out = { ...a, hasPassword: !!password };
      if (a.smtp) {
        const { password: smtpPassword, ...smtp } = a.smtp;
        out.smtp = { ...smtp, hasPassword: !!smtpPassword };
      }
      return out;
    }),
    calendarAccounts: (config.calendarAccounts || []).map(({ password, ...a }) => ({
      ...a,
      hasPassword: !!password,
    })),
  };
}

function mergePasswords(stored, incoming) {
  function mergeList(storedList, incomingList) {
    return (incomingList || []).map(acc => {
      const storedAcc = (storedList || []).find(s => s.id === acc.id);
      let out = acc;
      if (storedAcc && (!('password' in acc) || acc.password === '')) {
        out = { ...out, password: storedAcc.password || '' };
      }
      // Mail accounts: same rule for the nested SMTP password
      if (acc.smtp && storedAcc?.smtp?.password && (!('password' in acc.smtp) || acc.smtp.password === '')) {
        out = { ...out, smtp: { ...acc.smtp, password: storedAcc.smtp.password } };
      }
      if (out.smtp) {
        const { hasPassword, ...smtp } = out.smtp;
        out = { ...out, smtp };
      }
      return out;
    });
  }
  const merged = {
    ...incoming,
    mailAccounts:     mergeList(stored.mailAccounts,     incoming.mailAccounts),
    calendarAccounts: mergeList(stored.calendarAccounts, incoming.calendarAccounts),
  };
  // Preserve defaultTimezone if not explicitly included in the incoming body
  if (!('defaultTimezone' in incoming) && stored.defaultTimezone !== undefined) {
    merged.defaultTimezone = stored.defaultTimezone;
  }
  return merged;
}

/** Build CalDAV Authorization header from account credentials. */
function _calHeaders(account) {
  const headers = {};
  if (account.user && account.password) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${account.user}:${account.password}`).toString('base64');
  }
  return headers;
}

/** Validate an IANA timezone string using Intl (Node 18+). Returns error message or null. */
function _validateTz(tz) {
  if (!tz) return null;
  try {
    const valid = Intl.supportedValuesOf('timeZone');
    return valid.includes(tz) ? null : `Unknown timezone: ${tz}`;
  } catch {
    return null; // Node version without Intl.supportedValuesOf — skip validation
  }
}

// ---- Helpers ----

function _collectLinkedCardIds(items) {
  const ids = new Set();
  for (const item of (items || [])) {
    if (item.type === 'page') {
      for (const id of (item.linkedCards || [])) ids.add(id);
    } else if (item.type === 'folder') {
      for (const id of _collectLinkedCardIds(item.children)) ids.add(id);
    }
  }
  return ids;
}

async function _fetchNotesMap(couch, boards) {
  const map = new Map();
  await Promise.allSettled(boards.map(async board => {
    try {
      const raw = await couch.use(DB_PREFIX + board).get('notes');
      map.set(board, _collectLinkedCardIds(raw.items || []));
    } catch { map.set(board, new Set()); }
  }));
  return map;
}

function _flattenPages(items) {
  const pages = [];
  for (const item of (items || [])) {
    if (item.type === 'page') pages.push(item);
    else if (item.type === 'folder') pages.push(..._flattenPages(item.children));
  }
  return pages;
}

function _cardLastEdited(card) {
  let best = card.created || '';
  if (card.doneAt && card.doneAt > best) best = card.doneAt;
  const moves = card.moves;
  if (moves?.length) { const at = moves[moves.length - 1].at; if (at > best) best = at; }
  return best;
}

// ---- Routes ----

router.get('/dashboard/config', withHandler(async (req, res) => {
  const config = await getDashboardConfig();
  res.json(stripPasswords(config));
}));

router.get('/dashboard/recent', withHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const couch = getCouch();
  const allDbs = await couch.db.list();
  const boardNames = allDbs.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
  const items = [];
  await Promise.allSettled(boardNames.map(async board => {
    const db = couch.use(DB_PREFIX + board);
    const [boardRes, notesRes] = await Promise.allSettled([db.get(DOC_ID), db.get(NOTES_DOC_ID)]);
    if (boardRes.status === 'fulfilled') {
      const doc = boardRes.value;
      if (!doc.settings?.archived) {
        for (const col of doc.columns || []) {
          for (const card of col.cards || []) {
            if ((card.text || '').startsWith('#')) continue;
            items.push({ type: 'card', id: card.id, title: card.text || '', board, context: col.title, at: _cardLastEdited(card), color: card.color || '' });
          }
        }
      }
    }
    if (notesRes.status === 'fulfilled') {
      for (const page of _flattenPages(notesRes.value.items)) {
        if (!page.lastModified) continue;
        items.push({ type: 'note', id: page.id, title: page.title || '', board, context: 'notes', at: page.lastModified });
      }
    }
  }));
  items.sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
  res.json(items.slice(0, limit));
}));

router.put('/dashboard/config', writeRateLimit, withHandler(async (req, res) => {
  // Validate defaultTimezone if explicitly provided
  const tz = req.body.defaultTimezone;
  if (tz !== undefined && tz !== '') {
    const tzErr = _validateTz(tz);
    if (tzErr) return res.status(400).json({ error: tzErr });
  }

  const stored = await getDashboardConfig();
  const merged = mergePasswords(stored, req.body);

  // Clear defaultTimezone if explicitly set to empty string
  if (tz === '') delete merged.defaultTimezone;

  await saveDashboardConfig(merged);
  clearCalendarUrlCache();
  res.json({ ok: true });
}));

router.get('/dashboard/cards', withHandler(async (req, res) => {
  const config  = await getDashboardConfig();
  const couch   = getCouch();
  const sources = config.cardSources || [];

  const notesMap = await _fetchNotesMap(couch, [...new Set(sources.map(s => s.board))]);

  const settled = await Promise.allSettled(
    sources.map(async source => {
      const db  = couch.use(DB_PREFIX + source.board);
      const doc = await db.get(DOC_ID);
      const cols = (doc.columns || []).filter(col =>
        !source.columns?.length || source.columns.includes(col.title)
      );
      const linkedCards = notesMap.get(source.board) || new Set();
      return cols.map(col => ({
        sourceId:           source.id,
        board:              source.board,
        column:             col.title,
        initiallyCollapsed: source.collapsed || false,
        cards: (col.cards || []).map(({ id, text, priority, color, startDate, endDate, done, description, link, mailRef, calEvent }) => ({
          id, text, priority, color, startDate, endDate, done, description: !!description, link: link || '',
          hasLinkedNotes: linkedCards.has(id),
          hasMailRef:     !!mailRef,
          hasCalEvent:    !!calEvent,
        })),
        error: null,
      }));
    })
  );

  const result = sources.flatMap((source, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') return r.value;
    return [{ sourceId: source.id, board: source.board, column: null, cards: [], error: r.reason?.message || 'Unknown error' }];
  });

  res.json(result);
}));

// ---- Combined data endpoint ----

// GET /api/dashboard/data — fetch all sources in parallel, return combined result
router.get('/dashboard/data', withHandler(async (req, res) => {
  const config = await getDashboardConfig();

  const cardsPromise = (async () => {
    const couch   = getCouch();
    const sources = config.cardSources || [];
    const notesMap = await _fetchNotesMap(couch, [...new Set(sources.map(s => s.board))]);
    const settled = await Promise.allSettled(
      sources.map(async source => {
        const db  = couch.use(DB_PREFIX + source.board);
        const doc = await db.get(DOC_ID);
        const cols = (doc.columns || []).filter(col =>
          !source.columns?.length || source.columns.includes(col.title)
        );
        const linkedCards = notesMap.get(source.board) || new Set();
        return cols.map(col => ({
          sourceId:          source.id,
          board:             source.board,
          column:            col.title,
          initiallyCollapsed: source.collapsed || false,
          cards: (col.cards || []).map(({ id, text, priority, color, startDate, endDate, done, description, link, mailRef, calEvent }) => ({
            id, text, priority, color, startDate, endDate, done, description: !!description, link: link || '',
            hasLinkedNotes: linkedCards.has(id),
            hasMailRef:     !!mailRef,
            hasCalEvent:    !!calEvent,
          })),
          error: null,
        }));
      })
    );
    return sources.flatMap((source, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') return r.value;
      return [{ sourceId: source.id, board: source.board, column: null, cards: [], error: r.reason?.message || 'Unknown error' }];
    });
  })();

  const mailPromise = (async () => {
    const accounts = config.mailAccounts || [];
    const settled  = await Promise.allSettled(accounts.map(acc => fetchMailAccount(acc)));
    return accounts.map((acc, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        return { accountId: acc.id, label: acc.label, color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null, messages: r.value, error: null };
      }
      return { accountId: acc.id, label: acc.label, color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null, messages: [], error: r.reason?.message || 'Unknown error' };
    });
  })();

  const calendarPromise = (async () => {
    const accounts = config.calendarAccounts || [];
    const settled  = await Promise.allSettled(accounts.map(acc => fetchCalendarAccount(acc)));
    return accounts.map((acc, i) => {
      const r    = settled[i];
      const base = { accountId: acc.id, label: acc.label, type: acc.type || 'caldav', color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null };
      if (r.status === 'fulfilled') return { ...base, ...r.value };
      return { ...base, events: [], error: r.reason?.message || 'Unknown error' };
    });
  })();

  const [cards, mail, calendar] = await Promise.all([cardsPromise, mailPromise, calendarPromise]);
  res.json({ cards, mail, calendar, fetchedAt: new Date().toISOString() });
}));

// ---- Mail recent folders ----

// GET /api/dashboard/mail-recent-folders — returns { [accountId]: [path, ...] }
router.get('/dashboard/mail-recent-folders', withHandler(async (req, res) => {
  res.json(await getRecentFolders());
}));

// POST /api/dashboard/mail/:accountId/recent-folders — record a used folder
router.post('/dashboard/mail/:accountId/recent-folders', writeRateLimit, withHandler(async (req, res) => {
  const { folder } = req.body;
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'folder is required' });
  await addRecentFolder(req.params.accountId, folder);
  res.json({ ok: true });
}));

// ---- Mail routes ----

/** Optional ?folder= query param; undefined when absent, null when invalid. */
function _folderParam(req) {
  const f = req.query.folder;
  if (f === undefined || f === '') return undefined;
  return validMailFolderPath(f) ? f : null;
}

// One UID, or with { multi } a comma-separated UID set (≤ 500) for bulk actions
const _UID_RE       = /^\d{1,10}$/;
const _UID_SET_RE   = /^\d{1,10}(,\d{1,10}){0,499}$/;

/** Load the account and the optional folder param; sends 404/400 itself and returns null. */
async function _mailCtx(req, res, { multi = false } = {}) {
  const account = await getMailAccount(req.params.accountId);
  if (!account) { res.status(404).json({ error: 'Account not found' }); return null; }
  const folder = _folderParam(req);
  if (folder === null) { res.status(400).json({ error: 'Invalid folder' }); return null; }
  if (!(multi ? _UID_SET_RE : _UID_RE).test(req.params.uid ?? '0')) { res.status(400).json({ error: 'Invalid uid' }); return null; }
  return { account, folder };
}

/**
 * Add `cardRefs` ([{ board, cardId }]) to messages that a kanban card was created from.
 * Links are keyed by Message-ID; lookup failures never break the mail listing.
 */
async function _withCardRefs(accountId, messages) {
  let links;
  try { links = await getMailCardLinks(accountId); } catch { return messages; }
  if (!links || !Object.keys(links).length) return messages;
  for (const m of messages) {
    const refs = m?.messageId && links[m.messageId];
    if (Array.isArray(refs) && refs.length) m.cardRefs = refs;
  }
  return messages;
}

const _SEND_MAX_BYTES = 50 * 1024 * 1024;   // all attachments of one message together

const _sendUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024, files: 10, fields: 5, fieldSize: 6 * 1024 * 1024 },
}).array('files', 10);

// GET /api/dashboard/mail — aggregate all mail accounts
router.get('/dashboard/mail', withHandler(async (req, res) => {
  const config   = await getDashboardConfig();
  const accounts = config.mailAccounts || [];

  const settled = await Promise.allSettled(accounts.map(acc => fetchMailAccount(acc)));

  const result = accounts.map((acc, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      return { accountId: acc.id, label: acc.label, color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null, messages: r.value, error: null };
    }
    return { accountId: acc.id, label: acc.label, color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null, messages: [], error: r.reason?.message || 'Unknown error' };
  });
  await Promise.all(result.map(acc => _withCardRefs(acc.accountId, acc.messages)));

  res.json(result);
}));

// GET /api/dashboard/mail/:accountId — fetch one account's messages
router.get('/dashboard/mail/:accountId', withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const messages = await fetchMailAccount(account);
    res.json({ messages: await _withCardRefs(account.id, messages), error: null });
  } catch (err) {
    res.json({ messages: [], error: err.message });
  }
}));

// GET /api/dashboard/mail/:accountId/message/:uid — fetch one full message
router.get('/dashboard/mail/:accountId/message/:uid', withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res);
  if (!ctx) return;

  let msg;
  try {
    msg = await fetchMailMessage(ctx.account, req.params.uid, ctx.folder);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  await _withCardRefs(ctx.account.id, [msg]);
  res.json(msg);
}));

// GET /api/dashboard/mail/:accountId/message/:uid/source — raw RFC 822 source (shown as plain text)
router.get('/dashboard/mail/:accountId/message/:uid/source', withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res);
  if (!ctx) return;

  let source;
  try {
    source = await fetchMailSource(ctx.account, req.params.uid, ctx.folder);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (!source) return res.status(404).json({ error: 'Message not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(source);
}));

// POST /api/dashboard/mail/:accountId/message/:uid/cards?folder= — link a kanban card to the mail.
// Body: { board, cardId }. Stored server-side under the message's Message-ID (mails are immutable).
router.post('/dashboard/mail/:accountId/message/:uid/cards', writeRateLimit, withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res);
  if (!ctx) return;
  if (!validateMailCardLink(req.body)) return res.status(400).json({ error: schemaError(validateMailCardLink) });

  let messageId;
  try {
    messageId = await fetchMessageId(ctx.account, req.params.uid, ctx.folder);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (messageId === null) return res.status(404).json({ error: 'Message not found' });
  if (!messageId) return res.status(422).json({ error: 'The message has no Message-ID header' });

  const added = await addMailCardLink(ctx.account.id, messageId, req.body.board, req.body.cardId);
  res.json({ ok: true, messageId, ...(added ? {} : { unchanged: true }) });
}));

// GET /api/dashboard/mail/:accountId/locate?messageId=&folder=&scope= — find a message by Message-ID
// (folder = hint searched first; scope=hint searches only the hint folder). Returns { folder, uid }.
router.get('/dashboard/mail/:accountId/locate', withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { messageId } = req.query;
  if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 998 || /[\r\n]/.test(messageId)) {
    return res.status(400).json({ error: 'Invalid messageId' });
  }
  const folder = _folderParam(req);
  if (folder === null) return res.status(400).json({ error: 'Invalid folder' });

  let found;
  try {
    found = await findMailByMessageId(account, messageId, folder, { hintOnly: req.query.scope === 'hint' });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (!found) return res.status(404).json({ error: 'Message not found (deleted?)' });
  res.json(found);
}));

// GET /api/dashboard/mail/:accountId/message/:uid/attachment/:part — download attachment
router.get('/dashboard/mail/:accountId/message/:uid/attachment/:part', withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res);
  if (!ctx) return;

  const { part } = req.params;
  if (!/^[\d.]+$/.test(part)) return res.status(400).json({ error: 'Invalid part' });

  let att;
  try {
    att = await fetchMailAttachment(ctx.account, req.params.uid, part, ctx.folder);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (!att) return res.status(404).json({ error: 'Attachment not found' });

  res.setHeader('Content-Type', att.type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}`);
  res.send(att.data);
}));

// POST /api/dashboard/mail/:accountId/test — test IMAP connectivity
router.post('/dashboard/mail/:accountId/test', withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const result = await testMailAccount(account);
  res.json(result);
}));

// GET /api/dashboard/mail/:accountId/folders — list IMAP folders
router.get('/dashboard/mail/:accountId/folders', withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const folders = await listMailFolders(account, { status: req.query.status === '1' });
    res.json({ folders });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// POST /api/dashboard/mail/:accountId/folders — create folder; body: { path }
router.post('/dashboard/mail/:accountId/folders', writeRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { path } = req.body || {};
  if (!validMailFolderPath(path)) return res.status(400).json({ error: 'Invalid folder path' });

  try {
    await createMailFolder(account, path);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// DELETE /api/dashboard/mail/:accountId/folders?path= — delete folder
router.delete('/dashboard/mail/:accountId/folders', writeRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { path } = req.query;
  if (!validMailFolderPath(path)) return res.status(400).json({ error: 'Invalid folder path' });
  if (path.toUpperCase() === 'INBOX') return res.status(400).json({ error: 'The inbox cannot be deleted' });

  try {
    await deleteMailFolder(account, path);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// POST /api/dashboard/mail/:accountId/folders/rename — rename or move; body: { from, to }
router.post('/dashboard/mail/:accountId/folders/rename', writeRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { from, to } = req.body || {};
  if (!validMailFolderPath(from) || !validMailFolderPath(to)) return res.status(400).json({ error: 'Invalid folder path' });
  if (from.toUpperCase() === 'INBOX') return res.status(400).json({ error: 'The inbox cannot be renamed' });

  try {
    await renameMailFolder(account, from, to);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// POST /api/dashboard/mail/:accountId/folders/mark-read — mark all messages of a folder read; body: { path }
router.post('/dashboard/mail/:accountId/folders/mark-read', writeRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { path } = req.body || {};
  if (!validMailFolderPath(path)) return res.status(400).json({ error: 'Invalid folder path' });

  try {
    res.json({ ok: true, ...(await markFolderRead(account, path)) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// POST /api/dashboard/mail/:accountId/folders/empty — delete all messages of a trash / spam folder; body: { path }
router.post('/dashboard/mail/:accountId/folders/empty', writeRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { path } = req.body || {};
  if (!validMailFolderPath(path)) return res.status(400).json({ error: 'Invalid folder path' });

  try {
    const { deleted } = await emptyMailFolder(account, path);
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}));

// GET /api/dashboard/mail/:accountId/messages?folder=&page=&q= — one page of a folder
router.get('/dashboard/mail/:accountId/messages', withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res);
  if (!ctx) return;
  const page  = Math.max(0, Math.min(10_000, parseInt(req.query.page, 10) || 0));
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';

  try {
    const data = await fetchFolderMessages(ctx.account, ctx.folder || 'INBOX', { page, query });
    await _withCardRefs(ctx.account.id, data.messages);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// GET /api/dashboard/mail/:accountId/folder-size?folder= — { size (bytes), messages }
router.get('/dashboard/mail/:accountId/folder-size', withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res);
  if (!ctx) return;
  try {
    res.json(await fetchFolderSize(ctx.account, ctx.folder || 'INBOX'));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// POST /api/dashboard/mail/:accountId/send — multipart: `payload` (JSON) + `files`
router.post('/dashboard/mail/:accountId/send', uploadRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    await new Promise((resolve, reject) => _sendUpload(req, res, err => err ? reject(err) : resolve()));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let payload;
  try { payload = JSON.parse(req.body?.payload || 'null'); } catch { payload = null; }
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'payload is required' });
  if (!validateMailSend(payload)) return res.status(400).json({ error: schemaError(validateMailSend) });

  const attachments = (req.files || []).map(f => ({
    filename:    Buffer.from(f.originalname, 'latin1').toString('utf8'),
    content:     f.buffer,
    contentType: f.mimetype || 'application/octet-stream',
  }));

  // Forward: the original's attachments are fetched server-side (from the same or another account)
  if (payload.forwardParts?.length) {
    if (!payload.forwardUid || !validMailFolderPath(payload.forwardFolder)) {
      return res.status(400).json({ error: 'forwardUid and forwardFolder are required with forwardParts' });
    }
    const source = payload.forwardAccount ? await getMailAccount(payload.forwardAccount) : account;
    if (!source) return res.status(404).json({ error: 'Forward source account not found' });
    let forwarded;
    try {
      forwarded = await fetchMailAttachments(source, payload.forwardUid, payload.forwardParts, payload.forwardFolder);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
    if (!forwarded) return res.status(404).json({ error: 'Forwarded attachment not found' });
    attachments.push(...forwarded.map(a => ({ filename: a.name, content: a.data, contentType: a.type })));
  }
  const totalSize = attachments.reduce((n, a) => n + a.content.length, 0);
  if (totalSize > _SEND_MAX_BYTES) return res.status(413).json({ error: 'Attachments exceed 50 MB in total' });

  try {
    res.json(await sendMail(account, { ...payload, attachments }));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}));

// PATCH /api/dashboard/mail/:accountId/message/:uid — mark read/unread (:uid may be a set "3,7,9")
router.patch('/dashboard/mail/:accountId/message/:uid', writeRateLimit, withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res, { multi: true });
  if (!ctx) return;

  const { seen } = req.body;
  if (typeof seen !== 'boolean') return res.status(400).json({ error: 'seen must be boolean' });

  try {
    await markMailMessage(ctx.account, req.params.uid, seen, ctx.folder);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// POST /api/dashboard/mail/:accountId/message/:uid/move — move to folder (:uid may be a set)
router.post('/dashboard/mail/:accountId/message/:uid/move', writeRateLimit, withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res, { multi: true });
  if (!ctx) return;

  const { folder } = req.body;
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'folder is required' });

  try {
    await moveMailMessage(ctx.account, req.params.uid, folder, ctx.folder);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// DELETE /api/dashboard/mail/:accountId/message/:uid — move to trash (:uid may be a set)
router.delete('/dashboard/mail/:accountId/message/:uid', writeRateLimit, withHandler(async (req, res) => {
  const ctx = await _mailCtx(req, res, { multi: true });
  if (!ctx) return;

  try {
    const { permanent } = await deleteMailMessage(ctx.account, req.params.uid, ctx.folder);
    res.json({ ok: true, permanent });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// ---- Calendar routes ----

// GET /api/dashboard/calendar — fetch all configured calendar accounts (aggregated)
router.get('/dashboard/calendar', withHandler(async (req, res) => {
  const config   = await getDashboardConfig();
  const accounts = config.calendarAccounts || [];

  const settled = await Promise.allSettled(
    accounts.map(acc => fetchCalendarAccount(acc))
  );

  const result = accounts.map((acc, i) => {
    const r = settled[i];
    const base = { accountId: acc.id, label: acc.label, type: acc.type || 'caldav', color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null };
    if (r.status === 'fulfilled') return { ...base, ...r.value };
    return { ...base, events: [], error: r.reason?.message || 'Unknown error' };
  });

  res.json(result);
}));

// GET /api/dashboard/calendar/:accountId — fetch one account's events
// Supports ?days=n (lookahead from today) or ?from=YYYY-MM-DD&to=YYYY-MM-DD (explicit range, `to` exclusive)
const CAL_RANGE_MAX_DAYS = 62;
const _ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
router.get('/dashboard/calendar/:accountId', withHandler(async (req, res) => {
  const account = await getCalAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  let opts = {};
  const { from, to } = req.query;
  if (from !== undefined || to !== undefined) {
    if (typeof from !== 'string' || typeof to !== 'string' || !_ISO_DAY.test(from) || !_ISO_DAY.test(to)) {
      return res.status(400).json({ error: 'from and to must both be YYYY-MM-DD' });
    }
    const rangeStart = new Date(`${from}T00:00:00Z`);
    const rangeEnd   = new Date(`${to}T00:00:00Z`);
    if (isNaN(rangeStart) || isNaN(rangeEnd) || rangeEnd <= rangeStart) {
      return res.status(400).json({ error: 'to must be after from' });
    }
    if (rangeEnd - rangeStart > CAL_RANGE_MAX_DAYS * 86_400_000) {
      return res.status(400).json({ error: `Range must not exceed ${CAL_RANGE_MAX_DAYS} days` });
    }
    opts = { rangeStart, rangeEnd };
    const result = await fetchCalendarAccount(account, opts);
    return res.json({ type: account.type || 'caldav', ...result });
  }

  // Optional ?days=n override — clamped to [1, 365]; non-numeric → use account default
  const daysParam = parseInt(req.query.days, 10);
  if (!isNaN(daysParam)) opts.lookaheadDays = Math.min(365, Math.max(1, daysParam));

  const result = await fetchCalendarAccount(account, opts);
  res.json({ type: account.type || 'caldav', ...result });
}));

// GET /api/dashboard/calendar/:accountId/event/:uid — fetch one event's full fields
router.get('/dashboard/calendar/:accountId/event/:uid', withHandler(async (req, res) => {
  const account = await getCalAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { events, error } = await fetchRawEvents(account).catch(err => ({ events: [], error: err.message }));
  if (error) return res.status(502).json({ error });

  const event = events.find(e => e.uid === req.params.uid);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
}));

// POST /api/dashboard/calendar/:accountId/events — create a new event
router.post('/dashboard/calendar/:accountId/events', writeRateLimit, async (req, res) => {
  try {
    const account = await getCalAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.type === 'ical-url') return res.status(400).json({ error: 'iCal-URL accounts are read-only' });

    if (!validateCalendarEvent(req.body)) {
      return res.status(400).json({ error: schemaError(validateCalendarEvent) });
    }
    const { start, end, timezone, allDay } = req.body;
    if (new Date(end) < new Date(start)) return res.status(400).json({ error: 'end must be >= start' });
    if (!allDay && timezone) {
      const tzErr = _validateTz(timezone);
      if (tzErr) return res.status(400).json({ error: tzErr });
    }

    const { ics, uid } = buildIcs(req.body);
    const headers = _calHeaders(account);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const eventUrl = await resolveEventUrl(account, uid, headers, controller.signal);
      const r = await fetch(eventUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
        body:   ics,
        signal: controller.signal,
      });
      if (r.status === 201 || r.status === 204) return res.json({ ok: true, uid });
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `CalDAV error (HTTP ${r.status})`, detail });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err.name === 'AbortError') return res.status(502).json({ error: 'CalDAV request timed out' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/dashboard/calendar/:accountId/event/:uid — update an existing event
// Body may include editScope: 'occurrence'|'series' for recurring event editing.
// For 'occurrence': occurrenceDate (ISO) is required — fetches raw ICS and injects an exception VEVENT.
// For 'series': fetches raw ICS and patches master VEVENT fields.
// Without editScope: rebuilds from scratch (existing behaviour for non-recurring events).
router.put('/dashboard/calendar/:accountId/event/:uid', writeRateLimit, async (req, res) => {
  try {
    const account = await getCalAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.type === 'ical-url') return res.status(400).json({ error: 'iCal-URL accounts are read-only' });

    if (!validateCalendarEvent(req.body)) {
      return res.status(400).json({ error: schemaError(validateCalendarEvent) });
    }
    const { start, end, timezone, allDay, etag, href, editScope, occurrenceDate } = req.body;
    if (new Date(end) < new Date(start)) return res.status(400).json({ error: 'end must be >= start' });
    if (!allDay && timezone) {
      const tzErr = _validateTz(timezone);
      if (tzErr) return res.status(400).json({ error: tzErr });
    }

    const uid     = req.params.uid;
    const headers = _calHeaders(account);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      let ics, eventUrl;

      if (editScope === 'occurrence' || editScope === 'series') {
        // Fetch current raw ICS, then build modified version
        if (editScope === 'occurrence' && !occurrenceDate) {
          return res.status(400).json({ error: 'occurrenceDate is required for occurrence edits' });
        }
        const raw = await fetchRawIcs(account, uid, href, 10_000);
        eventUrl = raw.url;
        ics = editScope === 'occurrence'
          ? buildOccurrenceOverrideIcs(raw.ics, occurrenceDate, req.body)
          : patchMasterIcs(raw.ics, req.body);
      } else {
        // Rebuild from scratch (non-recurring event)
        ({ ics } = buildIcs(req.body, uid));
        eventUrl = hrefToUrl(account, href) || await resolveEventUrl(account, uid, headers, controller.signal);
      }

      const putHeaders = { ...headers, 'Content-Type': 'text/calendar; charset=utf-8' };
      if (etag) putHeaders['If-Match'] = etag;
      const r = await fetch(eventUrl, { method: 'PUT', headers: putHeaders, body: ics, signal: controller.signal });
      if (r.status === 204 || r.status === 201) return res.json({ ok: true });
      if (r.status === 412) return res.status(409).json({ error: 'Event was modified by someone else — please reload.' });
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `CalDAV error (HTTP ${r.status})`, detail });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err.name === 'AbortError') return res.status(502).json({ error: 'CalDAV request timed out' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/calendar/:accountId/event/:uid/cards — link a kanban card to the event.
// Body: { board, cardId, href? }. Adds a hidden X-JC-KANBAN-CARD property to the stored ICS
// (all other properties kept). Retries once when the event changed in between (HTTP 412).
router.post('/dashboard/calendar/:accountId/event/:uid/cards', writeRateLimit, async (req, res) => {
  try {
    const account = await getCalAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.type === 'ical-url') return res.status(400).json({ error: 'iCal-URL accounts are read-only' });
    if (!validateCalendarCardLink(req.body)) {
      return res.status(400).json({ error: schemaError(validateCalendarCardLink) });
    }
    const { board, cardId, href } = req.body;
    const headers = _calHeaders(account);

    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await fetchRawIcs(account, req.params.uid, href || null, 10_000);
      const ics = addCardRefIcs(raw.ics, board, cardId);
      if (!ics) return res.json({ ok: true, unchanged: true });
      const putHeaders = { ...headers, 'Content-Type': 'text/calendar; charset=utf-8' };
      if (raw.etag) putHeaders['If-Match'] = raw.etag;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const r = await fetch(raw.url, { method: 'PUT', headers: putHeaders, body: ics, signal: controller.signal });
        if (r.status === 204 || r.status === 201 || r.status === 200) return res.json({ ok: true });
        if (r.status === 412 && attempt === 0) continue;
        if (r.status === 412) return res.status(409).json({ error: 'Event was modified by someone else — please reload.' });
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: `CalDAV error (HTTP ${r.status})`, detail });
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return res.status(502).json({ error: 'CalDAV request timed out' });
    res.status(502).json({ error: err.message });
  }
});

// DELETE /api/dashboard/calendar/:accountId/event/:uid — delete an event
// ?editScope=occurrence&occurrenceDate=<ISO> → adds EXDATE to master (removes one occurrence).
// Without editScope → deletes the entire event resource.
router.delete('/dashboard/calendar/:accountId/event/:uid', writeRateLimit, async (req, res) => {
  try {
    const account = await getCalAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.type === 'ical-url') return res.status(400).json({ error: 'iCal-URL accounts are read-only' });

    const uid            = req.params.uid;
    const etag           = req.headers['if-match'] || null;
    const href           = req.query.href || null;
    const editScope      = req.query.editScope || null;
    const occurrenceDate = req.query.occurrenceDate || null;
    const headers        = _calHeaders(account);
    const controller     = new AbortController();
    const timer          = setTimeout(() => controller.abort(), 10_000);
    try {
      if (editScope === 'occurrence') {
        if (!occurrenceDate) return res.status(400).json({ error: 'occurrenceDate is required' });
        // Fetch current ICS, add EXDATE, PUT back
        const raw = await fetchRawIcs(account, uid, href, 10_000);
        const newIcs = buildDeleteOccurrenceIcs(raw.ics, occurrenceDate);
        const putHeaders = { ...headers, 'Content-Type': 'text/calendar; charset=utf-8' };
        if (etag) putHeaders['If-Match'] = etag;
        const r = await fetch(raw.url, { method: 'PUT', headers: putHeaders, body: newIcs, signal: controller.signal });
        if (r.status === 204 || r.status === 201) return res.json({ ok: true });
        if (r.status === 412) return res.status(409).json({ error: 'Event was modified — please reload.' });
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: `CalDAV error (HTTP ${r.status})`, detail });
      }

      // Delete entire event resource
      const eventUrl = hrefToUrl(account, href) || await resolveEventUrl(account, uid, headers, controller.signal);
      const delHeaders = { ...headers };
      if (etag) delHeaders['If-Match'] = etag;
      const r = await fetch(eventUrl, { method: 'DELETE', headers: delHeaders, signal: controller.signal });
      if (r.status === 204 || r.status === 200) return res.json({ ok: true });
      if (r.status === 404) return res.status(404).json({ error: 'Event not found (already deleted?)' });
      if (r.status === 412) return res.status(409).json({ error: 'Event was modified — please reload.' });
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `CalDAV error (HTTP ${r.status})`, detail });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err.name === 'AbortError') return res.status(502).json({ error: 'CalDAV request timed out' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/calendar/:accountId/test — test connectivity
router.post('/dashboard/calendar/:accountId/test', withHandler(async (req, res) => {
  const account = await getCalAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const result = await testCalendarAccount(account);
  res.json(result);
}));

// Attach helpers for unit tests
router.stripPasswords = stripPasswords;
router.mergePasswords  = mergePasswords;

module.exports = router;
