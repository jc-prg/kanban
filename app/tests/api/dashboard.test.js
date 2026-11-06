'use strict'
/**
 * Dashboard API tests — section DB-1 … DB-46 + DB-13..DB-20 (mail)
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
  getMailAccount:      async (id) => { const c = _storedConfig ?? _defaultConfig(); return (c.mailAccounts || []).find(a => a.id === id) || null; },
  getCalAccount:       async (id) => { const c = _storedConfig ?? _defaultConfig(); return (c.calendarAccounts || []).find(a => a.id === id) || null; },
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

// ---- Calendar range (?from&to) — used by the calendar view ----

test('DB-34 GET /api/dashboard/calendar/:id?from&to — past event in range returned, REPORT uses range', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }
  const ics = makeIcs('uid-past@ex', '20260302T090000Z', '20260302T100000Z', 'Past meeting')
  const bodies = []
  vi.stubGlobal('fetch', async (url, opts = {}) => {
    if (opts.body) bodies.push(String(opts.body))
    return { ok: true, status: 207, text: async () => calDavXml(ics) }
  })

  const res = await request(app).get('/api/dashboard/calendar/ca-1?from=2026-03-02&to=2026-03-09').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.events).toHaveLength(1)
  expect(res.body.events[0].uid).toBe('uid-past@ex')
  expect(bodies.some(b => b.includes('start="20260302T000000Z"') && b.includes('end="20260309T000000Z"'))).toBe(true)
})

test('DB-35 GET /api/dashboard/calendar/:id?from&to — events outside range excluded', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }
  const icsIn  = makeIcs('uid-in@ex',  '20260304T090000Z', '20260304T100000Z', 'Inside')
  const icsOut = makeIcs('uid-out@ex', '20260309T090000Z', '20260309T100000Z', 'Outside')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(icsIn, icsOut) }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1?from=2026-03-02&to=2026-03-09').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.events.map(e => e.uid)).toEqual(['uid-in@ex'])
})

test('DB-36 GET /api/dashboard/calendar/:id?from&to — recurring event expanded within range', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }
  // Daily series starting long before the range
  const ics = makeIcs('uid-rr@ex', '20260101T080000Z', '20260101T083000Z', 'Daily', 'RRULE:FREQ=DAILY')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(ics) }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1?from=2026-03-02&to=2026-03-09').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.events).toHaveLength(7)
  expect(res.body.events[0].start.slice(0, 10)).toBe('2026-03-02')
  expect(res.body.events.every(e => e.hasRrule)).toBe(true)
})

test('DB-37 GET /api/dashboard/calendar/:id?from&to — invalid or oversized range → 400', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount()],
  }
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml() }))

  for (const qs of ['from=2026-03-02', 'from=x&to=2026-03-09', 'from=2026-03-09&to=2026-03-02', 'from=2026-01-01&to=2026-04-01']) {
    const res = await request(app).get(`/api/dashboard/calendar/ca-1?${qs}`).set(AUTH)
    expect(res.status, qs).toBe(400)
  }
})

// ---------------------------------------------------------------------------
// Calendar ↔ card links (hidden X-JC-KANBAN-CARD property)
// ---------------------------------------------------------------------------

/** fetch mock for the link route: GET returns `ics` with an ETag, PUT answers with the next status. */
function _linkFetchMock(ics, putStatuses = [204]) {
  const calls = []
  const fn = async (url, opts = {}) => {
    const method = opts.method || 'GET'
    calls.push({ url, method, headers: opts.headers || {}, body: opts.body })
    if (method === 'GET') {
      return { ok: true, status: 200, text: async () => ics, headers: { get: h => (h.toLowerCase() === 'etag' ? '"etag-1"' : null) } }
    }
    const status = putStatuses.shift() ?? 204
    return { ok: status < 300, status, text: async () => '' }
  }
  return { fn, calls }
}

test('DB-38 GET /api/dashboard/calendar/:id/event/:uid — X-JC-KANBAN-CARD exposed as cardRefs', async () => {
  _storedConfig = { mailAccounts: [], cardSources: [], autoRefreshMs: 0, calendarAccounts: [_calAccount()] }
  const ics = makeIcs('uid-ref@ex', icalTs(TOMORROW), icalTs(TOMORROW), 'Linked',
    'X-JC-KANBAN-CARD:cards/id-abc123\r\nX-JC-KANBAN-CARD:work/id-def456\r\nX-JC-KANBAN-CARD:garbage')
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 207, text: async () => calDavXml(ics) }))

  const res = await request(app).get('/api/dashboard/calendar/ca-1/event/uid-ref@ex').set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.cardRefs).toEqual([
    { board: 'cards', cardId: 'id-abc123' },
    { board: 'work',  cardId: 'id-def456' },
  ])
})

