'use strict'
/**
 * Calendar view unit tests — CV-1 … CV-9
 *
 * calview.js is loaded via vm.runInContext with minimal browser-global stubs.
 * Only the pure helpers are exercised (range maths, layout, snapping, move bodies).
 * Dates are built with local constructors so the tests pass in any timezone.
 */

const vm   = require('vm')
const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')

let ctx

beforeAll(() => {
  const noop = () => {}
  ctx = vm.createContext({
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window:   { addEventListener: noop, location: { href: 'http://x/focus', search: '' } },
    history:  { pushState: noop, replaceState: noop, back: noop },
    localStorage: { getItem: () => null, setItem: noop },
    Intl, Date, Math, JSON, Object, Array, String, Number, URL, URLSearchParams,
    setInterval: noop, clearInterval: noop,
    _calAccountsMeta: [],
    _defaultTimezone: '',
  })
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'calview.js'), 'utf8'), ctx)
})

const ymd = d => ctx._cvYmd(d)

test('CV-1 _cvRange — week and work week start on Monday', () => {
  // Fri 2026-11-06
  const week = ctx._cvRange('week', new Date(2026, 10, 6, 15, 30))
  expect(ymd(week.start)).toBe('2026-11-02')
  expect(ymd(week.end)).toBe('2026-11-09')
  expect(week.days).toBe(7)

  const ww = ctx._cvRange('workweek', new Date(2026, 10, 8))   // Sunday → same week
  expect(ymd(ww.start)).toBe('2026-11-02')
  expect(ymd(ww.end)).toBe('2026-11-07')
  expect(ww.days).toBe(5)
})

test('CV-2 _cvRange — month covers whole weeks around the month', () => {
  const nov = ctx._cvRange('month', new Date(2026, 10, 17))
  expect(ymd(nov.start)).toBe('2026-10-26')   // Monday before Sun 1 Nov
  expect(ymd(nov.end)).toBe('2026-12-07')     // Monday after Mon 30 Nov's week
  expect(nov.days).toBe(42)

  const feb = ctx._cvRange('month', new Date(2027, 1, 10))   // Feb 2027 starts on Monday, 28 days
  expect(ymd(feb.start)).toBe('2027-02-01')
  expect(feb.days).toBe(28)
})

test('CV-3 _cvStep — navigates by week or month', () => {
  expect(ymd(ctx._cvStep('week', new Date(2026, 10, 6), 1))).toBe('2026-11-13')
  expect(ymd(ctx._cvStep('workweek', new Date(2026, 10, 6), -1))).toBe('2026-10-30')
  expect(ymd(ctx._cvStep('month', new Date(2026, 0, 31), 1))).toBe('2026-02-01')
  expect(ymd(ctx._cvStep('month', new Date(2026, 0, 15), -1))).toBe('2025-12-01')
})

test('CV-4 _cvIsoWeek — ISO week numbers', () => {
  expect(ctx._cvIsoWeek(new Date(2026, 10, 6))).toBe(45)
  expect(ctx._cvIsoWeek(new Date(2026, 0, 1))).toBe(1)
  expect(ctx._cvIsoWeek(new Date(2027, 0, 1))).toBe(53)
})

test('CV-5 _cvSnap — 15-minute grid with clamping', () => {
  expect(ctx._cvSnap(7)).toBe(0)
  expect(ctx._cvSnap(8)).toBe(15)
  expect(ctx._cvSnap(605)).toBe(600)
  expect(ctx._cvSnap(-20)).toBe(0)
  expect(ctx._cvSnap(1500)).toBe(1440)
  expect(ctx._cvSnap(10, 60, 120)).toBe(60)   // resize: never shorter than min
})

test('CV-6 _cvLayoutDay — overlapping events share the width', () => {
  const items = [
    { id: 'a', startMin: 540, endMin: 600 },   // 09:00–10:00
    { id: 'b', startMin: 570, endMin: 630 },   // 09:30–10:30 overlaps a
    { id: 'c', startMin: 600, endMin: 660 },   // 10:00–11:00 overlaps b, reuses a's column
    { id: 'd', startMin: 720, endMin: 780 },   // 12:00 — own cluster
  ]
  ctx._cvLayoutDay(items)
  const by = Object.fromEntries(items.map(i => [i.id, i]))
  expect(by.a).toMatchObject({ col: 0, cols: 2 })
  expect(by.b).toMatchObject({ col: 1, cols: 2 })
  expect(by.c).toMatchObject({ col: 0, cols: 2 })
  expect(by.d).toMatchObject({ col: 0, cols: 1 })
})

