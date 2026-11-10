'use strict'
/**
 * Mail privacy unit tests — MP-1 … MP-13, plus MP-A1 (header address links)
 *
 * The "Privacy" section of frontend/dashboard.js (_mailPrivacyHtml & helpers) is
 * extracted by its comment markers and run with the real DOMPurify bundle in jsdom.
 */

const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')

let P

beforeAll(() => {
  const purifySrc = fs.readFileSync(path.join(FRONTEND, 'vendor-libs/purify.min.js'), 'utf8')
  const mod = { exports: {} }
  new Function('module', 'exports', purifySrc)(mod, mod.exports)
  const DOMPurify = mod.exports

  const src   = fs.readFileSync(path.join(FRONTEND, 'dashboard.js'), 'utf8')
  const start = src.indexOf('// ---- Privacy: remote images and tracking elements ----')
  const end   = src.indexOf('/** True when a mail has both an HTML')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  P = new Function('DOMPurify', 'SVGICONS', 'fetch', 'escHtml', `${src.slice(start, end)}
    return { _mailPrivacyHtml, _mailSenderAddr, _mailCsp, _mailTrackerTitle, _mailSenderTrusted, _mailTrustedBadgeHtml,
             setTrusted: list => { _mailTrusted = new Set(list) } };`)(DOMPurify, { shield: () => '', shieldCheck: () => '<svg/>' }, () => Promise.reject(new Error('no fetch')),
    s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'))
})

const imgCount = html => (html.match(/<img/g) || []).length

test('MP-1 normal remote image — blocked by default, kept when loading images', () => {
  const html = '<p>Hi</p><img src="https://cdn.shop.com/banner.jpg" width="600" height="200" alt="Sale">'
  const blocked = P._mailPrivacyHtml(html)
  expect(blocked.html).not.toMatch(/src(set)?="[^"]*cdn\.shop\.com/)   // only in the placeholder tooltip
  expect(blocked.html).toContain('title="Blocked: https://cdn.shop.com/banner.jpg"')
  expect(blocked.html).toContain('data-jc-blocked')
  expect(blocked.html).toContain('alt="Sale"')
  expect(blocked.blocked).toBe(1)
  expect(blocked.trackers).toEqual([])
  const loaded = P._mailPrivacyHtml(html, { loadImages: true })
  expect(loaded.html).toContain('src="https://cdn.shop.com/banner.jpg"')
  expect(loaded.blocked).toBe(0)
  expect(loaded.remote).toBe(1)   // still known as a mail with images
})

test('MP-2 1×1 / 0×0 pixels removed even when loading images; reported with host', () => {
  const html = '<img src="https://news.example.com/x.gif" width="1" height="1">'
    + '<img src="https://a.example.org/y.png" style="width:0px;height:0px">'
  for (const loadImages of [false, true]) {
    const r = P._mailPrivacyHtml(html, { loadImages })
    expect(imgCount(r.html)).toBe(0)
    expect(r.trackers.map(t => t.host)).toEqual(['news.example.com', 'a.example.org'])
    expect(r.trackers.map(t => t.reason)).toEqual(['1×1 pixel', 'invisible image'])
  }
})

test('MP-3 hidden images (own style or hidden ancestor) count as trackers', () => {
  const r = P._mailPrivacyHtml('<img src="https://x.com/a.png" style="display:none">'
    + '<div style="visibility:hidden"><img src="https://y.com/b.png" width="300"></div>', { loadImages: true })
  expect(imgCount(r.html)).toBe(0)
  expect(r.trackers.map(t => t.reason)).toEqual(['hidden image', 'hidden image'])
})

test('MP-4 known tracker hosts and tracking paths — removed regardless of size', () => {
  const r = P._mailPrivacyHtml(
    '<img src="https://shop.us1.list-manage.com/track/open.php?u=1" width="100" height="40">'
    + '<img src="https://trk.example.com/logo.png" width="100">'
    + '<img src="https://example.com/wf/open?upn=abc" width="100">'
    + '<img src="https://firebasestorage.googleapis.com/v0/b/x/o/logo.png" width="100">',
    { loadImages: true })
  expect(r.trackers.map(t => t.reason)).toEqual(['tracker host', 'tracker host', 'tracking URL'])
  // Legitimate image host with an /o/ path segment stays
  expect(r.html).toContain('firebasestorage.googleapis.com')
  expect(imgCount(r.html)).toBe(1)
})

test('MP-5 background attribute, srcset and inline-style url() blocked unless loading images', () => {
  const html = '<table background="https://x.com/bg.jpg"><tr><td style="background:url(\'https://x.com/td.png\') no-repeat">a</td></tr></table>'
    + '<img src="data:image/png;base64,AAAA" srcset="https://x.com/a@2x.png 2x">'
  const r = P._mailPrivacyHtml(html)
  expect(r.html).not.toContain('x.com')
  expect(r.html).toContain('background:none no-repeat')
  expect(r.html).toContain('src="data:image/png;base64,AAAA"')   // inline data: images always shown
  expect(r.blocked).toBe(3)   // background attr, style url, the <img> with a remote srcset
  expect(r.remote).toBe(3)
  const loaded = P._mailPrivacyHtml(html, { loadImages: true })
  expect(loaded.html).toContain('https://x.com/bg.jpg')
  expect(loaded.html).toContain('https://x.com/td.png')
})

