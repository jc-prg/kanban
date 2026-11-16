'use strict'
/**
 * Mail view API tests — MVA-1 … MVA-48 (+ MVA-32b)
 *
 * Folder management, paged/searchable message lists, ?folder= on message routes,
 * trash handling and sending via SMTP (nodemailer mocked) with a sent copy.
 * imapflow is replaced by a recording mock; global-db by an in-memory config.
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
let _mailLinks = {}
let _trusted = []
let _hidden = {}
const _cfg = () => _storedConfig ?? { mailAccounts: [], cardSources: [], calendarAccounts: [], autoRefreshMs: 0 }
const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    getDashboardConfig:  async () => JSON.parse(JSON.stringify(_cfg())),
    saveDashboardConfig: async (data) => { _storedConfig = JSON.parse(JSON.stringify(data)) },
    getMailAccount:      async (id) => (_cfg().mailAccounts || []).find(a => a.id === id) || null,
    getCalAccount:       async () => null,
    getRecentFolders:    async () => ({}),
    addRecentFolder:     async () => {},
    getMailCardLinks:    async (acc) => _mailLinks[acc] || {},
    addMailCardLink:     async (acc, mid, board, cardId) => {
      const list = ((_mailLinks[acc] ||= {})[mid] ||= [])
      if (list.some(r => r.board === board && r.cardId === cardId)) return false
      list.push({ board, cardId }); return true
    },
    getTrustedSenders:   async () => [..._trusted],
    setTrustedSender:    async (addr, on) => { _trusted = _trusted.filter(a => a !== addr); if (on) _trusted.push(addr); return [..._trusted] },
    getHiddenFolders:    async () => JSON.parse(JSON.stringify(_hidden)),
    setHiddenFolders:    async (acc, paths) => { if (paths.length) _hidden[acc] = paths; else delete _hidden[acc]; return JSON.parse(JSON.stringify(_hidden)) },
    initGlobalDb:        async () => {},
    getGlobalDb:         () => ({}),
  },
}

// ---- imapflow mock (records every call) ----
let imap
function _resetImap() {
  imap = {
    calls:    [],      // [method, ...args]
    messages: [],      // in sequence order (seq = index + 1)
    folders:  [],      // raw LIST entries
    search:   [],      // UIDs returned by search()
    searchByFolder: null,   // { [folder]: [uids] } — overrides `search` per locked folder
    byFolder: null,    // { [folder]: [messages] } — overrides `messages` per locked folder
    locked:   null,
  }
}
const _lockedMsgs = () => imap.byFolder ? (imap.byFolder[imap.locked] || []) : imap.messages

class MockImapFlow {
  constructor(opts) { this.opts = opts }
  async connect() {}
  async logout() {}
  get mailbox() { return { exists: _lockedMsgs().length, uidValidity: imap.uidValidity, uidNext: imap.uidNext } }
  async getMailboxLock(folder, opts) { imap.calls.push(['lock', folder, opts]); imap.locked = folder; return { release: () => {} } }
  async list(opts) { imap.calls.push(['list', opts]); return imap.folders }
  async search(query, opts) {
    imap.calls.push(['search', query, opts])
    return imap.searchByFolder ? (imap.searchByFolder[imap.locked] || []) : imap.search
  }
  async * fetch(range, query, opts) {
    imap.calls.push(['fetch', range, opts])
    if (opts?.uid) {
      const uids = new Set(String(range).split(',').map(Number))
      for (const m of _lockedMsgs()) if (uids.has(m.uid)) yield m
    } else {
      const [a, b] = String(range).split(':').map(x => x === '*' ? _lockedMsgs().length : Number(x))
      for (const m of _lockedMsgs().slice(a - 1, b)) yield m
    }
  }
  async fetchOne(uid) { return imap.messages.find(m => String(m.uid) === String(uid)) ?? null }
  async mailboxCreate(p)       { imap.calls.push(['create', p]) }
  async mailboxDelete(p)       { imap.calls.push(['delete', p]) }
  async mailboxRename(a, b)    { imap.calls.push(['rename', a, b]) }
  async messageFlagsAdd(u, f)    { imap.calls.push(['flagsAdd', u, f]) }
  async messageFlagsRemove(u, f) { imap.calls.push(['flagsRemove', u, f]) }
  async messageMove(u, target)   { imap.calls.push(['move', u, target]) }
  async messageDelete(u)         { imap.calls.push(['expunge', u]) }
  async append(folder, raw, flags) { imap.calls.push(['append', folder, raw.toString('utf8'), flags]); return imap.appendUid ? { uid: imap.appendUid } : undefined }
}
const IMAPFLOW_MODULE = require.resolve('imapflow')
require.cache[IMAPFLOW_MODULE] = {
  id: IMAPFLOW_MODULE, filename: IMAPFLOW_MODULE, loaded: true, children: [], paths: [],
  exports: { ImapFlow: MockImapFlow },
}

// ---- nodemailer mock (MailComposer / addressparser stay real) ----
let smtp
const NODEMAILER_MODULE = require.resolve('nodemailer')
require.cache[NODEMAILER_MODULE] = {
  id: NODEMAILER_MODULE, filename: NODEMAILER_MODULE, loaded: true, children: [], paths: [],
  exports: {
    createTransport: (opts) => {
      smtp.transport = opts
      return { sendMail: async (mail) => { smtp.sent.push({ ...mail, raw: mail.raw.toString('utf8') }); return { messageId: 'x' } } }
    },
  },
}

const { createApp } = require('../setup/createApp')
const dbMock = {
  getCouch: () => ({ use: () => ({ get: async () => { throw Object.assign(new Error('nf'), { statusCode: 404 }) } }) }),
  validBoardName: () => true,
  withBoard: (h) => h, withExistingBoard: (h) => h, initDb: async () => {},
}
const app  = createApp(dbMock)
const AUTH = { 'x-api-key': 'test-api-key-that-is-32chars-long!' }
const API  = '/api/dashboard/mail/ma-1'

function _account(overrides = {}) {
  return {
    id: 'ma-1', label: 'work', host: 'imap.ex.com', port: 993, tls: true,
    user: 'me@ex.com', password: 'imap-pw', folder: 'INBOX', ...overrides,
  }
}

function _msg(uid, extra = {}) {
  return {
    uid,
    envelope: {
      subject: `Subject ${uid}`, from: [{ name: 'Jane', address: 'jane@ex.com' }], to: [{ address: 'me@ex.com' }],
      date: new Date('2026-11-01T10:00:00Z'), ...extra.envelope,
    },
    flags: new Set(extra.flags || []),
    bodyStructure: { type: 'text/plain', encoding: '7bit' },
    bodyParts: new Map([['1', Buffer.from('Body text')]]),
    headers: extra.headers,
    size: 1234,
  }
}

const calls = (name) => imap.calls.filter(c => c[0] === name)

beforeEach(() => {
  _storedConfig = { mailAccounts: [_account()], cardSources: [], calendarAccounts: [], autoRefreshMs: 0 }
  _resetImap()
  _mailLinks = {}
  smtp = { transport: null, sent: [] }
})

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

test('MVA-1 GET folders?status=1 — LIST-STATUS requested; fields mapped', async () => {
  imap.folders = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set(), specialUse: '\\Inbox', status: { messages: 10, unseen: 3 } },
    { path: 'Archive', name: 'Archive', delimiter: '/', flags: new Set(['\\Noselect']), status: { messages: 0, unseen: 0 } },
  ]
  const res = await request(app).get(`${API}/folders?status=1`).set(AUTH)
  expect(res.status).toBe(200)
  expect(calls('list')[0][1]).toEqual({ statusQuery: { messages: true, unseen: true } })
  expect(res.body.folders).toEqual([
    { path: 'Archive', name: 'Archive', delimiter: '/', parent: '', specialUse: null, noselect: true, messages: 0, unseen: 0 },
    { path: 'INBOX', name: 'INBOX', delimiter: '/', parent: '', specialUse: '\\Inbox', noselect: false, messages: 10, unseen: 3 },
  ])
})

test('MVA-2 POST folders — creates folder; invalid path → 400', async () => {
  const ok = await request(app).post(`${API}/folders`).set(AUTH).send({ path: 'Projects/2026' })
  expect(ok.status).toBe(200)
  expect(calls('create')).toEqual([['create', 'Projects/2026']])

  for (const body of [{}, { path: '' }, { path: 'bad\u0001name' }, { path: 'x'.repeat(256) }]) {
    const res = await request(app).post(`${API}/folders`).set(AUTH).send(body)
    expect(res.status).toBe(400)
  }
  expect(calls('create')).toHaveLength(1)
})

test('MVA-3 DELETE folders?path= — deletes folder; INBOX protected', async () => {
  const ok = await request(app).delete(`${API}/folders?path=${encodeURIComponent('Old/Stuff')}`).set(AUTH)
  expect(ok.status).toBe(200)
  expect(calls('delete')).toEqual([['delete', 'Old/Stuff']])

  const inbox = await request(app).delete(`${API}/folders?path=inbox`).set(AUTH)
  expect(inbox.status).toBe(400)
  const none = await request(app).delete(`${API}/folders`).set(AUTH)
  expect(none.status).toBe(400)
})

test('MVA-4 POST folders/rename — rename/move; INBOX protected', async () => {
  const ok = await request(app).post(`${API}/folders/rename`).set(AUTH).send({ from: 'Receipts', to: 'Archive/Receipts' })
  expect(ok.status).toBe(200)
  expect(calls('rename')).toEqual([['rename', 'Receipts', 'Archive/Receipts']])

  const inbox = await request(app).post(`${API}/folders/rename`).set(AUTH).send({ from: 'INBOX', to: 'X' })
  expect(inbox.status).toBe(400)
  const bad = await request(app).post(`${API}/folders/rename`).set(AUTH).send({ from: 'A' })
  expect(bad.status).toBe(400)
})

test('MVA-5 folder routes — unknown account → 404', async () => {
  const res = await request(app).post('/api/dashboard/mail/nope/folders').set(AUTH).send({ path: 'X' })
  expect(res.status).toBe(404)
})

// ---------------------------------------------------------------------------
// Message list
// ---------------------------------------------------------------------------

test('MVA-6 GET messages — date order of the whole folder, then one page by UID', async () => {
  imap.messages = Array.from({ length: 120 }, (_, i) => _msg(i + 1, i === 119 ? { flags: ['\\Seen', '\\Answered'] } : {}))

  const p0 = await request(app).get(`${API}/messages?folder=Archive`).set(AUTH)
  expect(p0.status).toBe(200)
  expect(calls('lock')[0][1]).toBe('Archive')
  expect(calls('fetch')[0][1]).toBe('1:*')   // date scan (same date everywhere → higher UID first)
  expect(calls('fetch')[1][1]).toBe(Array.from({ length: 50 }, (_, i) => 120 - i).join(','))
  expect(calls('fetch')[1][2]).toEqual({ uid: true })
  expect(p0.body).toMatchObject({ total: 120, page: 0, pageSize: 50 })
  expect(p0.body.messages).toHaveLength(50)
  expect(p0.body.messages[0]).toMatchObject({ id: '120', unread: false, answered: true, subject: 'Subject 120', to: 'me@ex.com' })
  expect(p0.body.messages[1].unread).toBe(true)

  _resetImap()
  imap.messages = Array.from({ length: 120 }, (_, i) => _msg(i + 1))
  const p2 = await request(app).get(`${API}/messages?page=2`).set(AUTH)
  expect(calls('fetch')[1][1]).toBe(Array.from({ length: 20 }, (_, i) => 20 - i).join(','))
  expect(calls('lock')[0][1]).toBe('INBOX')
  expect(p2.body.messages).toHaveLength(20)

  _resetImap()
  const empty = await request(app).get(`${API}/messages?page=5`).set(AUTH)
  expect(empty.body).toMatchObject({ messages: [], total: 0 })
  expect(calls('fetch')).toHaveLength(0)
})

test('MVA-7 GET messages?q= — server-side search, hits in date order, total = hits', async () => {
  imap.messages = [_msg(5), _msg(9), _msg(12)]
  imap.search   = [5, 12, 9]
  const res = await request(app).get(`${API}/messages?q=${encodeURIComponent('invoice')}`).set(AUTH)
  expect(res.status).toBe(200)
  const [, query, opts] = calls('search')[0]
  expect(query).toEqual({ or: [{ subject: 'invoice' }, { from: 'invoice' }, { to: 'invoice' }, { body: 'invoice' }] })
  expect(opts).toEqual({ uid: true })
  expect(calls('fetch')[1][1]).toBe('12,9,5')
  expect(calls('fetch')[1][2]).toEqual({ uid: true })
  expect(res.body.total).toBe(3)
  expect(res.body.messages.map(m => m.id)).toEqual(['12', '9', '5'])
})

test('MVA-8 ?folder= validation — control characters / bad uid → 400', async () => {
  const badFolder = await request(app).get(`${API}/messages?folder=${encodeURIComponent('a\u0000b')}`).set(AUTH)
  expect(badFolder.status).toBe(400)
  const badUid = await request(app).get(`${API}/message/12abc`).set(AUTH)
  expect(badUid.status).toBe(400)
  expect(imap.calls).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Message routes with ?folder=
// ---------------------------------------------------------------------------

test('MVA-9 GET message?folder= — threading headers and reply-to returned', async () => {
  imap.messages = [_msg(42, {
    envelope: { messageId: '<m42@ex.com>', inReplyTo: '<m41@ex.com>', replyTo: [{ name: 'List', address: 'list@ex.com' }] },
    headers: Buffer.from('References: <a@ex.com>\r\n <b@ex.com>\r\n\r\n'),
  })]
  const res = await request(app).get(`${API}/message/42?folder=Projects`).set(AUTH)
  expect(res.status).toBe(200)
  expect(calls('lock')[0][1]).toBe('Projects')
  expect(res.body).toMatchObject({
    messageId: '<m42@ex.com>', inReplyTo: '<m41@ex.com>', replyTo: 'List <list@ex.com>',
    references: ['<a@ex.com>', '<b@ex.com>'], unread: true,
  })
})

test('MVA-31 address lists — display names with specials are quoted, so "Doe, Jane" stays one address', async () => {
  imap.messages = [_msg(43, { envelope: {
    from: [{ name: 'Doe, Jane', address: 'jane@ex.com' }],
    to:   [{ name: 'Say "Hi"', address: 'hi@ex.com' }, { name: 'Bob', address: 'bob@ex.com' }, { address: 'x@ex.com' }],
  } })]
  const res = await request(app).get(`${API}/message/43`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.from).toBe('"Doe, Jane" <jane@ex.com>')
  expect(res.body.to).toBe('"Say \\"Hi\\"" <hi@ex.com>, Bob <bob@ex.com>, x@ex.com')
})

test('MVA-42 GET message — attachments carry the Content-ID; inline images without a file name get one', async () => {
  const m = _msg(44)
  m.bodyStructure = {
    type: 'multipart/related',
    childNodes: [
      { part: '1', type: 'text/html', encoding: '7bit' },
      { part: '2', type: 'image/png', encoding: 'base64', size: 8, id: '<img1@ex.com>', disposition: 'inline', dispositionParameters: { filename: 'PastedGraphic-1.png' } },
      { part: '3', type: 'image/svg+xml', encoding: 'base64', size: 8, id: '<logo@ex.com>' },
      { part: '4', type: 'application/pdf', encoding: 'base64', size: 8, dispositionParameters: { filename: 'report.pdf' } },
    ],
  }
  m.bodyParts = new Map([['1', Buffer.from('<p>Hi</p>')]])
  imap.messages = [m]
  const res = await request(app).get(`${API}/message/44`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.attachments).toEqual([
    { part: '2', name: 'PastedGraphic-1.png', type: 'image/png', size: 6, cid: 'img1@ex.com' },
    { part: '3', name: 'image-3.svg', type: 'image/svg+xml', size: 6, cid: 'logo@ex.com' },
    { part: '4', name: 'report.pdf', type: 'application/pdf', size: 6 },
  ])
})

test('MVA-10 PATCH / move with ?folder= — operate in that folder; default stays account folder', async () => {
  await request(app).patch(`${API}/message/7?folder=Projects`).set(AUTH).send({ seen: true })
  expect(calls('lock').at(-1)[1]).toBe('Projects')
  expect(calls('flagsAdd')[0]).toEqual(['flagsAdd', '7', ['\\Seen']])

  await request(app).post(`${API}/message/7/move?folder=Projects`).set(AUTH).send({ folder: 'Archive' })
  expect(calls('lock').at(-1)[1]).toBe('Projects')
  expect(calls('move')[0]).toEqual(['move', '7', 'Archive'])

  await request(app).patch(`${API}/message/7`).set(AUTH).send({ seen: false })
  expect(calls('lock').at(-1)[1]).toBe('INBOX')
})

test('MVA-11 DELETE — moves to the \\Trash folder; inside trash → permanent delete', async () => {
  imap.folders = [{ path: 'Deleted Items', specialUse: '\\Trash', flags: new Set() }]
  const moved = await request(app).delete(`${API}/message/3`).set(AUTH)
  expect(moved.body).toEqual({ ok: true, permanent: false })
  expect(calls('move')[0]).toEqual(['move', '3', 'Deleted Items'])

  const gone = await request(app).delete(`${API}/message/3?folder=${encodeURIComponent('Deleted Items')}`).set(AUTH)
  expect(gone.body).toEqual({ ok: true, permanent: true })
  expect(calls('expunge')).toEqual([['expunge', '3']])

  // Configured trashFolder wins over auto-detection
  _storedConfig.mailAccounts[0].trashFolder = 'Papierkorb'
  await request(app).delete(`${API}/message/4`).set(AUTH)
  expect(calls('move').at(-1)).toEqual(['move', '4', 'Papierkorb'])
})

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function _send(payload, files = []) {
  let req = request(app).post(`${API}/send`).set(AUTH).field('payload', JSON.stringify(payload))
  for (const f of files) req = req.attach('files', Buffer.from(f.content), f.name)
  return req
}

test('MVA-12 send — validation and missing SMTP configuration', async () => {
  const noSmtp = await _send({ to: 'bob@ex.com', subject: 'Hi', text: 'x' })
  expect(noSmtp.status).toBe(400)
  expect(noSmtp.body.error).toMatch(/SMTP/)

  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com' }
  expect((await request(app).post(`${API}/send`).set(AUTH).field('x', '1')).status).toBe(400)   // no payload
  expect((await _send({ subject: 'no recipient' })).status).toBe(400)
  expect((await _send({ to: 'bob@ex.com', evil: true })).status).toBe(400)
  expect((await _send({ to: 'not an address' })).status).toBe(400)
  expect(smtp.sent).toHaveLength(0)
})

test('MVA-13 send — SMTP falls back to IMAP credentials; sent copy keeps Bcc; reply flagged', async () => {
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com', port: 465, secure: 'auto', fromName: 'Me Myself' }
  imap.folders = [{ path: 'Gesendet', specialUse: '\\Sent', flags: new Set() }]

  const res = await _send({
    to: 'Bob <bob@ex.com>', cc: 'carol@ex.com', bcc: 'dave@ex.com', subject: 'Re: Plan',
    html: '<p>Hello <b>Bob</b></p>', text: 'Hello Bob',
    inReplyTo: '<m1@ex.com>', references: ['<m0@ex.com>', '<m1@ex.com>'],
    replyUid: '77', replyFolder: 'INBOX',
  }, [{ name: 'notes.txt', content: 'attached text' }])

  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
  expect(res.body.warning).toBeUndefined()
  expect(smtp.transport).toMatchObject({ host: 'smtp.ex.com', port: 465, secure: true, auth: { user: 'me@ex.com', pass: 'imap-pw' } })

  const sent = smtp.sent[0]
  expect(sent.envelope).toEqual({ from: 'me@ex.com', to: ['bob@ex.com', 'carol@ex.com', 'dave@ex.com'] })
  expect(sent.raw).toMatch(/^From: Me Myself <me@ex\.com>/m)
  expect(sent.raw).toMatch(/^In-Reply-To: <m1@ex\.com>/m)
  expect(sent.raw).toMatch(/^References: <m0@ex\.com> <m1@ex\.com>/m)
  expect(sent.raw).toContain('filename=notes.txt')
  expect(sent.raw).not.toMatch(/^Bcc:/m)

  const [, folder, copy, flags] = calls('append')[0]
  expect(folder).toBe('Gesendet')
  expect(flags).toEqual(['\\Seen'])
  expect(copy).toMatch(/^Bcc: dave@ex\.com/m)
  expect(copy.match(/^Message-ID: (.*)$/m)[1]).toBe(sent.raw.match(/^Message-ID: (.*)$/m)[1])

  expect(calls('flagsAdd')[0]).toEqual(['flagsAdd', '77', ['\\Answered']])
})

test('MVA-28 send — several sender addresses: chosen `from` used for header, envelope and Message-ID; default = first', async () => {
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com', fromName: 'Me', fromAddress: 'info@shop.de, Support Team <help@other.de>' }

  expect((await _send({ to: 'bob@ex.com', subject: 'a', text: 'x', from: 'HELP@other.de' })).status).toBe(200)
  let sent = smtp.sent.at(-1)
  expect(sent.envelope.from).toBe('help@other.de')
  expect(sent.raw).toMatch(/^From: Support Team <help@other\.de>/m)
  expect(sent.raw).toMatch(/^Message-ID: <[^@]+@other\.de>/m)

  expect((await _send({ to: 'bob@ex.com', subject: 'b', text: 'x' })).status).toBe(200)
  sent = smtp.sent.at(-1)
  expect(sent.envelope.from).toBe('info@shop.de')
  expect(sent.raw).toMatch(/^From: Me <info@shop\.de>/m)
})

test('MVA-29 send — `from` not configured for the account → 400, nothing sent', async () => {
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com', fromAddress: 'info@shop.de, help@other.de' }
  const res = await _send({ to: 'bob@ex.com', subject: 'a', text: 'x', from: 'ceo@bank.com' })
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/Sender address not configured/)
  // Without fromAddress only the IMAP user may send
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com' }
  expect((await _send({ to: 'bob@ex.com', text: 'x', from: 'info@shop.de' })).status).toBe(400)
  expect((await _send({ to: 'bob@ex.com', text: 'x', from: 'me@ex.com' })).status).toBe(200)
  expect(smtp.sent).toHaveLength(1)
})

test('MVA-30 trusted senders — GET / PUT, lower-cased, idempotent, validated', async () => {
  _trusted = []
  const url = '/api/dashboard/mail-trusted-senders'
  expect((await request(app).get(url).set(AUTH)).body).toEqual({ senders: [] })
  const put = await request(app).put(url).set(AUTH).send({ address: ' News@Shop.com ', trusted: true })
  expect(put.status).toBe(200)
  expect(put.body).toEqual({ ok: true, senders: ['news@shop.com'] })
  await request(app).put(url).set(AUTH).send({ address: 'news@shop.com', trusted: true })
  expect((await request(app).get(url).set(AUTH)).body.senders).toEqual(['news@shop.com'])
  expect((await request(app).put(url).set(AUTH).send({ address: 'news@shop.com', trusted: false })).body.senders).toEqual([])
  for (const body of [{ address: 'nope', trusted: true }, { address: 'a@b.c', trusted: 'yes' }, { address: 'x'.repeat(320) + '@b.c', trusted: true }, {}]) {
    expect((await request(app).put(url).set(AUTH).send(body)).status).toBe(400)
  }
})

test('MVA-14 config — SMTP password never returned and preserved on PUT', async () => {
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com', user: 'smtp-user', password: 'smtp-secret' }
  const get = await request(app).get('/api/dashboard/config').set(AUTH)
  expect(get.body.mailAccounts[0].smtp).toEqual({ host: 'smtp.ex.com', user: 'smtp-user', hasPassword: true })
  expect(JSON.stringify(get.body)).not.toContain('smtp-secret')

  // Round-trip of the GET body (no passwords) keeps both stored passwords
  const put = await request(app).put('/api/dashboard/config').set(AUTH).send(get.body)
  expect(put.status).toBe(200)
  expect(_storedConfig.mailAccounts[0].password).toBe('imap-pw')
  expect(_storedConfig.mailAccounts[0].smtp).toEqual({ host: 'smtp.ex.com', user: 'smtp-user', password: 'smtp-secret' })

  // A new SMTP password replaces the stored one
  const acc = { ...get.body.mailAccounts[0], smtp: { host: 'smtp.ex.com', password: 'new-secret' } }
  await request(app).put('/api/dashboard/config').set(AUTH).send({ ...get.body, mailAccounts: [acc] })
  expect(_storedConfig.mailAccounts[0].smtp.password).toBe('new-secret')
})

function _msgWithAttachment(uid) {
  const m = _msg(uid)
  m.bodyStructure = {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', encoding: '7bit' },
      { part: '2', type: 'application/pdf', encoding: 'base64', size: 8, dispositionParameters: { filename: 'report.pdf' } },
    ],
  }
  m.bodyParts = new Map([['1', Buffer.from('Body')], ['2', Buffer.from(Buffer.from('PDFDATA').toString('base64'))]])
  return m
}

test('MVA-15 send forward — original attachments fetched server-side; original flagged $Forwarded', async () => {
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com' }
  imap.messages = [_msgWithAttachment(31)]

  const res = await _send({
    to: 'bob@ex.com', subject: 'Fwd: Report', html: '<p>FYI</p>', text: 'FYI',
    forwardUid: '31', forwardFolder: 'Projects', forwardParts: ['2'],
  }, [{ name: 'extra.txt', content: 'own file' }])
  expect(res.status).toBe(200)
  const raw = smtp.sent[0].raw
  expect(raw).toContain('filename=report.pdf')
  expect(raw).toContain(Buffer.from('PDFDATA').toString('base64'))
  expect(raw).toContain('filename=extra.txt')
  expect(calls('lock')[0][1]).toBe('Projects')
  expect(calls('flagsAdd').at(-1)).toEqual(['flagsAdd', '31', ['$Forwarded']])
})

test('MVA-16 send forward — validation, missing part, other source account (no flag)', async () => {
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com' }
  imap.messages = [_msgWithAttachment(31)]

  // Parts without uid / folder
  expect((await _send({ to: 'bob@ex.com', forwardParts: ['2'] })).status).toBe(400)
  // Invalid part id
  expect((await _send({ to: 'bob@ex.com', forwardUid: '31', forwardFolder: 'INBOX', forwardParts: ['../x'] })).status).toBe(400)
  // Part not in the message
  const missing = await _send({ to: 'bob@ex.com', forwardUid: '31', forwardFolder: 'INBOX', forwardParts: ['7'] })
  expect(missing.status).toBe(404)
  // Unknown source account
  const noAcc = await _send({ to: 'bob@ex.com', forwardAccount: 'nope', forwardUid: '31', forwardFolder: 'INBOX', forwardParts: ['2'] })
  expect(noAcc.status).toBe(404)
  expect(smtp.sent).toHaveLength(0)

  // Forward from a second account: attachment fetched there, original not flagged
  _storedConfig.mailAccounts.push(_account({ id: 'ma-2', user: 'other@ex.com' }))
  const ok = await _send({ to: 'bob@ex.com', forwardAccount: 'ma-2', forwardUid: '31', forwardFolder: 'INBOX', forwardParts: ['2'] })
  expect(ok.status).toBe(200)
  expect(smtp.sent[0].raw).toContain('filename=report.pdf')
  expect(calls('flagsAdd').filter(c => c[2].includes('$Forwarded'))).toHaveLength(0)
})

test('MVA-17 POST folders/empty — trash / spam folders emptied permanently', async () => {
  imap.folders = [
    { path: 'Deleted Items', name: 'Deleted Items', flags: new Set() },
    { path: 'Junk', name: 'Junk', specialUse: '\\Junk', flags: new Set() },
    { path: 'Junk-E-Mail', name: 'Junk-E-Mail', flags: new Set() },
    { path: 'INBOX/Gelöschte Elemente', name: 'Gelöschte Elemente', flags: new Set() },
  ]
  imap.messages = [_msg(1), _msg(2), _msg(3)]
  for (const path of ['Deleted Items', 'Junk', 'Junk-E-Mail', 'INBOX/Gelöschte Elemente']) {
    const res = await request(app).post(`${API}/folders/empty`).set(AUTH).send({ path })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, deleted: 3 })
    expect(calls('lock').at(-1)[1]).toBe(path)
    expect(calls('expunge').at(-1)).toEqual(['expunge', '1:*'])
  }

  // Empty folder → nothing to delete
  imap.messages = []
  const empty = await request(app).post(`${API}/folders/empty`).set(AUTH).send({ path: 'Junk' })
  expect(empty.body).toEqual({ ok: true, deleted: 0 })
  expect(calls('expunge')).toHaveLength(4)
})

test('MVA-18 POST folders/empty — other folders refused, unknown → 404, configured trashFolder allowed', async () => {
  imap.folders = [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', flags: new Set() },
    { path: 'Archive/Trash notes', name: 'Trash notes', flags: new Set() },
    { path: 'Ablage', name: 'Ablage', flags: new Set() },
  ]
  imap.messages = [_msg(1)]
  expect((await request(app).post(`${API}/folders/empty`).set(AUTH).send({ path: 'INBOX' })).status).toBe(400)
  expect((await request(app).post(`${API}/folders/empty`).set(AUTH).send({ path: 'Archive/Trash notes' })).status).toBe(400)
  expect((await request(app).post(`${API}/folders/empty`).set(AUTH).send({ path: 'Nope' })).status).toBe(404)
  expect((await request(app).post(`${API}/folders/empty`).set(AUTH).send({})).status).toBe(400)
  expect(calls('expunge')).toHaveLength(0)

  _storedConfig.mailAccounts[0].trashFolder = 'Ablage'
  const ok = await request(app).post(`${API}/folders/empty`).set(AUTH).send({ path: 'Ablage' })
  expect(ok.status).toBe(200)
  expect(calls('expunge')).toEqual([['expunge', '1:*']])
})

test('MVA-19 bulk — UID sets accepted for PATCH / move / DELETE; single GET and oversized sets refused', async () => {
  await request(app).patch(`${API}/message/3,7,9?folder=Projects`).set(AUTH).send({ seen: true }).expect(200)
  expect(calls('flagsAdd')[0]).toEqual(['flagsAdd', '3,7,9', ['\\Seen']])

  await request(app).post(`${API}/message/3,7/move`).set(AUTH).send({ folder: 'Archive' }).expect(200)
  expect(calls('move')[0]).toEqual(['move', '3,7', 'Archive'])

  imap.folders = [{ path: 'Trash', specialUse: '\\Trash', flags: new Set() }]
  const del = await request(app).delete(`${API}/message/4,5`).set(AUTH)
  expect(del.body).toEqual({ ok: true, permanent: false })
  expect(calls('move').at(-1)).toEqual(['move', '4,5', 'Trash'])

  expect((await request(app).get(`${API}/message/3,7`).set(AUTH)).status).toBe(400)
  expect((await request(app).patch(`${API}/message/3,,7`).set(AUTH).send({ seen: true })).status).toBe(400)
  const tooMany = Array.from({ length: 501 }, (_, i) => i + 1).join(',')
  expect((await request(app).delete(`${API}/message/${tooMany}`).set(AUTH)).status).toBe(400)
})

test('MVA-20 GET folder-size — sums RFC822.SIZE of all messages in the folder', async () => {
  imap.messages = [_msg(1), _msg(2), _msg(3)]   // 1234 bytes each
  const res = await request(app).get(`${API}/folder-size?folder=Archive`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ size: 3702, messages: 3 })
  expect(calls('lock')[0][1]).toBe('Archive')
  expect(calls('fetch')[0][1]).toBe('1:*')

  _resetImap()
  const empty = await request(app).get(`${API}/folder-size`).set(AUTH)
  expect(empty.body).toEqual({ size: 0, messages: 0 })
  expect(calls('lock')[0][1]).toBe('INBOX')
  expect(calls('fetch')).toHaveLength(0)
})

test('MVA-21 POST folders/mark-read — whole folder flagged \\Seen; empty folder untouched', async () => {
  imap.messages = [_msg(1), _msg(2)]
  const res = await request(app).post(`${API}/folders/mark-read`).set(AUTH).send({ path: 'INBOX/Projects' })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true, messages: 2 })
  expect(calls('lock')[0][1]).toBe('INBOX/Projects')
  expect(calls('flagsAdd')).toEqual([['flagsAdd', '1:*', ['\\Seen']]])

  _resetImap()
  const empty = await request(app).post(`${API}/folders/mark-read`).set(AUTH).send({ path: 'Archive' })
  expect(empty.body).toEqual({ ok: true, messages: 0 })
  expect(calls('flagsAdd')).toHaveLength(0)

  expect((await request(app).post(`${API}/folders/mark-read`).set(AUTH).send({})).status).toBe(400)
  expect((await request(app).post('/api/dashboard/mail/nope/folders/mark-read').set(AUTH).send({ path: 'INBOX' })).status).toBe(404)
})

// ---------------------------------------------------------------------------
// Mail ↔ card links (keyed by Message-ID)
// ---------------------------------------------------------------------------

test('MVA-22 POST message/:uid/cards — link stored under the Message-ID; listing and message carry cardRefs', async () => {
  imap.messages = [_msg(7, { envelope: { messageId: '<abc@ex.com>' } }), _msg(8, { envelope: { messageId: '<other@ex.com>' } })]

  const res = await request(app).post(`${API}/message/7/cards?folder=Projects`).set(AUTH).send({ board: 'cards', cardId: 'id-abc123' })
  expect(res.status).toBe(200)
  expect(res.body.messageId).toBe('<abc@ex.com>')
  expect(_mailLinks['ma-1']).toEqual({ '<abc@ex.com>': [{ board: 'cards', cardId: 'id-abc123' }] })
  expect(calls('lock')[0][1]).toBe('Projects')

  const again = await request(app).post(`${API}/message/7/cards`).set(AUTH).send({ board: 'cards', cardId: 'id-abc123' })
  expect(again.body.unchanged).toBe(true)

  const list = await request(app).get(`${API}/messages?folder=INBOX`).set(AUTH)
  const byId = Object.fromEntries(list.body.messages.map(m => [m.id, m]))
  expect(byId['7'].cardRefs).toEqual([{ board: 'cards', cardId: 'id-abc123' }])
  expect(byId['8'].cardRefs).toBeUndefined()

  const msg = await request(app).get(`${API}/message/7`).set(AUTH)
  expect(msg.body.cardRefs).toEqual([{ board: 'cards', cardId: 'id-abc123' }])
  const panel = await request(app).get(API).set(AUTH)
  expect(panel.body.messages.find(m => m.id === '7').cardRefs).toHaveLength(1)
})

test('MVA-23 POST message/:uid/cards — invalid body 400; missing message 404; no Message-ID 422', async () => {
  imap.messages = [_msg(7, { envelope: { messageId: '' } })]
  for (const body of [{}, { board: 'Bad', cardId: 'id-1' }, { board: 'cards', cardId: 'a/b' }, { board: 'cards', cardId: 'id-1', x: 1 }]) {
    expect((await request(app).post(`${API}/message/7/cards`).set(AUTH).send(body)).status, JSON.stringify(body)).toBe(400)
  }
  expect((await request(app).post(`${API}/message/99/cards`).set(AUTH).send({ board: 'cards', cardId: 'id-1' })).status).toBe(404)
  expect((await request(app).post(`${API}/message/7/cards`).set(AUTH).send({ board: 'cards', cardId: 'id-1' })).status).toBe(422)
  expect(_mailLinks).toEqual({})
})

test('MVA-24 GET locate — searches the hint folder first, then the other selectable folders', async () => {
  imap.folders = [
    { path: 'INBOX',   name: 'INBOX',   delimiter: '/', flags: new Set() },
    { path: 'Archive', name: 'Archive', delimiter: '/', flags: new Set() },
    { path: 'Parent',  name: 'Parent',  delimiter: '/', flags: new Set(['\\Noselect']) },
  ]
  imap.searchByFolder = { Archive: [12, 15] }

  const res = await request(app).get(`${API}/locate?messageId=${encodeURIComponent('<abc@ex.com>')}&folder=Projects`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ folder: 'Archive', uid: '15' })
  const locked = calls('lock').map(c => c[1])
  expect(locked).toEqual(['Projects', 'INBOX', 'Archive'])
  expect(locked).not.toContain('Parent')
  expect(calls('search')[0][1]).toEqual({ header: { 'message-id': '<abc@ex.com>' }, deleted: false })
})

test('MVA-25 GET locate — not found 404; invalid messageId / folder 400', async () => {
  imap.folders = [{ path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set() }]
  imap.searchByFolder = {}
  expect((await request(app).get(`${API}/locate?messageId=%3Cx%40y%3E`).set(AUTH)).status).toBe(404)
  expect((await request(app).get(`${API}/locate`).set(AUTH)).status).toBe(400)
  expect((await request(app).get(`${API}/locate?messageId=a%0Db`).set(AUTH)).status).toBe(400)
  expect((await request(app).get(`${API}/locate?messageId=x&folder=bad%01`).set(AUTH)).status).toBe(400)
})

test('MVA-26 GET locate?scope=hint — only the hint folder is searched (no folder listing)', async () => {
  imap.folders = [
    { path: 'INBOX',   name: 'INBOX',   delimiter: '/', flags: new Set() },
    { path: 'Archive', name: 'Archive', delimiter: '/', flags: new Set() },
  ]
  imap.searchByFolder = { Archive: [12] }
  const mid = encodeURIComponent('<abc@ex.com>')
  expect((await request(app).get(`${API}/locate?messageId=${mid}&folder=INBOX&scope=hint`).set(AUTH)).status).toBe(404)
  expect(calls('lock').map(c => c[1])).toEqual(['INBOX'])

  imap.searchByFolder = { INBOX: [3] }
  const res = await request(app).get(`${API}/locate?messageId=${mid}&scope=hint`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ folder: 'INBOX', uid: '3' })
})

test('MVA-27 GET message/:uid/source — raw source as plain text in the given folder; 404 / 400', async () => {
  const raw = 'Subject: Hi\r\nMessage-ID: <s@ex.com>\r\n\r\n<script>alert(1)</script>\r\n'
  imap.messages = [{ ..._msg(8), source: Buffer.from(raw) }]
  const res = await request(app).get(`${API}/message/8/source?folder=Projects`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toMatch(/^text\/plain/)
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  expect(res.text).toBe(raw)
  expect(calls('lock')[0][1]).toBe('Projects')
  expect((await request(app).get(`${API}/message/99/source`).set(AUTH)).status).toBe(404)
  expect((await request(app).get(`${API}/message/abc/source`).set(AUTH)).status).toBe(400)
})

test('MVA-32 findDuplicateUids — without Message-ID: same sender, To, subject, date / time and size; lowest UID kept', () => {
  const { findDuplicateUids } = require('../../backend/dashboard/mail')
  const m = (uid, env = {}, size = 100) => ({
    uid, size,
    envelope: { from: [{ address: 'Jane@Ex.com' }], to: [{ address: 'me@ex.com' }], subject: 'Hi',
                date: new Date('2026-11-01T10:00:00Z'), ...env },
  })
  const msgs = [
    m(7), m(3), m(9),                                            // 3 copies → 7 and 9 go
    m(10, { from: [{ address: 'jane@ex.com' }] }),               // address case ignored → duplicate
    m(11, { to: [{ address: 'other@ex.com' }] }),                // other receiver
    m(12, { subject: 'Re: Hi' }),                                // other subject
    m(13, { date: new Date('2026-11-01T10:00:01Z') }),           // one second later
    m(14, {}, 101),                                              // other size
  ]
  expect(findDuplicateUids(msgs).sort((a, b) => a - b)).toEqual([7, 9, 10])
  // No Date header: the arrival time decides
  const a = { uid: 1, size: 5, envelope: { subject: 'x' }, internalDate: new Date('2026-01-01T00:00:00Z') }
  expect(findDuplicateUids([a, { ...a, uid: 2 }])).toEqual([2])
  expect(findDuplicateUids([a, { ...a, uid: 2, internalDate: new Date('2026-01-02T00:00:00Z') }])).toEqual([])
})

test('MVA-32b findDuplicateUids — with Message-ID: size ignored, the largest copy is kept', () => {
  const { findDuplicateUids } = require('../../backend/dashboard/mail')
  const m = (uid, size, env = {}) => ({
    uid, size,
    envelope: { from: [{ address: 'jane@ex.com' }], to: [{ address: 'me@ex.com' }], subject: 'Report',
                date: new Date('2026-11-01T10:00:00Z'), messageId: '<a1@ex.com>', ...env },
  })
  // Copies of one mail: headers added on a move (+32 bytes), attachment stripped (-245 KB)
  expect(findDuplicateUids([m(1, 250_000), m(2, 250_032), m(3, 4_000)])).toEqual([1, 3])
  expect(findDuplicateUids([m(1, 500), m(2, 500)])).toEqual([2])                                  // tie: lowest UID kept
  expect(findDuplicateUids([m(1, 500), m(2, 500, { messageId: '<b2@ex.com>' })])).toEqual([])     // other Message-ID
  expect(findDuplicateUids([m(1, 500), m(2, 500, { subject: 'Re: Report' })])).toEqual([])        // same ID, other subject
  expect(findDuplicateUids([m(1, 500), m(2, 500, { messageId: '' })])).toEqual([])                // only one has an ID
})

test('MVA-33 GET duplicates?folder= — scans the folder, returns the copies to delete', async () => {
  imap.messages = [_msg(1), _msg(2, { envelope: { subject: 'Subject 1' } }), _msg(3)]
  const res = await request(app).get(`${API}/duplicates?folder=Projects`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ messages: 3, uids: [2] })
  expect(calls('lock')[0][1]).toBe('Projects')
  expect(calls('fetch')[0][1]).toBe('1:*')
  expect((await request(app).get('/api/dashboard/mail/ma-x/duplicates').set(AUTH)).status).toBe(404)
})

test('MVA-34 GET messages — sorted by date / time, latest first (not by arrival); paging and search follow it', async () => {
  const at = (uid, iso) => _msg(uid, { envelope: { date: new Date(iso) } })
  imap.messages = [
    at(1, '2026-11-05T08:00:00Z'), at(2, '2026-10-01T12:00:00Z'),   // older mail moved in later
    at(3, '2026-11-05T09:30:00Z'), at(4, '2026-11-04T23:59:00Z'),
    { ..._msg(5), envelope: { ..._msg(5).envelope, date: undefined }, internalDate: new Date('2026-11-06T00:00:00Z') },   // no Date header
  ]
  const res = await request(app).get(`${API}/messages`).set(AUTH)
  expect(res.body.messages.map(m => m.id)).toEqual(['5', '3', '1', '4', '2'])

  _resetImap()
  imap.messages = [at(1, '2026-11-05T08:00:00Z'), at(2, '2026-10-01T12:00:00Z'), at(3, '2026-11-05T09:30:00Z')]
  imap.search = [1, 2]
  const q = await request(app).get(`${API}/messages?q=x`).set(AUTH)
  expect(q.body.messages.map(m => m.id)).toEqual(['1', '2'])
  expect(q.body.total).toBe(2)

  const { sortUidsByDate } = require('../../backend/dashboard/mail')
  expect(sortUidsByDate([{ uid: 1, envelope: { date: new Date('2026-01-01') } }, { uid: 2, envelope: { date: new Date('2026-01-01') } }])).toEqual([2, 1])
})

test('MVA-35 GET messages — date order cached per folder while UIDVALIDITY / UIDNEXT / EXISTS are unchanged', async () => {
  imap.messages = [_msg(1), _msg(2)]
  imap.uidValidity = 7; imap.uidNext = 3
  await request(app).get(`${API}/messages?folder=Cache`).set(AUTH)
  await request(app).get(`${API}/messages?folder=Cache&page=0`).set(AUTH)
  expect(calls('fetch').filter(c => c[1] === '1:*')).toHaveLength(1)
  imap.messages.push(_msg(3)); imap.uidNext = 4                       // new mail → rescan
  const res = await request(app).get(`${API}/messages?folder=Cache`).set(AUTH)
  expect(calls('fetch').filter(c => c[1] === '1:*')).toHaveLength(2)
  expect(res.body.messages.map(m => m.id)).toEqual(['3', '2', '1'])
})

test('MVA-36 hidden folders — GET / PUT per account (settings), deduplicated, validated', async () => {
  _hidden = {}
  const url = '/api/dashboard/mail-hidden-folders'
  expect((await request(app).get(url).set(AUTH)).body).toEqual({ folders: {} })
  const put = await request(app).put(url).set(AUTH).send({ accountId: 'ma-1', folders: ['Old', 'Old/2019', 'Old'] })
  expect(put.status).toBe(200)
  expect(put.body.folders).toEqual({ 'ma-1': ['Old', 'Old/2019'] })
  expect((await request(app).get(url).set(AUTH)).body).toEqual({ folders: { 'ma-1': ['Old', 'Old/2019'] } })
  // empty list removes the account's entry
  expect((await request(app).put(url).set(AUTH).send({ accountId: 'ma-1', folders: [] })).body.folders).toEqual({})
  expect((await request(app).put(url).set(AUTH).send({ accountId: 'ma-x', folders: [] })).status).toBe(404)
  expect((await request(app).put(url).set(AUTH).send({ accountId: 'ma-1', folders: 'Old' })).status).toBe(400)
  expect((await request(app).put(url).set(AUTH).send({ accountId: 'ma-1', folders: ['a\u0000b'] })).status).toBe(400)
})

test('MVA-37 GET message — body parts decoded in their charset (QP ISO-8859-1, HTML <meta>, undeclared 8-bit latin1, UTF-8)', async () => {
  const m = _msg(41)
  const html = '<html><head><meta charset="windows-1252"></head><body>Dank f\xfcr Ihr Interesse \x80</body></html>'
  m.bodyStructure = {
    type: 'multipart/alternative',
    childNodes: [
      { part: '1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'ISO-8859-1' } },
      { part: '2', type: 'text/html', encoding: 'base64' },
    ],
  }
  m.bodyParts = new Map([
    ['1', Buffer.from('Dank f=FCr Ihr Interesse, Gr=FC=DFe=\r\n und mehr')],
    ['2', Buffer.from(Buffer.from(html, 'latin1').toString('base64'))],
  ])
  imap.messages = [m]
  let res = await request(app).get(`${API}/message/41`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.body).toBe('Dank für Ihr Interesse, Grüße und mehr')
  expect(res.body.bodyHtml).toContain('Dank für Ihr Interesse €')

  // No charset, 8-bit latin1 bytes → windows-1252; valid UTF-8 (QP) stays UTF-8
  const plain = _msg(42)
  plain.bodyStructure = { type: 'text/plain', encoding: '8bit' }
  plain.bodyParts = new Map([['1', Buffer.from('Dank f\xfcr Ihr Interesse', 'latin1')]])
  const utf8 = _msg(43)
  utf8.bodyStructure = { type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } }
  utf8.bodyParts = new Map([['1', Buffer.from('Dank f=C3=BCr =E2=9C=85')]])
  imap.messages = [plain, utf8]
  res = await request(app).get(`${API}/message/42`).set(AUTH)
  expect(res.body.body).toBe('Dank für Ihr Interesse')
  res = await request(app).get(`${API}/message/43`).set(AUTH)
  expect(res.body.body).toBe('Dank für ✅')
})

// ---------------------------------------------------------------------------
// Flags (Apple Mail colours: \Flagged + $MailFlagBit0..2)
// ---------------------------------------------------------------------------

test('MVA-38 flagColor / flagChanges — Apple Mail bit encoding both ways', () => {
  const { flagColor, flagChanges, MAIL_FLAG_COLORS } = require('../../backend/dashboard/mail')
  expect(flagColor(new Set(['\\Seen']))).toBe(null)
  expect(flagColor(['$MailFlagBit0'])).toBe(null)   // bits without \Flagged = not flagged
  expect(flagColor(['\\Flagged'])).toBe('red')
  expect(flagColor(['\\Flagged', '$MailFlagBit0', '$MailFlagBit1'])).toBe('green')
  expect(flagColor(['\\Flagged', '$MailFlagBit1', '$MailFlagBit2'])).toBe('gray')
  for (const c of MAIL_FLAG_COLORS) expect(flagColor(flagChanges(c).add)).toBe(c)
  expect(flagChanges('purple')).toEqual({ add: ['\\Flagged', '$MailFlagBit0', '$MailFlagBit2'], remove: ['$MailFlagBit1'] })
  expect(flagChanges(null)).toEqual({ add: [], remove: ['\\Flagged', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2'] })
  expect(() => flagChanges('pink')).toThrow()
})

test('MVA-39 PATCH { flag } — sets / clears flag keywords on a UID set; validation', async () => {
  await request(app).patch(`${API}/message/3,7?folder=Projects`).set(AUTH).send({ flag: 'blue' }).expect(200)
  expect(calls('lock')[0][1]).toBe('Projects')
  expect(calls('flagsAdd')).toEqual([['flagsAdd', '3,7', ['\\Flagged', '$MailFlagBit2']]])
  expect(calls('flagsRemove')).toEqual([['flagsRemove', '3,7', ['$MailFlagBit0', '$MailFlagBit1']]])

  imap.calls = []
  await request(app).patch(`${API}/message/3`).set(AUTH).send({ flag: null }).expect(200)
  expect(calls('flagsAdd')).toEqual([])
  expect(calls('flagsRemove')).toEqual([['flagsRemove', '3', ['\\Flagged', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2']]])

  imap.calls = []
  await request(app).patch(`${API}/message/3`).set(AUTH).send({ seen: true, flag: 'red' }).expect(200)
  expect(calls('flagsAdd')).toEqual([['flagsAdd', '3', ['\\Seen']], ['flagsAdd', '3', ['\\Flagged']]])

  imap.calls = []
  for (const body of [{}, { flag: 'pink' }, { flag: 1 }, { seen: 'yes' }]) {
    await request(app).patch(`${API}/message/3`).set(AUTH).send(body).expect(400)
  }
  expect(imap.calls.filter(c => c[0].startsWith('flags'))).toEqual([])
})

test('MVA-40 GET /dashboard/mail — flagged mails of the account folder (any age, newest first) with flagColor', async () => {
  imap.messages = [
    _msg(1, { flags: ['\\Seen', '\\Flagged', '$MailFlagBit0'], envelope: { date: new Date('2025-01-01T10:00:00Z') } }),
    ...Array.from({ length: 30 }, (_, i) => _msg(i + 2)),
    _msg(32, { flags: ['\\Flagged'] }),
  ]
  imap.search = [1, 32]
  const res = await request(app).get('/api/dashboard/mail').set(AUTH)
  expect(res.status).toBe(200)
  const acc = res.body[0]
  expect(calls('search')[0][1]).toEqual({ flagged: true })
  expect(acc).toMatchObject({ accountId: 'ma-1', folder: 'INBOX', flaggedTotal: 2, error: null })
  expect(acc.messages).toHaveLength(20)
  expect(acc.messages[0]).toMatchObject({ id: '32', flagged: true, flagColor: 'red' })
  expect(acc.flagged.map(m => [m.id, m.flagColor, m.unread])).toEqual([['32', 'red', true], ['1', 'orange', false]])
})

test('MVA-41 GET message — full message carries flagged / flagColor', async () => {
  imap.messages = [_msg(5, { flags: ['\\Flagged', '$MailFlagBit1'] })]
  const res = await request(app).get(`${API}/message/5`).set(AUTH)
  expect(res.body).toMatchObject({ flagged: true, flagColor: 'yellow' })
})

test('MVA-43 GET messages — sort (oldest first, sender), date / attachment / duplicate filters, all=1, validation', async () => {
  const at = d => ({ envelope: { date: new Date(d) } })
  const from = (name, d) => ({ envelope: { from: [{ name, address: `${name.toLowerCase()}@ex.com` }], date: new Date(d) } })
  imap.messages = [
    _msg(1, from('Zoe',  '2026-03-01T10:00:00Z')),
    _msg(2, from('anna', '2026-03-05T10:00:00Z')),
    _msg(3, from('Ben',  '2026-03-03T10:00:00Z')),
    _msg(4, from('Anna', '2026-03-09T10:00:00Z')),
  ]
  imap.messages[2].bodyStructure = {
    type: 'multipart/mixed', childNodes: [
      { part: '1', type: 'text/plain', encoding: '7bit' },
      { part: '2', type: 'application/pdf', encoding: 'base64', size: 400, dispositionParameters: { filename: 'cv.pdf' } },
    ],
  }
  const ids = async qs => {
    const res = await request(app).get(`${API}/messages?${qs}`).set(AUTH)
    expect(res.status).toBe(200)
    return res.body
  }

  expect((await ids('')).messages.map(m => m.id)).toEqual(['4', '2', '3', '1'])
  expect((await ids('sort=date-asc')).messages.map(m => m.id)).toEqual(['1', '3', '2', '4'])
  // Sender A–Z, case-insensitive; same sender latest first
  expect((await ids('sort=from')).messages.map(m => m.id)).toEqual(['4', '2', '3', '1'])

  const since = encodeURIComponent('2026-03-03T00:00:00.000Z'), before = encodeURIComponent('2026-03-09T00:00:00.000Z')
  const range = await ids(`since=${since}&before=${before}`)
  expect(range.messages.map(m => m.id)).toEqual(['2', '3'])
  expect(range.total).toBe(2)
  expect((await ids(`before=${since}`)).messages.map(m => m.id)).toEqual(['1'])

  // Attachment filter: bodyStructure scan of the folder, same rule as hasAttachments
  _resetImap(); imap.messages = [_msg(1), _msg(2), _msg(3)]
  imap.messages[1].bodyStructure = { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'text/plain', encoding: '7bit' },
    { part: '2', type: 'image/png', encoding: 'base64', size: 40, parameters: { name: 'a.png' } },
  ] }
  const att = await ids('attachments=1')
  expect(att.messages.map(m => m.id)).toEqual(['2'])
  expect(att.messages[0].hasAttachments).toBe(true)

  // duplicates=1: only the copies (largest copy = original), combinable with the search
  _resetImap()
  const dup = (uid, size) => Object.assign(_msg(uid, { envelope: { messageId: '<same@ex.com>', subject: 'Same' } }), { size })
  imap.messages = [dup(1, 500), dup(2, 900), dup(3, 500), _msg(4)]
  const dupList = await ids('duplicates=1')
  expect(dupList.messages.map(m => m.id)).toEqual(['3', '1'])
  expect(dupList.messages.every(m => m.duplicate === true)).toBe(true)
  // Without the filter every message says whether it is a copy (the list label) — the original (largest) is not
  expect(Object.fromEntries((await ids('')).messages.map(m => [m.id, m.duplicate]))).toEqual({ 1: true, 2: false, 3: true, 4: false })
  imap.search = [1, 2, 4]
  expect((await ids('duplicates=1&q=same')).messages.map(m => m.id)).toEqual(['1'])

  // all=1: everything from the page on, fetched in chunks of 500 UIDs
  _resetImap(); imap.messages = Array.from({ length: 620 }, (_, i) => _msg(i + 1, at('2026-03-01T10:00:00Z')))
  const all = await ids('page=1&all=1')
  expect(all.messages).toHaveLength(570)
  expect(all.total).toBe(620)
  expect(calls('fetch').slice(1).map(c => c[1].split(',').length)).toEqual([500, 70])

  for (const qs of ['sort=size', 'since=yesterday', `since=${before}&before=${since}`]) {
    const res = await request(app).get(`${API}/messages?${qs}`).set(AUTH)
    expect(res.status).toBe(400)
  }
})

test('MVA-44 GET attachment/:part/event — ICS attachment parsed; nameless text/calendar part listed as invite.ics only without a named one; non-calendar / broken → 422', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:meet-1@ex.com',
    'DTSTART;TZID=Europe/Berlin:20261120T100000', 'DTEND;TZID=Europe/Berlin:20261120T113000',
    'SUMMARY:Kick-off', 'LOCATION:Room 4', 'DESCRIPTION:Agenda\\nfirst point', 'ORGANIZER;CN=Jane:mailto:jane@ex.com',
    'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
  const m = _msg(7)
  m.bodyStructure = { type: 'multipart/mixed', childNodes: [
    { type: 'multipart/alternative', childNodes: [
      { part: '1.1', type: 'text/plain', encoding: '7bit' },
      { part: '1.2', type: 'text/calendar', encoding: 'quoted-printable', parameters: { method: 'REQUEST' } },
    ] },
    { part: '2', type: 'application/ics', encoding: 'base64', size: 600, dispositionParameters: { filename: 'invite.ics' } },
    { part: '3', type: 'application/pdf', encoding: 'base64', size: 10, dispositionParameters: { filename: 'a.pdf' } },
  ] }
  m.bodyParts = new Map([
    ['1.1', Buffer.from('Hi')],
    ['1.2', Buffer.from(ics.replace('Room 4', 'Raum f=C3=BCr 4'))],   // quoted-printable, UTF-8
    ['2', Buffer.from(Buffer.from(ics).toString('base64'))],
    ['3', Buffer.from(Buffer.from('%PDF').toString('base64'))],
  ])
  imap.messages = [m]

  const full = await request(app).get(`${API}/message/7`).set(AUTH)
  // The named invite.ics wins: the inline calendar part (same invitation) is not listed a second time
  expect(full.body.attachments.map(a => [a.part, a.name])).toEqual([['2', 'invite.ics'], ['3', 'a.pdf']])

  const res = await request(app).get(`${API}/message/7/attachment/2/event`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.method).toBe('REQUEST')
  expect(res.body.events).toEqual([{
    uid: 'meet-1@ex.com', title: 'Kick-off', start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T10:30:00.000Z', allDay: false,
    location: 'Room 4', description: 'Agenda\nfirst point', organizer: 'jane@ex.com', timezone: 'Europe/Berlin', rruleStr: 'FREQ=WEEKLY;COUNT=3',
  }])

  expect((await request(app).get(`${API}/message/7/attachment/3/event`).set(AUTH)).status).toBe(422)
  m.bodyParts.set('2', Buffer.from(Buffer.from('BEGIN:VCALENDAR\r\nnonsense').toString('base64')))
  expect((await request(app).get(`${API}/message/7/attachment/2/event`).set(AUTH)).status).toBe(422)
  expect((await request(app).get(`${API}/message/7/attachment/9/event`).set(AUTH)).status).toBe(404)
  expect((await request(app).get(`${API}/message/7/attachment/x/event`).set(AUTH)).status).toBe(400)

  // Only the inline part (Outlook): listed as invite.ics, quoted-printable decoded
  m.bodyStructure.childNodes.splice(1, 1)
  const inline = await request(app).get(`${API}/message/7`).set(AUTH)
  expect(inline.body.attachments.map(a => [a.part, a.name])).toEqual([['1.2', 'invite.ics'], ['3', 'a.pdf']])
  const qp = await request(app).get(`${API}/message/7/attachment/1.2/event`).set(AUTH)
  expect(qp.body.events[0].location).toBe('Raum für 4')
})

// ---------------------------------------------------------------------------
// Conversations (threads across folders)
// ---------------------------------------------------------------------------

const { buildThreads } = require('../../backend/dashboard/mail.js')

test('MVA-45 buildThreads — reply chain, own headers win, missing ancestors, cycles, copies, no Message-ID', () => {
  const t = buildThreads([
    { key: 'INBOX\n1', mid: '<a>', irt: '', refs: [], t: 1 },
    { key: 'Sent\n5',  mid: '<b>', irt: '<a>', refs: ['<a>'], t: 2 },
    // References claims <x> → <b>, but <b>'s own In-Reply-To (<a>) wins
    { key: 'INBOX\n2', mid: '<c>', irt: '<b>', refs: ['<x>', '<b>'], t: 3 },
    { key: 'INBOX\n3', mid: '<d>', irt: '<gone>', refs: ['<gone>'], t: 4 },   // missing parent, one child → moves up
    { key: 'INBOX\n4', mid: '<e>', irt: '<y>', refs: ['<y>'], t: 6 },
    { key: 'INBOX\n6', mid: '<f>', irt: '<y>', refs: ['<y>'], t: 5 },         // missing parent, two children → placeholder
    { key: 'INBOX\n7', mid: '<g>', irt: '<h>', refs: [], t: 7 },
    { key: 'INBOX\n8', mid: '<h>', irt: '<g>', refs: [], t: 8 },              // cycle refused
    { key: 'Archive\n1', mid: '<a>', irt: '', refs: [], t: 1 },               // copy of <a>
    { key: 'INBOX\n9', mid: '', irt: '<a>', refs: [], t: 9 },                 // no Message-ID: own thread
  ])
  const thread = k => t.threadOf.get(k)
  expect(['INBOX\n1', 'Sent\n5', 'INBOX\n2', 'Archive\n1'].map(thread)).toEqual(Array(4).fill('m:<a>'))
  expect(t.nodes.get('m:<b>').parent).toBe('m:<a>')
  expect(t.nodes.get('m:<c>').parent).toBe('m:<b>')
  expect(t.nodes.has('m:<x>')).toBe(false)                     // empty ancestor with one child dropped
  expect(t.nodes.get('m:<a>').keys).toEqual(['INBOX\n1', 'Archive\n1'])
  expect(thread('INBOX\n3')).toBe('m:<d>')
  expect(t.nodes.has('m:<gone>')).toBe(false)
  expect(t.nodes.get('m:<y>')).toMatchObject({ keys: [], parent: null, children: ['m:<f>', 'm:<e>'] })   // oldest first
  expect(thread('INBOX\n4')).toBe('m:<y>')
  expect(thread('INBOX\n7')).toBe(thread('INBOX\n8'))
  expect(thread('INBOX\n9')).toBe('k:INBOX\n9')
})

/** INBOX: <a> (1), <c> → <b> (2), unrelated <z> (3); Sent: <b> → <a>; Archive: <d> → <c>; Trash: <e> → <a>. */
function _threadFixture() {
  const m = (uid, mid, irt, refs, day, from = 'jane@ex.com') => _msg(uid, {
    envelope: { messageId: mid, inReplyTo: irt, subject: mid === '<a>' ? 'Plan' : `Re: Plan`, date: new Date(`2026-11-0${day}T10:00:00Z`),
      from: [{ address: from }] },
    headers: refs.length ? Buffer.from(`References: ${refs.join('\r\n ')}\r\n\r\n`) : undefined,
  })
  imap.byFolder = {
    INBOX:   [m(1, '<a>', '', [], 1), m(2, '<c>', '<b>', ['<a>', '<b>'], 3), m(3, '<z>', '', [], 2)],
    Sent:    [m(5, '<b>', '<a>', ['<a>'], 2, 'me@ex.com')],
    Archive: [m(9, '<d>', '<c>', ['<a>', '<b>', '<c>'], 4)],
    Trash:   [m(4, '<e>', '<a>', ['<a>'], 5)],
  }
  imap.folders = ['INBOX', 'Sent', 'Archive', 'Trash'].map(path => ({
    path, name: path, delimiter: '/', flags: new Set(), specialUse: path === 'Trash' ? '\\Trash' : path === 'INBOX' ? '\\Inbox' : null,
  }))
}

