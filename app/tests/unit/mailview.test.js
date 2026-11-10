'use strict'
/**
 * Mail view unit tests — MV-1 … MV-18
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
  // Left swipe reveals Move + Delete (128 px), right swipe Mark read (64 px)
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
  expect(html.endsWith('a &lt; b')).toBe(true)
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
