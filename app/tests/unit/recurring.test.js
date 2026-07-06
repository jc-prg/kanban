'use strict'
/**
 * Unit tests for backend/recurring.js — RC-1 … RC-17
 * Pure date computation functions only; no DB calls.
 */

const path = require('path')

// Minimal db mock so recurring.js can be required without CouchDB
const DB_MODULE = path.resolve(__dirname, '../../backend/db.js')
require.cache[DB_MODULE] = {
  id: DB_MODULE, filename: DB_MODULE, loaded: true,
  exports: { getCouch: () => null, loadBoardData: async () => ({ columns: [] }), saveBoardData: async () => {}, upsertDoc: async () => {}, withHandler: f => f, validBoardName: () => true, getBoardDb: async () => ({}), withBoard: () => () => {}, withExistingBoard: () => () => {}, DB_PREFIX: 'jc-kanban-' },
  children: [], paths: [],
}

const { addDays, computeNextDueDate, getDueDates } = require('../../backend/recurring')

// ---------------------------------------------------------------------------
// Helpers to build task objects
// ---------------------------------------------------------------------------

function dailyTask(interval, startDate, endDate) {
  return { card: { text: 'x' }, targetColumn: 'Todo', startDate: startDate || '2026-01-01', endDate: endDate || null, lastCreatedDate: null, recurrence: { type: 'daily', interval } }
}
function weeklyTask(interval, daysOfWeek, startDate) {
  return { card: { text: 'x' }, targetColumn: 'Todo', startDate: startDate || '2026-01-05', endDate: null, lastCreatedDate: null, recurrence: { type: 'weekly', interval, daysOfWeek } }
}
function monthlyTask(interval, dayOfMonth, startDate) {
  return { card: { text: 'x' }, targetColumn: 'Todo', startDate: startDate || '2026-01-01', endDate: null, lastCreatedDate: null, recurrence: { type: 'monthly', interval, dayOfMonth } }
}
function yearlyTask(interval, month, dayOfMonth, startDate) {
  return { card: { text: 'x' }, targetColumn: 'Todo', startDate: startDate || '2026-04-15', endDate: null, lastCreatedDate: null, recurrence: { type: 'yearly', interval, month, dayOfMonth } }
}

// ---------------------------------------------------------------------------
// computeNextDueDate — daily
// ---------------------------------------------------------------------------

describe('RC-1: daily interval=1, after Mon', () => {
  it('returns Tue', () => {
    const task = dailyTask(1, '2026-07-06')
    expect(computeNextDueDate(task, '2026-07-06')).toBe('2026-07-07')
  })
})

describe('RC-2: daily interval=3, after Mon', () => {
  it('returns Thu', () => {
    // startDate = Mon 2026-07-06, after = 2026-07-06 → next = Jul 9 (Thu)
    const task = dailyTask(3, '2026-07-06')
    expect(computeNextDueDate(task, '2026-07-06')).toBe('2026-07-09')
  })
})

// ---------------------------------------------------------------------------
// computeNextDueDate — weekly
// ---------------------------------------------------------------------------

describe('RC-3: weekly Mon interval=1, after Mon', () => {
  it('returns next Mon (+7 days)', () => {
    const task = weeklyTask(1, [1], '2026-07-06') // startDate is a Monday
    expect(computeNextDueDate(task, '2026-07-06')).toBe('2026-07-13')
  })
})

describe('RC-4: weekly Mon+Wed interval=1, after Mon', () => {
  it('returns Wed same week', () => {
    const task = weeklyTask(1, [1, 3], '2026-07-06')
    expect(computeNextDueDate(task, '2026-07-06')).toBe('2026-07-08')
  })
})

describe('RC-5: weekly Mon interval=2, after Mon', () => {
  it('returns Mon +14 days', () => {
    const task = weeklyTask(2, [1], '2026-07-06')
    expect(computeNextDueDate(task, '2026-07-06')).toBe('2026-07-20')
  })
})

// ---------------------------------------------------------------------------
// computeNextDueDate — monthly
// ---------------------------------------------------------------------------

describe('RC-6: monthly day=15 interval=1, after Jul 15', () => {
  it('returns Aug 15', () => {
    const task = monthlyTask(1, 15, '2026-01-15')
    expect(computeNextDueDate(task, '2026-07-15')).toBe('2026-08-15')
  })
})

