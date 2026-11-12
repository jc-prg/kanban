'use strict'
/**
 * Today page API tests — TD-1 … TD-21
 *
 * routes/today.js is mounted on its own with db.js / global-db.js replaced via require.cache;
 * Open-Meteo and the CV-App are mocked with vi.stubGlobal('fetch').
 */

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

const path    = require('path')
const express = require('express')
const request = require('supertest')

const DB_MODULE        = path.resolve(__dirname, '../../backend/db.js')
const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')

// ---- Mock CouchDB: board name → board doc ----
const boards = {}
const notes  = {}   // board name → notes doc
const couch = {
  db:  { list: async () => Object.keys(boards).map(b => `jc-kanban-${b}`).concat(['jc-config-dashboard']) },
  use: name => ({
    get: async id => {
      const b   = name.replace(/^jc-kanban-/, '')
      const doc = id === 'notes' ? notes[b] : boards[b]
      if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 })
      return JSON.parse(JSON.stringify(doc))
    },
  }),
}
require.cache[DB_MODULE] = {
  id: DB_MODULE, filename: DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    getCouch: () => couch,
    withHandler: h => async (req, res) => { try { await h(req, res) } catch (e) { res.status(500).json({ error: e.message }) } },
  },
}

// ---- Mock global config DB ----
const store = { today: null }
const webdav = {}   // board name → jc-config-webdav doc
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    getTodayConfig:  async () => (store.today ? JSON.parse(JSON.stringify(store.today)) : null),
    getWebdavDb:       () => ({ get: async board => {
      if (!webdav[board]) throw Object.assign(new Error('not_found'), { statusCode: 404 })
      return webdav[board]
    } }),
    getWebdavAccounts: async () => [{ id: 'wa-1', url: 'https://dav.example/' }],
    saveTodayConfig: async data => { store.today = JSON.parse(JSON.stringify(data)); return { ok: true } },
  },
}

const app = express()
app.use(express.json())
app.use('/api', require('../../backend/routes/today'))
const { _clearCache: clearWeather }  = require('../../backend/today/weather')
const { _clearCache: clearCvApp }    = require('../../backend/today/cvapp')

const card = (id, extra = {}) => ({ id, text: `Card ${id}`, ...extra })

