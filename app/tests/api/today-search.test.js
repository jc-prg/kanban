'use strict'
/**
 * Today search widget / Find dialog API — TS-1 … TS-13
 *
 * routes/today.js mounted on its own; db.js / global-db.js and imapflow replaced via require.cache.
 * The calendar (iCal URL) and the CV-App are served by a stubbed global fetch.
 */

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

const path    = require('path')
const express = require('express')
const request = require('supertest')

const DB_MODULE        = path.resolve(__dirname, '../../backend/db.js')
const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')

// ---- Mock CouchDB ----
const boards = {}
const notes  = {}
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
const store = { today: null, dash: {} }
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    getTodayConfig:     async () => (store.today ? JSON.parse(JSON.stringify(store.today)) : null),
    saveTodayConfig:    async data => { store.today = data; return { ok: true } },
    getDashboardConfig: async () => JSON.parse(JSON.stringify(store.dash)),
    getWebdavDb:        () => ({ get: async () => { throw new Error('not_found') } }),
    getWebdavAccounts:  async () => [],
  },
}

// ---- Mock IMAP: folder path → [{ uid, subject, from, to, body, date }] ----
const mailbox = {}
const imapLog = []   // { folder, query }
class MockImapFlow {
  constructor() { this.current = null }
  async connect() {}
  async logout() {}
  async list() {
    return [
      ...Object.keys(mailbox).map(p => ({ path: p, name: p, flags: new Set() })),
      { path: '[Gmail]', name: '[Gmail]', flags: new Set(['\\Noselect']) },
    ]
  }
  async getMailboxLock(p) { this.current = p; return { release() {} } }
  async search(query) {
    imapLog.push({ folder: this.current, query })
    const has = (s, w) => String(s || '').toLowerCase().includes(w.toLowerCase())
    return (mailbox[this.current] || []).filter(m => query.or.some(k =>
      (k.subject && has(m.subject, k.subject)) || (k.from && has(m.from, k.from)) ||
      (k.to && has(m.to, k.to)) || (k.cc && false) || (k.body && has(m.body, k.body)))).map(m => m.uid)
  }
  async *fetch(range) {
    const uids = String(range).split(',').map(Number)
    for (const m of mailbox[this.current] || []) {
      if (!uids.includes(m.uid)) continue
      yield { uid: m.uid, flags: new Set(), size: 10, bodyStructure: { type: 'text/plain' },
        envelope: { subject: m.subject, from: [{ address: m.from }], to: [{ address: m.to }], date: new Date(m.date), messageId: `<${m.uid}@x>` } }
    }
  }
}
const IMAPFLOW_MODULE = require.resolve('imapflow')
require.cache[IMAPFLOW_MODULE] = {
  id: IMAPFLOW_MODULE, filename: IMAPFLOW_MODULE, loaded: true, children: [], paths: [],
  exports: { ImapFlow: MockImapFlow },
}

const app = express()
app.use(express.json())
app.use('/api', require('../../backend/routes/today'))
const search = require('../../backend/today/search')
const { _clearCache: clearCvApp } = require('../../backend/today/cvapp')

const get = (type, q, extra = '') => request(app).get(`/api/today/search/${type}?q=${encodeURIComponent(q)}${extra}`)

