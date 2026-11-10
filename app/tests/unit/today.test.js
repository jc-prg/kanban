'use strict'
/**
 * Today page unit tests — TU-1 … TU-11
 *
 * today.js is loaded via vm.runInContext with minimal browser-global stubs; only the pure
 * helpers are exercised (layout resolution / folding, agenda model, weather mapping, ISO week).
 * Dates are built with local constructors so the tests pass in any timezone.
 */

const vm   = require('vm')
const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')
const KNOWN = ['agenda', 'attention', 'weather', 'cvapp', 'progress', 'boards']

let ctx

beforeAll(() => {
  const noop = () => {}
  ctx = vm.createContext({
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window:   { addEventListener: noop, location: { href: 'http://x/today', search: '' }, innerWidth: 1400 },
    localStorage: { getItem: () => null, setItem: noop },
    SVGICONS: {}, ICONS: {},
    Intl, Date, Math, JSON, Object, Array, String, Number, Map, Set, Promise,
  })
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'today.js'), 'utf8'), ctx)
})

// Plain copies (vm objects have a foreign Object prototype → toEqual is stricter)
const plain = v => JSON.parse(JSON.stringify(v))

const LAYOUTS = {
  xl: {
    columns: [{ width: 2 }, { width: 1 }, { width: 1 }],
    tiles: [
      { id: 'agenda',    col: 0, order: 0, size: '1/1' },
      { id: 'attention', col: 1, order: 0, size: 'container' },
      { id: 'weather',   col: 1, order: 1, size: 'container' },
      { id: 'cvapp',     col: 2, order: 0, size: '1/2' },
      { id: 'progress',  col: 2, order: 1, size: 'container' },
    ],
  },
}

test('TU-1 _todayBpFor — breakpoints by viewport width', () => {
  expect(ctx._todayBpFor(1920)).toBe('xl')
  expect(ctx._todayBpFor(1600)).toBe('xl')
  expect(ctx._todayBpFor(1599)).toBe('lg')
  expect(ctx._todayBpFor(1000)).toBe('md')
  expect(ctx._todayBpFor(390)).toBe('sm')
})

test('TU-2 _todayResolveLayout — a breakpoint\'s own layout wins and is normalised', () => {
  const r = plain(ctx._todayResolveLayout({
    lg: { columns: [{ width: 2 }, { width: 1 }], tiles: [
      { id: 'weather', col: 1, order: 5, size: '1/3' },
      { id: 'agenda',  col: 0, order: 0, size: '1/1' },
      { id: 'gone',    col: 0, order: 1, size: '1/1' },      // unknown tile → skipped
      { id: 'cvapp',   col: 9, order: 0, size: 'huge' },     // column clamped, size → container
    ] },
  }, 'lg', KNOWN))
  expect(r.derived).toBe(false)
  expect(r.tiles).toEqual([
    { id: 'agenda',  col: 0, order: 0, size: '1/1' },
    { id: 'cvapp',   col: 1, order: 0, size: 'container' },
    { id: 'weather', col: 1, order: 1, size: '1/3' },
  ])
})

test('TU-3 _todayResolveLayout — 3 → 2 columns: dropped tiles go to the column with the least height', () => {
  const r = plain(ctx._todayResolveLayout(LAYOUTS, 'lg', KNOWN))
  expect(r.derived).toBe(true)
  expect(r.from).toBe('xl')
  expect(r.columns).toEqual([{ width: 2 }, { width: 1 }])
  // col 0 = agenda (1), col 1 = attention + weather (2 × 1/3) → cvapp (1/2) goes to col 1 (2/3 < 1),
  // then col 1 = 7/6 > col 0 = 1 → progress goes to col 0
  expect(r.tiles).toEqual([
    { id: 'agenda',    col: 0, order: 0, size: '1/1' },
    { id: 'progress',  col: 0, order: 1, size: 'container' },
    { id: 'attention', col: 1, order: 0, size: 'container' },
    { id: 'weather',   col: 1, order: 1, size: 'container' },
    { id: 'cvapp',     col: 1, order: 2, size: '1/2' },
  ])
})

