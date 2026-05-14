'use strict'
/**
 * State mutation unit tests — section 2.1 (S-1 … S-10)
 *
 * We use Node's `vm.runInContext` so that ALL top-level bindings in state.js
 * (var, let, const, function) become accessible as properties of a single
 * context object. This avoids the scoping issues of indirect eval where const/
 * let bindings are unreachable from outside.
 *
 * Environment: node is fine (jsdom is not needed here).
 */

const vm   = require('vm')
const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')

let ctx  // the vm context — holds all of state.js's top-level bindings

beforeAll(() => {
  const renderMock = vi.fn()

  // Provide the browser globals that state.js touches at load time.
  ctx = vm.createContext({
    window: { location: { pathname: '/' }, fetch: undefined },
    document: {
      getElementById: () => ({
        textContent: '', className: '', style: {}, classList: { remove: () => {} },
      }),
      querySelectorAll: () => [],
      createElement:    () => ({
        className: '', dataset: {}, style: {},
        addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
      }),
      addEventListener:    () => {},
      removeEventListener: () => {},
    },
    console,
    setTimeout:   () => {},
    setInterval:  () => {},
    clearTimeout: () => {},
    render:       renderMock,   // state.js calls render() as a global
    ICONS:        {},           // referenced by showSaved (only if schedulesSave runs)
  })

  // Append var-based shim accessors that run in the SAME script execution so
  // they can close over the let/const bindings from state.js.
  const src = fs.readFileSync(path.join(FRONTEND, 'state.js'), 'utf8') + `
;var __state    = function()  { return state; };
;var __setState = function(s) { state = s; baseState = null; };
;var __uid      = function()  { return uid(); };
`
  vm.runInContext(src, ctx)
})

beforeEach(() => {
  ctx.__setState({ columns: [] })
  ctx.render.mockClear()
})

// ---------------------------------------------------------------------------
// uid()
// ---------------------------------------------------------------------------
describe('uid()', () => {
  it('S-10: returns unique values across many calls', () => {
    const ids = Array.from({ length: 1000 }, () => ctx.__uid())
    expect(new Set(ids).size).toBe(1000)
  })

  it('result starts with "id-"', () => {
    expect(ctx.__uid()).toMatch(/^id-/)
  })
})

// ---------------------------------------------------------------------------
// buildPatch()
// ---------------------------------------------------------------------------
describe('buildPatch()', () => {
  it('S-8: unchanged state produces empty patch', () => {
    const s     = { columns: [{ id: 'c1', title: 'T', cards: [] }], settings: {} }
    const patch = ctx.buildPatch(s, JSON.parse(JSON.stringify(s)))
    expect(patch).toEqual({})
  })

  it('S-9: changed card text is captured in updatedColumns', () => {
    const base  = { columns: [{ id: 'c1', title: 'T', cards: [{ id: 'k1', text: 'Old' }] }] }
    const curr  = { columns: [{ id: 'c1', title: 'T', cards: [{ id: 'k1', text: 'New' }] }] }
    const patch = ctx.buildPatch(base, curr)
    expect(patch.updatedColumns[0].cards[0].text).toBe('New')
  })

  it('reordered columns sets columnOrder', () => {
    const base  = { columns: [{ id: 'a', title: 'A', cards: [] }, { id: 'b', title: 'B', cards: [] }] }
    const curr  = { columns: [{ id: 'b', title: 'B', cards: [] }, { id: 'a', title: 'A', cards: [] }] }
    const patch = ctx.buildPatch(base, curr)
    expect(patch.columnOrder).toEqual(['b', 'a'])
  })

  it('removed column is listed in removedColumnIds', () => {
    const base  = { columns: [{ id: 'a', title: 'A', cards: [] }, { id: 'b', title: 'B', cards: [] }] }
    const curr  = { columns: [{ id: 'a', title: 'A', cards: [] }] }
    const patch = ctx.buildPatch(base, curr)
    expect(patch.removedColumnIds).toContain('b')
  })

  it('changed settings captured', () => {
    const base  = { columns: [], settings: { description: 'old' } }
    const curr  = { columns: [], settings: { description: 'new' } }
    const patch = ctx.buildPatch(base, curr)
    expect(patch.settings.description).toBe('new')
  })
})

// ---------------------------------------------------------------------------
// mergeStates()
// ---------------------------------------------------------------------------
describe('mergeStates()', () => {
  it('new local column not in remote is added to merged', () => {
    const merged = ctx.mergeStates(
      { columns: [] },
      { columns: [] },
      { columns: [{ id: 'new', title: 'Local', cards: [] }] }
    )
    expect(merged.columns.some(c => c.id === 'new')).toBe(true)
  })

  it('card locally deleted is removed from merged', () => {
    const col  = { id: 'k1', title: 'T', cards: [{ id: 'card-1', text: 'X' }] }
    const base = { columns: [JSON.parse(JSON.stringify(col))] }
    const remote = { columns: [JSON.parse(JSON.stringify(col))] }
    const local  = { columns: [{ id: 'k1', title: 'T', cards: [] }] }
    const merged = ctx.mergeStates(base, remote, local)
    expect(merged.columns[0].cards).toHaveLength(0)
  })

  it('local card edit propagates when remote did not change that field', () => {
    const base   = { columns: [{ id: 'c', title: 'T', cards: [{ id: 'x', text: 'Base',   lastModified: '2025-01-01T00:00:00Z' }] }] }
    const remote = { columns: [{ id: 'c', title: 'T', cards: [{ id: 'x', text: 'Base',   lastModified: '2025-01-01T00:00:00Z' }] }] }
    const local  = { columns: [{ id: 'c', title: 'T', cards: [{ id: 'x', text: 'Edited', lastModified: '2025-01-02T00:00:00Z' }] }] }
    const merged = ctx.mergeStates(base, remote, local)
    expect(merged.columns[0].cards[0].text).toBe('Edited')
  })
})

