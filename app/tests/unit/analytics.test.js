'use strict'
/**
 * Analytics computation unit tests — section 2.5 (AN-1 … AN-12)
 *
 * analytics.js is an IIFE, so its internals are not accessible by default.
 * We inject an export shim at the end of the IIFE to expose:
 *   - window.__ANALYSES  — the raw ANALYSES array with .run() methods
 *   - window.__setSelColumns(ids) — reset the module-level selColumns Set
 *
 * Tests call analysis.run() directly with crafted card arrays and check the
 * returned data structures. No rendering is exercised.
 */

const vm   = require('vm')
const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')

let ctx

beforeAll(() => {
  ctx = vm.createContext({
    window:   {},
    document: { addEventListener: () => {} },
    state:    { columns: [] },
    escHtml:  (s) => String(s),
    fetch:    async () => ({ ok: false, json: async () => ({}) }),
    API:      null,
    console,
  })

  // Inject export shims just before the closing })(); of the IIFE
  const raw = fs.readFileSync(path.join(FRONTEND, 'analytics.js'), 'utf8')
  const src = raw.replace(
    /\}\)\(\);\s*$/,
    `; window.__ANALYSES = ANALYSES;
     window.__setSelColumns = function(ids) {
       selColumns.clear();
       if (ids) ids.forEach(function(id) { selColumns.add(id); });
     };
    })();`
  )
  vm.runInContext(src, ctx)
})

beforeEach(() => {
  ctx.state = { columns: [] }
  ctx.window.__setSelColumns(null)  // reset to "all columns"
})

function runAnalysis(id, cards, params) {
  const analysis = ctx.window.__ANALYSES.find(a => a.id === id)
  return analysis.run(cards, params)
}

