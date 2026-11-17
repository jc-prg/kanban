'use strict'
/**
 * Notes per-operation API tests — section 1.7
 * WC-1..5  WebDAV config
 * NP-*     Page operations   (WebDAV boards: files on the server are the truth)
 * NF-*     Folder operations
 * NS-*     Index / sync      (changes made outside the app, ETag propagation)
 * NA-*     Attachments next to the note
 * NM-*     Migration from the old DB tree
 *
 * WebDAV is an in-memory fake server (tests/setup/fakeDav.js) behind fetch().
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
// WebDAV global DB mock — injected before createApp so getWebdavDb() is wired
// ---------------------------------------------------------------------------
const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')
const mockWdStore = {}
const mockWdDb = {
  get:    async (id)   => {
    const doc = mockWdStore[id]
    if (!doc) throw Object.assign(new Error('missing'), { statusCode: 404 })
    return JSON.parse(JSON.stringify(doc))
  },
  insert: async (data) => {
    mockWdStore[data._id] = { ...JSON.parse(JSON.stringify(data)), _rev: '2-wdcfg' }
    return { ok: true, id: data._id, rev: '2-wdcfg' }
  },
}
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true,
  exports: {
    getDashboardConfig:   async () => ({ mailAccounts: [], cardSources: [], calendarAccounts: [], autoRefreshMs: 0 }),
    saveDashboardConfig:  async () => ({ ok: true }),
    initGlobalDb:         async () => {},
    getGlobalDb:          () => ({}),
    getWebdavDb:          () => mockWdDb,
    getWebdavAccounts:    async () => [{ id: 'acc-1', label: 'Test DAV', url: WD_URL, user: 'u', password: 'p' }],
    saveWebdavAccounts:   async () => ({ ok: true }),
  },
  children: [], paths: [],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WD_URL = 'http://dav.test/'

/** Make an in-memory db mock. webdav: null → no config doc (WebDAV disabled). */
function makeDb({ notes = null, webdav = null } = {}) {
  // WebDAV config lives in the global jc-config-webdav DB, keyed by board name
  if (webdav) {
    mockWdStore[B] = { _id: B, _rev: '1-wdcfg', ...webdav }
  } else {
    delete mockWdStore[B]
  }

  const docs = new Map()
  if (notes) docs.set('notes', { _id: 'notes', _rev: '1-n', ...notes })
  docs.set('board', { _id: 'board', _rev: '1-b', columns: [{ id: 'c1', title: 'Inbox', cards: [{ id: 'id-card1', text: 'Card one' }] }] })
  let rev = 1

  return {
    get: vi.fn(async (id) => {
      if (!docs.has(id)) throw Object.assign(new Error('missing'), { statusCode: 404 })
      return JSON.parse(JSON.stringify(docs.get(id)))
    }),
    insert: vi.fn(async (data) => {
      const r = `${++rev}-x`
      docs.set(data._id, { ...JSON.parse(JSON.stringify(data)), _rev: r })
      return { ok: true, id: data._id, rev: r }
    }),
    lastNotes: () => docs.get('notes') || null,
    doc: id => docs.get(id) || null,
  }
}

const WD_CFG = { enabled: true, url: WD_URL, user: 'u', password: 'p' }

const PAGE = { type: 'page', id: 'n-testpage', title: 'Test Page',
  description: 'Hello', link: '', linkedCards: [],
  lastModified: '2026-05-16T10:00:00.000Z' }

const NOTES_EMPTY   = { items: [], schemaVersion: 2 }
const NOTES_PAGE    = { items: [{ ...PAGE }], schemaVersion: 2 }


// ---------------------------------------------------------------------------
// Global fetch mock (intercepts WebDAV HTTP calls)
// ---------------------------------------------------------------------------
const { createFakeDav } = require('../setup/fakeDav')
const dav = createFakeDav({ base: WD_URL })
const mockFetch = vi.fn(dav.fetch)
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
const { _resetIndexes } = require('../../notes-webdav/backend/webdav-handlers')

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockImplementation((...a) => activeDav.fetch(...a))
  activeDav = dav
  dav.reset()
  _resetIndexes()
  Object.keys(mockWdStore).forEach(k => delete mockWdStore[k])
})
let activeDav = dav

// ===========================================================================
// WC — WebDAV Config
// ===========================================================================

describe('GET /:board/webdav-config', () => {
  it('WC-1a: no config stored → returns safe defaults, hasPassword: false', async () => {
    mockDbCtx.db = makeDb()
    const res = await request(app).get(`/api/${B}/webdav-config`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ enabled: false, accountId: '', subfolder: '' })
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
      .send({ enabled: true, accountId: 'acc-1', subfolder: 'notes' })
    expect(putRes.status).toBe(200)
    expect(putRes.body.ok).toBe(true)

    // Verify stored (simulate re-GET via global webdav db state)
    const stored = mockWdStore[B]
    expect(stored.enabled).toBe(true)
    expect(stored.accountId).toBe('acc-1')
    expect(stored.subfolder).toBe('notes')
  })
})

