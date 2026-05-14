'use strict'
/**
 * Board data API tests — section 1.3 (D-1 … D-14)
 *
 * withBoard / withExistingBoard are thin stubs that inject a configurable
 * mock CouchDB document object. The mock is injected into require.cache so
 * that route modules receive it on require('../db').
 */

process.env.APP_PASSWORD   = 'test-password'
process.env.API_KEY        = 'test-api-key-that-is-32chars-long!'
process.env.SESSION_SECRET = 'test-session-secret-32-chars-ok!'

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

const request       = require('supertest')
const { createApp } = require('../setup/createApp')

// ---- Shared mock db context -----------------------------------------------
// mockDbCtx.db is swapped in beforeEach/individual tests.
const mockDbCtx = { db: null }

function makeMockDb(boardDoc) {
  const doc = Object.assign({ _id: 'board', _rev: '1-abc', columns: [] }, boardDoc)
  return {
    get:    vi.fn().mockResolvedValue(doc),
    insert: vi.fn().mockResolvedValue({ ok: true, id: 'board', rev: '2-abc' }),
  }
}

const dbMock = {
  getCouch:      () => ({}),
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
const AUTH  = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }
const BOARD = 'test-board'

// ---------------------------------------------------------------------------
// GET /:board/board
// ---------------------------------------------------------------------------
describe('GET /:board/board', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [{ id: 'c1', title: 'Todo', cards: [] }] })
  })

  it('D-1: returns board data with columns array', async () => {
    const res = await request(app).get(`/api/${BOARD}/board`).set(AUTH)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.columns)).toBe(true)
    expect(res.body.columns[0].title).toBe('Todo')
  })

  it('returns 404 when board does not exist', async () => {
    mockDbCtx.db = null
    const res = await request(app).get(`/api/${BOARD}/board`).set(AUTH)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// PUT /:board/board
// ---------------------------------------------------------------------------
describe('PUT /:board/board', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb()
  })

  it('D-2: valid full board replacement → 200 success', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({ columns: [] })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('D-3: missing columns field → 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({ settings: {} })

    expect(res.status).toBe(400)
  })

  it('D-4: card with priority outside 1–5 → 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({
        columns: [{
          id: 'c1', title: 'Todo',
          cards: [{ id: 'card-1', text: 'Card', priority: 6 }],
        }],
      })

    expect(res.status).toBe(400)
  })

  it('D-5: card missing required id field → 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({
        columns: [{
          id: 'c1', title: 'Todo',
          cards: [{ text: 'No id here' }],
        }],
      })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// PATCH /:board/board
// ---------------------------------------------------------------------------
describe('PATCH /:board/board', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({
      columns: [
        { id: 'col-a', title: 'Alpha', cards: [{ id: 'card-x', text: 'Original' }] },
        { id: 'col-b', title: 'Beta',  cards: [] },
      ],
    })
  })

  it('D-6: add column via updatedColumns → 200, column present in saved doc', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({ updatedColumns: [{ id: 'col-new', title: 'New', cards: [] }] })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const saved = mockDbCtx.db.insert.mock.calls[0][0]
    expect(saved.columns.some(c => c.id === 'col-new')).toBe(true)
  })

  it('D-7: remove column via removedColumnIds → 200, column absent in saved doc', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({ removedColumnIds: ['col-b'] })

    expect(res.status).toBe(200)
    const saved = mockDbCtx.db.insert.mock.calls[0][0]
    expect(saved.columns.every(c => c.id !== 'col-b')).toBe(true)
  })

  it('D-8: update card text via updatedColumns → 200, new text in saved doc', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({
        updatedColumns: [{
          id: 'col-a', title: 'Alpha',
          cards: [{ id: 'card-x', text: 'Updated text' }],
        }],
      })

    expect(res.status).toBe(200)
    const saved = mockDbCtx.db.insert.mock.calls[0][0]
    const card  = saved.columns.find(c => c.id === 'col-a').cards[0]
    expect(card.text).toBe('Updated text')
  })

  it('D-9: update settings → 200, settings persisted in saved doc', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({ settings: { description: 'Test board' } })

    expect(res.status).toBe(200)
    const saved = mockDbCtx.db.insert.mock.calls[0][0]
    expect(saved.settings?.description).toBe('Test board')
  })

  it('invalid patch body (unknown field) → 400', async () => {
    const res = await request(app)
      .patch(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({ unknownField: true })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /:board/all-columns
// ---------------------------------------------------------------------------
describe('GET /:board/all-columns', () => {
  it('D-10: returns object keyed by column title', async () => {
    mockDbCtx.db = makeMockDb({
      columns: [
        { id: 'c1', title: 'Inbox', cards: [{ id: 'card-1', text: 'Test' }] },
        { id: 'c2', title: 'Done',  cards: [] },
      ],
    })

    const res = await request(app).get(`/api/${BOARD}/all-columns`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('Inbox')
    expect(res.body).toHaveProperty('Done')
    expect(res.body.Inbox[0].text).toBe('Test')
  })
})

// ---------------------------------------------------------------------------
// GET /:board/column/:name
// ---------------------------------------------------------------------------
describe('GET /:board/column/:name', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({
      columns: [{ id: 'c1', title: 'Done', cards: [{ id: 'card-1', text: 'Done card' }] }],
    })
  })

  it('D-11: case-insensitive match → 200 with cards array', async () => {
    const res = await request(app).get(`/api/${BOARD}/column/done`).set(AUTH)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body[0].text).toBe('Done card')
  })

  it('D-12: non-existent column → 404', async () => {
    const res = await request(app).get(`/api/${BOARD}/column/missing`).set(AUTH)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /:board/card/:id
// ---------------------------------------------------------------------------
describe('GET /:board/card/:id', () => {
  it('D-13: known card with move history → 200 with created, moves, column', async () => {
    mockDbCtx.db = makeMockDb({
      columns: [{
        id: 'c1', title: 'Done',
        cards: [{
          id: 'card-42',
          text: 'Some card',
          created: '2025-01-01',
          moves: [{ at: '2025-03-01T10:00:00Z', from: 'Inbox', to: 'Done' }],
        }],
      }],
    })

    const res = await request(app).get(`/api/${BOARD}/card/card-42`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body.created).toBe('2025-01-01')
    expect(res.body.moves).toHaveLength(1)
    expect(res.body.column).toBe('Done')
  })

  it('D-14: unknown card id → 404', async () => {
    mockDbCtx.db = makeMockDb({ columns: [{ id: 'c1', title: 'Inbox', cards: [] }] })
    const res = await request(app).get(`/api/${BOARD}/card/no-such-card`).set(AUTH)
    expect(res.status).toBe(404)
  })
})
