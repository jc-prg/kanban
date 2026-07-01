const express  = require('express');
const router   = express.Router();
const archiver = require('archiver');
const fs       = require('fs');
const path     = require('path');
const { writeRateLimit }                                            = require('../auth');
const { withBoard, withExistingBoard, loadNotesData, saveNotesData } = require('../db');
const { validateNotes, validateNotesPatch, schemaError }            = require('../schemas');
const { NOTES_DOC_ID, ATTACHMENTS_DIR }                             = require('../config');
const { getWebdavDb, getWebdavAccounts }                             = require('../global-db');
const {
  wdGet, wdPut, wdDelete, wdMove, wdMkcol, wdGetMeta,
  buildPath, getAttachmentPrefix, parseFm, renderMd,
  syncFromWebdav, syncRootFromWebdav, syncFolderChildrenFromWebdav,
  deletePageWithAttachments, deleteFolderWithAttachments,
  _titleToSlug, _updateChildWdPaths,
} = require('../webdav-notes');

// ---------------------------------------------------------------------------
// WebDAV config — stored globally in jc-config-webdav, keyed by board name
// Per-board doc format (new): { enabled, accountId, subfolder }
// Per-board doc format (old/compat): { enabled, url, user, password }
// ---------------------------------------------------------------------------

async function _loadWebdavDoc(board) {
  try {
    const { _id, _rev, ...data } = await getWebdavDb().get(board);
    return { _rev, ...data };
  } catch (err) {
    if (err.statusCode === 404) return {};
    throw err;
  }
}

/** Returns full config including password — for internal backend use only. */
async function getWebdavConfig(board) {
  const doc = await _loadWebdavDoc(board);
  if (!doc.enabled) return { enabled: false, url: '', user: '', password: '' };

  // New format: accountId + subfolder
  if (doc.accountId) {
    const accounts = await getWebdavAccounts();
    const account  = accounts.find(a => a.id === doc.accountId);
    if (!account) return { enabled: false, url: '', user: '', password: '' };
    const base      = account.url.endsWith('/') ? account.url : account.url + '/';
    const subfolder = (doc.subfolder || '').replace(/^\/|\/$/g, '');
    const url       = subfolder ? base + subfolder + '/' : base;
    return { enabled: true, url, user: account.user || '', password: account.password || '' };
  }

  // Legacy inline format (backward compat)
  return { enabled: true, url: doc.url || '', user: doc.user || '', password: doc.password || '' };
}