test('TU-4 _todayResolveLayout — 1 column: tall fractions become container, small ones stay', () => {
  const r = plain(ctx._todayResolveLayout(LAYOUTS, 'sm', KNOWN))
  expect(r.columns).toHaveLength(1)
  expect(r.tiles.map(t => t.id)).toEqual(['agenda', 'attention', 'weather', 'cvapp', 'progress'])
  expect(r.tiles.find(t => t.id === 'agenda').size).toBe('container')
  expect(r.tiles.find(t => t.id === 'cvapp').size).toBe('container')

  const small = plain(ctx._todayResolveLayout({ xl: { columns: [{ width: 1 }, { width: 1 }], tiles: [
    { id: 'agenda', col: 0, size: '1/3' }, { id: 'weather', col: 1, size: '2/3' },
  ] } }, 'sm', KNOWN))
  expect(small.tiles).toEqual([
    { id: 'agenda',  col: 0, order: 0, size: '1/3' },
    { id: 'weather', col: 0, order: 1, size: 'container' },
  ])
})

test('TU-5 _todayResolveLayout — width limits the derived column count; never more columns than the source', () => {
  // md allows 2 columns, but 500 px only fit one at 320 px minimum
  expect(ctx._todayResolveLayout(LAYOUTS, 'md', KNOWN, 500).columns).toHaveLength(1)
  expect(ctx._todayResolveLayout(LAYOUTS, 'md', KNOWN, 900).columns).toHaveLength(2)
  // A 1-column xl layout stays 1 column on lg
  const one = { xl: { columns: [{ width: 1 }], tiles: [{ id: 'agenda', col: 0, size: '1/2' }] } }
  expect(ctx._todayResolveLayout(one, 'lg', KNOWN).columns).toHaveLength(1)
})

test('TU-6 _todayResolveLayout — falls back to a smaller layout, then to all tiles stacked', () => {
  const r = plain(ctx._todayResolveLayout({ sm: { columns: [{ width: 1 }], tiles: [{ id: 'boards', col: 0, size: 'container' }] } }, 'xl', KNOWN))
  expect(r.from).toBe('sm')
  expect(r.tiles.map(t => t.id)).toEqual(['boards'])

  const none = plain(ctx._todayResolveLayout({}, 'lg', KNOWN))
  expect(none.from).toBeNull()
  expect(none.tiles.map(t => t.id)).toEqual(KNOWN)
})

// ---- Agenda ----

const iso = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString()

test('TU-7 _todayAgendaDay — all-day vs timed, sorted, continuing events in the all-day row', () => {
  const events = [
    { uid: 'b', title: 'Lunch',   start: iso(10, 12), end: iso(10, 13) },
    { uid: 'a', title: 'Standup', start: iso(10, 9, 30), end: iso(10, 9, 45) },
    { uid: 'c', title: 'Holiday', allDay: true, start: '2026-11-09', end: '2026-11-12' },
    { uid: 'd', title: 'Trip',    start: iso(9, 18), end: iso(10, 11) },          // from yesterday
    { uid: 'e', title: 'Tomorrow', start: iso(11, 9), end: iso(11, 10) },
    { uid: 'f', title: 'Ended',   allDay: true, start: '2026-11-09', end: '2026-11-10' },   // DTEND exclusive
  ]
  const day = plain(ctx._todayAgendaDay(events, { due: [], starts: [] }, '2026-11-10', new Date(2026, 10, 10, 10, 0)))
  expect(day.allDay.map(i => i.ev.uid)).toEqual(['c', 'd'])
  expect(day.allDay[1].continues).toBe(true)
  expect(day.timed.map(i => i.ev.uid)).toEqual(['a', 'b'])
  expect(day.timed[0].past).toBe(true)
  expect(day.timed[1].past).toBe(false)
})

test('TU-8 _todayAgendaDay — now line position, only on the day itself', () => {
  const events = [
    { uid: 'a', title: 'A', start: iso(10, 8), end: iso(10, 9) },
    { uid: 'b', title: 'B', start: iso(10, 14), end: iso(10, 15) },
  ]
  expect(ctx._todayAgendaDay(events, {}, '2026-11-10', new Date(2026, 10, 10, 10)).nowIndex).toBe(1)
  expect(ctx._todayAgendaDay(events, {}, '2026-11-10', new Date(2026, 10, 10, 7)).nowIndex).toBe(0)
  expect(ctx._todayAgendaDay(events, {}, '2026-11-10', new Date(2026, 10, 10, 20)).nowIndex).toBe(2)
  expect(ctx._todayAgendaDay(events, {}, '2026-11-11', new Date(2026, 10, 10, 10)).nowIndex).toBe(-1)
})

