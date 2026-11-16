'use strict'
/**
 * Mail view unit tests — MV-1 … MV-24
 *
 * mailview.js is loaded via vm.runInContext with minimal browser-global stubs.
 * Only the pure helpers are exercised (folder tree, addresses, reply fields, URL state).
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
    DOMPurify: { sanitize: html => html.replace(/<script[\s\S]*?<\/script>/gi, '') },
    escHtml:   s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    // dashboard.js globals (privacy filter): record the calls, strip remote images when not trusted
    _mailSenderTrusted: msg => msg.from === 'trusted@ex.com',
    _mailImagesAllowed: msg => msg.from === 'trusted@ex.com' || !!msg._jcLoadImages,
    _mailPrivacyHtml:   (html, { loadImages }) => ({ html: loadImages ? html : html.replace(/<img[^>]*>/gi, '') }),
    Intl, Date, Math, JSON, Object, Array, String, Number, Set, Map, URL, URLSearchParams,
    setTimeout: noop, clearTimeout: noop,
  })
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'mailview.js'), 'utf8'), ctx)
})

const plain = v => JSON.parse(JSON.stringify(v))
const f = (p, extra = {}) => ({ path: p, name: p.split(extra.delimiter || '/').pop(), delimiter: '/', ...extra })

test('MV-1 _mvBuildTree — nesting by delimiter, inbox + special folders first, then by name', () => {
  const tree = ctx._mvBuildTree([
    f('zeta'), f('Archive', { specialUse: '\\Archive' }), f('alpha'),
    f('Trash', { specialUse: '\\Trash' }), f('INBOX'), f('INBOX/Sub'), f('INBOX/Sub/Deep'),
    f('Sent', { specialUse: '\\Sent' }),
  ])
  expect(tree.map(n => n.folder.path)).toEqual(['INBOX', 'Sent', 'Archive', 'Trash', 'alpha', 'zeta'])
  expect(tree[0].children[0].folder.path).toBe('INBOX/Sub')
  expect(tree[0].children[0].children[0].folder.path).toBe('INBOX/Sub/Deep')
})

test('MV-2 _mvBuildTree — "." delimiter; orphans (missing parent) become roots', () => {
  const tree = ctx._mvBuildTree([
    f('INBOX', { delimiter: '.' }), f('INBOX.Lists', { delimiter: '.', name: 'Lists' }),
    f('Old.2020', { delimiter: '.', name: '2020' }),
  ])
  expect(tree.map(n => n.folder.path)).toEqual(['INBOX', 'Old.2020'])
  expect(tree[0].children.map(n => n.folder.path)).toEqual(['INBOX.Lists'])
  expect(ctx._mvLeafName('INBOX.Lists', '.')).toBe('Lists')
  expect(ctx._mvParentPath({ path: 'INBOX.Lists', delimiter: '.' })).toBe('INBOX')
  expect(ctx._mvParentPath({ path: 'INBOX', delimiter: '.' })).toBe('')
})

test('MV-3 _mvSubtreeUnseen — sums descendants but not Trash / Junk below the top', () => {
  const [inbox] = ctx._mvBuildTree([
    f('INBOX', { unseen: 2 }), f('INBOX/A', { unseen: 3 }), f('INBOX/A/B', { unseen: 1 }),
    f('INBOX/Trash', { specialUse: '\\Trash', unseen: 9 }),
  ])
  expect(ctx._mvSubtreeUnseen(inbox)).toBe(6)
})

test('MV-4 _mvSplitAddrs / _mvAddrOf / _mvDisplayName — quoted commas and angle brackets', () => {
  const list = ctx._mvSplitAddrs('"Doe, Jane" <jane@ex.com>, bob@ex.com; Carol <Carol@Ex.com>')
  expect(plain(list)).toEqual(['"Doe, Jane" <jane@ex.com>', 'bob@ex.com', 'Carol <Carol@Ex.com>'])
  expect(ctx._mvAddrOf(list[2])).toBe('carol@ex.com')
  expect(ctx._mvAddrOf('bob@ex.com')).toBe('bob@ex.com')
  expect(ctx._mvDisplayName('"Doe, Jane" <jane@ex.com>')).toBe('Doe, Jane')
  expect(ctx._mvDisplayName('<x@ex.com>')).toBe('x@ex.com')
  expect(ctx._mvDisplayName('')).toBe('')
})

test('MV-5 _mvReplySubject — adds Re: once, recognises AW:', () => {
  expect(ctx._mvReplySubject('Plan')).toBe('Re: Plan')
  expect(ctx._mvReplySubject('RE: Plan')).toBe('RE: Plan')
  expect(ctx._mvReplySubject('AW: Plan')).toBe('AW: Plan')
  expect(ctx._mvReplySubject('')).toBe('Re: ')
})

test('MV-6 _mvReplyFields — reply vs. reply all; own addresses and duplicates dropped; references chained', () => {
  const msg = {
    from: 'Bob <bob@ex.com>', replyTo: '', subject: 'Plan',
    to: 'me@ex.com, Alice <alice@ex.com>, bob@ex.com', cc: 'carol@ex.com, ME@ex.com',
    messageId: '<m2@ex.com>', references: ['<m1@ex.com>'],
  }
  const one = ctx._mvReplyFields(msg, false, ['me@ex.com'])
  expect(plain(one)).toEqual({
    to: 'Bob <bob@ex.com>', cc: '', subject: 'Re: Plan',
    inReplyTo: '<m2@ex.com>', references: ['<m1@ex.com>', '<m2@ex.com>'],
  })
  const all = ctx._mvReplyFields(msg, true, ['me@ex.com'])
  expect(all.to).toBe('Bob <bob@ex.com>, Alice <alice@ex.com>')
  expect(all.cc).toBe('carol@ex.com')

  // Reply-To wins over From
  expect(ctx._mvReplyFields({ ...msg, replyTo: 'list@ex.com' }, false, []).to).toBe('list@ex.com')
  // Answering one's own sent mail goes to its recipients
  expect(ctx._mvReplyFields({ from: 'me@ex.com', to: 'bob@ex.com', subject: 'x' }, false, ['me@ex.com']).to).toBe('bob@ex.com')
})

test('MV-7 _mvQuoteHtml — plain text escaped, HTML sanitised, inside a blockquote', () => {
  const q = ctx._mvQuoteHtml({ from: 'Bob <bob@ex.com>', date: null, body: 'a < b\nline 2' })
  expect(q).toContain('Bob &lt;bob@ex.com&gt; wrote:')
  expect(q).toContain('<blockquote type="cite">a &lt; b<br>line 2</blockquote>')
  const h = ctx._mvQuoteHtml({ from: 'x', bodyHtml: '<p>ok</p><script>alert(1)</script>' })
  expect(h).toContain('<p>ok</p>')
  expect(h).not.toContain('<script')
})

test('MV-14 _mvOriginalHtml — quoting goes through the privacy filter (remote images only for trusted senders)', () => {
  const html = '<p>hi</p><img src="https://ex.com/a.png">'
  expect(ctx._mvQuoteHtml({ from: 'x@ex.com', bodyHtml: html })).not.toContain('<img')
  expect(ctx._mvQuoteHtml({ from: 'trusted@ex.com', bodyHtml: html })).toContain('<img src="https://ex.com/a.png">')
  // "Load images" ticked for this mail only → its quote keeps the images too
  expect(ctx._mvQuoteHtml({ from: 'x@ex.com', bodyHtml: html, _jcLoadImages: true })).toContain('<img src="https://ex.com/a.png">')
})

test('MV-15 _mvParseSenders / _mvReplySender — comma list, first is default, reply uses the address written to', () => {
  expect(plain(ctx._mvParseSenders('a@x.de, Bob <B@x.de>, a@x.de', 'user@x.de'))).toEqual(['a@x.de', 'b@x.de'])
  expect(plain(ctx._mvParseSenders('', 'User@x.de'))).toEqual(['user@x.de'])
  expect(plain(ctx._mvParseSenders('', ''))).toEqual([])
  const senders = ['a@x.de', 'b@x.de']
  expect(ctx._mvReplySender({ to: 'Me <B@x.de>', cc: '' }, senders)).toBe('b@x.de')
  expect(ctx._mvReplySender({ to: 'other@y.de', cc: 'b@x.de' }, senders)).toBe('b@x.de')
  expect(ctx._mvReplySender({ to: 'list@y.de' }, senders)).toBe('a@x.de')
  expect(ctx._mvReplySender({}, [])).toBe('')
  // Reply all drops every own sender address
  const all = ctx._mvReplyFields({ from: 'bob@y.de', to: 'a@x.de, b@x.de, carol@y.de', subject: 's' }, true, ['user@x.de', ...senders])
  expect(all.to).toBe('bob@y.de, carol@y.de')
})

test('MV-16 _mvSwipeSnap — opens past half of an action area, otherwise closes', () => {
  // e.g. left swipe Move + Delete (128 px), right swipe Mark read (64 px)
  expect(ctx._mvSwipeSnap(-70, 64, 128)).toBe(-128)
  expect(ctx._mvSwipeSnap(-60, 64, 128)).toBe(0)
  expect(ctx._mvSwipeSnap(-300, 64, 128)).toBe(-128)
  expect(ctx._mvSwipeSnap(40, 64, 128)).toBe(64)
  expect(ctx._mvSwipeSnap(20, 64, 128)).toBe(0)
  expect(ctx._mvSwipeSnap(0, 64, 128)).toBe(0)
  // No action area on a side → that side never opens
  expect(ctx._mvSwipeSnap(-90, 64, 0)).toBe(0)
})

test('MV-17 quoted display names — commas and \\" escapes stay inside one entry', () => {
  const list = ctx._mvSplitAddrs('"Name, Firstname" <firstname.name@domain.com>, "Say \\"Hi\\", Bob" <b@x.de>')
  expect(list).toHaveLength(2)
  expect(ctx._mvDisplayName(list[0])).toBe('Name, Firstname')
  expect(ctx._mvAddrOf(list[0])).toBe('firstname.name@domain.com')
  expect(ctx._mvDisplayName(list[1])).toBe('Say "Hi", Bob')
  // Unquoted (older server): merged back into one quoted entry
  expect(plain(ctx._mvSplitAddrs('Name, Firstname <f.n@d.com>, bob@x.de'))).toEqual(['"Name, Firstname" <f.n@d.com>', 'bob@x.de'])
  expect(ctx._mvDisplayName('Name, Firstname <f.n@d.com>')).toBe('Name, Firstname')
  // Plain address lists are untouched
  expect(plain(ctx._mvSplitAddrs('a@x.de, Bob <b@x.de>'))).toEqual(['a@x.de', 'Bob <b@x.de>'])
})

test('MV-18 _mvMailtoAddr — header link → bare lower-case address', () => {
  expect(ctx._mvMailtoAddr('mailto:Firstname.Name@Domain.com')).toBe('firstname.name@domain.com')
  expect(ctx._mvMailtoAddr('mailto:a%2Bb@x.de?subject=Hi')).toBe('a+b@x.de')
  expect(ctx._mvMailtoAddr('https://x.de')).toBe('')
  expect(ctx._mvMailtoAddr(null)).toBe('')
})

test('MV-8 _mvParseUrl / _mvFmtSize / _mvFolderLabel', () => {
  expect(ctx._mvParseUrl('?cal=week')).toBeNull()
  expect(plain(ctx._mvParseUrl('?mail=ma-1&folder=INBOX%2FSub'))).toEqual({ accountId: 'ma-1', folder: 'INBOX/Sub', mid: null })
  expect(plain(ctx._mvParseUrl('?mail='))).toEqual({ accountId: null, folder: 'INBOX', mid: null })
  expect(plain(ctx._mvParseUrl('?mail=ma-1&folder=Archive&mid=%3Cabc%40ex.com%3E'))).toEqual({ accountId: 'ma-1', folder: 'Archive', mid: '<abc@ex.com>' })
  expect(ctx._mvFmtSize(0)).toBe('')
  expect(ctx._mvFmtSize(512)).toBe('512 B')
  expect(ctx._mvFmtSize(48213)).toBe('47 KB')
  expect(ctx._mvFmtSize(5 * 1024 * 1024)).toBe('5.0 MB')
  expect(ctx._mvFmtSize(3 * 1024 ** 3)).toBe('3.00 GB')
  expect(ctx._mvFolderLabel({ path: 'INBOX', name: 'INBOX' })).toBe('Inbox')
  expect(ctx._mvFolderLabel({ path: 'A/B', name: 'B' })).toBe('B')
})

test('MV-9 _mvClampWidths — minimums kept, folders + list ≤ half the width (list gives way first)', () => {
  expect(plain(ctx._mvClampWidths({ folders: 210, list: 340 }, 1400))).toEqual({ folders: 210, list: 340 })
  // Too wide together: list shrinks to the remaining half
  expect(plain(ctx._mvClampWidths({ folders: 300, list: 600 }, 1400))).toEqual({ folders: 300, list: 400 })
  // Folders alone too wide: capped so the list keeps its minimum
  expect(plain(ctx._mvClampWidths({ folders: 900, list: 340 }, 1400))).toEqual({ folders: 520, list: 180 })
  // Below the minimums
  expect(plain(ctx._mvClampWidths({ folders: 10, list: 10 }, 1400))).toEqual({ folders: 120, list: 180 })
})

test('MV-10 _mvForwardSubject / _mvForwardHtml — Fwd: once; header block + original body', () => {
  expect(ctx._mvForwardSubject('Report')).toBe('Fwd: Report')
  expect(ctx._mvForwardSubject('FW: Report')).toBe('FW: Report')
  expect(ctx._mvForwardSubject('WG: Bericht')).toBe('WG: Bericht')
  const html = ctx._mvForwardHtml({ from: 'Bob <bob@ex.com>', subject: 'Report', to: 'me@ex.com', cc: '', date: null, body: 'a < b' })
  expect(html).toContain('-------- Forwarded message --------')
  expect(html).toContain('From: Bob &lt;bob@ex.com&gt;<br>Subject: Report<br>To: me@ex.com</p>')
  expect(html).not.toContain('Cc:')
  expect(html).not.toContain('Date:')
  expect(html.endsWith('<div>a &lt; b</div>')).toBe(true)   // original in its own block: keeps its own spacing
})

test('MV-11 _mvIsEmptyable — special use, configured trash or well-known names only', () => {
  expect(ctx._mvIsEmptyable({ path: 'X', name: 'X', specialUse: '\\Trash' })).toBe(true)
  expect(ctx._mvIsEmptyable({ path: 'X', name: 'X', specialUse: '\\Junk' })).toBe(true)
  for (const name of ['Spam', 'Trash', 'Gelöschte Elemente', 'Junk-E-Mail', 'Deleted Items', 'Papierkorb']) {
    expect(ctx._mvIsEmptyable({ path: `INBOX/${name}`, name })).toBe(true)
  }
  expect(ctx._mvIsEmptyable({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' })).toBe(false)
  expect(ctx._mvIsEmptyable({ path: 'Trash notes', name: 'Trash notes' })).toBe(false)
  expect(ctx._mvIsEmptyable({ path: 'Ablage', name: 'Ablage' }, 'Ablage')).toBe(true)
})

test('MV-12 _mvRangeIds — inclusive range in list order, either direction', () => {
  const ids = ['9', '8', '7', '6', '5']
  expect(plain(ctx._mvRangeIds(ids, '8', '6'))).toEqual(['8', '7', '6'])
  expect(plain(ctx._mvRangeIds(ids, '5', '8'))).toEqual(['8', '7', '6', '5'])
  expect(plain(ctx._mvRangeIds(ids, '7', '7'))).toEqual(['7'])
  expect(plain(ctx._mvRangeIds(ids, 'gone', '6'))).toEqual(['6'])
  expect(plain(ctx._mvRangeIds(ids, '8', 'gone'))).toEqual([])
})

describe('MV-13 _mvOpenByMessageId — hint folder first, then a cancellable search of all folders', () => {
  // Fresh context: the navigation helpers are replaced with recorders
  function load(responses) {
    const noop = () => {}
    const log = { urls: [], progress: [], closed: 0, messages: [], selected: [], opened: [] }
    let cancel
    const c = vm.createContext({
      document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      window:   { addEventListener: noop, location: { href: 'http://x/focus', search: '' } },
      history:  { pushState: noop, replaceState: noop, back: noop },
      localStorage: { getItem: () => null, setItem: noop },
      Intl, Date, Math, JSON, Object, Array, String, Number, Set, Map, URL, URLSearchParams, Promise, Error, AbortController,
      setTimeout: noop, clearTimeout: noop,
      fetch: async (url, opts) => {
        log.urls.push(url)
        const r = responses.shift()
        if (r === 'hang') return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
        return { ok: r.status === 200, status: r.status, json: async () => r.body }
      },
      showProgress: msg => { log.progress.push(msg); return { cancelled: new Promise(res => { cancel = res }), close: () => { log.closed++ } } },
      showMessage:  msg => { log.messages.push(msg) },
    })
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'mailview.js'), 'utf8'), c)
    vm.runInContext(`_mvIsOpen = () => true; _mvAccountId = 'a1'; _mvFolder = 'INBOX';
      _mvSelectFolder = (acc, f) => { __log.selected.push(f); _mvFolder = f; };
      _mvOpenMessage  = uid => { __log.opened.push(uid); };`, Object.assign(c, { __log: log }))
    return { c, log, cancel: () => cancel() }
  }

  test('found in the hint folder — no dialog', async () => {
    const { c, log } = load([{ status: 200, body: { folder: 'INBOX', uid: '5' } }])
    await c._mvOpenByMessageId('a1', '<m@x>', 'INBOX')
    expect(log.urls[0]).toContain('scope=hint')
    expect(log.progress).toEqual([])
    expect(log.opened).toEqual(['5'])
  })

  test('moved — progress dialog, full search, opens the new folder', async () => {
    const { c, log } = load([{ status: 404, body: { error: 'Message not found (deleted?)' } }, { status: 200, body: { folder: 'INBOX.Sub', uid: '9' } }])
    await c._mvOpenByMessageId('a1', '<m@x>', 'INBOX')
    expect(log.urls[1]).not.toContain('scope=')
    expect(log.progress).toHaveLength(1)
    expect(log.closed).toBe(1)
    expect(log.selected).toEqual(['INBOX.Sub'])
    expect(log.opened).toEqual(['9'])
  })

  test('not found anywhere — information dialog', async () => {
    const { c, log } = load([{ status: 404, body: { error: 'Message not found (deleted?)' } }, { status: 404, body: { error: 'Message not found (deleted?)' } }])
    await c._mvOpenByMessageId('a1', '<m@x>', 'INBOX')
    expect(log.messages[0]).toMatch(/could not be found/)
    expect(log.opened).toEqual([])
  })

  test('cancelled — search aborted, nothing opened, no message', async () => {
    const { c, log, cancel } = load([{ status: 404, body: { error: 'Message not found (deleted?)' } }, 'hang'])
    const p = c._mvOpenByMessageId('a1', '<m@x>', 'INBOX')
    await new Promise(r => setImmediate(r))
    cancel()
    await p
    expect(log.messages).toEqual([])
    expect(log.opened).toEqual([])
  })
})

test('MV-19 _mvDuplicateIds — loaded copies with the same sender, To, subject, date and size; lowest UID is the original', () => {
  const m = (id, extra = {}) => ({ id, from: 'Jane <Jane@ex.com>', to: 'me@ex.com, "Doe, Bob" <bob@ex.com>', subject: 'Hi',
                                   date: '2026-11-01T10:00:00.000Z', size: 100, ...extra })
  const dupes = ctx._mvDuplicateIds([
    m('9'), m('3'), m('12'),                                  // newest first in the list: 3 is the original
    m('20', { from: 'jane@ex.com' }),                         // same address without name → duplicate
    m('21', { to: 'bob@ex.com, me@ex.com' }),                 // same recipients, other order → duplicate
    m('22', { subject: 'Re: Hi' }), m('23', { size: 101 }), m('24', { date: '2026-11-01T10:00:01.000Z' }),
    m('25', { to: 'me@ex.com' }),
  ])
  expect([...dupes].sort()).toEqual(['12', '20', '21', '9'])
  expect(ctx._mvDuplicateIds([m('1'), m('2', { subject: 'x' })]).size).toBe(0)
  // Same Message-ID: size ignored, the largest copy is the original
  const withId = (id, size) => m(id, { messageId: '<a1@ex.com>', size })
  expect([...ctx._mvDuplicateIds([withId('5', 4000), withId('6', 250000), withId('7', 250032)])].sort()).toEqual(['5', '6'])
})

test('MV-20 _mvListOptsQs / _mvListFiltered — sort, local-day date filters, attachments, duplicates', () => {
  const iso = (y, m, d) => encodeURIComponent(new Date(y, m - 1, d).toISOString())
  const qs = o => ctx._mvListOptsQs({ sort: 'date', range: '', from: '', to: '', attachments: false, ...o })
  expect(qs({})).toBe('')
  expect(qs({ sort: 'date-asc' })).toBe('&sort=date-asc')
  expect(qs({ sort: 'from', attachments: true })).toBe('&sort=from&attachments=1')
  expect(qs({ duplicates: true })).toBe('&duplicates=1')
  expect(ctx._mvListFiltered({ sort: 'date', duplicates: true })).toBe(true)
  // newer than = from the following day on; older than = before that day
  expect(qs({ range: 'newer', from: '2026-03-10' })).toBe(`&since=${iso(2026, 3, 11)}`)
  expect(qs({ range: 'older', from: '2026-03-10' })).toBe(`&before=${iso(2026, 3, 10)}`)
  // between: both days included, reversed ends swapped, one open end allowed
  expect(qs({ range: 'between', from: '2026-03-10', to: '2026-03-12' })).toBe(`&since=${iso(2026, 3, 10)}&before=${iso(2026, 3, 13)}`)
  expect(qs({ range: 'between', from: '2026-03-12', to: '2026-03-10' })).toBe(`&since=${iso(2026, 3, 10)}&before=${iso(2026, 3, 13)}`)
  expect(qs({ range: 'between', to: '2026-03-12' })).toBe(`&before=${iso(2026, 3, 13)}`)
  // a range without a date filters nothing
  expect(qs({ range: 'older' })).toBe('')
  expect(ctx._mvListFiltered({ sort: 'from', range: 'older', from: '' })).toBe(false)
  expect(ctx._mvListFiltered({ sort: 'date', attachments: true })).toBe(true)
})

describe('MV-21 read after 5 s alone; Ctrl+A selects all; multi-selections are never marked read', () => {
  function load() {
    const noop = () => {}
    const timers = []
    const log = { unread: [] }
    const c = vm.createContext({
      document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      window:   { addEventListener: noop, location: { href: 'http://x/today', search: '' } },
      history:  { pushState: noop, replaceState: noop, back: noop },
      localStorage: { getItem: () => null, setItem: noop },
      Intl, Date, Math, JSON, Object, Array, String, Number, Set, Map, URL, URLSearchParams, Promise,
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
      clearTimeout: t => { if (t) t.cleared = true },
      __log: log,
    })
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'mailview.js'), 'utf8'), c)
    vm.runInContext(`_mvIsOpen = () => true; _mvAccountId = 'a1'; _mvFolder = 'INBOX';
      _mvMsgs = [{ id: '1', unread: true }, { id: '2', unread: true }, { id: '3', unread: false }];
      _mvRenderListSelection = () => {}; _mvRenderReader = () => {}; _mvSetPane = () => {};
      _mvJson = () => new Promise(() => {});
      _mvSetUnread = (ids, unread) => { __log.unread.push([ids, unread]); };`, c)
    const run = () => timers.filter(t => !t.cleared && !t.ran).forEach(t => { t.ran = true; t.fn() })
    return { c, log, timers, run, ev: (o = {}) => ({ shiftKey: false, ctrlKey: false, metaKey: false, ...o }) }
  }

  test('opening an unread message marks it read only after 5 s', () => {
    const { c, log, timers, run } = load()
    c._mvOpenMessage('1')
    expect(log.unread).toEqual([])
    expect(timers.at(-1).ms).toBe(5000)
    run()
    expect(log.unread).toEqual([[['1'], false]])
  })

  test('moving on within 5 s leaves the message unread; already read ones get no timer', () => {
    const { c, log, run } = load()
    c._mvOpenMessage('1')
    c._mvOpenMessage('3')
    run()
    expect(log.unread).toEqual([])
    c._mvOpenMessage('2')
    run()
    expect(log.unread).toEqual([[['2'], false]])
  })

  test('Shift / Ctrl+click and Ctrl+A cancel the read; Ctrl+A selects every listed message', () => {
    const { c, log, run, ev } = load()
    c._mvOpenMessage('1')
    c._mvClickMessage(ev({ ctrlKey: true }), '2')
    run()
    expect(log.unread).toEqual([])

    c._mvOpenMessage('2')
    c._mvSelectAll()
    expect(vm.runInContext('[..._mvChecked]', c)).toEqual(['1', '2', '3'])
    run()
    expect(log.unread).toEqual([])
  })

  test('switching the folder cancels the pending read', () => {
    const { c, log, run } = load()
    c._mvOpenMessage('1')
    vm.runInContext(`_mvRenderTree = () => {}; _mvRenderToolbar = () => {}; _mvRenderList = () => {};
      _mvLoadList = () => {}; _mvLoadFolderSize = () => {}; _mvSetUrl = () => {};`, c)
    c._mvSelectFolder('a1', 'Archive')
    run()
    expect(log.unread).toEqual([])
  })
})

// ---- Conversations ----

/** INBOX conversation: a (1) ← b (Sent 5, foreign) ← c (2), plus a missing message with two replies; and a single mail. */
function _threads() {
  const msg = (id, folder, depth, date, extra = {}) => ({ id, folder, depth, date: `2026-11-0${date}T10:00:00Z`, foreign: folder !== 'INBOX', subject: 'Re: Plan', from: 'jane@ex.com', ...extra })
  return [
    { id: 'm:<a>', messages: [
      msg('1', 'INBOX', 0, 1, { subject: 'Plan' }), msg('5', 'Sent', 1, 2), msg('2', 'INBOX', 2, 3, { unread: true }),
      { placeholder: true, node: 'm:<y>', depth: 1 }, msg('7', 'INBOX', 2, 4),
    ] },
    { id: 'm:<z>', messages: [msg('3', 'INBOX', 0, 2)] },
    { id: 'm:<o>', messages: [msg('8', 'Archive', 0, 1)] },   // nothing in this folder: no row
  ]
}

