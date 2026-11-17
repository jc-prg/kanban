'use strict';

const express  = require('express');
const archiver = require('archiver');
const fs       = require('fs');
const path     = require('path');

const { validateNotes, validateNotesPatch, schemaError } = require('./schemas');
const { getAttachmentPrefix, renderMd, _titleToSlug } = require('./webdav-core');
const { createWebdavHandlers } = require('./webdav-handlers');

const EMPTY_NOTES = { items: [], schemaVersion: 2 };

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

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
  const folderChildren = [];
  if (page.description?.trim()) folderChildren.push(pageItem);
  for (const child of page.children) folderChildren.push(..._migratePageToItems(child));
  return [{ type: 'folder', id: page.id, title: page.title, children: folderChildren }];
}

function migrateV1ToV2(data) {
  const items = [];
  for (const page of (data.pages || [])) items.push(..._migratePageToItems(page));
  return { items, schemaVersion: 2 };
}

function normalizeNotes(data) {
  if (!data) return { items: [], schemaVersion: 2 };
  if (data.schemaVersion === 2 && Array.isArray(data.items)) return data;
  if (Array.isArray(data.pages)) return migrateV1ToV2(data);
  return { items: [], schemaVersion: 2 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _getAttachmentFiles(attachmentsDir, board, pageId, prefix = '') {
  if (!attachmentsDir) return [];
  const dir = path.join(attachmentsDir, board, prefix, '_attachments');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(n => !n.startsWith('.') && n.startsWith(pageId + '_'))
      .map(n => n.slice(pageId.length + 1));
  } catch { return []; }
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
  targetArr.push(item);
  return true;
}

/** Resolve the link base: baseUrl may be a string or a (req) => string function. */
function _origin(req, baseUrl) {
  if (typeof baseUrl === 'function') return baseUrl(req);
  return baseUrl || `${req.protocol}://${req.get('host')}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Express router that handles all notes + WebDAV routes.
 *
 * @param {object} options
 * @param {object}   options.adapter          - StorageAdapter instance
 * @param {function} options.withBoard        - (handler) => Express handler; validates board name, creates if absent
 * @param {function} options.withExistingBoard - (handler) => Express handler; validates board name, 404 if absent
 * @param {function} [options.writeRateLimit] - Express middleware for write ops (default: no-op)
 * @param {function} [options.uploadRateLimit] - Express middleware for upload ops (default: no-op)
 * @param {string}   [options.attachmentsDir] - Absolute path to local attachments directory
 * @param {number}   [options.maxFileSize]    - Max upload size in bytes (default: 50 MB)
 * @param {function} [options.resolveCards]   - async (boardName) => Map<cardId, cardText>
 * @param {string|function} [options.baseUrl] - Base URL for links in WebDAV frontmatter,
 *   or (req) => string; links are "<baseUrl>/<board>#note:<id>"
 */
function createNotesRouter(options = {}) {
  const {
    adapter,
    withBoard,
    withExistingBoard,
    writeRateLimit  = (_req, _res, next) => next(),
    attachmentsDir  = null,
    resolveCards    = null,
    baseUrl         = null,
  } = options;

  const router = express.Router();
  // Boards with WebDAV: the files on the server are the truth, the notes document is their index
  const wd = createWebdavHandlers({ adapter, attachmentsDir, resolveCards, baseUrl });

  /** Calls the WebDAV handler when the board syncs with WebDAV, else the CouchDB one. */
  function byMode(wdHandler, dbHandler) {
    return async (req, res, db) => {
      const cfg = await adapter.resolveWebdavCfg(req.params.board);
      return cfg.enabled ? wdHandler(req, res, cfg) : dbHandler(req, res, db);
    };
  }
  // ---------------------------------------------------------------------------
  // WebDAV config routes
  // ---------------------------------------------------------------------------

  router.get('/:board/webdav-config', withExistingBoard(async (req, res, _db) => {
    try {
      const doc = await adapter.loadWebdavConfig(req.params.board);
      let accountLabel = '';
      if (doc.accountId) {
        const accounts = await adapter.loadWebdavAccounts();
        const account  = accounts.find(a => a.id === doc.accountId);
        accountLabel   = account ? (account.label || account.url || '') : '';
      }
      res.json({
        enabled:      doc.enabled      ?? false,
        accountId:    doc.accountId    || '',
        subfolder:    doc.subfolder    || '',
        accountLabel,
        ...(doc.url ? { url: doc.url, user: doc.user || '', hasPassword: !!doc.password } : {}),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }));

  router.post('/:board/webdav-config/test', writeRateLimit, withExistingBoard(async (req, res, _db) => {
    try {
      const accountId = req.body.accountId || '';
      const subfolder = typeof req.body.subfolder === 'string' ? req.body.subfolder.trim() : '';
      let url, user, password;

      if (accountId) {
        const accounts = await adapter.loadWebdavAccounts();
        const account  = accounts.find(a => a.id === accountId);
        if (!account) return res.json({ ok: false, error: 'Account not found' });
        const base = account.url.endsWith('/') ? account.url : account.url + '/';
        const sub  = subfolder.replace(/^\/|\/$/g, '');
        url      = sub ? base + sub + '/' : base;
        user     = account.user     || '';
        password = account.password || '';
      } else {
        const stored = await adapter.resolveWebdavCfg(req.params.board);
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

      if (r.status === 207)   return res.json({ ok: true,  message: `Connected — HTTP ${r.status} Multi-Status` });
      if (r.status === 401 || r.status === 403) return res.json({ ok: false, error: `Authentication failed (HTTP ${r.status})` });
      if (r.status === 405)   return res.json({ ok: false, error: `Server reachable but PROPFIND not allowed (HTTP 405) — not a WebDAV endpoint?` });
      return res.json({ ok: false, error: `Unexpected response: HTTP ${r.status}` });
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timed out (8 s)' : err.message;
      res.json({ ok: false, error: msg });
    }
  }));

  router.put('/:board/webdav-config', writeRateLimit, withBoard(async (req, res, _db) => {
    try {
      const { enabled, accountId, subfolder } = req.body;
      const existing = await adapter.loadWebdavConfig(req.params.board);
      const cfg = {
        enabled:   !!enabled,
        accountId: typeof accountId === 'string' ? accountId.trim() : (existing.accountId || ''),
        subfolder: typeof subfolder === 'string' ? subfolder.trim() : (existing.subfolder || ''),
      };
      await adapter.saveWebdavConfig(req.params.board, cfg);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }));

  // ---------------------------------------------------------------------------
  // Notes document (tree)
  // ---------------------------------------------------------------------------

  router.get('/:board/notes', withExistingBoard(byMode(wd.getNotes, async (req, res) => {
    const { data, rev } = await adapter.loadNotesWithRev(req.params.board);
    const etag = rev ? `"${rev}"` : null;
    if (etag) {
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('ETag', etag);
    }
    res.json(normalizeNotes(data));
  })));

  router.put('/:board/notes', writeRateLimit, withBoard(byMode(wd.ignoreBulkSave, async (req, res) => {
    const { board } = req.params;
    if (!validateNotes(req.body))
      return res.status(400).json({ error: 'Invalid notes data', details: schemaError(validateNotes) });
    const ifMatch = req.headers['if-match'];
    if (ifMatch) {
      const { rev } = await adapter.loadNotesWithRev(board);
      if (rev && ifMatch !== `"${rev}"`) return res.status(409).json({ error: 'conflict' });
    }
    const result = await adapter.saveNotes(board, req.body);
    res.setHeader('ETag', `"${result.rev}"`);
    res.json({ ok: true });
  })));

  router.patch('/:board/notes', writeRateLimit, withBoard(byMode(wd.ignoreBulkSave, async (req, res) => {
    const { board } = req.params;
    if (!validateNotesPatch(req.body))
      return res.status(400).json({ error: 'Invalid notes patch', details: schemaError(validateNotesPatch) });
    const { updatedPages = [] } = req.body;
    if (!updatedPages.length) return res.json({ ok: true });

    const { data: raw, rev: currentRev } = await adapter.loadNotesWithRev(board);
    const notes = normalizeNotes(raw);

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
    const result = await adapter.saveNotes(board, notes);
    res.setHeader('ETag', `"${result.rev}"`);
    res.json({ ok: true });
  })));

  /** Checks the server now (WebDAV boards); body { full: true } lists everything again. */
  router.post('/:board/notes/sync', withBoard(byMode(wd.sync, async (req, res) => {
    res.json({ ok: true, changed: false, notes: await _loadNotes(req.params.board) });
  })));

  /** One-time migration of a WebDAV board from the old DB tree; ?dry_run=0 runs it. */
  router.post('/:board/notes/migrate', writeRateLimit, withBoard(byMode(wd.migrate, async (req, res) => {
    res.status(400).json({ error: 'WebDAV not enabled for this board' });
  })));

  router.get('/:board/notes/export', withExistingBoard(async (req, res, _db) => {
    const { board } = req.params;
    const cfg       = await adapter.resolveWebdavCfg(board);
    if (cfg.enabled) {
      // The files as they are on the server (Markdown + attachments)
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', err => console.error('ZIP error:', err.message));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="notes-${board}.zip"`);
      archive.pipe(res);
      await wd.exportZip(req, res, cfg, archive);
      return archive.finalize();
    }
    const raw       = await adapter.loadNotes(board);
    const notes     = normalizeNotes(raw);
    const boardDir  = attachmentsDir ? path.join(attachmentsDir, board) : null;
    const origin    = _origin(req, baseUrl);

    // Resolve card map for linkedCards
    const cardMap = new Map();
    if (resolveCards) {
      try {
        const m = await resolveCards(board);
        for (const [k, v] of m) cardMap.set(k, v);
      } catch { /* ignore */ }
    }

    function resolveLinkedCards(linkedCards) {
      if (!linkedCards?.length) return [];
      return linkedCards.map(id => {
        const rawText = cardMap.get(id);
        if (!rawText) return id;
        const title = rawText.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
        return `[${title}](${origin}/${board}#card:${id})`;
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
          const localAttachDir = boardDir
            ? path.join(boardDir, getAttachmentPrefix(item, notes.items), '_attachments')
            : null;
          const storedFiles = localAttachDir && fs.existsSync(localAttachDir)
            ? fs.readdirSync(localAttachDir).filter(n => !n.startsWith('.') && n.startsWith(`${item.id}_`))
            : [];
          const attachmentFiles = storedFiles.map(n => n.slice(item.id.length + 1));
          const source    = `${origin}/${board}#note:${item.id}`;
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
  // Per-page routes
  // ---------------------------------------------------------------------------

  async function _loadNotes(board) {
    const data = await adapter.loadNotes(board);
    return normalizeNotes(data) || { ...EMPTY_NOTES };
  }

  router.get('/:board/notes/pages/:id/content', withExistingBoard(byMode(wd.getContent, async (req, res) => {
    res.status(400).json({ error: 'WebDAV not enabled' });
  })));

  router.post('/:board/notes/pages', writeRateLimit, withBoard(byMode(wd.createPage, async (req, res) => {
    const { board } = req.params;
    const { page, parentId } = req.body;
    if (!page?.id || !page?.title) return res.status(400).json({ error: 'page.id and page.title required' });
    const notes = await _loadNotes(board);
    if (_findItem(page.id, notes.items)) return res.status(409).json({ error: 'Page ID already exists' });
    _insertItem({ type: 'page', ...page }, parentId || null, notes.items);
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  })));

  router.patch('/:board/notes/pages/:id', writeRateLimit, withBoard(byMode(wd.updatePage, async (req, res) => {
    const { id, board } = req.params;
    const notes = await _loadNotes(board);
    const page  = _findItem(id, notes.items);
    if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });
    if (req.body.title       !== undefined) page.title       = req.body.title;
    if (req.body.description !== undefined) page.description = req.body.description;
    if (req.body.link        !== undefined) page.link        = req.body.link;
    if (req.body.linkedCards !== undefined) page.linkedCards = req.body.linkedCards;
    page.lastModified = new Date().toISOString();
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  })));

  router.delete('/:board/notes/pages/:id', writeRateLimit, withBoard(byMode(wd.deletePage, async (req, res) => {
    const { id, board } = req.params;
    const notes = await _loadNotes(board);
    const page  = _findItem(id, notes.items);
    if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });
    if (attachmentsDir) {
      const prefix = getAttachmentPrefix(page, notes.items);
      const aDir   = path.join(attachmentsDir, board, prefix, '_attachments');
      for (const f of _getAttachmentFiles(attachmentsDir, board, page.id, prefix)) {
        try { fs.unlinkSync(path.join(aDir, `${page.id}_${f}`)); } catch { /* ok */ }
      }
    }
    _removeItem(id, notes.items);
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  })));

  router.post('/:board/notes/pages/:id/move', writeRateLimit, withBoard(byMode(wd.movePage, async (req, res) => {
    const { id, board } = req.params;
    const { folderId, targetId, position } = req.body;
    const notes = await _loadNotes(board);
    const page  = _findItem(id, notes.items);
    if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

    const oldPrefix = getAttachmentPrefix(page, notes.items);
    _removeItem(id, notes.items);
    _insertItem(page, folderId || null, notes.items, targetId || null, position || null);
    const newPrefix = getAttachmentPrefix(page, notes.items);

    // Local attachment copies follow the page's folder
    if (attachmentsDir && oldPrefix !== newPrefix) {
      const attachFiles = _getAttachmentFiles(attachmentsDir, board, page.id, oldPrefix);
      if (attachFiles.length) {
        const oldDir = path.join(attachmentsDir, board, oldPrefix, '_attachments');
        const newDir = path.join(attachmentsDir, board, newPrefix, '_attachments');
        fs.mkdirSync(newDir, { recursive: true });
        for (const f of attachFiles)
          try { fs.renameSync(path.join(oldDir, `${page.id}_${f}`), path.join(newDir, `${page.id}_${f}`)); } catch { /* ok */ }
      }
    }
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  })));

  // ---------------------------------------------------------------------------
  // Per-folder routes
  // ---------------------------------------------------------------------------

  router.post('/:board/notes/folders', writeRateLimit, withBoard(byMode(wd.createFolder, async (req, res) => {
    const { board } = req.params;
    const { folder, parentId } = req.body;
    if (!folder?.id || !folder?.title) return res.status(400).json({ error: 'folder.id and folder.title required' });
    const notes = await _loadNotes(board);
    if (_findItem(folder.id, notes.items)) return res.status(409).json({ error: 'Folder ID already exists' });
    _insertItem({ type: 'folder', ...folder, children: folder.children || [] }, parentId || null, notes.items);
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev, id: folder.id });
  })));

  router.patch('/:board/notes/folders/:id', writeRateLimit, withBoard(byMode(wd.renameFolder, async (req, res) => {
    const { id, board } = req.params;
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const notes  = await _loadNotes(board);
    const folder = _findItem(id, notes.items);
    if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });
    folder.title = title;
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  })));

  router.delete('/:board/notes/folders/:id', writeRateLimit, withBoard(byMode(wd.deleteFolder, async (req, res) => {
    const { id, board } = req.params;
    const notes  = await _loadNotes(board);
    const folder = _findItem(id, notes.items);
    if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });
    _removeItem(id, notes.items);
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  })));

  router.post('/:board/notes/folders/:id/move', writeRateLimit, withBoard(byMode(wd.moveFolder, async (req, res) => {
    const { id, board } = req.params;
    const { parentId, targetId, position } = req.body;
    const notes  = await _loadNotes(board);
    const folder = _findItem(id, notes.items);
    if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });
    _removeItem(id, notes.items);
    _insertItem(folder, parentId || null, notes.items, targetId || null, position || null);
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  })));

  // ---------------------------------------------------------------------------
  // Attachments of WebDAV boards (files in <folder>/_attachments/ on the server).
  // Other boards fall through to the host app's local attachment routes.
  // ---------------------------------------------------------------------------

  function webdavOnly(handler) {
    return async (req, res, next) => {
      try {
        const cfg = await adapter.resolveWebdavCfg(req.params.board);
        if (!cfg.enabled) return next();
        await handler(req, res, cfg);
      } catch (err) { next(err); }
    };
  }

  router.get('/:board/notes/attachments/:pageId', webdavOnly(wd.listAttachments));
  router.post('/:board/notes/attachments/:pageId', writeRateLimit, webdavOnly(wd.uploadAttachment));
  router.get('/:board/notes/attachments/:pageId/:filename', webdavOnly(wd.downloadAttachment));
  router.delete('/:board/notes/attachments/:pageId/:filename', writeRateLimit, webdavOnly(wd.deleteAttachment));

  return router;
}

module.exports = createNotesRouter;