beforeEach(() => {
  store.today = null
  store.dash = {}
  for (const o of [boards, notes, mailbox]) for (const k of Object.keys(o)) delete o[k]
  imapLog.length = 0
  clearCvApp()
  search._clearCalCache()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

test('TS-1 matching: all words, case- and accent-insensitive', () => {
  expect(search.queryWords('  Café  cafe MÜNCHEN ')).toEqual(['cafe', 'munchen'])
  expect(search.matchesAll(['Team-Café in München', ''], ['cafe', 'munchen'])).toBe(true)
  expect(search.matchesAll(['Team-Café', 'Berlin'], ['cafe', 'munchen'])).toBe(false)
})

test('TS-2 cards: title mode = text + column; description only in full text; archived boards and # headers skipped', async () => {
  boards.jobs = { columns: [
    { id: 'c1', title: 'INBOX', cards: [
      { id: 'id-1', text: 'Backend Dev | ACME | Köln', description: 'kubernetes heavy' },
      { id: 'id-2', text: '# ACME section' },
    ] },
    { id: 'c2', title: 'APPLIED', cards: [{ id: 'id-3', text: 'Frontend | Other', description: 'mentions acme' }] },
  ] }
  boards.old = { settings: { archived: true }, columns: [{ id: 'c', title: 'X', cards: [{ id: 'id-9', text: 'ACME archived' }] }] }

  const title = await get('cards', 'acme koln')
  expect(title.status).toBe(200)
  expect(title.body.items.map(i => i.card.id)).toEqual(['id-1'])
  expect(title.body.items[0]).toMatchObject({ board: 'jobs', column: 'INBOX', card: { description: true } })

  expect((await get('cards', 'acme')).body.items.map(i => i.card.id)).toEqual(['id-1'])
  expect((await get('cards', 'acme', '&full=1')).body.items.map(i => i.card.id).sort()).toEqual(['id-1', 'id-3'])
  expect((await get('cards', 'applied')).body.items.map(i => i.card.id)).toEqual(['id-3'])   // column title
  expect((await get('cards', 'kubernetes')).body.total).toBe(0)
  expect((await get('cards', 'kubernetes', '&full=1')).body.total).toBe(1)
})

test('TS-3 notes: title + folder path; body only in full text', async () => {
  boards.b = { columns: [] }
  notes.b = { schemaVersion: 2, items: [
    { type: 'folder', id: 'f1', title: 'Projekte', children: [
      { type: 'page', id: 'n-1', title: 'Kickoff', description: 'Agenda mit Budget', lastModified: '2026-11-01T10:00:00Z' },
    ] },
    { type: 'page', id: 'n-2', title: 'Budget 2027' },
  ] }
  const folder = await get('notes', 'projekte kickoff')
  expect(folder.body.items).toEqual([{ board: 'b', id: 'n-1', title: 'Kickoff', path: ['Projekte'], lastModified: '2026-11-01T10:00:00Z' }])
  expect((await get('notes', 'budget')).body.items.map(i => i.id)).toEqual(['n-2'])
  expect((await get('notes', 'budget', '&full=1')).body.items.map(i => i.id).sort()).toEqual(['n-1', 'n-2'])
})

test('TS-4 pickOccurrences: next upcoming occurrence per UID, else the latest past one', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  const evs = [
    { uid: 'a', start: '2026-11-04T09:00:00Z', end: '2026-11-04T10:00:00Z' },
    { uid: 'a', start: '2026-11-25T09:00:00Z', end: '2026-11-25T10:00:00Z' },
    { uid: 'a', start: '2026-11-18T09:00:00Z', end: '2026-11-18T10:00:00Z' },
    { uid: 'b', start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z' },
    { uid: 'b', start: '2026-10-08T09:00:00Z', end: '2026-10-08T10:00:00Z' },
  ]
  const picked = search.pickOccurrences(evs, now)
  expect(picked.find(e => e.uid === 'a').start).toBe('2026-11-18T09:00:00Z')
  expect(picked.find(e => e.uid === 'b').start).toBe('2026-10-08T09:00:00Z')
})

test('TS-5 events: title + location, description in full text; account tags; window ±1 year', async () => {
  const day = d => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '')
  const ev = (uid, d, summary, location, description) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${day(d)}T090000Z\r\nDTEND:${day(d)}T100000Z\r\nSUMMARY:${summary}\r\nLOCATION:${location}\r\nDESCRIPTION:${description}\r\nEND:VEVENT\r\n`
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n${ev('u1', 3, 'Interview ACME', 'Köln', 'bring portfolio')}${ev('u2', -30, 'Lunch', 'ACME Kantine', '')}${ev('u3', 5, 'Sync', 'Online', 'ACME roadmap')}${ev('u4', 500, 'ACME far future', '', '')}END:VCALENDAR\r\n`
  vi.stubGlobal('fetch', vi.fn(async () => new Response(ics, { status: 200 })))
  store.dash = { calendarAccounts: [{ id: 'ca-1', type: 'ical-url', url: 'https://cal.example/x.ics', label: 'Work', color: '#f00', webInterfaceUrl: 'https://cal.example' }] }

  const title = await get('events', 'acme')
  expect(title.status).toBe(200)
  expect(title.body.items.map(e => e.uid)).toEqual(['u1', 'u2'])   // upcoming first, then past; u4 outside the window
  expect(title.body.items[0]).toMatchObject({ accountId: 'ca-1', label: 'Work', color: '#f00', webUrl: 'https://cal.example', location: 'Köln' })
  expect((await get('events', 'acme', '&full=1')).body.items.map(e => e.uid)).toEqual(['u1', 'u3', 'u2'])
  expect((await get('events', 'portfolio')).body.total).toBe(0)
})

test('TS-6 mail: every selectable folder searched, body only in full text, folder on each hit', async () => {
  store.dash = { mailAccounts: [{ id: 'ma-1', host: 'imap.x', user: 'u', password: 'p', folder: 'INBOX' }] }
  mailbox.INBOX   = [{ uid: 1, subject: 'Offer from ACME', from: 'hr@acme.com', to: 'me@x', body: '', date: '2026-11-10T10:00:00Z' }]
  mailbox.Archive = [{ uid: 7, subject: 'Hello', from: 'bob@y', to: 'me@x', body: 'talked to ACME', date: '2026-11-09T10:00:00Z' }]

  const title = await get('mail', 'acme', '&account=ma-1')
  expect(title.status).toBe(200)
  expect(title.body.items.map(m => [m.id, m.folder])).toEqual([['1', 'INBOX']])
  expect(imapLog.map(l => l.folder)).toEqual(['INBOX', 'Archive'])   // account folder first, [Gmail] (\Noselect) skipped
  expect(imapLog[0].query.or.some(k => 'body' in k)).toBe(false)

  imapLog.length = 0
  const full = await get('mail', 'acme', '&account=ma-1&full=1')
  expect(full.body.items.map(m => [m.id, m.folder])).toEqual([['1', 'INBOX'], ['7', 'Archive']])
  expect(imapLog[0].query.or.some(k => k.body === 'acme')).toBe(true)
})

test('TS-7 mail title mode: IMAP searches the longest word, the summary must contain all words', async () => {
  store.dash = { mailAccounts: [{ id: 'ma-1', host: 'imap.x', user: 'u', password: 'p' }] }
  mailbox.INBOX = [
    { uid: 1, subject: 'Invoice November', from: 'billing@acme.com', to: 'me@x', date: '2026-11-10T10:00:00Z' },
    { uid: 2, subject: 'Invoice October', from: 'billing@other.com', to: 'me@x', date: '2026-10-10T10:00:00Z' },
  ]
  const res = await get('mail', 'acme invoice', '&account=ma-1')
  expect(imapLog[0].query.or[0]).toEqual({ subject: 'invoice' })
  expect(res.body.items.map(m => m.id)).toEqual(['1'])
})

test('TS-8 applications: job title + company; all text fields and drafts in full text; deep link', async () => {
  store.today = { widgets: { cvapp: { apiUrl: 'http://cv:8000', apiKey: 'k', publicUrl: 'https://host/cv/' } } }
  const apps = [
    { id: 'a1', title: 'Data Engineer', company: 'ACME', location: 'Berlin', status: 'Versendet', updated_at: '2026-11-02' },
    { id: 'a2', title: 'Architect', company: 'Other', location: 'Berlin', notes: 'referral via ACME', updated_at: '2026-11-03' },
    { id: 'a3', title: 'Lead', company: 'Third', drafts: [{ label: 'v1', content: 'Dear ACME team' }], updated_at: '2026-11-01' },
  ]
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(apps), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  const title = await get('applications', 'acme')
  expect(title.body.items.map(a => a.id)).toEqual(['a1'])
  expect(title.body.items[0]).toMatchObject({ title: 'Data Engineer', company: 'ACME', status: 'Versendet', url: 'https://host/cv/#/applications?id=a1' })
  expect((await get('applications', 'berlin')).body.total).toBe(0)   // location only in full text
  expect((await get('applications', 'acme', '&full=1')).body.items.map(a => a.id)).toEqual(['a2', 'a1', 'a3'])
  expect(fetchMock).toHaveBeenCalledTimes(1)   // raw list cached
})

test('TS-9 GET /today/search lists the available sources', async () => {
  expect((await request(app).get('/api/today/search')).body).toEqual({ types: ['cards', 'notes'], mailAccounts: [], calendarAccounts: [] })
  store.dash = { calendarAccounts: [{ id: 'ca-1', label: 'Team', password: 'calsecret' }], mailAccounts: [{ id: 'ma-1', label: 'Work', color: '#0f0', password: 'secret' }] }
  store.today = { widgets: { cvapp: { apiUrl: 'http://cv:8000' } } }
  const res = await request(app).get('/api/today/search')
  expect(res.body.types).toEqual(['cards', 'notes', 'events', 'mail', 'applications'])
  expect(res.body.mailAccounts).toEqual([{ id: 'ma-1', label: 'Work', color: '#0f0', webInterfaceUrl: null }])
  expect(res.body.calendarAccounts).toEqual([{ id: 'ca-1', label: 'Team', color: null }])
  expect(JSON.stringify(res.body)).not.toContain('secret')
})

test('TS-10 validation: short / long query 400, unknown type / mail account 404, CV-App not configured 400', async () => {
  expect((await get('cards', 'a')).status).toBe(400)
  expect((await get('cards', 'ab')).status).toBe(400)   // at least 3 characters
  expect((await get('cards', 'x'.repeat(201))).status).toBe(400)
  expect((await get('photos', 'abc')).status).toBe(404)
  expect((await get('mail', 'abc', '&account=nope')).status).toBe(404)
  expect((await get('applications', 'abc')).status).toBe(400)
})

test('TS-11 date range / folder validation: YYYY-MM-DD, from ≤ to, events at most 3 years', async () => {
  store.dash = { calendarAccounts: [{ id: 'ca-1', type: 'ical-url', url: 'https://cal.example/x.ics' }] }
  vi.stubGlobal('fetch', vi.fn(async () => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 })))
  expect((await get('events', 'abc', '&from=2026-13-01')).status).toBe(400)
  expect((await get('events', 'abc', '&from=11.11.2026')).status).toBe(400)
  expect((await get('events', 'abc', '&from=2026-11-12&to=2026-11-11')).status).toBe(400)
  expect((await get('events', 'abc', '&from=2020-01-01&to=2026-01-01')).status).toBe(400)
  expect((await get('events', 'abc', '&from=2026-11-01&to=2026-11-30')).status).toBe(200)
  expect((await get('mail', 'abc', '&account=ma-1&folder=a%0Ab')).status).toBe(400)
  // One open end never fails: it is kept within the 3-year window
  const now = Date.parse('2026-11-12T10:00:00Z')
  const r = search.eventRange({ from: '2015-01-01' }, now)
  expect(r.rangeStart.toISOString()).toBe('2015-01-01T00:00:00.000Z')
  expect((r.rangeEnd - r.rangeStart) / 86_400_000).toBe(3 * 366)
  const t = search.eventRange({ to: '2026-12-31' }, now)
  expect(t.rangeEnd.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  expect(t.rangeStart.toISOString()).toBe('2025-11-12T00:00:00.000Z')   // today − 365 days
})