describe('POST /:board/webdav-config/test', () => {
  it('WC-3: server returns 207 → ok: true', async () => {
    mockDbCtx.db = makeDb()
    mockFetch.mockResolvedValueOnce({ ok: true, status: 207 })
    const res = await request(app)
      .post(`/api/${B}/webdav-config/test`).set(AUTH)
      .send({ accountId: 'acc-1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('WC-4: server returns 401 → ok: false, auth error message', async () => {
    mockDbCtx.db = makeDb()
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    const res = await request(app)
      .post(`/api/${B}/webdav-config/test`).set(AUTH)
      .send({ accountId: 'acc-1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/auth/i)
  })

  it('WC-5: connection times out → ok: false, timeout message', async () => {
    mockDbCtx.db = makeDb()
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('abort'), { name: 'AbortError' }))
    const res = await request(app)
      .post(`/api/${B}/webdav-config/test`).set(AUTH)
      .send({ accountId: 'acc-1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/timed? ?out/i)
  })
})

// ===========================================================================
// Helpers for WebDAV boards
// ===========================================================================

/** WebDAV board with the given files on the server; returns the loaded notes document. */
async function wdBoard(files = {}, { notes = null } = {}) {
  mockDbCtx.db = makeDb({ webdav: WD_CFG, notes })
  for (const [p, text] of Object.entries(files)) activeDav.write(p, text)
  const res = await request(app).get(`/api/${B}/notes?wait=1`).set(AUTH)
  expect(res.status).toBe(200)
  return res.body
}

/** Flat list "path" of the tree (folders end with "/"). */
function paths(items, prefix = '') {
  const out = []
  for (const it of items) {
    if (it.type === 'folder') { out.push(prefix + it.title + '/'); out.push(...paths(it.children, prefix + it.title + '/')) }
    else out.push(prefix + it.title)
  }
  return out
}

function find(items, title) {
  for (const it of items) {
    if (it.title === title) return it
    if (it.type === 'folder') { const f = find(it.children, title); if (f) return f }
  }
  return null
}

const NOTE_1 = '---\nid: n-one\ntags: [keep]\n---\nOne\n'

// ===========================================================================
// NP — Page operations
// ===========================================================================

describe('GET /:board/notes (WebDAV board)', () => {
  it('NP-0b: a path-derived id handed out before the front matter was read keeps working', async () => {
    mockDbCtx.db = makeDb({ webdav: WD_CFG })
    activeDav.write('One.md', NOTE_1)
    const first = (await request(app).get(`/api/${B}/notes`).set(AUTH)).body   // front matter still loading
    const early = find(first.items, 'One').id
    await request(app).get(`/api/${B}/notes?wait=1`).set(AUTH)
    const res = await request(app).get(`/api/${B}/notes/pages/${early}/content`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('n-one')
  })

  it('NP-0: tree = files on the server; folders first, alphabetical; dot folders and _attachments hidden', async () => {
    const notes = await wdBoard({
      'b.md': 'b', 'Ä.md': 'a', 'Z/x.md': 'x', '.obsidian/app.json': '{}', '_attachments/p.png': 'P', 'One.md': NOTE_1,
    })
    expect(notes.source).toBe('webdav')
    expect(paths(notes.items)).toEqual(['Z/', 'Z/x', 'Ä', 'b', 'One'])
    expect(find(notes.items, 'One').id).toBe('n-one')
    expect(find(notes.items, 'b').id).toMatch(/^n-[0-9a-f]{12}$/)
    expect(find(notes.items, 'One').description).toBe('One\n')
  })
})

describe('POST /:board/notes/pages', () => {
  it('NP-1: create root page → file with id, link and linked cards; page in returned notes', async () => {
    await wdBoard()
    const res = await request(app).post(`/api/${B}/notes/pages`).set(AUTH)
      .send({ page: { id: 'n-new1', title: 'New: Page', description: 'Body', link: 'https://l', linkedCards: ['id-card1'] } })
    expect(res.status).toBe(200)
    expect(res.body.page.id).toBe('n-new1')
    expect(find(res.body.notes.items, 'New Page').id).toBe('n-new1')
    const text = activeDav.read('New Page.md')
    // linkedCards as "[Card text](…#card:id)" when the host resolves cards, else the bare id
    expect(text).toMatch(/^---\nid: n-new1\nlink: https:\/\/l\nlinkedCards:\n  - .*id-card1.*\n---\nBody$/)
  })

  it('NP-2: create page inside a folder; a second page with the same title gets a free name', async () => {
    const notes = await wdBoard({ 'F/Taken.md': 'x' })
    const fid = find(notes.items, 'F').id
    const res = await request(app).post(`/api/${B}/notes/pages`).set(AUTH)
      .send({ page: { id: 'n-new2', title: 'Taken', description: '' }, parentId: fid })
    expect(res.status).toBe(200)
    expect(activeDav.read('F/Taken 1.md')).toBe('---\nid: n-new2\n---\n')
  })
})

describe('PATCH /:board/notes/pages/:id', () => {
  it('NP-4: title change → file renamed, id kept, Obsidian properties kept, legacy keys removed', async () => {
    await wdBoard({ 'Old.md': '---\nid: "[n-one](http://x#note:n-one)"\ntitle: "Old"\nlastModified: 2026-01-01T00:00:00Z\ntags: [keep]\n---\nText\n' })
    const c = await request(app).get(`/api/${B}/notes/pages/n-one/content`).set(AUTH)
    expect(c.body).toMatchObject({ content: 'Text\n', properties: { tags: ['keep'] } })
    const res = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).set('If-Match', `"${c.body.etag}"`)
      .send({ title: 'New', description: 'Changed\n' })
    expect(res.status).toBe(200)
    expect(activeDav.read('Old.md')).toBeUndefined()
    expect(activeDav.read('New.md')).toBe('---\nid: "n-one"\ntags: [keep]\n---\nChanged\n')
    expect(find(res.body.notes.items, 'New').id).toBe('n-one')
  })

  it('NP-5: stale If-Match → 412 with the server version, nothing written', async () => {
    await wdBoard({ 'One.md': NOTE_1 })
    const c = await request(app).get(`/api/${B}/notes/pages/n-one/content`).set(AUTH)
    activeDav.write('One.md', '---\nid: n-one\n---\nFrom Obsidian\n')
    const res = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).set('If-Match', `"${c.body.etag}"`)
      .send({ description: 'Mine' })
    expect(res.status).toBe(412)
    expect(res.body.server.content).toBe('From Obsidian\n')
    expect(activeDav.read('One.md')).toBe('---\nid: n-one\n---\nFrom Obsidian\n')
    // force overwrites
    const forced = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).send({ description: 'Mine\n', force: true })
    expect(forced.status).toBe(200)
    expect(activeDav.read('One.md')).toBe('---\nid: n-one\n---\nMine\n')
  })

  it('NP-5b: only linkedCards → text stays as it is on the server (no stale body written back)', async () => {
    await wdBoard({ 'One.md': NOTE_1 })
    activeDav.write('One.md', '---\nid: n-one\n---\nNewer text\n')
    const res = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).send({ linkedCards: ['id-card1'] })
    expect(res.status).toBe(200)
    expect(activeDav.read('One.md')).toMatch(/Newer text\n$/)
    expect(activeDav.read('One.md')).toMatch(/linkedCards:/)
  })

  it('NP-6: unknown page id → 404', async () => {
    await wdBoard()
    const res = await request(app).patch(`/api/${B}/notes/pages/n-nope`).set(AUTH).send({ title: 'x' })
    expect(res.status).toBe(404)
  })

  it('NP-6b: rename onto an existing name → 409, content saved, file not renamed', async () => {
    await wdBoard({ 'One.md': NOTE_1, 'Two.md': 'two' })
    const res = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).send({ title: 'Two', description: 'X' })
    expect(res.status).toBe(409)
    expect(activeDav.read('One.md')).toMatch(/X$/)
    expect(activeDav.read('Two.md')).toBe('two')
  })
})

