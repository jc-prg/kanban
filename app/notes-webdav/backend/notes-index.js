'use strict';

/**
 * Notes index for WebDAV boards: a cache of the files on the server, never a
 * second source of truth. It is persisted as the board's CouchDB notes document
 * ({ items: [...] } like before, plus source: "webdav"), so the Today page,
 * search and backups keep reading it unchanged. The tree in that document is
 * rebuilt from the file listing on every change — nothing is matched by
 * heuristics, so there are no orphans: what is gone on the server is gone here.
 *
 * Change detection:
 * - Nextcloud/ownCloud propagate folder ETags: PROPFIND Depth:0 on the root;
 *   unchanged → nothing to do (one request). Otherwise only folders whose ETag
 *   changed are listed again (Depth:1).
 * - Other servers: one Depth:infinity listing (or a full Depth:1 walk).
 * Front matter fields and bodies (for search) are read in the background for
 * files with a new ETag.
 *
 * Ids: a page keeps the `id` from its front matter (unique), otherwise
 * "n-<hash of path>"; folders are "f-<hash of path>".
 */

const crypto = require('crypto');
const fm = require('./frontmatter');
const { NotFound, NotModified, StoreError, parentOf, nameOf, joinPath } = require('./store');

const ATTACH_DIR = '_attachments';
const MIN_REVALIDATE_MS = 5000;
// Small Nextcloud instances run only a few PHP workers; stay below that
const LIST_CONCURRENCY  = 4;
const FETCH_CONCURRENCY = 3;

const visible = p => !!p && !p.split('/').some(seg => seg.startsWith('.'));
const isAttachmentPath = p => p.split('/').includes(ATTACH_DIR);
const hash12 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const sortKey = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('de');
const hasAttachmentLinks = body => body.includes(`${ATTACH_DIR}/`) || body.includes('![[');