test('MP-6 <style> — @import always dropped, remote url() only when blocked, tracker url() always', () => {
  const html = '<html><head><style>@import url("https://fonts.x.com/css");'
    + ' .hero{background:url(https://cdn.x.com/hero.jpg)} .t{background-image:url(https://pixel.x.com/o.gif)}</style></head><body><p class="hero">x</p></body></html>'
  const r = P._mailPrivacyHtml(html)
  expect(r.styles).not.toContain('@import')
  expect(r.styles).not.toContain('cdn.x.com')
  expect(r.trackers).toEqual([{ host: 'pixel.x.com', reason: 'CSS tracker host' }])
  expect(r.html).not.toContain('<style')
  const loaded = P._mailPrivacyHtml(html, { loadImages: true })
  expect(loaded.styles).not.toContain('@import')
  expect(loaded.styles).toContain('https://cdn.x.com/hero.jpg')
  expect(loaded.styles).not.toContain('pixel.x.com')
})

test('MP-7 links — ping stripped, rel noopener noreferrer added; scripts still sanitised', () => {
  const r = P._mailPrivacyHtml('<a href="https://x.com" ping="https://t.x.com/p">go</a><script>alert(1)</script>')
  expect(r.html).not.toContain('ping=')
  expect(r.html).toContain('rel="noopener noreferrer"')
  expect(r.html).not.toContain('<script')
})

test('MP-8 _mailCsp — remote images / fonts only for trusted senders, nothing else remote', () => {
  expect(P._mailCsp(false)).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: cid:; font-src data:")
  expect(P._mailCsp(true)).toContain('img-src data: blob: cid: https: http:')
  expect(P._mailCsp(true)).toContain("default-src 'none'")
})

test('MP-9 _mailSenderAddr / _mailSenderTrusted — bare lower-case address of From', () => {
  expect(P._mailSenderAddr({ from: '"Shop, Inc" <News@Shop.com>' })).toBe('news@shop.com')
  expect(P._mailSenderAddr({ from: 'news@shop.com' })).toBe('news@shop.com')
  expect(P._mailSenderAddr({ from: 'Nobody' })).toBe('')
  expect(P._mailSenderTrusted({ from: 'news@shop.com' })).toBe(false)
  P.setTrusted(['news@shop.com'])
  expect(P._mailSenderTrusted({ from: 'Shop <NEWS@shop.com>' })).toBe(true)
  expect(P._mailSenderTrusted({ from: 'other@shop.com' })).toBe(false)
})

test('MP-10 _mailTrackerTitle — grouped list with counts', () => {
  const t = P._mailTrackerTitle([
    { host: 'a.com', reason: '1×1 pixel' }, { host: 'a.com', reason: '1×1 pixel' }, { host: 'b.com', reason: 'tracker host' },
  ])
  expect(t).toBe('3 tracking elements blocked:\n• 1×1 pixel — a.com (×2)\n• tracker host — b.com')
})

test('MP-11 blockedUrls — every blocked URL once (img, srcset, background, CSS url / @import); placeholder tooltip', () => {
  const html = '<html><head><style>@import url("https://fonts.x.com/css"); .h{background:url(https://cdn.x.com/hero.jpg)}</style></head><body>'
    + '<img src="https://cdn.x.com/a.png" width="200" title="Logo"><img src="https://cdn.x.com/a.png" width="200">'
    + '<img src="data:image/png;base64,AA" srcset="https://cdn.x.com/a@2x.png 2x">'
    + '<table background="https://cdn.x.com/bg.jpg"><tr><td style="background:url(https://cdn.x.com/td.png)">x</td></tr></table>'
    + '<img src="https://t.x.com/p.gif" width="1" height="1"></body></html>'
  const r = P._mailPrivacyHtml(html)
  expect(r.blockedUrls.sort()).toEqual([
    'https://cdn.x.com/a.png', 'https://cdn.x.com/a@2x.png', 'https://cdn.x.com/bg.jpg',
    'https://cdn.x.com/hero.jpg', 'https://cdn.x.com/td.png', 'https://fonts.x.com/css',
  ])
  expect(r.blockedUrls).not.toContain('https://t.x.com/p.gif')   // trackers are listed by the shield instead
  expect(r.html).toContain('title="Blocked: https://cdn.x.com/a.png\nLogo"')
  expect(P._mailPrivacyHtml(html, { loadImages: true }).blockedUrls).toEqual(['https://fonts.x.com/css'])
})