beforeEach(() => {
  store.today = null
  for (const k of Object.keys(boards)) delete boards[k]
  for (const k of Object.keys(notes)) delete notes[k]
  for (const k of Object.keys(webdav)) delete webdav[k]
  clearWeather()
  clearCvApp()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

test('TD-1 GET /today/config returns the default layouts when nothing is stored', async () => {
  const res = await request(app).get('/api/today/config')
  expect(res.status).toBe(200)
  expect(res.body.showBar).toBe(true)
  expect(Object.keys(res.body.layouts).sort()).toEqual(['lg', 'sm', 'xl'])
  expect(res.body.layouts.lg.columns).toEqual([{ width: 2 }, { width: 1 }])
  expect(res.body.layouts.lg.tiles.find(t => t.id === 'agenda')).toMatchObject({ col: 0, size: '1/1' })
})

test('TD-2 PUT stores a layout; GET returns it and keeps the other breakpoints', async () => {
  const md = { columns: [{ width: 1 }, { width: 1 }], tiles: [{ id: 'agenda', col: 1, order: 0, size: '1/3' }] }
  const put = await request(app).put('/api/today/config').send({ layouts: { md } })
  expect(put.status).toBe(200)
  const res = await request(app).get('/api/today/config')
  expect(res.body.layouts).toEqual({ md })
  expect(res.body.showBar).toBe(true)
})

test('TD-3 PUT rejects 5 columns, an unknown size and a tile outside the columns', async () => {
  const cols = n => Array.from({ length: n }, () => ({ width: 1 }))
  const five = await request(app).put('/api/today/config').send({ layouts: { lg: { columns: cols(5), tiles: [] } } })
  expect(five.status).toBe(400)
  const size = await request(app).put('/api/today/config').send({ layouts: { lg: { columns: cols(1), tiles: [{ id: 'agenda', col: 0, size: '3/4' }] } } })
  expect(size.status).toBe(400)
  const col = await request(app).put('/api/today/config').send({ layouts: { lg: { columns: cols(2), tiles: [{ id: 'agenda', col: 2, size: '1/1' }] } } })
  expect(col.status).toBe(400)
  expect(col.body.error).toMatch(/column 3/)
  const dup = await request(app).put('/api/today/config').send({ layouts: { lg: { columns: cols(1), tiles: [{ id: 'agenda', col: 0, size: '1/1' }, { id: 'agenda', col: 0, size: '1/3' }] } } })
  expect(dup.status).toBe(400)
  expect(store.today).toBeNull()
})

test('TD-4 CV-App API key is stripped on GET and kept on PUT when omitted', async () => {
  await request(app).put('/api/today/config').send({ widgets: { cvapp: { apiUrl: 'http://cv:8000', apiKey: 'secret-key' } } })
  expect(store.today.widgets.cvapp.apiKey).toBe('secret-key')

  const get = await request(app).get('/api/today/config')
  expect(get.body.widgets.cvapp).toEqual({ apiUrl: 'http://cv:8000', hasApiKey: true })
  expect(JSON.stringify(get.body)).not.toContain('secret-key')

  await request(app).put('/api/today/config').send({ widgets: { cvapp: { apiUrl: 'http://cv:9000', hasApiKey: true } } })
  expect(store.today.widgets.cvapp).toEqual({ apiUrl: 'http://cv:9000', apiKey: 'secret-key' })

  // Layout-only PUTs never touch widget settings
  await request(app).put('/api/today/config').send({ showBar: false })
  expect(store.today.widgets.cvapp.apiKey).toBe('secret-key')
  expect(store.today.showBar).toBe(false)

  // hasApiKey: false clears it
  await request(app).put('/api/today/config').send({ widgets: { cvapp: { apiUrl: 'http://cv:9000', hasApiKey: false } } })
  expect(store.today.widgets.cvapp.apiKey).toBeUndefined()
})

test('TD-15 agenda range: days 2 or 7 only', async () => {
  expect((await request(app).put('/api/today/config').send({ widgets: { agenda: { days: 7 } } })).status).toBe(200)
  expect(store.today.widgets.agenda).toEqual({ days: 7 })
  expect((await request(app).put('/api/today/config').send({ widgets: { agenda: { days: 5 } } })).status).toBe(400)
})

test('TD-5 PUT rejects non-http CV-App URLs and a half weather location', async () => {
  const bad = await request(app).put('/api/today/config').send({ widgets: { cvapp: { apiUrl: 'javascript:alert(1)' } } })
  expect(bad.status).toBe(400)
  const half = await request(app).put('/api/today/config').send({ widgets: { weather: { lat: 52.5 } } })
  expect(half.status).toBe(400)
})

test('TD-6 POST reset-layouts restores the defaults and keeps widget settings', async () => {
  store.today = { showBar: false, widgets: { weather: { lat: 1, lon: 2 } }, layouts: { md: { columns: [{ width: 1 }], tiles: [] } } }
  const res = await request(app).post('/api/today/config/reset-layouts')
  expect(res.status).toBe(200)
  expect(Object.keys(store.today.layouts).sort()).toEqual(['lg', 'sm', 'xl'])
  expect(store.today.widgets.weather).toEqual({ lat: 1, lon: 2 })
  expect(store.today.showBar).toBe(false)
})

test('TD-7 unknown widget → 404', async () => {
  const res = await request(app).get('/api/today/widgets/nope')
  expect(res.status).toBe(404)
  const proto = await request(app).get('/api/today/widgets/constructor')
  expect(proto.status).toBe(404)
})

test('TD-8 cards widget: overdue / due / starts / tomorrow / unread across boards; archived and done skipped', async () => {
  boards.work = { columns: [
    { id: 'c1', title: 'TODO', cards: [
      card('a', { endDate: '2026-11-09' }),                       // overdue
      card('b', { endDate: '2026-11-10', priority: 1 }),          // due today
      card('c', { startDate: '2026-11-10' }),                     // starts today
      card('d', { endDate: '2026-11-11' }),                       // due tomorrow
      card('g', { startDate: '2026-11-14', endDate: '2026-11-16' }), // starts + due within the week
      card('i', { endDate: '2026-11-17' }),                       // today + 7 → outside the week
      card('e', { endDate: '2026-11-01', done: true }),           // done → ignored
      card('f', { unread: true, created: '2026-11-10' }),         // new
      { id: 'h', text: '# Section', endDate: '2026-11-01' },      // header card → ignored
    ] },
  ] }
  boards.old = { settings: { archived: true }, columns: [{ id: 'x', title: 'X', cards: [card('z', { endDate: '2026-11-01' })] }] }

  const res = await request(app).get('/api/today/widgets/cards?date=2026-11-10')
  expect(res.status).toBe(200)
  const ids = k => res.body[k].map(i => i.card.id)
  expect(ids('overdue')).toEqual(['a'])
  expect(ids('dueToday')).toEqual(['b'])
  expect(ids('startsToday')).toEqual(['c'])
  expect(ids('dueTomorrow')).toEqual(['d'])
  expect(ids('dueWeek')).toEqual(['d', 'g'])
  expect(ids('startsWeek')).toEqual(['g'])
  expect(ids('unread')).toEqual(['f'])
  expect(res.body.counts).toEqual({ overdue: 1, dueToday: 1, startsToday: 1, dueTomorrow: 1, dueWeek: 2, startsWeek: 1, unread: 1 })
  expect(res.body.overdue[0]).toMatchObject({ board: 'work', column: 'TODO' })
  expect(res.body.dueToday[0].card.description).toBe(false)
})

test('TD-9 weather widget: 400 without location', async () => {
  const res = await request(app).get('/api/today/widgets/weather')
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/location/i)
})

test('TD-10 weather widget: normalises Open-Meteo and caches per location', async () => {
  store.today = { widgets: { weather: { lat: 52.52, lon: 13.41, label: 'Berlin' } } }
  const hours = Array.from({ length: 48 }, (_, i) => `2026-11-${String(10 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`)
  const fetchMock = vi.fn(async url => {
    expect(String(url)).toContain('latitude=52.52')
    return { ok: true, json: async () => ({
      current: { time: '2026-11-10T10:45', temperature_2m: 8.4, weather_code: 3, is_day: 1 },
      hourly:  { time: hours, temperature_2m: hours.map((_, i) => i), precipitation_probability: hours.map(() => 10), weather_code: hours.map(() => 61) },
      daily:   { time: ['2026-11-10', '2026-11-11'], temperature_2m_min: [4, 2], temperature_2m_max: [11, 9], weather_code: [61, 3], precipitation_probability_max: [60, 10], sunrise: ['2026-11-10T07:20', ''], sunset: ['2026-11-10T16:20', ''] },
    }) }
  })
  vi.stubGlobal('fetch', fetchMock)

  const res = await request(app).get('/api/today/widgets/weather')
  expect(res.status).toBe(200)
  expect(res.body.label).toBe('Berlin')
  expect(res.body.current).toEqual({ time: '2026-11-10T10:45', temp: 8.4, code: 3, isDay: true })
  expect(res.body.today).toMatchObject({ date: '2026-11-10', min: 4, max: 11, precipMax: 60 })
  expect(res.body.hours).toHaveLength(12)
  expect(res.body.hours[0].time).toBe('2026-11-10T10:00')   // from the current hour on

  await request(app).get('/api/today/widgets/weather')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('TD-11 weather widget: upstream error → 502', async () => {
  store.today = { widgets: { weather: { lat: 1, lon: 2 } } }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
  const res = await request(app).get('/api/today/widgets/weather')
  expect(res.status).toBe(502)
  expect(res.body.error).toMatch(/503/)
})

test('TD-12 cvapp widget: sends x-api-key, filters closed applications, counts statuses, builds deep links', async () => {
  store.today = { widgets: { cvapp: { apiUrl: 'http://cv:8000/', publicUrl: 'https://host/cvapp/', apiKey: 'k1' } } }
  const fetchMock = vi.fn(async (url, opts) => {
    expect(url).toBe('http://cv:8000/api/applications')
    expect(opts.headers['x-api-key']).toBe('k1')
    return { ok: true, json: async () => [
      { id: 'a1', title: 'Dev', company: 'ACME', status: 'Versendet', updated_at: '2026-11-01T10:00:00', applied_at: '2026-11-01', fit_score: 3, status_note: 'waiting' },
      { id: 'a2', title: 'Lead', company: 'Foo', status: 'Gespräch', updated_at: '2026-11-09T10:00:00' },
      { id: 'a3', title: 'Old', company: 'Bar', status: 'Absage', updated_at: '2026-11-10T10:00:00' },
      { id: 'a4', title: 'Prep', company: 'Baz', status: 'Vorbereitung', updated_at: '2026-10-01T10:00:00' },
      { id: 'a5', title: 'Offer', company: 'Qux', status: 'Angebot', updated_at: '2026-10-02T10:00:00' },
    ] }
  })
  vi.stubGlobal('fetch', fetchMock)

  const res = await request(app).get('/api/today/widgets/cvapp')
  expect(res.status).toBe(200)
  // Active = Research / Vorbereitung / Versendet / Gespräch / Angebot (Absage excluded)
  expect(res.body.total).toBe(4)
  expect(res.body.statuses).toEqual([
    { status: 'Vorbereitung', count: 1 }, { status: 'Versendet', count: 1 }, { status: 'Gespräch', count: 1 }, { status: 'Angebot', count: 1 },
  ])
  // Active list: most advanced status first; recent: last updated first, closed ones included
  expect(res.body.active.map(a => a.id)).toEqual(['a5', 'a2', 'a1', 'a4'])
  expect(res.body.recent.map(a => a.id)).toEqual(['a3', 'a2', 'a1', 'a5', 'a4'])
  expect(res.body.active[2]).toMatchObject({ statusNote: 'waiting', fitScore: 3, appliedAt: '2026-11-01', url: 'https://host/cvapp/#/applications?id=a1' })
  expect(JSON.stringify(res.body)).not.toContain('k1')
})

test('TD-13 cvapp widget: not configured → 400; upstream 401 → 502', async () => {
  const none = await request(app).get('/api/today/widgets/cvapp')
  expect(none.status).toBe(400)

  store.today = { widgets: { cvapp: { apiUrl: 'http://cv:8000' } } }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
  const res = await request(app).get('/api/today/widgets/cvapp')
  expect(res.status).toBe(502)
  expect(res.body.error).toMatch(/401/)
})

test('TD-14 geocode: validates q and maps Open-Meteo results', async () => {
  expect((await request(app).get('/api/today/geocode?q=a')).status).toBe(400)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    results: [{ name: 'Berlin', admin1: 'Berlin', country: 'Deutschland', latitude: 52.52, longitude: 13.41 }],
  }) })))
  const res = await request(app).get('/api/today/geocode?q=Berlin')
  expect(res.status).toBe(200)
  expect(res.body.results).toEqual([{ name: 'Berlin', admin1: 'Berlin', country: 'Deutschland', lat: 52.52, lon: 13.41 }])
})