describe('DELETE /:board/notes/pages/:id', () => {
  it('NP-7: delete page → file and the attachments only it links are gone', async () => {
    await wdBoard({
      'F/A.md': '---\nid: n-a\n---\n![](_attachments/only.png) ![](_attachments/shared.png)',
      'F/B.md': '![](_attachments/shared.png)',
      'F/_attachments/only.png': 'O', 'F/_attachments/shared.png': 'S',
    })
    const res = await request(app).delete(`/api/${B}/notes/pages/n-a`).set(AUTH)
    expect(res.status).toBe(200)
    expect(activeDav.read('F/A.md')).toBeUndefined()
    expect(activeDav.read('F/_attachments/only.png')).toBeUndefined()
    expect(activeDav.read('F/_attachments/shared.png')).toBe('S')
    expect(paths(res.body.notes.items)).toEqual(['F/', 'F/B'])
  })

  it('NP-7b: delete page → attachments only its front matter lists are gone too', async () => {
    await wdBoard({
      'F/A.md': '---\nid: n-a\nattachments:\n  - "[only.pdf](_attachments/only.pdf)"\n  - "[shared.pdf](_attachments/shared.pdf)"\n---\nText',
      'F/B.md': '---\nattachments:\n  - "[shared.pdf](_attachments/shared.pdf)"\n---\n',
      'F/_attachments/only.pdf': 'O', 'F/_attachments/shared.pdf': 'S',
    })
    expect((await request(app).delete(`/api/${B}/notes/pages/n-a`).set(AUTH)).status).toBe(200)
    expect(activeDav.read('F/_attachments/only.pdf')).toBeUndefined()
    expect(activeDav.read('F/_attachments/shared.pdf')).toBe('S')
  })

  it('NP-8b: 423 Locked on save → retried; still locked after the retries → readable error', async () => {
    const store = require('../../notes-webdav/backend/store')
    const pauses = store.LOCK_RETRY_MS
    store.LOCK_RETRY_MS = [1, 1, 1]
    try {
      await wdBoard({ 'One.md': NOTE_1 })
      let locked = 2   // the first two PUTs hit a lock
      activeDav.fail = (m) => m === 'PUT' && locked-- > 0 ? 423 : false
      const ok = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).send({ description: 'Saved\n' })
      expect(ok.status).toBe(200)
      expect(activeDav.read('One.md')).toMatch(/Saved\n$/)
      activeDav.fail = (m) => m === 'PUT' ? 423 : false
      const res = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).send({ description: 'Again\n' })
      expect(res.status).toBe(423)
      expect(res.body.error).toMatch(/locked on the server/)
      expect(activeDav.requests.filter(r => r.method === 'PUT').length).toBeGreaterThanOrEqual(4 + 3)
    } finally { store.LOCK_RETRY_MS = pauses; activeDav.fail = null }
  })

  it('NP-8c: file locked by an app (stale Nextcloud Text lock) → 423 names the owner, the time and what to do', async () => {
    const store = require('../../notes-webdav/backend/store')
    const pauses = store.LOCK_RETRY_MS
    store.LOCK_RETRY_MS = [1]
    try {
      await wdBoard({ 'Sub/Next test.md': NOTE_1 })
      activeDav.locks.set('Sub/Next test.md', { owner: 'Text', app: true, editor: 'text', time: 1794911615 })
      const res = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).send({ description: 'x\n' })
      expect(res.status).toBe(423)
      expect(res.body.error).toMatch(/^"Next test" is locked on the server by Text \(Nextcloud app lock\), without expiry\. Nextcloud did not release it/)
      expect(res.body.lock).toMatchObject({ owner: 'Text', app: true, since: new Date(1794911615 * 1000).toISOString() })
      expect(activeDav.read('Sub/Next test.md')).toBe(NOTE_1)
    } finally { store.LOCK_RETRY_MS = pauses }
  })

  it('NA-6: upload with an umlaut in the file name (multer: UTF-8 bytes as Latin-1) → stored and listed as typed', async () => {
    await wdBoard({ 'One.md': NOTE_1 })
    const up = await request(app).post(`/api/${B}/notes/attachments/n-one`).set(AUTH).attach('file', Buffer.from('PDF'), 'Vorbereitung Gespräch.pdf')
    expect(up.status).toBe(200)
    expect(up.body.name).toBe('Vorbereitung Gespräch.pdf')
    expect(activeDav.read('_attachments/Vorbereitung Gespräch.pdf')).toBe('PDF')
  })

  it('NP-8: WebDAV DELETE fails → error; page still listed', async () => {
    await wdBoard({ 'One.md': NOTE_1 })
    activeDav.fail = (m) => m === 'DELETE'
    const res = await request(app).delete(`/api/${B}/notes/pages/n-one`).set(AUTH)
    expect(res.status).toBeGreaterThanOrEqual(500)
    activeDav.fail = null
    const notes = (await request(app).get(`/api/${B}/notes`).set(AUTH)).body
    expect(find(notes.items, 'One')).not.toBeNull()
  })
})

