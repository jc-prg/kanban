const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { writeRateLimit, uploadRateLimit } = require('../auth');
const { validBoardName, getBoardDb }      = require('../db');
const { ATTACHMENTS_DIR, NOTES_DOC_ID }   = require('../config');
const { getDbSizeBytes }                  = require('../backup');
const { getWebdavConfig }                 = require('./notes');
const { wdPutBinary, wdDelete, wdMkcol, _titleToSlug } = require('../webdav-notes');

function safePageId(id) {
  return typeof id === 'string' && /^n-[a-z0-9]{1,20}$/.test(id);
}
function safeCardId(id) {
  return typeof id === 'string' && /^id-[a-z0-9]{1,10}$/.test(id);
}
function safeFilename(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && !/[/\\]/.test(name) && !name.includes('..') && !name.includes('\x00');
}

// Extensions blocked at upload — browser-executable, OS-executable, or scripting formats.
// Office formats (.doc/x, .xls/x, .ppt/x, .docm, …) and .html/.htm/.svg are intentionally allowed.
const BLOCKED_EXTS = new Set([
  // browser-renderable same-origin risk
  'xhtml', 'xht', 'xml',
  // Windows executables / scripting
  'exe', 'com', 'bat', 'cmd', 'vbs', 'wsf', 'hta', 'ps1',
  // macOS / Linux executables & installers
  'app', 'dmg', 'pkg', 'deb', 'rpm', 'run', 'elf',
  // JVM
  'jar', 'war',
  // server-side scripting
  'php', 'asp', 'aspx', 'jsp', 'cgi', 'rb', 'pl',
  // general scripting
  'js', 'mjs', 'py', 'sh', 'bash',
  // polyglot / embedded-script formats
  'swf',
]);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  if (BLOCKED_EXTS.has(ext))
    return cb(Object.assign(new Error(`File type .${ext} is not allowed`), { status: 400 }));
  cb(null, true);
}

function _safeFilePart(name) {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_')
    .replace(/^\./, '_').slice(0, 200) || 'file';
}

const MULTER_OPTS = { fileFilter, limits: { fileSize: 50 * 1024 * 1024 } };

// Card attachment storage (path does not depend on notes tree)
const uploadCard = multer({
  ...MULTER_OPTS,
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(ATTACHMENTS_DIR, req.params.board, req.params.cardId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) { cb(null, _safeFilePart(file.originalname)); },
  }),
});

// ---------------------------------------------------------------------------
// Notes attachment helpers
// ---------------------------------------------------------------------------

/** Walk a v2 notes items array to find the folder-slug prefix of a page. */
function _findPagePrefix(items, pageId, prefix = '') {
  for (const item of items) {
    if (item.type === 'page' && item.id === pageId) return prefix;
    if (item.type === 'folder') {
      const slug   = _titleToSlug(item.title);
      const result = _findPagePrefix(item.children || [], pageId, prefix + slug + '/');
      if (result !== null) return result;
    }
  }
  return null;
}

/** Load notes tree from CouchDB and return the _attachments prefix for pageId. */
async function _getPageAttachmentPrefix(board, pageId) {
  try {
    const db  = await getBoardDb(board);
    const raw = await db.get(NOTES_DOC_ID).catch(() => null);
    if (!raw) return '';
    const items = (raw.schemaVersion === 2 && Array.isArray(raw.items)) ? raw.items : [];
    return _findPagePrefix(items, pageId) ?? '';
  } catch { return ''; }
}

// ---- Notes attachments ----

