'use strict'
/**
 * Notes per-operation API tests — section 1.7
 * WC-1..5  WebDAV config
 * NP-1..14 Page operations
 * NF-1..7  Folder operations
 * NS-1..4  Sync
 */

const os   = require('os')
const path = require('path')
const fs   = require('fs')

// ---------------------------------------------------------------------------
// Config mock — inject BEFORE any backend module loads
// ---------------------------------------------------------------------------
const TEST_DIR   = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-notes-ops-'))
const ATTACH_DIR = path.join(TEST_DIR, 'attachments')

const CONFIG_MODULE = path.resolve(__dirname, '../../backend/config.js')
require.cache[CONFIG_MODULE] = {
  id: CONFIG_MODULE, filename: CONFIG_MODULE, loaded: true,
  children: [], paths: [],
  exports: {
    PORT: 3000, HOST: 'localhost',
    APP_PASSWORD: 'test-password',
    SESSION_SECRET: 'test-session-secret-32-chars-ok!',
    SESSION_MAX_AGE_MS: 604800000,
    API_KEY: 'test-api-key-that-is-32chars-long!',
    COUCHDB_HOST: 'localhost', COUCHDB_PORT: 5984,
    COUCHDB_USER: 'kanban', COUCHDB_PASSWORD: 'kanban-pwd',
    DB_PREFIX: 'jc-kanban-', DOC_ID: 'board', NOTES_DOC_ID: 'notes',
    PROMPTS_DB_NAME: 'jc-extension-prompts',
    BACKUP_DIR: TEST_DIR, BACKUP_INTERVAL_MS: 600000,
    ATTACHMENTS_DIR: ATTACH_DIR,
    JSON_BACKUP_DIR: path.join(TEST_DIR, 'json'),
    COUCHDB_DATA_DIR: path.join(TEST_DIR, 'couchdb'),
    LOG_API_RESPONSES: false, DB_SIZE_INTERVAL_MS: 900000,
  },
}

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

const request       = require('supertest')
const { createApp } = require('../setup/createApp')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WD_URL = 'http://dav.test/'

/** Make an in-memory db mock. webdav: null → no config doc (WebDAV disabled). */
function makeDb({ notes = null, webdav = null } = {}) {
  let notesDoc  = notes  ? { _id: 'notes',         _rev: '1-n',    ...notes  } : null
  let webdavDoc = webdav ? { _id: 'webdav-config', _rev: '1-wdcfg', ...webdav } : null

  return {
    get: vi.fn(async (id) => {
      if (id === 'notes') {
        if (!notesDoc) throw Object.assign(new Error('missing'), { statusCode: 404 })
        return JSON.parse(JSON.stringify(notesDoc))
      }
      if (id === 'webdav-config') {
        if (!webdavDoc) throw Object.assign(new Error('missing'), { statusCode: 404 })
        return JSON.parse(JSON.stringify(webdavDoc))
      }
      if (id === 'board') return { _id: 'board', _rev: '1-b', columns: [] }
      throw Object.assign(new Error('missing'), { statusCode: 404 })
    }),
    insert: vi.fn(async (data) => {
      if (data._id === 'notes')         notesDoc  = { ...JSON.parse(JSON.stringify(data)), _rev: '2-n' }
      if (data._id === 'webdav-config') webdavDoc = { ...JSON.parse(JSON.stringify(data)), _rev: '2-wdcfg' }
      return { ok: true, id: data._id, rev: '2-abc' }
    }),
    lastNotes:  () => notesDoc,
    lastWebdav: () => webdavDoc,
  }
}

const WD_CFG = { enabled: true, url: WD_URL, user: 'u', password: 'p' }

const PAGE = { type: 'page', id: 'n-testpage', title: 'Test Page',
  description: 'Hello', link: '', linkedCards: [],
  lastModified: '2026-05-16T10:00:00.000Z' }

const FOLDER = { type: 'folder', id: 'f-testfolder', title: 'Test Folder', children: [] }

const NOTES_EMPTY   = { items: [], schemaVersion: 2 }
const NOTES_PAGE    = { items: [{ ...PAGE }], schemaVersion: 2 }
const NOTES_FOLDER  = { items: [{ ...FOLDER }], schemaVersion: 2 }
const NOTES_FOLDER_WITH_PAGE = {
  items: [{ ...FOLDER, children: [{ ...PAGE }] }],
  schemaVersion: 2,
}

