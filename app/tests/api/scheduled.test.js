'use strict'
/**
 * API tests for scheduled-column feature — SC-A1 … SC-A6
 *
 * Covers:
 *   SC-A1..A2  POST /:board/scheduled/run endpoint
 *   SC-A3..A4  PATCH /:board/board — scheduledColumnId persisted / cleared
 *   SC-A5      Schema validation accepts card scheduling fields
 *   SC-A6      Schema validation rejects invalid recurrence type
 */

process.env.APP_PASSWORD   = 'test-password'
process.env.API_KEY        = 'test-api-key-that-is-32chars-long!'
process.env.SESSION_SECRET = 'test-session-secret-32-chars-ok!'

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

const request       = require('supertest')
const { createApp } = require('../setup/createApp')

const AUTH  = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }
const BOARD = 'testboard'
const TODAY = new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Shared mock DB
// ---------------------------------------------------------------------------

const mockDbCtx = { db: null }

function makeDb(boardDoc) {
  const board = Object.assign(
    { _id: 'board', _rev: '1-aaa', columns: [], settings: {} },
    boardDoc,
  )
  return {
    get: vi.fn(async (id) => {
      if (id === 'board') return board
      if (id === 'recurring-tasks') {
        const e = Object.assign(new Error('missing'), { statusCode: 404 }); throw e
      }
      const e = Object.assign(new Error('missing'), { statusCode: 404 }); throw e
    }),
    insert: vi.fn(async (doc) => ({ ok: true, id: doc._id, rev: '2-bbb' })),
  }
}

const _validName = (n) =>
  typeof n === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(n) && n.length <= 64 && n !== 'inbox'

const dbMock = {
  validBoardName: _validName,
  getBoardDb:     async () => mockDbCtx.db,
  loadBoardData:  async (db) => { const { _id, _rev, ...d } = await db.get('board'); return d },
  saveBoardData:  async (db, data) => {
    const { _rev } = await db.get('board')
    return db.insert({ _id: 'board', _rev, ...data })
  },
  upsertDoc: async (db, id, data) => {
    let rev; try { ({ _rev: rev } = await db.get(id)) } catch {}
    return db.insert({ _id: id, ...(rev ? { _rev: rev } : {}), ...data })
  },
  withBoard: (handler) => async (req, res) => {
    if (!_validName(req.params.board)) return res.status(400).json({ error: 'Invalid board name' })
    if (!mockDbCtx.db) return res.status(500).json({ error: 'No mock db' })
    try { await handler(req, res, mockDbCtx.db) }
    catch (e) { res.status(500).json({ error: e.message }) }
  },
  withExistingBoard: (handler) => async (req, res) => {
    if (!_validName(req.params.board)) return res.status(400).json({ error: 'Invalid board name' })
    if (!mockDbCtx.db) return res.status(404).json({ error: 'Board not found' })
    try { await handler(req, res, mockDbCtx.db) }
    catch (e) { res.status(500).json({ error: e.message }) }
  },
}

let app
beforeAll(() => { app = createApp(dbMock) })
beforeEach(() => { mockDbCtx.db = makeDb({}) })

// ---------------------------------------------------------------------------
// SC-A1: POST /scheduled/run — board has no scheduledColumnId → ok, no-op
// ---------------------------------------------------------------------------

describe('SC-A1: POST /scheduled/run — no scheduled column', () => {
  it('returns 200 ok without touching the board', async () => {
    mockDbCtx.db = makeDb({ columns: [{ id: 'c1', title: 'Todo', cards: [] }], settings: {} })
    const res = await request(app)
      .post(`/api/${BOARD}/scheduled/run`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(mockDbCtx.db.insert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// SC-A2: POST /scheduled/run — due one-time card → moved, board saved
// ---------------------------------------------------------------------------

describe('SC-A2: POST /scheduled/run — due one-time card moved', () => {
  it('returns 200 ok and board is saved with card in target column', async () => {
    mockDbCtx.db = makeDb({
      columns: [
        {
          id: 'sched',
          title: '⏰ Scheduled',
          cards: [{
            id:              'id-aaa000111',
            text:            'Release prep',
            scheduledFor:    TODAY,
            scheduledTarget: 'inbox',
            created:         TODAY,
          }],
        },
        { id: 'inbox', title: 'Inbox', cards: [] },
      ],
      settings: { scheduledColumnId: 'sched' },
    })
    const res = await request(app)
      .post(`/api/${BOARD}/scheduled/run`)
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(mockDbCtx.db.insert).toHaveBeenCalled()
    const saved = mockDbCtx.db.insert.mock.calls[0][0]
    const inbox = saved.columns.find(c => c.id === 'inbox')
    const sched = saved.columns.find(c => c.id === 'sched')
    expect(inbox.cards).toHaveLength(1)
    expect(inbox.cards[0].text).toBe('Release prep')
    expect(sched.cards).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// SC-A3: PATCH /:board/board — scheduledColumnId is persisted
// ---------------------------------------------------------------------------

describe('SC-A3: PATCH settings.scheduledColumnId is persisted', () => {
  it('saves scheduledColumnId to the board document', async () => {
    mockDbCtx.db = makeDb({
      columns: [{ id: 'sched', title: '⏰ Scheduled', cards: [] }],
      settings: {},
    })
    const res = await request(app)
      .patch(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({ settings: { scheduledColumnId: 'sched' } })
    expect(res.status).toBe(200)
    const saved = mockDbCtx.db.insert.mock.calls[0][0]
    expect(saved.settings?.scheduledColumnId).toBe('sched')
  })
})

// ---------------------------------------------------------------------------
// SC-A4: PATCH /:board/board — scheduledColumnId can be cleared (omitted)
// ---------------------------------------------------------------------------

describe('SC-A4: PATCH settings without scheduledColumnId clears it', () => {
  it('removes scheduledColumnId from settings on server', async () => {
    mockDbCtx.db = makeDb({
      columns: [],
      settings: { scheduledColumnId: 'sched' },
    })
    const res = await request(app)
      .patch(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({ settings: {} })
    expect(res.status).toBe(200)
    const saved = mockDbCtx.db.insert.mock.calls[0][0]
    expect(saved.settings?.scheduledColumnId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SC-A5: PUT full board — card with scheduling fields passes schema validation
// ---------------------------------------------------------------------------

describe('SC-A5: PUT board with scheduled card fields passes validation', () => {
  it('returns 200', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({
        columns: [{
          id: 'sched',
          title: '⏰ Scheduled',
          cards: [{
            id:              'id-sched000001',
            text:            'Review Q3',
            scheduledFor:    TODAY,
            scheduledTarget: 'c1',
            recurrence:      { type: 'weekly', interval: 1, daysOfWeek: [1] },
            nextDueDate:     TODAY,
            lastCreatedDate: null,
            created:         TODAY,
          }],
        }],
        settings: { scheduledColumnId: 'sched' },
      })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// SC-A6: PUT board — invalid recurrence type rejected by schema
// ---------------------------------------------------------------------------

describe('SC-A6: PUT board — invalid recurrence type is rejected', () => {
  it('returns 400', async () => {
    const res = await request(app)
      .put(`/api/${BOARD}/board`)
      .set(AUTH)
      .send({
        columns: [{
          id: 'sched',
          title: '⏰ Scheduled',
          cards: [{
            id:           'id-sched000002',
            text:         'Bad card',
            scheduledFor: TODAY,
            recurrence:   { type: 'hourly', interval: 1 },
            created:      TODAY,
          }],
        }],
      })
    expect(res.status).toBe(400)
  })
})
