'use strict'
/**
 * Search logic unit tests — section 2.3 (SR-1 … SR-7)
 *
 * The pure functions inside search.js live in an IIFE and are not exported.
 * We test the same algorithms inline — keeping the implementation side-by-side
 * with the production code so any divergence is immediately visible.
 *
 * Environment: jsdom (needed for DOMContentLoaded guard in search.js).
 */

// ---- Pure helpers extracted from search.js --------------------------------

/** Diacritic-insensitive lowercase normalization. */
function normalize(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * Collect matching note pages (DFS). Returns { page, path } entries where
 * path is the ancestor chain including the page itself.
 */
function collectPages(pages, words, acc = [], breadcrumb = []) {
  for (const page of pages) {
    const path = [...breadcrumb, page]
    const hay  = normalize(page.title + ' ' + (page.description || ''))
    if (words.length === 0 || words.every(w => hay.includes(w)))
      acc.push({ page, path })
    if (page.children?.length) collectPages(page.children, words, acc, path)
  }
  return acc
}

/**
 * Filter cards from columns using the same logic as runSearch() in search.js.
 *
 * @param {object[]} columns     Board columns (each with .id and .cards).
 * @param {string}   query       Raw search text (will be normalized + split).
 * @param {Set}      selColumns  Column id whitelist; empty Set = no filter.
 * @param {Set}      selPriorities Priority whitelist; empty Set = no filter.
 * @param {string}   dateStart   ISO date lower bound for startDate filter.
 * @param {string}   dateEnd     ISO date upper bound for endDate filter.
 * @returns {{ card, col }[]}
 */
function filterCards(columns, query, selColumns = new Set(), selPriorities = new Set(), dateStart = '', dateEnd = '') {
  const words = query ? normalize(query).split(/\s+/).filter(Boolean) : []
  const results = []
  for (const col of columns) {
    if (selColumns.size > 0 && !selColumns.has(col.id)) continue
    for (const card of col.cards) {
      if (words.length > 0) {
        const hay = normalize(card.text + ' ' + (card.description || ''))
        if (!words.every(w => hay.includes(w))) continue
      }
      if (selPriorities.size > 0 && !selPriorities.has(card.priority || 0)) continue
      if (dateStart && (!card.startDate || card.startDate < dateStart)) continue
      if (dateEnd   && (!card.endDate   || card.endDate   > dateEnd))   continue
      results.push({ card, col })
    }
  }
  return results
}

// ---- Test data -------------------------------------------------------------

const COLUMNS = [
  {
    id: 'c1', title: 'Inbox',
    cards: [
      { id: 'k1', text: 'Cafe au lait', priority: 1, startDate: '2024-01-10', endDate: '2024-02-01' },
      { id: 'k2', text: 'foo in bar',   priority: 2, startDate: '2024-03-01', endDate: '2024-04-01' },
      { id: 'k3', text: 'foo',          priority: 3, startDate: '2024-05-01', endDate: '2024-06-01' },
    ],
  },
  {
    id: 'c2', title: 'Done',
    cards: [
      { id: 'k4', text: 'done task', priority: 1 },
    ],
  },
]

// ---------------------------------------------------------------------------
// SR-1: Diacritic-insensitive search
// ---------------------------------------------------------------------------
describe('normalize()', () => {
  it('SR-1a: strips combining accents so "café" matches "cafe"', () => {
    expect(normalize('café')).toBe('cafe')
  })

  it('SR-1b: "résumé" normalizes to "resume"', () => {
    expect(normalize('résumé')).toBe('resume')
  })

  it('lowercases ASCII', () => {
    expect(normalize('HELLO')).toBe('hello')
  })
})

describe('filterCards() — diacritic-insensitive search (SR-1)', () => {
  it('SR-1: searching "cafe" finds card with text "Cafe au lait"', () => {
    const results = filterCards(COLUMNS, 'cafe')
    expect(results.some(r => r.card.id === 'k1')).toBe(true)
  })

  it('SR-1: searching "café" also finds "Cafe au lait"', () => {
    const results = filterCards(COLUMNS, 'café')
    expect(results.some(r => r.card.id === 'k1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SR-2: All-words filter
// ---------------------------------------------------------------------------
describe('filterCards() — all-words filter (SR-2)', () => {
  it('SR-2a: "foo bar" matches "foo in bar"', () => {
    const results = filterCards(COLUMNS, 'foo bar')
    expect(results.some(r => r.card.id === 'k2')).toBe(true)
  })

  it('SR-2b: "foo bar" does NOT match card with only "foo"', () => {
    const results = filterCards(COLUMNS, 'foo bar')
    expect(results.some(r => r.card.id === 'k3')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SR-3: Priority filter
// ---------------------------------------------------------------------------
describe('filterCards() — priority filter (SR-3)', () => {
  it('SR-3: priority filter = {1} returns only priority-1 cards', () => {
    const results = filterCards(COLUMNS, '', new Set(), new Set([1]))
    expect(results.every(r => r.card.priority === 1)).toBe(true)
    expect(results.some(r => r.card.id === 'k1')).toBe(true)
    expect(results.some(r => r.card.id === 'k4')).toBe(true)
    expect(results.some(r => r.card.id === 'k2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SR-4: Column filter
// ---------------------------------------------------------------------------
describe('filterCards() — column filter (SR-4)', () => {
  it('SR-4: unchecking "Done" column excludes its cards', () => {
    const results = filterCards(COLUMNS, '', new Set(['c1']))  // only c1
    expect(results.every(r => r.col.id === 'c1')).toBe(true)
    expect(results.some(r => r.card.id === 'k4')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SR-5: Date range filter
// ---------------------------------------------------------------------------
describe('filterCards() — date range filter (SR-5)', () => {
  it('SR-5: card whose endDate falls after range is excluded', () => {
    // dateEnd = '2024-01-31' — k1 has endDate 2024-02-01 which is > 2024-01-31, so excluded
    const results = filterCards(COLUMNS, '', new Set(), new Set(), '', '2024-01-31')
    expect(results.some(r => r.card.id === 'k1')).toBe(false)
  })

  it('cards with endDate within range are included', () => {
    const results = filterCards(COLUMNS, '', new Set(), new Set(), '', '2024-06-30')
    // k1 endDate 2024-02-01, k2 endDate 2024-04-01, k3 endDate 2024-06-01 — all within range
    expect(results.some(r => r.card.id === 'k1')).toBe(true)
    expect(results.some(r => r.card.id === 'k2')).toBe(true)
    expect(results.some(r => r.card.id === 'k3')).toBe(true)
  })

  it('cards without endDate are excluded when dateEnd filter is set', () => {
    const results = filterCards(COLUMNS, '', new Set(), new Set(), '', '2024-12-31')
    expect(results.some(r => r.card.id === 'k4')).toBe(false)  // k4 has no endDate
  })
})

// ---------------------------------------------------------------------------
// SR-6: Page search breadcrumb path
// ---------------------------------------------------------------------------
describe('collectPages() — page search with breadcrumb (SR-6)', () => {
  const PAGES = [
    {
      id: 'n-1', title: 'Root Page', description: 'root content',
      children: [
        {
          id: 'n-2', title: 'Child Page', description: 'child content',
          children: [],
        },
      ],
    },
    { id: 'n-3', title: 'Another Root', description: '', children: [] },
  ]

  it('SR-6: search "child" returns result with breadcrumb [Root Page, Child Page]', () => {
    const results = collectPages(PAGES, ['child'])
    expect(results).toHaveLength(1)
    expect(results[0].page.id).toBe('n-2')
    expect(results[0].path.map(p => p.title)).toEqual(['Root Page', 'Child Page'])
  })

  it('empty query returns all pages (including nested)', () => {
    const results = collectPages(PAGES, [])
    expect(results).toHaveLength(3)
  })

  it('search for root title returns top-level page with single-element path', () => {
    const results = collectPages(PAGES, ['another'])
    expect(results).toHaveLength(1)
    expect(results[0].path).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// SR-7: Empty query returns all cards
// ---------------------------------------------------------------------------
describe('filterCards() — empty query (SR-7)', () => {
  it('SR-7: empty query with no filters returns all cards', () => {
    const results = filterCards(COLUMNS, '')
    expect(results).toHaveLength(4)  // k1, k2, k3, k4
  })

  it('whitespace-only query also returns all cards', () => {
    const results = filterCards(COLUMNS, '   ')
    expect(results).toHaveLength(4)
  })
})