function fetchOk(status = 200, text = '') {
  return { ok: true, status, text: async () => text }
}
function fetchFail(status = 500) {
  return { ok: false, status, text: async () => '' }
}

/** Build a PROPFIND multi-status XML blob. entries = [{ href, collection?, lastModified?, size? }] */
function propfindXml(entries, baseHref = WD_URL) {
  const toResp = (e) => `
  <D:response>
    <D:href>${e.href}</D:href>
    <D:propstat><D:prop>
      <D:resourcetype>${e.collection ? '<D:collection/>' : ''}</D:resourcetype>
      <D:getlastmodified>${e.lastModified || 'Fri, 16 May 2026 10:00:00 GMT'}</D:getlastmodified>
      <D:getcontentlength>${e.size ?? 100}</D:getcontentlength>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>`
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${baseHref}</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype>
      <D:getlastmodified>Fri, 16 May 2026 10:00:00 GMT</D:getlastmodified>
      <D:getcontentlength>0</D:getcontentlength>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  ${entries.map(toResp).join('')}
</D:multistatus>`
}

function mdContent(id = 'n-wd-new', title = 'New', body = 'body') {
  return `---\nid: ${id}\ntitle: "${title}"\nlastModified: 2026-05-16T10:00:00.000Z\n---\n\n${body}`
}

// ---------------------------------------------------------------------------
// Global fetch mock (intercepts WebDAV HTTP calls)
// ---------------------------------------------------------------------------
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ---------------------------------------------------------------------------
// App + shared db context
// ---------------------------------------------------------------------------
const mockDbCtx = { db: null }

const dbMock = {
  getCouch:      () => ({}),
  validBoardName: (n) =>
    typeof n === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(n) && n.length <= 64 && n !== 'inbox',
  getBoardDb:   async () => mockDbCtx.db,
  loadBoardData: async (db) => { const { _id, _rev, ...d } = await db.get('board'); return d },
  saveBoardData: async (db, data) => db.insert({ _id: 'board', ...data }),
  loadNotesData: async (db) => {
    try { const { _id, _rev, ...d } = await db.get('notes'); return d }
    catch (e) { if (e.statusCode === 404) return { items: [], schemaVersion: 2 }; throw e }
  },
  saveNotesData: async (db, data) => {
    let rev
    try { ({ _rev: rev } = await db.get('notes')) } catch (_) {}
    return db.insert({ _id: 'notes', ...(rev ? { _rev: rev } : {}), ...data })
  },
  withBoard: (h) => async (req, res) => {
    const n = req.params.board
    if (!/^[a-z0-9][a-z0-9-]*$/.test(n) || n.length > 64 || n === 'inbox')
      return res.status(400).json({ error: 'Invalid board name' })
    if (!mockDbCtx.db) return res.status(500).json({ error: 'No mock db' })
    try { await h(req, res, mockDbCtx.db) } catch (e) { res.status(500).json({ error: e.message }) }
  },
  withExistingBoard: (h) => async (req, res) => {
    const n = req.params.board
    if (!/^[a-z0-9][a-z0-9-]*$/.test(n) || n.length > 64 || n === 'inbox')
      return res.status(400).json({ error: 'Invalid board name' })
    if (!mockDbCtx.db) return res.status(404).json({ error: 'Board not found' })
    try { await h(req, res, mockDbCtx.db) } catch (e) { res.status(500).json({ error: e.message }) }
  },
  initDb: async () => {},
}

const app  = createApp(dbMock)
const AUTH = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }
const B    = 'test-board'

afterAll(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch (_) {} })
beforeEach(() => { mockFetch.mockReset() })

// ===========================================================================
// WC — WebDAV Config
// ===========================================================================

describe('GET /:board/webdav-config', () => {
  it('WC-1a: no config stored → returns safe defaults, hasPassword: false', async () => {
    mockDbCtx.db = makeDb()
    const res = await request(app).get(`/api/${B}/webdav-config`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ enabled: false, url: '', user: '', hasPassword: false })
    expect(res.body.password).toBeUndefined()
  })

  it('WC-1b: config stored with password → hasPassword: true, no password field', async () => {
    mockDbCtx.db = makeDb({ webdav: { ...WD_CFG } })
    const res = await request(app).get(`/api/${B}/webdav-config`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
    expect(res.body.hasPassword).toBe(true)
    expect(res.body.password).toBeUndefined()
  })
})

describe('PUT /:board/webdav-config', () => {
  it('WC-2: saves config; re-GET confirms values (no password in response)', async () => {
    mockDbCtx.db = makeDb()
    const putRes = await request(app)
      .put(`/api/${B}/webdav-config`).set(AUTH)
      .send({ enabled: true, url: 'http://my-dav/', user: 'alice', password: 's3cr3t' })
    expect(putRes.status).toBe(200)
    expect(putRes.body.ok).toBe(true)

    // Verify stored (simulate re-GET via db state)
    const stored = mockDbCtx.db.lastWebdav()
    expect(stored.enabled).toBe(true)
    expect(stored.url).toBe('http://my-dav/')
    expect(stored.user).toBe('alice')
    expect(stored.password).toBe('s3cr3t')
  })
})

describe('POST /:board/webdav-config/test', () => {
  it('WC-3: server returns 207 → ok: true', async () => {
    mockDbCtx.db = makeDb()
    mockFetch.mockResolvedValueOnce({ ok: true, status: 207 })
    const res = await request(app)
      .post(`/api/${B}/webdav-config/test`).set(AUTH)
      .send({ url: WD_URL })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('WC-4: server returns 401 → ok: false, auth error message', async () => {
    mockDbCtx.db = makeDb()
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    const res = await request(app)
      .post(`/api/${B}/webdav-config/test`).set(AUTH)
      .send({ url: WD_URL })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/auth/i)
  })

  it('WC-5: connection times out → ok: false, timeout message', async () => {
    mockDbCtx.db = makeDb()
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('abort'), { name: 'AbortError' }))
    const res = await request(app)
      .post(`/api/${B}/webdav-config/test`).set(AUTH)
      .send({ url: WD_URL })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/timed? ?out/i)
  })
})

// ===========================================================================
// NP — Page operations
// ===========================================================================

describe('POST /:board/notes/pages', () => {
  it('NP-1: create root-level page → page in returned notes; WebDAV PUT called', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_EMPTY })
    mockFetch.mockResolvedValueOnce(fetchOk(201)) // PUT
    const res = await request(app)
      .post(`/api/${B}/notes/pages`).set(AUTH)
      .send({ page: { id: 'n-new1', title: 'New Page', description: '', link: '', linkedCards: [] } })
    expect(res.status).toBe(200)
    expect(res.body.notes.items.some(i => i.id === 'n-new1')).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(opts.method).toBe('PUT')
  })

  it('NP-2: create page inside folder → page in folder children; MKCOL + PUT called', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_FOLDER })
    mockFetch
      .mockResolvedValueOnce(fetchOk(405)) // MKCOL (405 = already exists, tolerated)
      .mockResolvedValueOnce(fetchOk(201)) // PUT
    const res = await request(app)
      .post(`/api/${B}/notes/pages`).set(AUTH)
      .send({ page: { id: 'n-child', title: 'Child Page', description: '', link: '', linkedCards: [] }, parentId: 'f-testfolder' })
    expect(res.status).toBe(200)
    const folder = res.body.notes.items.find(i => i.id === 'f-testfolder')
    expect(folder.children.some(c => c.id === 'n-child')).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][1].method).toBe('MKCOL')
    expect(mockFetch.mock.calls[1][1].method).toBe('PUT')
  })

  it('NP-3: duplicate page id → 409, no WebDAV call', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    const res = await request(app)
      .post(`/api/${B}/notes/pages`).set(AUTH)
      .send({ page: { id: 'n-testpage', title: 'Dup' } })
    expect(res.status).toBe(409)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('PATCH /:board/notes/pages/:id', () => {
  it('NP-4: title change → WebDAV MOVE + PUT; new title in returned notes', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    mockFetch
      .mockResolvedValueOnce(fetchOk(201)) // MOVE
      .mockResolvedValueOnce(fetchOk(200)) // PUT
    const res = await request(app)
      .patch(`/api/${B}/notes/pages/n-testpage`).set(AUTH)
      .send({ title: 'Renamed Page', description: 'Hello' })
    expect(res.status).toBe(200)
    const page = res.body.notes.items.find(i => i.id === 'n-testpage')
    expect(page.title).toBe('Renamed Page')
    expect(mockFetch.mock.calls[0][1].method).toBe('MOVE')
    expect(mockFetch.mock.calls[1][1].method).toBe('PUT')
  })

  it('NP-5: content change only (same title) → only PUT, no MOVE', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    mockFetch.mockResolvedValueOnce(fetchOk(200)) // PUT
    const res = await request(app)
      .patch(`/api/${B}/notes/pages/n-testpage`).set(AUTH)
      .send({ title: 'Test Page', description: 'Updated body' })
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][1].method).toBe('PUT')
    const page = res.body.notes.items.find(i => i.id === 'n-testpage')
    expect(page.description).toBe('Updated body')
  })

  it('NP-6: unknown page id → 404', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    const res = await request(app)
      .patch(`/api/${B}/notes/pages/n-doesnotexist`).set(AUTH)
      .send({ title: 'X' })
    expect(res.status).toBe(404)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('DELETE /:board/notes/pages/:id', () => {
  it('NP-7: delete page → page removed from notes; WebDAV DELETE called', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    mockFetch.mockResolvedValueOnce(fetchOk(204)) // DELETE
    const res = await request(app)
      .delete(`/api/${B}/notes/pages/n-testpage`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.notes.items.find(i => i.id === 'n-testpage')).toBeUndefined()
    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE')
  })

  it('NP-8: WebDAV DELETE fails → 500; page NOT removed from CouchDB', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    mockFetch.mockResolvedValueOnce(fetchFail(500)) // DELETE fails
    const res = await request(app)
      .delete(`/api/${B}/notes/pages/n-testpage`).set(AUTH)
    expect(res.status).toBe(500)
    // CouchDB insert (save) should NOT have been called
    expect(mockDbCtx.db.insert).not.toHaveBeenCalled()
  })
})

describe('POST /:board/notes/pages/:id/move', () => {
  it('NP-9: move page from root into folder → page in folder children; MKCOL + MOVE called', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: {
      items: [{ ...PAGE }, { ...FOLDER }],
      schemaVersion: 2,
    }})
    mockFetch
      .mockResolvedValueOnce(fetchOk(405)) // MKCOL
      .mockResolvedValueOnce(fetchOk(201)) // MOVE
    const res = await request(app)
      .post(`/api/${B}/notes/pages/n-testpage/move`).set(AUTH)
      .send({ folderId: 'f-testfolder' })
    expect(res.status).toBe(200)
    const folder = res.body.notes.items.find(i => i.id === 'f-testfolder')
    expect(folder.children.some(c => c.id === 'n-testpage')).toBe(true)
    expect(res.body.notes.items.find(i => i.id === 'n-testpage' && i.type === 'page')).toBeUndefined()
    expect(mockFetch.mock.calls[0][1].method).toBe('MKCOL')
    expect(mockFetch.mock.calls[1][1].method).toBe('MOVE')
  })

  it('NP-10: move page from folder to root → page at root; MOVE called', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_FOLDER_WITH_PAGE })
    mockFetch.mockResolvedValueOnce(fetchOk(201)) // MOVE (no MKCOL — root has no dir prefix)
    const res = await request(app)
      .post(`/api/${B}/notes/pages/n-testpage/move`).set(AUTH)
      .send({ folderId: null })
    expect(res.status).toBe(200)
    const rootPage = res.body.notes.items.find(i => i.id === 'n-testpage')
    expect(rootPage).toBeDefined()
    expect(mockFetch.mock.calls[0][1].method).toBe('MOVE')
  })

  it('NP-11: reorder two root pages (before/after) → order changed in CouchDB; no WebDAV MOVE', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: {
      items: [
        { type: 'page', id: 'n-p1', title: 'Alpha', linkedCards: [] },
        { type: 'page', id: 'n-p2', title: 'Beta',  linkedCards: [] },
      ],
      schemaVersion: 2,
    }})
    // n-p2 moved before n-p1
    const res = await request(app)
      .post(`/api/${B}/notes/pages/n-p2/move`).set(AUTH)
      .send({ folderId: null, targetId: 'n-p1', position: 'before' })
    expect(res.status).toBe(200)
    const ids = res.body.notes.items.map(i => i.id)
    expect(ids).toEqual(['n-p2', 'n-p1'])
    // WebDAV paths are identical (same root) → no MOVE should have been triggered
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('GET /:board/notes/pages/:id/content', () => {
  it('NP-12: WebDAV enabled → 200 { content, lastModified }', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    const md = mdContent('n-testpage', 'Test Page', 'Page body here')
    mockFetch.mockResolvedValueOnce(fetchOk(200, md)) // GET
    const res = await request(app)
      .get(`/api/${B}/notes/pages/n-testpage/content`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('Page body here')
    expect(res.body.lastModified).toBeTruthy()
  })

  it('NP-13: WebDAV disabled → 400', async () => {
    mockDbCtx.db = makeDb({ notes: NOTES_PAGE }) // no webdav
    const res = await request(app)
      .get(`/api/${B}/notes/pages/n-testpage/content`).set(AUTH)
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('GET /:board/notes/pages/:id/meta', () => {
  it('NP-14: returns { lastModified, size } from WebDAV PROPFIND', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    const xml = propfindXml([{
      href: `${WD_URL}Test%20Page.md`,
      lastModified: 'Fri, 16 May 2026 10:00:00 GMT',
      size: 512,
    }])
    mockFetch.mockResolvedValueOnce(fetchOk(207, xml)) // PROPFIND Depth:0
    const res = await request(app)
      .get(`/api/${B}/notes/pages/n-testpage/meta`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.lastModified).toBeTruthy()
    expect(typeof res.body.size).toBe('number')
  })
})

// ===========================================================================
// NF — Folder operations
// ===========================================================================

describe('POST /:board/notes/folders', () => {
  it('NF-1: create root folder → folder in items; WebDAV MKCOL called', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_EMPTY })
    mockFetch.mockResolvedValueOnce(fetchOk(201)) // MKCOL
    const res = await request(app)
      .post(`/api/${B}/notes/folders`).set(AUTH)
      .send({ folder: { id: 'f-new1', title: 'My Folder', children: [] } })
    expect(res.status).toBe(200)
    expect(res.body.notes.items.some(i => i.id === 'f-new1' && i.type === 'folder')).toBe(true)
    expect(mockFetch.mock.calls[0][1].method).toBe('MKCOL')
  })

  it('NF-2: create nested folder inside another folder → subfolder in parent children', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_FOLDER })
    mockFetch.mockResolvedValueOnce(fetchOk(201)) // MKCOL
    const res = await request(app)
      .post(`/api/${B}/notes/folders`).set(AUTH)
      .send({ folder: { id: 'f-sub', title: 'Sub', children: [] }, parentId: 'f-testfolder' })
    expect(res.status).toBe(200)
    const parent = res.body.notes.items.find(i => i.id === 'f-testfolder')
    expect(parent.children.some(c => c.id === 'f-sub')).toBe(true)
  })
})

describe('PATCH /:board/notes/folders/:id', () => {
  it('NF-3: rename folder → WebDAV MOVE called; title and wdPath updated', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_FOLDER })
    mockFetch.mockResolvedValueOnce(fetchOk(201)) // MOVE
    const res = await request(app)
      .patch(`/api/${B}/notes/folders/f-testfolder`).set(AUTH)
      .send({ title: 'Renamed Folder' })
    expect(res.status).toBe(200)
    const folder = res.body.notes.items.find(i => i.id === 'f-testfolder')
    expect(folder.title).toBe('Renamed Folder')
    expect(folder.wdPath).toBe('Renamed Folder/')
    expect(mockFetch.mock.calls[0][1].method).toBe('MOVE')
  })

  it('NF-3b: wdPath on children updated after folder rename', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: {
      items: [{ ...FOLDER, children: [{ ...PAGE, wdPath: 'Test Folder/Test Page.md' }] }],
      schemaVersion: 2,
    }})
    mockFetch.mockResolvedValueOnce(fetchOk(201)) // MOVE
    const res = await request(app)
      .patch(`/api/${B}/notes/folders/f-testfolder`).set(AUTH)
      .send({ title: 'Renamed' })
    expect(res.status).toBe(200)
    const folder = res.body.notes.items.find(i => i.id === 'f-testfolder')
    expect(folder.children[0].wdPath).toBe('Renamed/Test Page.md')
  })
})

describe('DELETE /:board/notes/folders/:id', () => {
  it('NF-4: delete folder → removed from notes; WebDAV DELETE called', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_FOLDER })
    mockFetch.mockResolvedValueOnce(fetchOk(204)) // DELETE
    const res = await request(app)
      .delete(`/api/${B}/notes/folders/f-testfolder`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.notes.items.find(i => i.id === 'f-testfolder')).toBeUndefined()
    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE')
  })

  it('NF-5: WebDAV DELETE fails → 500; folder NOT removed from CouchDB', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_FOLDER })
    mockFetch.mockResolvedValueOnce(fetchFail(500))
    const res = await request(app)
      .delete(`/api/${B}/notes/folders/f-testfolder`).set(AUTH)
    expect(res.status).toBe(500)
    expect(mockDbCtx.db.insert).not.toHaveBeenCalled()
  })
})

describe('POST /:board/notes/folders/:id/move', () => {
  it('NF-6: move folder into another folder → MOVE called; folder nested under new parent', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: {
      items: [
        { type: 'folder', id: 'f-src', title: 'Source', children: [] },
        { type: 'folder', id: 'f-tgt', title: 'Target', children: [] },
      ],
      schemaVersion: 2,
    }})
    mockFetch.mockResolvedValueOnce(fetchOk(201)) // MOVE
    const res = await request(app)
      .post(`/api/${B}/notes/folders/f-src/move`).set(AUTH)
      .send({ parentId: 'f-tgt' })
    expect(res.status).toBe(200)
    const target = res.body.notes.items.find(i => i.id === 'f-tgt')
    expect(target.children.some(c => c.id === 'f-src')).toBe(true)
    expect(mockFetch.mock.calls[0][1].method).toBe('MOVE')
  })
})

describe('POST /:board/notes/folders/:id/sync', () => {
  it('NF-7: new file on WebDAV → page added to folder children', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_FOLDER })

    // PROPFIND Depth:1 on the folder — returns the folder + one new .md file
    const xml = propfindXml([
      { href: `${WD_URL}Test%20Folder/`, collection: true },
      { href: `${WD_URL}Test%20Folder/child.md`, size: 80 },
    ], WD_URL)
    mockFetch
      .mockResolvedValueOnce(fetchOk(207, xml))                     // PROPFIND
      .mockResolvedValueOnce(fetchOk(200, mdContent('n-c1', 'Child', 'hi'))) // GET child.md

    const res = await request(app)
      .post(`/api/${B}/notes/folders/f-testfolder/sync`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.changed).toBe(true)
    const folder = res.body.notes.items.find(i => i.id === 'f-testfolder')
    expect(folder.children.length).toBeGreaterThan(0)
    expect(folder.children[0].title).toBe('Child')
  })
})

// ===========================================================================
// NS — Sync
// ===========================================================================

describe('POST /:board/notes/sync', () => {
  it('NS-1: no body → full scan; new WD file added to tree', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_EMPTY })
    const xml = propfindXml([{ href: `${WD_URL}fresh.md`, size: 60 }])
    mockFetch
      .mockResolvedValueOnce(fetchOk(207, xml))                           // PROPFIND infinity
      .mockResolvedValueOnce(fetchOk(200, mdContent('n-fresh', 'Fresh'))) // GET
    const res = await request(app)
      .post(`/api/${B}/notes/sync`).set(AUTH)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.changed).toBe(true)
    expect(res.body.notes.items.some(i => i.title === 'Fresh')).toBe(true)
  })

  it('NS-2: { folderIds: [] } → lazy root-only sync; new root file discovered', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_EMPTY })
    const xml = propfindXml([{ href: `${WD_URL}lazy.md`, size: 40 }])
    mockFetch
      .mockResolvedValueOnce(fetchOk(207, xml))                          // PROPFIND Depth:1
      .mockResolvedValueOnce(fetchOk(200, mdContent('n-lazy', 'Lazy'))) // GET
    const res = await request(app)
      .post(`/api/${B}/notes/sync`).set(AUTH)
      .send({ folderIds: [] })
    expect(res.status).toBe(200)
    expect(res.body.changed).toBe(true)
    expect(res.body.notes.items.some(i => i.title === 'Lazy')).toBe(true)
  })

  it('NS-3: page in CouchDB absent from WebDAV → marked orphaned', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG, notes: NOTES_PAGE })
    // PROPFIND returns only the root collection — no files
    const xml = propfindXml([])
    mockFetch.mockResolvedValueOnce(fetchOk(207, xml))
    const res = await request(app)
      .post(`/api/${B}/notes/sync`).set(AUTH)
      .send({ folderIds: [] })
    expect(res.status).toBe(200)
    expect(res.body.changed).toBe(true)
    const page = res.body.notes.items.find(i => i.id === 'n-testpage')
    expect(page.orphaned).toBe(true)
  })

  it('NS-4: WebDAV disabled → 200 { ok: true, changed: false }, no fetch', async () => {
    mockDbCtx.db = makeDb({ notes: NOTES_PAGE }) // no webdav config
    const res = await request(app)
      .post(`/api/${B}/notes/sync`).set(AUTH)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.changed).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
