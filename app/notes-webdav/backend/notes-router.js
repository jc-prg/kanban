'use strict';

const express  = require('express');
const archiver = require('archiver');
const fs       = require('fs');
const path     = require('path');

const { validateNotes, validateNotesPatch, schemaError } = require('./schemas');
const {
  wdGet, wdPut, wdMove, wdMkcol, wdGetMeta,
  buildPath, getAttachmentPrefix, parseFm, renderMd,
  syncFromWebdav, syncRootFromWebdav, syncFolderChildrenFromWebdav,
  deletePageWithAttachments, deleteFolderWithAttachments,
  _titleToSlug, _updateChildWdPaths,
} = require('./webdav-core');

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
  targetArr.push(item);
  return true;
}

function _sourceUrl(req, baseUrl, board, pageId) {
  const origin = baseUrl || `${req.protocol}://${req.get('host')}`;
  return `${origin}/${board}#note:${pageId}`;
}

/** Resolve card IDs to formatted link strings for WebDAV frontmatter.
 *  Uses resolveCards(boardName) → Map<id, text> from options. */
async function _buildLinkedCardEntries(linkedCards, boardName, req, resolveCards, baseUrl) {
  if (!linkedCards?.length) return [];
  if (!resolveCards) return linkedCards;
  try {
    const cardMap = await resolveCards(boardName);
    const origin  = baseUrl || `${req.protocol}://${req.get('host')}`;
    return linkedCards.map(id => {
      const rawText = cardMap.get(id);
      if (!rawText) return id;
      const title = rawText.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
      return `[${title}](${origin}/${boardName}#card:${id})`;
    });
  } catch { return linkedCards; }
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
 * @param {string}   [options.baseUrl]        - Base URL for links in WebDAV frontmatter
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
  // Notes CRUD routes
  // ---------------------------------------------------------------------------

  router.get('/:board/notes', withExistingBoard(async (req, res, _db) => {
    const { board } = req.params;
    try {
      const { data: raw, rev: loadedRev } = await adapter.loadNotesWithRev(board);
      let data = normalizeNotes(raw);
      let _rev = loadedRev;

      const cfg = await adapter.resolveWebdavCfg(board);
      if (cfg.enabled) {
        try {
          const { tree, changed } = await syncRootFromWebdav(cfg, data);
          if (changed) {
            const result = await adapter.saveNotes(board, tree);
            _rev = result.rev;
            data = tree;
          }
        } catch (wdErr) {
          console.warn('WebDAV sync failed, serving from CouchDB cache:', wdErr.message);
        }
      }

      const etag = _rev ? `"${_rev}"` : null;
      if (etag) {
        if (req.headers['if-none-match'] === etag) return res.status(304).end();
        res.setHeader('ETag', etag);
      }
      res.json(data);
    } catch (err) { throw err; }
  }));

  router.put('/:board/notes', writeRateLimit, withBoard(async (req, res, _db) => {
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
  }));

  router.patch('/:board/notes', writeRateLimit, withBoard(async (req, res, _db) => {
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
  }));

  router.get('/:board/notes/export', withExistingBoard(async (req, res, _db) => {
    const { board } = req.params;
    const raw       = await adapter.loadNotes(board);
    const notes     = normalizeNotes(raw);
    const boardDir  = attachmentsDir ? path.join(attachmentsDir, board) : null;
    const origin    = baseUrl || `${req.protocol}://${req.get('host')}`;

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

  router.get('/:board/notes/pages/:id/content', withExistingBoard(async (req, res, _db) => {
    const { board, id } = req.params;
    const cfg = await adapter.resolveWebdavCfg(board);
    if (!cfg.enabled) return res.status(400).json({ error: 'WebDAV not enabled' });
    const notes    = await _loadNotes(board);
    const page     = _findItem(id, notes.items);
    if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });
    const pagePath = buildPath(page, notes.items);
    if (!pagePath) return res.status(404).json({ error: 'Cannot determine page path' });
    try {
      const text = await wdGet(cfg, pagePath);
      const { meta, body } = parseFm(text);
      res.json({ content: body, lastModified: meta.lastModified || null });
    } catch (err) {
      if (err.status === 404) return res.json({ content: page.description || '', lastModified: page.lastModified || null });
      res.status(502).json({ error: `WebDAV error: ${err.message}` });
    }
  }));

  router.get('/:board/notes/pages/:id/meta', withExistingBoard(async (req, res, _db) => {
    const { board, id } = req.params;
    const cfg = await adapter.resolveWebdavCfg(board);
    if (!cfg.enabled) return res.status(400).json({ error: 'WebDAV not enabled' });
    const notes    = await _loadNotes(board);
    const page     = _findItem(id, notes.items);
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

  router.post('/:board/notes/pages', writeRateLimit, withBoard(async (req, res, _db) => {
    const { board } = req.params;
    const { page, parentId } = req.body;
    if (!page?.id || !page?.title) return res.status(400).json({ error: 'page.id and page.title required' });
    const notes = await _loadNotes(board);
    if (_findItem(page.id, notes.items)) return res.status(409).json({ error: 'Page ID already exists' });
    _insertItem({ type: 'page', ...page }, parentId || null, notes.items);
    const cfg = await adapter.resolveWebdavCfg(board);
    if (cfg.enabled) {
      const inserted = _findItem(page.id, notes.items);
      const basePath = buildPath(inserted, notes.items);
      if (basePath) {
        const occupied = _collectWdPaths(notes.items);
        occupied.delete(inserted.wdPath);
        const pagePath = _uniqueWdPath(basePath, occupied);
        inserted.wdPath = pagePath;
        try {
          const dir = pagePath.includes('/') ? pagePath.substring(0, pagePath.lastIndexOf('/') + 1) : '';
          if (dir) await wdMkcol(cfg, dir).catch(() => {});
          const lcEntries = await _buildLinkedCardEntries(inserted.linkedCards, board, req, resolveCards, baseUrl);
          await wdPut(cfg, pagePath, renderMd(inserted, _getAttachmentFiles(attachmentsDir, board, inserted.id, getAttachmentPrefix(inserted, notes.items)), _sourceUrl(req, baseUrl, board, inserted.id), lcEntries));
        } catch (err) {
          console.warn('WebDAV write failed, saving to CouchDB cache:', err.message);
        }
      }
    }
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  }));

  router.patch('/:board/notes/pages/:id', writeRateLimit, withBoard(async (req, res, _db) => {
    const { id, board } = req.params;
    const notes  = await _loadNotes(board);
    const page   = _findItem(id, notes.items);
    if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

    const cfg          = await adapter.resolveWebdavCfg(board);
    const oldPath      = cfg.enabled ? (page.wdPath || buildPath(page, notes.items)) : null;
    const titleChanged = req.body.title !== undefined && req.body.title !== page.title;

    if (req.body.title       !== undefined) page.title       = req.body.title;
    if (req.body.description !== undefined) page.description = req.body.description;
    if (req.body.link        !== undefined) page.link        = req.body.link;
    if (req.body.linkedCards !== undefined) page.linkedCards = req.body.linkedCards;
    page.lastModified = new Date().toISOString();

    if (cfg.enabled && oldPath) {
      try {
        const savedWdPath = page.wdPath;
        delete page.wdPath;
        const newPath = buildPath(page, notes.items);
        page.wdPath   = savedWdPath;

        const attachFiles = _getAttachmentFiles(attachmentsDir, board, page.id, getAttachmentPrefix(page, notes.items));
        const source      = _sourceUrl(req, baseUrl, board, page.id);
        const lcEntries   = await _buildLinkedCardEntries(page.linkedCards, board, req, resolveCards, baseUrl);
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
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  }));

  router.delete('/:board/notes/pages/:id', writeRateLimit, withBoard(async (req, res, _db) => {
    const { id, board } = req.params;
    const notes = await _loadNotes(board);
    const page  = _findItem(id, notes.items);
    if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

    const cfg = await adapter.resolveWebdavCfg(board);
    if (cfg.enabled) {
      const boardAttachDir = attachmentsDir ? path.join(attachmentsDir, board) : null;
      try {
        await deletePageWithAttachments(cfg, page, notes.items, boardAttachDir);
      } catch (err) {
        console.error('WebDAV delete page failed:', err.message);
        return res.status(500).json({ error: `Could not delete page on WebDAV server: ${err.message}` });
      }
    } else {
      if (attachmentsDir) {
        const prefix = getAttachmentPrefix(page, notes.items);
        const aDir   = path.join(attachmentsDir, board, prefix, '_attachments');
        for (const f of _getAttachmentFiles(attachmentsDir, board, page.id, prefix)) {
          try { fs.unlinkSync(path.join(aDir, `${page.id}_${f}`)); } catch { /* ok */ }
        }
      }
    }
    _removeItem(id, notes.items);
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  }));

  router.post('/:board/notes/pages/:id/move', writeRateLimit, withBoard(async (req, res, _db) => {
    const { id, board } = req.params;
    const { folderId, targetId, position } = req.body;
    const notes = await _loadNotes(board);
    const page  = _findItem(id, notes.items);
    if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

    const cfg       = await adapter.resolveWebdavCfg(board);
    const oldPath   = page.wdPath || buildPath(page, notes.items);
    const oldPrefix = getAttachmentPrefix(page, notes.items);

    _removeItem(id, notes.items);
    _insertItem(page, folderId || null, notes.items, targetId || null, position || null);

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

        if (oldPrefix !== newPrefix) {
          const attachFiles = _getAttachmentFiles(attachmentsDir, board, page.id, oldPrefix);
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

    if (attachmentsDir && pathChanged && oldPrefix !== newPrefix) {
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
  }));

  // ---------------------------------------------------------------------------
  // Per-folder routes
  // ---------------------------------------------------------------------------

  router.post('/:board/notes/folders', writeRateLimit, withBoard(async (req, res, _db) => {
    const { board } = req.params;
    const { folder, parentId } = req.body;
    if (!folder?.id || !folder?.title) return res.status(400).json({ error: 'folder.id and folder.title required' });
    const notes = await _loadNotes(board);
    if (_findItem(folder.id, notes.items)) return res.status(409).json({ error: 'Folder ID already exists' });
    _insertItem({ type: 'folder', ...folder, children: folder.children || [] }, parentId || null, notes.items);
    const cfg = await adapter.resolveWebdavCfg(board);
    if (cfg.enabled) {
      const inserted   = _findItem(folder.id, notes.items);
      const folderPath = buildPath(inserted, notes.items);
      if (folderPath) {
        inserted.wdPath = folderPath;
        await wdMkcol(cfg, folderPath).catch(() => {});
      }
    }
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  }));

  router.patch('/:board/notes/folders/:id', writeRateLimit, withBoard(async (req, res, _db) => {
    const { id, board } = req.params;
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const notes  = await _loadNotes(board);
    const folder = _findItem(id, notes.items);
    if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });

    const cfg     = await adapter.resolveWebdavCfg(board);
    const oldPath = cfg.enabled ? (folder.wdPath || buildPath(folder, notes.items)) : null;
    folder.title  = title;
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
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  }));

  router.delete('/:board/notes/folders/:id', writeRateLimit, withBoard(async (req, res, _db) => {
    const { id, board } = req.params;
    const notes  = await _loadNotes(board);
    const folder = _findItem(id, notes.items);
    if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });

    const cfg = await adapter.resolveWebdavCfg(board);
    if (cfg.enabled) {
      const boardAttachDir = attachmentsDir ? path.join(attachmentsDir, board) : null;
      try {
        await deleteFolderWithAttachments(cfg, folder, notes.items, boardAttachDir);
      } catch (err) {
        console.error('WebDAV delete folder failed:', err.message);
        return res.status(500).json({ error: `Could not delete folder on WebDAV server: ${err.message}` });
      }
    }
    _removeItem(id, notes.items);
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  }));

  router.post('/:board/notes/folders/:id/move', writeRateLimit, withBoard(async (req, res, _db) => {
    const { id, board } = req.params;
    const { parentId, targetId, position } = req.body;
    const notes  = await _loadNotes(board);
    const folder = _findItem(id, notes.items);
    if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });

    const cfg     = await adapter.resolveWebdavCfg(board);
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
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  }));

  // ---------------------------------------------------------------------------
  // Orphan repair route
  // ---------------------------------------------------------------------------

  router.post('/:board/notes/repair-orphan', writeRateLimit, withBoard(async (req, res, _db) => {
    const { board } = req.params;
    const { itemId, action } = req.body;
    if (!itemId || !['upload', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'itemId and action (upload|delete) required' });
    }
    const notes = await _loadNotes(board);
    const item  = _findItem(itemId, notes.items);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    if (action === 'delete') {
      // Remove from DB only — no WebDAV touch since item is orphaned (not present there).
      // Clean up any local attachments for pages.
      function _cleanLocalAttach(it) {
        if (it.type === 'page' && attachmentsDir) {
          const prefix = getAttachmentPrefix(it, notes.items);
          const aDir   = path.join(attachmentsDir, board, prefix, '_attachments');
          for (const f of _getAttachmentFiles(attachmentsDir, board, it.id, prefix)) {
            try { fs.unlinkSync(path.join(aDir, `${it.id}_${f}`)); } catch { /* ok */ }
          }
        }
        if (it.type === 'folder') for (const child of it.children || []) _cleanLocalAttach(child);
      }
      _cleanLocalAttach(item);
      _removeItem(itemId, notes.items);
      const result = await adapter.saveNotes(board, notes);
      return res.json({ ok: true, notes, rev: result.rev });
    }

    // action === 'upload': (re-)create item on WebDAV.
    const cfg = await adapter.resolveWebdavCfg(board);
    if (!cfg.enabled) return res.status(400).json({ error: 'WebDAV not enabled' });

    async function _uploadItem(it) {
      delete it.wdPath;
      delete it.orphaned;
      const itPath = buildPath(it, notes.items);
      if (!itPath) return;
      if (it.type === 'folder') {
        await wdMkcol(cfg, itPath).catch(() => {});
        it.wdPath = itPath;
        for (const child of (it.children || [])) await _uploadItem(child);
      } else {
        const dir = itPath.includes('/') ? itPath.substring(0, itPath.lastIndexOf('/') + 1) : '';
        if (dir) await wdMkcol(cfg, dir).catch(() => {});
        const attachFiles = _getAttachmentFiles(attachmentsDir, board, it.id, getAttachmentPrefix(it, notes.items));
        const source      = _sourceUrl(req, baseUrl, board, it.id);
        const lcEntries   = await _buildLinkedCardEntries(it.linkedCards, board, req, resolveCards, baseUrl);
        await wdPut(cfg, itPath, renderMd(it, attachFiles, source, lcEntries));
        it.wdPath = itPath;
        it.lastModified = new Date().toISOString();
      }
    }

    try {
      await _uploadItem(item);
    } catch (err) {
      return res.status(502).json({ error: `WebDAV upload failed: ${err.message}` });
    }
    const result = await adapter.saveNotes(board, notes);
    res.json({ ok: true, notes, rev: result.rev });
  }));

  // ---------------------------------------------------------------------------
  // Sync routes
  // ---------------------------------------------------------------------------

  router.post('/:board/notes/folders/:id/sync', withBoard(async (req, res, _db) => {
    const { id, board } = req.params;
    const cfg   = await adapter.resolveWebdavCfg(board);
    const notes = await _loadNotes(board);
    if (!cfg.enabled) return res.json({ ok: true, changed: false, notes });
    try {
      const { tree, changed } = await syncFolderChildrenFromWebdav(cfg, notes, id);
      if (changed) await adapter.saveNotes(board, tree);
      res.json({ ok: true, changed, notes: changed ? tree : notes });
    } catch (err) {
      console.error('WebDAV folder sync error:', err.message);
      res.status(502).json({ error: `WebDAV folder sync failed: ${err.message}` });
    }
  }));

  router.post('/:board/notes/sync', withBoard(async (req, res, _db) => {
    const { board } = req.params;
    const cfg   = await adapter.resolveWebdavCfg(board);
    const notes = await _loadNotes(board);
    if (!cfg.enabled) return res.json({ ok: true, changed: false, notes });
    const { folderIds } = req.body || {};
    try {
      let tree = notes, changed = false;
      if (Array.isArray(folderIds)) {
        let r = await syncRootFromWebdav(cfg, tree);
        tree = r.tree; changed = r.changed;
        for (const folderId of folderIds) {
          r = await syncFolderChildrenFromWebdav(cfg, tree, folderId);
          tree = r.tree; if (r.changed) changed = true;
        }
      } else {
        const r = await syncFromWebdav(cfg, tree);
        tree = r.tree; changed = r.changed;
      }
      if (changed) await adapter.saveNotes(board, tree);
      res.json({ ok: true, changed, notes: changed ? tree : notes });
    } catch (err) {
      console.error('WebDAV sync error:', err.message);
      res.status(502).json({ error: `WebDAV sync failed: ${err.message}` });
    }
  }));

  return router;
}

module.exports = createNotesRouter;