test('TD-16 layout size "available": accepted once per column, rejected twice in one column', async () => {
  const layout = tiles => ({ layouts: { lg: { columns: [{ width: 1 }, { width: 1 }], tiles } } })
  const ok = await request(app).put('/api/today/config').send(layout([
    { id: 'agenda', col: 0, order: 0, size: 'available' }, { id: 'weather', col: 1, order: 0, size: 'available' },
  ]))
  expect(ok.status).toBe(200)
  const bad = await request(app).put('/api/today/config').send(layout([
    { id: 'agenda', col: 0, order: 0, size: 'available' }, { id: 'weather', col: 0, order: 1, size: 'available' },
  ]))
  expect(bad.status).toBe(400)
  expect(bad.body.error).toMatch(/more than one/)
})

test('TD-17 refreshMinutes: default 1, 0–60 accepted, others rejected', async () => {
  expect((await request(app).get('/api/today/config')).body.refreshMinutes).toBe(1)
  expect((await request(app).put('/api/today/config').send({ refreshMinutes: 0 })).status).toBe(200)
  expect((await request(app).put('/api/today/config').send({ refreshMinutes: 5 })).body.config.refreshMinutes).toBe(5)
  expect((await request(app).put('/api/today/config').send({ refreshMinutes: 61 })).status).toBe(400)
  expect((await request(app).put('/api/today/config').send({ refreshMinutes: 1.5 })).status).toBe(400)
})

