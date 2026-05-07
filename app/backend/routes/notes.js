const express  = require('express');
const router   = express.Router();
const archiver = require('archiver');
const fs       = require('fs');
const path     = require('path');
const { writeRateLimit }                                            = require('../auth');
const { withBoard, withExistingBoard, loadNotesData, saveNotesData } = require('../db');
const { validateNotes, validateNotesPatch, schemaError }            = require('../schemas');
const { NOTES_DOC_ID, ATTACHMENTS_DIR }                             = require('../config');

router.get('/:board/notes', withExistingBoard(async (req, res, db) => {
  try {
    const { _id, _rev, ...data } = await db.get(NOTES_DOC_ID);
    const etag = `"${_rev}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.json(data);
  } catch (err) {
    if (err.statusCode === 404) return res.json({ pages: [] });
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
    const { _id, _rev, ...data } = await db.get(NOTES_DOC_ID);
    currentRev = _rev;
    notes = data;
  } catch (err) {
    if (err.statusCode === 404) { notes = { pages: [] }; }
    else throw err;
  }
  const ifMatch = req.headers['if-match'];
  if (ifMatch && currentRev && ifMatch !== `"${currentRev}"`) return res.status(409).json({ error: 'conflict' });
  function upsertPage(pages, patch) {
    for (const p of pages) {
      if (p.id === patch.id) { Object.assign(p, patch); return true; }
      if (p.children?.length && upsertPage(p.children, patch)) return true;
    }
    return false;
  }
  for (const page of updatedPages) upsertPage(notes.pages, page);
  const result = await saveNotesData(db, notes);
  res.setHeader('ETag', `"${result.rev}"`);
  res.json({ ok: true });
}));

router.get('/:board/notes/export', withExistingBoard(async (req, res, db) => {
  const { board } = req.params;
  const notes    = await loadNotesData(db);
  const boardDir = path.join(ATTACHMENTS_DIR, board);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => console.error('ZIP error:', err.message));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="notes-${board}.zip"`);
  archive.pipe(res);

  function addPages(pages, prefix) {
    for (const p of pages) {
      const dir = prefix + (p.title || 'Untitled').replace(/[/\\<>:|*?"]/g, '_').trim() + '/';
      const md  = (p.description || '').replace(/\(attachment:([^)\s]+)\)/g, '(./attachments/$1)');
      archive.append(md, { name: dir + 'page.md' });
      const aDir = path.join(boardDir, p.id);
      if (fs.existsSync(aDir))
        fs.readdirSync(aDir).filter(n => !n.startsWith('.')).forEach(f => {
          const entryName = dir + 'attachments/' + path.basename(f);
          if (!entryName.includes('..')) archive.file(path.join(aDir, f), { name: entryName });
        });
      if (p.children?.length) addPages(p.children, dir);
    }
  }

  addPages(notes.pages || [], '');
  await archive.finalize();
}));

module.exports = router;
