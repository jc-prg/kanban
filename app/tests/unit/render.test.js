'use strict'
/**
 * Render helper unit tests — section 2.2 (R-1 … R-6)
 *
 * Environment: jsdom (see vitest.config.js environmentMatchGlobs).
 * render.js is executed via indirect eval so its top-level function
 * declarations become globals on the jsdom window.
 */

const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')

// Stub globals that render.js or its callee helpers might reference before we
// load it. The full render() function uses DOM heavily, but the pure helpers
// at the top of the file do not.
beforeAll(() => {
  // render() touches document.getElementById('board') — mock it so that
  // accidentally calling render() doesn't crash.
  if (typeof globalThis.document !== 'undefined') {
    const stub = { innerHTML: '', appendChild: () => {}, querySelectorAll: () => [] }
    vi.spyOn(document, 'getElementById').mockReturnValue(stub)
    vi.spyOn(document, 'createElement').mockReturnValue({
      className: '', dataset: {}, style: {},
      addEventListener: () => {}, appendChild: () => {}, querySelectorAll: () => [],
      setAttribute: () => {},
    })
  }

  // Icons are used by render() but not by the pure helpers — supply a minimal stub.
  globalThis.ICONS      = {}
  globalThis.state      = { columns: [] }
  globalThis.notesState = { pages: [] }
  globalThis.COL_COLORS = ['#7c6af7']
  globalThis.CARDS_PER_PAGE = 30
  globalThis.colVisible      = {}
  globalThis.colCollapsed    = new Set()
  globalThis.colColorFilter  = {}

  // Load render.js — pure functions (escHtml, safeLink, fmtDate,
  // getLinkBadgeHtml) become globals.
  const src = fs.readFileSync(path.join(FRONTEND, 'render.js'), 'utf8')
  ;(0, eval)(src)   // indirect eval → global scope
})

// ---------------------------------------------------------------------------
// escHtml
// ---------------------------------------------------------------------------
describe('escHtml', () => {
  it('R-1: escapes < > & "', () => {
    expect(globalThis.escHtml('<script>alert("x")&</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&lt;/script&gt;'
    )
  })

  it('converts non-string to string first', () => {
    expect(globalThis.escHtml(42)).toBe('42')
  })
})

// ---------------------------------------------------------------------------
// safeLink
// ---------------------------------------------------------------------------
describe('safeLink', () => {
  it('R-2: javascript: scheme → empty string', () => {
    expect(globalThis.safeLink('javascript:alert(1)')).toBe('')
  })

  it('R-3: https URL → returned unchanged', () => {
    expect(globalThis.safeLink('https://example.com')).toBe('https://example.com')
  })

  it('R-4: http URL → returned unchanged', () => {
    expect(globalThis.safeLink('http://example.com/path?q=1')).toBe('http://example.com/path?q=1')
  })

  it('data: scheme → empty string', () => {
    expect(globalThis.safeLink('data:text/html,<h1>hi</h1>')).toBe('')
  })

  it('malformed URL → empty string', () => {
    expect(globalThis.safeLink('not a url')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// fmtDate
// ---------------------------------------------------------------------------
describe('fmtDate', () => {
  it('R-5: ISO date string → readable format', () => {
    const result = globalThis.fmtDate('2024-01-05')
    expect(result).toContain('Jan')
    expect(result).toContain('5')
  })

  it('empty string → empty string', () => {
    expect(globalThis.fmtDate('')).toBe('')
  })

  it('null/undefined → empty string', () => {
    expect(globalThis.fmtDate(null)).toBe('')
    expect(globalThis.fmtDate(undefined)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// getLinkBadgeHtml
// ---------------------------------------------------------------------------
describe('getLinkBadgeHtml', () => {
  it('R-6: LinkedIn URL → badge with LinkedIn blue background', () => {
    const html = globalThis.getLinkBadgeHtml(
      'https://www.linkedin.com/in/someone',
      'https://www.linkedin.com/in/someone'
    )
    expect(html).toContain('#0077b5')
    expect(html).toContain('linkedin.com')
  })

  it('Xing URL → badge with Xing green', () => {
    const html = globalThis.getLinkBadgeHtml('https://www.xing.com/profile/x', 'https://www.xing.com/profile/x')
    expect(html).toContain('#026466')
  })

  it('unknown URL → fallback badge', () => {
    const html = globalThis.getLinkBadgeHtml('https://example.com', 'https://example.com')
    expect(html).toContain('card-link-badge')
  })
})
