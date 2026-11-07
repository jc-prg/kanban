'use strict'
/**
 * Dashboard unit tests — DU-1 … DU-13
 *
 * Tests the pure password-utility functions exported from routes/dashboard.js
 * without starting the HTTP server or touching CouchDB, plus the pure frontend
 * helper _calSeriesDates (DU-11 … DU-13, extracted from frontend/dashboard.js).
 */

vi.spyOn(console, 'log').mockImplementation(() => {})

const path = require('path')

// Stub global-db and db before requiring the route so no real connections fire
const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')
if (!require.cache[GLOBAL_DB_MODULE]) {
  require.cache[GLOBAL_DB_MODULE] = {
    id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true,
    exports: {
      getDashboardConfig:  async () => ({ mailAccounts: [], cardSources: [], calendarAccounts: [], autoRefreshMs: 0 }),
      saveDashboardConfig: async () => {},
      initGlobalDb:        async () => {},
      getGlobalDb:         () => ({}),
    },
    children: [], paths: [],
  }
}

const { stripPasswords, mergePasswords } = require('../../backend/routes/dashboard')
const { filterEvents } = require('../../backend/dashboard/calendar')

// ---------------------------------------------------------------------------
// stripPasswords
// ---------------------------------------------------------------------------

test('DU-1 stripPasswords — mail password removed; hasPassword:true added', () => {
  const cfg = {
    mailAccounts:     [{ id: 'ma-1', label: 'work', password: 'secret' }],
    calendarAccounts: [],
    cardSources:      [],
    autoRefreshMs:    0,
  }
  const result = stripPasswords(cfg)
  expect(result.mailAccounts[0].password).toBeUndefined()
  expect(result.mailAccounts[0].hasPassword).toBe(true)
  expect(result.mailAccounts[0].label).toBe('work')
})

test('DU-2 stripPasswords — account with no password; hasPassword:false', () => {
  const cfg = {
    mailAccounts:     [{ id: 'ma-1', label: 'work' }],
    calendarAccounts: [{ id: 'ca-1', label: 'cal' }],
    cardSources:      [],
    autoRefreshMs:    0,
  }
  const result = stripPasswords(cfg)
  expect(result.mailAccounts[0].hasPassword).toBe(false)
  expect(result.calendarAccounts[0].hasPassword).toBe(false)
})

// ---------------------------------------------------------------------------
// mergePasswords
// ---------------------------------------------------------------------------

test('DU-3 mergePasswords — incoming account missing password field → keeps stored password', () => {
  const stored   = { mailAccounts: [{ id: 'ma-1', password: 'original' }], calendarAccounts: [], cardSources: [], autoRefreshMs: 0 }
  const incoming = { mailAccounts: [{ id: 'ma-1', label: 'updated' }],     calendarAccounts: [], cardSources: [], autoRefreshMs: 0 }
  const result   = mergePasswords(stored, incoming)
  expect(result.mailAccounts[0].password).toBe('original')
  expect(result.mailAccounts[0].label).toBe('updated')
})

test('DU-4 mergePasswords — incoming account has new non-empty password → new password used', () => {
  const stored   = { mailAccounts: [{ id: 'ma-1', password: 'old' }], calendarAccounts: [], cardSources: [], autoRefreshMs: 0 }
  const incoming = { mailAccounts: [{ id: 'ma-1', password: 'new' }], calendarAccounts: [], cardSources: [], autoRefreshMs: 0 }
  const result   = mergePasswords(stored, incoming)
  expect(result.mailAccounts[0].password).toBe('new')
})

// ---------------------------------------------------------------------------
// filterEvents — DU-5 … DU-10
// ---------------------------------------------------------------------------

// Fixed reference date: 2026-07-01 UTC (avoids flakiness)
const REF = new Date('2026-07-01T00:00:00Z')

function ev(uid, startIso, endIso, allDay = false) {
  return { uid, title: uid, start: startIso, end: endIso, allDay }
}

test('DU-5 filterEvents — event starts tomorrow, lookahead 7 → included', () => {
  const e = ev('e1', '2026-07-02T09:00:00Z', '2026-07-02T10:00:00Z')
  expect(filterEvents([e], 7, REF)).toHaveLength(1)
})

test('DU-6 filterEvents — event starts 8 days from now, lookahead 7 → excluded', () => {
  const e = ev('e2', '2026-07-09T09:00:00Z', '2026-07-09T10:00:00Z')
  expect(filterEvents([e], 7, REF)).toHaveLength(0)
})

test('DU-7 filterEvents — all-day event (DATE) within window → included', () => {
  // All-day on 2026-07-03; DTEND (exclusive) = 2026-07-04
  const e = ev('e3', '2026-07-03', '2026-07-04', true)
  expect(filterEvents([e], 7, REF)).toHaveLength(1)
})

test('DU-8 filterEvents — multi-day event starts before today, ends within window → included', () => {
  const e = ev('e4', '2026-06-30T08:00:00Z', '2026-07-04T18:00:00Z')
  expect(filterEvents([e], 7, REF)).toHaveLength(1)
})

test('DU-9 filterEvents — event started yesterday, ended yesterday → excluded', () => {
  const e = ev('e5', '2026-06-30T09:00:00Z', '2026-06-30T10:00:00Z')
  expect(filterEvents([e], 7, REF)).toHaveLength(0)
})

test('DU-10 filterEvents — empty events array → returns []', () => {
  expect(filterEvents([], 7, REF)).toEqual([])
})

// ---------------------------------------------------------------------------
// _calSeriesDates (frontend dashboard.js) — "Edit entire series" prefills the series start
// ---------------------------------------------------------------------------

const _dashSrc = require('fs').readFileSync(path.resolve(__dirname, '../../frontend/dashboard.js'), 'utf8')
const _calSeriesDates = new Function(`${_dashSrc.match(/function _calSeriesDates\(ev\) \{[\s\S]*?\n\}/)[0]}; return _calSeriesDates;`)()

test('DU-11 _calSeriesDates — timed occurrence → series start with the occurrence duration', () => {
  const r = _calSeriesDates({
    start: '2026-11-12T08:00:00.000Z', end: '2026-11-12T09:30:00.000Z',
    seriesStart: '2026-10-01T08:00:00.000Z', allDay: false,
  })
  expect(r).toEqual({ start: '2026-10-01T08:00:00.000Z', end: '2026-10-01T09:30:00.000Z' })
})

test('DU-12 _calSeriesDates — all-day occurrence → series start date, same day span', () => {
  const r = _calSeriesDates({ start: '2026-11-12', end: '2026-11-14', seriesStart: '2026-10-01', allDay: true })
  expect(r).toEqual({ start: '2026-10-01', end: '2026-10-03' })
})

test('DU-13 _calSeriesDates — no seriesStart → occurrence dates unchanged', () => {
  const ev = { start: '2026-11-12T08:00:00.000Z', end: '2026-11-12T09:00:00.000Z' }
  expect(_calSeriesDates(ev)).toEqual({ start: ev.start, end: ev.end })
})