test('MP-12 remote count — trackers and @import are not images; trusted badge hidden unless trusted', () => {
  const r = P._mailPrivacyHtml('<style>@import url(https://x.com/a.css);</style><p>Text</p><img src="https://t.x.com/o.gif" width="1" height="1">', { loadImages: true })
  expect(r.remote).toBe(0)
  expect(r.trackers).toHaveLength(1)
  expect(r.blockedUrls).toEqual(['https://x.com/a.css'])
  expect(P._mailPrivacyHtml('<p>plain</p>').remote).toBe(0)

  P.setTrusted(['news@shop.com'])
  expect(P._mailTrustedBadgeHtml({ from: 'Shop <news@shop.com>' })).toMatch(/^<span class="mail-trusted-badge" data-mail-sender="news@shop.com"[^>]*><svg\/><\/span>$/)
  expect(P._mailTrustedBadgeHtml({ from: 'other@shop.com' })).toContain(' hidden>')
  expect(P._mailTrustedBadgeHtml({ from: 'Nobody' })).toBe('')
})

test('MP-A1 _foldAddresses — "Name, Firstname" (quoted or not) is one link to the address', () => {
  const src = fs.readFileSync(path.join(FRONTEND, 'dashboard.js'), 'utf8')
  const a = src.indexOf('function _splitAddresses'), b = src.indexOf('function _openMailDetail')
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const { _foldAddresses, _mailDisplayName } = new Function('escHtml', `${src.slice(a, b)}; return { _foldAddresses, _mailDisplayName };`)(esc)
  // Focus mail panel sender name
  expect(_mailDisplayName('"Name, Firstname" <firstname.name@domain.com>')).toBe('Name, Firstname')
  expect(_mailDisplayName('Name, Firstname <firstname.name@domain.com>')).toBe('Name, Firstname')
  expect(_mailDisplayName('<x@y.de>')).toBe('x@y.de')
  expect(_mailDisplayName('plain@x.de')).toBe('plain@x.de')
  expect(_mailDisplayName('')).toBe('')
  const link = '<a href="mailto:firstname.name@domain.com" title="firstname.name@domain.com">Name, Firstname</a>'
  expect(_foldAddresses('"Name, Firstname" <firstname.name@domain.com>')).toBe(link)
  expect(_foldAddresses('Name, Firstname <firstname.name@domain.com>')).toBe(link)   // unquoted (older server)
  expect(_foldAddresses('"Doe, Jane" <j@x.de>, bob@x.de')).toBe('<a href="mailto:j@x.de" title="j@x.de">Doe, Jane</a>, <a href="mailto:bob@x.de">bob@x.de</a>')
})

test('MP-13 image attachments — shown below the body only for trusted senders, follow trust changes', async () => {
  const src = fs.readFileSync(path.join(FRONTEND, 'dashboard.js'), 'utf8')
  const a = src.indexOf('// ---- Image attachments of trusted senders'), b = src.indexOf('/** True when a mail has both an HTML')
  const fetched = []
  const fetchMock = async url => {
    fetched.push(url)
    if (url.endsWith('bad')) return { ok: false, status: 404 }
    return { ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) }
  }
  const URLshim = { createObjectURL: () => `blob:${fetched.length}`, revokeObjectURL: () => {} }
  const G = new Function('DOMPurify', 'SVGICONS', 'fetch', 'escHtml', '_attachType', 'URL', `${src.slice(a, b)}
    return { _mailAppendGallery, _mailSyncTrustedBadges, setTrusted: list => { _mailTrusted = new Set(list) } };`)(
    null, {}, fetchMock, s => s, n => /\.(png|jpe?g|gif)$/i.test(n) ? 'image' : 'other', URLshim)
  const flush = () => new Promise(r => setTimeout(r, 0))

  const msg = { from: 'Shop <news@shop.com>', attachments: [
    { name: 'photo.jpg', part: '2' }, { name: 'doc.pdf', part: '3' }, { name: 'scan.png', part: 'bad' },
  ] }
  const opened = []
  const att = { url: x => `/att/${x.part}`, open: x => opened.push(x.name) }

  G.setTrusted([])
  const box = document.createElement('div'); document.body.appendChild(box)
  G._mailAppendGallery(box, msg, att)
  const gal = box.querySelector('.mail-att-gallery')
  expect(gal.hidden).toBe(true)
  expect(fetched).toEqual([])                       // untrusted: nothing fetched

  G.setTrusted(['news@shop.com']); G._mailSyncTrustedBadges(); await flush()
  expect(gal.hidden).toBe(false)
  expect([...gal.querySelectorAll('figcaption')].map(f => f.textContent)).toEqual(['photo.jpg', 'scan.png — could not be loaded'])
  expect(fetched).toEqual(['/att/2', '/att/bad'])   // only images, not the PDF
  expect(gal.querySelector('img').getAttribute('src')).toMatch(/^blob:/)
  gal.querySelector('.mail-att-img').click()
  expect(opened).toEqual(['photo.jpg'])

  G.setTrusted([]); G._mailSyncTrustedBadges()
  expect(gal.hidden).toBe(true)
  expect(gal.children).toHaveLength(0)

  // No image attachments / no attachment handlers → no gallery at all
  const box2 = document.createElement('div')
  G._mailAppendGallery(box2, { from: 'a@b.c', attachments: [{ name: 'x.pdf', part: '2' }] }, att)
  G._mailAppendGallery(box2, msg, null)
  expect(box2.children).toHaveLength(0)
})
