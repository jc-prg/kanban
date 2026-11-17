'use strict';

/**
 * Route handlers for boards whose notes live on WebDAV. The files on the server
 * are the only source of truth; the board's notes document is the index
 * (notes-index.js). Routes keep their id-based shape: ids are resolved to paths
 * through the index. Writes go to the server first (If-Match = ETag the note was
 * loaded with, 412 → conflict), then into the index. Errors are reported, never
 * swallowed into a DB-only state.
 */

const crypto = require('crypto');
const multer = require('multer');
const fm = require('./frontmatter');
const { BoardNotesIndex, ATTACH_DIR } = require('./notes-index');
const {
  WebdavStore, StoreError, NotFound, NotModified, PreconditionFailed,
  normEtag, cleanPath, parentOf, nameOf, joinPath,
} = require('./store');

const MD_TYPE = 'text/markdown; charset=utf-8';
const SLOW_READ_MS = 2500;
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
// Same list as the host app's local attachment upload (routes/attachments.js)
const BLOCKED_EXTS = new Set(['xhtml', 'xht', 'xml', 'exe', 'com', 'bat', 'cmd', 'vbs', 'wsf', 'hta', 'ps1',
  'app', 'dmg', 'pkg', 'deb', 'rpm', 'run', 'elf', 'jar', 'war', 'php', 'asp', 'aspx', 'jsp', 'cgi', 'rb', 'pl',
  'js', 'mjs', 'py', 'sh', 'bash', 'swf']);

const _MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain',
  md: 'text/markdown', html: 'text/html', htm: 'text/html', json: 'application/json', zip: 'application/zip',
};
const mimeOf = name => _MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

/** Title → file/folder name that works in Obsidian and on every OS. */
function fileName(title) {
  const n = String(title || '').trim().replace(/[/\\:*?"<>|#^[\]\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return n.slice(0, 180) || 'Untitled';
}

// Links to attachments next to the note: ](_attachments/x.png) or ](<_attachments/x y.png>)
const ATTACH_LINK_RE = /\]\(<?(_attachments\/[^)>\s]+)>?\)/g;
function attachmentRefs(body) {
  const out = new Set();
  for (const m of body.matchAll(ATTACH_LINK_RE)) { try { out.add(decodeURIComponent(m[1])); } catch { out.add(m[1]); } }
  return out;
}
const attachmentLink = rel => rel.split('/').map(encodeURIComponent).join('/');

function _err(res, status, error, extra = {}) { return res.status(status).json({ error, ...extra }); }

function _storeError(res, err) {
  if (err instanceof StoreError || err.status) return _err(res, err.status || 502, err.message);
  throw err;
}

// board → BoardNotesIndex (one per process; replaced when the board's WebDAV config changes)
const indexes = new Map();

/** Tests only: forget all indexes. */
function _resetIndexes() { indexes.clear(); }

