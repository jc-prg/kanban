'use strict';
const express = require('express');
const router  = express.Router();
const { writeRateLimit }                          = require('../auth');
const { getDashboardConfig, saveDashboardConfig } = require('../global-db');
const { getCouch }                                = require('../db');
const { DB_PREFIX, DOC_ID }                       = require('../config');
const { fetchCalendarAccount, fetchRawEvents, testCalendarAccount, clearCalendarUrlCache } = require('../dashboard/calendar');
const { fetchMailAccount, fetchMailMessage, testMailAccount,
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
  return {
    ...incoming,
    mailAccounts:     mergeList(stored.mailAccounts,     incoming.mailAccounts),
    calendarAccounts: mergeList(stored.calendarAccounts, incoming.calendarAccounts),
  };
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

// ---- Routes ----

router.get('/dashboard/config', async (req, res) => {
  try {
    const config = await getDashboardConfig();
    res.json(stripPasswords(config));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/dashboard/config', writeRateLimit, async (req, res) => {
  try {
    const stored = await getDashboardConfig();
    const merged = mergePasswords(stored, req.body);
    await saveDashboardConfig(merged);
    clearCalendarUrlCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dashboard/cards', async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Combined data endpoint ----

// GET /api/dashboard/data — fetch all sources in parallel, return combined result
router.get('/dashboard/data', async (req, res) => {
  try {
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
        const r = settled[i];
        if (r.status === 'fulfilled') {
          return { accountId: acc.id, label: acc.label, color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null, ...r.value };
        }
        return { accountId: acc.id, label: acc.label, color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null, events: [], error: r.reason?.message || 'Unknown error' };
      });
    })();

    const [cards, mail, calendar] = await Promise.all([cardsPromise, mailPromise, calendarPromise]);
    res.json({ cards, mail, calendar, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Mail routes ----

// GET /api/dashboard/mail — aggregate all mail accounts
router.get('/dashboard/mail', async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/mail/:accountId — fetch one account's messages
router.get('/dashboard/mail/:accountId', async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.mailAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    try {
      const messages = await fetchMailAccount(account);
      res.json({ messages, error: null });
    } catch (err) {
      res.json({ messages: [], error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/mail/:accountId/message/:uid — fetch one full message
router.get('/dashboard/mail/:accountId/message/:uid', async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.mailAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    let msg;
    try {
      msg = await fetchMailMessage(account, req.params.uid);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/mail/:accountId/test — test IMAP connectivity
router.post('/dashboard/mail/:accountId/test', async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.mailAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const result = await testMailAccount(account);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/mail/:accountId/folders — list IMAP folders
router.get('/dashboard/mail/:accountId/folders', async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.mailAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    try {
      const folders = await listMailFolders(account);
      res.json({ folders });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/dashboard/mail/:accountId/message/:uid — mark read/unread
router.patch('/dashboard/mail/:accountId/message/:uid', writeRateLimit, async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.mailAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { seen } = req.body;
    if (typeof seen !== 'boolean') return res.status(400).json({ error: 'seen must be boolean' });

    try {
      await markMailMessage(account, req.params.uid, seen);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/mail/:accountId/message/:uid/move — move to folder
router.post('/dashboard/mail/:accountId/message/:uid/move', writeRateLimit, async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.mailAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { folder } = req.body;
    if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'folder is required' });

    try {
      await moveMailMessage(account, req.params.uid, folder);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dashboard/mail/:accountId/message/:uid — move to trash
router.delete('/dashboard/mail/:accountId/message/:uid', writeRateLimit, async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.mailAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    try {
      await deleteMailMessage(account, req.params.uid);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Calendar routes ----

// GET /api/dashboard/calendar — fetch all configured calendar accounts (aggregated)
router.get('/dashboard/calendar', async (req, res) => {
  try {
    const config   = await getDashboardConfig();
    const accounts = config.calendarAccounts || [];

    const settled = await Promise.allSettled(
      accounts.map(acc => fetchCalendarAccount(acc))
    );

    const result = accounts.map((acc, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        return { accountId: acc.id, label: acc.label, color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null, ...r.value };
      }
      return { accountId: acc.id, label: acc.label, color: acc.color || null, webInterfaceUrl: acc.webInterfaceUrl || null, events: [], error: r.reason?.message || 'Unknown error' };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/calendar/:accountId — fetch one account's events
router.get('/dashboard/calendar/:accountId', async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.calendarAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const result = await fetchCalendarAccount(account);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/calendar/:accountId/event/:uid — fetch one event's full fields
router.get('/dashboard/calendar/:accountId/event/:uid', async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.calendarAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { events, error } = await fetchRawEvents(account).catch(err => ({ events: [], error: err.message }));
    if (error) return res.status(502).json({ error });

    const event = events.find(e => e.uid === req.params.uid);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/calendar/:accountId/test — test connectivity
router.post('/dashboard/calendar/:accountId/test', async (req, res) => {
  try {
    const config  = await getDashboardConfig();
    const account = (config.calendarAccounts || []).find(a => a.id === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const result = await testCalendarAccount(account);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attach helpers for unit tests
router.stripPasswords = stripPasswords;
router.mergePasswords  = mergePasswords;

module.exports = router;
