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
  const start = src.indexOf('function _nextOccurrence')
  const end   = src.indexOf('window.sortScheduledCards')
  ctx = vm.createContext({ window: {}, _today: () => '2026-10-12' })
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

describe('SC-13: next occurrence of a recurring card', () => {
  it('uses the first matching date on/after today, not the "from" date', () => {
    const next = (recurrence, from) => ctx._nextOccurrence(recurrence, from, null, '2026-10-12')
    expect(next({ type: 'monthly', interval: 1, dayOfMonth: 20 }, '2026-01-01')).toBe('2026-10-20')
    expect(next({ type: 'monthly', interval: 2, dayOfMonth: 5 }, '2026-01-01')).toBe('2026-11-05')
    expect(next({ type: 'weekly', interval: 1, daysOfWeek: [3] }, '2026-01-01')).toBe('2026-10-14')
    expect(next({ type: 'yearly', interval: 1, dayOfMonth: 3, month: 2 }, '2026-01-01')).toBe('2027-02-03')
    expect(next({ type: 'monthly', interval: 1, dayOfMonth: 1 }, '2027-03-10')).toBe('2027-04-01')
  })

  it('anchors the interval cycle on the first match on/after "from"', () => {
    const r = { type: 'monthly', interval: 3, dayOfMonth: 5 }
    expect(ctx._nextOccurrence(r, '2026-10-12', null, '2026-10-12')).toBe('2026-11-05')
    expect(ctx._nextOccurrence(r, '2026-10-12', null, '2026-11-06')).toBe('2027-02-05')
  })

  it('computes the sort key when nextDueDate is missing', () => {
    const card = { recurrence: { type: 'monthly', interval: 1, dayOfMonth: 20 }, scheduledFor: '2026-01-01' }
    expect(ctx._schedSortKey(card)).toBe('2026-10-20')
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
