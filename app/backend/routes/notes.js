const express  = require('express');
const router   = express.Router();
const archiver = require('archiver');
const fs       = require('fs');
const path     = require('path');
const { writeRateLimit }                                            = require('../auth');
const { withBoard, withExistingBoard, loadNotesData, saveNotesData } = require('../db');
const { validateNotes, validateNotesPatch, schemaError }            = require('../schemas');
const { NOTES_DOC_ID, ATTACHMENTS_DIR }                             = require('../config');

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

module.exports = router;
