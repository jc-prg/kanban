'use strict'
/**
 * Print view unit tests — section 2.6 (PR-1 … PR-12)
 *
 * cards.js is loaded via vm.runInContext with minimal browser-global stubs.
 * Only the print helper functions are exercised; no DOM rendering occurs.
 *
 * Functions under test:
 *   _fmtPrintDate(d)             — date → 'DD.MM.YYYY HH:MM'
 *   _buildPrintItem(opts)        — builds the print-item HTML string
 *   _cardPrintFooter(card)       — builds footer rows array for a card
 *   _waitForImages(container)    — promise that resolves when all imgs load
 */

const vm   = require('vm')
const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')

let ctx

beforeAll(() => {
  const noop   = () => {}
  const noopEl = {
    addEventListener:    noop,
    removeEventListener: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style:    {},
    dataset:  {},
    value:    '',
    textContent: '',
    checked:  false,
    focus:    noop,
    querySelectorAll: () => ({ forEach: noop, length: 0 }),
    querySelector:    () => null,
  }

  ctx = vm.createContext({
    // Vendor stubs — called at module load time by marked.use()
    marked:    { use: noop, parse: (t) => `<p>${t}</p>` },
    DOMPurify: { sanitize: (h) => h },

    // Browser globals
    window:   { open: noop },
    document: {
      addEventListener:  noop,
      getElementById:    () => noopEl,
      querySelector:     () => null,
      querySelectorAll:  () => [],
      createElement:     () => ({ ...noopEl, innerHTML: '', appendChild: noop }),
    },
    location: { href: 'http://localhost:3000/board' },
    URL:      { createObjectURL: () => 'blob:mock' },
    fetch:    async () => ({ ok: false }),
    requestAnimationFrame: noop,

    // App globals required at load time
    API_BASE:        null,
    BOARD_NAME:      'test',
    state:           { columns: [], settings: {} },
    escHtml:         (s) => String(s),
    PRIORITY_LABELS: ['—', 'P1', 'P2', 'P3', 'P4', 'P5'],
    COLORS:          ['#7c6af7'],
    ICONS:           {},
    SVGICONS:        { description: noop, link: noop, attachment: noop, linkedCards: noop },
    schedulesSave:   noop,
    render:          noop,

    // Timer stubs
    setTimeout:   () => 0,
    clearTimeout: noop,
    setInterval:  () => 0,
    clearInterval: noop,

    // Standard built-ins forwarded explicitly for clarity
    Promise,
    console,
  })

  // Load cards.js and append shims that expose the private print functions.
  const src = fs.readFileSync(path.join(FRONTEND, 'cards.js'), 'utf8') + `
;var __fmtPrintDate    = function(d)    { return _fmtPrintDate(d); };
;var __buildPrintItem  = function(opts) { return _buildPrintItem(opts); };
;var __cardPrintFooter = function(card) { return _cardPrintFooter(card); };
;var __waitForImages   = function(c)    { return _waitForImages(c); };
`
  vm.runInContext(src, ctx)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an HTML string into a DOM node (uses the jsdom env's document). */
function parse(html) {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

/** Build a minimal fake img-container for _waitForImages tests. */
function fakeContainer(imgs) {
  return { querySelectorAll: () => imgs }
}

// ---------------------------------------------------------------------------
// PR-1  _fmtPrintDate
// ---------------------------------------------------------------------------
describe('_fmtPrintDate()', () => {
  it('PR-1a: formats a date as DD.MM.YYYY HH:MM with zero-padding', () => {
    const d = new Date(2024, 0, 5, 9, 3) // 2024-01-05 09:03 local time
    expect(ctx.__fmtPrintDate(d)).toBe('05.01.2024 09:03')
  })

  it('PR-1b: pads double-digit values correctly', () => {
    const d = new Date(2024, 11, 31, 23, 59) // 2024-12-31 23:59
    expect(ctx.__fmtPrintDate(d)).toBe('31.12.2024 23:59')
  })

  it('PR-1c: midnight is formatted as 00:00', () => {
    const d = new Date(2025, 5, 1, 0, 0) // 2025-06-01 00:00
    expect(ctx.__fmtPrintDate(d)).toBe('01.06.2025 00:00')
  })
})

// ---------------------------------------------------------------------------
// PR-2  _buildPrintItem
// ---------------------------------------------------------------------------
describe('_buildPrintItem()', () => {
  it('PR-2a: renders board name in header', () => {
    const html = ctx.__buildPrintItem({ board: 'my-board', context: '', title: 'T', body: '', footerRows: [] })
    const el = parse(html)
    expect(el.querySelector('.print-board').textContent).toBe('my-board')
  })

  it('PR-2b: renders context span when provided', () => {
    const html = ctx.__buildPrintItem({ board: 'b', context: 'Col: Work', title: 'T', body: '', footerRows: [] })
    const el = parse(html)
    expect(el.querySelector('.print-context').textContent).toBe('Col: Work')
  })

  it('PR-2c: omits context span when context is empty', () => {
    const html = ctx.__buildPrintItem({ board: 'b', context: '', title: 'T', body: '', footerRows: [] })
    const el = parse(html)
    expect(el.querySelector('.print-context')).toBeNull()
  })

  it('PR-2d: renders title in h1.print-title', () => {
    const html = ctx.__buildPrintItem({ board: 'b', context: '', title: 'My Card', body: '', footerRows: [] })
    const el = parse(html)
    expect(el.querySelector('.print-title').textContent).toBe('My Card')
  })

  it('PR-2e: renders body when provided', () => {
    const html = ctx.__buildPrintItem({ board: 'b', context: '', title: 'T', body: '<p>text</p>', footerRows: [] })
    const el = parse(html)
    expect(el.querySelector('.print-body').innerHTML).toBe('<p>text</p>')
  })

  it('PR-2f: omits body div when body is empty', () => {
    const html = ctx.__buildPrintItem({ board: 'b', context: '', title: 'T', body: '', footerRows: [] })
    const el = parse(html)
    expect(el.querySelector('.print-body')).toBeNull()
  })

  it('PR-2g: renders footer rows with label and value', () => {
    const html = ctx.__buildPrintItem({
      board: 'b', context: '', title: 'T', body: '',
      footerRows: [['ID', 'id-abc'], ['URL', 'http://x']],
    })
    const el = parse(html)
    const rows = el.querySelectorAll('.print-footer-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.print-footer-label').textContent).toBe('ID')
    expect(rows[0].querySelector('.print-footer-value').textContent).toBe('id-abc')
  })

  it('PR-2h: omits footer div when footerRows is empty', () => {
    const html = ctx.__buildPrintItem({ board: 'b', context: '', title: 'T', body: '', footerRows: [] })
    const el = parse(html)
    expect(el.querySelector('.print-footer')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PR-3  _cardPrintFooter
// ---------------------------------------------------------------------------
describe('_cardPrintFooter()', () => {
  it('PR-3a: minimal card has ID, URL and Status as last three rows', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-abc' })
    const labels = rows.map(([l]) => l)
    expect(labels).toContain('ID')
    expect(labels).toContain('URL')
    expect(labels).toContain('Status')
    expect(labels.at(-1)).toBe('Status')
  })

  it('PR-3b: ID value matches card.id', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-xyz' })
    const id = rows.find(([l]) => l === 'ID')
    expect(id[1]).toBe('id-xyz')
  })

  it('PR-3c: URL contains a #card: fragment with the card id', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-xyz' })
    const url = rows.find(([l]) => l === 'URL')
    expect(url[1]).toContain('#card:id-xyz')
  })

  it('PR-3d: Status value matches DD.MM.YYYY HH:MM format', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-abc' })
    const status = rows.find(([l]) => l === 'Status')
    expect(status[1]).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/)
  })

  it('PR-3e: Priority row present when card.priority is set', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-a', priority: 2 })
    const pri = rows.find(([l]) => l === 'Priority')
    expect(pri).toBeDefined()
    expect(pri[1]).toBe('P2')
  })

  it('PR-3f: Priority row absent when card.priority is falsy', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-a' })
    expect(rows.find(([l]) => l === 'Priority')).toBeUndefined()
  })

  it('PR-3g: Created row present when card.created is set', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-a', created: '2024-03-15' })
    const c = rows.find(([l]) => l === 'Created')
    expect(c[1]).toBe('2024-03-15')
  })

  it('PR-3h: Done row with date when card.done and card.doneAt are set', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-a', done: true, doneAt: '2024-06-01T10:00:00.000Z' })
    const d = rows.find(([l]) => l === 'Done')
    expect(d).toBeDefined()
    expect(d[1]).not.toBe('yes') // should be a date string, not literal 'yes'
  })

  it('PR-3i: Done row shows "yes" when card.done is true but doneAt absent', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-a', done: true })
    const d = rows.find(([l]) => l === 'Done')
    expect(d[1]).toBe('yes')
  })

  it('PR-3j: Dates row with startDate → endDate when both set', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-a', startDate: '2024-01-01', endDate: '2024-03-31' })
    const dt = rows.find(([l]) => l === 'Dates')
    expect(dt[1]).toContain('2024-01-01')
    expect(dt[1]).toContain('2024-03-31')
    expect(dt[1]).toContain('→')
  })

  it('PR-3k: Link row present when card.link is set', () => {
    const rows = ctx.__cardPrintFooter({ id: 'id-a', link: 'https://example.com' })
    const lnk = rows.find(([l]) => l === 'Link')
    expect(lnk[1]).toBe('https://example.com')
  })

  it('PR-3l: Status is always the very last row regardless of other fields', () => {
    const rows = ctx.__cardPrintFooter({
      id: 'id-a', priority: 1, created: '2024-01-01',
      done: true, startDate: '2024-01-01', endDate: '2024-12-31',
      link: 'https://x.com',
    })
    expect(rows.at(-1)[0]).toBe('Status')
  })
})