test('TU-9 _todayAgendaDay — cards: starting today in the all-day row, due ones separately', () => {
  const item = id => ({ board: 'b', column: 'TODO', card: { id, text: id } })
  const day = plain(ctx._todayAgendaDay([], { due: [item('x')], starts: [item('y')] }, '2026-11-10', new Date(2026, 10, 10, 10)))
  expect(day.allDay).toEqual([{ kind: 'card', board: 'b', column: 'TODO', card: { id: 'y', text: 'y' }, why: 'starts' }])
  expect(day.due.map(d => [d.card.id, d.why])).toEqual([['x', 'due']])
})

// ---- Weather / misc ----

test('TU-10 _todayWeatherKind — WMO codes → icon, night variant; _todayNextRain', () => {
  expect(plain(ctx._todayWeatherKind(0))).toEqual({ icon: 'wxSun', label: 'Clear' })
  expect(ctx._todayWeatherKind(0, false).icon).toBe('wxMoon')
  expect(ctx._todayWeatherKind(2).icon).toBe('wxPartly')
  expect(ctx._todayWeatherKind(3).icon).toBe('wxCloud')
  expect(ctx._todayWeatherKind(45).icon).toBe('wxFog')
  expect(ctx._todayWeatherKind(53).label).toBe('Drizzle')
  expect(ctx._todayWeatherKind(63).icon).toBe('wxRain')
  expect(ctx._todayWeatherKind(75).icon).toBe('wxSnow')
  expect(ctx._todayWeatherKind(81).label).toBe('Showers')
  expect(ctx._todayWeatherKind(96).icon).toBe('wxThunder')
  expect(ctx._todayNextRain([{ time: 'a', precip: 20 }, { time: 'b', precip: 55 }]).time).toBe('b')
  expect(ctx._todayNextRain([{ time: 'a', precip: 20 }])).toBeNull()
})

test('TU-11 _todayIsoWeek and _todayAddDays', () => {
  expect(ctx._todayIsoWeek(new Date(2026, 10, 10))).toBe(46)
  expect(ctx._todayIsoWeek(new Date(2027, 0, 1))).toBe(53)   // Fri 1 Jan 2027 belongs to 2026-W53
  expect(ctx._todayIsoWeek(new Date(2027, 0, 4))).toBe(1)
  expect(ctx._todayAddDays('2026-12-31', 1)).toBe('2027-01-01')
  expect(ctx._todayAddDays('2026-03-29', 1)).toBe('2026-03-30')   // DST change
})

test('TU-12 _todayAgendaDays — 7-day range uses dueWeek / startsWeek per day; _todayAgendaRange', () => {
  const item = (id, card) => ({ board: 'b', column: 'TODO', card: { id, text: id, ...card } })
  const cards = {
    dueToday: [item('t', { endDate: '2026-11-10' })], startsToday: [],
    dueWeek: [item('w1', { endDate: '2026-11-11' }), item('w4', { endDate: '2026-11-14' })],
    startsWeek: [item('s3', { startDate: '2026-11-13', endDate: '2026-11-15' })],
  }
  const events = [{ uid: 'e', title: 'E', start: iso(16, 9), end: iso(16, 10) }]
  const days = plain(ctx._todayAgendaDays(events, cards, '2026-11-10', 7, new Date(2026, 10, 10, 8)))
  expect(days.map(d => d.day)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'])
  expect(days[0].due.map(d => d.card.id)).toEqual(['t'])
  expect(days[1].due.map(d => d.card.id)).toEqual(['w1'])
  expect(days[3].allDay.map(d => d.card.id)).toEqual(['s3'])
  expect(days[4].due.map(d => d.card.id)).toEqual(['w4'])
  expect(days[6].timed.map(d => d.ev.uid)).toEqual(['e'])
  expect(days[6].nowIndex).toBe(-1)

  expect(ctx._todayAgendaDays([], cards, '2026-11-10', 2, new Date())).toHaveLength(2)
  expect(ctx._todayAgendaRange({ widgets: { agenda: { days: 7 } } })).toBe(7)
  expect(ctx._todayAgendaRange({})).toBe(2)
})
