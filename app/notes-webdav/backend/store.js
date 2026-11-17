'use strict';

/**
 * WebDAV file store for notes. The files on the server are the only source of
 * truth; this module only talks HTTP. Paths are relative to the notes root,
 * use "/" as separator and carry no leading or trailing slash.
 *
 * Node's built-in fetch keeps connections alive, so each operation costs one
 * round trip instead of a new TCP/TLS handshake.
 */

class StoreError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
class NotFound extends StoreError {
  constructor(message) { super(message, 404); }
}
/** If-Match / If-None-Match / Overwrite:F did not hold (HTTP 412). */
class PreconditionFailed extends StoreError {
  constructor(message) { super(message, 412); }
}
/** GET with If-None-Match matched (HTTP 304). */
class NotModified extends Error {}

// Writes answered with 423 Locked are retried after these pauses (ms). Nextcloud locks a file while another
// request reads / writes it or its desktop client syncs it — usually for a moment. Tests shorten them.
const LOCK_RETRY_MS = [300, 1000, 2500];
const WRITE_METHODS = new Set(['PUT', 'MOVE', 'DELETE', 'MKCOL']);

function normEtag(v) {
  let s = String(v || '').trim();
  if (s.startsWith('W/')) s = s.slice(2);
  return s.replace(/^"|"$/g, '');
}