// ---------------------------------------------------------------------------
// addColumn()
// ---------------------------------------------------------------------------
describe('addColumn()', () => {
  it('S-1: increments column count and assigns a color', () => {
    ctx.addColumn()
    expect(ctx.__state().columns).toHaveLength(1)
    expect(ctx.__state().columns[0].color).toBeTruthy()
    expect(ctx.render).toHaveBeenCalledTimes(1)
  })

  it('new column has a unique id starting with "id-"', () => {
    ctx.addColumn()
    expect(ctx.__state().columns[0].id).toMatch(/^id-/)
  })
})

// ---------------------------------------------------------------------------
// deleteColumn()
// ---------------------------------------------------------------------------
describe('deleteColumn()', () => {
  it('S-2: removes column, no orphaned columns remain', () => {
    ctx.addColumn()
    const id = ctx.__state().columns[0].id
    ctx.render.mockClear()

    ctx.deleteColumn(id)

    expect(ctx.__state().columns).toHaveLength(0)
    expect(ctx.render).toHaveBeenCalledTimes(1)
  })

  it('deleting unknown id is a no-op', () => {
    ctx.deleteColumn('does-not-exist')
    expect(ctx.__state().columns).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// addCard()
// ---------------------------------------------------------------------------
describe('addCard()', () => {
  beforeEach(() => {
    ctx.addColumn()
    ctx.render.mockClear()
  })

  it('S-3: adds card with created date and unique id', () => {
    const colId = ctx.__state().columns[0].id
    const card  = ctx.addCard(colId, { text: 'Hello' })

    expect(card).toBeTruthy()
    expect(card.text).toBe('Hello')
    expect(card.id).toMatch(/^id-/)
    expect(card.created).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ctx.__state().columns[0].cards).toHaveLength(1)
    expect(ctx.render).toHaveBeenCalledTimes(1)
  })

  it('S-4: priority is stored as provided', () => {
    const colId = ctx.__state().columns[0].id
    const card  = ctx.addCard(colId, { text: 'Hi', priority: 5 })
    expect(card.priority).toBe(5)
  })

  it('returns null for unknown column id', () => {
    expect(ctx.addCard('no-such-col', { text: 'X' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// moveCardToColumn() — S-5, S-6, S-7
// ---------------------------------------------------------------------------
describe('moveCardToColumn()', () => {
  let fromColId, toColId, cardId

  beforeEach(() => {
    ctx.addColumn()
    ctx.addColumn()
    fromColId = ctx.__state().columns[0].id
    toColId   = ctx.__state().columns[1].id
    const card = ctx.addCard(fromColId, { text: 'Moving card' })
    cardId = card.id
    ctx.render.mockClear()
  })

  it('S-5: card moves to target column and records move history', () => {
    ctx.moveCardToColumn(fromColId, cardId, toColId)

    expect(ctx.__state().columns[0].cards.every(c => c.id !== cardId)).toBe(true)
    expect(ctx.__state().columns[1].cards[0].id).toBe(cardId)
    expect(ctx.__state().columns[1].cards[0].moves).toHaveLength(1)
    expect(ctx.render).toHaveBeenCalledTimes(1)
  })

  it('S-6: column with markDone action sets done:true on moved card', () => {
    ctx.__state().columns[1].actions = ['markDone']
    ctx.moveCardToColumn(fromColId, cardId, toColId)
    expect(ctx.__state().columns[1].cards[0].done).toBe(true)
    expect(ctx.__state().columns[1].cards[0].doneAt).toBeTruthy()
  })

  it('S-7: column with setEndDate action sets endDate to today', () => {
    const today = new Date().toISOString().slice(0, 10)
    ctx.__state().columns[1].actions = ['setEndDate']
    ctx.moveCardToColumn(fromColId, cardId, toColId)
    expect(ctx.__state().columns[1].cards[0].endDate).toBe(today)
  })
})

// ---------------------------------------------------------------------------
// applyColumnActions()
// ---------------------------------------------------------------------------
describe('applyColumnActions()', () => {
  it('markUndone clears done flag and removes doneAt', () => {
    const card = { id: 'x', text: 'T', done: true, doneAt: '2025-01-01T00:00:00Z' }
    ctx.applyColumnActions(card, { actions: ['markUndone'] })
    expect(card.done).toBe(false)
    expect(card.doneAt).toBeUndefined()
  })

  it('setStartDate sets startDate to today', () => {
    const today = new Date().toISOString().slice(0, 10)
    const card  = { id: 'x', text: 'T' }
    ctx.applyColumnActions(card, { actions: ['setStartDate'] })
    expect(card.startDate).toBe(today)
  })

  it('no actions → no-op', () => {
    const card = { id: 'x', text: 'T' }
    ctx.applyColumnActions(card, { actions: [] })
    expect(card.done).toBeUndefined()
  })
})