test('MVA-46 GET messages?threads=1 — conversations across folders (trash left out), tree order, paged by thread, search hits', async () => {
  _threadFixture()
  const res = await request(app).get(`${API}/messages?folder=INBOX&threads=1`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ total: 2, totalMessages: 3, page: 0 })
  const [plan, other] = res.body.threads
  expect(plan.id).toBe('m:<a>')
  expect(plan.messages.map(x => [x.folder, x.id, x.depth, x.foreign])).toEqual([
    ['INBOX', '1', 0, false], ['Sent', '5', 1, true], ['INBOX', '2', 2, false], ['Archive', '9', 3, true],
  ])
  expect(plan.messages[1].parent).toBe('m:<a>')
  expect(other.messages.map(x => x.id)).toEqual(['3'])
  // Flat list = this folder's messages of the page, in conversation order
  expect(res.body.messages.map(x => x.id)).toEqual(['1', '2', '3'])
  expect(JSON.stringify(res.body)).not.toContain('"Trash"')

  // Search: a conversation shows when one of its messages here matches; hits are marked
  imap.searchByFolder = { INBOX: [1] }
  const hit = await request(app).get(`${API}/messages?folder=INBOX&threads=1&q=plan`).set(AUTH)
  expect(hit.body.total).toBe(1)
  expect(hit.body.threads[0].messages.map(x => [x.id, x.match])).toEqual([['1', true], ['5', undefined], ['2', false], ['9', undefined]])

  // Opened from the trash, the trash itself takes part
  const trash = await request(app).get(`${API}/messages?folder=Trash&threads=1`).set(AUTH)
  expect(trash.body.threads[0].messages.map(x => `${x.folder}/${x.id}`)).toEqual(['INBOX/1', 'Sent/5', 'INBOX/2', 'Archive/9', 'Trash/4'])
})