// ---------------------------------------------------------------------------
// done-per-month (AN-1 … AN-5)
// ---------------------------------------------------------------------------
describe('done-per-month', () => {
  beforeEach(() => {
    // Provide a "Done" column so doneColTitles is populated
    ctx.state = { columns: [{ id: 'd1', title: 'Done', cards: [] }] }
  })

  it('AN-1: card with doneAt → counted in correct month and week bucket', () => {
    const cards = [{ id: 'c1', text: 'T', doneAt: '2024-03-15T10:00:00Z' }]
    const { months, weeks } = runAnalysis('done-per-month', cards)

    expect(months).toContainEqual(expect.objectContaining({ label: '2024-03', count: 1 }))
    // Monday of the week containing 2024-03-15 (Friday) is 2024-03-11
    expect(weeks.some(w => w.mon === '2024-03-11')).toBe(true)
  })

  it('AN-2: card moved to done* column, no doneAt → counted using move date', () => {
    const cards = [{
      id: 'c1', text: 'T',
      moves: [{ at: '2024-04-10T09:00:00Z', from: 'Inbox', to: 'Done' }],
    }]
    const { months } = runAnalysis('done-per-month', cards)

    expect(months).toContainEqual(expect.objectContaining({ label: '2024-04', count: 1 }))
  })

  it('AN-3: card with both doneAt and done move → counted exactly once (doneAt takes priority)', () => {
    const cards = [{
      id: 'c1', text: 'T',
      doneAt: '2024-05-01T00:00:00Z',
      moves: [{ at: '2024-04-28T00:00:00Z', from: 'Inbox', to: 'Done' }],
    }]
    const { months } = runAnalysis('done-per-month', cards)

    const total = months.reduce((s, m) => s + m.count, 0)
    expect(total).toBe(1)
    // doneAt wins, so counted in May not April
    expect(months).toContainEqual(expect.objectContaining({ label: '2024-05', count: 1 }))
    expect(months.find(m => m.label === '2024-04')).toBeUndefined()
  })

  it('AN-4: card with no doneAt and no move to done* column → not counted', () => {
    const cards = [{
      id: 'c1', text: 'T',
      moves: [{ at: '2024-06-01T00:00:00Z', from: 'Inbox', to: 'Review' }],
    }]
    const { months } = runAnalysis('done-per-month', cards)

    expect(months).toHaveLength(0)
  })

  it('AN-5: moves to non-done columns are ignored', () => {
    const cards = [{
      id: 'c1', text: 'T',
      moves: [
        { at: '2024-07-01T00:00:00Z', from: 'Inbox',  to: 'Review'      },
        { at: '2024-07-05T00:00:00Z', from: 'Review', to: 'In Progress' },
      ],
    }]
    const { months } = runAnalysis('done-per-month', cards)

    expect(months).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// moved-to-column (AN-6 … AN-8)
// ---------------------------------------------------------------------------
describe('moved-to-column', () => {
  it('AN-6: card moved multiple times → each destination gets its own count', () => {
    ctx.state = {
      columns: [
        { id: 'a', title: 'Inbox',  cards: [{ id: 'c1', text: 'T', moves: [
          { at: '2024-01-10T00:00:00Z', from: 'Inbox',  to: 'Review' },
          { at: '2024-01-15T00:00:00Z', from: 'Review', to: 'Done'   },
        ]}] },
        { id: 'b', title: 'Review', cards: [] },
        { id: 'c', title: 'Done',   cards: [] },
      ],
    }
    const { months } = runAnalysis('moved-to-column')

    const jan = months.find(m => m.label === '2024-01')
    expect(jan).toBeDefined()
    expect(jan.counts['Review']).toBe(1)
    expect(jan.counts['Done']).toBe(1)
  })

  it('AN-7: selColumns restricts destination columns shown in result', () => {
    ctx.state = {
      columns: [
        { id: 'col-inbox',  title: 'Inbox',  cards: [{ id: 'c1', text: 'T', moves: [
          { at: '2024-02-01T00:00:00Z', from: 'Inbox',  to: 'Review' },
          { at: '2024-02-02T00:00:00Z', from: 'Review', to: 'Done'   },
        ]}] },
        { id: 'col-review', title: 'Review', cards: [] },
        { id: 'col-done',   title: 'Done',   cards: [] },
      ],
    }
    ctx.window.__setSelColumns(['col-done'])

    const { columns } = runAnalysis('moved-to-column')

    expect(columns).toContain('Done')
    expect(columns).not.toContain('Review')
  })

  it('AN-8: columns in result follow board column order, not move insertion order', () => {
    ctx.state = {
      columns: [
        { id: 'a', title: 'Alpha', cards: [] },
        { id: 'b', title: 'Beta',  cards: [{ id: 'c1', text: 'T', moves: [
          { at: '2024-03-01T00:00:00Z', from: 'Gamma', to: 'Beta'  },
          { at: '2024-03-02T00:00:00Z', from: 'Beta',  to: 'Alpha' },
        ]}] },
        { id: 'c', title: 'Gamma', cards: [] },
      ],
    }
    const { columns } = runAnalysis('moved-to-column')

    // Alpha comes before Beta in board order → Alpha index < Beta index
    const alphaIdx = columns.indexOf('Alpha')
    const betaIdx  = columns.indexOf('Beta')
    expect(alphaIdx).toBeGreaterThanOrEqual(0)
    expect(betaIdx).toBeGreaterThanOrEqual(0)
    expect(alphaIdx).toBeLessThan(betaIdx)
  })
})

// ---------------------------------------------------------------------------
// word-freq (AN-9)
// ---------------------------------------------------------------------------
describe('word-freq', () => {
  it('AN-9: words shorter than minLength are excluded from results', () => {
    const cards = [
      { text: 'the cat sat on the mat' },
      { text: 'engineering project management' },
    ]
    const result = runAnalysis('word-freq', cards, { minLength: 5, topN: 20 })
    const words = result.map(r => r.label)

    expect(words).not.toContain('the')
    expect(words).not.toContain('cat')
    expect(words).not.toContain('sat')
    expect(words).toContain('engineering')
    expect(words).toContain('project')
    expect(words).toContain('management')
  })
})

// ---------------------------------------------------------------------------
// split-position (AN-10)
// ---------------------------------------------------------------------------
describe('split-position', () => {
  it('AN-10: card text split by | at position 1 → correct field extracted and counted', () => {
    const cards = [
      { text: 'Engineer | ACME | Berlin' },
      { text: 'Manager | ACME | Munich' },
      { text: 'Engineer | OtherCo | Berlin' },
    ]
    const result = runAnalysis('split-position', cards, { delimiter: '|', position: 1, topN: 10 })
    const labels = result.map(r => r.label)

    expect(labels).toContain('ACME')
    expect(labels).toContain('OtherCo')
    expect(result.find(r => r.label === 'ACME').count).toBe(2)
    expect(result.find(r => r.label === 'OtherCo').count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// date-duration (AN-11 … AN-12)
// ---------------------------------------------------------------------------
describe('date-duration', () => {
  it('AN-11: card with startDate and endDate → duration in days in both[] bucket', () => {
    const cards = [{ text: 'T', startDate: '2024-01-01', endDate: '2024-01-11' }]
    const { both, startOnly, endOnly } = runAnalysis('date-duration', cards)

    expect(both).toHaveLength(1)
    expect(both[0]).toBe(10)
    expect(startOnly).toHaveLength(0)
    expect(endOnly).toHaveLength(0)
  })

  it('AN-12: card with only startDate (no endDate) → appears in startOnly[] bucket', () => {
    const cards = [{ text: 'T', startDate: '2024-01-01' }]
    const { both, startOnly } = runAnalysis('date-duration', cards)

    expect(both).toHaveLength(0)
    expect(startOnly).toHaveLength(1)
    expect(startOnly[0]).toBeGreaterThanOrEqual(0)
  })
})