test('CV-7 _cvLaneBars — overlapping all-day bars stack', () => {
  const bars = [{ from: 0, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 5 }, { from: 5, to: 6 }]
  expect(ctx._cvLaneBars(bars)).toBe(2)
  expect(bars.map(b => b.lane)).toEqual([0, 1, 0, 0])
})

test('CV-8 _cvEventDates / _cvWallTime — all-day and timezone conversion', () => {
  const ad = ctx._cvEventDates({ allDay: true, start: '2026-11-04', end: '2026-11-06' })
  expect(ymd(ad.s)).toBe('2026-11-04')
  expect(ymd(ad.e)).toBe('2026-11-06')

  // 2026-11-06 09:00Z = 10:00 in Berlin (CET), 04:00 in New York (EST)
  const inst = new Date(Date.UTC(2026, 10, 6, 9, 0))
  expect(ctx._cvWallTime(inst, 'Europe/Berlin')).toBe('2026-11-06T10:00:00')
  expect(ctx._cvWallTime(inst, 'America/New_York')).toBe('2026-11-06T04:00:00')
})

describe('CV-9 _cvBuildMoveBody', () => {
  const base = {
    uid: 'u1', title: 'Standup', allDay: false, location: 'Room 1', description: 'daily',
    etag: '"e1"', href: '/cal/u1.ics', timezone: 'Europe/Berlin',
  }

  test('single timed event → wall-clock in event timezone + etag/href', () => {
    const s = new Date(Date.UTC(2026, 10, 6, 9, 0)), e = new Date(Date.UTC(2026, 10, 6, 10, 0))
    const body = ctx._cvBuildMoveBody({ ...base, start: '2026-11-05T09:00:00.000Z' }, s, e, null, 'Europe/Berlin')
    expect(body).toEqual({
      title: 'Standup', allDay: false, location: 'Room 1', description: 'daily',
      start: '2026-11-06T10:00:00', end: '2026-11-06T11:00:00', timezone: 'Europe/Berlin',
      etag: '"e1"', href: '/cal/u1.ics',
    })
  })

  test('UTC event → ISO timestamps without timezone', () => {
    const s = new Date(Date.UTC(2026, 10, 6, 9, 0)), e = new Date(Date.UTC(2026, 10, 6, 9, 30))
    const body = ctx._cvBuildMoveBody({ ...base, start: '2026-11-05T09:00:00.000Z' }, s, e, null, 'UTC')
    expect(body.start).toBe('2026-11-06T09:00:00.000Z')
    expect(body.end).toBe('2026-11-06T09:30:00.000Z')
    expect(body.timezone).toBeUndefined()
  })

  test('occurrence → editScope + original occurrence start', () => {
    const occ = { ...base, hasRrule: true, start: '2026-11-05T08:00:00.000Z' }
    const s = new Date(Date.UTC(2026, 10, 5, 12, 0)), e = new Date(Date.UTC(2026, 10, 5, 13, 0))
    const body = ctx._cvBuildMoveBody(occ, s, e, 'occurrence', 'Europe/Berlin')
    expect(body.editScope).toBe('occurrence')
    expect(body.occurrenceDate).toBe('2026-11-05T08:00:00.000Z')
    expect(body.start).toBe('2026-11-05T13:00:00')
  })

  test('series → wall-clock shift applied to the series start', () => {
    // Series started Mon 2026-11-02 09:00 local; occurrence Thu 05 09:00 moved to Fri 06 10:30
    const seriesStart = new Date(2026, 10, 2, 9, 0)
    const occStart    = new Date(2026, 10, 5, 9, 0)
    const ev = { ...base, hasRrule: true, start: occStart.toISOString(), end: new Date(2026, 10, 5, 9, 30).toISOString(), seriesStart: seriesStart.toISOString() }
    const body = ctx._cvBuildMoveBody(ev, new Date(2026, 10, 6, 10, 30), new Date(2026, 10, 6, 11, 0), 'series', 'Europe/Berlin')
    expect(body.editScope).toBe('series')
    expect(body.start).toBe(new Date(2026, 10, 3, 10, 30).toISOString())
    expect(body.end).toBe(new Date(2026, 10, 3, 11, 0).toISOString())
    expect(body.timezone).toBe('Europe/Berlin')
    expect('rrule' in body).toBe(false)   // RRULE stays untouched on the server
  })

  test('all-day event → date-only start/end (end exclusive)', () => {
    const ev = { ...base, allDay: true, start: '2026-11-04', end: '2026-11-06' }
    const body = ctx._cvBuildMoveBody(ev, new Date(2026, 10, 9), new Date(2026, 10, 11), null, 'Europe/Berlin')
    expect(body.start).toBe('2026-11-09')
    expect(body.end).toBe('2026-11-11')
    expect(body.timezone).toBeUndefined()
  })
})

