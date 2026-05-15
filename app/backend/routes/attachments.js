const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { writeRateLimit, uploadRateLimit }               = require('../auth');
const { validBoardName, getCouch, loadBoardData }       = require('../db');
const { ATTACHMENTS_DIR, DB_PREFIX }                    = require('../config');
const { getDbSizeBytes }                                = require('../backup');
const {
  listAttachmentsFromWebdav, getAttachmentFromWebdav,
  uploadAttachmentToWebdav,  deleteAttachmentFromWebdav,
} = require('../webdav-notes');

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
  'xhtml', 'xht', 'xml',
  'exe', 'com', 'bat', 'cmd', 'vbs', 'wsf', 'hta', 'ps1',
  'app', 'dmg', 'pkg', 'deb', 'rpm', 'run', 'elf',
  'jar', 'war',
  'php', 'asp', 'aspx', 'jsp', 'cgi', 'rb', 'pl',
  'js', 'mjs', 'py', 'sh', 'bash',
  'swf',
]);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  if (BLOCKED_EXTS.has(ext))
    return cb(Object.assign(new Error(`File type .${ext} is not allowed`), { status: 400 }));
  cb(null, true);
}

function sanitizeFilename(original) {
  return (original || 'file')
    .replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_')
    .replace(/^\./, '_').slice(0, 200) || 'file';
}

function makeDiskStorage(subParamName) {
  return multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(ATTACHMENTS_DIR, req.params.board, req.params[subParamName]);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) { cb(null, sanitizeFilename(file.originalname)); },
  });
}

const MULTER_OPTS   = { fileFilter, limits: { fileSize: 50 * 1024 * 1024 } };
const upload        = multer({ ...MULTER_OPTS, storage: makeDiskStorage('pageId') });
const uploadCard    = multer({ ...MULTER_OPTS, storage: makeDiskStorage('cardId') });
const uploadMemory  = multer({ ...MULTER_OPTS, storage: multer.memoryStorage() });

// Promisify a multer single-file call so it can be awaited.
function runUpload(multerInstance, req, res) {
  return new Promise((resolve, reject) =>
    multerInstance.single('file')(req, res, err => (err ? reject(err) : resolve()))
  );
}

// Returns the webdav config if WebDAV is enabled for this board, otherwise null.
async function getWebdavCfg(board) {
  try {
    const db   = getCouch().use(DB_PREFIX + board);
    const data = await loadBoardData(db);
    const cfg  = data.settings?.webdav;
    return cfg?.enabled ? cfg : null;
  } catch { return null; }
}

// Local cache helpers for WebDAV attachment mirroring
function _localAttachDir(board, pageId)            { return path.join(ATTACHMENTS_DIR, board, pageId); }
function _localAttachFile(board, pageId, filename) { return path.join(ATTACHMENTS_DIR, board, pageId, filename); }
function _cacheAttachment(board, pageId, filename, buffer) {
  try {
    fs.mkdirSync(_localAttachDir(board, pageId), { recursive: true });
    fs.writeFileSync(_localAttachFile(board, pageId, filename), buffer);
  } catch (err) {
    console.error('[WebDAV] local attachment cache write failed:', err.message);
  }
}

// ---- Notes attachments ----

router.get('/:board/notes/attachments/:pageId', async (req, res) => {
  const { board, pageId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safePageId(pageId))   return res.status(400).json({ error: 'Invalid page id' });

  const wdCfg = await getWebdavCfg(board);
  if (wdCfg) {
    try { return res.json(await listAttachmentsFromWebdav(wdCfg, pageId)); }
    catch {
      // Fall back to local cache
      const dir = _localAttachDir(board, pageId);
      if (!fs.existsSync(dir)) return res.json([]);
      try {
        return res.json(fs.readdirSync(dir).filter(n => !n.startsWith('.')).map(name => ({
          name, size: fs.statSync(path.join(dir, name)).size,
        })));
      } catch { return res.json([]); }
    }
  }

  const dir = path.join(ATTACHMENTS_DIR, board, pageId);
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    res.json(fs.readdirSync(dir).filter(n => !n.startsWith('.')).map(name => ({
      name, size: fs.statSync(path.join(dir, name)).size,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:board/notes/attachments/:pageId', uploadRateLimit, async (req, res) => {
  const { board, pageId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safePageId(pageId))   return res.status(400).json({ error: 'Invalid page id' });

  const wdCfg = await getWebdavCfg(board);
  if (wdCfg) {
    try { await runUpload(uploadMemory, req, res); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filename = sanitizeFilename(req.file.originalname);
    try {
      await uploadAttachmentToWebdav(wdCfg, pageId, filename, req.file.buffer);
      _cacheAttachment(board, pageId, filename, req.file.buffer);  // mirror to local
      return res.json({ name: filename, size: req.file.buffer.length });
    } catch (err) {
      return res.status(500).json({ error: 'WebDAV upload failed: ' + err.message });
    }
  }

  upload.single('file')(req, res, err => {
    if (err)       return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ name: req.file.filename, size: req.file.size });
  });
});

router.get('/:board/notes/attachments/:pageId/:filename', async (req, res) => {
  const { board, pageId, filename } = req.params;
  if (!validBoardName(board) || !safePageId(pageId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });

  const wdCfg = await getWebdavCfg(board);
  if (wdCfg) {
    try {
      const buffer = await getAttachmentFromWebdav(wdCfg, pageId, filename);
      _cacheAttachment(board, pageId, filename, buffer);  // mirror to local
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    } catch (err) {
      // Fall back to local cache
      const localFile = _localAttachFile(board, pageId, filename);
      if (fs.existsSync(localFile)) {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.sendFile(filename, { root: _localAttachDir(board, pageId) });
      }
      return res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
    }
  }

  const root = path.join(ATTACHMENTS_DIR, board, pageId);
  if (!fs.existsSync(path.join(root, filename))) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filename, { root });
});

router.delete('/:board/notes/attachments/:pageId/:filename', writeRateLimit, async (req, res) => {
  const { board, pageId, filename } = req.params;
  if (!validBoardName(board) || !safePageId(pageId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });

  const wdCfg = await getWebdavCfg(board);
  if (wdCfg) {
    try { await deleteAttachmentFromWebdav(wdCfg, pageId, filename); } catch {}
    try { fs.unlinkSync(_localAttachFile(board, pageId, filename)); } catch {}  // remove local cache
    return res.json({ ok: true });
  }

  try { fs.unlinkSync(path.join(ATTACHMENTS_DIR, board, pageId, filename)); } catch {}
  res.json({ ok: true });
});

// ---- Card attachments (always local, unaffected by WebDAV) ----

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
    res.json(fs.readdirSync(dir).filter(n => !n.startsWith('.')).map(name => ({
      name, size: fs.statSync(path.join(dir, name)).size,
    })));
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