test('MV-22 _mvThreadRows — collapsed: one row per conversation (its first message); open: the further messages below it (root not repeated), other folders and gaps', () => {
  const threads = _threads()
  const shut = plain(ctx._mvThreadRows(threads, () => false).map(r => [r.kind, r.msg?.id, r.open]))
  expect(shut).toEqual([['thread', '1', false], ['msg', '3', null]])
  const open = ctx._mvThreadRows(threads, t => t.id === 'm:<a>')
  expect(plain(open.map(r => [r.kind, r.msg?.id ?? null, r.depth, !!r.child]))).toEqual([
    ['thread', '1', 0, false], ['msg', '5', 1, true], ['msg', '2', 2, true],
    ['gap', null, 1, true], ['msg', '7', 2, true], ['msg', '3', 0, false],
  ])
  expect(plain(ctx._mvThreadChron(threads[0].messages).map(m => m.id))).toEqual(['1', '5', '2', '7'])
  expect(ctx._mvBareSubject('Re: AW: Fwd: Plan')).toBe('Plan')
  expect(ctx._mvBareSubject('Re[2]: ')).toBe('(no subject)')
})

test('MV-23 conversation mode — a collapsed row stands for its messages here (selection, actions); open ones for one; keyboard rows', () => {
  vm.runInContext(`
    _mvFolder = 'INBOX';
    _mvOpts = { ..._mvDefaultListOpts(), threads: true };
    _mvThreads = __threads;
    _mvMsgs = _mvThreads.flatMap(t => t.messages.filter(m => !m.placeholder && !m.foreign));
    _mvTOpen = new Map();
    _mvChecked = new Set(['1']);
    _mvSelId = '1';
  `, Object.assign(ctx, { __threads: _threads() }))
  expect(plain(ctx._mvSelectedIds())).toEqual(['1', '2', '7'])
  expect(plain(ctx._mvRowIds('3'))).toEqual(['3'])
  expect(plain(ctx._mvNavRows())).toEqual([{ id: '1', folder: 'INBOX' }, { id: '3', folder: 'INBOX' }])

  vm.runInContext(`_mvTOpen.set('m:<a>', true)`, ctx)
  expect(plain(ctx._mvSelectedIds())).toEqual(['1'])
  // Open: every message is a row of its own — the one in Sent too (opened in its folder)
  expect(plain(ctx._mvNavRows().map(r => `${r.folder}/${r.id}`))).toEqual(['INBOX/1', 'Sent/5', 'INBOX/2', 'INBOX/7', 'INBOX/3'])
  expect(ctx._mvFindListed('5', 'Sent').folder).toBe('Sent')
  expect(ctx._mvFindListed('5')).toBe(null)
  // Filtered lists open conversations by default
  vm.runInContext(`_mvTOpen = new Map(); _mvQuery = 'plan'`, ctx)
  expect(ctx._mvThreadOpen(ctx.__threads[0])).toBe(true)
  vm.runInContext(`_mvQuery = ''; _mvOpts = _mvDefaultListOpts()`, ctx)
  expect(ctx._mvListOptsQs({ threads: true })).toBe('&threads=1')
  expect(ctx._mvListFiltered({ threads: true })).toBe(false)
})

