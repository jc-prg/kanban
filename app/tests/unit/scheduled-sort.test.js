'use strict'
/**
 * Scheduled column sorting — SC-11, SC-12
 * _schedSortKey / sortScheduledCards are extracted from scheduled.js source
 * and evaluated in an isolated vm context (the file itself needs a full DOM).
 */

const vm   = require('vm')
const fs   = require('fs')
const path = require('path')

let ctx

beforeAll(() => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../frontend/scheduled.js'), 'utf8')
  const start = src.indexOf('function _schedSortKey')
  const end   = src.indexOf('window.sortScheduledCards')
  ctx = vm.createContext({ window: {} })
  vm.runInContext(src.slice(start, end), ctx)
})

const ids = cards => cards.map(c => c.id)

describe('SC-11: sort order', () => {
  it('sorts one-time cards by scheduledFor, earliest first, undated last, stable', () => {
    const { oneTime } = ctx.sortScheduledCards([
      { id: 'a', scheduledFor: '2026-12-01' },
      { id: 'b' },
      { id: 'c', scheduledFor: '2026-11-01' },
      { id: 'd', scheduledFor: '2026-11-01' },
    ])
    expect(ids(oneTime)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('sorts recurring cards by nextDueDate, falling back to scheduledFor', () => {
    const r = { type: 'daily', interval: 1 }
    const { recurring } = ctx.sortScheduledCards([
      { id: 'a', recurrence: r, scheduledFor: '2026-10-01', nextDueDate: '2026-12-01' },
      { id: 'b', recurrence: r, scheduledFor: '2026-11-15' },
      { id: 'c', recurrence: r, scheduledFor: '2026-10-01', nextDueDate: '2026-11-01' },
    ])
    expect(ids(recurring)).toEqual(['c', 'b', 'a'])
  })
})

describe('SC-12: grouping', () => {
  it('separates one-time and recurring cards', () => {
    const { oneTime, recurring } = ctx.sortScheduledCards([
      { id: 'a', recurrence: { type: 'weekly', interval: 1 }, scheduledFor: '2026-10-20' },
      { id: 'b', scheduledFor: '2026-10-25' },
    ])
    expect(ids(oneTime)).toEqual(['b'])
    expect(ids(recurring)).toEqual(['a'])
  })
})