// ---------------------------------------------------------------------------
// PR-4  _waitForImages
// ---------------------------------------------------------------------------
describe('_waitForImages()', () => {
  it('PR-4a: resolves immediately when container has no images', async () => {
    const container = fakeContainer([])
    await expect(ctx.__waitForImages(container)).resolves.toBeUndefined()
  })

  it('PR-4b: resolves immediately when all images are already complete', async () => {
    const container = fakeContainer([
      { complete: true },
      { complete: true },
    ])
    await expect(ctx.__waitForImages(container)).resolves.toBeUndefined()
  })

  it('PR-4c: resolves after the load event fires on a pending image', async () => {
    const img = { complete: false }
    const container = fakeContainer([img])
    const p = ctx.__waitForImages(container)
    // The Promise constructor callback is synchronous — img.onload is set by now
    img.onload()
    await expect(p).resolves.toBeDefined()
  })

  it('PR-4d: resolves after the error event fires (broken image)', async () => {
    const img = { complete: false }
    const container = fakeContainer([img])
    const p = ctx.__waitForImages(container)
    img.onerror()
    await expect(p).resolves.toBeDefined()
  })

  it('PR-4e: resolves only after all pending images have loaded', async () => {
    const img1 = { complete: false }
    const img2 = { complete: false }
    const container = fakeContainer([img1, img2])
    let settled = false
    const p = ctx.__waitForImages(container).then(() => { settled = true })
    img1.onload()
    // After only one image loads the promise should still be pending
    await Promise.resolve() // flush microtasks
    expect(settled).toBe(false)
    img2.onload()
    await p
    expect(settled).toBe(true)
  })
})
