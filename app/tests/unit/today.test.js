'use strict'
/**
 * Today page unit tests — TU-1 … TU-31
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
    escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    safeLink: u => (/^https?:\/\//i.test(u) ? u : null),
    Intl, Date, Math, JSON, Object, Array, String, Number, Map, Set, Promise,
  })
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'today.js'), 'utf8'), ctx)
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'today-search.js'), 'utf8'), ctx)
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'today-stickies.js'), 'utf8'), ctx)
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

test('TU-13 size "available": one per column — stored, folded and edited layouts keep only one', () => {
  const two = { columns: [{ width: 1 }, { width: 1 }], tiles: [
    { id: 'agenda', col: 0, order: 0, size: 'available' },
    { id: 'attention', col: 0, order: 1, size: 'available' },
    { id: 'weather', col: 1, order: 0, size: 'available' },
  ] }
  // own layout: the first one per column keeps it
  const own = plain(ctx._todayResolveLayout({ lg: two }, 'lg', KNOWN))
  expect(own.tiles.map(t => t.size)).toEqual(['available', 'container', 'available'])
  // folded to one column: the moved tile falls back to container, "available" is not a tall fraction
  const one = plain(ctx._todayResolveLayout({ lg: two }, 'sm', KNOWN))
  expect(one.tiles.map(t => [t.id, t.size])).toEqual([['agenda', 'available'], ['attention', 'container'], ['weather', 'container']])
  // edit: keepId wins over the earlier tile
  const tiles = [{ id: 'a', col: 0, size: 'available' }, { id: 'b', col: 0, size: 'available' }, { id: 'c', col: 1, size: 'available' }]
  expect(plain(ctx._todayOneAvailable(tiles, 'b')).map(t => t.size)).toEqual(['container', 'available', 'available'])
})

test('TU-14 deactivated widgets: _todayKnownTiles skips them; _todayLayoutsWith re-adds a tile where it is missing', () => {
  expect(plain(ctx._todayKnownTiles({ disabled: ['weather', 'cvapp'] }))).toEqual(['agenda', 'attention', 'progress', 'quickaccess', 'boards', 'notes', 'search', 'stickies'])
  const layouts = {
    lg: { columns: [{ width: 2 }, { width: 1 }], tiles: [{ id: 'agenda', col: 0, order: 0, size: '1/1' }, { id: 'boards', col: 1, order: 0, size: 'container' }] },
    sm: { columns: [{ width: 1 }], tiles: [{ id: 'weather', col: 0, order: 0, size: 'container' }] },
  }
  const out = plain(ctx._todayLayoutsWith(layouts, 'weather'))
  expect(out.lg.tiles.at(-1)).toEqual({ id: 'weather', col: 1, order: 1, size: 'container' })
  expect(out.sm).toEqual(layouts.sm)
  expect(layouts.lg.tiles).toHaveLength(2)   // not mutated
})

test('TU-15 _todayFilterNoteTree — all words, accent-insensitive; folder match keeps its children', () => {
  const tree = [
    { type: 'folder', id: 'f1', title: 'Projekte', children: [
      { type: 'page', id: 'a', title: 'Café Planung' },
      { type: 'page', id: 'b', title: 'Budget' },
    ] },
    { type: 'folder', id: 'f2', title: 'Archiv', children: [{ type: 'page', id: 'c', title: 'Alte Planung 2024' }] },
    { type: 'page', id: 'd', title: 'Ideen' },
  ]
  expect(plain(ctx._todayFilterNoteTree(tree, ''))).toEqual(tree)
  const cafe = plain(ctx._todayFilterNoteTree(tree, 'cafe plan'))
  expect(cafe).toEqual([{ type: 'folder', id: 'f1', title: 'Projekte', children: [{ type: 'page', id: 'a', title: 'Café Planung' }] }])
  expect(plain(ctx._todayFilterNoteTree(tree, 'planung')).map(f => f.children.map(c => c.id))).toEqual([['a'], ['c']])
  expect(plain(ctx._todayFilterNoteTree(tree, 'projekte'))[0].children).toHaveLength(2)
  expect(plain(ctx._todayFilterNoteTree(tree, 'xyz'))).toEqual([])
})

test('TU-16 _todayWidgetShown — deactivated or missing from every stored layout = off', () => {
  const layouts = { lg: { columns: [{ width: 1 }], tiles: [{ id: 'agenda', col: 0, order: 0, size: '1/1' }] } }
  expect(ctx._todayWidgetShown({ layouts }, 'agenda')).toBe(true)
  expect(ctx._todayWidgetShown({ layouts }, 'notes')).toBe(false)
  expect(ctx._todayWidgetShown({ layouts, disabled: ['agenda'] }, 'agenda')).toBe(false)
  expect(ctx._todayWidgetShown({ layouts: {} }, 'notes')).toBe(true)
})

test('TU-17 _todayCvStatusCounts — counts per status in the CV-App order, unknown statuses last', () => {
  const apps = [{ status: 'Absage' }, { status: 'Versendet' }, { status: 'Research' }, { status: 'Versendet' }, { status: 'Neu' }, { status: 'Gespräch' }]
  expect(plain(ctx._todayCvStatusCounts(apps))).toEqual([
    { status: 'Research', count: 1 }, { status: 'Versendet', count: 2 }, { status: 'Gespräch', count: 1 },
    { status: 'Absage', count: 1 }, { status: 'Neu', count: 1 },
  ])
  expect(plain(ctx._todayCvStatusCounts([]))).toEqual([])
})

test('TU-18 _todayBoardCols — as many equal cards as fit, at least 2, at most the number of boards', () => {
  expect(ctx._todayBoardCols(400, 120, 8, 6)).toBe(3)    // (400 + 8) / 128 = 3.19
  expect(ctx._todayBoardCols(400, 250, 8, 6)).toBe(2)    // only 1 fits → still 2
  expect(ctx._todayBoardCols(1000, 120, 8, 4)).toBe(4)   // 7 would fit, 4 boards
  expect(ctx._todayBoardCols(1000, 120, 8, 1)).toBe(2)
  expect(ctx._todayBoardCols(400, 0, 8, 5)).toBe(2)
})

test('TU-19 _todayColumnNeed — fixed sizes as set, collapsed = header, fit content / available = header + content', () => {
  const H = 600, g = 26
  // 1/3 + collapsed + "available" with 200 px content: fits
  const fits = [
    { size: '1/3', headerH: 30, contentH: 999, collapsed: false },
    { size: '1/2', headerH: 30, contentH: 999, collapsed: true },
    { size: 'available', headerH: 30, contentH: 200, collapsed: false },
  ]
  const need = ctx._todayColumnNeed(fits, H, g)
  expect(need).toBeCloseTo((H / 3 - g * 2 / 3) + 30 + (30 + 200) + 2 * g)
  expect(need).toBeLessThan(H)
  // The same column with a long "available" tile overflows → the column scrolls anyway
  expect(ctx._todayColumnNeed([fits[0], fits[1], { ...fits[2], contentH: 900 }], H, g)).toBeGreaterThan(H)
  // A single 1/1 tile is exactly the column height
  expect(ctx._todayColumnNeed([{ size: '1/1', headerH: 30, contentH: 5000, collapsed: false }], H, g)).toBeCloseTo(H)
})

test('TU-20 _todayMeetingLink — Teams / Webex / Google Meet / Zoom from location, else description; other URLs ignored', () => {
  const m = ev => plain(ctx._todayMeetingLink(ev))
  expect(m({ location: 'https://acme.zoom.us/j/123456?pwd=abc' })).toEqual({ name: 'Zoom', url: 'https://acme.zoom.us/j/123456?pwd=abc' })
  expect(m({ location: 'Room 4', description: 'Join: <https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d>' }))
    .toEqual({ name: 'Teams', url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d' })
  expect(m({ description: 'Agenda https://example.com/doc then https://meet.google.com/abc-defg-hij.' }))
    .toEqual({ name: 'Google Meet', url: 'https://meet.google.com/abc-defg-hij' })
  expect(m({ location: 'https://acme.webex.com/acme/j.php?MTID=m1' }).name).toBe('Webex')
  expect(m({ location: 'https://zoom.us/', description: 'https://example.com/zoom.us/j/1' })).toBeNull()
  expect(m({ location: '', description: '' })).toBeNull()
})

test('TU-21 Quick access: _todayQaCfg defaults, _todayQaSplit (0 = all), _todayQaMove', () => {
  expect(plain(ctx._todayQaCfg({}))).toEqual({ visible: 8, size: 'm', showTitles: true, items: [] })
  expect(plain(ctx._todayQaCfg({ widgets: { quickaccess: { visible: 0, size: 'x', showTitles: false, items: [{ id: 'qa-1' }] } } })))
    .toEqual({ visible: 0, size: 'm', showTitles: false, items: [{ id: 'qa-1' }] })
  const items = ['a', 'b', 'c', 'd'].map(id => ({ id }))
  const ids = r => ({ shown: r.shown.map(i => i.id), more: r.more.map(i => i.id) })
  expect(ids(ctx._todayQaSplit(items, 2))).toEqual({ shown: ['a', 'b'], more: ['c', 'd'] })
  expect(ids(ctx._todayQaSplit(items, 0))).toEqual({ shown: ['a', 'b', 'c', 'd'], more: [] })
  expect(ids(ctx._todayQaSplit(items, 9))).toEqual({ shown: ['a', 'b', 'c', 'd'], more: [] })
  expect(ids(ctx._todayQaSplit(undefined, 3))).toEqual({ shown: [], more: [] })
  expect(plain(ctx._todayQaMove(items, 0, 2)).map(i => i.id)).toEqual(['b', 'c', 'a', 'd'])
  expect(plain(ctx._todayQaMove(items, 3, 0)).map(i => i.id)).toEqual(['d', 'a', 'b', 'c'])
  expect(items.map(i => i.id)).toEqual(['a', 'b', 'c', 'd'])   // not mutated
})

test('TU-22 Quick access: icon markup — stored image (bare, optional invert), emoji / letter (framed); escaped', () => {
  ctx.BASE_PATH = '/kb'
  ctx.URL = URL
  ctx.escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  expect(ctx._todayQaIconHtml({ icon: { type: 'image', file: 'qa-0123456789abcdef.png' } }))
    .toContain('src="/kb/api/today/quickaccess/icon/qa-0123456789abcdef.png"')
  expect(ctx._todayQaIconHtml({ icon: { type: 'emoji', value: '🚀' } })).toContain('🚀')
  expect(ctx._todayQaIconHtml({ title: 'grafana', icon: null })).toContain('>G<')
  expect(ctx._todayQaIconHtml({ url: 'https://www.example.com/x' })).toContain('>E<')   // host without www.
  expect(ctx._todayQaIconHtml({ title: '<b>', icon: { type: 'emoji', value: '<i>' } })).not.toContain('<i>')
  expect(ctx._todayQaHost('https://www.github.com/foo')).toBe('github.com')
  // App icons stand alone, emoji / letter get the framed area; invert class only when set
  expect(ctx._todayQaIconBoxHtml({ icon: { type: 'image', file: 'qa-0123456789abcdef.png' } })).toContain('today-qa-icon--img')
  expect(ctx._todayQaIconBoxHtml({ icon: { type: 'emoji', value: '🚀' } })).toContain('today-qa-icon--box')
  expect(ctx._todayQaIconBoxHtml({ title: 'x' })).toContain('today-qa-icon--box')
  expect(ctx._todayQaIconHtml({ icon: { type: 'image', file: 'qa-0123456789abcdef.png', invertDark: true } })).toContain('today-qa-img--invert')
  expect(ctx._todayQaIconHtml({ icon: { type: 'image', file: 'qa-0123456789abcdef.png' } })).not.toContain('--invert')
  delete ctx.BASE_PATH
})

test('TU-23 Search tile: registered; prefs (off list, full) with defaults; active types and request slots', () => {
  expect(vm.runInContext('TODAY_TILES.search.title', ctx)).toBe('Find')
  expect(plain(ctx._tsPrefs())).toEqual({ off: [], full: false })
  const saved = {}
  const orig = ctx.localStorage
  ctx.localStorage = { getItem: k => saved[k] ?? null, setItem: (k, v) => { saved[k] = v } }
  try {
    ctx._tsSavePrefs({ off: ['mail'], full: true })
    expect(plain(ctx._tsPrefs())).toEqual({ off: ['mail'], full: true })
    saved['today-search'] = '{broken'
    expect(plain(ctx._tsPrefs())).toEqual({ off: [], full: false })
  } finally { ctx.localStorage = orig }

  const sources = { types: ['cards', 'notes', 'mail', 'applications'], mailAccounts: [{ id: 'ma-1' }, { id: 'ma-2' }] }
  expect(plain(ctx._tsActiveTypes(sources.types, ['notes', 'events']))).toEqual(['cards', 'mail', 'applications'])
  expect(plain(ctx._tsSlots(sources, ['notes'])).map(s => s.id)).toEqual(['cards', 'mail:ma-1', 'mail:ma-2', 'applications'])
  expect(plain(ctx._tsSlots(sources, ['cards', 'notes', 'mail', 'applications']))).toEqual([])
  expect(ctx._tsUrl({ type: 'mail', acc: { id: 'ma 1' } }, 'a&b', true)).toBe('/api/today/search/mail?q=a%26b&full=1&account=ma%201')
})

test('TU-24 Search tile: _tsGroup merges mail accounts (newest first), sums totals, collects errors, keeps loading', () => {
  const slots = [{ id: 'mail:a', type: 'mail', acc: { id: 'a', label: 'A' } }, { id: 'mail:b', type: 'mail', acc: { id: 'b', label: 'B' } }, { id: 'cards', type: 'cards' }]
  const results = {
    'mail:a': { status: 'done', items: [{ id: '1', date: '2026-11-01' }], total: 3, truncated: true },
    'mail:b': { status: 'done', items: [{ id: '9', date: '2026-11-05' }], total: 1 },
  }
  const g = plain(ctx._tsGroup('mail', slots, results))
  expect(g.items.map(i => [i.acc.id, i.msg.id])).toEqual([['b', '9'], ['a', '1']])
  expect(g).toMatchObject({ status: 'done', total: 4, truncated: true, errors: [] })

  results['mail:b'] = { status: 'error', error: 'auth failed' }
  expect(plain(ctx._tsGroup('mail', slots, results))).toMatchObject({ status: 'done', total: 3, errors: ['B: auth failed'] })
  results['mail:b'] = { status: 'loading' }
  expect(ctx._tsGroup('mail', slots, results).status).toBe('loading')
  expect(ctx._tsGroup('cards', slots, results)).toBe(null)   // not requested yet
  results.cards = { status: 'error', error: 'HTTP 500' }
  expect(plain(ctx._tsGroup('cards', slots, results))).toMatchObject({ status: 'error', items: [], errors: ['HTTP 500'] })
})

test('TU-25 widget mode: _todayCollapsedForMode — all collapsed, all open, one at a time keeps the first open tile', () => {
  const ids = ['agenda', 'attention', 'progress']
  const set = (...v) => new Set(v)
  expect([...ctx._todayCollapsedForMode('closed', ids, set())]).toEqual(ids)
  expect([...ctx._todayCollapsedForMode('open', ids, set('agenda', 'progress'))]).toEqual([])
  expect([...ctx._todayCollapsedForMode('one', ids, set())]).toEqual(['attention', 'progress'])
  expect([...ctx._todayCollapsedForMode('one', ids, set('agenda'))]).toEqual(['agenda', 'progress'])
  expect([...ctx._todayCollapsedForMode('one', ids, set(...ids))]).toEqual(ids)   // none open: all stay collapsed
})

test('TU-26 Stickies tile: registered; slot angles ±1.5° … ±6°, distinct, shifted on every flip', () => {
  expect(vm.runInContext('TODAY_TILES.stickies.title', ctx)).toBe('Stickies')
  const ok = a => Math.abs(a) >= 1.5 && Math.abs(a) <= 6
  for (let run = 0; run < 50; run++) {
    const a = plain(ctx._stkShiftAngles(null, 0))
    expect(a).toHaveLength(4)
    expect(a.every(ok)).toBe(true)
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(Math.abs(a[i] - a[j])).toBeGreaterThanOrEqual(1.5)
    for (let i = 1; i < 4; i++) expect(Math.sign(a[i])).not.toBe(Math.sign(a[i - 1]))   // neighbours lean opposite ways
  }
  const a = [3, -4, 2, -5.5]
  // forward: papers move up keeping their angle, a new one at the end
  const f = plain(ctx._stkShiftAngles(a, 1))
  expect(f.slice(0, 3)).toEqual([-4, 2, -5.5])
  expect(ok(f[3]) && f[3] > 0).toBe(true)
  // backward: a new top, the others move down
  const b = plain(ctx._stkShiftAngles(a, -1))
  expect(b.slice(1)).toEqual([3, -4, 2])
  expect(ok(b[0]) && b[0] < 0).toBe(true)
  expect(plain(ctx._stkShiftAngles(a, 0))).toEqual(a)
  expect(ctx._stkShiftAngles(a, 9)).toHaveLength(4)
})

test('TU-27 Stickies: _stkDue — off for rhythm 0, due without a previous pick or after the rhythm', () => {
  const now = Date.UTC(2026, 10, 12, 12, 0)
  expect(ctx._stkDue(0, 0, now)).toBe(false)
  expect(ctx._stkDue(60, 0, now)).toBe(true)
  expect(ctx._stkDue(60, now - 59 * 60000, now)).toBe(false)
  expect(ctx._stkDue(60, now - 60 * 60000, now)).toBe(true)
  expect(ctx._stkDue(1440, now - 23 * 3600000, now)).toBe(false)
})

test('TU-28 Stickies: _stkPickRandom never repeats the current one; none / one sticky', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  for (const r of [0, 0.34, 0.5, 0.99, 0.999999]) expect(ctx._stkPickRandom(items, 'b', () => r)).not.toBe('b')
  expect(ctx._stkPickRandom(items, 'b', () => 0)).toBe('a')
  expect(ctx._stkPickRandom(items, 'b', () => 0.99)).toBe('c')
  expect(ctx._stkPickRandom([], 'a')).toBeNull()
  expect(ctx._stkPickRandom([{ id: 'a' }], 'a')).toBe('a')
})

test('TU-29 Stickies: _stkSplit title / body, _stkMarkdown quotes', () => {
  expect(plain(ctx._stkSplit('  Buy milk  '))).toEqual({ title: 'Buy milk', body: '' })
  expect(plain(ctx._stkSplit('Idea\nmore details'))).toEqual({ title: 'Idea', body: 'Idea\nmore details' })
  const long = 'word '.repeat(40).trim()
  const { title, body } = ctx._stkSplit(long)
  expect(title.endsWith('\u2026')).toBe(true)
  expect(title.length).toBeLessThanOrEqual(121)
  expect(title).not.toMatch(/wor\u2026$/)   // cut at a word
  expect(body).toBe(long)
  expect(ctx._stkMarkdown({ category: 'quote' }, 'To be\nor not')).toBe('> To be\n> or not')
  expect(ctx._stkMarkdown({ category: 'note' }, 'plain')).toBe('plain')
  expect(ctx._stkMarkdown({ category: 'quote' }, '')).toBe('')
  // Source: after the quote / as "Source:", the text included even when the title says it all
  expect(ctx._stkMarkdown({ category: 'quote', text: 'To be', source: 'Hamlet' }, '')).toBe('> To be\n>\n> \u2014 Hamlet')
  expect(ctx._stkMarkdown({ category: 'note', text: 'Idea', source: 'https://x.y' }, '')).toBe('Idea\n\nSource: https://x.y')
  expect(ctx._stkPlain({ text: 'To be', source: ' Hamlet ' }, '')).toBe('To be\n\n\u2014 Hamlet')
  expect(ctx._stkPlain({ text: 'a\nb', source: '' }, 'a\nb')).toBe('a\nb')
})

test('TU-30 Stickies: _stkLinkify — URLs as links without the scheme, trailing punctuation outside, rest escaped', () => {
  expect(ctx._stkLinkify('Seneca <Letters>')).toBe('Seneca &lt;Letters&gt;')
  const html = ctx._stkLinkify('see https://www.example.com/a?b=1. and http://x.org')
  expect(html).toBe('see <a href="https://www.example.com/a?b=1" target="_blank" rel="noopener noreferrer" title="https://www.example.com/a?b=1">example.com/a?b=1</a>. and '
    + '<a href="http://x.org" target="_blank" rel="noopener noreferrer" title="http://x.org">x.org</a>')
  expect(ctx._stkLinkify('javascript:alert(1)')).toBe('javascript:alert(1)')
  expect(ctx._stkLinkify('')).toBe('')
})

test('TU-31 Stickies: _stkFilter keeps the order, missing category = note; _stkCounts per category', () => {
  const items = [{ id: 'a', category: 'quote' }, { id: 'b' }, { id: 'c', category: 'note' }, { id: 'd', category: 'quote' }]
  expect(plain(ctx._stkFilter(items, 'all')).map(i => i.id)).toEqual(['a', 'b', 'c', 'd'])
  expect(plain(ctx._stkFilter(items, 'quote')).map(i => i.id)).toEqual(['a', 'd'])
  expect(plain(ctx._stkFilter(items, 'note')).map(i => i.id)).toEqual(['b', 'c'])
  expect(plain(ctx._stkFilter(items, 'other'))).toEqual([])
  expect(plain(ctx._stkCounts(items))).toEqual({ all: 4, note: 2, quote: 2, intervention: 0, other: 0 })
})

test('TU-32 Stickies order: pos wins, else newest first; drop position between neighbours; stable grid angles', () => {
  const items = [
    { id: 'old', created: '2026-11-01T10:00:00.000Z' },
    { id: 'new', created: '2026-11-05T10:00:00.000Z' },
    { id: 'mid', created: '2026-11-03T10:00:00.000Z' },
  ]
  expect(plain(ctx._stkSort(items)).map(i => i.id)).toEqual(['new', 'mid', 'old'])
  expect(items.map(i => i.id)).toEqual(['old', 'new', 'mid'])   // input untouched
  // "old" dropped between "new" and "mid"
  const k = id => ctx._stkOrderKey(items.find(i => i.id === id))
  const pos = ctx._stkPosBetween(k('new'), k('mid'))
  const moved = items.map(i => (i.id === 'old' ? { ...i, pos } : i))
  expect(plain(ctx._stkSort(moved)).map(i => i.id)).toEqual(['new', 'old', 'mid'])
  // a sticky created later still comes first
  moved.push({ id: 'newest', created: '2026-11-06T10:00:00.000Z' })
  expect(plain(ctx._stkSort(moved))[0].id).toBe('newest')
  expect(ctx._stkPosBetween(null, 5)).toBe(4)
  expect(ctx._stkPosBetween(5, null)).toBe(6)
  expect(ctx._stkPosBetween(null, null)).toBe(0)
  // Angles: same id → same angle; ±1.5–5°; both directions among a few ids
  const ids = ['s-000000000001', 's-000000000002', 's-000000000003', 's-00000000000a', 's-0000000000ff', 's-123456789abc']
  const angles = ids.map(id => ctx._stkGridAngle(id))
  expect(angles).toEqual(ids.map(id => ctx._stkGridAngle(id)))
  for (const a of angles) { expect(Math.abs(a)).toBeGreaterThanOrEqual(1.5); expect(Math.abs(a)).toBeLessThanOrEqual(5) }
  expect(angles.some(a => a > 0) && angles.some(a => a < 0)).toBe(true)
  expect(new Set(angles).size).toBeGreaterThan(3)
})