test('MV-24 _mvTreeMovePlan — a message moves with its replies (any folder); nested anchors count as replies; target folder stays', () => {
  const threads = _threads()
  const plan = (anchors, target = 'Archive') => plain(ctx._mvTreeMovePlan(threads, anchors, target))
  const ids = p => p.items.map(m => `${m.folder}/${m.id}`)
  const root = plan([{ id: '1', folder: 'INBOX' }])
  expect(ids(root)).toEqual(['INBOX/1', 'Sent/5', 'INBOX/2', 'INBOX/7'])
  expect([root.anchors, root.replies]).toEqual([1, 3])
  // A reply's subtree ends at the next entry that is not deeper (here the gap of the other branch)
  const mid = plan([{ id: '5', folder: 'Sent' }])
  expect([ids(mid), mid.replies]).toEqual([['Sent/5', 'INBOX/2'], 1])
  // Already in the target: stays
  expect(ids(plan([{ id: '1', folder: 'INBOX' }], 'Sent'))).toEqual(['INBOX/1', 'INBOX/2', 'INBOX/7'])
  // Anchor inside another anchor's subtree = reply; a message without conversation moves alone
  const both = plan([{ id: '2', folder: 'INBOX' }, { id: '1', folder: 'INBOX' }, { id: '99', folder: 'INBOX' }])
  expect([both.items.length, both.anchors, both.replies]).toEqual([5, 2, 3])
  expect(plan([{ id: '7', folder: 'INBOX' }]).replies).toBe(0)
})

test('MV-25 list rows — answered / forwarded icons only outside conversation mode (the reply tree shows that there)', () => {
  const m = { id: '9', subject: 'Plan', from: 'Jane <jane@ex.com>', date: '2026-01-05T10:00:00Z', answered: true, forwarded: true }
  ctx._mailTrustedBadgeHtml = () => ''   // dashboard.js global
  ctx._mailFlagHtml = () => ''
  vm.runInContext(`_mvFolder = 'INBOX'; _mvOpts = _mvDefaultListOpts()`, ctx)
  const flat = ctx._mvListItemHtml(m, new Set())
  expect(flat).toContain('title="Answered"')
  expect(flat).toContain('title="Forwarded"')
  vm.runInContext(`_mvOpts = { ..._mvDefaultListOpts(), threads: true }`, ctx)
  const grouped = ctx._mvListItemHtml(m, new Set())
  expect(grouped).not.toContain('mv-msg-answered')
  vm.runInContext(`_mvOpts = _mvDefaultListOpts()`, ctx)
})
