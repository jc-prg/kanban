'use strict'
/**
 * Dashboard API tests — section DB-1 … DB-29 + DB-13..DB-20 (mail)
 *
 * global-db is injected into require.cache before createApp loads any routes.
 * The db mock's mockCouch.use() returns a per-name board document so card-source
 * tests can seed real board state.
 */

process.env.APP_PASSWORD   = 'test-password'
process.env.API_KEY        = 'test-api-key-that-is-32chars-long!'
process.env.SESSION_SECRET = 'test-session-secret-32-chars-ok!'

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})

const path    = require('path')
const request = require('supertest')

// ---- global-db mock ----
let _storedConfig = null

function _defaultConfig() {
  return { mailAccounts: [], cardSources: [], calendarAccounts: [], autoRefreshMs: 0 }
}

const globalDbMock = {
  getDashboardConfig:  async () => JSON.parse(JSON.stringify(_storedConfig ?? _defaultConfig())),
  saveDashboardConfig: async (data) => { _storedConfig = JSON.parse(JSON.stringify(data)) },
  initGlobalDb:        async () => {},
  getGlobalDb:         () => ({}),
}

const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true,
  exports: globalDbMock, children: [], paths: [],
}

// ---- imapflow mock (for mail routes) ----
let _imapMessages   = []   // messages yielded by client.fetch()
let _imapConnectErr = null // error thrown by client.connect(), or null

class MockImapFlow {
  constructor() {}
  async connect() { if (_imapConnectErr) throw _imapConnectErr }
  get mailbox()   { return { exists: _imapMessages.length } }
  async getMailboxLock() { return { release: () => {} } }
  async * fetch()  { for (const m of _imapMessages) yield m }
  async fetchOne(uid) {
    return _imapMessages.find(m => String(m.uid) === String(uid)) ?? null
  }
  async logout() {}
}

const IMAPFLOW_MODULE = require.resolve('imapflow')
require.cache[IMAPFLOW_MODULE] = {
  id: IMAPFLOW_MODULE, filename: IMAPFLOW_MODULE, loaded: true,
  exports: { ImapFlow: MockImapFlow },
  children: [], paths: [],
}

// ---- db mock (for /dashboard/cards) ----
const boardDocs = new Map()   // dbName → board document

const mockCouch = {
  use: (dbName) => ({
    get: async (id) => {
      if (id !== 'board') throw Object.assign(new Error('not found'), { statusCode: 404 })
      const doc = boardDocs.get(dbName)
      if (!doc) throw Object.assign(new Error('not found'), { statusCode: 404 })
      return doc
    },
    insert: async () => ({ ok: true }),
  }),
}

const dbMock = {
  getCouch: () => mockCouch,
  validBoardName: (name) =>
    typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64 && name !== 'inbox',
  getBoardDb:    async () => ({}),
  loadBoardData: async () => ({ columns: [] }),
  saveBoardData: async () => ({ ok: true }),
  withBoard:         (h) => async (req, res) => { try { await h(req, res, {}) } catch (e) { res.status(500).json({ error: e.message }) } },
  withExistingBoard: (h) => async (req, res) => { try { await h(req, res, {}) } catch (e) { res.status(500).json({ error: e.message }) } },
  initDb: async () => {},
}

const { createApp } = require('../setup/createApp')
const app  = createApp(dbMock)
const AUTH = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }

beforeEach(() => {
  _storedConfig    = null
  boardDocs.clear()
  _imapMessages    = []
  _imapConnectErr  = null
})

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

test('DB-1 GET /api/dashboard/config — no config saved → default empty config', async () => {
  const res = await request(app).get('/api/dashboard/config').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({
    mailAccounts:     [],
    cardSources:      [],
    calendarAccounts: [],
    autoRefreshMs:    0,
  })
})

test('DB-2 PUT then GET /api/dashboard/config — values persisted', async () => {
  const cfg = {
    mailAccounts:     [{ id: 'ma-1', label: 'work', host: 'imap.ex.com', port: 993, tls: true, user: 'u', password: 'p', folder: 'INBOX', maxMessages: 20 }],
    cardSources:      [{ id: 'cs-1', board: 'jobs', columns: ['Inbox'] }],
    calendarAccounts: [],
    autoRefreshMs:    300000,
  }
  const put = await request(app).put('/api/dashboard/config').set(AUTH).send(cfg)
  expect(put.status).toBe(200)
  expect(put.body.ok).toBe(true)

  const get = await request(app).get('/api/dashboard/config').set(AUTH)
  expect(get.status).toBe(200)
  expect(get.body.cardSources).toEqual(cfg.cardSources)
  expect(get.body.autoRefreshMs).toBe(300000)
})