/** Run fns with at most n at a time. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(workers);
}

class BoardNotesIndex {
  constructor({ board, store, adapter, key }) {
    this.board = board;
    this.store = store;
    this.adapter = adapter;
    this.key = key;
    // path → { d, e, m, s, fe, id, link, lc, att, head, body, be }
    //   fe/be: ETag the front matter fields / the cached text belong to
    this.entries = new Map();
    this.rootEtag = '';
    this.version = 0;
    this.checkedAt = 0;
    this.error = null;
    this._chain = Promise.resolve();      // serialises revalidations
    this._task = null;                     // running background revalidation
    this._fmTask = null;                   // running front matter refresh
    this._loaded = null;
  }

  // ── persistence (the board's notes document) ─────────────────

  load() {
    this._loaded ??= (async () => {
      const doc = await this.adapter.loadNotes(this.board);
      if (doc?.source !== 'webdav') {
        // First use: keep the old DB tree for the migration
        if (doc?.items?.length && this.adapter.saveLegacyNotes) {
          const legacy = await this.adapter.loadLegacyNotes?.(this.board);
          if (!legacy?.items?.length) await this.adapter.saveLegacyNotes(this.board, doc);
        }
        return;
      }
      if (doc.key !== this.key) return;
      this.rootEtag = doc.rootEtag || '';
      this.version = doc.version || 0;
      const walk = items => {
        for (const it of items || []) {
          const p = String(it.wdPath || '').replace(/\/$/, '');
          if (!p) continue;
          if (it.type === 'folder') {
            this.entries.set(p, { d: true, e: it.etag || '', m: '', s: 0 });
            walk(it.children);
          } else {
            this.entries.set(p, {
              d: false, e: it.etag || '', m: it.lastModified || '', s: it.size || 0,
              fe: it.fe || '', id: it.fmId || '', link: it.link || '', lc: it.linkedCards || [],
              att: !!it.hasAttachments, body: it.description ?? null, head: it.head ?? '', be: it.be || '',
            });
          }
        }
      };
      walk(doc.items);
      for (const [p, f] of Object.entries(doc.files || {})) this.entries.set(p, { d: false, e: f.e || '', m: f.m || '', s: f.s || 0 });
    })();
    return this._loaded;
  }

  async save() {
    const res = await this.adapter.saveNotes(this.board, this.document());
    return res?.rev;
  }

  async _bump() { this.version++; return this.save(); }

  /** The notes document: tree for the UI and other readers, plus index metadata. */
  document() {
    const files = {};
    const nodes = new Map([['', { children: [] }]]);
    const usedIds = new Set();
    const paths = [...this.entries.keys()].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
    for (const p of paths) {
      const e = this.entries.get(p);
      if (isAttachmentPath(p) || (!e.d && !p.endsWith('.md'))) {
        if (!e.d) files[p] = { e: e.e, m: e.m, s: e.s };
        continue;
      }
      const parent = nodes.get(parentOf(p));
      if (!parent) continue;
      if (e.d) {
        const node = { type: 'folder', id: 'f-' + hash12(p), title: nameOf(p), wdPath: p + '/', etag: e.e, children: [] };
        nodes.set(p, node);
        parent.children.push(node);
      } else {
        let id = e.id && /^n-(?:wd-)?[a-z0-9]{1,20}$/.test(e.id) && !usedIds.has(e.id) ? e.id : 'n-' + hash12(p);
        usedIds.add(id);
        parent.children.push({
          type: 'page', id, title: nameOf(p).replace(/\.md$/i, ''), wdPath: p, etag: e.e,
          lastModified: e.m || '', size: e.s,
          ...(e.body !== null && e.body !== undefined ? { description: e.body, head: e.head || '', be: e.be } : {}),
          link: e.link || '', linkedCards: e.lc || [], hasAttachments: !!e.att,
          fe: e.fe || '', fmId: e.id || '',
        });
      }
    }
    const sort = items => {
      items.sort((a, b) => (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) ||
        sortKey(a.title).localeCompare(sortKey(b.title), 'de'));
      for (const n of items) if (n.type === 'folder') sort(n.children);
    };
    sort(nodes.get('').children);
    return {
      schemaVersion: 2, source: 'webdav', key: this.key, version: this.version, rootEtag: this.rootEtag,
      items: nodes.get('').children, files,
    };
  }

  // ── revalidation ─────────────────────────────────────────────

  get revalidating() { return !!this._task; }

  /** Starts a background check if the last one is older than maxAge. True while one runs. */
  ensureFresh(maxAge = MIN_REVALIDATE_MS) {
    if (this._task) return true;
    if (this.entries.size && Date.now() - this.checkedAt < maxAge) return false;
    this._task = this.revalidate().catch(err => console.warn(`notes ${this.board}: revalidation failed:`, err.message))
      .finally(() => { this._task = null; });
    return true;
  }

  async wait(timeoutMs = 15000) {
    if (!this._task) return;
    await Promise.race([this._task, new Promise(r => setTimeout(r, timeoutMs))]);
  }

  async waitFrontmatter(timeoutMs = 30000) {
    if (!this._fmTask) return;
    await Promise.race([this._fmTask, new Promise(r => setTimeout(r, timeoutMs))]);
  }

  /** Brings the index in line with the server. Resolves to true if anything changed. */
  revalidate({ full = false } = {}) {
    const run = async () => {
      await this.load();
      try {
        const before = new Map([...this.entries].map(([p, e]) => [p, e.e]));
        const [root] = await this.store.list('', '0');
        let changed = false;
        if (!(this.store.propagatesEtags && !full && this.entries.size && root.etag === this.rootEtag)) {
          if (this.store.propagatesEtags && !full && this.entries.size) await this._walk('');
          else await this._fullScan();
          this.rootEtag = root.etag;
          changed = before.size !== this.entries.size || [...this.entries].some(([p, e]) => before.get(p) !== e.e);
        }
        if (changed) await this._bump();
        this.error = null;
        if (this._staleNotes().length && !this._fmTask) {
          this._fmTask = this._refreshNotes()
            .then(ch => ch && this._bump())
            .catch(err => console.warn(`notes ${this.board}: front matter refresh failed:`, err.message))
            .finally(() => { this._fmTask = null; });
        }
        return changed;
      } catch (err) {
        this.error = err.message;
        throw err;
      } finally {
        this.checkedAt = Date.now();
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  _setEntry(e) {
    const old = this.entries.get(e.path);
    const rec = { d: e.isDir, e: e.etag, m: e.mtime, s: e.size };
    if (old && !old.d && !e.isDir) for (const k of ['fe', 'id', 'link', 'lc', 'att', 'body', 'head', 'be']) if (k in old) rec[k] = old[k];
    this.entries.set(e.path, rec);
  }

  _dropSubtree(p) {
    this.entries.delete(p);
    const prefix = p + '/';
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  _children(p) { return [...this.entries.keys()].filter(k => parentOf(k) === p); }

  async _walk(folder) {
    let active = 0;
    const queue = [];
    const acquire = () => new Promise(res => {
      if (active < LIST_CONCURRENCY) { active++; res(); } else queue.push(res);
    });
    const release = () => { const next = queue.shift(); if (next) next(); else active--; };

    const walk = async d => {
      await acquire();
      let listing;
      try { listing = await this.store.list(d, '1'); } finally { release(); }
      const seen = new Set();
      const todo = [];
      for (const e of listing) {
        if (e.path === d || !visible(e.path) || parentOf(e.path) !== d) continue;
        seen.add(e.path);
        let old = this.entries.get(e.path);
        if (old && old.d !== e.isDir) { this._dropSubtree(e.path); old = null; }
        if (e.isDir && (!old || old.e !== e.etag)) {
          todo.push(e);
          // ETag stored only after the folder was listed completely
          this._setEntry({ ...e, etag: '' });
        } else this._setEntry(e);
      }
      for (const k of this._children(d)) if (!seen.has(k)) this._dropSubtree(k);
      await Promise.all(todo.map(async e => { await walk(e.path); this.entries.get(e.path).e = e.etag; }));
    };
    await walk(folder);
  }

  async _fullScan() {
    let listing;
    try { listing = await this.store.list('', 'infinity'); }
    catch (err) {
      if (!(err instanceof StoreError) || err instanceof NotFound) throw err;
      // Server refuses Depth:infinity → walk every folder
      for (const [p] of this.entries) this.entries.get(p).d && (this.entries.get(p).e = '');
      return this._walk('');
    }
    const seen = new Set();
    for (const e of listing) {
      if (!visible(e.path)) continue;
      seen.add(e.path);
      const old = this.entries.get(e.path);
      if (old && old.d !== e.isDir) this._dropSubtree(e.path);
      this._setEntry(e);
    }
    for (const k of [...this.entries.keys()]) if (!seen.has(k)) this._dropSubtree(k);
  }

  _staleNotes() {
    return [...this.entries].filter(([p, e]) => !e.d && p.endsWith('.md') && !isAttachmentPath(p) && e.fe !== e.e).map(([p]) => p);
  }

  async _refreshNotes() {
    const stale = this._staleNotes();
    if (!stale.length) return false;
    await pool(stale, FETCH_CONCURRENCY, async p => {
      try { await this._read(p); } catch (err) { console.info(`notes ${this.board}: could not read ${p}:`, err.message); }
    });
    return true;
  }

  _applyNote(p, etag, text) {
    const rec = this.entries.get(p);
    if (!rec) return;
    const note = fm.parse(text);
    rec.fe = etag;
    rec.id = fm.noteId(note);
    rec.link = String(fm.get(note, 'link') || '');
    rec.lc = fm.linkedCards(note);
    rec.att = hasAttachmentLinks(note.body) || fm.has(note, 'attachments');
    rec.body = note.body;
    rec.head = text.slice(0, text.length - note.body.length);   // front matter block, verbatim
    rec.be = etag;
  }

  // ── reading / writing ────────────────────────────────────────

  /** Text of a note: conditional GET against the cached copy (usually 304). */
  async _read(p) {
    const rec = this.entries.get(p);
    const cached = rec && rec.body !== null && rec.body !== undefined && rec.be ? rec : null;
    let text, etag;
    try {
      const r = await this.store.get(p, cached ? cached.be : '');
      text = r.data.toString('utf8');
      etag = r.etag || (await this.store.stat(p))?.etag || '';
    } catch (err) {
      if (err instanceof NotModified) {
        etag = cached.be;
        text = (cached.head || '') + cached.body;
      } else {
        if (err instanceof NotFound && this.entries.has(p)) { this._dropSubtree(p); await this._bump(); }
        throw err;
      }
    }
    if (rec) {
      rec.e = etag;
      if (rec.fe !== etag || rec.be !== etag) this._applyNote(p, etag, text);
    }
    return { text, etag };
  }

  read(p) { return this._read(p); }

  /** Full text if the cached copy is at `etag`. */
  cachedText(p, etag) {
    const rec = this.entries.get(p);
    return rec && etag && rec.be === etag && rec.body !== null && rec.body !== undefined ? (rec.head || '') + rec.body : null;
  }

  async noteWritten(p, etag, text = null, size = 0) {
    const rec = this.entries.get(p) || { d: false };
    Object.assign(rec, { d: false, e: etag, m: new Date().toISOString(), s: size });
    this.entries.set(p, rec);
    if (text !== null && p.endsWith('.md')) this._applyNote(p, etag, text);
    this._ensureParents(p);
    return this._bump();
  }

  async folderCreated(p) {
    if (!this.entries.has(p)) this.entries.set(p, { d: true, e: '', m: '', s: 0 });
    this._ensureParents(p);
    return this._bump();
  }

  _ensureParents(p) {
    for (let q = parentOf(p); q; q = parentOf(q))
      if (!this.entries.has(q)) this.entries.set(q, { d: true, e: '', m: '', s: 0 });
  }

  async removed(p) {
    this._dropSubtree(p);
    return this._bump();
  }

  async moved(src, dst) {
    const prefix = src + '/';
    for (const k of [...this.entries.keys()]) {
      if (k !== src && !k.startsWith(prefix)) continue;
      const nk = dst + k.slice(src.length);
      this.entries.set(nk, this.entries.get(k));
      this.entries.delete(k);
    }
    this._ensureParents(dst);
    return this._bump();
  }

  // ── queries ──────────────────────────────────────────────────

  exists(p) { return this.entries.has(p); }
  entry(p) { return this.entries.get(p) || null; }

  /** Path of an id: the tree id, a page's front matter id or the path-derived id
   *  ("n-"/"f-" + hash) — all stay valid, so an id a client got before the front
   *  matter was read still works afterwards. */
  pathOf(id) {
    if (!id) return null;
    for (const [p, e] of this.entries) {
      if (isAttachmentPath(p)) continue;
      if (e.d ? id === 'f-' + hash12(p) : p.endsWith('.md') && (id === 'n-' + hash12(p) || (e.id && e.id === id))) return p;
    }
    return null;
  }

  idOf(p) {
    const find = items => {
      for (const it of items) {
        if (String(it.wdPath).replace(/\/$/, '') === p) return it.id;
        if (it.type === 'folder') { const r = find(it.children); if (r) return r; }
      }
      return null;
    };
    return find(this.document().items);
  }

  filesIn(folder) { return [...this.entries].filter(([k, e]) => !e.d && parentOf(k) === folder).map(([k]) => k).sort(); }

  findFile(name, near = '') {
    name = nameOf(String(name || '').trim());
    if (!name) return null;
    for (const c of [joinPath(near, name), joinPath(near, ATTACH_DIR, name)]) {
      const e = this.entries.get(c);
      if (e && !e.d) return c;
    }
    const hits = [...this.entries].filter(([k, e]) => !e.d && nameOf(k) === name).map(([k]) => k)
      .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
    return hits[0] || null;
  }

  allNotePaths() {
    return [...this.entries].filter(([p, e]) => !e.d && p.endsWith('.md') && !isAttachmentPath(p)).map(([p]) => p).sort();
  }
}

module.exports = { BoardNotesIndex, ATTACH_DIR, visible, isAttachmentPath };