test('MVA-47 GET thread/:uid — conversation of one message from every folder; 404 unknown, 400 bad uid', async () => {
  _threadFixture()
  const res = await request(app).get(`${API}/thread/9?folder=Archive`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body.id).toBe('m:<a>')
  expect(res.body.messages.map(x => [x.folder, x.id, x.foreign])).toEqual([
    ['INBOX', '1', true], ['Sent', '5', true], ['INBOX', '2', true], ['Archive', '9', false],
  ])
  expect((await request(app).get(`${API}/thread/77?folder=INBOX`).set(AUTH)).status).toBe(404)
  expect((await request(app).get(`${API}/thread/x`).set(AUTH)).status).toBe(400)
})

test('MVA-48 threads — unchanged folders are not scanned again (LIST-STATUS signature); a new reply in Sent is picked up', async () => {
  _threadFixture()
  imap.uidValidity = 4848
  imap.uidNext = 100
  const status = { INBOX: 3, Sent: 1, Archive: 1, Trash: 1 }
  const syncStatus = () => imap.folders.forEach(f => { f.status = { messages: status[f.path], uidNext: 100, uidValidity: 4848 } })
  syncStatus()
  await request(app).get(`${API}/messages?folder=INBOX&threads=1`).set(AUTH)
  const locks = () => calls('lock').map(c => c[1])
  expect(locks()).toEqual(expect.arrayContaining(['Sent', 'Archive']))

  imap.calls = []
  const again = await request(app).get(`${API}/messages?folder=INBOX&threads=1`).set(AUTH)
  expect(again.body.threads[0].messages).toHaveLength(4)
  // Index from the cache: Archive / Sent only locked to fetch the summaries, INBOX for the list
  expect(calls('fetch').filter(c => c[1] === '1:*')).toEqual([])

  // A second own reply lands in Sent → Sent's signature changes → rescanned, the reply joins the conversation
  imap.byFolder.Sent.push(_msg(6, { envelope: { messageId: '<b2>', inReplyTo: '<c>', subject: 'Re: Plan', date: new Date('2026-11-05T10:00:00Z') } }))
  status.Sent = 2
  syncStatus()
  imap.calls = []
  const fresh = await request(app).get(`${API}/messages?folder=INBOX&threads=1`).set(AUTH)
  expect(fresh.body.threads[0].messages.map(x => `${x.folder}/${x.id}`)).toEqual(['INBOX/1', 'Sent/5', 'INBOX/2', 'Archive/9', 'Sent/6'])
  expect(calls('fetch').filter(c => c[1] === '1:*')).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

function _draft(payload, files = []) {
  let req = request(app).post(`${API}/draft`).set(AUTH).field('payload', JSON.stringify(payload))
  for (const f of files) req = req.attach('files', Buffer.from(f.content), f.name)
  return req
}

test('MVA-49 POST draft — stored in the \\Drafts folder (\\Draft, unread, Bcc kept, original in X-JC-Reply), replaces the previous version, never sent', async () => {
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com', fromName: 'Me' }
  imap.folders = [{ path: 'Entwürfe', specialUse: '\\Drafts', flags: new Set() }]
  imap.appendUid = 41
  imap.messages = [_msg(40, { flags: ['\\Draft', '\\Seen'] }), _msg(41, { flags: ['\\Draft', '\\Seen'] })]

  const res = await _draft({ to: 'bob@ex.com', bcc: 'dave@ex.com', subject: 'Re: Plan', html: '<p>Half</p>', text: 'Half',
    inReplyTo: '<m1@ex.com>', replyUid: '77', replyFolder: 'INBOX/Projekte', draftUid: '40' }, [{ name: 'a.txt', content: 'x' }])
  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ ok: true, uid: '41', folder: 'Entwürfe', attachments: [] })
  expect(smtp.sent).toHaveLength(0)
  const [, folder, raw, flags] = calls('append')[0]
  expect(folder).toBe('Entwürfe')
  expect(flags).toEqual(['\\Draft'])   // unread: counted in the folder tree
  expect(raw).toMatch(/^Bcc: dave@ex\.com/m)
  expect(raw).toMatch(/^In-Reply-To: <m1@ex\.com>/m)
  expect(raw).toMatch(/^X-JC-Reply: 77 INBOX%2FProjekte/im)   // header names are case-insensitive (MailComposer: X-Jc-Reply)
  expect(raw).toContain('filename=a.txt')
  expect(calls('expunge')).toEqual([['expunge', '40']])   // the previous version

  // Recipients may be missing; no UIDPLUS → found by Message-ID
  imap.appendUid = null
  imap.search = [52, 50]
  const blank = await _draft({ subject: '', text: '' })
  expect(blank.status).toBe(200)
  expect(blank.body.uid).toBe('52')
  expect(calls('search').at(-1)[1]).toMatchObject({ header: { 'message-id': expect.stringMatching(/^<.+@ex\.com>$/) } })
  expect((await _draft({ to: 'x', evil: 1 })).status).toBe(400)
})