test('DB-3 GET /api/dashboard/config — passwords stripped; hasPassword added', async () => {
  _storedConfig = {
    mailAccounts:     [{ id: 'ma-1', label: 'work', password: 'secret' }],
    cardSources:      [],
    calendarAccounts: [{ id: 'ca-1', label: 'cal', password: 'calpass' }],
    autoRefreshMs:    0,
  }
  const res = await request(app).get('/api/dashboard/config').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.mailAccounts[0].password).toBeUndefined()
  expect(res.body.mailAccounts[0].hasPassword).toBe(true)
  expect(res.body.calendarAccounts[0].password).toBeUndefined()
  expect(res.body.calendarAccounts[0].hasPassword).toBe(true)
})

test('DB-4 PUT mail account without password field → stored password preserved', async () => {
  _storedConfig = {
    mailAccounts:     [{ id: 'ma-1', label: 'work', password: 'original' }],
    cardSources:      [],
    calendarAccounts: [],
    autoRefreshMs:    0,
  }
  await request(app).put('/api/dashboard/config').set(AUTH).send({
    mailAccounts:     [{ id: 'ma-1', label: 'updated' }],   // no password field
    cardSources:      [],
    calendarAccounts: [],
    autoRefreshMs:    0,
  })
  expect(_storedConfig.mailAccounts[0].password).toBe('original')
  expect(_storedConfig.mailAccounts[0].label).toBe('updated')
})

test('DB-5 PUT calendar account with empty password → stored password preserved', async () => {
  _storedConfig = {
    mailAccounts:     [],
    cardSources:      [],
    calendarAccounts: [{ id: 'ca-1', label: 'cal', password: 'calpass' }],
    autoRefreshMs:    0,
  }
  await request(app).put('/api/dashboard/config').set(AUTH).send({
    mailAccounts:     [],
    cardSources:      [],
    calendarAccounts: [{ id: 'ca-1', label: 'cal', password: '' }],
    autoRefreshMs:    0,
  })
  expect(_storedConfig.calendarAccounts[0].password).toBe('calpass')
})

test('DB-6 GET /api/dashboard/config — unauthenticated → 401', async () => {
  const res = await request(app).get('/api/dashboard/config')
  expect(res.status).toBe(401)
})

test('DB-7 webInterfaceUrl on mail account — saved and returned in GET', async () => {
  const cfg = {
    mailAccounts:     [{ id: 'ma-1', label: 'work', webInterfaceUrl: 'https://mail.ex.com' }],
    cardSources:      [],
    calendarAccounts: [],
    autoRefreshMs:    0,
  }
  await request(app).put('/api/dashboard/config').set(AUTH).send(cfg)
  const res = await request(app).get('/api/dashboard/config').set(AUTH)
  expect(res.body.mailAccounts[0].webInterfaceUrl).toBe('https://mail.ex.com')
})

test('DB-8 webInterfaceUrl on calendar account — saved and returned in GET', async () => {
  const cfg = {
    mailAccounts:     [],
    cardSources:      [],
    calendarAccounts: [{ id: 'ca-1', label: 'work', webInterfaceUrl: 'https://cal.ex.com' }],
    autoRefreshMs:    0,
  }
  await request(app).put('/api/dashboard/config').set(AUTH).send(cfg)
  const res = await request(app).get('/api/dashboard/config').set(AUTH)
  expect(res.body.calendarAccounts[0].webInterfaceUrl).toBe('https://cal.ex.com')
})

// ---------------------------------------------------------------------------
// Card sources
// ---------------------------------------------------------------------------