test('CV-10 _cvClampZoom — between whole day and 6 visible hours', () => {
  const scroll = { clientHeight: 720 }
  expect(ctx._cvClampZoom(48, scroll)).toBe(48)
  expect(ctx._cvClampZoom(10, scroll)).toBe(30)     // 720 / 24 → 00:00–24:00 fits exactly
  expect(ctx._cvClampZoom(500, scroll)).toBe(120)   // 720 / 6  → 6 hours visible
  expect(ctx._cvClampZoom(77, { clientHeight: 0 })).toBe(77)   // not laid out yet → unchanged
})

test('CV-11 _cvClipLanes — full days show "+N more", bars are split around them', () => {
  // A 7-day bar in lane 0, then four single-day items on day 2 (lanes 1–4) → day 2 overflows max = 4
  const items = [{ from: 0, to: 7 }, ...[1, 2, 3, 4].map(() => ({ from: 2, to: 3 }))]
  ctx._cvLaneBars(items)
  const { segs, more, limit } = ctx._cvClipLanes(items, 7, 4)
  expect(limit).toEqual([4, 4, 3, 4, 4, 4, 4])
  expect(more).toEqual([0, 0, 2, 0, 0, 0, 0])              // lanes 3 and 4 hidden on day 2
  expect(segs.filter(s => s.item === items[0]).map(s => [s.from, s.to])).toEqual([[0, 7]])   // lane 0 stays continuous
  expect(segs.length).toBe(3)                               // bar + 2 visible single-day items

  // A bar in a hidden lane is cut where it crosses the full day
  const bars = [{ from: 1, to: 4 }, { from: 1, to: 4 }, { from: 1, to: 4 }, { from: 0, to: 6 }, { from: 2, to: 3 }]
  ctx._cvLaneBars(bars)                                     // the 0–6 bar gets lane 0 (starts first), day 2 needs 5 lanes
  const r = ctx._cvClipLanes(bars, 7, 4)
  const hidden = bars.find(b => b.lane === 3)
  expect(r.segs.filter(s => s.item === hidden).map(s => [s.from, s.to])).toEqual([[1, 2], [3, 4]])
  expect(r.more[2]).toBe(2)
})

test('CV-12 _cvEventsOnDay — events touching the day; all-day / multi-day first, then by start', () => {
  const day = new Date(2026, 10, 6)
  const ev = (title, s, e, allDay = false) => ({ title, _s: s, _e: e, allDay })
  const events = [
    ev('late',      new Date(2026, 10, 6, 15), new Date(2026, 10, 6, 16)),
    ev('early',     new Date(2026, 10, 6, 8),  new Date(2026, 10, 6, 9)),
    ev('allday',    new Date(2026, 10, 6),     new Date(2026, 10, 7), true),
    ev('overnight', new Date(2026, 10, 5, 22), new Date(2026, 10, 6, 2)),
    ev('trip',      new Date(2026, 10, 4),     new Date(2026, 10, 9), true),
    ev('yesterday', new Date(2026, 10, 5, 9),  new Date(2026, 10, 5, 10)),
    ev('tomorrow',  new Date(2026, 10, 7),     new Date(2026, 10, 7, 1)),
  ]
  expect(ctx._cvEventsOnDay(events, day).map(e => e.title)).toEqual(['trip', 'allday', 'overnight', 'early', 'late'])
})

test('CV-13 _cvDayListTime — all day, time range, continuing ends shown as …', () => {
  const day = new Date(2026, 10, 6)
  const t = d => ctx._cvTimeLabel(d)
  expect(ctx._cvDayListTime({ allDay: true, _s: day, _e: new Date(2026, 10, 7) }, day)).toBe('All day')
  const a = new Date(2026, 10, 6, 9), b = new Date(2026, 10, 6, 10, 30)
  expect(ctx._cvDayListTime({ _s: a, _e: b }, day)).toBe(`${t(a)} \u2013 ${t(b)}`)
  expect(ctx._cvDayListTime({ _s: new Date(2026, 10, 5, 22), _e: new Date(2026, 10, 6, 2) }, day)).toBe(`\u2026 \u2013 ${t(new Date(2026, 10, 6, 2))}`)
  expect(ctx._cvDayListTime({ _s: new Date(2026, 10, 6, 23), _e: new Date(2026, 10, 7, 1) }, day)).toBe(`${t(new Date(2026, 10, 6, 23))} \u2013 \u2026`)
})