router.get('/:board/webdav-config', withExistingBoard(async (req, res, _db) => {
  try {
    const doc = await _loadWebdavDoc(req.params.board);
    // Resolve account label for display
    let accountLabel = '';
    if (doc.accountId) {
      const accounts = await getWebdavAccounts();
      const account  = accounts.find(a => a.id === doc.accountId);
      accountLabel   = account ? (account.label || account.url || '') : '';
    }
    res.json({
      enabled:      doc.enabled      ?? false,
      accountId:    doc.accountId    || '',
      subfolder:    doc.subfolder    || '',
      accountLabel,
      // legacy fields — present only for old docs, omitted when using account
      ...(doc.url  ? { url:  doc.url,  user: doc.user || '', hasPassword: !!doc.password } : {}),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}));

// Test connectivity — accepts {accountId, subfolder} from body (no credentials sent from browser)
router.post('/:board/webdav-config/test', writeRateLimit, withExistingBoard(async (req, res, _db) => {
  try {
    const accountId = req.body.accountId || '';
    const subfolder = typeof req.body.subfolder === 'string' ? req.body.subfolder.trim() : '';

    let url, user, password;

    if (accountId) {
      const accounts = await getWebdavAccounts();
      const account  = accounts.find(a => a.id === accountId);
      if (!account) return res.json({ ok: false, error: 'Account not found' });
      const base = account.url.endsWith('/') ? account.url : account.url + '/';
      const sub  = subfolder.replace(/^\/|\/$/g, '');
      url      = sub ? base + sub + '/' : base;
      user     = account.user     || '';
      password = account.password || '';
    } else {
      // Legacy: test with stored inline config
      const stored = await getWebdavConfig(req.params.board);
      url      = stored.url;
      user     = stored.user;
      password = stored.password;
    }

    if (!url) return res.json({ ok: false, error: 'No WebDAV URL configured' });

    const testUrl = url.endsWith('/') ? url : url + '/';
    const headers = { Depth: '0', 'Content-Type': 'application/xml' };
    if (user || password)
      headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let r;
    try {
      r = await fetch(testUrl, { method: 'PROPFIND', headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (r.status === 207)
      return res.json({ ok: true, message: `Connected — HTTP ${r.status} Multi-Status` });
    if (r.status === 401 || r.status === 403)
      return res.json({ ok: false, error: `Authentication failed (HTTP ${r.status})` });
    if (r.status === 405)
      return res.json({ ok: false, error: `Server reachable but PROPFIND not allowed (HTTP 405) — not a WebDAV endpoint?` });
    return res.json({ ok: false, error: `Unexpected response: HTTP ${r.status}` });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out (8 s)' : err.message;
    res.json({ ok: false, error: msg });
  }
}));

router.put('/:board/webdav-config', writeRateLimit, withBoard(async (req, res, _db) => {
  try {
    const { enabled, accountId, subfolder } = req.body;
    const existing = await _loadWebdavDoc(req.params.board);
    const doc = {
      _id:       req.params.board,
      ...(existing._rev ? { _rev: existing._rev } : {}),
      enabled:   !!enabled,
      accountId: typeof accountId === 'string' ? accountId.trim() : (existing.accountId || ''),
      subfolder: typeof subfolder === 'string' ? subfolder.trim() : (existing.subfolder || ''),
    };
    await getWebdavDb().insert(doc);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
}));

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

// Convert a v1 page (with optional children) into v2 items (folders + pages).
function _migratePageToItems(page) {
  const pageItem = {
    type: 'page',
    id:    page.id,
    title: page.title,
    ...(page.description    !== undefined ? { description:    page.description    } : {}),
    ...(page.link           !== undefined ? { link:           page.link           } : {}),
    ...(page.linkedCards    !== undefined ? { linkedCards:    page.linkedCards    } : {}),
    ...(page.hasAttachments !== undefined ? { hasAttachments: page.hasAttachments } : {}),
    ...(page.lastModified   !== undefined ? { lastModified:   page.lastModified   } : {}),
  };

  if (!page.children?.length) return [pageItem];

  // Page with children → folder; keep the page's own content inside the folder
  // if it has a non-empty description, otherwise just promote children.
  const folderChildren = [];
  if (page.description?.trim()) {
    folderChildren.push(pageItem);
  }
  for (const child of page.children) {
    folderChildren.push(..._migratePageToItems(child));
  }
  return [{ type: 'folder', id: page.id, title: page.title, children: folderChildren }];
}

function migrateV1ToV2(data) {
  const items = [];
  for (const page of (data.pages || [])) {
    items.push(..._migratePageToItems(page));
  }
  return { items, schemaVersion: 2 };
}

function normalizeNotes(data) {
  if (!data) return { items: [], schemaVersion: 2 };
  if (data.schemaVersion === 2 && Array.isArray(data.items)) return data;
  // v1: has pages array
  if (Array.isArray(data.pages)) return migrateV1ToV2(data);
  return { items: [], schemaVersion: 2 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string for YAML flow scalar (double-quoted). */
function yamlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** List original attachment filenames for a page from the local filesystem. */
function _getAttachmentFiles(board, pageId, prefix = '') {
  if (!ATTACHMENTS_DIR) return [];
  const dir = path.join(ATTACHMENTS_DIR, board, prefix, '_attachments');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(n => !n.startsWith('.') && n.startsWith(pageId + '_'))
      .map(n => n.slice(pageId.length + 1));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/:board/notes', withExistingBoard(async (req, res, db) => {
  try {
    let _rev, data;
    try {
      const { _id, _rev: rev, ...raw } = await db.get(NOTES_DOC_ID);
      _rev = rev;
      data = normalizeNotes(raw);
    } catch (err) {
      if (err.statusCode === 404) { data = { items: [], schemaVersion: 2 }; }
      else throw err;
    }

    const cfg = await getWebdavConfig(req.params.board);
    if (cfg.enabled) {
      try {
        const { tree, changed } = await syncRootFromWebdav(cfg, data);
        if (changed) {
          const result = await saveNotesData(db, tree);
          _rev = result.rev;
          data = tree;
        }
      } catch (wdErr) {
        // WebDAV unavailable — serve from CouchDB cache
        console.warn('WebDAV sync failed, serving from CouchDB cache:', wdErr.message);
      }
    }

    const etag = _rev ? `"${_rev}"` : null;
    if (etag) {
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('ETag', etag);
    }
    res.json(data);
  } catch (err) {
    throw err;
  }
}));

router.put('/:board/notes', writeRateLimit, withBoard(async (req, res, db) => {
  if (!validateNotes(req.body))
    return res.status(400).json({ error: 'Invalid notes data', details: schemaError(validateNotes) });
  const ifMatch = req.headers['if-match'];
  if (ifMatch) {
    let rev;
    try { ({ _rev: rev } = await db.get(NOTES_DOC_ID)); } catch (e) { /* new doc — no conflict */ }
    if (rev && ifMatch !== `"${rev}"`) return res.status(409).json({ error: 'conflict' });
  }
  const result = await saveNotesData(db, req.body);
  res.setHeader('ETag', `"${result.rev}"`);
  res.json({ ok: true });
}));

router.patch('/:board/notes', writeRateLimit, withBoard(async (req, res, db) => {
  if (!validateNotesPatch(req.body))
    return res.status(400).json({ error: 'Invalid notes patch', details: schemaError(validateNotesPatch) });
  const { updatedPages = [] } = req.body;
  if (!updatedPages.length) return res.json({ ok: true });
  let notes, currentRev;
  try {
    const { _id, _rev, ...raw } = await db.get(NOTES_DOC_ID);
    currentRev = _rev;
    notes = normalizeNotes(raw);
  } catch (err) {
    if (err.statusCode === 404) { notes = { items: [], schemaVersion: 2 }; }
    else throw err;
  }
  const ifMatch = req.headers['if-match'];
  if (ifMatch && currentRev && ifMatch !== `"${currentRev}"`) return res.status(409).json({ error: 'conflict' });

  function upsertPage(items, patch) {
    for (const item of items) {
      if (item.type === 'page' && item.id === patch.id) { Object.assign(item, patch); return true; }
      if (item.type === 'folder' && item.children?.length && upsertPage(item.children, patch)) return true;
    }
    return false;
  }
  for (const page of updatedPages) upsertPage(notes.items, page);
  const result = await saveNotesData(db, notes);
  res.setHeader('ETag', `"${result.rev}"`);
  res.json({ ok: true });
}));

router.get('/:board/notes/export', withExistingBoard(async (req, res, db) => {
  const { board } = req.params;
  const raw      = await loadNotesData(db);
  const notes    = normalizeNotes(raw);
  const boardDir = ATTACHMENTS_DIR ? path.join(ATTACHMENTS_DIR, board) : null;
  const baseUrl  = `${req.protocol}://${req.get('host')}`;

  // Pre-build card map for linkedCards resolution (same logic as _linkedCardEntries)
  const cardMap = new Map();
  try {
    const { columns } = await db.get('board');
    for (const col of columns || [])
      for (const card of col.cards || [])
        cardMap.set(card.id, card.text);
  } catch { /* board doc absent */ }

  function resolveLinkedCards(linkedCards) {
    if (!linkedCards?.length) return [];
    return linkedCards.map(id => {
      const rawText = cardMap.get(id);
      if (!rawText) return id;
      const title = rawText.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
      return `[${title}](${baseUrl}/${board}#card:${id})`;
    });
  }

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => console.error('ZIP error:', err.message));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="notes-${board}.zip"`);
  archive.pipe(res);

  function addItems(items, zipPrefix) {
    for (const item of items) {
      const slug = _titleToSlug(item.title || 'Untitled');
      if (item.type === 'folder') {
        addItems(item.children || [], `${zipPrefix}${slug}/`);
      } else {
        // Locate local attachment files using the stored tree prefix
        const localAttachDir = boardDir
          ? path.join(boardDir, getAttachmentPrefix(item, notes.items), '_attachments')
          : null;
        const storedFiles = localAttachDir && fs.existsSync(localAttachDir)
          ? fs.readdirSync(localAttachDir).filter(n => !n.startsWith('.') && n.startsWith(`${item.id}_`))
          : [];
        const attachmentFiles = storedFiles.map(n => n.slice(item.id.length + 1));

        const source    = `${baseUrl}/${board}#note:${item.id}`;
        const lcEntries = resolveLinkedCards(item.linkedCards);
        archive.append(renderMd(item, attachmentFiles, source, lcEntries), { name: `${zipPrefix}${slug}.md` });

        for (const stored of storedFiles) {
          const zipPath = `${zipPrefix}_attachments/${stored}`;
          if (!zipPath.includes('..')) archive.file(path.join(localAttachDir, stored), { name: zipPath });
        }
      }
    }
  }

  addItems(notes.items || [], '');
  await archive.finalize();
}));

// ---------------------------------------------------------------------------
// Helpers shared by per-operation routes
// ---------------------------------------------------------------------------

async function _loadNotes(db) {
  try {
    const { _id, _rev, ...raw } = await db.get(NOTES_DOC_ID);
    return normalizeNotes(raw);
  } catch (err) {
    if (err.statusCode === 404) return { items: [], schemaVersion: 2 };
    throw err;
  }
}

function _findItem(id, items) {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.type === 'folder') { const f = _findItem(id, item.children || []); if (f) return f; }
  }
  return null;
}

function _removeItem(id, items) {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === id) return items.splice(i, 1)[0];
    if (items[i].type === 'folder') {
      const r = _removeItem(id, items[i].children || []);
      if (r) return r;
    }
  }
  return null;
}

