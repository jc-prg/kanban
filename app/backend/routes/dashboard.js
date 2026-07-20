'use strict';
const express = require('express');
const router  = express.Router();
const { writeRateLimit }                          = require('../auth');
const { getDashboardConfig, saveDashboardConfig, getMailAccount, getCalAccount, getRecentFolders, addRecentFolder } = require('../global-db');
const { getCouch, withHandler }                   = require('../db');
const { DB_PREFIX, DOC_ID, NOTES_DOC_ID }         = require('../config');
const { fetchCalendarAccount, fetchRawEvents, testCalendarAccount, clearCalendarUrlCache,
        buildIcs, fetchRawIcs, patchMasterIcs, buildOccurrenceOverrideIcs, buildDeleteOccurrenceIcs,
        resolveEventUrl, hrefToUrl } = require('../dashboard/calendar');
const { validateCalendarEvent, schemaError } = require('../schemas');
const { fetchMailAccount, fetchMailMessage, fetchMailAttachment, testMailAccount,
        listMailFolders, markMailMessage, moveMailMessage, deleteMailMessage } = require('../dashboard/mail');

// ---- Password utilities (also exported for unit tests) ----

function stripPasswords(config) {
  return {
    ...config,
    mailAccounts: (config.mailAccounts || []).map(({ password, ...a }) => ({
      ...a,
      hasPassword: !!password,
    })),
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
      if (storedAcc && (!('password' in acc) || acc.password === '')) {
        return { ...acc, password: storedAcc.password || '' };
      }
      return acc;
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
        cards: (col.cards || []).map(({ id, text, priority, color, startDate, endDate, done, description, link }) => ({
          id, text, priority, color, startDate, endDate, done, description: !!description, link: link || '',
          hasLinkedNotes: linkedCards.has(id),
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
          cards: (col.cards || []).map(({ id, text, priority, color, startDate, endDate, done, description, link }) => ({
            id, text, priority, color, startDate, endDate, done, description: !!description, link: link || '',
            hasLinkedNotes: linkedCards.has(id),
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

  res.json(result);
}));

// GET /api/dashboard/mail/:accountId — fetch one account's messages
router.get('/dashboard/mail/:accountId', withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const messages = await fetchMailAccount(account);
    res.json({ messages, error: null });
  } catch (err) {
    res.json({ messages: [], error: err.message });
  }
}));

// GET /api/dashboard/mail/:accountId/message/:uid — fetch one full message
router.get('/dashboard/mail/:accountId/message/:uid', withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  let msg;
  try {
    msg = await fetchMailMessage(account, req.params.uid);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  res.json(msg);
}));

// GET /api/dashboard/mail/:accountId/message/:uid/attachment/:part — download attachment
router.get('/dashboard/mail/:accountId/message/:uid/attachment/:part', withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { part } = req.params;
  if (!/^[\d.]+$/.test(part)) return res.status(400).json({ error: 'Invalid part' });

  let att;
  try {
    att = await fetchMailAttachment(account, req.params.uid, part);
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
    const folders = await listMailFolders(account);
    res.json({ folders });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// PATCH /api/dashboard/mail/:accountId/message/:uid — mark read/unread
router.patch('/dashboard/mail/:accountId/message/:uid', writeRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { seen } = req.body;
  if (typeof seen !== 'boolean') return res.status(400).json({ error: 'seen must be boolean' });

  try {
    await markMailMessage(account, req.params.uid, seen);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// POST /api/dashboard/mail/:accountId/message/:uid/move — move to folder
router.post('/dashboard/mail/:accountId/message/:uid/move', writeRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { folder } = req.body;
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'folder is required' });

  try {
    await moveMailMessage(account, req.params.uid, folder);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// DELETE /api/dashboard/mail/:accountId/message/:uid — move to trash
router.delete('/dashboard/mail/:accountId/message/:uid', writeRateLimit, withHandler(async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    await deleteMailMessage(account, req.params.uid);
    res.json({ ok: true });
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

// GET /api/dashboard/calendar/:accountId — fetch one account's events (supports ?days=n)
router.get('/dashboard/calendar/:accountId', withHandler(async (req, res) => {
  const account = await getCalAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Optional ?days=n override — clamped to [1, 365]; non-numeric → use account default
  let opts = {};
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
