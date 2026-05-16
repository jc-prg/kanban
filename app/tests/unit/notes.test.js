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
      querySelector:      () => null,
      querySelectorAll:   () => [],
      createElement:      () => ({ ...noopEl, innerHTML: '', appendChild: noop }),
      addEventListener:   noop,
      removeEventListener: noop,
      elementFromPoint:   () => null,
    },
    sessionStorage: { getItem: () => null, setItem: noop },
    console,
    setTimeout:    () => {},
    setInterval:   () => {},
    clearTimeout:  noop,
    clearInterval: noop,
    history: { replaceState: noop },
    location: { hash: '', pathname: '', search: '' },

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
    ICONS: { close: 'x', collapse: '−', expand: '+' },
    SVGICONS: { description: () => '', link: () => '', linkedCards: () => '', attachment: () => '' },
    crypto: globalThis.crypto,
  })

  // Load notes.js and append shims.
  const src = fs.readFileSync(path.join(FRONTEND, 'notes.js'), 'utf8') + `
;var __getNotesState    = function()  { return notesState; };
;var __setNotesState    = function(s) { notesState = s; baseNotesState = null; };
;var __buildNotesPatch  = function(b, c) { return buildNotesPatch(b, c); };
;var __flattenPages     = function(items) { return _flattenNotePages(items); };
;var __findPage         = function(id, items) { return findNotePage(id, items); };
;var __findItem         = function(id, items) { return findNoteItem(id, items); };
;var __addNotePage      = function(parentId) { return addNotePage(parentId); };
;var __addNoteFolder    = function(parentId) { return addNoteFolder(parentId); };
;var __deleteNoteItem   = function(id) { return deleteNoteItem(id); };
;var __deleteNotePage   = function(id) { return deleteNotePage(id); };
;var __getPendingPage   = function() { return _pendingNewPage; };
;var __insertPendingPage = function() {
  if (!_pendingNewPage) return null;
  var p = _pendingNewPage; _pendingNewPage = null;
  if (!p.parentId) { notesState.items.push(p.page); }
  else {
    var par = findNoteItem(p.parentId, notesState.items);
    if (par && par.type === 'folder') {
      if (!par.children) par.children = [];
      par.children.push(p.page);
    } else { notesState.items.push(p.page); }
  }
  renderNotesTree(); return p.page;
};
;var __calls = { renderNotesTree: 0, scheduleSaveNotes: 0, openNoteModal: 0, openNoteModalLastArg: undefined };
;var __resetCalls = function() { __calls.renderNotesTree = 0; __calls.scheduleSaveNotes = 0; __calls.openNoteModal = 0; __calls.openNoteModalLastArg = undefined; };
;renderNotesTree   = function() { __calls.renderNotesTree++; };
;scheduleSaveNotes = function() { __calls.scheduleSaveNotes++; };
;openNoteModal     = function(id) { __calls.openNoteModal++; __calls.openNoteModalLastArg = id; };
`
  vm.runInContext(src, ctx)
})

beforeEach(() => {
  ctx.__setNotesState({ items: [], schemaVersion: 2 })
  ctx.render.mockClear()
  ctx.__resetCalls()
})

// ---------------------------------------------------------------------------
// NT-1: addNotePage — top-level page creation
// ---------------------------------------------------------------------------
describe('addNotePage()', () => {
  it('NT-1: creates top-level page with unique n- id', () => {
    ctx.__addNotePage(null)

    // Page is pending until first save — not yet in state
    const pending = ctx.__getPendingPage()
    expect(pending).not.toBeNull()
    expect(pending.page.type).toBe('page')
    expect(pending.page.id).toMatch(/^n-/)
    expect(pending.page.title).toBeTruthy()
    expect(ctx.__calls.openNoteModal).toBe(1)
    expect(ctx.__calls.openNoteModalLastArg).toBe(pending.page.id)

    // After committing (simulates first modal save), page appears in state
    ctx.__insertPendingPage()
    const items = ctx.__getNotesState().items
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('page')
    expect(items[0].id).toMatch(/^n-/)
    expect(ctx.__calls.renderNotesTree).toBe(1)
  })

  it('NT-1: each call produces a unique id', () => {
    ctx.__addNotePage(null)
    const id1 = ctx.__getPendingPage().page.id
    ctx.__insertPendingPage()

    ctx.__addNotePage(null)
    const id2 = ctx.__getPendingPage().page.id
    ctx.__insertPendingPage()

    expect(id1).not.toBe(id2)
  })

  it('creates page inside a folder', () => {
    ctx.__addNoteFolder(null)
    const folderId = ctx.__getNotesState().items[0].id
    ctx.__resetCalls()

    ctx.__addNotePage(folderId)
    ctx.__insertPendingPage()

    const folder = ctx.__getNotesState().items[0]
    expect(folder.type).toBe('folder')
    expect(folder.children).toHaveLength(1)
    expect(folder.children[0].type).toBe('page')
    expect(folder.children[0].id).toMatch(/^n-/)
  })

  it('ignores parentId that refers to a page (pages cannot contain pages)', () => {
    ctx.__addNotePage(null)
    ctx.__insertPendingPage()
    const pageId = ctx.__getNotesState().items[0].id
    ctx.__resetCalls()

    ctx.__addNotePage(pageId) // parentId is a page → should fall back to root
    ctx.__insertPendingPage()

    const items = ctx.__getNotesState().items
    expect(items).toHaveLength(2) // both at root level
  })
})

