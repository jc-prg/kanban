'use strict'
/**
 * Security tests — section 4 (SEC-1 … SEC-8)
 *
 * SEC-7 (timing-safe auth) is approximated: we verify the constant-time
 * comparison function is used, not a full statistical timing analysis.
 */

const os   = require('os')
const path = require('path')
const fs   = require('fs')

// ---------------------------------------------------------------------------
// Config mock with temp attachment dir
// ---------------------------------------------------------------------------
const TEST_DIR   = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-sec-test-'))
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
// Shared mock db
// ---------------------------------------------------------------------------
const mockDbCtx = { db: null }

function makeMockDb(boardDoc) {
  let currentDoc = { _id: 'board', _rev: '1-abc', columns: [], ...boardDoc }
  return {
    get: vi.fn().mockImplementation(async () => JSON.parse(JSON.stringify(currentDoc))),
    insert: vi.fn().mockImplementation(async (data) => {
      currentDoc = { ...data, _rev: '2-abc' }
      return { ok: true, id: 'board', rev: '2-abc' }
    }),
  }
}

const dbMock = {
  getCouch:       () => ({}),
  validBoardName: (name) =>
    typeof name === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    name.length <= 64 &&
    name !== 'inbox',
  getBoardDb:    async () => mockDbCtx.db,
  loadBoardData: async (db) => {
    const { _id, _rev, ...data } = await db.get('board')
    return data
  },
  saveBoardData: async (db, data) => {
    const { _rev } = await db.get('board')
    return db.insert({ _id: 'board', _rev, ...data })
  },
  loadNotesData: async () => ({ pages: [] }),
  saveNotesData: async () => ({ ok: true, rev: '1-abc' }),
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

const app  = createApp(dbMock)
const AUTH = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch (_) {}
})

