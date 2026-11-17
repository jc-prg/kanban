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

/**
 * Front matter `attachments:` — the page's own files (uploaded for it or linked in it) as "[name](_attachments/name)"
 * (also bare names and older "[name](_attachments/<pageId>_name)" entries). Returns relative paths "_attachments/…".
 */
function fmAttachments(note) {
  const v = fm.get(note, 'attachments');
  if (!v) return [];
  const out = new Set();
  for (const e of Array.isArray(v) ? v : [v]) {
    const s = String(e ?? '').trim().replace(/^"|"$/g, '');
    if (!s) continue;
    const m = /^!?\[[^\]]*\]\(<?([^)>]+)>?\)$/.exec(s);
    let rel = m ? m[1] : (s.includes('/') ? s : `${ATTACH_DIR}/${s}`);
    try { rel = decodeURIComponent(rel); } catch { /* keep */ }
    rel = rel.replace(/^\.\//, '');
    if (rel.startsWith(`${ATTACH_DIR}/`) && !rel.slice(ATTACH_DIR.length + 1).includes('/')) out.add(rel);
  }
  return [...out];
}

/** Writes the list (sorted by name, "[name](link)"); an empty list removes the key. */
function setFmAttachments(note, rels) {
  const list = [...new Set(rels)].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de'));
  fm.set(note, 'attachments', list.map(rel => `[${nameOf(rel).replace(/[[\]]/g, '')}](${attachmentLink(rel)})`));
}

/** All attachments of a note: its front matter list and the files its text links. */
function noteAttachments(note) {
  return new Set([...fmAttachments(note), ...attachmentRefs(note.body)]);
}

function _err(res, status, error, extra = {}) { return res.status(status).json({ error, ...extra }); }

/** Text for a lock found by store.lockInfo: who holds it and what to do (the time goes along as `lock.since` — the
 *  browser shows it in local time; the server may run in UTC). */
function lockMessage(name, lock) {
  const who = lock.app ? `by ${lock.owner || 'an app'} (Nextcloud app lock)` : `by ${lock.owner || 'another user'}${lock.editor ? ` in ${lock.editor}` : ''}`;
  const hint = lock.app
    ? 'Nextcloud did not release it when the file was closed there. Open the file in Nextcloud and close it again, or ask the Nextcloud admin to remove the lock (files_lock).'
    : 'Close the file there, or remove the lock in Nextcloud (Files → file menu → Unlock).';
  return `"${name}" is locked on the server ${who}${lock.timeout ? '' : ', without expiry'}. ${hint}`;
}

async function _storeError(res, err) {
  if (err.status === 423 && err.store && err.path) {
    // Who holds the lock — a stale Nextcloud Text lock never goes away on its own
    const lock = await err.store.lockInfo(err.path).catch(() => null);
    if (lock) return _err(res, 423, lockMessage(nameOf(err.path).replace(/\.md$/i, ''), lock), { lock: { owner: lock.owner, app: lock.app, since: lock.since } });
  }
  if (err instanceof StoreError || err.status) return _err(res, err.status || 502, err.message);
  throw err;
}

