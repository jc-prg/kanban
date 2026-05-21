'use strict'
/**
 * Webhook config & trigger API tests — section 1.8 (WH-1 … WH-10)
 */

process.env.APP_PASSWORD   = 'test-password'
process.env.API_KEY        = 'test-api-key-that-is-32chars-long!'
process.env.SESSION_SECRET = 'test-session-secret-32-chars-ok!'

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

const request       = require('supertest')
const { createApp } = require('../setup/createApp')

// ---------------------------------------------------------------------------
// Shared mock db — stores multiple docs keyed by _id
// ---------------------------------------------------------------------------
const mockDbCtx = { db: null }

function makeDb(webhookDoc = null) {
  const store = {
    board: { _id: 'board', _rev: '1-abc', columns: [] },
  }
  if (webhookDoc) {
    store['webhook-config'] = { _id: 'webhook-config', _rev: '1-wh', ...webhookDoc }
  }

  return {
    get: vi.fn().mockImplementation(async (id) => {
      if (store[id]) return JSON.parse(JSON.stringify(store[id]))
      const err = new Error('not_found'); err.statusCode = 404; throw err
    }),
    insert: vi.fn().mockImplementation(async (doc) => {
      store[doc._id] = { ...JSON.parse(JSON.stringify(doc)), _rev: '2-abc' }
      return { ok: true, rev: '2-abc' }
    }),
    getStored: (id) => store[id],
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
  loadNotesData: async () => ({ items: [], schemaVersion: 2 }),
  saveNotesData: async () => ({ ok: true }),
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
// GET /:board/webhook-config (WH-1)
// ---------------------------------------------------------------------------
describe('GET /:board/webhook-config', () => {
  it('WH-1: no doc yet → 200 with defaults { enabled:false, name:"", url:"", method:"POST" }', async () => {
    mockDbCtx.db = makeDb()  // no webhook doc stored

    const res = await request(app).get(`/api/${BOARD}/webhook-config`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ enabled: false, name: '', url: '', method: 'POST' })
  })
})

// ---------------------------------------------------------------------------
// PUT /:board/webhook-config (WH-2 … WH-4)
// ---------------------------------------------------------------------------
describe('PUT /:board/webhook-config', () => {
  beforeEach(() => {
    mockDbCtx.db = makeDb()
  })

  it('WH-2: valid config → 200 ok:true; re-GET confirms stored values', async () => {
    const cfg = { enabled: true, name: 'Deploy', url: 'https://hooks.example.com/deploy', method: 'POST' }

    const put = await request(app).put(`/api/${BOARD}/webhook-config`).set(AUTH).send(cfg)
    expect(put.status).toBe(200)
    expect(put.body.ok).toBe(true)

    const get = await request(app).get(`/api/${BOARD}/webhook-config`).set(AUTH)
    expect(get.status).toBe(200)
    expect(get.body).toMatchObject({ enabled: true, name: 'Deploy', url: 'https://hooks.example.com/deploy' })
  })

  it('WH-3: URL without http/https scheme → 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/webhook-config`)
      .set(AUTH)
      .send({ enabled: true, name: 'Test', url: 'ftp://example.com', method: 'POST' })

    expect(res.status).toBe(400)
  })

  it('WH-4: invalid method (DELETE) → 200; method silently falls back to default POST', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/webhook-config`)
      .set(AUTH)
      .send({ enabled: true, name: 'Test', url: 'https://example.com', method: 'DELETE' })

    expect(res.status).toBe(200)

    const get = await request(app).get(`/api/${BOARD}/webhook-config`).set(AUTH)
    expect(get.body.method).toBe('POST')
  })
})

// ---------------------------------------------------------------------------
// POST /:board/webhook/trigger (WH-5 … WH-10)
// ---------------------------------------------------------------------------
describe('POST /:board/webhook/trigger', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('WH-5: no url configured → 400 { ok:false }', async () => {
    mockDbCtx.db = makeDb({ enabled: true, url: '', method: 'POST' })

    const res = await request(app).post(`/api/${BOARD}/webhook/trigger`).set(AUTH)

    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('WH-6: webhook disabled (enabled:false) → 400 { ok:false }', async () => {
    mockDbCtx.db = makeDb({ enabled: false, url: 'https://hooks.example.com/deploy', method: 'POST' })

    const res = await request(app).post(`/api/${BOARD}/webhook/trigger`).set(AUTH)

    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('WH-7: mock target returns 200 → 200 { ok:true, status:200 }', async () => {
    mockDbCtx.db = makeDb({ enabled: true, url: 'https://hooks.example.com/deploy', method: 'POST' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

    const res = await request(app).post(`/api/${BOARD}/webhook/trigger`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, status: 200 })
  })

  it('WH-8: mock target returns 500 → 200 { ok:false, error:"Webhook returned HTTP 500" }', async () => {
    mockDbCtx.db = makeDb({ enabled: true, url: 'https://hooks.example.com/deploy', method: 'POST' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const res = await request(app).post(`/api/${BOARD}/webhook/trigger`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, error: 'Webhook returned HTTP 500' })
  })

  it('WH-9: mock target times out → 200 { ok:false, error:"Webhook timed out (10 s)" }', async () => {
    mockDbCtx.db = makeDb({ enabled: true, url: 'https://hooks.example.com/deploy', method: 'POST' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('AbortError'), { name: 'AbortError' })
    ))

    const res = await request(app).post(`/api/${BOARD}/webhook/trigger`).set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, error: 'Webhook timed out (10 s)' })
  })

  it('WH-10: method GET → fetch called with GET and no body/Content-Type', async () => {
    mockDbCtx.db = makeDb({ enabled: true, url: 'https://hooks.example.com/deploy', method: 'GET' })
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)

    await request(app).post(`/api/${BOARD}/webhook/trigger`).set(AUTH)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.method).toBe('GET')
    expect(opts.body).toBeUndefined()
    expect(opts.headers?.['Content-Type']).toBeUndefined()
  })
})