test('TD-18 disabled widgets: default empty, list of ids saved, invalid ids / duplicates rejected', async () => {
  expect((await request(app).get('/api/today/config')).body.disabled).toEqual([])
  const ok = await request(app).put('/api/today/config').send({ disabled: ['weather', 'cvapp'] })
  expect(ok.status).toBe(200)
  expect(store.today.disabled).toEqual(['weather', 'cvapp'])
  expect((await request(app).put('/api/today/config').send({ disabled: ['Bad Id'] })).status).toBe(400)
  expect((await request(app).put('/api/today/config').send({ disabled: ['a', 'a'] })).status).toBe(400)
})

test('TD-19 notes widget: page trees (titles only) of active boards; archived boards and boards without pages skipped', async () => {
  boards.work = { columns: [] }
  notes.work  = { schemaVersion: 2, items: [
    { type: 'folder', id: 'f1', title: 'Projects', children: [
      { type: 'page', id: 'n-a', title: 'Alpha', description: 'secret body', lastModified: '2026-11-01T10:00:00Z' },
    ] },
    { type: 'page', id: 'n-b', title: 'Beta', linkedCards: ['id-x'] },
  ] }
  boards.old  = { columns: [], settings: { archived: true } }
  notes.old   = { schemaVersion: 2, items: [{ type: 'page', id: 'n-c', title: 'Old' }] }
  boards.empty = { columns: [] }
  notes.empty  = { schemaVersion: 2, items: [{ type: 'folder', id: 'f2', title: 'Nothing', children: [] }] }
  boards.none  = { columns: [] }   // no notes doc

  const res = await request(app).get('/api/today/widgets/notes')
  expect(res.status).toBe(200)
  expect(res.body.total).toBe(2)
  expect(res.body.boards).toEqual([{ board: 'work', pages: 2, webdav: false, items: [
    { type: 'folder', id: 'f1', title: 'Projects', children: [
      { type: 'page', id: 'n-a', title: 'Alpha', lastModified: '2026-11-01T10:00:00Z' },
    ] },
    { type: 'page', id: 'n-b', title: 'Beta' },
  ] }])
})

