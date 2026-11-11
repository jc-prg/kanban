'use strict'
/**
 * Today "Quick access" widget — QA-1 … QA-11
 *
 * Icon discovery / ranking (pure helpers of backend/today/quickaccess.js), the icon routes of
 * routes/today.js (fetch with a stubbed global fetch, upload, serve) and orphan pruning.
 * TODAY_ICONS_DIR points to a temp dir (config.js replaced via require.cache); db.js /
 * global-db.js are mocked as in today.test.js.
 */

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const express = require('express')
const request = require('supertest')

const ICON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-qa-icons-'))

const CONFIG_MODULE    = path.resolve(__dirname, '../../backend/config.js')
const DB_MODULE        = path.resolve(__dirname, '../../backend/db.js')
const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')

const realConfig = require(CONFIG_MODULE)
require.cache[CONFIG_MODULE].exports = { ...realConfig, TODAY_ICONS_DIR: ICON_DIR }

require.cache[DB_MODULE] = {
  id: DB_MODULE, filename: DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    getCouch: () => ({ db: { list: async () => [] }, use: () => ({}) }),
    withHandler: h => async (req, res) => { try { await h(req, res) } catch (e) { res.status(500).json({ error: e.message }) } },
  },
}
const store = { today: null }
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    getTodayConfig:  async () => (store.today ? JSON.parse(JSON.stringify(store.today)) : null),
    saveTodayConfig: async data => { store.today = JSON.parse(JSON.stringify(data)); return { ok: true } },
    getWebdavDb: () => ({ get: async () => { throw Object.assign(new Error('not_found'), { statusCode: 404 }) } }),
    getWebdavAccounts: async () => [],
  },
}

const app = express()
app.use(express.json())
app.use('/api', require('../../backend/routes/today'))
const qa = require('../../backend/today/quickaccess')

const PNG  = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')])
const PNG2 = Buffer.concat([PNG, Buffer.from('-other')])
const SVG  = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>')
const ICO  = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])

/** Stub fetch with a URL → { status?, type?, body } map; records the requested URLs. */
function stubFetch(routes) {
  const calls = []
  vi.stubGlobal('fetch', async url => {
    calls.push(url)
    const r = routes[url]
    if (!r) return new Response('not found', { status: 404 })
    return new Response(r.body, { status: r.status || 200, headers: { 'content-type': r.type || 'application/octet-stream' } })
  })
  return calls
}

const iconFiles = () => fs.readdirSync(ICON_DIR).sort()

beforeEach(() => {
  store.today = null
  for (const f of fs.readdirSync(ICON_DIR)) fs.unlinkSync(path.join(ICON_DIR, f))
  vi.unstubAllGlobals()
})
afterAll(() => fs.rmSync(ICON_DIR, { recursive: true, force: true }))

// ---------------------------------------------------------------------------