function createWebdavHandlers({ adapter, attachmentsDir = null, resolveCards = null, baseUrl = null }) {
  async function getIndex(board, cfg) {
    const secret = crypto.createHash('sha1').update(cfg.password || '').digest('hex').slice(0, 8);
    const key = crypto.createHash('sha1').update(`${cfg.url}|${cfg.user}|${secret}`).digest('hex').slice(0, 16);
    let idx = indexes.get(board);
    if (idx && idx.key === key) return idx;
    idx = new BoardNotesIndex({ board, key, adapter, store: new WebdavStore({ url: cfg.url, user: cfg.user, password: cfg.password }) });
    indexes.set(board, idx);
    await idx.load();
    return idx;
  }

  function _origin(req) {
    if (typeof baseUrl === 'function') return baseUrl(req);
    return baseUrl || `${req.protocol}://${req.get('host')}`;
  }

  async function _linkedCardEntries(ids, board, req) {
    if (!ids?.length) return [];
    if (!resolveCards) return ids;
    try {
      const map = await resolveCards(board);
      return ids.map(id => {
        const raw = map.get(id);
        if (!raw) return id;
        return `[${String(raw).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()}](${_origin(req)}/${board}#card:${id})`;
      });
    } catch { return ids; }
  }

  function _unique(idx, folder, stem, ext = '') {
    let p = joinPath(folder, stem + ext);
    for (let n = 1; idx.exists(p); n++) p = joinPath(folder, `${stem} ${n}${ext}`);
    return p;
  }

  function _payload(idx, extra = {}) {
    return { ok: true, notes: idx.document(), rev: `w-${idx.version}`, ...extra };
  }

  function _pagePayload(idx, p, text, etag) {
    const note = fm.parse(text);
    const skip = new Set([...fm.APP_KEYS, ...fm.LEGACY_KEYS]);
    const properties = {};
    if (note.doc) for (const [k, v] of Object.entries(note.doc.toJSON() || {})) if (!skip.has(k)) properties[k] = v;
    return {
      id: idx.idOf(p), path: p, title: nameOf(p).replace(/\.md$/i, ''), content: note.body,
      link: String(fm.get(note, 'link') || ''), linkedCards: fm.linkedCards(note),
      properties: JSON.parse(JSON.stringify(properties)), etag,
      lastModified: idx.entry(p)?.m || null,
    };
  }

  /** Removes keys earlier versions wrote; attachments listed only there become links in the text. */
  function _cleanupLegacy(note, stem) {
    const att = fm.get(note, 'attachments');
    if (att) {
      const refs = attachmentRefs(note.body);
      const lines = [];
      for (const e of Array.isArray(att) ? att : [att]) {
        const m = /^\[(.+?)\]\((.+)\)$/.exec(String(e).trim().replace(/^"|"$/g, ''));
        const [name, rel] = m ? [m[1], m[2]] : [nameOf(String(e)), `${ATTACH_DIR}/${e}`];
        if (!refs.has(rel)) lines.push(`- ${IMG_EXT.has((name.split('.').pop() || '').toLowerCase()) ? '!' : ''}[${name}](${attachmentLink(rel)})`);
      }
      if (lines.length) note.body = note.body.replace(/\n+$/, '') + (note.body.trim() ? '\n\n' : '') + lines.join('\n') + '\n';
    }
    const changed = [];
    if (fm.remove(note, 'attachments')) changed.push('attachments');
    const title = fm.get(note, 'title');
    if (title !== undefined) {
      const t = String(title).trim();
      if (!t || [t, fileName(t)].includes(stem) || t.replace(/[/\\:*?"<>|\x00]/g, '_') === stem) {
        fm.remove(note, 'title'); changed.push('title');
      }
    }
    for (const k of ['lastModified', 'source']) if (fm.remove(note, k)) changed.push(k);
    const raw = fm.get(note, 'id');
    if (raw && fm.noteId(note) !== String(raw).trim()) { fm.set(note, 'id', fm.noteId(note)); changed.push('id'); }
    return changed;
  }

  async function _referencedElsewhere(idx, folder, exceptPath, rel) {
    for (const p of idx.filesIn(folder)) {
      if (p === exceptPath || !p.endsWith('.md')) continue;
      try {
        const { text } = await idx.read(p);
        if (attachmentRefs(fm.parse(text).body).has(rel)) return true;
      } catch { return true; }   // unknown → keep the file
    }
    return false;
  }

  /** A page moved to another folder takes the attachments it links along. */
  async function _relocateAttachments(idx, page, oldFolder, newFolder) {
    const { text, etag } = await idx.read(page);
    const note = fm.parse(text);
    const mapping = new Map();
    for (const rel of attachmentRefs(note.body)) {
      const src = joinPath(oldFolder, rel);
      if (!idx.exists(src)) continue;
      const name = nameOf(rel);
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      const dst = _unique(idx, joinPath(newFolder, ATTACH_DIR), stem, ext);
      await idx.store.mkdirs(joinPath(newFolder, ATTACH_DIR));
      if (await _referencedElsewhere(idx, oldFolder, page, rel)) {
        const { data } = await idx.store.get(src);
        await idx.noteWritten(dst, await idx.store.put(dst, data, { contentType: mimeOf(name), createOnly: true }), null, data.length);
      } else {
        await idx.store.move(src, dst);
        await idx.moved(src, dst);
      }
      mapping.set(rel, `${ATTACH_DIR}/${nameOf(dst)}`);
    }
    const body = note.body.replace(ATTACH_LINK_RE, (m, raw) => {
      let r = raw; try { r = decodeURIComponent(raw); } catch {}
      return mapping.has(r) ? `](${attachmentLink(mapping.get(r))})` : m;
    });
    if (body !== note.body) {
      note.body = body;
      const out = fm.render(note);
      await idx.noteWritten(page, await idx.store.put(page, out, { contentType: MD_TYPE, ifMatch: etag }), out, Buffer.byteLength(out));
    }
  }

  // ── tree ────────────────────────────────────────────────────

  async function getNotes(req, res, cfg) {
    const idx = await getIndex(req.params.board, cfg);
    if (!idx.entries.size && !idx.revalidating) {
      try { await idx.revalidate(); } catch { /* reported via idx.error */ }
    } else idx.ensureFresh();
    if (req.query.wait) { await idx.wait(); await idx.waitFrontmatter(); }
    const etag = `"w-${idx.key.slice(0, 6)}-${idx.version}${idx.revalidating ? '-r' : ''}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ ...idx.document(), revalidating: idx.revalidating, error: idx.error });
  }

  async function sync(req, res, cfg) {
    const idx = await getIndex(req.params.board, cfg);
    await idx.wait();
    try { await idx.revalidate({ full: !!req.body?.full }); }
    catch (err) { return res.status(502).json({ error: `WebDAV error: ${err.message}`, notes: idx.document() }); }
    res.json({ ..._payload(idx), changed: true });
  }

  /** Bulk saves of the whole tree (CouchDB mode) do not apply: the index is derived. */
  async function ignoreBulkSave(req, res, cfg) {
    const idx = await getIndex(req.params.board, cfg);
    res.setHeader('ETag', `"w-${idx.key.slice(0, 6)}-${idx.version}"`);
    res.json({ ok: true });
  }

  // ── pages ───────────────────────────────────────────────────

  async function getContent(req, res, cfg) {
    const idx = await getIndex(req.params.board, cfg);
    const p = idx.pathOf(req.params.id);
    if (!p || !p.endsWith('.md')) return _err(res, 404, 'Page not found');
    const rec = idx.entry(p);
    const cached = rec ? idx.cachedText(p, rec.e) : null;
    const reading = idx.read(p);
    try {
      const timeout = cached !== null ? new Promise(r => setTimeout(() => r(null), SLOW_READ_MS)) : null;
      const result = timeout ? await Promise.race([reading, timeout]) : await reading;
      if (!result) {
        reading.catch(() => {});   // keeps running; the server is slow
        return res.json({ ..._pagePayload(idx, p, cached, rec.e), stale: true });
      }
      res.json(_pagePayload(idx, p, result.text, result.etag));
    } catch (err) {
      if (err instanceof NotFound) return _err(res, 404, 'Page no longer exists on the server');
      if (cached !== null) return res.json({ ..._pagePayload(idx, p, cached, rec.e), stale: true });
      return _storeError(res, err);
    }
  }

  async function createPage(req, res, cfg) {
    const { board } = req.params;
    const { page = {}, parentId } = req.body || {};
    const idx = await getIndex(board, cfg);
    try {
      const folder = parentId ? idx.pathOf(parentId) : '';
      if (folder === null) return _err(res, 404, 'Folder not found');
      const note = fm.parse(String(page.description || ''));
      if (/^n-(?:wd-)?[a-z0-9]{1,20}$/.test(page.id || '')) fm.set(note, 'id', page.id);
      if (page.link) fm.set(note, 'link', String(page.link).trim());
      if (page.linkedCards?.length) fm.set(note, 'linkedCards', await _linkedCardEntries(page.linkedCards, board, req));
      const text = fm.render(note);
      if (folder) await idx.store.mkdirs(folder);
      const stem = fileName(page.title || 'New Page');
      for (let i = 0; i < 20; i++) {
        const p = _unique(idx, folder, stem, '.md');
        let etag;
        try { etag = await idx.store.put(p, text, { contentType: MD_TYPE, createOnly: true }); }
        catch (err) {
          if (err instanceof PreconditionFailed) { await idx.noteWritten(p, '', null); continue; }
          throw err;
        }
        await idx.noteWritten(p, etag, text, Buffer.byteLength(text));
        return res.json(_payload(idx, { page: { id: idx.idOf(p), etag, wdPath: p } }));
      }
      return _err(res, 409, 'No free file name found');
    } catch (err) { return _storeError(res, err); }
  }

  /** Body {title?, description?, link?, linkedCards?, etag?, force?}; header If-Match: <etag>. */
  async function updatePage(req, res, cfg) {
    const { board, id } = req.params;
    const body = req.body || {};
    const idx = await getIndex(board, cfg);
    let p = idx.pathOf(id);
    if (!p || !p.endsWith('.md')) return _err(res, 404, 'Page not found');
    try {
      const force = !!body.force;
      const etagIn = normEtag(req.headers['if-match'] || body.etag);
      // Without an ETag (older callers) the write is unconditional
      const conditional = !!etagIn && !force;
      let base = conditional ? idx.cachedText(p, etagIn) : null;
      if (base === null) {
        const cur = await idx.read(p);
        if (conditional && cur.etag !== etagIn)
          return _err(res, 412, 'The note was changed elsewhere', { server: _pagePayload(idx, p, cur.text, cur.etag) });
        base = cur.text;
      }
      const note = fm.parse(base);
      const stem = nameOf(p).replace(/\.md$/i, '');
      if (body.description !== undefined) note.body = String(body.description);
      _cleanupLegacy(note, stem);
      if (body.link !== undefined) fm.set(note, 'link', String(body.link || '').trim());
      if (body.linkedCards !== undefined) fm.set(note, 'linkedCards', await _linkedCardEntries(body.linkedCards, board, req));
      // Pin the id, so card links and deep links survive a rename in Obsidian
      if (!fm.noteId(note) && /^n-(?:wd-)?[a-z0-9]{1,20}$/.test(id)) fm.set(note, 'id', id);
      const text = fm.render(note);
      let etag;
      try { etag = await idx.store.put(p, text, { contentType: MD_TYPE, ifMatch: conditional ? etagIn : '' }); }
      catch (err) {
        if (!(err instanceof PreconditionFailed)) throw err;
        const cur = await idx.read(p);
        return _err(res, 412, 'The note was changed elsewhere', { server: _pagePayload(idx, p, cur.text, cur.etag) });
      }
      await idx.noteWritten(p, etag, text, Buffer.byteLength(text));

      if (body.title !== undefined && fileName(body.title) !== stem) {
        const np = joinPath(parentOf(p), fileName(body.title) + '.md');
        if (idx.exists(np) && np.toLowerCase() !== p.toLowerCase())
          return _err(res, 409, `"${nameOf(np).replace(/\.md$/, '')}" already exists in this folder`, { etag, ..._payload(idx) });
        await idx.store.move(p, np);
        await idx.moved(p, np);
        p = np;
        etag = (await idx.store.stat(p))?.etag || etag;
        await idx.noteWritten(p, etag, text, Buffer.byteLength(text));
      }
      res.json(_payload(idx, { page: { id: idx.idOf(p), etag, wdPath: p } }));
    } catch (err) { return _storeError(res, err); }
  }

  async function deletePage(req, res, cfg) {
    const { board, id } = req.params;
    const idx = await getIndex(board, cfg);
    const p = idx.pathOf(id);
    if (!p || !p.endsWith('.md')) return _err(res, 404, 'Page not found');
    try {
      const folder = parentOf(p);
      let refs = new Set();
      try { refs = attachmentRefs(fm.parse((await idx.read(p)).text).body); } catch (err) { if (!(err instanceof NotFound)) throw err; }
      for (const rel of refs) {
        const f = joinPath(folder, rel);
        if (idx.exists(f) && !await _referencedElsewhere(idx, folder, p, rel)) { await idx.store.delete(f); await idx.removed(f); }
      }
      await idx.store.delete(p);
      await idx.removed(p);
      res.json(_payload(idx));
    } catch (err) { return _storeError(res, err); }
  }

  async function _move(req, res, cfg, { id, folderId, name, isFolder }) {
    const idx = await getIndex(req.params.board, cfg);
    const src = idx.pathOf(id);
    if (!src || idx.entry(src)?.d !== isFolder) return _err(res, 404, isFolder ? 'Folder not found' : 'Page not found');
    try {
      const folder = folderId === undefined ? parentOf(src) : (folderId ? idx.pathOf(folderId) : '');
      if (folder === null) return _err(res, 404, 'Folder not found');
      if (isFolder && (folder === src || folder.startsWith(src + '/'))) return _err(res, 400, 'A folder cannot be moved into itself');
      const dst = joinPath(folder, name ? fileName(name) + (isFolder ? '' : '.md') : nameOf(src));
      if (dst === src) return res.json(_payload(idx));   // same folder: order is alphabetical
      if (idx.exists(dst) && dst.toLowerCase() !== src.toLowerCase()) return _err(res, 409, `"${nameOf(dst)}" already exists there`);
      if (folder) await idx.store.mkdirs(folder);
      await idx.store.move(src, dst);
      await idx.moved(src, dst);
      if (!isFolder && parentOf(src) !== folder) await _relocateAttachments(idx, dst, parentOf(src), folder);
      res.json(_payload(idx, { id: idx.idOf(dst) }));
    } catch (err) {
      if (err instanceof PreconditionFailed) return _err(res, 409, 'Target already exists');
      return _storeError(res, err);
    }
  }

  const movePage     = (req, res, cfg) => _move(req, res, cfg, { id: req.params.id, folderId: req.body?.folderId ?? '', isFolder: false });
  const moveFolder   = (req, res, cfg) => _move(req, res, cfg, { id: req.params.id, folderId: req.body?.parentId ?? '', isFolder: true });
  const renameFolder = (req, res, cfg) => {
    if (!req.body?.title) return _err(res, 400, 'title required');
    return _move(req, res, cfg, { id: req.params.id, name: req.body.title, isFolder: true });
  };

  // ── folders ─────────────────────────────────────────────────

  async function createFolder(req, res, cfg) {
    const { folder = {}, parentId } = req.body || {};
    if (!folder.title) return _err(res, 400, 'folder.title required');
    const idx = await getIndex(req.params.board, cfg);
    try {
      const parent = parentId ? idx.pathOf(parentId) : '';
      if (parent === null) return _err(res, 404, 'Folder not found');
      const p = _unique(idx, parent, fileName(folder.title));
      await idx.store.mkdirs(p);
      await idx.folderCreated(p);
      res.json(_payload(idx, { id: idx.idOf(p) }));
    } catch (err) { return _storeError(res, err); }
  }

  async function deleteFolder(req, res, cfg) {
    const idx = await getIndex(req.params.board, cfg);
    const p = idx.pathOf(req.params.id);
    if (!p || !idx.entry(p)?.d) return _err(res, 404, 'Folder not found');
    try {
      await idx.store.delete(p);
      await idx.removed(p);
      res.json(_payload(idx));
    } catch (err) { return _storeError(res, err); }
  }

  // ── attachments: files in <folder>/_attachments/ next to the note ──

  /** Path of an attachment `filename` of page `pageId` (new names, legacy "<id>_name", Obsidian embeds). */
  function _attachmentPath(idx, pageId, filename) {
    const p = idx.pathOf(pageId);
    if (!p) return null;
    const folder = parentOf(p);
    for (const c of [joinPath(folder, ATTACH_DIR, filename), joinPath(folder, ATTACH_DIR, `${pageId}_${filename}`)])
      if (idx.exists(c)) return c;
    return idx.findFile(filename, folder);
  }

  /** Attachment links of a note's text — the cached copy when it is current, else read from the server. */
  async function _refsOf(idx, p) {
    const text = idx.cachedText(p, idx.entry(p)?.e) ?? (await idx.read(p)).text;
    return attachmentRefs(fm.parse(text).body);
  }

  /**
   * Files of a page: in <folder>/_attachments/ the ones its text links, legacy "<id>_name" files, and files no note
   * of the folder links yet (just uploaded — the link is in the editor until the note is saved — or added
   * elsewhere, e.g. Obsidian). Files only other notes link are left out. Each with its `link` for the text.
   */
  async function listAttachments(req, res, cfg) {
    const { pageId } = req.params;
    const idx = await getIndex(req.params.board, cfg);
    const p = idx.pathOf(pageId);
    if (!p) return res.json([]);
    try {
      const folder = parentOf(p);
      const refs = await _refsOf(idx, p);
      const others = new Set();
      for (const q of idx.filesIn(folder)) {
        if (q === p || !q.endsWith('.md')) continue;
        try { for (const r of await _refsOf(idx, q)) others.add(r); }
        catch { /* unreadable → its links unknown */ }
      }
      const out = [];
      for (const f of idx.filesIn(joinPath(folder, ATTACH_DIR))) {
        const name = nameOf(f), rel = `${ATTACH_DIR}/${name}`;
        const legacy = name.startsWith(pageId + '_');
        if (!refs.has(rel) && !legacy && others.has(rel)) continue;
        out.push({ name: legacy ? name.slice(pageId.length + 1) : name, size: idx.entry(f)?.s || 0, link: attachmentLink(rel) });
      }
      res.json(out);
    } catch (err) { return _storeError(res, err); }
  }

  const _upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter(req, file, cb) {
      const ext = (file.originalname.split('.').pop() || '').toLowerCase();
      if (BLOCKED_EXTS.has(ext)) return cb(Object.assign(new Error(`File type .${ext} is not allowed`), { status: 400 }));
      cb(null, true);
    },
  }).single('file');

  function uploadAttachment(req, res, cfg) {
    _upload(req, res, async uerr => {
      if (uerr) return _err(res, 400, uerr.message);
      if (!req.file) return _err(res, 400, 'No file uploaded');
      const idx = await getIndex(req.params.board, cfg);
      const p = idx.pathOf(req.params.pageId);
      if (!p) return _err(res, 404, 'Page not found');
      try {
        const target = joinPath(parentOf(p), ATTACH_DIR);
        const base = fileName(nameOf(req.file.originalname || 'file'));
        const dot = base.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
        await idx.store.mkdirs(target);
        for (let i = 0; i < 20; i++) {
          const f = _unique(idx, target, stem, ext);
          let etag;
          try { etag = await idx.store.put(f, req.file.buffer, { contentType: req.file.mimetype || mimeOf(f), createOnly: true }); }
          catch (err) {
            if (err instanceof PreconditionFailed) { await idx.noteWritten(f, '', null); continue; }
            throw err;
          }
          await idx.noteWritten(f, etag, null, req.file.size);
          return res.json({ name: nameOf(f), size: req.file.size, link: attachmentLink(`${ATTACH_DIR}/${nameOf(f)}`) });
        }
        return _err(res, 409, 'No free file name found');
      } catch (err) { return _storeError(res, err); }
    });
  }

  async function downloadAttachment(req, res, cfg) {
    const idx = await getIndex(req.params.board, cfg);
    const f = _attachmentPath(idx, req.params.pageId, req.params.filename);
    if (!f) return _err(res, 404, 'Not found');
    try {
      const { data, etag } = await idx.store.get(f);
      res.setHeader('Content-Type', mimeOf(f));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nameOf(f))}`);
      if (etag) res.setHeader('ETag', `"${etag}"`);
      res.send(data);
    } catch (err) { return _storeError(res, err); }
  }

  async function deleteAttachment(req, res, cfg) {
    const idx = await getIndex(req.params.board, cfg);
    const f = _attachmentPath(idx, req.params.pageId, req.params.filename);
    if (!f || !f.split('/').includes(ATTACH_DIR)) return res.json({ ok: true });
    try {
      await idx.store.delete(f);
      await idx.removed(f);
      res.json({ ok: true });
    } catch (err) { return _storeError(res, err); }
  }

  // ── export ──────────────────────────────────────────────────

  async function exportZip(req, res, cfg, archive) {
    const idx = await getIndex(req.params.board, cfg);
    for (const [p, e] of [...idx.entries].sort()) {
      if (e.d) continue;
      try { archive.append((await idx.store.get(p)).data, { name: p }); }
      catch (err) { console.warn(`notes export: ${p}:`, err.message); }
    }
  }

  // ── migration from the old DB tree ──────────────────────────

  async function migrate(req, res, cfg) {
    const { runMigration } = require('./migrate');
    const idx = await getIndex(req.params.board, cfg);
    try { res.json(await runMigration({ idx, adapter, board: req.params.board, attachmentsDir, dryRun: req.query.dry_run !== '0', cleanup: _cleanupLegacy, fileName, unique: _unique })); }
    catch (err) { return _storeError(res, err); }
  }

  return {
    getIndex, getNotes, sync, ignoreBulkSave,
    getContent, createPage, updatePage, deletePage, movePage,
    createFolder, renameFolder, deleteFolder, moveFolder,
    listAttachments, uploadAttachment, downloadAttachment, deleteAttachment,
    exportZip, migrate,
  };
}

module.exports = { createWebdavHandlers, fileName, attachmentRefs, attachmentLink, _resetIndexes };