function _collectWdPaths(items, out = new Set()) {
  for (const it of items) {
    if (it.wdPath) out.add(it.wdPath);
    if (it.type === 'folder') _collectWdPaths(it.children || [], out);
  }
  return out;
}

function _uniqueWdPath(basePath, occupied) {
  if (!occupied.has(basePath)) return basePath;
  const stem = basePath.replace(/\.md$/, '');
  let i = 2;
  while (occupied.has(`${stem}-${i}.md`)) i++;
  return `${stem}-${i}.md`;
}

function _insertItem(item, parentId, items, targetId = null, position = null) {
  let targetArr;
  if (!parentId) {
    targetArr = items;
  } else {
    const parent = _findItem(parentId, items);
    targetArr = (parent?.type === 'folder') ? (parent.children ??= []) : items;
  }
  if (targetId && (position === 'before' || position === 'after')) {
    const idx = targetArr.findIndex(i => i.id === targetId);
    if (idx !== -1) {
      targetArr.splice(position === 'before' ? idx : idx + 1, 0, item);
      return true;
    }
  }
  targetArr.push(item); // fallback: append
  return true;
}

// ---------------------------------------------------------------------------
// Per-operation routes
// ---------------------------------------------------------------------------

// GET /:board/notes/pages/:id/content  — fetch page body fresh from WebDAV
router.get('/:board/notes/pages/:id/content', withExistingBoard(async (req, res, db) => {
  const cfg = await getWebdavConfig(req.params.board);
  if (!cfg.enabled) return res.status(400).json({ error: 'WebDAV not enabled' });
  const notes = await _loadNotes(db);
  const page  = _findItem(req.params.id, notes.items);
  if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });
  const pagePath = buildPath(page, notes.items);
  if (!pagePath) return res.status(404).json({ error: 'Cannot determine page path' });
  try {
    const text = await wdGet(cfg, pagePath);
    const { meta, body } = parseFm(text);
    const lastModified = meta.lastModified || null;
    res.json({ content: body, lastModified });
  } catch (err) {
    if (err.status === 404) return res.json({ content: page.description || '', lastModified: page.lastModified || null });
    res.status(502).json({ error: `WebDAV error: ${err.message}` });
  }
}));