// ---------------------------------------------------------------------------
// NT-1b: addNoteFolder — folder creation
// ---------------------------------------------------------------------------
describe('addNoteFolder()', () => {
  it('creates top-level folder with unique f- id', () => {
    ctx.__addNoteFolder(null)

    const items = ctx.__getNotesState().items
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('folder')
    expect(items[0].id).toMatch(/^f-/)
    expect(items[0].children).toEqual([])
    expect(ctx.__calls.renderNotesTree).toBe(1)
  })

  it('creates nested folder inside another folder', () => {
    ctx.__addNoteFolder(null)
    const parentId = ctx.__getNotesState().items[0].id
    ctx.__resetCalls()

    ctx.__addNoteFolder(parentId)

    const parent = ctx.__getNotesState().items[0]
    expect(parent.children).toHaveLength(1)
    expect(parent.children[0].type).toBe('folder')
    expect(parent.children[0].id).toMatch(/^f-/)
  })
})

// ---------------------------------------------------------------------------
// NT-2: depth is unrestricted for folders (folders can nest arbitrarily)
// ---------------------------------------------------------------------------
describe('addNoteFolder() — depth behaviour', () => {
  it('NT-2: folders can be nested arbitrarily deep', () => {
    ctx.__addNoteFolder(null)
    const id0 = ctx.__getNotesState().items[0].id

    ctx.__addNoteFolder(id0)
    const id1 = ctx.__getNotesState().items[0].children[0].id

    ctx.__addNoteFolder(id1)
    const grandchildren = ctx.__getNotesState().items[0].children[0].children
    expect(grandchildren).toHaveLength(1)
    expect(grandchildren[0].type).toBe('folder')
  })
})

