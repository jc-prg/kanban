'use strict'
/**
 * In-memory WebDAV server as a fetch() replacement for notes tests.
 * Real ETags, If-Match / If-None-Match / Overwrite, MKCOL needs an existing
 * parent, PROPFIND Depth 0/1/infinity. `propagate: true` behaves like
 * Nextcloud: oc:fileid is reported and folder ETags change whenever anything
 * below them changes.
 *
 *   const dav = createFakeDav({ base: 'http://dav.test/' })
 *   vi.stubGlobal('fetch', dav.fetch)
 *   dav.write('Folder/Note.md', '---\nid: n-1\n---\nText')   // change "from outside"
 */

function createFakeDav({ base = 'http://dav.test/', propagate = false } = {}) {
  const basePath = new URL(base).pathname
  const files = new Map()            // path → { data: Buffer, etag, mtime }
  const dirs  = new Map([['', { etag: 'd0' }]])
  const requests = []
  let n = 0
  const etag = () => `e${++n}`
  const parentOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

  function touch(p) {
    // Folder ETags: the parent always, with propagate all ancestors up to the root
    for (let q = parentOf(p); ; q = parentOf(q)) {
      if (dirs.has(q)) dirs.get(q).etag = etag()
      if (!propagate || q === '') break
    }
  }

  function rel(url) {
    let p = decodeURIComponent(new URL(url, base).pathname)
    if (p.startsWith(basePath)) p = p.slice(basePath.length)
    return p.replace(/^\/+|\/+$/g, '')
  }

  const enc = p => basePath + p.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  function propEntry(p, isDir) {
    const e = isDir ? dirs.get(p) : files.get(p)
    const href = enc(p) + (isDir && p ? '/' : '')
    return `<d:response><d:href>${xmlEsc(href || basePath)}</d:href><d:propstat><d:prop>` +
      `<d:getetag>"${e.etag}"</d:getetag>` +
      `<d:getlastmodified>${(isDir ? new Date(0) : e.mtime).toUTCString()}</d:getlastmodified>` +
      (isDir ? '' : `<d:getcontentlength>${e.data.length}</d:getcontentlength>`) +
      `<d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>` +
      (propagate ? `<oc:fileid>${Math.abs(hashCode(p))}</oc:fileid>` : '') +
      `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  }
  const hashCode = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)

  const res = (status, body = '', headers = {}) => new Response(status === 304 || status === 204 ? null : body, { status, headers })

  function isUnder(p, root) { return root === '' ? true : p === root || p.startsWith(root + '/') }

  async function fetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase()
    const h = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    const p = rel(url)
    requests.push({ method, path: p, headers: h })
    const failed = api.fail && api.fail(method, p)   // true → 500, a number → that status
    if (failed) return res(typeof failed === 'number' ? failed : 500)
    const ifMatch = (h['if-match'] || '').replace(/"/g, '')
    const ifNone  = h['if-none-match'] || ''

    if (method === 'PROPFIND') {
      const depth = h.depth || 'infinity'
      if (files.has(p)) return res(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${propEntry(p, false)}</d:multistatus>`)
      if (!dirs.has(p)) return res(404)
      let body = propEntry(p, true)
      if (depth !== '0') {
        const direct = q => parentOf(q) === p
        const take = q => q !== p && isUnder(q, p) && (depth === 'infinity' || direct(q))
        for (const d of [...dirs.keys()].filter(take).sort()) body += propEntry(d, true)
        for (const f of [...files.keys()].filter(take).sort()) body += propEntry(f, false)
      }
      return res(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${body}</d:multistatus>`)
    }
    if (method === 'GET') {
      const f = files.get(p)
      if (!f) return res(404)
      if (ifNone && ifNone.replace(/"/g, '') === f.etag) return res(304, '', { ETag: `"${f.etag}"` })
      return res(200, f.data, { ETag: `"${f.etag}"` })
    }
    if (method === 'PUT') {
      const f = files.get(p)
      if (ifMatch && (!f || f.etag !== ifMatch)) return res(412)
      if (ifNone === '*' && f) return res(412)
      if (!dirs.has(parentOf(p))) return res(409)
      const data = Buffer.from(opts.body instanceof Uint8Array ? opts.body : String(opts.body ?? ''))
      const e = etag()
      files.set(p, { data, etag: e, mtime: new Date() })
      touch(p)
      return res(f ? 204 : 201, '', { ETag: `"${e}"` })
    }
    if (method === 'MKCOL') {
      if (dirs.has(p) || files.has(p)) return res(405)
      if (!dirs.has(parentOf(p))) return res(409)
      dirs.set(p, { etag: etag() })
      touch(p)
      return res(201)
    }
    if (method === 'DELETE') {
      if (files.delete(p)) { touch(p); return res(204) }
      if (!dirs.has(p) || p === '') return res(404)
      for (const k of [...dirs.keys()]) if (isUnder(k, p)) dirs.delete(k)
      for (const k of [...files.keys()]) if (isUnder(k, p)) files.delete(k)
      touch(p)
      return res(204)
    }
    if (method === 'MOVE') {
      const dst = rel(h.destination)
      const exists = files.has(dst) || dirs.has(dst)
      if (exists && h.overwrite === 'F') return res(412)
      if (!dirs.has(parentOf(dst))) return res(409)
      if (files.has(p)) {
        files.set(dst, files.get(p)); files.delete(p)
      } else if (dirs.has(p)) {
        for (const k of [...dirs.keys()].filter(k => isUnder(k, p)).sort()) { dirs.set(dst + k.slice(p.length), dirs.get(k)); dirs.delete(k) }
        for (const k of [...files.keys()].filter(k => isUnder(k, p))) { files.set(dst + k.slice(p.length), files.get(k)); files.delete(k) }
      } else return res(404)
      touch(p); touch(dst)
      return res(exists ? 204 : 201)
    }
    return res(405)
  }

  const api = {
    fetch, requests, files, dirs, fail: null,
    /** Change a file "from outside" (Obsidian, another app). */
    write(p, text) {
      for (let q = parentOf(p), chain = []; ; q = parentOf(q)) {
        chain.unshift(q)
        if (q === '') { for (const d of chain) if (!dirs.has(d)) { dirs.set(d, { etag: etag() }); touch(d) } break }
      }
      files.set(p, { data: Buffer.from(text), etag: etag(), mtime: new Date() })
      touch(p)
    },
    read(p) { return files.get(p)?.data.toString('utf8') },
    remove(p) { files.delete(p); touch(p) },
    rename(from, to) { return fetch(base + from, { method: 'MOVE', headers: { Destination: base + to, Overwrite: 'F' } }) },
    count(method) { return requests.filter(r => r.method === method).length },
    reset() { files.clear(); dirs.clear(); dirs.set('', { etag: 'd0' }); requests.length = 0; api.fail = null },
  }
  return api
}

module.exports = { createFakeDav }