test('MVA-50 drafts are only deleted when flagged \\Draft; DELETE draft/:uid', async () => {
  imap.folders = [{ path: 'Drafts', specialUse: '\\Drafts', flags: new Set() }]
  imap.messages = [_msg(7, { flags: ['\\Seen'] }), _msg(8, { flags: ['\\Draft'] })]
  expect((await request(app).delete(`${API}/draft/7`).set(AUTH)).body).toEqual({ ok: true, deleted: false })
  expect((await request(app).delete(`${API}/draft/8`).set(AUTH)).body).toEqual({ ok: true, deleted: true })
  expect(calls('expunge')).toEqual([['expunge', '8']])
  expect(calls('lock').every(c => c[1] === 'Drafts')).toBe(true)
  expect((await request(app).delete(`${API}/draft/x1`).set(AUTH)).status).toBe(400)
  expect((await request(app).delete('/api/dashboard/mail/nope/draft/8').set(AUTH)).status).toBe(404)
})

test('MVA-51 send a continued draft — its attachments taken over (draftParts), the draft deleted afterwards', async () => {
  _storedConfig.mailAccounts[0].smtp = { host: 'smtp.ex.com' }
  imap.folders = [{ path: 'Drafts', specialUse: '\\Drafts', flags: new Set() }]
  const draft = _msg(9, { flags: ['\\Draft'] })
  draft.bodyStructure = { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'text/plain', encoding: '7bit' },
    { part: '2', type: 'application/pdf', encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'offer.pdf' }, size: 4 },
  ] }
  draft.bodyParts = new Map([['1', Buffer.from('Body')], ['2', Buffer.from('UERGIQ==')]])
  imap.messages = [draft]
  const res = await _send({ to: 'bob@ex.com', subject: 'Offer', text: 'see attached', draftUid: '9', draftFolder: 'Drafts', draftParts: ['2'] })
  expect(res.status).toBe(200)
  expect(smtp.sent[0].raw).toContain('filename=offer.pdf')
  expect(calls('expunge')).toEqual([['expunge', '9']])
  expect((await _send({ to: 'bob@ex.com', text: 'x', draftParts: ['2'] })).status).toBe(400)   // parts without the draft
})