describe('POST /:board/notes/pages/:id/move', () => {
  it('NP-9: move page into a folder → file moved, linked attachments follow, links rewritten', async () => {
    const notes = await wdBoard({
      'One.md': '---\nid: n-one\n---\n![x](_attachments/Bild%201.png)\n',
      '_attachments/Bild 1.png': 'PNG',
      'Target/Exists.md': 'e',
      'Target/_attachments/Bild 1.png': 'OTHER',
    })
    const res = await request(app).post(`/api/${B}/notes/pages/n-one/move`).set(AUTH)
      .send({ folderId: find(notes.items, 'Target').id })
    expect(res.status).toBe(200)
    expect(activeDav.read('One.md')).toBeUndefined()
    expect(activeDav.read('Target/One.md')).toBe('---\nid: n-one\n---\n![x](_attachments/Bild%201%201.png)\n')
    expect(activeDav.read('Target/_attachments/Bild 1 1.png')).toBe('PNG')
    expect(activeDav.read('_attachments/Bild 1.png')).toBeUndefined()
  })

  it('NP-9b: move page into a subfolder → its attachments follow (front matter list and links), shared ones are copied, list and links updated', async () => {
    const notes = await wdBoard({
      'F/One.md': '---\nid: n-one\nattachments:\n  - "[listed.pdf](_attachments/listed.pdf)"\n  - "[pic.png](_attachments/pic.png)"\n---\n![p](_attachments/pic.png)\n',
      'F/Other.md': '---\nattachments:\n  - "[pic.png](_attachments/pic.png)"\n---\n',
      'F/_attachments/listed.pdf': 'L', 'F/_attachments/pic.png': 'P',
      'F/Sub/Keep.md': 'k',
    })
    const res = await request(app).post(`/api/${B}/notes/pages/n-one/move`).set(AUTH).send({ folderId: find(notes.items, 'Sub').id })
    expect(res.status).toBe(200)
    expect(activeDav.read('F/Sub/One.md')).toBe('---\nid: n-one\nattachments:\n  - "[listed.pdf](_attachments/listed.pdf)"\n  - "[pic.png](_attachments/pic.png)"\n---\n![p](_attachments/pic.png)\n')
    expect(activeDav.read('F/Sub/_attachments/listed.pdf')).toBe('L')
    expect(activeDav.read('F/_attachments/listed.pdf')).toBeUndefined()   // only One had it → moved
    expect(activeDav.read('F/Sub/_attachments/pic.png')).toBe('P')
    expect(activeDav.read('F/_attachments/pic.png')).toBe('P')            // Other lists it too → copied
    const list = (await request(app).get(`/api/${B}/notes/attachments/n-one`).set(AUTH)).body
    expect(list.map(f => `${f.scope}:${f.name}`)).toEqual(['page:listed.pdf', 'page:pic.png'])
  })

  it('NP-11: reorder within the same folder → no MOVE (order is alphabetical)', async () => {
    await wdBoard({ 'A.md': '---\nid: n-a\n---\n', 'B.md': 'b' })
    const moves = activeDav.count('MOVE')
    const res = await request(app).post(`/api/${B}/notes/pages/n-a/move`).set(AUTH)
      .send({ folderId: null, targetId: 'x', position: 'after' })
    expect(res.status).toBe(200)
    expect(activeDav.count('MOVE')).toBe(moves)
  })
})

