const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { writeRateLimit, uploadRateLimit } = require('../auth');
const { validBoardName }                  = require('../db');
const { ATTACHMENTS_DIR }                 = require('../config');
const { getDbSizeBytes }                  = require('../backup');

function safePageId(id) {
  return typeof id === 'string' && /^n-[a-z0-9]{1,20}$/.test(id);
}
function safeCardId(id) {
  return typeof id === 'string' && /^id-[a-z0-9]{1,10}$/.test(id);
}
function safeFilename(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && !/[/\\]/.test(name) && !name.includes('..');
}

function makeDiskStorage(subParamName) {
  return multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(ATTACHMENTS_DIR, req.params.board, req.params[subParamName]);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const safe = file.originalname
        .replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_')
        .replace(/^\./, '_').slice(0, 200) || 'file';
      cb(null, safe);
    },
  });
}

const upload     = multer({ storage: makeDiskStorage('pageId'), limits: { fileSize: 50 * 1024 * 1024 } });
const uploadCard = multer({ storage: makeDiskStorage('cardId'), limits: { fileSize: 50 * 1024 * 1024 } });

// ---- Notes attachments ----

router.get('/:board/notes/attachments/:pageId', (req, res) => {
  const { board, pageId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safePageId(pageId))   return res.status(400).json({ error: 'Invalid page id' });
  const dir = path.join(ATTACHMENTS_DIR, board, pageId);
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    const files = fs.readdirSync(dir).filter(n => !n.startsWith('.')).map(name => ({
      name, size: fs.statSync(path.join(dir, name)).size,
    }));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:board/notes/attachments/:pageId', uploadRateLimit, (req, res) => {
  const { board, pageId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safePageId(pageId))   return res.status(400).json({ error: 'Invalid page id' });
  upload.single('file')(req, res, err => {
    if (err)       return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ name: req.file.filename, size: req.file.size });
  });
});

router.get('/:board/notes/attachments/:pageId/:filename', (req, res) => {
  const { board, pageId, filename } = req.params;
  if (!validBoardName(board) || !safePageId(pageId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  const fp = path.join(ATTACHMENTS_DIR, board, pageId, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(fp);
});

router.delete('/:board/notes/attachments/:pageId/:filename', writeRateLimit, (req, res) => {
  const { board, pageId, filename } = req.params;
  if (!validBoardName(board) || !safePageId(pageId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  try { fs.unlinkSync(path.join(ATTACHMENTS_DIR, board, pageId, filename)); } catch {}
  res.json({ ok: true });
});

// ---- Card attachments ----

router.get('/:board/cards/attachments', (req, res) => {
  const { board } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  const boardDir = path.join(ATTACHMENTS_DIR, board);
  if (!fs.existsSync(boardDir)) return res.json([]);
  try {
    const ids = fs.readdirSync(boardDir).filter(name => {
      if (!safeCardId(name)) return false;
      const dir = path.join(boardDir, name);
      try {
        return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).some(f => !f.startsWith('.'));
      } catch { return false; }
    });
    res.json(ids);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:board/cards/attachments/:cardId', (req, res) => {
  const { board, cardId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safeCardId(cardId))   return res.status(400).json({ error: 'Invalid card id' });
  const dir = path.join(ATTACHMENTS_DIR, board, cardId);
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    const files = fs.readdirSync(dir).filter(n => !n.startsWith('.')).map(name => ({
      name, size: fs.statSync(path.join(dir, name)).size,
    }));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:board/cards/attachments/:cardId', uploadRateLimit, (req, res) => {
  const { board, cardId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safeCardId(cardId))   return res.status(400).json({ error: 'Invalid card id' });
  uploadCard.single('file')(req, res, err => {
    if (err)       return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ name: req.file.filename, size: req.file.size });
  });
});

router.get('/:board/cards/attachments/:cardId/:filename', (req, res) => {
  const { board, cardId, filename } = req.params;
  if (!validBoardName(board) || !safeCardId(cardId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  const fp = path.join(ATTACHMENTS_DIR, board, cardId, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(fp);
});

router.delete('/:board/cards/attachments/:cardId/:filename', writeRateLimit, (req, res) => {
  const { board, cardId, filename } = req.params;
  if (!validBoardName(board) || !safeCardId(cardId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  try { fs.unlinkSync(path.join(ATTACHMENTS_DIR, board, cardId, filename)); } catch {}
  res.json({ ok: true });
});

router.get('/:board/attachment-stats', (req, res) => {
  const { board } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  const boardDir = path.join(ATTACHMENTS_DIR, board);
  if (!fs.existsSync(boardDir)) return res.json({ count: 0, size: 0 });
  let count = 0, size = 0;
  try {
    for (const sub of fs.readdirSync(boardDir)) {
      const subDir = path.join(boardDir, sub);
      try {
        if (!fs.statSync(subDir).isDirectory()) continue;
        for (const file of fs.readdirSync(subDir).filter(n => !n.startsWith('.'))) {
          count++;
          size += fs.statSync(path.join(subDir, file)).size;
        }
      } catch {}
    }
    res.json({ count, size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/db-size', (req, res) => {
  res.json({ size: getDbSizeBytes() });
});

module.exports = router;