test('TD-20 notes widget: webdav flag — enabled with an existing account or legacy inline config', async () => {
  for (const b of ['acc', 'legacy', 'gone', 'off']) {
    boards[b] = { columns: [] }
    notes[b]  = { schemaVersion: 2, items: [{ type: 'page', id: `n-${b}`, title: b }] }
  }
  webdav.acc    = { enabled: true, accountId: 'wa-1' }
  webdav.legacy = { enabled: true, url: 'https://dav.example/x/' }
  webdav.gone   = { enabled: true, accountId: 'wa-deleted' }
  webdav.off    = { enabled: false, accountId: 'wa-1' }
  const res = await request(app).get('/api/today/widgets/notes')
  expect(Object.fromEntries(res.body.boards.map(b => [b.board, b.webdav]))).toEqual({ acc: true, legacy: true, gone: false, off: false })
})

test('TD-21 stickies rhythm: 0 (on request) or 10 min … 1 day only; category filter', async () => {
  expect((await request(app).put('/api/today/config').send({ widgets: { stickies: { rhythm: 240 } } })).status).toBe(200)
  expect(store.today.widgets.stickies).toEqual({ rhythm: 240 })
  expect((await request(app).put('/api/today/config').send({ widgets: { stickies: { rhythm: 0 } } })).status).toBe(200)
  expect((await request(app).put('/api/today/config').send({ widgets: { stickies: { rhythm: 10 } } })).status).toBe(200)
  expect((await request(app).put('/api/today/config').send({ widgets: { stickies: { rhythm: 30, filter: 'quote' } } })).status).toBe(200)
  expect(store.today.widgets.stickies).toEqual({ rhythm: 30, filter: 'quote' })
  expect((await request(app).put('/api/today/config').send({ widgets: { stickies: { filter: 'all' } } })).status).toBe(200)
  expect((await request(app).put('/api/today/config').send({ widgets: { stickies: { filter: 'todo' } } })).status).toBe(400)
  for (const rhythm of [45, -1, '60']) {
    expect((await request(app).put('/api/today/config').send({ widgets: { stickies: { rhythm } } })).status).toBe(400)
  }
  expect((await request(app).put('/api/today/config').send({ widgets: { stickies: { other: 1 } } })).status).toBe(400)
})
