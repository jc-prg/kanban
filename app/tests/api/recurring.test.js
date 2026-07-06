'use strict'
/**
 * API tests for /api/:board/recurring-tasks  — RC-A1 … RC-A17
 */

process.env.APP_PASSWORD   = 'test-password'
process.env.API_KEY        = 'test-api-key-that-is-32chars-long!'
process.env.SESSION_SECRET = 'test-session-secret-32-chars-ok!'

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

const request       = require('supertest')
const { createApp } = require('../setup/createApp')

const AUTH = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }
const BOARD = 'testboard'

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

const mockDbCtx = { db: null }

function makeDb(rtDoc, boardDoc) {
  const rt    = Object.assign({ _id: 'recurring-tasks', _rev: '1-aaa', tasks: [] }, rtDoc)
  const board = Object.assign({ _id: 'board', _rev: '1-bbb', columns: [{ id: 'c1', title: 'Todo', cards: [] }] }, boardDoc)
  return {
    get: vi.fn(async (id) => {
      if (id === 'recurring-tasks') {
        if (rt._missing) { const e = Object.assign(new Error('missing'), { statusCode: 404 }); throw e; }
        return rt
      }
      if (id === 'board') return board
      const e = Object.assign(new Error('missing'), { statusCode: 404 }); throw e
    }),
    insert: vi.fn(async (doc) => ({ ok: true, id: doc._id, rev: '2-abc' })),
  }
}

const _validName = (name) =>
  typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64 && name !== 'inbox'

const dbMock = {
  validBoardName: _validName,
  getBoardDb:    async () => mockDbCtx.db,
  loadBoardData: async (db) => {
    const { _id, _rev, ...data } = await db.get('board')
    return data
  },
  saveBoardData: async (db, data) => {
    const { _rev } = await db.get('board')
    return db.insert({ _id: 'board', _rev, ...data })
  },
  upsertDoc: async (db, id, data) => {
    let rev
    try { ({ _rev: rev } = await db.get(id)) } catch { /* new doc */ }
    return db.insert({ _id: id, ...(rev ? { _rev: rev } : {}), ...data })
  },
  withBoard: (handler) => async (req, res) => {
    const name = req.params.board
    if (!_validName(name)) return res.status(400).json({ error: 'Invalid board name' })
    if (!mockDbCtx.db) return res.status(500).json({ error: 'No mock db' })
    try { await handler(req, res, mockDbCtx.db) }
    catch (e) { res.status(500).json({ error: e.message }) }
  },
  withExistingBoard: (handler) => async (req, res) => {
    const name = req.params.board
    if (!_validName(name)) return res.status(400).json({ error: 'Invalid board name' })
    if (!mockDbCtx.db) return res.status(404).json({ error: 'Board not found' })
    try { await handler(req, res, mockDbCtx.db) }
    catch (e) { res.status(500).json({ error: e.message }) }
  },
}

let app
beforeAll(() => { app = createApp(dbMock) })
beforeEach(() => { mockDbCtx.db = makeDb({}) })

// ---------------------------------------------------------------------------
// RC-A1: GET — no recurring-tasks document
// ---------------------------------------------------------------------------

