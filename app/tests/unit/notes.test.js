'use strict'
/**
 * Notes helper unit tests — section 2.4 (NT-1 … NT-4)
 *
 * notes.js is loaded via vm.runInContext (same technique as state.test.js).
 * Browser globals that notes.js needs at load time are stubbed in the context.
 *
 * Environment: node (no DOM needed for the pure helper functions).
 */

const vm   = require('vm')
const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')

let ctx

beforeAll(() => {
  const noop = () => {}
  const noopEl = {
    style: {}, classList: { toggle: noop, add: noop, remove: noop },
    addEventListener: noop, removeEventListener: noop,
    offsetWidth: 230,
  }

  ctx = vm.createContext({
    // Minimal browser globals
    window:   { innerWidth: 1280 },
    document: {
      getElementById:     () => noopEl,
      querySelectorAll:   () => [],
      createElement:      () => ({ ...noopEl, innerHTML: '', appendChild: noop }),
      addEventListener:   noop,
      removeEventListener: noop,
    },
    console,
    setTimeout:    () => {},
    setInterval:   () => {},
    clearTimeout:  noop,
    clearInterval: noop,

    // Globals that notes.js reads at module level
    API_BASE: null,   // makes NOTES_API = null (disables network)
    state:    { columns: [], settings: {} },

    // render() is not defined in notes.js so vi.fn() stays intact.
    // renderNotesTree, scheduleSaveNotes, openNoteModal ARE defined in notes.js
    // — they will overwrite anything here. We override them via shims appended
    // to the script below.
    render:        vi.fn(),
    schedulesSave: vi.fn(),

    // escHtml used in renderNotesTree
    escHtml: (s) => String(s),

    // ICONS used in some render paths
    ICONS: {},
    SVGICONS: { description: () => '' },
  })

  // Load notes.js and append shims.
  // - var shims can close over the let/const bindings from notes.js.
  // - Override DOM-heavy functions (defined in notes.js) with plain trackers
  //   AFTER the script runs so we don't get no-op placeholders overwritten.
  const src = fs.readFileSync(path.join(FRONTEND, 'notes.js'), 'utf8') + `
;var __getNotesState    = function()  { return notesState; };
;var __setNotesState    = function(s) { notesState = s; baseNotesState = null; };
;var __buildNotesPatch  = function(b, c) { return buildNotesPatch(b, c); };
;var __flattenPages     = function(p)  { return _flattenNotePages(p); };
;var __findPage         = function(id, pages) { return findNotePage(id, pages); };
;var __addNotePage      = function(parentId) { return addNotePage(parentId); };
;var __deleteNotePage   = function(id) { return deleteNotePage(id); };
;var __mergeNotesStates = function(b, r, l) { return mergeNotesStates(b, r, l); };
;var __calls = { renderNotesTree: 0, scheduleSaveNotes: 0, openNoteModal: 0, openNoteModalLastArg: undefined };
;var __resetCalls = function() { __calls.renderNotesTree = 0; __calls.scheduleSaveNotes = 0; __calls.openNoteModal = 0; __calls.openNoteModalLastArg = undefined; };
;renderNotesTree   = function() { __calls.renderNotesTree++; };
;scheduleSaveNotes = function() { __calls.scheduleSaveNotes++; };
;openNoteModal     = function(id) { __calls.openNoteModal++; __calls.openNoteModalLastArg = id; };
`
  vm.runInContext(src, ctx)
})

beforeEach(() => {
  ctx.__setNotesState({ pages: [] })
  ctx.render.mockClear()
  ctx.__resetCalls()
})

// ---------------------------------------------------------------------------
// NT-1: addNotePage — top-level page creation
// ---------------------------------------------------------------------------
describe('addNotePage()', () => {
  it('NT-1: creates top-level page with unique n- id', () => {
    ctx.__addNotePage(null)

    const pages = ctx.__getNotesState().pages
    expect(pages).toHaveLength(1)
    expect(pages[0].id).toMatch(/^n-/)
    expect(pages[0].title).toBeTruthy()
    expect(ctx.__calls.renderNotesTree).toBe(1)
    expect(ctx.__calls.openNoteModalLastArg).toBe(pages[0].id)
  })

  it('NT-1: each call produces a unique id', () => {
    ctx.__addNotePage(null)
    ctx.__addNotePage(null)
    const pages = ctx.__getNotesState().pages
    expect(pages[0].id).not.toBe(pages[1].id)
  })

  it('creates child page under existing parent', () => {
    ctx.__addNotePage(null)            // create root
    const parentId = ctx.__getNotesState().pages[0].id
    ctx.__resetCalls()

    ctx.__addNotePage(parentId)        // create child

    const parent = ctx.__getNotesState().pages[0]
    expect(parent.children).toHaveLength(1)
    expect(parent.children[0].id).toMatch(/^n-/)
  })
})

