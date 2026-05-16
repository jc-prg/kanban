const express  = require('express');
const router   = express.Router();
const archiver = require('archiver');
const fs       = require('fs');
const path     = require('path');
const { writeRateLimit }                                            = require('../auth');
const { withBoard, withExistingBoard, loadNotesData, saveNotesData } = require('../db');
const { validateNotes, validateNotesPatch, schemaError }            = require('../schemas');
const { NOTES_DOC_ID, ATTACHMENTS_DIR }                             = require('../config');
const { getWebdavConfig } = require('./prompts');
const {
  wdGet, wdPut, wdDelete, wdMove, wdMkcol, wdGetMeta,
  buildPath, parseFm, renderMd, syncFromWebdav,
  deletePageWithAttachments, deleteFolderWithAttachments,
} = require('../webdav-notes');

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
// Routes
// ---------------------------------------------------------------------------

router.get('/:board/notes', withExistingBoard(async (req, res, db) => {
  try {
    const { _id, _rev, ...raw } = await db.get(NOTES_DOC_ID);
    const data  = normalizeNotes(raw);
    const etag  = `"${_rev}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.json(data);
  } catch (err) {
    if (err.statusCode === 404) return res.json({ items: [], schemaVersion: 2 });
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
  const boardDir = path.join(ATTACHMENTS_DIR, board);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => console.error('ZIP error:', err.message));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="notes-${board}.zip"`);
  archive.pipe(res);

  function addItems(items, prefix) {
    for (const item of items) {
      const safeName = (item.title || 'Untitled').replace(/[/\\<>:|*?"]/g, '_').trim();
      if (item.type === 'folder') {
        addItems(item.children || [], prefix + safeName + '/');
      } else {
        const dir = prefix + safeName + '/';
        const md  = (item.description || '').replace(/\(attachment:([^)\s]+)\)/g, '(./attachments/$1)');
        archive.append(md, { name: dir + 'page.md' });
        const aDir = path.join(boardDir, item.id);
        if (fs.existsSync(aDir))
          fs.readdirSync(aDir).filter(n => !n.startsWith('.')).forEach(f => {
            const entryName = dir + 'attachments/' + path.basename(f);
            if (!entryName.includes('..')) archive.file(path.join(aDir, f), { name: entryName });
          });
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

function _insertItem(item, parentId, items) {
  if (!parentId) { items.push(item); return true; }
  const parent = _findItem(parentId, items);
  if (parent && parent.type === 'folder') {
    if (!parent.children) parent.children = [];
    parent.children.push(item);
    return true;
  }
  items.push(item); // fallback to root
  return true;
}

// ---------------------------------------------------------------------------
// Per-operation routes
// ---------------------------------------------------------------------------

// GET /:board/notes/pages/:id/content  — fetch page body fresh from WebDAV
router.get('/:board/notes/pages/:id/content', withExistingBoard(async (req, res, db) => {
  const cfg = await getWebdavConfig();
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
  const cfg = await getWebdavConfig();
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

// POST /:board/notes/pages  — create page (+ WebDAV PUT)
router.post('/:board/notes/pages', writeRateLimit, withBoard(async (req, res, db) => {
  const { page, parentId } = req.body;
  if (!page?.id || !page?.title) return res.status(400).json({ error: 'page.id and page.title required' });
  const notes = await _loadNotes(db);
  if (_findItem(page.id, notes.items)) return res.status(409).json({ error: 'Page ID already exists' });
  _insertItem({ type: 'page', ...page }, parentId || null, notes.items);
  const cfg = await getWebdavConfig();
  if (cfg.enabled) {
    const inserted = _findItem(page.id, notes.items);
    const pagePath = buildPath(inserted, notes.items);
    if (pagePath) {
      const dir = pagePath.includes('/') ? pagePath.substring(0, pagePath.lastIndexOf('/') + 1) : '';
      if (dir) await wdMkcol(cfg, dir).catch(() => {});
      await wdPut(cfg, pagePath, renderMd(inserted));
    }
  }
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// PATCH /:board/notes/pages/:id  — update page fields (title, content, link, linkedCards)
router.patch('/:board/notes/pages/:id', writeRateLimit, withBoard(async (req, res, db) => {
  const { id } = req.params;
  const notes  = await _loadNotes(db);
  const page   = _findItem(id, notes.items);
  if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

  const cfg        = await getWebdavConfig();
  const oldPath    = cfg.enabled ? buildPath(page, notes.items) : null;
  const titleChanged = req.body.title !== undefined && req.body.title !== page.title;

  if (req.body.title       !== undefined) page.title       = req.body.title;
  if (req.body.description !== undefined) page.description = req.body.description;
  if (req.body.link        !== undefined) page.link        = req.body.link;
  if (req.body.linkedCards !== undefined) page.linkedCards = req.body.linkedCards;
  page.lastModified = new Date().toISOString();

  if (cfg.enabled && oldPath) {
    const newPath = buildPath(page, notes.items);
    if (titleChanged && newPath && newPath !== oldPath) {
      await wdMove(cfg, oldPath, newPath);
    } else if (newPath) {
      await wdPut(cfg, newPath, renderMd(page));
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

  const cfg = await getWebdavConfig();
  if (cfg.enabled) {
    const boardAttachDir = ATTACHMENTS_DIR ? path.join(ATTACHMENTS_DIR, board) : null;
    await deletePageWithAttachments(cfg, page, notes.items, boardAttachDir).catch(err => {
      console.error('WebDAV delete page failed:', err.message);
    });
  } else {
    // CouchDB-only: delete local attachments
    if (ATTACHMENTS_DIR) {
      const localDir = path.join(ATTACHMENTS_DIR, board, id);
      try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }
  _removeItem(id, notes.items);
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// POST /:board/notes/pages/:id/move  — move page to different folder (or root)
router.post('/:board/notes/pages/:id/move', writeRateLimit, withBoard(async (req, res, db) => {
  const { id } = req.params;
  const { folderId } = req.body; // null/undefined = move to root
  const notes = await _loadNotes(db);
  const page  = _findItem(id, notes.items);
  if (!page || page.type !== 'page') return res.status(404).json({ error: 'Page not found' });

  const cfg     = await getWebdavConfig();
  const oldPath = cfg.enabled ? buildPath(page, notes.items) : null;

  _removeItem(id, notes.items);
  _insertItem(page, folderId || null, notes.items);

  if (cfg.enabled && oldPath) {
    const newPath = buildPath(page, notes.items);
    if (newPath && newPath !== oldPath) {
      const dir = newPath.includes('/') ? newPath.substring(0, newPath.lastIndexOf('/') + 1) : '';
      if (dir) await wdMkcol(cfg, dir).catch(() => {});
      await wdMove(cfg, oldPath, newPath);
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
  const cfg = await getWebdavConfig();
  if (cfg.enabled) {
    const inserted   = _findItem(folder.id, notes.items);
    const folderPath = buildPath(inserted, notes.items);
    if (folderPath) await wdMkcol(cfg, folderPath).catch(() => {});
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

  const cfg     = await getWebdavConfig();
  const oldPath = cfg.enabled ? buildPath(folder, notes.items) : null;
  folder.title  = title;
  if (cfg.enabled && oldPath) {
    const newPath = buildPath(folder, notes.items);
    if (newPath && newPath !== oldPath) await wdMove(cfg, oldPath, newPath);
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

  const cfg = await getWebdavConfig();
  if (cfg.enabled) {
    const boardAttachDir = ATTACHMENTS_DIR ? path.join(ATTACHMENTS_DIR, board) : null;
    await deleteFolderWithAttachments(cfg, folder, notes.items, boardAttachDir).catch(err => {
      console.error('WebDAV delete folder failed:', err.message);
    });
  }
  _removeItem(id, notes.items);
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// POST /:board/notes/folders/:id/move  — move folder to different parent (or root)
router.post('/:board/notes/folders/:id/move', writeRateLimit, withBoard(async (req, res, db) => {
  const { id }      = req.params;
  const { parentId } = req.body;
  const notes  = await _loadNotes(db);
  const folder = _findItem(id, notes.items);
  if (!folder || folder.type !== 'folder') return res.status(404).json({ error: 'Folder not found' });

  const cfg     = await getWebdavConfig();
  const oldPath = cfg.enabled ? buildPath(folder, notes.items) : null;
  _removeItem(id, notes.items);
  _insertItem(folder, parentId || null, notes.items);
  if (cfg.enabled && oldPath) {
    const newPath = buildPath(folder, notes.items);
    if (newPath && newPath !== oldPath) await wdMove(cfg, oldPath, newPath);
  }
  const result = await saveNotesData(db, notes);
  res.json({ ok: true, notes, rev: result.rev });
}));

// POST /:board/notes/sync  — sync tree from WebDAV → CouchDB
router.post('/:board/notes/sync', withBoard(async (req, res, db) => {
  const cfg = await getWebdavConfig();
  if (!cfg.enabled) return res.json({ ok: true, changed: false, notes: await _loadNotes(db) });
  const notes = await _loadNotes(db);
  try {
    const { tree, changed } = await syncFromWebdav(cfg, notes);
    if (changed) await saveNotesData(db, tree);
    res.json({ ok: true, changed, notes: changed ? tree : notes });
  } catch (err) {
    console.error('WebDAV sync error:', err.message);
    res.status(502).json({ error: `WebDAV sync failed: ${err.message}` });
  }
}));

module.exports = router;