describe('RC-A1: GET when no document exists', () => {
  it('returns 200 { tasks: [] }', async () => {
    mockDbCtx.db = makeDb({ _missing: true })
    const res = await request(app)
      .get(`/api/${BOARD}/recurring-tasks`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.tasks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// RC-A2: PUT valid tasks → nextDueDate assigned
// ---------------------------------------------------------------------------

describe('RC-A2: PUT valid task array', () => {
  it('returns tasks with nextDueDate computed', async () => {
    const task = {
      enabled: true,
      card: { text: 'Weekly review' },
      targetColumn: 'Todo',
      recurrence: { type: 'weekly', interval: 1, daysOfWeek: [1] },
      startDate: '2026-01-05',
    }
    const res = await request(app)
      .put(`/api/${BOARD}/recurring-tasks`)
      .set(AUTH)
      .send({ tasks: [task] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.tasks).toHaveLength(1)
    expect(res.body.tasks[0].id).toMatch(/^rt-[a-z0-9]+$/)
    expect(res.body.tasks[0].nextDueDate).toBeTruthy()

    // re-GET
    const get = await request(app).get(`/api/${BOARD}/recurring-tasks`).set(AUTH)
    expect(get.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// RC-A3: PUT invalid schema
// ---------------------------------------------------------------------------

describe('RC-A3: PUT missing card.text', () => {
  it('returns 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/recurring-tasks`)
      .set(AUTH)
      .send({ tasks: [{ card: {}, targetColumn: 'Todo', recurrence: { type: 'daily' }, startDate: '2026-01-01' }] })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// RC-A4: PUT weekly missing daysOfWeek
// ---------------------------------------------------------------------------

describe('RC-A4: PUT weekly missing daysOfWeek', () => {
  it('returns 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/recurring-tasks`)
      .set(AUTH)
      .send({ tasks: [{ card: { text: 'x' }, targetColumn: 'Todo', recurrence: { type: 'weekly' }, startDate: '2026-01-01' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/daysOfWeek/i)
  })
})

// ---------------------------------------------------------------------------
// RC-A5: PUT monthly missing dayOfMonth
// ---------------------------------------------------------------------------

describe('RC-A5: PUT monthly missing dayOfMonth', () => {
  it('returns 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/recurring-tasks`)
      .set(AUTH)
      .send({ tasks: [{ card: { text: 'x' }, targetColumn: 'Todo', recurrence: { type: 'monthly' }, startDate: '2026-01-01' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/dayOfMonth/i)
  })
})

// ---------------------------------------------------------------------------
// RC-A6: PUT yearly missing month
// ---------------------------------------------------------------------------

describe('RC-A6: PUT yearly missing month', () => {
  it('returns 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/recurring-tasks`)
      .set(AUTH)
      .send({ tasks: [{ card: { text: 'x' }, targetColumn: 'Todo', recurrence: { type: 'yearly', dayOfMonth: 15 }, startDate: '2026-01-01' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/month/i)
  })
})

// ---------------------------------------------------------------------------
// RC-A7: PUT endDate before startDate
// ---------------------------------------------------------------------------

describe('RC-A7: PUT endDate before startDate', () => {
  it('returns 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/recurring-tasks`)
      .set(AUTH)
      .send({ tasks: [{ card: { text: 'x' }, targetColumn: 'Todo', recurrence: { type: 'daily', interval: 1 }, startDate: '2026-07-01', endDate: '2026-06-01' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/endDate/i)
  })
})

// ---------------------------------------------------------------------------
// RC-A8: PUT > 50 tasks
// ---------------------------------------------------------------------------

describe('RC-A8: PUT more than 50 tasks', () => {
  it('returns 400', async () => {
    const tasks = Array.from({ length: 51 }, (_, i) => ({
      card: { text: `task ${i}` },
      targetColumn: 'Todo',
      recurrence: { type: 'daily', interval: 1 },
      startDate: '2026-01-01',
    }))
    const res = await request(app)
      .put(`/api/${BOARD}/recurring-tasks`)
      .set(AUTH)
      .send({ tasks })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// RC-A9: POST /run — task due today creates card
// ---------------------------------------------------------------------------

describe('RC-A9: POST /run task due today', () => {
  it('returns created:1 and card appears in board', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const rtDoc = {
      tasks: [{
        id: 'rt-abc123456789',
        enabled: true,
        card: { text: 'Daily review' },
        targetColumn: 'Todo',
        recurrence: { type: 'daily', interval: 1 },
        startDate: today,
        lastCreatedDate: null,
        nextDueDate: today,
      }]
    }
    const boardDoc = { columns: [{ id: 'c1', title: 'Todo', cards: [] }] }
    mockDbCtx.db = makeDb(rtDoc, boardDoc)

    const res = await request(app)
      .post(`/api/${BOARD}/recurring-tasks/rt-abc123456789/run`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(1)
    expect(res.body.skipped).toBe(0)
    // board was saved with the new card
    expect(mockDbCtx.db.insert).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// RC-A10: POST /run — dedup (card already exists today)
// ---------------------------------------------------------------------------

describe('RC-A10: POST /run card already exists today', () => {
  it('returns created:0, skipped:1', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const rtDoc = {
      tasks: [{
        id: 'rt-dup000000000',
        enabled: true,
        card: { text: 'Daily review' },
        targetColumn: 'Todo',
        recurrence: { type: 'daily', interval: 1 },
        startDate: today,
        lastCreatedDate: null,
        nextDueDate: today,
      }]
    }
    // Card already exists in target column for today
    const boardDoc = { columns: [{ id: 'c1', title: 'Todo', cards: [{ id: 'id-x', text: 'Daily review', created: today }] }] }
    mockDbCtx.db = makeDb(rtDoc, boardDoc)

    const res = await request(app)
      .post(`/api/${BOARD}/recurring-tasks/rt-dup000000000/run`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(0)
    expect(res.body.skipped).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// RC-A11: POST /run — unknown id
// ---------------------------------------------------------------------------

describe('RC-A11: POST /run unknown id', () => {
  it('returns 404', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/recurring-tasks/rt-doesnotexist/run`)
      .set(AUTH)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// RC-A12: POST /run — disabled task → 400
// ---------------------------------------------------------------------------

describe('RC-A12: POST /run disabled task', () => {
  it('returns 400 task is disabled', async () => {
    const today = new Date().toISOString().slice(0, 10)
    mockDbCtx.db = makeDb({
      tasks: [{
        id: 'rt-disabled0000',
        enabled: false,
        card: { text: 'x' },
        targetColumn: 'Todo',
        recurrence: { type: 'daily', interval: 1 },
        startDate: today,
        lastCreatedDate: null,
        nextDueDate: today,
      }]
    })
    const res = await request(app)
      .post(`/api/${BOARD}/recurring-tasks/rt-disabled0000/run`)
      .set(AUTH)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disabled/)
  })
})

// ---------------------------------------------------------------------------
// RC-A13: unauthenticated
// ---------------------------------------------------------------------------

describe('RC-A13: unauthenticated requests', () => {
  it('GET returns 401', async () => {
    const res = await request(app).get(`/api/${BOARD}/recurring-tasks`)
    expect(res.status).toBe(401)
  })
  it('PUT returns 401', async () => {
    const res = await request(app).put(`/api/${BOARD}/recurring-tasks`).send({ tasks: [] })
    expect(res.status).toBe(401)
  })
  it('POST /run returns 401', async () => {
    const res = await request(app).post(`/api/${BOARD}/recurring-tasks/rt-abc/run`)
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// RC-A14: targetColumn not found, inbox column exists → card in inbox
// ---------------------------------------------------------------------------

describe('RC-A14: targetColumn not found, inbox column exists', () => {
  it('card lands in inbox column', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const rtDoc = {
      tasks: [{
        id: 'rt-inbox000000',
        enabled: true,
        card: { text: 'Inbox fallback' },
        targetColumn: 'NoSuchColumn',
        recurrence: { type: 'daily', interval: 1 },
        startDate: today,
        lastCreatedDate: null,
        nextDueDate: today,
      }]
    }
    const boardDoc = {
      columns: [
        { id: 'c0', title: 'Other',   cards: [] },
        { id: 'c1', title: 'Inbox',   cards: [] },
        { id: 'c2', title: 'Todo',    cards: [] },
      ]
    }
    mockDbCtx.db = makeDb(rtDoc, boardDoc)

    const res = await request(app)
      .post(`/api/${BOARD}/recurring-tasks/rt-inbox000000/run`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(1)
    // The card was saved via saveBoardData — check insert was called
    const insertCalls = mockDbCtx.db.insert.mock.calls
    const boardSave   = insertCalls.find(c => c[0]._id === 'board')
    expect(boardSave).toBeTruthy()
    const savedCols = boardSave[0].columns
    const inbox = savedCols.find(c => c.title === 'Inbox')
    expect(inbox.cards).toHaveLength(1)
    expect(inbox.cards[0].text).toBe('Inbox fallback')
  })
})

// ---------------------------------------------------------------------------
// RC-A15: targetColumn not found, no inbox → card in first column
// ---------------------------------------------------------------------------

describe('RC-A15: targetColumn not found, no inbox column', () => {
  it('card lands in first column', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const rtDoc = {
      tasks: [{
        id: 'rt-firstcol0000',
        enabled: true,
        card: { text: 'First col fallback' },
        targetColumn: 'NoSuchColumn',
        recurrence: { type: 'daily', interval: 1 },
        startDate: today,
        lastCreatedDate: null,
        nextDueDate: today,
      }]
    }
    const boardDoc = {
      columns: [
        { id: 'c0', title: 'Backlog', cards: [] },
        { id: 'c1', title: 'Todo',    cards: [] },
      ]
    }
    mockDbCtx.db = makeDb(rtDoc, boardDoc)

    const res = await request(app)
      .post(`/api/${BOARD}/recurring-tasks/rt-firstcol0000/run`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(1)

    const insertCalls = mockDbCtx.db.insert.mock.calls
    const boardSave   = insertCalls.find(c => c[0]._id === 'board')
    const firstCol    = boardSave[0].columns[0]
    expect(firstCol.title).toBe('Backlog')
    expect(firstCol.cards).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// RC-A16: POST /run — 3 missed dates → single card with "(3x missed)" suffix
// ---------------------------------------------------------------------------

describe('RC-A16: POST /run 3 missed dates', () => {
  it('creates single card with (3x missed) in description', async () => {
    const today        = new Date().toISOString().slice(0, 10)
    const threeDaysAgo = new Date(new Date() - 3 * 86400000).toISOString().slice(0, 10)
    const rtDoc = {
      tasks: [{
        id: 'rt-missed000000',
        enabled: true,
        card: { text: 'Daily standup', description: 'Base desc' },
        targetColumn: 'Todo',
        recurrence: { type: 'daily', interval: 1 },
        startDate: threeDaysAgo,
        lastCreatedDate: null,  // never run
        nextDueDate: threeDaysAgo,
      }]
    }
    mockDbCtx.db = makeDb(rtDoc, { columns: [{ id: 'c1', title: 'Todo', cards: [] }] })

    const res = await request(app)
      .post(`/api/${BOARD}/recurring-tasks/rt-missed000000/run`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(1)

    const insertCalls = mockDbCtx.db.insert.mock.calls
    const boardSave   = insertCalls.find(c => c[0]._id === 'board')
    const card = boardSave[0].columns[0].cards[0]
    expect(card.description).toMatch(/\(3x missed\)|\(4x missed\)/)  // depending on exact timing
  })
})

// ---------------------------------------------------------------------------
// RC-A17: POST /run — task due exactly today, no missed count suffix
// ---------------------------------------------------------------------------

describe('RC-A17: POST /run — due today, no missed count', () => {
  it('description unchanged (no (Nx missed))', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(new Date() - 86400000).toISOString().slice(0, 10)
    const rtDoc = {
      tasks: [{
        id: 'rt-notmissed0000',
        enabled: true,
        card: { text: 'Daily standup', description: 'Notes here' },
        targetColumn: 'Todo',
        recurrence: { type: 'daily', interval: 1 },
        startDate: '2026-01-01',
        lastCreatedDate: yesterday,  // ran yesterday, so today is the only due date
        nextDueDate: today,
      }]
    }
    mockDbCtx.db = makeDb(rtDoc, { columns: [{ id: 'c1', title: 'Todo', cards: [] }] })

    const res = await request(app)
      .post(`/api/${BOARD}/recurring-tasks/rt-notmissed0000/run`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(1)

    const boardSave = mockDbCtx.db.insert.mock.calls.find(c => c[0]._id === 'board')
    const card = boardSave[0].columns[0].cards[0]
    expect(card.description).toBe('Notes here')
    expect(card.description).not.toMatch(/missed/)
  })
})