// GET /:board/notes/pages/:id/meta  — get last-modified from WebDAV (conflict check)
router.get('/:board/notes/pages/:id/meta', withExistingBoard(async (req, res, db) => {
  const cfg = await getWebdavConfig(req.params.board);
  if (!cfg.enabled) return res.status(400).json({ error: 'WebDAV not enabled' });
  const notes = await _loadNotes(db);
  const page  = _findItem(req.params.id, notes.items);
  if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });
  const pagePath = buildPath(page, notes.items);
  if (!pagePath) return res.status(404).json({ error: 'Cannot determine page path' });
  try {
    const meta = await wdGetMeta(cfg, pagePath);
    res.json(meta || { lastModified: null, size: 0 });
  } catch (err) {
    res.status(502).json({ error: `WebDAV error: ${err.message}` });
  }
}));

function _sourceUrl(req, board, pageId) {
  return `${req.protocol}://${req.get('host')}/${board}#note:${pageId}`;
}

/** Resolve card IDs to "[title | id-xxx](url/board#card:id-xxx)" strings for WebDAV frontmatter. */
async function _linkedCardEntries(db, linkedCards, baseUrl = '', board = '') {
  if (!linkedCards?.length) return [];
  try {
    const { columns } = await db.get('board');
    const cardMap = new Map();
    for (const col of columns || [])
      for (const card of col.cards || [])
        cardMap.set(card.id, card.text);
    return linkedCards.map(id => {
      const rawText = cardMap.get(id);
      if (!rawText) return id;
      const title = rawText.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
      if (baseUrl && board) return `[${title}](${baseUrl}/${board}#card:${id})`;
      return `${title} (${id})`;
    });
  } catch { return linkedCards; }
}

