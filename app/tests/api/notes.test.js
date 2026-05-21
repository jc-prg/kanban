'use strict'
/**
 * Notes API tests — section 1.5 (N-1 … N-12)
 *
 * File upload/download tests (N-6 to N-9) use a temporary directory injected
 * via a config module mock so no real filesystem paths are polluted.
 * N-10 (>50 MB upload) is omitted as it would require transmitting 50 MB of
 * data and is better suited to a manual/load-test environment.
 */

const os   = require('os')
const path = require('path')
const fs   = require('fs')

// ---------------------------------------------------------------------------
// Config mock — must be injected BEFORE any backend module is loaded so that
// ATTACHMENTS_DIR points to a temp directory for this test run.
// ---------------------------------------------------------------------------
const TEST_DIR   = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-notes-test-'))
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
// Mock db — supports both board doc and notes doc
// ---------------------------------------------------------------------------
const mockDbCtx = { db: null }

function makeMockDb({ notesDoc } = {}) {
  let currentNotes = notesDoc
    ? { _id: 'notes', _rev: '1-abc', ...notesDoc }
    : null

  return {
    get: vi.fn().mockImplementation(async (id) => {
      if (id === 'notes') {
        if (!currentNotes) {
          const err = Object.assign(new Error('missing'), { statusCode: 404 })
          throw err
        }
        return JSON.parse(JSON.stringify(currentNotes))
      }
      // board doc
      return { _id: 'board', _rev: '1-abc', columns: [] }
    }),
    insert: vi.fn().mockImplementation(async (data) => {
      if (data._id === 'notes') {
        currentNotes = { ...JSON.parse(JSON.stringify(data)), _rev: '2-abc' }
      }
      return { ok: true, id: data._id, rev: '2-abc' }
    }),
    getLastSavedNotes: () => currentNotes,
  }
}

const dbMock = {
  getCouch:      () => ({}),
  validBoardName: (name) =>
    typeof name === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    name.length <= 64 &&
    name !== 'inbox',
  getBoardDb: async () => mockDbCtx.db,
  loadBoardData: async (db) => {
    const { _id, _rev, ...data } = await db.get('board')
    return data
  },
  saveBoardData: async (db, data) => {
    const { _rev } = await db.get('board')
    return db.insert({ _id: 'board', _rev, ...data })
  },
  loadNotesData: async (db) => {
    try {
      const { _id, _rev, ...data } = await db.get('notes')
      return data
    } catch (err) {
      if (err.statusCode === 404) return { items: [], schemaVersion: 2 }
      throw err
    }
  },
  saveNotesData: async (db, data) => {
    let rev
    try { ({ _rev: rev } = await db.get('notes')) } catch (_) { /* new doc */ }
    return db.insert({ _id: 'notes', ...(rev ? { _rev: rev } : {}), ...data })
  },
  withBoard: (handler) => async (req, res) => {
    const name = req.params.board
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64 || name === 'inbox')
      return res.status(400).json({ error: 'Invalid board name' })
    if (!mockDbCtx.db) return res.status(500).json({ error: 'No mock db configured' })
    try { await handler(req, res, mockDbCtx.db) }
    catch (e) { res.status(500).json({ error: e.message }) }
  },
  withExistingBoard: (handler) => async (req, res) => {
    const name = req.params.board
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64 || name === 'inbox')
      return res.status(400).json({ error: 'Invalid board name' })
    if (!mockDbCtx.db) return res.status(404).json({ error: 'Board not found' })
    try { await handler(req, res, mockDbCtx.db) }
    catch (e) { res.status(500).json({ error: e.message }) }
  },
  initDb: async () => {},
}

const app   = createApp(dbMock)
const AUTH  = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }
const BOARD = 'test-board'

afterAll(() => {
  // Clean up temp dir
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch (_) {}
})