/** Normalize a client-supplied relative path; rejects anything leaving the root. */
function cleanPath(p) {
  const s = String(p || '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return '';
  const parts = s.split('/');
  if (parts.some(seg => seg === '' || seg === '.' || seg === '..' || seg.includes('\0')))
    throw Object.assign(new Error(`Invalid path: ${p}`), { status: 400 });
  return s;
}

const parentOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf   = p => p.slice(p.lastIndexOf('/') + 1);
const joinPath = (...parts) => parts.map(x => String(x || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
  '<d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:resourcetype/><oc:fileid/></d:prop>' +
  '</d:propfind>';

function _decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
const _tagRe = tag => new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'gi');
const _first = (xml, tag) => { const m = _tagRe(tag).exec(xml); return m ? m[1] : null; };
const _all   = (xml, tag) => [...xml.matchAll(_tagRe(tag))].map(m => m[1]);

class WebdavStore {
  constructor({ url, user = '', password = '', timeoutMs = 30000 }) {
    this.baseUrl  = url.endsWith('/') ? url : url + '/';
    this.basePath = decodeURIComponent(new URL(this.baseUrl).pathname);
    this.headers  = (user || password)
      ? { Authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64') }
      : {};
    this.timeoutMs = timeoutMs;
    // Nextcloud/ownCloud propagate folder ETags upwards (detected by oc:fileid)
    this.propagatesEtags = false;
    this._detected = false;
  }

  _url(p, isDir = false) {
    if (!p) return this.baseUrl;
    return this.baseUrl + p.split('/').map(encodeURIComponent).join('/') + (isDir ? '/' : '');
  }

  _rel(href) {
    let p;
    try { p = decodeURIComponent(new URL(href, this.baseUrl).pathname); } catch { p = href; }
    if (p.startsWith(this.basePath)) p = p.slice(this.basePath.length);
    else if (p.replace(/\/$/, '') + '/' === this.basePath) p = '';
    return p.replace(/^\/+|\/+$/g, '');
  }

  async _fetch(method, url, { headers = {}, body } = {}) {
    const pauses = WRITE_METHODS.has(method) ? module.exports.LOCK_RETRY_MS : [];
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(url, {
          method, body, headers: { ...this.headers, ...headers },
          redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const msg = err.name === 'TimeoutError' ? `timeout after ${this.timeoutMs / 1000} s` : (err.cause?.message || err.message);
        throw new StoreError(`${method} failed: ${msg}`);
      }
      // 423 Locked: the file is in use on the server for a moment — try again
      if (r.status !== 423 || attempt >= pauses.length) return r;
      await r.arrayBuffer().catch(() => {});
      await new Promise(res => setTimeout(res, pauses[attempt]));
    }
  }

  _raise(r, what) {
    if (r.status === 404) throw new NotFound(`${what}: not found`);
    if (r.status === 412) throw new PreconditionFailed(`${what}: changed meanwhile or already exists`);
    if (r.status === 401 || r.status === 403) throw new StoreError(`${what}: access denied (HTTP ${r.status})`);
    if (r.status === 423) throw new StoreError(`${what}: the file is locked on the server (in use by another program or sync client, e.g. Nextcloud desktop or Obsidian) — try again in a moment`, 423);
    throw new StoreError(`${what}: HTTP ${r.status}`);
  }

  /** Entries at `p` (the folder itself included) down to `depth` ("0", "1", "infinity"). */
  async list(p, depth = '1') {
    const r = await this._fetch('PROPFIND', this._url(p, depth !== '0'), {
      headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY,
    });
    if (r.status !== 207) this._raise(r, `PROPFIND ${p || '/'}`);
    return this._parse(await r.text());
  }

  _parse(xml) {
    const out = [];
    let sawFileid = false;
    for (const resp of _all(xml, 'response')) {
      const href = _decodeXml((_first(resp, 'href') || '').trim());
      const ok = _all(resp, 'propstat').find(ps => / 200 /.test(_first(ps, 'status') || ''));
      if (!ok) continue;
      const prop = _first(ok, 'prop') || '';
      const isDir = /<(?:[\w-]+:)?collection\s*\/?>/i.test(_first(prop, 'resourcetype') || '') ||
                    /<(?:[\w-]+:)?resourcetype[^>]*>\s*<(?:[\w-]+:)?collection/i.test(prop);
      if ((_first(prop, 'fileid') || '').trim()) sawFileid = true;
      const lm = (_first(prop, 'getlastmodified') || '').trim();
      const d = lm ? new Date(lm) : null;
      const size = parseInt((_first(prop, 'getcontentlength') || '0').trim(), 10);
      out.push({
        path: this._rel(href), isDir,
        etag: normEtag(_decodeXml(_first(prop, 'getetag') || '')),
        mtime: d && !isNaN(d) ? d.toISOString() : '',
        size: Number.isFinite(size) ? size : 0,
      });
    }
    if (!this._detected) { this.propagatesEtags = sawFileid; this._detected = true; }
    return out;
  }

  async stat(p) {
    try {
      const entries = await this.list(p, '0');
      return entries.find(e => e.path === p) || entries[0] || null;
    } catch (err) {
      if (err instanceof NotFound) return null;
      throw err;
    }
  }

  /** Returns { data: Buffer, etag }. Throws NotModified / NotFound. */
  async get(p, ifNoneMatch = '') {
    const r = await this._fetch('GET', this._url(p), { headers: ifNoneMatch ? { 'If-None-Match': `"${ifNoneMatch}"` } : {} });
    if (r.status === 304) throw new NotModified();
    if (!r.ok) this._raise(r, `GET ${p}`);
    return { data: Buffer.from(await r.arrayBuffer()), etag: normEtag(r.headers.get('oc-etag') || r.headers.get('etag')) };
  }

  /** Writes the file, returns its new ETag. Throws PreconditionFailed. */
  async put(p, data, { contentType = 'application/octet-stream', ifMatch = '', createOnly = false } = {}) {
    const headers = { 'Content-Type': contentType };
    if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
    if (createOnly) headers['If-None-Match'] = '*';
    const r = await this._fetch('PUT', this._url(p), { headers, body: data });
    if (!r.ok) this._raise(r, `PUT ${p}`);
    let etag = normEtag(r.headers.get('oc-etag') || r.headers.get('etag'));
    if (!etag) etag = (await this.stat(p))?.etag || '';
    return etag;
  }

  async move(src, dst, { overwrite = false } = {}) {
    const st = await this.stat(src);
    if (!st) throw new NotFound(`MOVE ${src}: not found`);
    const r = await this._fetch('MOVE', this._url(src, st.isDir), {
      headers: { Destination: this._url(dst, st.isDir), Overwrite: overwrite ? 'T' : 'F' },
    });
    if (!r.ok) this._raise(r, `MOVE ${src} → ${dst}`);
  }

  async mkdirs(p) {
    if (!p) return;
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      const r = await this._fetch('MKCOL', this._url(sub, true));
      if (!r.ok && r.status !== 405) this._raise(r, `MKCOL ${sub}`);   // 405 = exists
    }
  }

  async delete(p) {
    const st = await this.stat(p);
    if (!st) return;
    const r = await this._fetch('DELETE', this._url(p, st.isDir));
    if (!r.ok && r.status !== 404) this._raise(r, `DELETE ${p}`);
  }
}

module.exports = {
  WebdavStore, StoreError, NotFound, PreconditionFailed, NotModified, LOCK_RETRY_MS,
  normEtag, cleanPath, parentOf, nameOf, joinPath,
};
