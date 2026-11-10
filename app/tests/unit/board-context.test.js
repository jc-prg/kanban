'use strict'
/**
 * Board context switching (Today in-place editing) — BC-1 … BC-6
 *
 * state.js derives ROUTE / BOARD_NAME / API from the URL; on Today, setBoardContext()
 * points the board globals at the board of the card being edited, and flushBoardSave()
 * runs a pending debounced save immediately (before switching boards / navigating).
 * Loaded with vm.runInContext like state.test.js; here `window` is the context itself so
 * the fetch interceptor in state.js wraps the mocked fetch.
 */

const vm   = require('vm')
const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')
const STATE_SRC = fs.readFileSync(path.join(FRONTEND, 'state.js'), 'utf8')

function makeCtx(pathname, fetchImpl) {
  const el = () => ({ textContent: '', className: '', style: {}, classList: { remove: () => {}, add: () => {} } })
  const ctx = vm.createContext({
    location: { pathname },
    document: {
      querySelector:       () => null,
      getElementById:      el,
      querySelectorAll:    () => [],
      addEventListener:    () => {},
      removeEventListener: () => {},
    },
    console,
    setTimeout, clearTimeout,
    setInterval: () => {},
    render: vi.fn(),
    ICONS:  { done: '✓', error: '!' },
    crypto: globalThis.crypto,
    fetch:  fetchImpl || vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) })),
  })
  ctx.window = ctx
  ctx.__fetchMock = ctx.fetch   // state.js replaces window.fetch with its interceptor
  // CARD_ATTACH_API lives in cards.js; declare it so setBoardContext can update it
  vm.runInContext(STATE_SRC + `
;let CARD_ATTACH_API = null;
;var __get = function() { return { ROUTE, BOARD_NAME, API_BASE, API, CARD_ATTACH_API, state, baseState, boardEtag, saveTimer }; };
;var __set = function(s, base) { state = s; baseState = base; };
`, ctx)
  return ctx
}

const board = (title = 'Todo', text = 'A') => ({ columns: [{ id: 'c1', title, cards: [{ id: 'id-1', text }] }] })

test('BC-1 ROUTE / BOARD_NAME from the URL: board page vs. Today', () => {
  const b = makeCtx('/board/jobs').__get()
  expect(b.ROUTE).toBe('board')
  expect(b.BOARD_NAME).toBe('jobs')
  expect(b.API).toBe('/api/jobs/board')

  for (const p of ['/today', '/']) {
    const t = makeCtx(p).__get()
    expect(t.ROUTE).toBe('today')
    expect(t.BOARD_NAME).toBeNull()
    expect(t.API).toBeNull()
  }
})

test('BC-2 setBoardContext — sets the board globals and the attachment API, resets state and ETag', () => {
  const ctx = makeCtx('/today')
  ctx.__set(board(), board())
  vm.runInContext('boardEtag = "\\"3-x\\""; colCollapsed.add("c1");', ctx)

  ctx.setBoardContext('my-board')
  const g = ctx.__get()
  expect(g.ROUTE).toBe('today')                     // the page stays Today
  expect(g.BOARD_NAME).toBe('my-board')
  expect(g.API_BASE).toBe('/api/my-board')
  expect(g.API).toBe('/api/my-board/board')
  expect(g.CARD_ATTACH_API).toBe('/api/my-board/cards/attachments')
  expect(g.state).toEqual({ columns: [] })
  expect(g.baseState).toBeNull()
  expect(g.boardEtag).toBeNull()
  expect(vm.runInContext('colCollapsed.size', ctx)).toBe(0)

  ctx.setBoardContext(null)
  expect(ctx.__get().API).toBeNull()
  expect(ctx.__get().CARD_ATTACH_API).toBeNull()
})

test('BC-3 flushBoardSave — sends the pending PATCH right away (no 600 ms debounce)', async () => {
  const ctx = makeCtx('/today')
  ctx.setBoardContext('jobs')
  ctx.__set(board('Todo', 'changed'), board('Todo', 'original'))
  ctx.schedulesSave()
  expect(ctx.__get().saveTimer).not.toBeNull()
  expect(ctx.__fetchMock).not.toHaveBeenCalled()

  await ctx.flushBoardSave()
  expect(ctx.__fetchMock).toHaveBeenCalledTimes(1)
  const [url, opts] = ctx.__fetchMock.mock.calls[0]
  expect(url).toBe('/api/jobs/board')
  expect(opts.method).toBe('PATCH')
  expect(JSON.parse(opts.body).updatedColumns[0].cards[0].text).toBe('changed')
  expect(ctx.__get().saveTimer).toBeNull()
})

test('BC-4 flushBoardSave — waits for a save that is already in flight', async () => {
  let release
  const fetchImpl = vi.fn(() => new Promise(r => { release = () => r({ ok: true, status: 200, headers: { get: () => null } }) }))
  const ctx = makeCtx('/today', fetchImpl)
  ctx.setBoardContext('jobs')
  ctx.__set(board('Todo', 'changed'), board('Todo', 'original'))
  ctx.schedulesSave()
  const first = ctx.flushBoardSave()            // starts the save, blocks on fetch
  await new Promise(r => setTimeout(r, 0))
  let done = false
  const second = ctx.flushBoardSave().then(() => { done = true })
  await new Promise(r => setTimeout(r, 80))
  expect(done).toBe(false)                     // still waiting for the in-flight save
  release()
  await Promise.all([first, second])
  expect(done).toBe(true)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('BC-5 flushBoardSave — nothing pending → resolves without a request', async () => {
  const ctx = makeCtx('/today')
  ctx.setBoardContext('jobs')
  await ctx.flushBoardSave()
  expect(ctx.__fetchMock).not.toHaveBeenCalled()
})

test('BC-6 render() is a no-op outside board pages', () => {
  const src = fs.readFileSync(path.join(FRONTEND, 'render.js'), 'utf8')
  const body = src.slice(src.indexOf('function render() {'))
  expect(body.split('\n')[1]).toMatch(/if \(ROUTE !== 'board'\) return;/)
})