// ---------------------------------------------------------------------------
// NT-3: deleteNoteItem — removes items and their children
// ---------------------------------------------------------------------------
describe('deleteNoteItem()', () => {
  it('NT-3: removes top-level page', () => {
    ctx.__addNotePage(null)
    ctx.__insertPendingPage()
    const id = ctx.__getNotesState().items[0].id
    ctx.__resetCalls()

    ctx.__deleteNoteItem(id)

    expect(ctx.__getNotesState().items).toHaveLength(0)
    expect(ctx.__calls.renderNotesTree).toBe(1)
  })

  it('NT-3: removes top-level folder and all its children', () => {
    ctx.__addNoteFolder(null)
    const folderId = ctx.__getNotesState().items[0].id
    ctx.__addNotePage(folderId)

    ctx.__deleteNoteItem(folderId)

    expect(ctx.__getNotesState().items).toHaveLength(0)
  })

  it('NT-3: removes nested page while keeping folder', () => {
    ctx.__addNoteFolder(null)
    const folderId = ctx.__getNotesState().items[0].id
    ctx.__addNotePage(folderId)
    ctx.__insertPendingPage()
    const pageId = ctx.__getNotesState().items[0].children[0].id

    ctx.__deleteNoteItem(pageId)

    const items = ctx.__getNotesState().items
    expect(items).toHaveLength(1)            // folder still present
    expect(items[0].children).toHaveLength(0) // page removed
  })

  it('deleteNotePage alias works the same way', () => {
    ctx.__addNotePage(null)
    ctx.__insertPendingPage()
    const id = ctx.__getNotesState().items[0].id

    ctx.__deleteNotePage(id)

    expect(ctx.__getNotesState().items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// NT-4: buildNotesPatch — structural vs content changes
// ---------------------------------------------------------------------------
describe('buildNotesPatch()', () => {
  it('NT-4a: unchanged notes returns empty patch {}', () => {
    const notes = { items: [{ type: 'page', id: 'n-1', title: 'Page', description: '' }], schemaVersion: 2 }
    const patch = ctx.__buildNotesPatch(notes, JSON.parse(JSON.stringify(notes)))
    expect(patch).toEqual({})
  })

  it('NT-4b: description change captured in updatedPages', () => {
    const base    = { items: [{ type: 'page', id: 'n-1', title: 'Page', description: 'old' }], schemaVersion: 2 }
    const current = { items: [{ type: 'page', id: 'n-1', title: 'Page', description: 'new' }], schemaVersion: 2 }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch.updatedPages).toHaveLength(1)
    expect(patch.updatedPages[0].description).toBe('new')
  })

  it('NT-4c: adding a page → returns null (caller should PUT)', () => {
    const base    = { items: [], schemaVersion: 2 }
    const current = { items: [{ type: 'page', id: 'n-new', title: 'New Page' }], schemaVersion: 2 }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch).toBeNull()
  })

  it('NT-4c: adding a folder → returns null (caller should PUT)', () => {
    const base    = { items: [], schemaVersion: 2 }
    const current = { items: [{ type: 'folder', id: 'f-1', title: 'Folder', children: [] }], schemaVersion: 2 }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch).toBeNull()
  })

  it('NT-4d: linkedCards change captured', () => {
    const base    = { items: [{ type: 'page', id: 'n-1', title: 'T', linkedCards: [] }], schemaVersion: 2 }
    const current = { items: [{ type: 'page', id: 'n-1', title: 'T', linkedCards: ['card-x'] }], schemaVersion: 2 }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch.updatedPages[0].linkedCards).toEqual(['card-x'])
  })

  it('NT-4e: page inside folder — description change captured', () => {
    const base = { items: [{ type: 'folder', id: 'f-1', title: 'Folder', children: [
      { type: 'page', id: 'n-1', title: 'P', description: 'old' }
    ]}], schemaVersion: 2 }
    const current = { items: [{ type: 'folder', id: 'f-1', title: 'Folder', children: [
      { type: 'page', id: 'n-1', title: 'P', description: 'new' }
    ]}], schemaVersion: 2 }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch.updatedPages).toHaveLength(1)
    expect(patch.updatedPages[0].description).toBe('new')
  })

  it('NT-4f: moving a page to a different folder → returns null (PUT required)', () => {
    const base = { items: [
      { type: 'folder', id: 'f-1', title: 'A', children: [{ type: 'page', id: 'n-1', title: 'P' }] },
      { type: 'folder', id: 'f-2', title: 'B', children: [] },
    ], schemaVersion: 2 }
    const current = { items: [
      { type: 'folder', id: 'f-1', title: 'A', children: [] },
      { type: 'folder', id: 'f-2', title: 'B', children: [{ type: 'page', id: 'n-1', title: 'P' }] },
    ], schemaVersion: 2 }
    const patch = ctx.__buildNotesPatch(base, current)
    expect(patch).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// findNoteItem / findNotePage helpers
// ---------------------------------------------------------------------------
describe('findNoteItem() / findNotePage()', () => {
  it('finds a root-level page', () => {
    ctx.__setNotesState({ items: [{ type: 'page', id: 'n-1', title: 'P' }], schemaVersion: 2 })
    const found = ctx.__findItem('n-1', ctx.__getNotesState().items)
    expect(found).not.toBeNull()
    expect(found.id).toBe('n-1')
  })

  it('finds a page nested inside a folder', () => {
    ctx.__setNotesState({ items: [
      { type: 'folder', id: 'f-1', title: 'F', children: [{ type: 'page', id: 'n-2', title: 'P' }] }
    ], schemaVersion: 2 })
    const found = ctx.__findPage('n-2', ctx.__getNotesState().items)
    expect(found).not.toBeNull()
    expect(found.id).toBe('n-2')
  })

  it('findNotePage returns null for a folder id', () => {
    ctx.__setNotesState({ items: [
      { type: 'folder', id: 'f-1', title: 'F', children: [] }
    ], schemaVersion: 2 })
    const found = ctx.__findPage('f-1', ctx.__getNotesState().items)
    expect(found).toBeNull()
  })
})