/** multer hands over the file name's UTF-8 bytes as Latin-1 ("Ã¤" for "ä") — decode them; real Latin-1 stays. */
function uploadName(name) {
  const s = String(name || '');
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  const utf8 = Buffer.from(s, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? s : utf8;
}

// board → BoardNotesIndex (one per process; replaced when the board's WebDAV config changes)
const indexes = new Map();

/** Tests only: forget all indexes. */
function _resetIndexes() { indexes.clear(); }

// The handlers of the mounted notes router — lets other readers of the notes documents (Today's Notes and Find
// widgets) bring WebDAV boards up to date first
let _freshen = null;

/**
 * Checks the WebDAV boards among `boards` against their servers (at most every 5 s each) and waits for that up to
 * `waitMs` (`frontmatter`: also for the texts of changed files — full-text search). Boards without WebDAV are skipped.
 */
async function freshenWebdavNotes(boards, { waitMs = 3000, frontmatter = false } = {}) {
  if (!_freshen) return;
  await Promise.allSettled(boards.map(b => _freshen(b, waitMs, frontmatter)));
}

function createWebdavHandlers({ adapter, attachmentsDir = null, resolveCards = null, baseUrl = null }) {
  _freshen = async (board, waitMs, frontmatter) => {
    const cfg = await adapter.resolveWebdavCfg(board);
    if (!cfg.enabled || !cfg.url) return;
    const idx = await getIndex(board, cfg);
    idx.ensureFresh();
    const until = Date.now() + waitMs;
    await idx.wait(waitMs);
    if (frontmatter) await idx.waitFrontmatter(Math.max(0, until - Date.now()));
  };

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

  /** Removes keys earlier versions wrote (`attachments:` stays — it lists the page's files). */
  function _cleanupLegacy(note, stem) {
    const changed = [];
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
        if (noteAttachments(fm.parse(text)).has(rel)) return true;
      } catch { return true; }   // unknown → keep the file
    }
    return false;
  }

  /** A page moved to another folder takes the attachments it links along. */
  async function _relocateAttachments(idx, page, oldFolder, newFolder) {
    const { text, etag } = await idx.read(page);
    const note = fm.parse(text);
    const mapping = new Map();
    for (const rel of noteAttachments(note)) {
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
    const listed = fmAttachments(note);
    if (listed.some(r => mapping.has(r))) setFmAttachments(note, listed.map(r => mapping.get(r) || r));
    if (body !== note.body || note.dirty) {
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
      // Files the text links (and that exist next to the note) join the page's attachments list
      const listed = fmAttachments(note);
      const linked = [...attachmentRefs(note.body)].filter(r => !listed.includes(r) && idx.exists(joinPath(parentOf(p), r)));
      if (linked.length) setFmAttachments(note, [...listed, ...linked]);
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
      try { refs = noteAttachments(fm.parse((await idx.read(p)).text)); } catch (err) { if (!(err instanceof NotFound)) throw err; }
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

  /**
   * Changes the page's front matter `attachments:` list (fn: list → list) and writes the note when it changed.
   * `etagIn` = ETag the editor loaded the note with: the note is only touched when it still is at that version
   * (else PreconditionFailed — the editor's next save brings the list in line). Returns the note's ETag.
   */
  async function _editAttachmentList(idx, p, fn, etagIn = '') {
    let text = etagIn ? idx.cachedText(p, etagIn) : null, etag = etagIn;
    if (text === null) {
      const cur = await idx.read(p);
      if (etagIn && cur.etag !== etagIn) throw new PreconditionFailed('note changed since it was loaded');
      ({ text, etag } = cur);
    }
    const note = fm.parse(text);
    if (!note.valid) return etag;   // unparsable YAML: leave the note alone
    const before = fmAttachments(note);
    const after = fn(before);
    if (after.length === before.length && after.every(r => before.includes(r))) return etag;
    setFmAttachments(note, after);
    const out = fm.render(note);
    const nextEtag = await idx.store.put(p, out, { contentType: MD_TYPE, ifMatch: etag });
    await idx.noteWritten(p, nextEtag, out, Buffer.byteLength(out));
    return nextEtag;
  }

  /**
   * Files in the page's folder <folder>/_attachments/, each { name, size, link, scope }: scope 'page' = the page's
   * own (front matter `attachments:`, links in its text, legacy "<id>_name" files — listed without the prefix),
   * 'folder' = the folder's other files (other notes', Obsidian's, …).
   */
  async function listAttachments(req, res, cfg) {
    const { pageId } = req.params;
    const idx = await getIndex(req.params.board, cfg);
    const p = idx.pathOf(pageId);
    if (!p) return res.json([]);
    try {
      const folder = parentOf(p);
      const own = noteAttachments(fm.parse((await idx.read(p)).text));
      const page = [], other = [];
      for (const f of idx.filesIn(joinPath(folder, ATTACH_DIR))) {
        const name = nameOf(f), rel = `${ATTACH_DIR}/${name}`;
        const legacy = name.startsWith(pageId + '_');
        const item = { name: legacy ? name.slice(pageId.length + 1) : name, size: idx.entry(f)?.s || 0, link: attachmentLink(rel) };
        if (own.has(rel) || legacy) page.push({ ...item, scope: 'page' });
        else other.push({ ...item, scope: 'folder' });
      }
      res.json([...page, ...other]);
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
        const base = fileName(nameOf(uploadName(req.file.originalname) || 'file'));
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
          // The page lists the file in its front matter (If-Match: the editor's version of the note)
          const rel = `${ATTACH_DIR}/${nameOf(f)}`;
          let noteEtag = null;
          try { noteEtag = await _editAttachmentList(idx, p, list => [...list, rel], normEtag(req.headers['if-match'] || '')); }
          catch (err) { if (!(err instanceof PreconditionFailed)) console.warn(`notes: could not list ${f} in ${p}:`, err.message); }
          return res.json({ name: nameOf(f), size: req.file.size, link: attachmentLink(rel), etag: noteEtag });
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
      // Out of the page's front matter list too
      const p = idx.pathOf(req.params.pageId);
      const rel = `${ATTACH_DIR}/${nameOf(f)}`;
      let etag = null;
      if (p && joinPath(parentOf(p), rel) === f) {
        try { etag = await _editAttachmentList(idx, p, list => list.filter(r => r !== rel), normEtag(req.headers['if-match'] || '')); }
        catch (err) { if (!(err instanceof PreconditionFailed)) console.warn(`notes: could not unlist ${f} in ${p}:`, err.message); }
      }
      res.json({ ok: true, etag });
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

module.exports = { createWebdavHandlers, freshenWebdavNotes, fileName, attachmentRefs, attachmentLink, fmAttachments, noteAttachments, uploadName, lockMessage, _resetIndexes };