test('DB-9 GET /api/dashboard/cards — cards from configured board/column returned', async () => {
  _storedConfig = {
    mailAccounts: [], calendarAccounts: [], autoRefreshMs: 0,
    cardSources: [{ id: 'cs-1', board: 'jobs', columns: ['Inbox'] }],
  }
  boardDocs.set('jc-kanban-jobs', {
    _id: 'board', _rev: '1-abc',
    columns: [
      { id: 'c1', title: 'Inbox', cards: [{ id: 'id-aaa', text: 'Card A', priority: 1 }] },
      { id: 'c2', title: 'Done',  cards: [{ id: 'id-bbb', text: 'Card B' }] },
    ],
  })

  const res = await request(app).get('/api/dashboard/cards').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toHaveLength(1)
  expect(res.body[0].column).toBe('Inbox')
  expect(res.body[0].cards).toHaveLength(1)
  expect(res.body[0].cards[0].text).toBe('Card A')
})

test('DB-10 GET /api/dashboard/cards — column filter applied; unlisted column excluded', async () => {
  _storedConfig = {
    mailAccounts: [], calendarAccounts: [], autoRefreshMs: 0,
    cardSources: [{ id: 'cs-1', board: 'jobs', columns: ['Inbox'] }],
  }
  boardDocs.set('jc-kanban-jobs', {
    _id: 'board', _rev: '1-abc',
    columns: [
      { id: 'c1', title: 'Inbox', cards: [{ id: 'id-aaa', text: 'Wanted' }] },
      { id: 'c2', title: 'Done',  cards: [{ id: 'id-bbb', text: 'Not wanted' }] },
    ],
  })

  const res = await request(app).get('/api/dashboard/cards').set(AUTH)
  expect(res.body.every(g => g.column === 'Inbox')).toBe(true)
  expect(res.body.flatMap(g => g.cards).map(c => c.text)).not.toContain('Not wanted')
})

test('DB-11 GET /api/dashboard/cards — columns: [] means all columns included', async () => {
  _storedConfig = {
    mailAccounts: [], calendarAccounts: [], autoRefreshMs: 0,
    cardSources: [{ id: 'cs-1', board: 'jobs', columns: [] }],
  }
  boardDocs.set('jc-kanban-jobs', {
    _id: 'board', _rev: '1-abc',
    columns: [
      { id: 'c1', title: 'Inbox', cards: [{ id: 'id-aaa', text: 'A' }] },
      { id: 'c2', title: 'Done',  cards: [{ id: 'id-bbb', text: 'B' }] },
    ],
  })

  const res = await request(app).get('/api/dashboard/cards').set(AUTH)
  const columnTitles = res.body.map(g => g.column)
  expect(columnTitles).toContain('Inbox')
  expect(columnTitles).toContain('Done')
})

test('DB-12 GET /api/dashboard/cards — missing board returns error field, no 500', async () => {
  _storedConfig = {
    mailAccounts: [], calendarAccounts: [], autoRefreshMs: 0,
    cardSources: [{ id: 'cs-1', board: 'missing', columns: [] }],
  }
  // boardDocs has nothing for jc-kanban-missing

  const res = await request(app).get('/api/dashboard/cards').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toHaveLength(1)
  expect(res.body[0].error).toBeTruthy()
  expect(res.body[0].cards).toEqual([])
})

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