test('TS-12 events with a date range: every occurrence inside it, earliest first; outside the default window too', async () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n'
    + 'BEGIN:VEVENT\r\nUID:w1\r\nDTSTAMP:20200101T000000Z\r\nDTSTART:20200106T090000Z\r\nDTEND:20200106T100000Z\r\nRRULE:FREQ=WEEKLY;COUNT=10\r\nSUMMARY:ACME weekly\r\nEND:VEVENT\r\n'
    + 'BEGIN:VEVENT\r\nUID:o1\r\nDTSTAMP:20200101T000000Z\r\nDTSTART:20200115T090000Z\r\nDTEND:20200115T100000Z\r\nSUMMARY:ACME review\r\nEND:VEVENT\r\n'
    + 'END:VCALENDAR\r\n'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(ics, { status: 200 })))
  store.dash = { calendarAccounts: [{ id: 'ca-1', type: 'ical-url', url: 'https://cal.example/x.ics', label: 'Work' }] }
  expect((await get('events', 'acme')).body.total).toBe(0)   // 2020 lies outside today ± 1 year
  expect((await get('events', 'acme', '&account=nope')).status).toBe(404)
  expect((await get('events', 'acme', '&account=ca-1&from=2020-01-10&to=2020-01-12')).body.total).toBe(0)
  const res = await get('events', 'acme', '&from=2020-01-10&to=2020-01-27')
  expect(res.status).toBe(200)
  expect(res.body.items.map(e => [e.uid, e.start.slice(0, 10)])).toEqual([
    ['w1', '2020-01-13'], ['o1', '2020-01-15'], ['w1', '2020-01-20'], ['w1', '2020-01-27'],
  ])
})