test('MVA-52 GET drafts?inReplyTo — draft replies to a message; message route reports bcc, draft flag and the original', async () => {
  imap.folders = [{ path: 'Drafts', specialUse: '\\Drafts', flags: new Set() }]
  imap.search = [3, 4, 5]
  imap.messages = [
    _msg(3, { flags: ['\\Draft'], envelope: { inReplyTo: '<m1@ex.com>', subject: 'Re: A', date: new Date('2026-11-02T10:00:00Z') } }),
    _msg(4, { flags: ['\\Draft'], envelope: { inReplyTo: '<other@ex.com>' } }),   // header search is substring-based
    _msg(5, { flags: ['\\Seen'],  envelope: { inReplyTo: '<m1@ex.com>' } }),       // not a draft
  ]
  const res = await request(app).get(`${API}/drafts?inReplyTo=${encodeURIComponent('<m1@ex.com>')}`).set(AUTH)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ folder: 'Drafts', drafts: [{ id: '3', subject: 'Re: A', date: '2026-11-02T10:00:00.000Z' }] })
  expect(calls('search')[0][1]).toEqual({ header: { 'in-reply-to': '<m1@ex.com>' } })
  expect((await request(app).get(`${API}/drafts?inReplyTo=nope`).set(AUTH)).status).toBe(400)

  imap.messages = [_msg(3, { flags: ['\\Draft'], envelope: { bcc: [{ address: 'dave@ex.com' }] },
    headers: Buffer.from('X-JC-Reply: 77 INBOX%2FProjekte\r\nX-JC-Forward: 12 Archive\r\n') })]
  const msg = await request(app).get(`${API}/message/3?folder=Drafts`).set(AUTH)
  expect(msg.body).toMatchObject({ draft: true, bcc: 'dave@ex.com', draftReply: { uid: '77', folder: 'INBOX/Projekte' }, draftForward: { uid: '12', folder: 'Archive' } })
})
