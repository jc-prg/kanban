'use strict'
/**
 * Mail HTML → Markdown unit tests — MD-1 … MD-9
 *
 * frontend/mail-markdown.js (used when a card is created from an HTML mail) runs in jsdom;
 * the result is also rendered with the real marked bundle to check it reads like the mail.
 */

const fs   = require('fs')
const path = require('path')

const FRONTEND = path.resolve(__dirname, '../../frontend')

let md, imagesMd, marked

beforeAll(() => {
  const src = fs.readFileSync(path.join(FRONTEND, 'mail-markdown.js'), 'utf8')
  ;({ md, imagesMd } = new Function('DOMParser', `${src}\nreturn { md: _mailHtmlToMarkdown, imagesMd: _mailImageAttachmentsMd };`)(DOMParser))
  const markedSrc = fs.readFileSync(path.join(FRONTEND, 'vendor-libs/marked.min.js'), 'utf8')
  const mod = { exports: {} }
  new Function('module', 'exports', 'define', markedSrc)(mod, mod.exports, undefined)
  marked = mod.exports.marked || mod.exports
})

test('MD-1 paragraphs, line breaks, bold / italic / strike, whitespace collapsed', () => {
  const out = md(`<div>Hello   <b>Anna</b>,</div><p>first line<br>second <i>line</i>
    with <s>old</s> text</p><p>&nbsp;</p><div><br></div><p>Bye</p>`)
  expect(out).toBe('Hello **Anna**,\n\nfirst line  \nsecond *line* with ~~old~~ text\n\nBye')
})

test('MD-2 links: text + URL, bare URLs as autolinks, mailto, javascript dropped, linked images left out', () => {
  const out = md(`<p><a href="https://ex.com/a b?x=(1)">the offer</a> · <a href="https://ex.com">https://ex.com</a>
    · <a href="mailto:a@ex.com">a@ex.com</a> · <a href="javascript:alert(1)">click</a>
    <a href="https://track.ex.com"><img src="https://ex.com/logo.png" alt="Logo"></a></p>`)
  expect(out).toBe('[the offer](https://ex.com/a%20b?x=%281%29) · <https://ex.com> · <mailto:a@ex.com> · click')
  expect(out).not.toContain('logo.png')
})

test('MD-3 headings, rule, nested lists (ordered start), code and pre', () => {
  const out = md(`<h2>Agenda</h2><ol start="3"><li>Intro</li><li>Plan<ul><li>A</li><li>B</li></ul></li></ol><hr>
    <p>Run <code>npm test</code></p><pre>line 1\n  line 2</pre>`)
  expect(out).toBe('## Agenda\n\n3. Intro\n4. Plan\n   - A\n   - B\n\n---\n\nRun `npm test`\n\n```\nline 1\n  line 2\n```')
})

test('MD-4 reply quotes become blockquotes (nested)', () => {
  const out = md('<p>Sounds good</p><blockquote><p>Can we meet?</p><blockquote>Earlier</blockquote></blockquote>')
  expect(out).toBe('Sounds good\n\n> Can we meet?\n>\n> > Earlier')
})

test('MD-5 data table → GFM table; layout tables flattened to their cells', () => {
  const data = md('<table><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td>3 | 4 €</td></tr></table>')
  expect(data).toBe('| Item | Price |\n| --- | --- |\n| Tea | 3 \\| 4 € |')
  const layout = md(`<table><tr><td><table><tr><td><h1>News</h1></td></tr></table></td></tr>
    <tr><td><p>Story one</p><p>Story two</p></td><td>Side</td></tr></table>`)
  expect(layout).toBe('# News\n\nStory one\n\nStory two\n\nSide')
})

test('MD-6 styles, scripts, images and hidden elements dropped', () => {
  const out = md(`<html><head><title>T</title><style>p{color:red}</style></head><body>
    <div style="display: none">preheader</div><span style="mso-hide:all">x</span><script>alert(1)</script>
    <img src="https://t.ex.com/pixel.gif" width="1" height="1"><p hidden>no</p><p>Visible</p></body></html>`)
  expect(out).toBe('Visible')
})

test('MD-7 text that looks like Markdown / HTML stays literal', () => {
  const out = md('<p># not a heading</p><p>- not a list<br>1. not a list</p><p>a*b*c [x](y) &lt;tag&gt; _u_</p>')
  expect(out).toBe('\\# not a heading\n\n\\- not a list  \n\\1. not a list\n\na\\*b\\*c \\[x\\](y) \\<tag\\> \\_u\\_')
  const html = marked.parse(out)
  expect(html).not.toMatch(/<h1|<ul|<ol|<em|<a /)
  expect(html).toContain('&lt;tag&gt;')
})

test('MD-8 rendered with marked it reads like the mail', () => {
  const html = marked.parse(md(`<p>Hi <strong>team</strong>,</p><ul><li>one</li><li>two</li></ul>
    <p>See <a href="https://ex.com/doc">the doc</a>.</p><blockquote>quoted</blockquote>`))
  expect(html).toContain('<strong>team</strong>')
  expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/)
  expect(html).toContain('<a href="https://ex.com/doc">the doc</a>')
  expect(html).toMatch(/<blockquote>\s*<p>quoted<\/p>/)
})

test('MD-9 attached images embedded: inline (cid:) at their place, the others appended; stored names sanitised', () => {
  const attachments = [
    { name: 'PastedGraphic-1.png', type: 'image/png', cid: 'img1@ex.com' },
    { name: 'Screen shot (2).JPG', type: 'image/jpeg', cid: '<IMG2@ex.com>' },
    { name: 'photo.webp', type: 'image/webp' },
    { name: 'report.pdf', type: 'application/pdf' },
    { name: 'scan.tiff', type: 'image/tiff' },
  ]
  const used = new Set()
  const out = md(`<p>Look:</p><img src="cid:img1@ex.com" alt="x"><p>and <img src="cid:img2@ex.com"> here</p>
    <img src="https://ex.com/remote.png"><img src="cid:unknown@ex.com">`, { attachments, used })
  expect(out).toBe('Look:\n\n![PastedGraphic-1.png](attachment:PastedGraphic-1.png)\n\nand ![Screen_shot__2_.JPG](attachment:Screen_shot__2_.JPG) here')
  expect([...used]).toEqual(['PastedGraphic-1.png', 'Screen shot (2).JPG'])
  // Not shown in the body: the remaining image attachments (browser-viewable types only)
  expect(imagesMd(attachments, used)).toBe('![photo.webp](attachment:photo.webp)')
  expect(imagesMd(attachments)).toContain('![PastedGraphic-1.png](attachment:PastedGraphic-1.png)')
})