test('TS-13 mail with a folder and a date range: only that folder, SENTSINCE / SENTBEFORE (to inclusive)', async () => {
  store.dash = { mailAccounts: [{ id: 'ma-1', host: 'imap.x', user: 'u', password: 'p', folder: 'INBOX' }] }
  mailbox.INBOX   = [{ uid: 1, subject: 'ACME one', from: 'a@x', to: 'me@x', date: '2026-11-10T10:00:00Z' }]
  mailbox.Archive = [{ uid: 7, subject: 'ACME two', from: 'b@y', to: 'me@x', date: '2026-10-09T10:00:00Z' }]
  const res = await get('mail', 'acme', '&account=ma-1&folder=Archive&from=2026-10-01&to=2026-10-31')
  expect(res.status).toBe(200)
  expect(res.body.items.map(m => [m.id, m.folder])).toEqual([['7', 'Archive']])
  expect(imapLog.map(l => l.folder)).toEqual(['Archive'])
  expect(imapLog[0].query.sentSince.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  expect(imapLog[0].query.sentBefore.toISOString()).toBe('2026-11-01T00:00:00.000Z')
  imapLog.length = 0
  await get('mail', 'acme', '&account=ma-1')
  expect(imapLog.map(l => l.folder)).toEqual(['INBOX', 'Archive'])
  expect('sentSince' in imapLog[0].query).toBe(false)
})