test('DB-39 POST /api/dashboard/calendar/:id/event/:uid/cards — adds the reference, keeps other properties, uses If-Match', async () => {
  _storedConfig = { mailAccounts: [], cardSources: [], autoRefreshMs: 0, calendarAccounts: [_calAccount()] }
  const ics = makeIcs('uid-link@ex', icalTs(TOMORROW), icalTs(TOMORROW), 'Meeting',
    'LOCATION:Room 1\r\nX-OTHER-CLIENT:keep-me')
  const { fn, calls } = _linkFetchMock(ics)
  vi.stubGlobal('fetch', fn)

  const res = await request(app).post('/api/dashboard/calendar/ca-1/event/uid-link@ex/cards').set(AUTH)
    .send({ board: 'cards', cardId: 'id-abc123', href: '/cal/uid-link.ics' })
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)

  const put = calls.find(c => c.method === 'PUT')
  expect(put.url).toBe('https://dav.example.com/cal/uid-link.ics')
  expect(put.headers['If-Match']).toBe('"etag-1"')
  expect(put.body).toMatch(/X-JC-KANBAN-CARD:cards\/id-abc123/)
  expect(put.body).toMatch(/LOCATION:Room 1/)
  expect(put.body).toMatch(/X-OTHER-CLIENT:keep-me/)
  expect(put.body).toMatch(/DTSTART:/)
})

test('DB-40 POST …/cards — reference already present → unchanged, no PUT', async () => {
  _storedConfig = { mailAccounts: [], cardSources: [], autoRefreshMs: 0, calendarAccounts: [_calAccount()] }
  const ics = makeIcs('uid-dup@ex', icalTs(TOMORROW), icalTs(TOMORROW), 'Meeting', 'X-JC-KANBAN-CARD:cards/id-abc123')
  const { fn, calls } = _linkFetchMock(ics)
  vi.stubGlobal('fetch', fn)

  const res = await request(app).post('/api/dashboard/calendar/ca-1/event/uid-dup@ex/cards').set(AUTH)
    .send({ board: 'cards', cardId: 'id-abc123', href: '/cal/uid-dup.ics' })
  expect(res.status).toBe(200)
  expect(res.body.unchanged).toBe(true)
  expect(calls.some(c => c.method === 'PUT')).toBe(false)
})

test('DB-41 POST …/cards — invalid body or iCal-URL account → 400', async () => {
  _storedConfig = {
    mailAccounts: [], cardSources: [], autoRefreshMs: 0,
    calendarAccounts: [_calAccount(), _calAccount({ id: 'ca-ical', type: 'ical-url' })],
  }
  const { fn, calls } = _linkFetchMock('')
  vi.stubGlobal('fetch', fn)

  for (const body of [{ board: 'Bad Board', cardId: 'id-1' }, { board: 'cards', cardId: 'id/../x' }, { board: 'cards' }, { board: 'cards', cardId: 'id-1', extra: 1 }]) {
    const res = await request(app).post('/api/dashboard/calendar/ca-1/event/u@ex/cards').set(AUTH).send(body)
    expect(res.status, JSON.stringify(body)).toBe(400)
  }
  const res = await request(app).post('/api/dashboard/calendar/ca-ical/event/u@ex/cards').set(AUTH).send({ board: 'cards', cardId: 'id-1' })
  expect(res.status).toBe(400)
  expect(calls).toHaveLength(0)
})

test('DB-42 POST …/cards — 412 on the first PUT → re-fetches and retries once', async () => {
  _storedConfig = { mailAccounts: [], cardSources: [], autoRefreshMs: 0, calendarAccounts: [_calAccount()] }
  const ics = makeIcs('uid-race@ex', icalTs(TOMORROW), icalTs(TOMORROW), 'Meeting')
  const { fn, calls } = _linkFetchMock(ics, [412, 204])
  vi.stubGlobal('fetch', fn)

  const res = await request(app).post('/api/dashboard/calendar/ca-1/event/uid-race@ex/cards').set(AUTH)
    .send({ board: 'cards', cardId: 'id-abc123', href: '/cal/uid-race.ics' })
  expect(res.status).toBe(200)
  expect(calls.filter(c => c.method === 'GET')).toHaveLength(2)
  expect(calls.filter(c => c.method === 'PUT')).toHaveLength(2)
})