describe('GET /:board/notes/pages/:id/content', () => {
  it('NP-12: WebDAV enabled → content, etag, properties; second read is a 304 from the server', async () => {
    await wdBoard({ 'One.md': NOTE_1 })
    const res = await request(app).get(`/api/${B}/notes/pages/n-one/content`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ content: 'One\n', properties: { tags: ['keep'] }, title: 'One' })
    expect(res.body.etag).toBeTruthy()
    const before = activeDav.requests.length
    await request(app).get(`/api/${B}/notes/pages/n-one/content`).set(AUTH)
    const gets = activeDav.requests.slice(before).filter(r => r.method === 'GET')
    expect(gets).toHaveLength(1)
    expect(gets[0].headers['if-none-match']).toBe(`"${res.body.etag}"`)
  })

  it('NP-13: WebDAV disabled → 400', async () => {
    mockDbCtx.db = makeDb({ notes: NOTES_PAGE })
    const res = await request(app).get(`/api/${B}/notes/pages/n-testpage/content`).set(AUTH)
    expect(res.status).toBe(400)
  })
})

// ===========================================================================
// NF — Folder operations
// ===========================================================================

describe('folders', () => {
  it('NF-1: create folder → MKCOL; id of the new folder returned', async () => {
    await wdBoard()
    const res = await request(app).post(`/api/${B}/notes/folders`).set(AUTH).send({ folder: { id: 'f-x', title: 'New/Folder' } })
    expect(res.status).toBe(200)
    expect(activeDav.dirs.has('New Folder')).toBe(true)
    expect(find(res.body.notes.items, 'New Folder').id).toBe(res.body.id)
  })

  it('NF-3: rename folder → MOVE; pages inside keep their ids', async () => {
    const notes = await wdBoard({ 'F/One.md': NOTE_1 })
    const res = await request(app).patch(`/api/${B}/notes/folders/${find(notes.items, 'F').id}`).set(AUTH).send({ title: 'G' })
    expect(res.status).toBe(200)
    expect(activeDav.read('G/One.md')).toBe(NOTE_1)
    expect(paths(res.body.notes.items)).toEqual(['G/', 'G/One'])
    expect(find(res.body.notes.items, 'One').id).toBe('n-one')
  })

  it('NF-4: delete folder → removed recursively', async () => {
    const notes = await wdBoard({ 'F/One.md': NOTE_1, 'F/Sub/x.md': 'x' })
    const res = await request(app).delete(`/api/${B}/notes/folders/${find(notes.items, 'F').id}`).set(AUTH)
    expect(res.status).toBe(200)
    expect(activeDav.files.size).toBe(0)
    expect(res.body.notes.items).toEqual([])
  })

  it('NF-6: move folder into another folder; into itself → 400', async () => {
    const notes = await wdBoard({ 'A/x.md': 'x', 'B/y.md': 'y' })
    const a = find(notes.items, 'A').id, b = find(notes.items, 'B').id
    const res = await request(app).post(`/api/${B}/notes/folders/${a}/move`).set(AUTH).send({ parentId: b })
    expect(res.status).toBe(200)
    expect(activeDav.read('B/A/x.md')).toBe('x')
    const into = await request(app).post(`/api/${B}/notes/folders/${b}/move`).set(AUTH).send({ parentId: find(res.body.notes.items, 'A').id })
    expect(into.status).toBe(400)
  })
})

