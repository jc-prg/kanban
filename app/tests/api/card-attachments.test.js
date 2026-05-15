'use strict'
/**
 * Card attachment API tests — section 1.6 (CA-1 … CA-7)
 *
 * Uses a temp directory (via config module mock) so no real data is touched.
 */

const os   = require('os')
const path = require('path')
const fs   = require('fs')

// ---------------------------------------------------------------------------
// Config mock — inject before any backend module loads
// ---------------------------------------------------------------------------
const TEST_DIR   = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-card-attach-'))
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

const dbMock = {
  getCouch:       () => ({}),
  validBoardName: (name) =>
    typeof name === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    name.length <= 64 &&
    name !== 'inbox',
  getBoardDb:     async () => null,
  loadBoardData:  async () => ({ columns: [] }),
  saveBoardData:  async () => ({ ok: true, rev: '1-abc' }),
  loadNotesData:  async () => ({ pages: [] }),
  saveNotesData:  async () => ({ ok: true, rev: '1-abc' }),
  withBoard:      (handler) => async (req, res) => {
    if (!require('../setup/createApp').createApp) return // satisfy require
    res.status(500).json({ error: 'not needed for attachment routes' })
  },
  withExistingBoard: (handler) => async (req, res) => {
    res.status(500).json({ error: 'not needed for attachment routes' })
  },
  initDb: async () => {},
}

const app   = createApp(dbMock)
const AUTH  = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }
const BOARD = 'test-board'
const CARD_ID = 'id-abc123ef'

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch (_) {}
})

// ---------------------------------------------------------------------------
// CA-1: Upload file to a card
// ---------------------------------------------------------------------------
describe('POST /:board/cards/attachments/:cardId', () => {
  it('CA-1: upload file to valid cardId → 200 { name, size }', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/cards/attachments/${CARD_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('card attachment'), 'card-file.txt')

    expect(res.status).toBe(200)
    expect(res.body.name).toBeTruthy()
    expect(typeof res.body.size).toBe('number')
  })

  it('CA-6: invalid cardId (no id- prefix) → 400', async () => {
    // A cardId without the required id-[alphanumeric] pattern is rejected by safeCardId.
    // Path-traversal IDs with slashes are intercepted by the router (404) before
    // our handler runs; we verify the pattern-based rejection instead.
    const res = await request(app)
      .post(`/api/${BOARD}/cards/attachments/not-a-valid-id`)
      .set(AUTH)
      .attach('file', Buffer.from('x'), 'file.txt')

    expect(res.status).toBe(400)
  })

  it('blocked file extension (.exe) → 400', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/cards/attachments/${CARD_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('MZ'), 'evil.exe')

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// CA-2: List card IDs with attachments
// ---------------------------------------------------------------------------
describe('GET /:board/cards/attachments', () => {
  it('CA-2: returns array of card IDs that have attachments', async () => {
    // Upload to ensure at least one card has an attachment
    await request(app)
      .post(`/api/${BOARD}/cards/attachments/${CARD_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('data'), 'listed-card.txt')

    const res = await request(app)
      .get(`/api/${BOARD}/cards/attachments`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toContain(CARD_ID)
  })
})

// ---------------------------------------------------------------------------
// CA-3: List attachments for a specific card
// ---------------------------------------------------------------------------
describe('GET /:board/cards/attachments/:cardId', () => {
  it('CA-3: list attachments for card → array of { name, size }', async () => {
    await request(app)
      .post(`/api/${BOARD}/cards/attachments/${CARD_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from('hello'), 'detail-file.txt')

    const res = await request(app)
      .get(`/api/${BOARD}/cards/attachments/${CARD_ID}`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.some(f => f.name && typeof f.size === 'number')).toBe(true)
  })

  it('empty card → 200 empty array', async () => {
    const res = await request(app)
      .get(`/api/${BOARD}/cards/attachments/id-empty00`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// CA-4: Download card attachment
// ---------------------------------------------------------------------------
describe('GET /:board/cards/attachments/:cardId/:filename', () => {
  it('CA-4: download → 200 with correct file content', async () => {
    const content = 'downloadable card content'
    await request(app)
      .post(`/api/${BOARD}/cards/attachments/${CARD_ID}`)
      .set(AUTH)
      .attach('file', Buffer.from(content), 'to-download.txt')

    const res = await request(app)
      .get(`/api/${BOARD}/cards/attachments/${CARD_ID}/to-download.txt`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(res.text).toBe(content)
  })

  it('nonexistent file → 404', async () => {
    const res = await request(app)
      .get(`/api/${BOARD}/cards/attachments/${CARD_ID}/ghost.txt`)
      .set(AUTH)

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// CA-5: Delete card attachment
// ---------------------------------------------------------------------------
describe('DELETE /:board/cards/attachments/:cardId/:filename', () => {
  it('CA-5: delete attachment → 200 { ok: true }, file no longer listed', async () => {
    const CARD_ID2 = 'id-del000ab'
    await request(app)
      .post(`/api/${BOARD}/cards/attachments/${CARD_ID2}`)
      .set(AUTH)
      .attach('file', Buffer.from('bye'), 'to-del.txt')

    const delRes = await request(app)
      .delete(`/api/${BOARD}/cards/attachments/${CARD_ID2}/to-del.txt`)
      .set(AUTH)

    expect(delRes.status).toBe(200)
    expect(delRes.body.ok).toBe(true)

    const listRes = await request(app)
      .get(`/api/${BOARD}/cards/attachments/${CARD_ID2}`)
      .set(AUTH)
    expect(listRes.body.some(f => f.name === 'to-del.txt')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CA-7: Attachment stats
// ---------------------------------------------------------------------------
describe('GET /:board/attachment-stats', () => {
  it('CA-7: returns { count, size } integers', async () => {
    const res = await request(app)
      .get(`/api/${BOARD}/attachment-stats`)
      .set(AUTH)

    expect(res.status).toBe(200)
    expect(typeof res.body.count).toBe('number')
    expect(typeof res.body.size).toBe('number')
  })
})