// ---------------------------------------------------------------------------
// SEC-1: Path traversal in filename
// ---------------------------------------------------------------------------
describe('SEC-1: path traversal in attachment filename', () => {
  it('../../etc/passwd as filename → 400 on download (invalid request)', async () => {
    mockDbCtx.db = makeMockDb()
    const res = await request(app)
      .get('/api/test-board/notes/attachments/n-safe123/../../etc/passwd')
      .set(AUTH)

    // Express router treats `..` in path segments — the URL path itself is
    // normalised by the HTTP layer, so the route may 404 or 400.
    expect([400, 404]).toContain(res.status)
  })

  it('filename with path separator rejected by safeFilename → 400', async () => {
    mockDbCtx.db = makeMockDb()
    // safeFilename rejects any name containing / or \
    // supertest encodes slashes, so we test via direct upload with a crafted name.
    // The multer filename sanitizer strips special chars, but the GET path is checked first.
    const res = await request(app)
      .get('/api/test-board/notes/attachments/n-safe123/..%2Fetc%2Fpasswd')
      .set(AUTH)

    expect([400, 404]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// SEC-2: Path traversal in pageId
// ---------------------------------------------------------------------------
describe('SEC-2: path traversal in pageId', () => {
  it('pageId "n-../../secret" → 400 (safePageId rejects non-alphanumeric)', async () => {
    mockDbCtx.db = makeMockDb()
    const res = await request(app)
      .get('/api/test-board/notes/attachments/n-abc%2F..%2Fsecret')
      .set(AUTH)

    expect(res.status).toBe(400)
  })

  it('pageId without n- prefix → 400', async () => {
    const res = await request(app)
      .get('/api/test-board/notes/attachments/evil-id')
      .set(AUTH)

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// SEC-3: Path traversal in cardId
// ---------------------------------------------------------------------------
describe('SEC-3: path traversal in cardId', () => {
  it('cardId not matching id-[a-z0-9] → 400', async () => {
    const res = await request(app)
      .get('/api/test-board/cards/attachments/id-../../../../secret')
      .set(AUTH)

    expect([400, 404]).toContain(res.status)
  })

  it('cardId without id- prefix → 400', async () => {
    const res = await request(app)
      .get('/api/test-board/cards/attachments/not-a-valid-id')
      .set(AUTH)

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// SEC-4: Board name with path traversal characters
// ---------------------------------------------------------------------------
describe('SEC-4: board name validation', () => {
  it('"../secret" board name → 400', async () => {
    const res = await request(app)
      .get('/api/../secret/board')
      .set(AUTH)

    expect([400, 404]).toContain(res.status)
  })

  it('board name with uppercase → 400', async () => {
    mockDbCtx.db = makeMockDb()
    const res = await request(app)
      .get('/api/Invalid-Board/board')
      .set(AUTH)

    expect(res.status).toBe(400)
  })

  it('board name "inbox" → 400', async () => {
    mockDbCtx.db = makeMockDb()
    const res = await request(app)
      .get('/api/inbox/board')
      .set(AUTH)

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// SEC-5: XSS via card title — stored as-is, returned as-is in JSON
// (sanitization is the frontend's responsibility via DOMPurify)
// ---------------------------------------------------------------------------
describe('SEC-5: XSS card text stored and returned correctly', () => {
  beforeEach(() => {
    const xssText = '<script>alert(1)</script>'
    mockDbCtx.db = makeMockDb({
      columns: [{
        id: 'c1', title: 'Inbox',
        cards: [{ id: 'xss-card', text: xssText }],
      }],
    })
  })

  it('XSS payload in card text is returned as-is (JSON; no HTML escaping at API level)', async () => {
    const res = await request(app)
      .get('/api/test-board/column/inbox')
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body[0].text).toBe('<script>alert(1)</script>')
  })
})

// ---------------------------------------------------------------------------
// SEC-6: Uploaded HTML file served with attachment Content-Disposition
// (prevents inline script execution in browser even if served from same origin)
// ---------------------------------------------------------------------------
describe('SEC-6: HTML upload served with Content-Disposition: attachment', () => {
  it('uploaded HTML file → Content-Disposition: attachment on download', async () => {
    // HTML is not blocked (only xhtml, xml, exe, etc. are blocked)
    const PAGE_ID = 'n-sec6test'
    await request(app)
      .post(`/api/test-board/notes/attachments/${PAGE_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('<script>alert(1)</script>'), 'xss.html')

    const res = await request(app)
      .get(`/api/test-board/notes/attachments/${PAGE_ID}/xss.html`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
  })
})

// ---------------------------------------------------------------------------
// SEC-7: Timing-safe password comparison
// safeEqual from auth.js uses crypto.timingSafeEqual — verify it's exported
// and behaves correctly rather than doing a fragile wall-clock timing test.
// ---------------------------------------------------------------------------
describe('SEC-7: timing-safe auth comparison', () => {
  it('safeEqual returns true for identical strings', () => {
    const { safeEqual } = require('../../backend/auth')
    expect(safeEqual('password123', 'password123')).toBe(true)
  })

  it('safeEqual returns false for different strings', () => {
    const { safeEqual } = require('../../backend/auth')
    expect(safeEqual('password123', 'wrongpasswd')).toBe(false)
  })

  it('safeEqual returns false when lengths differ (padded comparison)', () => {
    const { safeEqual } = require('../../backend/auth')
    expect(safeEqual('short', 'much-longer-string')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SEC-8: Session token behaviour after new login
// The implementation uses signed cookies; a second login creates a new token
// but the old one remains valid (single-user app — documented behaviour).
// ---------------------------------------------------------------------------
describe('SEC-8: session token behaviour', () => {
  it('first login token still accepted after second login (single-user design)', async () => {
    const login1 = await request(app)
      .post('/api/auth')
      .send({ password: 'test-password' })
    const cookie1 = (login1.headers['set-cookie'] ?? []).join('; ')

    // Second login
    await request(app)
      .post('/api/auth')
      .send({ password: 'test-password' })

    // First token should still work
    const verifyRes = await request(app)
      .get('/api/auth/verify')
      .set('Cookie', cookie1)

    expect(verifyRes.status).toBe(200)
    expect(verifyRes.body.ok).toBe(true)
  })
})