// ===========================================================================
// NS — Index / sync
// ===========================================================================

describe('index follows the server', () => {
  it('NS-1: changes made outside the app (new, renamed, moved, deleted) → tree matches, no leftovers, ids kept', async () => {
    await wdBoard({ 'One.md': NOTE_1, 'Gone.md': 'g', 'Deep/a/b/c.md': 'c' })
    activeDav.write('Fresh.md', 'new')
    await activeDav.rename('One.md', 'Deep/a/Renamed.md')
    activeDav.remove('Gone.md')
    const res = await request(app).post(`/api/${B}/notes/sync`).set(AUTH).send({})
    expect(res.status).toBe(200)
    expect(paths(res.body.notes.items)).toEqual(['Deep/', 'Deep/a/', 'Deep/a/b/', 'Deep/a/b/c', 'Deep/a/Renamed', 'Fresh'])
    const fresh = (await request(app).get(`/api/${B}/notes?wait=1`).set(AUTH)).body
    expect(find(fresh.items, 'Renamed').id).toBe('n-one')
    expect(JSON.stringify(fresh)).not.toMatch(/orphan/i)
  })

  it('NS-2: Nextcloud (ETag propagation) → unchanged root = one PROPFIND Depth:0; a change lists only changed folders', async () => {
    activeDav = createFakeDav({ base: WD_URL, propagate: true })
    await wdBoard({ 'A/x.md': 'x', 'B/y.md': 'y', 'C/z.md': 'z' })
    let before = activeDav.requests.length
    await request(app).post(`/api/${B}/notes/sync`).set(AUTH).send({})
    expect(activeDav.requests.slice(before).map(r => `${r.method} ${r.headers.depth}`)).toEqual(['PROPFIND 0'])

    activeDav.write('B/new.md', 'n')
    before = activeDav.requests.length
    const res = await request(app).post(`/api/${B}/notes/sync`).set(AUTH).send({})
    const lists = activeDav.requests.slice(before).filter(r => r.method === 'PROPFIND').map(r => `${r.path}|${r.headers.depth}`)
    expect(lists).toEqual(['|0', '|1', 'B|1'])
    expect(paths(res.body.notes.items)).toContain('B/new')
  })

  it('NS-3: GET answers from the index at once and checks in the background (revalidating flag)', async () => {
    await wdBoard({ 'A.md': 'a' })
    await new Promise(r => setTimeout(r, 5100))   // older than the minimum check interval
    activeDav.write('B.md', 'b')
    const first = await request(app).get(`/api/${B}/notes`).set(AUTH)
    expect(first.body.revalidating).toBe(true)
    expect(paths(first.body.items)).toEqual(['A'])
    const second = await request(app).get(`/api/${B}/notes?wait=1`).set(AUTH)
    expect(paths(second.body.items)).toEqual(['A', 'B'])
  }, 10000)

  it('NS-4: WebDAV disabled → sync returns the CouchDB notes, no fetch', async () => {
    mockDbCtx.db = makeDb({ notes: NOTES_PAGE })
    const res = await request(app).post(`/api/${B}/notes/sync`).set(AUTH).send({})
    expect(res.status).toBe(200)
    expect(res.body.changed).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('NS-5: bulk PUT/PATCH of the tree is ignored on WebDAV boards (the tree is derived)', async () => {
    await wdBoard({ 'One.md': NOTE_1 })
    const before = activeDav.requests.length
    const res = await request(app).put(`/api/${B}/notes`).set(AUTH).send({ items: [], schemaVersion: 2 })
    expect(res.status).toBe(200)
    expect(activeDav.requests.length).toBe(before)
    expect(activeDav.read('One.md')).toBe(NOTE_1)
  })
})

// ===========================================================================
// NA — Attachments next to the note
// ===========================================================================

describe('freshenWebdavNotes (Today widgets)', () => {
  it('NS-9: a note added outside the app reaches the stored index (Notes / Find widgets) without opening the board', async () => {
    const { freshenWebdavNotes } = require('../../notes-webdav/backend/webdav-handlers')
    await wdBoard({ 'One.md': NOTE_1 })
    activeDav.write('Folder/From Obsidian.md', 'Klient Auszug\n')
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 6000)   // past the 5 s between checks
    try { await freshenWebdavNotes([B, 'other-board'], { frontmatter: true }) } finally { spy.mockRestore() }
    const stored = mockDbCtx.db.doc('notes')
    expect(paths(stored.items)).toContain('Folder/From Obsidian')
    expect(find(stored.items, 'From Obsidian').description).toBe('Klient Auszug\n')   // full text searchable
  })
})

describe('attachments (WebDAV board)', () => {
  it('NA-1: upload → file in <folder>/_attachments, link returned; list, download, delete', async () => {
    await wdBoard({ 'F/One.md': NOTE_1 })
    const up = await request(app).post(`/api/${B}/notes/attachments/n-one`).set(AUTH).attach('file', Buffer.from('PNG'), 'My Pic.png')
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ name: 'My Pic.png', link: '_attachments/My%20Pic.png' })
    expect(activeDav.read('F/_attachments/My Pic.png')).toBe('PNG')
    await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).send({ description: `![](${up.body.link})` })
    const list = await request(app).get(`/api/${B}/notes/attachments/n-one`).set(AUTH)
    expect(list.body).toEqual([{ name: 'My Pic.png', size: 3, link: '_attachments/My%20Pic.png', scope: 'page' }])
    const dl = await request(app).get(`/api/${B}/notes/attachments/n-one/${encodeURIComponent('My Pic.png')}`).set(AUTH).buffer(true)
    expect(dl.status).toBe(200)
    expect(Buffer.from(dl.body).toString()).toBe('PNG')
    const del = await request(app).delete(`/api/${B}/notes/attachments/n-one/${encodeURIComponent('My Pic.png')}`).set(AUTH)
    expect(del.status).toBe(200)
    expect(activeDav.read('F/_attachments/My Pic.png')).toBeUndefined()
  })

  it('NA-2: legacy "<id>_name" files are listed without the prefix and still download', async () => {
    await wdBoard({ 'One.md': NOTE_1, '_attachments/n-one_old.pdf': 'PDF' })
    const list = await request(app).get(`/api/${B}/notes/attachments/n-one`).set(AUTH)
    expect(list.body).toEqual([{ name: 'old.pdf', size: 3, link: '_attachments/n-one_old.pdf', scope: 'page' }])
    const dl = await request(app).get(`/api/${B}/notes/attachments/n-one/old.pdf`).set(AUTH).buffer(true)
    expect(Buffer.from(dl.body).toString()).toBe('PDF')
  })

  it('NA-4: the page\'s own files (front matter list, links) apart from the folder\'s other files', async () => {
    await wdBoard({
      'F/One.md': NOTE_1,
      'F/Two.md': '---\nid: n-two\nattachments:\n  - "[theirs.png](_attachments/theirs.png)"\n---\nText\n',
      'F/_attachments/theirs.png': 'T', 'F/_attachments/loose.pdf': 'L',
    })
    const up = await request(app).post(`/api/${B}/notes/attachments/n-one`).set(AUTH).attach('file', Buffer.from('NEW'), 'new.png')
    expect(up.status).toBe(200)
    const one = (await request(app).get(`/api/${B}/notes/attachments/n-one`).set(AUTH)).body
    expect(one.map(f => `${f.scope}:${f.name}`)).toEqual(['page:new.png', 'folder:loose.pdf', 'folder:theirs.png'])
    const two = (await request(app).get(`/api/${B}/notes/attachments/n-two`).set(AUTH)).body
    expect(two.map(f => `${f.scope}:${f.name}`)).toEqual(['page:theirs.png', 'folder:loose.pdf', 'folder:new.png'])
  })

  it('NA-5: front matter `attachments:` — upload adds (If-Match = editor version, new ETag back), saving adds linked files, delete removes; Obsidian keys kept', async () => {
    await wdBoard({ 'F/One.md': NOTE_1, 'F/_attachments/linked.pdf': 'P' })
    const c = await request(app).get(`/api/${B}/notes/pages/n-one/content`).set(AUTH)
    const up = await request(app).post(`/api/${B}/notes/attachments/n-one`).set(AUTH).set('If-Match', `"${c.body.etag}"`)
      .attach('file', Buffer.from('PNG'), 'My Pic.png')
    expect(up.body.etag).toBeTruthy()
    expect(up.body.etag).not.toBe(c.body.etag)
    expect(activeDav.read('F/One.md')).toBe('---\nid: n-one\ntags: [keep]\nattachments:\n  - "[My Pic.png](_attachments/My%20Pic.png)"\n---\nOne\n')
    expect((await request(app).get(`/api/${B}/notes/pages/n-one/content`).set(AUTH)).body.properties).toEqual({ tags: ['keep'] })
    // The editor saves with the ETag from the upload: no conflict; a link in the text joins the list
    const save = await request(app).patch(`/api/${B}/notes/pages/n-one`).set(AUTH).set('If-Match', `"${up.body.etag}"`)
      .send({ description: 'One\n[doc](_attachments/linked.pdf)\n' })
    expect(save.status).toBe(200)
    expect(activeDav.read('F/One.md')).toContain('attachments:\n  - "[linked.pdf](_attachments/linked.pdf)"\n  - "[My Pic.png](_attachments/My%20Pic.png)"\n')
    // Delete: file gone, entry gone
    const del = await request(app).delete(`/api/${B}/notes/attachments/n-one/${encodeURIComponent('My Pic.png')}`).set(AUTH)
      .set('If-Match', `"${save.body.page.etag}"`)
    expect(del.body.etag).toBeTruthy()
    expect(activeDav.read('F/_attachments/My Pic.png')).toBeUndefined()
    expect(activeDav.read('F/One.md')).not.toContain('My%20Pic.png')
    // Note changed elsewhere since the editor loaded it: the file is uploaded, the note left alone (the next save conflicts)
    activeDav.write('F/One.md', activeDav.read('F/One.md') + 'changed in Obsidian\n')
    const late = await request(app).post(`/api/${B}/notes/attachments/n-one`).set(AUTH).set('If-Match', `"${del.body.etag}"`)
      .attach('file', Buffer.from('X'), 'late.png')
    expect(late.status).toBe(200)
    expect(late.body.etag).toBeNull()
    expect(activeDav.read('F/_attachments/late.png')).toBe('X')
    expect(activeDav.read('F/One.md')).not.toContain('late.png')
  })

  it('NA-3: blocked file type → 400', async () => {
    await wdBoard({ 'One.md': NOTE_1 })
    const up = await request(app).post(`/api/${B}/notes/attachments/n-one`).set(AUTH).attach('file', Buffer.from('x'), 'evil.js')
    expect(up.status).toBe(400)
  })
})

