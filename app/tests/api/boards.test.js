'use strict'
/**
 * Board management API tests — section 1.2 (B-1 … B-12)
 *
 * CouchDB is replaced by a plain mock object (mockCouch) that is configured
 * per test. The mock is injected into require.cache via createApp(dbMock)
 * before the route modules are loaded.
 */

process.env.APP_PASSWORD   = 'test-password'
process.env.API_KEY        = 'test-api-key-that-is-32chars-long!'
process.env.SESSION_SECRET = 'test-session-secret-32-chars-ok!'

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})

const request              = require('supertest')
const { createApp }        = require('../setup/createApp')

// ---- Shared mock couch object (configured per test in beforeEach) ----------
const mockCouch = {
  db: {
    list:    async () => [],
    create:  async () => ({ ok: true }),
    destroy: async () => ({ ok: true }),
  },
  use: () => ({
    get:    async () => ({ _id: 'board', _rev: '1-abc', columns: [] }),
    insert: async () => ({ ok: true, rev: '2-abc' }),
  }),
}

// Build the db mock module once. getCouch() closes over the mutable mockCouch
// object, so tests can mutate mockCouch.db.* between runs.
const dbMock = {
  getCouch:      () => mockCouch,
  validBoardName: (name) =>
    typeof name === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    name.length <= 64 &&
    name !== 'inbox',
  getBoardDb:    async () => ({}),
  loadBoardData: async () => ({ columns: [], settings: {} }),
  saveBoardData: async () => ({ ok: true }),
  withBoard: (handler) => async (req, res) => {
    const name = req.params.board
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64 || name === 'inbox')
      return res.status(400).json({ error: 'Invalid board name' })
    try { await handler(req, res, {}) }
    catch (e) { res.status(500).json({ error: e.message }) }
  },
  withExistingBoard: (handler) => async (req, res) => {
    const name = req.params.board
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64 || name === 'inbox')
      return res.status(400).json({ error: 'Invalid board name' })
    try { await handler(req, res, {}) }
    catch (e) { res.status(500).json({ error: e.message }) }
  },
  initDb: async () => {},
}

const app  = createApp(dbMock)
const AUTH = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }

beforeEach(() => {
  // Restore defaults so individual tests can override only what they need
  mockCouch.db.list    = async () => []
  mockCouch.db.create  = async () => ({ ok: true })
  mockCouch.db.destroy = async () => ({ ok: true })
})

// ---------------------------------------------------------------------------
// GET /api/boards
// ---------------------------------------------------------------------------
describe('GET /api/boards', () => {
  it('B-1: returns an array of board stats', async () => {
    mockCouch.db.list = async () => ['jc-kanban-alpha', 'jc-kanban-beta']

    const res = await request(app).get('/api/boards').set(AUTH)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(2)
    expect(res.body[0]).toMatchObject({ name: 'alpha' })
    expect(res.body[1]).toMatchObject({ name: 'beta' })
  })

  it('returns empty array when no boards exist', async () => {
    const res = await request(app).get('/api/boards').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// POST /api/boards/:name  (create)
// ---------------------------------------------------------------------------
describe('POST /api/boards/:name', () => {
  it('B-2: valid name → 200 ok:true', async () => {
    const res = await request(app).post('/api/boards/my-board').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('B-3: name with uppercase → 400', async () => {
    const res = await request(app).post('/api/boards/My-Board').set(AUTH)
    expect(res.status).toBe(400)
  })

  it('B-4: reserved name "inbox" → 400', async () => {
    const res = await request(app).post('/api/boards/inbox').set(AUTH)
    expect(res.status).toBe(400)
  })

  it('B-6: name longer than 64 chars → 400', async () => {
    const res = await request(app).post(`/api/boards/${'a'.repeat(65)}`).set(AUTH)
    expect(res.status).toBe(400)
  })

  it('name starting with hyphen → 400', async () => {
    const res = await request(app).post('/api/boards/-invalid').set(AUTH)
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /api/boards/:name/rename
// ---------------------------------------------------------------------------
describe('POST /api/boards/:name/rename', () => {
  it('B-8: valid rename → 200 ok:true', async () => {
    const res = await request(app)
      .post('/api/boards/old-name/rename')
      .set(AUTH)
      .send({ newName: 'new-name' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('B-9: rename to existing name → 409', async () => {
    mockCouch.db.create = async () => {
      const err = new Error('Conflict'); err.statusCode = 412; throw err
    }
    const res = await request(app)
      .post('/api/boards/old-name/rename')
      .set(AUTH)
      .send({ newName: 'existing' })
    expect(res.status).toBe(409)
  })

  it('B-10: rename to "inbox" → 400', async () => {
    const res = await request(app)
      .post('/api/boards/old-name/rename')
      .set(AUTH)
      .send({ newName: 'inbox' })
    expect(res.status).toBe(400)
  })

  it('rename to name longer than 12 chars → 400', async () => {
    const res = await request(app)
      .post('/api/boards/old-name/rename')
      .set(AUTH)
      .send({ newName: 'a-very-long-name' })
    expect(res.status).toBe(400)
  })

  it('rename to identical name → 400', async () => {
    const res = await request(app)
      .post('/api/boards/my-board/rename')
      .set(AUTH)
      .send({ newName: 'my-board' })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/boards/:name
// ---------------------------------------------------------------------------
describe('DELETE /api/boards/:name', () => {
  it('B-11: valid board → 200 ok:true', async () => {
    const res = await request(app).delete('/api/boards/my-board').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('B-12: non-existent board → 404', async () => {
    mockCouch.db.destroy = async () => {
      const err = new Error('not_found'); err.statusCode = 404; throw err
    }
    const res = await request(app).delete('/api/boards/ghost').set(AUTH)
    expect(res.status).toBe(404)
  })
})