// Build a minimal ICS string for a single VEVENT
function makeIcs(uid, dtstart, dtend, summary, extras = '') {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${summary}`,
    extras,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')
}

// Wrap an ICS block inside a CalDAV multistatus XML response
function calDavXml(...icsBlocks) {
  const responses = icsBlocks.map(ics =>
    `<response><propstat><prop><C:calendar-data>${ics}</C:calendar-data></prop></propstat></response>`
  ).join('')
  return `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</multistatus>`
}

// Format a JS Date as iCal UTC timestamp (YYYYMMDDTHHmmssZ)
function icalTs(d) {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
}

// Reference date: today
const TODAY     = new Date()
const TOMORROW  = new Date(TODAY.getTime() + 86_400_000)
const IN5DAYS   = new Date(TODAY.getTime() + 5 * 86_400_000)
const IN8DAYS   = new Date(TODAY.getTime() + 8 * 86_400_000)
const YESTERDAY = new Date(TODAY.getTime() - 86_400_000)

function _calAccount(overrides = {}) {
  return {
    id: 'ca-1', label: 'Work', type: 'caldav',
    url: 'https://dav.example.com/cal/', user: 'alice', password: 'pw',
    lookaheadDays: 7,
    ...overrides,
  }
}

afterEach(() => { vi.unstubAllGlobals() })

test('DB-21 GET /api/dashboard/calendar/:id — CalDAV returns events within lookahead', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }

  const ics1 = makeIcs('uid1@ex', icalTs(TOMORROW), icalTs(IN5DAYS), 'Team Standup')
  const ics2 = makeIcs('uid2@ex', icalTs(IN5DAYS),  icalTs(IN5DAYS),  'Review')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(ics1, ics2) }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.events).toHaveLength(2)
  expect(res.body.error).toBeNull()
  expect(res.body.events[0].uid).toBe('uid1@ex')
  expect(res.body.events[0].title).toBe('Team Standup')
})

test('DB-22 GET /api/dashboard/calendar/:id — event beyond lookaheadDays excluded', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],   // lookaheadDays: 7
  }

  const icsIn  = makeIcs('uid-in@ex',  icalTs(TOMORROW), icalTs(TOMORROW), 'Inside window')
  const icsOut = makeIcs('uid-out@ex', icalTs(IN8DAYS),  icalTs(IN8DAYS),  'Outside window')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(icsIn, icsOut) }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.events).toHaveLength(1)
  expect(res.body.events[0].uid).toBe('uid-in@ex')
})

test('DB-23 GET /api/dashboard/calendar/:id — multi-day event overlapping boundary included', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }

  // Starts yesterday, ends in 3 days → overlaps the window
  const ics = makeIcs('uid-multi@ex', icalTs(YESTERDAY), icalTs(IN5DAYS), 'Conference')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(ics) }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.events).toHaveLength(1)
  expect(res.body.events[0].uid).toBe('uid-multi@ex')
})

test('DB-24 GET /api/dashboard/calendar/:id — CalDAV returns 401 → error field, no 500', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }

  vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => '' }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.events).toEqual([])
  expect(res.body.error).toMatch(/401/)
})

test('DB-25 GET /api/dashboard/calendar/:id/event/:uid — full event fields returned', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }

  const ics = makeIcs('uid-full@ex', icalTs(TOMORROW), icalTs(TOMORROW), 'Doctor',
    'LOCATION:Room 42\r\nDESCRIPTION:Annual checkup\r\nSTATUS:CONFIRMED')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(ics) }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1/event/uid-full@ex').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.uid).toBe('uid-full@ex')
  expect(res.body.title).toBe('Doctor')
  expect(res.body.location).toBe('Room 42')
  expect(res.body.description).toBe('Annual checkup')
  expect(res.body.status).toBe('CONFIRMED')
})

test('DB-26 GET /api/dashboard/calendar/:id/event/:uid — uid not found → 404', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }

  const ics = makeIcs('uid-other@ex', icalTs(TOMORROW), icalTs(TOMORROW), 'Other')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(ics) }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1/event/uid-notexist@ex').set(AUTH)
  expect(res.status).toBe(404)
})

test('DB-27 POST /api/dashboard/calendar/:id/test — 207 → { ok: true }', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }

  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => '' }))

  const res = await request(app).post('/api/dashboard/calendar/ca-1/test').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
})

test('DB-28 POST /api/dashboard/calendar/:id/test — 401 → { ok: false, error: … }', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }

  vi.stubGlobal('fetch', async () => ({ ok: false, status: 401 }))

  const res = await request(app).post('/api/dashboard/calendar/ca-1/test').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(false)
  expect(res.body.error).toMatch(/401/)
})

test('DB-29 POST /api/dashboard/calendar/:id/test — timeout → { ok: false, error: … }', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }

  vi.stubGlobal('fetch', async (_url, opts) => {
    // Simulate abort by rejecting with AbortError
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    throw err
  })

  const res = await request(app).post('/api/dashboard/calendar/ca-1/test').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(false)
  expect(res.body.error).toMatch(/timed out/i)
})

test('DB-27b GET /api/dashboard/calendar/:id — unknown accountId → 404', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [],
  }

  const res = await request(app).get('/api/dashboard/calendar/nope').set(AUTH)
  expect(res.status).toBe(404)
})

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

function _mailAccount(overrides = {}) {
  return {
    id: 'ma-1', label: 'work@example.com',
    host: 'imap.ex.com', port: 993, tls: true,
    user: 'alice', password: 'pw', folder: 'INBOX', maxMessages: 20,
    ...overrides,
  }
}

function _mockMsg(uid, subject, from = 'Jane <jane@ex.com>', preview = 'Hello there') {
  return {
    uid,
    envelope: {
      subject,
      from: [{ name: 'Jane Doe', address: 'jane@ex.com' }],
      to:   [{ name: 'Me', address: 'me@ex.com' }],
      cc:   [],
      date: new Date('2026-07-01T10:23:00Z'),
    },
    bodyParts: new Map([['text', Buffer.from(preview)]]),
  }
}

test('DB-13 GET /api/dashboard/mail/:id — IMAP returns 3 messages', async () => {
  _storedConfig = {
    cardSources: [], calendarAccounts: [], autoRefreshMs: 0,
    mailAccounts: [_mailAccount()],
  }
  _imapMessages = [_mockMsg(3, 'Third'), _mockMsg(2, 'Second'), _mockMsg(1, 'First')]

  const res = await request(app).get('/api/dashboard/mail/ma-1').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.messages).toHaveLength(3)
  expect(res.body.error).toBeNull()
  expect(res.body.messages[0]).toMatchObject({ id: expect.any(String), subject: expect.any(String), from: expect.any(String) })
})

test('DB-14 GET /api/dashboard/mail/:id — IMAP throws connection error → error field, no 500', async () => {
  _storedConfig = {
    cardSources: [], calendarAccounts: [], autoRefreshMs: 0,
    mailAccounts: [_mailAccount()],
  }
  _imapConnectErr = new Error('Connection refused')

  const res = await request(app).get('/api/dashboard/mail/ma-1').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.messages).toEqual([])
  expect(res.body.error).toBeTruthy()
})

test('DB-15 GET /api/dashboard/mail/:id/message/:uid — full message fields returned', async () => {
  _storedConfig = {
    cardSources: [], calendarAccounts: [], autoRefreshMs: 0,
    mailAccounts: [_mailAccount()],
  }
  _imapMessages = [_mockMsg(42, 'Meeting prep', 'Jane', 'Just a quick reminder')]

  const res = await request(app).get('/api/dashboard/mail/ma-1/message/42').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.subject).toBe('Meeting prep')
  expect(res.body.from).toBeTruthy()
  expect(res.body.to).toBeTruthy()
  expect(res.body.date).toBeTruthy()
  expect(typeof res.body.body).toBe('string')
  expect(Array.isArray(res.body.attachments)).toBe(true)
})

test('DB-16 GET /api/dashboard/mail/:id/message/:uid — uid not found → 404', async () => {
  _storedConfig = {
    cardSources: [], calendarAccounts: [], autoRefreshMs: 0,
    mailAccounts: [_mailAccount()],
  }
  _imapMessages = [_mockMsg(1, 'Other')]

  const res = await request(app).get('/api/dashboard/mail/ma-1/message/999').set(AUTH)
  expect(res.status).toBe(404)
})

test('DB-17 GET /api/dashboard/mail/:id — unknown accountId → 404', async () => {
  _storedConfig = {
    cardSources: [], calendarAccounts: [], autoRefreshMs: 0,
    mailAccounts: [],
  }

  const res = await request(app).get('/api/dashboard/mail/nope').set(AUTH)
  expect(res.status).toBe(404)
})

test('DB-18 POST /api/dashboard/mail/:id/test — handshake succeeds → { ok: true }', async () => {
  _storedConfig = {
    cardSources: [], calendarAccounts: [], autoRefreshMs: 0,
    mailAccounts: [_mailAccount()],
  }
  // _imapConnectErr = null → connect() resolves normally

  const res = await request(app).post('/api/dashboard/mail/ma-1/test').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
})

test('DB-19 POST /api/dashboard/mail/:id/test — auth error → { ok: false, error: "Authentication failed" }', async () => {
  _storedConfig = {
    cardSources: [], calendarAccounts: [], autoRefreshMs: 0,
    mailAccounts: [_mailAccount()],
  }
  const err = new Error('Login failed')
  err.authenticationFailed = true
  _imapConnectErr = err

  const res = await request(app).post('/api/dashboard/mail/ma-1/test').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(false)
  expect(res.body.error).toBe('Authentication failed')
})

test('DB-20 POST /api/dashboard/mail/:id/test — timeout → { ok: false, error: "Connection timed out (10 s)" }', async () => {
  _storedConfig = {
    cardSources: [], calendarAccounts: [], autoRefreshMs: 0,
    mailAccounts: [_mailAccount()],
  }
  const err = new Error('Connection timed out')
  err.code = 'ETIMEDOUT'
  _imapConnectErr = err

  const res = await request(app).post('/api/dashboard/mail/ma-1/test').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(false)
  expect(res.body.error).toBe('Connection timed out (10 s)')
})

// ---------------------------------------------------------------------------
// Combined data endpoint
// ---------------------------------------------------------------------------

test('DB-30 GET /api/dashboard/data — all sources configured and mocked successfully', async () => {
  _storedConfig = {
    autoRefreshMs:    0,
    mailAccounts:     [_mailAccount()],
    cardSources:      [{ id: 'cs-1', board: 'jobs', columns: ['Inbox'] }],
    calendarAccounts: [_calAccount()],
  }
  _imapMessages = [_mockMsg(1, 'Newsletter')]
  boardDocs.set('jc-kanban-jobs', {
    columns: [{ id: 'c1', title: 'Inbox', cards: [{ id: 'id-abc', text: 'Apply at Acme' }] }],
  })
  const ics = makeIcs('uid-d30@ex', icalTs(TOMORROW), icalTs(TOMORROW), 'Standup')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(ics) }))

  const res = await request(app).get('/api/dashboard/data').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.fetchedAt).toBeTruthy()
  expect(res.body.mail).toHaveLength(1)
  expect(res.body.mail[0].messages).toHaveLength(1)
  expect(res.body.mail[0].error).toBeNull()
  expect(res.body.cards).toHaveLength(1)
  expect(res.body.cards[0].cards).toHaveLength(1)
  expect(res.body.cards[0].error).toBeNull()
  expect(res.body.calendar).toHaveLength(1)
  expect(res.body.calendar[0].events).toHaveLength(1)
  expect(res.body.calendar[0].error).toBeNull()
})

test('DB-31 GET /api/dashboard/data — one IMAP account unreachable → error field, other sources normal', async () => {
  _storedConfig = {
    autoRefreshMs:    0,
    mailAccounts:     [_mailAccount()],
    cardSources:      [{ id: 'cs-1', board: 'jobs', columns: ['Inbox'] }],
    calendarAccounts: [_calAccount()],
  }
  _imapConnectErr = new Error('Connection refused')
  boardDocs.set('jc-kanban-jobs', {
    columns: [{ id: 'c1', title: 'Inbox', cards: [{ id: 'id-abc', text: 'Apply' }] }],
  })
  const ics = makeIcs('uid-d31@ex', icalTs(TOMORROW), icalTs(TOMORROW), 'Meeting')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(ics) }))

  const res = await request(app).get('/api/dashboard/data').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.mail[0].error).toBeTruthy()
  expect(res.body.mail[0].messages).toHaveLength(0)
  expect(res.body.cards[0].cards).toHaveLength(1)
  expect(res.body.cards[0].error).toBeNull()
  expect(res.body.calendar[0].events).toHaveLength(1)
  expect(res.body.calendar[0].error).toBeNull()
})

test('DB-32 GET /api/dashboard/data — all sources fail → 200 with all error fields set', async () => {
  _storedConfig = {
    autoRefreshMs:    0,
    mailAccounts:     [_mailAccount()],
    cardSources:      [{ id: 'cs-1', board: 'missing', columns: [] }],
    calendarAccounts: [_calAccount()],
  }
  _imapConnectErr = new Error('Connection refused')
  // boardDocs has no entry for 'missing'
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }))

  const res = await request(app).get('/api/dashboard/data').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.mail[0].error).toBeTruthy()
  expect(res.body.cards[0].error).toBeTruthy()
  expect(res.body.calendar[0].error).toBeTruthy()
})

test('DB-33 GET /api/dashboard/data — unauthenticated → 401', async () => {
  const res = await request(app).get('/api/dashboard/data')
  expect(res.status).toBe(401)
})