// POST /:board/notes/pages  — create page (+ WebDAV PUT)
router.post('/:board/notes/pages', writeRateLimit, withBoard(async (req, res, db) => {
  const { board } = req.params;
  const { page, parentId } = req.body;
  if (!page?.id || !page?.title) return res.status(400).json({ error: 'page.id and page.title required' });
  const notes = await _loadNotes(db);
  if (_findItem(page.id, notes.items)) return res.status(409).json({ error: 'Page ID already exists' });
  _insertItem({ type: 'page', ...page }, parentId || null, notes.items);
  const cfg = await getWebdavConfig(req.params.board);
  if (cfg.enabled) {
    const inserted = _findItem(page.id, notes.items);
    const basePath = buildPath(inserted, notes.items);
    if (basePath) {
      // Ensure the computed path doesn't collide with an existing page's wdPath
      const occupied = _collectWdPaths(notes.items);
      occupied.delete(inserted.wdPath); // inserted has no wdPath yet, but be safe
      const pagePath = _uniqueWdPath(basePath, occupied);
      inserted.wdPath = pagePath;
      try {
        const dir = pagePath.includes('/') ? pagePath.substring(0, pagePath.lastIndexOf('/') + 1) : '';
        if (dir) await wdMkcol(cfg, dir).catch(() => {});
        const lcEntries = await _linkedCardEntries(db, inserted.linkedCards, `${req.protocol}://${req.get('host')}`, board);
        await wdPut(cfg, pagePath, renderMd(inserted, _getAttachmentFiles(board, inserted.id, getAttachmentPrefix(inserted, notes.items)), _sourceUrl(req, board, inserted.id), lcEntries));
      } catch (err) {
        console.warn('WebDAV write failed, saving to CouchDB cache:', err.message);
      }
    }
  }
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// PATCH /:board/notes/pages/:id  — update page fields (title, content, link, linkedCards)
router.patch('/:board/notes/pages/:id', writeRateLimit, withBoard(async (req, res, db) => {
  const { id, board } = req.params;
  const notes  = await _loadNotes(db);
  const page   = _findItem(id, notes.items);
  if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

  const cfg          = await getWebdavConfig(req.params.board);
  const oldPath      = cfg.enabled ? (page.wdPath || buildPath(page, notes.items)) : null;
  const titleChanged = req.body.title !== undefined && req.body.title !== page.title;

  if (req.body.title       !== undefined) page.title       = req.body.title;
  if (req.body.description !== undefined) page.description = req.body.description;
  if (req.body.link        !== undefined) page.link        = req.body.link;
  if (req.body.linkedCards !== undefined) page.linkedCards = req.body.linkedCards;
  page.lastModified = new Date().toISOString();

  if (cfg.enabled && oldPath) {
    try {
      // Compute new path from the (possibly changed) title, ignoring stored wdPath.
      const savedWdPath = page.wdPath;
      delete page.wdPath;
      const newPath = buildPath(page, notes.items);
      page.wdPath   = savedWdPath;

      const attachFiles = _getAttachmentFiles(board, page.id, getAttachmentPrefix(page, notes.items));
      const source      = _sourceUrl(req, board, page.id);
      const lcEntries   = await _linkedCardEntries(db, page.linkedCards, `${req.protocol}://${req.get('host')}`, board);
      if (titleChanged && newPath && newPath !== oldPath) {
        await wdMove(cfg, oldPath, newPath);
        page.wdPath = newPath;
        await wdPut(cfg, newPath, renderMd(page, attachFiles, source, lcEntries));
      } else {
        const target = page.wdPath || newPath;
        if (target) await wdPut(cfg, target, renderMd(page, attachFiles, source, lcEntries));
      }
    } catch (err) {
      console.warn('WebDAV write failed, saving to CouchDB cache:', err.message);
    }
  }
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// DELETE /:board/notes/pages/:id  — delete page + attachments
router.delete('/:board/notes/pages/:id', writeRateLimit, withBoard(async (req, res, db) => {
  const { id, board } = req.params;
  const notes = await _loadNotes(db);
  const page  = _findItem(id, notes.items);
  if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

  const cfg = await getWebdavConfig(req.params.board);
  if (cfg.enabled) {
    const boardAttachDir = ATTACHMENTS_DIR ? path.join(ATTACHMENTS_DIR, board) : null;
    try {
      await deletePageWithAttachments(cfg, page, notes.items, boardAttachDir);
    } catch (err) {
      console.error('WebDAV delete page failed:', err.message);
      return res.status(500).json({ error: `Could not delete page on WebDAV server: ${err.message}` });
    }
  } else {
    // CouchDB-only: delete local attachment files for this page
    if (ATTACHMENTS_DIR) {
      const prefix  = getAttachmentPrefix(page, notes.items);
      const aDir    = path.join(ATTACHMENTS_DIR, board, prefix, '_attachments');
      for (const f of _getAttachmentFiles(board, page.id, prefix)) {
        try { fs.unlinkSync(path.join(aDir, `${page.id}_${f}`)); } catch { /* ok */ }
      }
    }
  }
  _removeItem(id, notes.items);
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// POST /:board/notes/pages/:id/move  — move page to different folder (or root)
router.post('/:board/notes/pages/:id/move', writeRateLimit, withBoard(async (req, res, db) => {
  const { id, board } = req.params;
  const { folderId, targetId, position } = req.body; // null/undefined = move to root
  const notes = await _loadNotes(db);
  const page  = _findItem(id, notes.items);
  if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

  const cfg       = await getWebdavConfig(req.params.board);
  const oldPath   = page.wdPath || buildPath(page, notes.items);
  const oldPrefix = getAttachmentPrefix(page, notes.items); // computed before tree mutation

  _removeItem(id, notes.items);
  _insertItem(page, folderId || null, notes.items, targetId || null, position || null);

  // Compute new path without relying on stored wdPath (it's stale after the move).
  const savedWdPath = page.wdPath;
  delete page.wdPath;
  const newPath   = buildPath(page, notes.items);
  page.wdPath     = savedWdPath;
  const newPrefix = newPath && newPath.includes('/') ? newPath.substring(0, newPath.lastIndexOf('/') + 1) : '';

  const pathChanged = oldPath && newPath && newPath !== oldPath;

  if (cfg.enabled && pathChanged) {
    try {
      if (newPrefix) await wdMkcol(cfg, newPrefix).catch(() => {});
      await wdMove(cfg, oldPath, newPath);
      page.wdPath = newPath;

      // Move per-page attachments to the new _attachments directory on WebDAV
      if (oldPrefix !== newPrefix) {
        const attachFiles = _getAttachmentFiles(board, page.id, oldPrefix);
        if (attachFiles.length) {
          if (newPrefix) await wdMkcol(cfg, `${newPrefix}_attachments/`).catch(() => {});
          for (const f of attachFiles)
            await wdMove(cfg, `${oldPrefix}_attachments/${page.id}_${f}`, `${newPrefix}_attachments/${page.id}_${f}`).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('WebDAV write failed, saving to CouchDB cache:', err.message);
    }
  }

  // Move local cached attachment files so download links remain valid after tree save.
  // The download route resolves the prefix from CouchDB on every request, so files must
  // be at the new prefix location before saveNotesData writes the updated tree.
  if (ATTACHMENTS_DIR && pathChanged && oldPrefix !== newPrefix) {
    const attachFiles = _getAttachmentFiles(board, page.id, oldPrefix);
    if (attachFiles.length) {
      const oldDir = path.join(ATTACHMENTS_DIR, board, oldPrefix, '_attachments');
      const newDir = path.join(ATTACHMENTS_DIR, board, newPrefix, '_attachments');
      fs.mkdirSync(newDir, { recursive: true });
      for (const f of attachFiles)
        try { fs.renameSync(path.join(oldDir, `${page.id}_${f}`), path.join(newDir, `${page.id}_${f}`)); } catch { /* ok */ }
    }
  }

  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// POST /:board/notes/folders  — create folder (+ WebDAV MKCOL)
router.post('/:board/notes/folders', writeRateLimit, withBoard(async (req, res, db) => {
  const { folder, parentId } = req.body;
  if (!folder?.id || !folder?.title) return res.status(400).json({ error: 'folder.id and folder.title required' });
  const notes = await _loadNotes(db);
  if (_findItem(folder.id, notes.items)) return res.status(409).json({ error: 'Folder ID already exists' });
  _insertItem({ type: 'folder', ...folder, children: folder.children || [] }, parentId || null, notes.items);
  const cfg = await getWebdavConfig(req.params.board);
  if (cfg.enabled) {
    const inserted   = _findItem(folder.id, notes.items);
    const folderPath = buildPath(inserted, notes.items);
    if (folderPath) {
      inserted.wdPath = folderPath;
      await wdMkcol(cfg, folderPath).catch(() => {});
    }
  }
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// PATCH /:board/notes/folders/:id  — rename folder (+ WebDAV MOVE)
router.patch('/:board/notes/folders/:id', writeRateLimit, withBoard(async (req, res, db) => {
  const { id }   = req.params;
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const notes  = await _loadNotes(db);
  const folder = _findItem(id, notes.items);
  if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });

  const cfg     = await getWebdavConfig(req.params.board);
  const oldPath = cfg.enabled ? (folder.wdPath || buildPath(folder, notes.items)) : null;
  folder.title  = title;
  if (cfg.enabled && oldPath) {
    try {
      // Compute new path from the new title, ignoring the stale stored wdPath.
      const savedWdPath = folder.wdPath;
      delete folder.wdPath;
      const newPath = buildPath(folder, notes.items);
      folder.wdPath = savedWdPath;

      if (newPath && newPath !== oldPath) {
        await wdMove(cfg, oldPath, newPath);
        folder.wdPath = newPath;
        _updateChildWdPaths(folder.children || [], oldPath, newPath);
      }
    } catch (err) {
      console.warn('WebDAV write failed, saving to CouchDB cache:', err.message);
    }
  }
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// DELETE /:board/notes/folders/:id  — delete folder recursively
router.delete('/:board/notes/folders/:id', writeRateLimit, withBoard(async (req, res, db) => {
  const { id, board } = req.params;
  const notes  = await _loadNotes(db);
  const folder = _findItem(id, notes.items);
  if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });

  const cfg = await getWebdavConfig(req.params.board);
  if (cfg.enabled) {
    const boardAttachDir = ATTACHMENTS_DIR ? path.join(ATTACHMENTS_DIR, board) : null;
    try {
      await deleteFolderWithAttachments(cfg, folder, notes.items, boardAttachDir);
    } catch (err) {
      console.error('WebDAV delete folder failed:', err.message);
      return res.status(500).json({ error: `Could not delete folder on WebDAV server: ${err.message}` });
    }
  }
  _removeItem(id, notes.items);
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// POST /:board/notes/folders/:id/move  — move folder to different parent (or root)
router.post('/:board/notes/folders/:id/move', writeRateLimit, withBoard(async (req, res, db) => {
  const { id }      = req.params;
  const { parentId, targetId, position } = req.body;
  const notes  = await _loadNotes(db);
  const folder = _findItem(id, notes.items);
  if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });

  const cfg     = await getWebdavConfig(req.params.board);
  const oldPath = cfg.enabled ? (folder.wdPath || buildPath(folder, notes.items)) : null;
  _removeItem(id, notes.items);
  _insertItem(folder, parentId || null, notes.items, targetId || null, position || null);
  if (cfg.enabled && oldPath) {
    try {
      const savedWdPath = folder.wdPath;
      delete folder.wdPath;
      const newPath = buildPath(folder, notes.items);
      folder.wdPath = savedWdPath;

      if (newPath && newPath !== oldPath) {
        await wdMove(cfg, oldPath, newPath);
        folder.wdPath = newPath;
        _updateChildWdPaths(folder.children || [], oldPath, newPath);
      }
    } catch (err) {
      console.warn('WebDAV write failed, saving to CouchDB cache:', err.message);
    }
  }
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// POST /:board/notes/folders/:id/sync  — sync one folder's children from WebDAV
router.post('/:board/notes/folders/:id/sync', withBoard(async (req, res, db) => {
  const { id } = req.params;
  const cfg = await getWebdavConfig(req.params.board);
  const notes = await _loadNotes(db);
  if (!cfg.enabled) return res.json({ ok: true, changed: false, notes });
  try {
    const { tree, changed } = await syncFolderChildrenFromWebdav(cfg, notes, id);
    if (changed) await saveNotesData(db, tree);
    res.json({ ok: true, changed, notes: changed ? tree : notes });
  } catch (err) {
    console.error('WebDAV folder sync error:', err.message);
    res.status(502).json({ error: `WebDAV folder sync failed: ${err.message}` });
  }
}));

// POST /:board/notes/sync  — sync tree from WebDAV → CouchDB
// Body: { folderIds?: string[] } — if provided, syncs root + those folders only;
// omitting folderIds triggers a full depth-infinity sync (backward compat).
router.post('/:board/notes/sync', withBoard(async (req, res, db) => {
  const cfg = await getWebdavConfig(req.params.board);
  if (!cfg.enabled) return res.json({ ok: true, changed: false, notes: await _loadNotes(db) });
  const notes = await _loadNotes(db);
  const { folderIds } = req.body || {};
  try {
    let tree = notes, changed = false;
    if (Array.isArray(folderIds)) {
      // Lazy sync: root + specified open folders
      let r = await syncRootFromWebdav(cfg, tree);
      tree = r.tree; changed = r.changed;
      for (const folderId of folderIds) {
        r = await syncFolderChildrenFromWebdav(cfg, tree, folderId);
        tree = r.tree; if (r.changed) changed = true;
      }
    } else {
      // Full sync
      const r = await syncFromWebdav(cfg, tree);
      tree = r.tree; changed = r.changed;
    }
    if (changed) await saveNotesData(db, tree);
    res.json({ ok: true, changed, notes: changed ? tree : notes });
  } catch (err) {
    console.error('WebDAV sync error:', err.message);
    res.status(502).json({ error: `WebDAV sync failed: ${err.message}` });
  }
}));

module.exports = router;
module.exports.getWebdavConfig = getWebdavConfig;
