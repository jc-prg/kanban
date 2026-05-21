'use strict'
/**
 * Import & move-to API tests — section 1.4 (I-1 … I-10)
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
// Shared mock db — each test refreshes mockDbCtx.db with a stateful mock
// that allows import to mutate and re-read the board document.
// ---------------------------------------------------------------------------
const mockDbCtx = { db: null }

function makeMockDb(boardDoc) {
  // Keep a mutable doc so loadBoardData + saveBoardData round-trips work.
  let currentDoc = { _id: 'board', _rev: '1-abc', columns: [], ...boardDoc }
  const db = {
    get: vi.fn().mockImplementation(async () => JSON.parse(JSON.stringify(currentDoc))),
    insert: vi.fn().mockImplementation(async (data) => {
      currentDoc = { ...JSON.parse(JSON.stringify(data)), _rev: '2-abc' }
      return { ok: true, id: 'board', rev: '2-abc' }
    }),
    getLastSaved: () => currentDoc,
  }
  return db
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
  loadNotesData: async () => ({ pages: [] }),
  saveNotesData: async () => ({ ok: true, id: 'notes', rev: '1-abc' }),
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
// POST /:board/import — plain array (I-1)
// ---------------------------------------------------------------------------
describe('POST /:board/import — plain array', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [{ id: 'col-1', title: 'Inbox', cards: [] }] })
  })

  it('I-1: plain array → cards land in Inbox with individual colors', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/import`)
      .set(AUTH)
      .send([
        { text: 'Card A', color: '#aabbcc' },
        { text: 'Card B' },
      ])

    expect(res.status).toBe(200)
    expect(res.body.relevant).toBe(2)
    expect(res.body.relevant_items).toHaveLength(2)
    expect(res.body.relevant_items[0].text).toBe('Card A')
    expect(res.body.relevant_items[0].color).toBe('#aabbcc')
    expect(res.body.excluded).toBe(0)
    expect(res.body.duplicates).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// POST /:board/import — classified object (I-2)
// ---------------------------------------------------------------------------
describe('POST /:board/import — classified object', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [] })
  })

  it('I-2: { relevant, excluded } → relevant get green, excluded get red', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/import`)
      .set(AUTH)
      .send({
        relevant: [{ text: 'Good one' }],
        excluded: [{ text: 'Bad one' }],
      })

    expect(res.status).toBe(200)
    expect(res.body.relevant).toBe(1)
    expect(res.body.excluded).toBe(1)
    expect(res.body.relevant_items[0].color).toBe('#10b981')
    expect(res.body.excluded_items[0].color).toBe('#ef4444')
  })
})

// ---------------------------------------------------------------------------
// POST /:board/import — job-application objects (I-3)
// ---------------------------------------------------------------------------
describe('POST /:board/import — job-application objects', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [] })
  })

  it('I-3: job-title + company + location → text = "title | company | location"; reason → description', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/import`)
      .set(AUTH)
      .send([{
        'job-title': 'Engineer',
        company:     'ACME',
        location:    'Berlin',
        reason:      'Great fit',
      }])

    expect(res.status).toBe(200)
    const card = res.body.relevant_items[0]
    expect(card.text).toBe('Engineer | ACME | Berlin')
    expect(card.description).toBe('Great fit')
  })
})

// ---------------------------------------------------------------------------
// POST /:board/import — duplicate detection (I-4)
// ---------------------------------------------------------------------------
describe('POST /:board/import — duplicate detection', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({
      columns: [{ id: 'col-1', title: 'Inbox', cards: [{ id: 'c1', text: 'Already here' }] }],
    })
  })

  it('I-4: duplicate card text is counted as duplicate (not relevant/excluded)', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/import`)
      .set(AUTH)
      .send([{ text: 'Already here' }, { text: 'Brand new' }])

    expect(res.status).toBe(200)
    expect(res.body.duplicates).toBe(1)
    expect(res.body.relevant).toBe(1)
    expect(res.body.duplicate_items[0].text).toBe('Already here')
  })
})

// ---------------------------------------------------------------------------
// POST /:board/import — Inbox column creation (I-5)
// ---------------------------------------------------------------------------
describe('POST /:board/import — Inbox auto-creation', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [] })  // no Inbox
  })

  it('I-5: Inbox column created at position 0 when absent', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/import`)
      .set(AUTH)
      .send([{ text: 'New card' }])

    expect(res.status).toBe(200)
    const saved = mockDbCtx.db.getLastSaved()
    expect(saved.columns[0].title).toBe('Inbox')
    expect(saved.columns[0].cards.some(c => c.text === 'New card')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POST /:board/import — inboxWithDate setting (I-6)
// ---------------------------------------------------------------------------
describe('POST /:board/import — inboxWithDate', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [], settings: { inboxWithDate: true } })
  })

  it('I-6: inboxWithDate:true → inbox column title includes today\'s date (DD.MM. format)', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/import`)
      .set(AUTH)
      .send([{ text: 'Dated card' }])

    expect(res.status).toBe(200)
    const saved = mockDbCtx.db.getLastSaved()
    const now = new Date()
    const dd = String(now.getDate()).padStart(2, '0')
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    expect(saved.columns[0].title).toMatch(new RegExp(`Inbox.*${dd}\\.${mm}\\.`))
  })
})

// ---------------------------------------------------------------------------
// POST /:board/move-to/:name (I-7 … I-10)
// ---------------------------------------------------------------------------
describe('POST /:board/move-to/:name', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({
      columns: [
        {
          id: 'col-inbox', title: 'Inbox',
          cards: [{ id: 'c1', text: 'Engineer | ACME | Berlin' }],
        },
        { id: 'col-done', title: 'Done', cards: [] },
      ],
    })
  })

  it('I-7: move matching card to existing column → success:true, card in target', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/move-to/done`)
      .set(AUTH)
      .send({ 'job-title': 'Engineer', company: 'ACME', location: 'Berlin' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.toColumn).toBe('Done')
    expect(res.body.moved).toBeTruthy()
  })

  it('I-8: move-to nonexistent column → success:false', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/move-to/nonexistent`)
      .set(AUTH)
      .send({ 'job-title': 'Engineer', company: 'ACME', location: 'Berlin' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(false)
  })

  it('I-9: card text not found in any column → success:false', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/move-to/done`)
      .set(AUTH)
      .send({ 'job-title': 'Ghost', company: 'Nobody', location: 'Nowhere' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(false)
    expect(res.body.moved).toBeNull()
  })

  it('I-10: location "test-city" Easter egg → success:true, card not actually moved', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/move-to/done`)
      .set(AUTH)
      .send({ 'job-title': 'Engineer', company: 'ACME', location: 'test-city' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    // Route returns early — no saveBoardData call, so db.insert was never called
    expect(mockDbCtx.db.insert.mock.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// POST /:board/import — invalid body
// ---------------------------------------------------------------------------
describe('POST /:board/import — invalid body', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [] })
  })

  it('non-array non-classified body → 400', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/import`)
      .set(AUTH)
      .send({ foo: 'bar' })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /:board/inbox — quick-add (I-11 … I-15)
// ---------------------------------------------------------------------------
describe('POST /:board/inbox — single card object', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [] })
  })

  it('I-11: single card object → added:1, card appears in Inbox', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/inbox`)
      .set(AUTH)
      .send({ text: 'Quick task' })

    expect(res.status).toBe(200)
    expect(res.body.added).toBe(1)
    expect(res.body.added_items).toHaveLength(1)
    expect(res.body.added_items[0].text).toBe('Quick task')
    expect(res.body.duplicates).toBe(0)

    const saved = mockDbCtx.db.getLastSaved()
    const inbox = saved.columns.find(c => c.title === 'Inbox')
    expect(inbox).toBeDefined()
    expect(inbox.cards.some(c => c.text === 'Quick task')).toBe(true)
  })
})

describe('POST /:board/inbox — array of cards', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [] })
  })

  it('I-12: array of cards → all non-duplicate cards added', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/inbox`)
      .set(AUTH)
      .send([{ text: 'Card One' }, { text: 'Card Two' }])

    expect(res.status).toBe(200)
    expect(res.body.added).toBe(2)
    expect(res.body.duplicates).toBe(0)
  })
})

describe('POST /:board/inbox — duplicate detection', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({
      columns: [{ id: 'col-1', title: 'Backlog', cards: [{ id: 'c1', text: 'Existing task' }] }],
    })
  })

  it('I-13: card with text already in a column → duplicates:1, card inserted with duplicate:true', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/inbox`)
      .set(AUTH)
      .send({ text: 'Existing task' })

    expect(res.status).toBe(200)
    expect(res.body.duplicates).toBe(1)
    expect(res.body.duplicate_items[0].text).toBe('Existing task')
    expect(res.body.duplicate_items[0].duplicate).toBe(true)
    // Card is still inserted into inbox
    const saved = mockDbCtx.db.getLastSaved()
    const inbox = saved.columns.find(c => c.title === 'Inbox')
    expect(inbox).toBeDefined()
    expect(inbox.cards.some(c => c.text === 'Existing task')).toBe(true)
  })
})

describe('POST /:board/inbox — inboxWithDate', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [], settings: { inboxWithDate: true } })
  })

  it('I-14: inboxWithDate:true → Inbox column title includes today\'s date', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/inbox`)
      .set(AUTH)
      .send({ text: 'Dated card' })

    expect(res.status).toBe(200)
    const saved = mockDbCtx.db.getLastSaved()
    const now = new Date()
    const dd = String(now.getDate()).padStart(2, '0')
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    expect(saved.columns[0].title).toMatch(new RegExp(`Inbox.*${dd}\\.${mm}\\.`))
  })
})

describe('POST /:board/inbox — invalid body', () => {
  beforeEach(() => {
    mockDbCtx.db = makeMockDb({ columns: [] })
  })

  it('I-15: missing required "text" field → 400', async () => {
    const res = await request(app)
      .post(`/api/${BOARD}/inbox`)
      .set(AUTH)
      .send({ priority: 1 })

    expect(res.status).toBe(400)
  })
})