// ---------------------------------------------------------------------------
// GET /:board/notes (N-1)
// ---------------------------------------------------------------------------
describe('GET /:board/notes', () => {
  it('N-1: no notes doc → 200 with empty items array (v2)', async () => {
    mockDbCtx.db = makeMockDb()  // no notesDoc

    const res = await request(app).get(`/api/${BOARD}/notes`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], schemaVersion: 2 })
  })

  it('v2 notes doc → 200 with items', async () => {
    mockDbCtx.db = makeMockDb({
      notesDoc: { items: [{ type: 'page', id: 'n-abc', title: 'My Page' }], schemaVersion: 2 },
    })

    const res = await request(app).get(`/api/${BOARD}/notes`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].title).toBe('My Page')
    expect(res.body.schemaVersion).toBe(2)
  })

  it('v1 notes doc (pages) → automatically migrated to v2 items on GET', async () => {
    mockDbCtx.db = makeMockDb({
      notesDoc: { pages: [{ id: 'n-abc', title: 'Old Page', children: [] }] },
    })

    const res = await request(app).get(`/api/${BOARD}/notes`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body.schemaVersion).toBe(2)
    expect(Array.isArray(res.body.items)).toBe(true)
    expect(res.body.items.some(i => i.title === 'Old Page')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PUT /:board/notes (N-2, N-3, N-4)
// ---------------------------------------------------------------------------
describe('PUT /:board/notes', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb()
  })

  it('N-2: valid v2 notes structure with folder and page → 200 { ok: true }', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/notes`)
      .set(AUTH)
      .send({
        items: [
          {
            type: 'folder', id: 'f-parent', title: 'Section',
            children: [{ type: 'page', id: 'n-child', title: 'Child' }],
          },
          { type: 'page', id: 'n-root', title: 'Root Page' },
        ],
        schemaVersion: 2,
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('N-3: missing items field → 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/notes`)
      .set(AUTH)
      .send({ title: 'oops, not items' })

    expect(res.status).toBe(400)
  })

  it('N-4: item missing required title field → 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/notes`)
      .set(AUTH)
      .send({ items: [{ type: 'page', id: 'n-abc' }] })  // title required

    expect(res.status).toBe(400)
  })

  it('N-5: item id fails minLength → 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/notes`)
      .set(AUTH)
      .send({ items: [{ type: 'page', id: '', title: 'Blank id' }] })  // id minLength: 1

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Notes attachments (N-6 … N-9, N-11)
// ---------------------------------------------------------------------------
describe('Notes attachments', () => {
  const PAGE_ID = 'n-abc123'

  beforeEach(() => {
    mockDbCtx.db = makeMockDb()
  })

  it('N-6: upload file to valid pageId → 200 { name, size }', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/notes/attachments/${PAGE_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('hello world'), 'hello.txt')

    expect(res.status).toBe(200)
    expect(res.body.name).toBeTruthy()
    expect(typeof res.body.size).toBe('number')
  })

  it('N-7: list attachments after upload → array with uploaded file', async () => {
    // Upload first
    await request(app)
      .post(`/api/${BOARD}/notes/attachments/${PAGE_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('data'), 'listed.txt')

    const res = await request(app)
      .get(`/api/${BOARD}/notes/attachments/${PAGE_ID}`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.some(f => f.name === 'listed.txt')).toBe(true)
  })

  it('N-8: download attachment → 200 with correct content', async () => {
    const content = 'file content for download'
    await request(app)
      .post(`/api/${BOARD}/notes/attachments/${PAGE_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from(content), 'download-me.txt')

    const res = await request(app)
      .get(`/api/${BOARD}/notes/attachments/${PAGE_ID}/download-me.txt`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(res.text).toBe(content)
  })

  it('N-9: delete attachment → 200 { ok: true }, file gone from list', async () => {
    await request(app)
      .post(`/api/${BOARD}/notes/attachments/${PAGE_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('bye'), 'to-delete.txt')

    const delRes = await request(app)
      .delete(`/api/${BOARD}/notes/attachments/${PAGE_ID}/to-delete.txt`)
      .set(AUTH)

    expect(delRes.status).toBe(200)
    expect(delRes.body.ok).toBe(true)

    const listRes = await request(app)
      .get(`/api/${BOARD}/notes/attachments/${PAGE_ID}`)
      .set(AUTH)
    expect(listRes.body.some(f => f.name === 'to-delete.txt')).toBe(false)
  })

  it('N-11: upload with invalid pageId (path traversal attempt) → 400', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/notes/attachments/n-../../secret`)
      .set(AUTH)
      .attach('file', Buffer.from('x'), 'file.txt')

    expect(res.status).toBe(400)
  })

  it('upload blocked extension (.js) → 400', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/notes/attachments/${PAGE_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('alert(1)'), 'evil.js')

    expect(res.status).toBe(400)
  })

  it('GET list for empty pageId dir → 200 empty array', async () => {
    const res = await request(app)
      .get(`/api/${BOARD}/notes/attachments/n-empty000`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Notes ZIP export (N-12)
// ---------------------------------------------------------------------------
describe('GET /:board/notes/export', () => {
  it('N-12: export → 200 application/zip with Content-Disposition', async () => {
    mockDbCtx.db = makeMockDb({
      notesDoc: {
        items: [{ type: 'page', id: 'n-exp1', title: 'Export Page', description: '# Hello' }],
        schemaVersion: 2,
      },
    })

    const res = await request(app)
      .get(`/api/${BOARD}/notes/export`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/zip')
    expect(res.headers['content-disposition']).toContain(`notes-${BOARD}.zip`)
  })
})

// ---------------------------------------------------------------------------
// PATCH /:board/notes + ETag (N-13 … N-17)
// ---------------------------------------------------------------------------
describe('PATCH /:board/notes', () => {
  const PAGE_ID = 'n-patch01'

  beforeEach(() => {
    mockDbCtx.db = makeMockDb({
      notesDoc: {
        items: [{ type: 'page', id: PAGE_ID, title: 'Original', description: 'old text' }],
        schemaVersion: 2,
      },
    })
  })

  it('N-13: updatedPages with existing id → 200 { ok:true }, description updated, ETag header set', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/notes`)
      .set(AUTH)
      .send({ updatedPages: [{ id: PAGE_ID, description: 'new text' }] })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.headers['etag']).toBeTruthy()

    const saved = mockDbCtx.db.getLastSavedNotes()
    const page = saved.items.find(i => i.id === PAGE_ID)
    expect(page.description).toBe('new text')
  })

  it('N-14: If-Match matches current _rev → 200, update applied', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/notes`)
      .set(AUTH)
      .set('If-Match', '"1-abc"')
      .send({ updatedPages: [{ id: PAGE_ID, description: 'patched' }] })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('N-15: If-Match stale (rev mismatch) → 409 conflict', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/notes`)
      .set(AUTH)
      .set('If-Match', '"stale-rev"')
      .send({ updatedPages: [{ id: PAGE_ID, description: 'should not apply' }] })

    expect(res.status).toBe(409)
  })

  it('N-16: updatedPages references unknown page id → 200, no-op (silently skipped)', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/notes`)
      .set(AUTH)
      .send({ updatedPages: [{ id: 'n-nonexistent', description: 'ghost' }] })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const saved = mockDbCtx.db.getLastSavedNotes()
    const original = saved.items.find(i => i.id === PAGE_ID)
    expect(original.description).toBe('old text')  // unchanged
  })
})

// ---------------------------------------------------------------------------
// GET /api/db-size (N-17)
// ---------------------------------------------------------------------------
describe('GET /api/db-size', () => {
  it('N-17: returns 200 { size } in bytes', async () => {
    mockDbCtx.db = makeMockDb()

    const res = await request(app).get('/api/db-size').set(AUTH)

    expect(res.status).toBe(200)
    expect(typeof res.body.size).toBe('number')
  })
})