describe('RC-7: monthly interval=3 day=1, after Jan 1', () => {
  it('returns Apr 1', () => {
    const task = monthlyTask(3, 1, '2026-01-01')
    expect(computeNextDueDate(task, '2026-01-01')).toBe('2026-04-01')
  })
})

// ---------------------------------------------------------------------------
// computeNextDueDate — yearly
// ---------------------------------------------------------------------------

describe('RC-8: yearly Apr 15, after Apr 15 2026', () => {
  it('returns Apr 15 2027', () => {
    const task = yearlyTask(1, 4, 15, '2026-04-15')
    expect(computeNextDueDate(task, '2026-04-15')).toBe('2027-04-15')
  })
})

describe('RC-9: yearly interval=2 Apr 15, after Apr 15 2026', () => {
  it('returns Apr 15 2028', () => {
    const task = yearlyTask(2, 4, 15, '2026-04-15')
    expect(computeNextDueDate(task, '2026-04-15')).toBe('2028-04-15')
  })
})

// ---------------------------------------------------------------------------
// computeNextDueDate — endDate
// ---------------------------------------------------------------------------

describe('RC-10: daily result exceeds endDate', () => {
  it('returns null', () => {
    const task = { ...dailyTask(1, '2026-07-01'), endDate: '2026-07-06' }
    expect(computeNextDueDate(task, '2026-07-06')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// computeNextDueDate — never run (startDate)
// ---------------------------------------------------------------------------

describe('RC-11: never run, startDate=future', () => {
  it('returns startDate', () => {
    const task = dailyTask(1, '2026-12-01')
    // afterDate well before startDate
    expect(computeNextDueDate(task, '2026-01-01')).toBe('2026-12-01')
  })
})

describe('RC-12: never run, startDate=past', () => {
  it('returns first occurrence >= startDate', () => {
    const task = dailyTask(1, '2026-06-01')
    // after = startDate - 1
    expect(computeNextDueDate(task, addDays('2026-06-01', -1))).toBe('2026-06-01')
  })
})

// ---------------------------------------------------------------------------
// getDueDates
// ---------------------------------------------------------------------------

describe('RC-13: getDueDates daily interval=1, Mon to Fri', () => {
  it('returns Mon Tue Wed Thu', () => {
    const task = dailyTask(1, '2026-07-06') // Mon
    const dates = getDueDates(task, '2026-07-06', '2026-07-10')
    expect(dates).toEqual(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09'])
  })
})

describe('RC-14: getDueDates weekly Mon, two weeks', () => {
  it('returns two Mondays', () => {
    const task = weeklyTask(1, [1], '2026-07-06')
    const dates = getDueDates(task, '2026-07-07', addDays('2026-07-20', 1))
    expect(dates).toEqual(['2026-07-13', '2026-07-20'])
  })
})

describe('RC-15: getDueDates monthly day=31, Feb (clamp)', () => {
  it('returns Feb 28 (non-leap year)', () => {
    const task = monthlyTask(1, 31, '2025-01-31')
    const dates = getDueDates(task, '2025-02-01', '2025-03-01')
    expect(dates).toEqual(['2025-02-28'])
  })
})

describe('RC-15b: getDueDates monthly day=31, Apr (clamp)', () => {
  it('returns Apr 30', () => {
    const task = monthlyTask(1, 31, '2026-01-31')
    const dates = getDueDates(task, '2026-04-01', '2026-05-01')
    expect(dates).toEqual(['2026-04-30'])
  })
})

describe('RC-16: getDueDates with endDate mid-range', () => {
  it('stops at endDate', () => {
    const task = { ...dailyTask(1, '2026-07-01'), endDate: '2026-07-03' }
    const dates = getDueDates(task, '2026-07-01', '2026-07-10')
    expect(dates).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })
})

describe('RC-17: getDueDates disabled task', () => {
  it('still returns dates (caller responsibility)', () => {
    // getDueDates itself does not filter by enabled
    const task = { ...dailyTask(1, '2026-07-06'), enabled: false }
    const dates = getDueDates(task, '2026-07-06', '2026-07-08')
    expect(dates).toEqual(['2026-07-06', '2026-07-07'])
  })
})