router.get('/:board/notes/attachments/:pageId', async (req, res) => {
  const { board, pageId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safePageId(pageId))   return res.status(400).json({ error: 'Invalid page id' });
  const prefix = await _getPageAttachmentPrefix(board, pageId);
  const dir    = path.join(ATTACHMENTS_DIR, board, prefix, '_attachments');
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    const files = fs.readdirSync(dir)
      .filter(n => !n.startsWith('.') && n.startsWith(pageId + '_'))
      .map(name => ({ name: name.slice(pageId.length + 1), size: fs.statSync(path.join(dir, name)).size }));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:board/notes/attachments/:pageId', uploadRateLimit, async (req, res) => {
  const { board, pageId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safePageId(pageId))   return res.status(400).json({ error: 'Invalid page id' });

  const prefix    = await _getPageAttachmentPrefix(board, pageId);
  const uploadDir = path.join(ATTACHMENTS_DIR, board, prefix, '_attachments');

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename(req, file, cb) { cb(null, `${pageId}_${_safeFilePart(file.originalname)}`); },
  });

  multer({ ...MULTER_OPTS, storage }).single('file')(req, res, async err => {
    if (err)       return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const originalName = req.file.filename.slice(pageId.length + 1);
    res.json({ name: originalName, size: req.file.size });
    try {
      const db  = await getBoardDb(board);
      const cfg = await getWebdavConfig(db);
      if (cfg.enabled) {
        // Ensure all ancestor folders and _attachments collection exist
        if (prefix) {
          const parts = prefix.replace(/\/$/, '').split('/');
          let cumPath = '';
          for (const part of parts) { cumPath += part + '/'; await wdMkcol(cfg, cumPath).catch(() => {}); }
        }
        await wdMkcol(cfg, `${prefix}_attachments/`).catch(() => {});
        const buf = fs.readFileSync(req.file.path);
        await wdPutBinary(cfg, `${prefix}_attachments/${req.file.filename}`, buf, req.file.mimetype || 'application/octet-stream');
      }
    } catch (wdErr) {
      console.warn('WebDAV attachment upload failed:', wdErr.message);
    }
  });
});

router.get('/:board/notes/attachments/:pageId/:filename', async (req, res) => {
  const { board, pageId, filename } = req.params;
  if (!validBoardName(board) || !safePageId(pageId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  const prefix = await _getPageAttachmentPrefix(board, pageId);
  const dir    = path.join(ATTACHMENTS_DIR, board, prefix, '_attachments');
  const stored = `${pageId}_${filename}`;
  if (!fs.existsSync(path.join(dir, stored))) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(stored, { root: dir });
});

router.delete('/:board/notes/attachments/:pageId/:filename', writeRateLimit, async (req, res) => {
  const { board, pageId, filename } = req.params;
  if (!validBoardName(board) || !safePageId(pageId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  const prefix = await _getPageAttachmentPrefix(board, pageId);
  const dir    = path.join(ATTACHMENTS_DIR, board, prefix, '_attachments');
  try { fs.unlinkSync(path.join(dir, `${pageId}_${filename}`)); } catch {}
  res.json({ ok: true });
  try {
    const db  = await getBoardDb(board);
    const cfg = await getWebdavConfig(db);
    if (cfg.enabled) await wdDelete(cfg, `${prefix}_attachments/${pageId}_${filename}`);
  } catch (wdErr) {
    console.warn('WebDAV attachment delete failed:', wdErr.message);
  }
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
  const root = path.join(ATTACHMENTS_DIR, board, cardId);
  if (!fs.existsSync(path.join(root, filename))) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filename, { root });
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
    function scan(dir) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('.')) continue;
        const full = path.join(dir, entry);
        try {
          if (fs.statSync(full).isDirectory()) {
            if (entry === '_attachments') {
              for (const f of fs.readdirSync(full).filter(n => !n.startsWith('.'))) {
                count++;
                size += fs.statSync(path.join(full, f)).size;
              }
            } else {
              scan(full);
            }
          } else {
            // card attachments stored flat under their cardId dir
            count++;
            size += fs.statSync(full).size;
          }
        } catch {}
      }
    }
    // Board dir contains cardId dirs (flat files) and folder-path dirs (_attachments inside)
    for (const entry of fs.readdirSync(boardDir)) {
      if (entry.startsWith('.')) continue;
      const full = path.join(boardDir, entry);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
        if (entry === '_attachments') {
          // root-level notes attachments
          for (const f of fs.readdirSync(full).filter(n => !n.startsWith('.'))) {
            count++;
            size += fs.statSync(path.join(full, f)).size;
          }
        } else if (/^id-[a-z0-9]{1,10}$/.test(entry)) {
          // card attachment dir — flat files
          for (const f of fs.readdirSync(full).filter(n => !n.startsWith('.'))) {
            count++;
            size += fs.statSync(path.join(full, f)).size;
          }
        } else {
          // folder path — scan recursively for nested _attachments
          scan(full);
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