// ---------------------------------------------------------------------------
// NT-2: depth limit is a UI constraint, not enforced by addNotePage itself.
// The function allows adding children to any level. Document this behaviour.
// ---------------------------------------------------------------------------
describe('addNotePage() — depth behaviour', () => {
  it('NT-2 (documented behaviour): addNotePage does not enforce depth limits', () => {
    // Level 0 → level 1 → level 2 (grandchild)
    ctx.__addNotePage(null)
    const rootId = ctx.__getNotesState().pages[0].id

    ctx.__addNotePage(rootId)
    const childId = ctx.__getNotesState().pages[0].children[0].id

    // Adding a grandchild should succeed (depth limit is UI-only)
    ctx.__addNotePage(childId)
    const grandchildren = ctx.__getNotesState().pages[0].children[0].children
    expect(grandchildren).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// NT-3: deleteNotePage — removes page and all its children
// ---------------------------------------------------------------------------
describe('deleteNotePage()', () => {
  it('NT-3: removes top-level page', () => {
    ctx.__addNotePage(null)
    const id = ctx.__getNotesState().pages[0].id
    ctx.__resetCalls()

    ctx.__deleteNotePage(id)

    expect(ctx.__getNotesState().pages).toHaveLength(0)
    expect(ctx.__calls.renderNotesTree).toBe(1)
  })

  it('NT-3: removing parent also removes its children (no orphans)', () => {
    ctx.__addNotePage(null)
    const parentId = ctx.__getNotesState().pages[0].id
    ctx.__addNotePage(parentId)

    ctx.__deleteNotePage(parentId)

    expect(ctx.__getNotesState().pages).toHaveLength(0)
  })

  it('NT-3: removes nested child while keeping parent', () => {
    ctx.__addNotePage(null)
    const parentId = ctx.__getNotesState().pages[0].id
    ctx.__addNotePage(parentId)
    const childId = ctx.__getNotesState().pages[0].children[0].id

    ctx.__deleteNotePage(childId)

    const pages = ctx.__getNotesState().pages
    expect(pages).toHaveLength(1)                  // parent still present
    expect(pages[0].children).toHaveLength(0)       // child removed
  })
})

// ---------------------------------------------------------------------------
// NT-4: buildNotesPatch — linked card tracking via notes state
// ---------------------------------------------------------------------------
describe('buildNotesPatch()', () => {
  it('NT-4a: unchanged notes returns empty patch {}', () => {
    const notes = { pages: [{ id: 'n-1', title: 'Page', description: '' }] }
    const patch = ctx.__buildNotesPatch(notes, JSON.parse(JSON.stringify(notes)))
    expect(patch).toEqual({})
  })

  it('NT-4b: description change captured in updatedPages', () => {
    const base    = { pages: [{ id: 'n-1', title: 'Page', description: 'old' }] }
    const current = { pages: [{ id: 'n-1', title: 'Page', description: 'new' }] }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch.updatedPages).toHaveLength(1)
    expect(patch.updatedPages[0].description).toBe('new')
  })

  it('NT-4c: structural change (add page) → returns null (caller should PUT)', () => {
    const base    = { pages: [] }
    const current = { pages: [{ id: 'n-new', title: 'New Page' }] }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch).toBeNull()
  })

  it('NT-4d: linkedCards change captured', () => {
    const base    = { pages: [{ id: 'n-1', title: 'T', linkedCards: [] }] }
    const current = { pages: [{ id: 'n-1', title: 'T', linkedCards: ['card-x'] }] }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch.updatedPages[0].linkedCards).toEqual(['card-x'])
  })
})

// ---------------------------------------------------------------------------
// mergeNotesStates()
// ---------------------------------------------------------------------------
describe('mergeNotesStates()', () => {
  it('page new in local but absent in remote is appended to root', () => {
    const base   = { pages: [] }
    const remote = { pages: [] }
    const local  = { pages: [{ id: 'n-local', title: 'Local Only', children: [] }] }

    const merged = ctx.__mergeNotesStates(base, remote, local)
    expect(merged.pages.some(p => p.id === 'n-local')).toBe(true)
  })

  it('page deleted locally is removed from merged result', () => {
    const page   = { id: 'n-del', title: 'To Delete', children: [] }
    const base   = { pages: [{ ...page }] }
    const remote = { pages: [{ ...page }] }
    const local  = { pages: [] }

    const merged = ctx.__mergeNotesStates(base, remote, local)
    expect(merged.pages.some(p => p.id === 'n-del')).toBe(false)
  })

  it('local description edit propagates when remote did not change it', () => {
    const ts = new Date().toISOString()
    const base   = { pages: [{ id: 'n-1', title: 'T', description: 'old', lastModified: '2025-01-01T00:00:00Z', children: [] }] }
    const remote = { pages: [{ id: 'n-1', title: 'T', description: 'old', lastModified: '2025-01-01T00:00:00Z', children: [] }] }
    const local  = { pages: [{ id: 'n-1', title: 'T', description: 'new', lastModified: ts, children: [] }] }

    const merged = ctx.__mergeNotesStates(base, remote, local)
    expect(merged.pages[0].description).toBe('new')
  })
})