test('DB-43 PUT /api/dashboard/calendar/:id/event/:uid — rebuilt ICS keeps cardRefs (event moved)', async () => {
  _storedConfig = { mailAccounts: [], cardSources: [], autoRefreshMs: 0, calendarAccounts: [_calAccount()] }
  const { fn, calls } = _linkFetchMock('')
  vi.stubGlobal('fetch', fn)

  const res = await request(app).put('/api/dashboard/calendar/ca-1/event/uid-move@ex').set(AUTH).send({
    title: 'Moved', allDay: false, start: '2026-11-10T09:00:00Z', end: '2026-11-10T10:00:00Z',
    href: '/cal/uid-move.ics', cardRefs: [{ board: 'cards', cardId: 'id-abc123' }],
  })
  expect(res.status).toBe(200)
  const put = calls.find(c => c.method === 'PUT')
  expect(put.body).toMatch(/UID:uid-move@ex/)
  expect(put.body).toMatch(/DTSTART:20261110T090000Z/)
  expect(put.body).toMatch(/X-JC-KANBAN-CARD:cards\/id-abc123/)
})

test('DB-44 calendar helpers — series patch and occurrence override keep the card reference', () => {
  const { patchMasterIcs, buildOccurrenceOverrideIcs, parseEvents } = require('../../backend/dashboard/calendar')
  const master = makeIcs('uid-ser@ex', '20261102T090000Z', '20261102T100000Z', 'Weekly',
    'RRULE:FREQ=WEEKLY;COUNT=4\r\nX-JC-KANBAN-CARD:cards/id-abc123')

  const patched = patchMasterIcs(master, { title: 'Weekly (moved)', start: '2026-11-03T09:00:00Z', end: '2026-11-03T10:00:00Z' })
  expect(parseEvents(patched)[0].cardRefs).toEqual([{ board: 'cards', cardId: 'id-abc123' }])

  const override = buildOccurrenceOverrideIcs(master, '2026-11-09T09:00:00Z',
    { title: 'Moved once', allDay: false, start: '2026-11-09T11:00:00Z', end: '2026-11-09T12:00:00Z' })
  const occ = parseEvents(override, { windowStart: new Date('2026-11-09T00:00:00Z'), windowEnd: new Date('2026-11-10T00:00:00Z') })
  expect(occ).toHaveLength(1)
  expect(occ[0].title).toBe('Moved once')
  expect(occ[0].cardRefs).toEqual([{ board: 'cards', cardId: 'id-abc123' }])
})

test('DB-45 board schema — card.calEvent accepted, malformed calEvent rejected', () => {
  const { validateBoard } = require('../../backend/schemas')
  const board = calEvent => ({ columns: [{ id: 'c1', title: 'INBOX', cards: [{ id: 'id-1', text: 'x', calEvent }] }] })
  expect(validateBoard(board({ accountId: 'ca-1', uid: 'uid@ex' }))).toBe(true)
  expect(validateBoard(board({ accountId: 'ca-1' }))).toBe(false)
  expect(validateBoard(board({ accountId: 'ca-1', uid: 'u', title: 'extra' }))).toBe(false)
})

test('DB-46 board schema — card.mailRef accepted, malformed mailRef rejected', () => {
  const { validateBoard } = require('../../backend/schemas')
  const board = mailRef => ({ columns: [{ id: 'c1', title: 'INBOX', cards: [{ id: 'id-1', text: 'x', mailRef }] }] })
  expect(validateBoard(board({ accountId: 'ma-1', messageId: '<a@b>' }))).toBe(true)
  expect(validateBoard(board({ accountId: 'ma-1', messageId: '<a@b>', folder: 'Archive', subject: 'Hi' }))).toBe(true)
  expect(validateBoard(board({ accountId: 'ma-1' }))).toBe(false)
  expect(validateBoard(board({ accountId: 'ma-1', messageId: '<a@b>', uid: 7 }))).toBe(false)
})
