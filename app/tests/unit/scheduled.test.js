'use strict'
/**
 * Unit tests for runScheduledCheck in backend/recurring.js — SC-1 … SC-10
 * Tests the scheduled-column processor directly against a mock DB.
 */

const path = require('path')

// ---- DB mock injected before recurring.js is required ----------------------

let _boardState = null
let _savedState = null

const DB_MODULE = path.resolve(__dirname, '../../backend/db.js')
require.cache[DB_MODULE] = {
  id: DB_MODULE, filename: DB_MODULE, loaded: true,
  exports: {
    getCouch:      () => null,
    loadBoardData: async () => JSON.parse(JSON.stringify(_boardState)),
    saveBoardData: async (_db, data) => { _savedState = JSON.parse(JSON.stringify(data)) },
    saveBoardDataRaw: async () => {},
    upsertDoc:     async () => {},
    withBoard:     () => () => {},
    withExistingBoard: () => () => {},
    validBoardName: () => true,
    getBoardDb:    async () => ({}),
    DB_PREFIX:     'jc-kanban-',
    DOC_ID:        'board',
  },
  children: [], paths: [],
}

const CONFIG_MODULE = path.resolve(__dirname, '../../backend/config.js')
require.cache[CONFIG_MODULE] = {
  id: CONFIG_MODULE, filename: CONFIG_MODULE, loaded: true,
  exports: { DB_PREFIX: 'jc-kanban-', DOC_ID: 'board' },
  children: [], paths: [],
}

const { runScheduledCheck } = require('../../backend/recurring')

// ---- Helpers ---------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10)
function yesterday(n = 1) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10)
}
function tomorrow(n = 1) {
  const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10)
}

function makeBoard({ schedCards = [], targetCards = [] } = {}) {
  return {
    columns: [
      { id: 'sched', title: '⏰ Scheduled', cards: schedCards },
      { id: 'inbox', title: 'Inbox',        cards: targetCards },
    ],
    settings: { scheduledColumnId: 'sched' },
  }
}

beforeEach(() => { _savedState = null })

// ---------------------------------------------------------------------------
// SC-1: no scheduledColumnId → no-op
// ---------------------------------------------------------------------------