test('QA-1 sniffImage — PNG / JPEG / GIF / WebP / ICO / SVG by magic bytes; HTML and empty rejected', () => {
  expect(qa.sniffImage(PNG)).toBe('png')
  expect(qa.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
  expect(qa.sniffImage(Buffer.from('GIF89a..'))).toBe('gif')
  expect(qa.sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
  expect(qa.sniffImage(ICO)).toBe('ico')
  expect(qa.sniffImage(SVG)).toBe('svg')
  expect(qa.sniffImage(Buffer.from('<svg viewBox="0 0 1 1"/>'))).toBe('svg')
  expect(qa.sniffImage(Buffer.from('<!doctype html><html><svg></svg></html>'))).toBeNull()
  expect(qa.sniffImage(Buffer.alloc(0))).toBeNull()
})

test('QA-2 parseIconLinks — largest first (SVG below large raster icons); apple-touch default 180; mask-icon ignored; <base> + fallbacks', () => {
  const html = `<html><head><base href="/app/">
    <link rel="icon" href="favicon-32.png" sizes="32x32">
    <link rel="icon" type="image/png" href="icon-192.png" sizes="192x192">
    <link rel='apple-touch-icon' href='touch.png'>
    <link rel="mask-icon" href="mask.svg" color="#000">
    <link rel="icon" href="/logo.svg" type="image/svg+xml">
    <link rel="manifest" href="site.webmanifest">
    <link rel="stylesheet" href="x.css"></head></html>`
  const { candidates, manifest } = qa.parseIconLinks(html, 'https://ex.com/start')
  expect(candidates.map(c => c.url)).toEqual([
    'https://ex.com/app/icon-192.png',
    'https://ex.com/app/touch.png',
    'https://ex.com/apple-touch-icon.png',
    'https://ex.com/logo.svg',
    'https://ex.com/app/favicon-32.png',
    'https://ex.com/favicon.ico',
  ])
  expect(manifest).toBe('https://ex.com/app/site.webmanifest')
  // No HTML at all → just the well-known fallbacks
  expect(qa.parseIconLinks('', 'https://ex.com/').candidates.map(c => c.url))
    .toEqual(['https://ex.com/apple-touch-icon.png', 'https://ex.com/favicon.ico'])
})

test('QA-3 parseManifestIcons — sizes, SVG, maskable-only icons rank at most 100', () => {
  const icons = qa.parseManifestIcons({ icons: [
    { src: '/i-512.png', sizes: '512x512', purpose: 'maskable' },
    { src: '/i-256.png', sizes: '256x256', purpose: 'any maskable' },
    { src: 'v.svg', type: 'image/svg+xml' },
    { nosrc: true },
  ] }, 'https://ex.com/m/manifest.json')
  expect(icons).toEqual([
    { url: 'https://ex.com/i-512.png', score: 100 },
    { url: 'https://ex.com/i-256.png', score: 256 },
    { url: 'https://ex.com/m/v.svg', score: 120 },
  ])
})

test('QA-4 POST /today/quickaccess/icon stores the best icon (manifest included); GET serves it cached, sandboxed', async () => {
  const calls = stubFetch({
    'https://app.example/': { type: 'text/html', body: '<link rel="icon" href="/f.ico"><link rel="manifest" href="/m.json">' },
    'https://app.example/m.json': { type: 'application/json', body: JSON.stringify({ icons: [{ src: '/big.png', sizes: '512x512' }] }) },
    'https://app.example/big.png': { type: 'image/png', body: PNG },
    'https://app.example/f.ico': { type: 'image/x-icon', body: ICO },
  })
  const res = await request(app).post('/api/today/quickaccess/icon').send({ url: 'https://app.example/' })
  expect(res.status).toBe(200)
  expect(res.body.file).toMatch(/^qa-[a-f0-9]{16}\.png$/)
  expect(calls).toContain('https://app.example/big.png')
  expect(calls).not.toContain('https://app.example/f.ico')   // first candidate already worked
  expect(iconFiles()).toEqual([res.body.file])

  const get = await request(app).get(`/api/today/quickaccess/icon/${res.body.file}`)
  expect(get.status).toBe(200)
  expect(Buffer.from(get.body)).toEqual(PNG)
  expect(get.headers['cache-control']).toContain('immutable')
  expect(get.headers['x-content-type-options']).toBe('nosniff')
  expect(get.headers['content-security-policy']).toContain('sandbox')

  // Same bytes again → same content-addressed name, no second file
  const again = await request(app).post('/api/today/quickaccess/icon').send({ url: 'https://app.example/' })
  expect(again.body.file).toBe(res.body.file)
  expect(iconFiles()).toHaveLength(1)
})

test('QA-5 icon fetch skips non-images and failures; 502 when no candidate works; 400 for a non-http URL', async () => {
  stubFetch({
    'https://a.example/': { type: 'text/html', body: '<link rel="apple-touch-icon" href="/touch.png">' },
    'https://a.example/touch.png': { type: 'text/html', body: '<html>login</html>' },   // login page instead of an image
    'https://a.example/favicon.ico': { type: 'image/x-icon', body: ICO },
  })
  const ok = await request(app).post('/api/today/quickaccess/icon').send({ url: 'https://a.example/' })
  expect(ok.status).toBe(200)
  expect(ok.body.file).toMatch(/\.ico$/)

  stubFetch({ 'https://b.example/': { status: 500, body: 'down' } })
  const none = await request(app).post('/api/today/quickaccess/icon').send({ url: 'https://b.example/' })
  expect(none.status).toBe(502)
  expect(none.body.error).toMatch(/No icon/)

  for (const url of ['javascript:alert(1)', 'ftp://x/', '', 42]) {
    const bad = await request(app).post('/api/today/quickaccess/icon').send({ url })
    expect(bad.status).toBe(400)
  }
})

test('QA-6 inline data: icons in the page are decoded and stored', async () => {
  const b64 = PNG.toString('base64')
  stubFetch({ 'https://d.example/': { type: 'text/html', body: `<link rel="icon" sizes="64x64" href="data:image/png;base64,${b64}">` } })
  const res = await request(app).post('/api/today/quickaccess/icon').send({ url: 'https://d.example/' })
  expect(res.status).toBe(200)
  expect(fs.readFileSync(path.join(ICON_DIR, res.body.file))).toEqual(PNG)
})

test('QA-7 upload: image stored, non-image 415, larger than 512 KB 413, missing file 400', async () => {
  const ok = await request(app).post('/api/today/quickaccess/icon/upload').attach('file', SVG, 'logo.svg')
  expect(ok.status).toBe(200)
  expect(ok.body.file).toMatch(/^qa-[a-f0-9]{16}\.svg$/)

  const text = await request(app).post('/api/today/quickaccess/icon/upload').attach('file', Buffer.from('hello'), 'a.png')
  expect(text.status).toBe(415)

  const big = await request(app).post('/api/today/quickaccess/icon/upload').attach('file', Buffer.concat([PNG, Buffer.alloc(qa.MAX_ICON)]), 'big.png')
  expect(big.status).toBe(413)

  const none = await request(app).post('/api/today/quickaccess/icon/upload').field('x', '1')
  expect(none.status).toBe(400)
  expect(iconFiles()).toEqual([ok.body.file])
})

test('QA-8 GET icon: invalid names 400 (traversal, wrong pattern), unknown 404', async () => {
  for (const name of ['..%2Fconfig.js', 'qa-xyz.png', 'qa-0123456789abcdef.exe', 'evil.svg']) {
    const res = await request(app).get(`/api/today/quickaccess/icon/${name}`)
    expect(res.status).toBe(400)
  }
  const missing = await request(app).get('/api/today/quickaccess/icon/qa-0123456789abcdef.png')
  expect(missing.status).toBe(404)
})

test('QA-9 PUT /today/config: quickaccess schema — valid entries saved; bad URL / icon / size / showTitles / duplicate ids 400', async () => {
  const quickaccess = { visible: 4, size: 'l', showTitles: false, items: [
    { id: 'qa-a1', url: 'https://grafana.local/', title: 'Grafana', icon: { type: 'image', file: 'qa-0123456789abcdef.png', invertDark: true } },
    { id: 'qa-b2', url: 'http://nas:5000', icon: { type: 'emoji', value: '💾' } },
  ] }
  const ok = await request(app).put('/api/today/config').send({ widgets: { quickaccess } })
  expect(ok.status).toBe(200)
  expect(ok.body.config.widgets.quickaccess).toEqual(quickaccess)

  const item = quickaccess.items[0]
  const bad = [
    { ...quickaccess, size: 'xl' },
    { ...quickaccess, visible: 51 },
    { ...quickaccess, showTitles: 'no' },
    { items: [{ ...item, url: 'javascript:alert(1)' }] },
    { items: [{ ...item, icon: { type: 'image', file: '../config.js' } }] },
    { items: [{ ...item, icon: { type: 'emoji', value: '' } }] },
    { items: [{ ...item, icon: { type: 'emoji', value: '🚀', invertDark: true } }] },   // invert is for images only
    { items: [{ ...item, icon: { ...item.icon, invertDark: 'yes' } }] },
    { items: [{ ...item, icon: { type: 'image', file: 'qa-0123456789abcdef.png', value: 'x' } }] },
    { items: [{ ...item, id: 'Bad Id' }] },
    { items: [item, { ...item, url: 'https://other/' }] },   // same id twice
  ]
  for (const q of bad) {
    const res = await request(app).put('/api/today/config').send({ widgets: { quickaccess: q } })
    expect(res.status, JSON.stringify(q)).toBe(400)
  }
})

test('QA-10 pruneIcons removes unreferenced icons older than the grace period; referenced / fresh ones stay', async () => {
  const { file: used }  = await qa.saveIcon(PNG)
  const { file: stale } = await qa.saveIcon(PNG2)
  const { file: fresh } = await qa.saveIcon(SVG)
  const old = new Date(Date.now() - qa.PRUNE_GRACE - 60_000)
  for (const f of [used, stale]) fs.utimesSync(path.join(ICON_DIR, f), old, old)
  fs.writeFileSync(path.join(ICON_DIR, 'notes.txt'), 'not an icon')   // foreign files are never touched

  const cfg = { widgets: { quickaccess: { items: [{ id: 'qa-1', url: 'https://x/', icon: { type: 'image', file: used } }] } } }
  expect(await qa.pruneIcons(cfg)).toEqual([stale])
  expect(iconFiles()).toEqual([fresh, 'notes.txt', used].sort())

  // Saving the config without the entry prunes its icon (route side, fire and forget)
  fs.utimesSync(path.join(ICON_DIR, used), old, old)
  await request(app).put('/api/today/config').send({ widgets: { quickaccess: { items: [] } } })
  await vi.waitFor(() => expect(iconFiles()).not.toContain(used))
})

test('QA-11 page HTML larger than 1 MB: icon links in <head> are still found (body read up to the limit)', async () => {
  const head = '<html><head><link rel="apple-touch-icon" sizes="152x152" href="/touch-152.png"></head><body>'
  stubFetch({
    'https://big.example/': { type: 'text/html', body: head + 'x'.repeat(1.5 * 1024 * 1024) + '</body></html>' },
    'https://big.example/touch-152.png': { type: 'image/png', body: PNG },
  })
  const cands = await qa.discoverIcons('https://big.example/')
  expect(cands[0]).toEqual({ url: 'https://big.example/touch-152.png', score: 152 })
  const res = await request(app).post('/api/today/quickaccess/icon').send({ url: 'https://big.example/' })
  expect(res.status).toBe(200)
  expect(res.body.file).toMatch(/\.png$/)
})