// ===========================================================================
// NM — Migration from the old DB tree
// ===========================================================================

describe('POST /:board/notes/migrate', () => {
  it('NM-1: old tree kept as notes-legacy; dry run reports; run restores DB-only text and cleans front matter; idempotent', async () => {
    const legacy = { schemaVersion: 2, items: [
      { type: 'page', id: 'n-one', title: 'One', wdPath: 'One.md', description: 'One\n' },
      { type: 'page', id: 'n-lost', title: 'Lost', wdPath: 'Lost.md', description: 'Only in the DB' },
      { type: 'page', id: 'n-moved', title: 'Moved', wdPath: 'Moved.md', description: 'Same text' },
    ] }
    await wdBoard({
      'One.md': '---\nid: "[n-one](http://x#note:n-one)"\ntitle: "One"\nlastModified: 2026-01-01T00:00:00Z\nattachments:\n  - "[a.png](_attachments/n-one_a.png)"\n---\nOne\n',
      'Archiv/Moved.md': 'Same text',
    }, { notes: legacy })
    expect(mockDbCtx.db.doc('notes-legacy').items).toHaveLength(3)
    expect(mockDbCtx.db.doc('notes').source).toBe('webdav')

    const dry = await request(app).post(`/api/${B}/notes/migrate`).set(AUTH)
    expect(dry.status).toBe(200)
    expect(dry.body).toMatchObject({ dry_run: true, restored: ['Lost.md'], moved_elsewhere: ['Moved.md → Archiv/Moved.md'] })
    expect(dry.body.frontmatter_cleaned).toEqual(['One.md: title, lastModified, id'])
    expect(activeDav.read('Lost.md')).toBeUndefined()

    const run = await request(app).post(`/api/${B}/notes/migrate?dry_run=0`).set(AUTH)
    expect(run.status).toBe(200)
    expect(activeDav.read('Lost.md')).toBe('Only in the DB')
    expect(activeDav.read('One.md')).toBe('---\nid: "n-one"\nattachments:\n  - "[a.png](_attachments/n-one_a.png)"\n---\nOne\n')   // the list stays

    const again = await request(app).post(`/api/${B}/notes/migrate?dry_run=0`).set(AUTH)
    expect(again.body).toMatchObject({ restored: [], uploaded: [], frontmatter_cleaned: [], attachments_uploaded: [] })
  })
})