describe('SC-1: missing scheduledColumnId → no-op', () => {
  it('does not save', async () => {
    _boardState = { columns: [{ id: 'c1', title: 'Todo', cards: [] }], settings: {} }
    await runScheduledCheck({}, 'test')
    expect(_savedState).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SC-2: scheduled column empty → no-op
// ---------------------------------------------------------------------------

describe('SC-2: empty scheduled column → no-op', () => {
  it('does not save', async () => {
    _boardState = makeBoard()
    await runScheduledCheck({}, 'test')
    expect(_savedState).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SC-3: one-time card due today → moved to target column
// ---------------------------------------------------------------------------

describe('SC-3: one-time card due today → moved to target', () => {
  it('card appears in inbox and is removed from scheduled', async () => {
    _boardState = makeBoard({
      schedCards: [{
        id: 'id-aaa111',
        text: 'Buy milk',
        scheduledFor: TODAY,
        scheduledTarget: 'inbox',
        created: TODAY,
      }],
    })
    await runScheduledCheck({}, 'test')
    expect(_savedState).not.toBeNull()
    const sched = _savedState.columns.find(c => c.id === 'sched')
    const inbox = _savedState.columns.find(c => c.id === 'inbox')
    expect(sched.cards).toHaveLength(0)
    expect(inbox.cards).toHaveLength(1)
    expect(inbox.cards[0].text).toBe('Buy milk')
    expect(inbox.cards[0].scheduledFor).toBeUndefined()
    expect(inbox.cards[0].scheduledTarget).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SC-4: one-time card due yesterday → moved (overdue counts as due)
// ---------------------------------------------------------------------------

describe('SC-4: one-time card overdue → moved', () => {
  it('card is moved to target', async () => {
    _boardState = makeBoard({
      schedCards: [{
        id: 'id-bbb222',
        text: 'Overdue task',
        scheduledFor: yesterday(3),
        scheduledTarget: 'inbox',
        created: yesterday(3),
      }],
    })
    await runScheduledCheck({}, 'test')
    expect(_savedState).not.toBeNull()
    const inbox = _savedState.columns.find(c => c.id === 'inbox')
    expect(inbox.cards).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// SC-5: one-time card due tomorrow → stays in scheduled column
// ---------------------------------------------------------------------------

describe('SC-5: one-time card future → not moved', () => {
  it('does not move or save', async () => {
    _boardState = makeBoard({
      schedCards: [{
        id: 'id-ccc333',
        text: 'Future task',
        scheduledFor: tomorrow(2),
        scheduledTarget: 'inbox',
        created: TODAY,
      }],
    })
    await runScheduledCheck({}, 'test')
    expect(_savedState).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SC-6: moved card has no scheduling fields and a move history entry
// ---------------------------------------------------------------------------

describe('SC-6: moved card is clean (no scheduling fields, has moves)', () => {
  it('stripes scheduling metadata and appends move history', async () => {
    _boardState = makeBoard({
      schedCards: [{
        id: 'id-ddd444',
        text: 'Clean card',
        scheduledFor: TODAY,
        scheduledTarget: 'inbox',
        scheduledEndDate: '2026-12-31',
        recurrence: null,
        nextDueDate: null,
        lastCreatedDate: null,
        created: TODAY,
      }],
    })
    await runScheduledCheck({}, 'test')
    const card = _savedState.columns.find(c => c.id === 'inbox').cards[0]
    expect(card.scheduledFor).toBeUndefined()
    expect(card.scheduledTarget).toBeUndefined()
    expect(card.scheduledEndDate).toBeUndefined()
    expect(card.moves).toHaveLength(1)
    expect(card.moves[0].from).toBe('⏰ Scheduled')
    expect(card.moves[0].to).toBe('Inbox')
  })
})

// ---------------------------------------------------------------------------
// SC-7: target column missing → falls back to first non-scheduled column
// ---------------------------------------------------------------------------

describe('SC-7: unknown target column → fallback to first available', () => {
  it('card lands in the fallback column', async () => {
    _boardState = makeBoard({
      schedCards: [{
        id: 'id-eee555',
        text: 'No target',
        scheduledFor: TODAY,
        scheduledTarget: 'nonexistent',
        created: TODAY,
      }],
    })
    await runScheduledCheck({}, 'test')
    const inbox = _savedState.columns.find(c => c.id === 'inbox')
    expect(inbox.cards).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// SC-8: recurring card due today → new card spawned, template updated
// ---------------------------------------------------------------------------

describe('SC-8: recurring card due today → card spawned in target', () => {
  it('creates a new card and updates lastCreatedDate / nextDueDate', async () => {
    _boardState = makeBoard({
      schedCards: [{
        id: 'id-fff666',
        text: 'Weekly review',
        scheduledFor: yesterday(7),
        scheduledTarget: 'inbox',
        recurrence: { type: 'daily', interval: 1 },
        nextDueDate: TODAY,
        lastCreatedDate: yesterday(1),
        created: yesterday(7),
      }],
    })
    await runScheduledCheck({}, 'test')
    expect(_savedState).not.toBeNull()
    const inbox = _savedState.columns.find(c => c.id === 'inbox')
    expect(inbox.cards).toHaveLength(1)
    expect(inbox.cards[0].text).toBe('Weekly review')
    // template stays in scheduled column
    const sched = _savedState.columns.find(c => c.id === 'sched')
    expect(sched.cards).toHaveLength(1)
    expect(sched.cards[0].lastCreatedDate).toBe(TODAY)
    expect(sched.cards[0].nextDueDate).toBeTruthy()
    expect(sched.cards[0].nextDueDate).not.toBe(TODAY)
  })
})

// ---------------------------------------------------------------------------
// SC-9: recurring card not yet due → no card created
// ---------------------------------------------------------------------------

describe('SC-9: recurring card not yet due → no-op', () => {
  it('does not create a card or save', async () => {
    _boardState = makeBoard({
      schedCards: [{
        id: 'id-ggg777',
        text: 'Monthly report',
        scheduledFor: yesterday(1),
        scheduledTarget: 'inbox',
        recurrence: { type: 'daily', interval: 1 },
        nextDueDate: tomorrow(1),
        lastCreatedDate: TODAY,
        created: yesterday(1),
      }],
    })
    await runScheduledCheck({}, 'test')
    expect(_savedState).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SC-10: recurring card dedup — same text already created today → skipped
// ---------------------------------------------------------------------------

describe('SC-10: recurring dedup — already created today → no duplicate', () => {
  it('does not add another card', async () => {
    _boardState = makeBoard({
      schedCards: [{
        id: 'id-hhh888',
        text: 'Daily standup',
        scheduledFor: yesterday(1),
        scheduledTarget: 'inbox',
        recurrence: { type: 'daily', interval: 1 },
        nextDueDate: TODAY,
        lastCreatedDate: yesterday(1),
        created: yesterday(1),
      }],
      targetCards: [{ id: 'id-iii999', text: 'Daily standup', created: TODAY }],
    })
    await runScheduledCheck({}, 'test')
    // dedup fires → nothing changes → no save
    expect(_savedState).toBeNull()
  })
})
