'use strict'
/**
 * Stickies API tests — ST-1 … ST-17 (ST-15 … ST-17: Markdown export / import, stickies-md.js)
 *
 * routes/stickies.js is mounted on its own with global-db.js replaced via require.cache.
 */

const path    = require('path')
const express = require('express')
const request = require('supertest')

const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')

const store = new Map()
let cats = null   // saved categories (null = defaults)
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    listStickies: async () => [...store.values()].sort((a, b) => b.created.localeCompare(a.created)),
    getSticky:    async id => (store.has(id) ? { ...store.get(id) } : null),
    saveSticky:   async item => { store.set(item.id, { ...item }); return { ...item } },
    deleteSticky: async id => store.delete(id),
    getStickyCategories:  async () => (cats ? cats.map(c => ({ ...c })) : null),
    saveStickyCategories: async list => { cats = list.map(c => ({ ...c })); return list },
  },
}

const router = require('../../backend/routes/stickies')
const app = express()
app.use(express.json())
app.use('/api', router)

const seed = (over = {}) => {
  const item = { id: 's-000000000001', text: 'Hello', color: '#fde68a', category: 'note',
                 created: '2026-11-01T10:00:00.000Z', updated: '2026-11-01T10:00:00.000Z', ...over }
  store.set(item.id, item)
  return item
}

beforeEach(() => { store.clear(); cats = null })

describe('Stickies API', () => {
  it('ST-1: GET lists stickies newest first plus the categories', async () => {
    seed()
    seed({ id: 's-000000000002', text: 'Newer', created: '2026-11-02T10:00:00.000Z' })
    const res = await request(app).get('/api/stickies')
    expect(res.status).toBe(200)
    expect(res.body.items.map(i => i.text)).toEqual(['Newer', 'Hello'])
    expect(res.body.categories).toEqual([{ id: 'note', label: 'Note' }, { id: 'quote', label: 'Quote' }, { id: 'intervention', label: 'Intervention' }, { id: 'other', label: 'Other' }])
  })

  it('ST-2: POST creates a sticky with a palette colour and category "note" by default', async () => {
    const res = await request(app).post('/api/stickies').send({ text: 'Idea' })
    expect(res.status).toBe(201)
    const { item } = res.body
    expect(item.id).toMatch(/^s-[0-9a-f]{12}$/)
    expect(item).toMatchObject({ text: 'Idea', category: 'note' })
    expect(router.STICKY_COLORS).toContain(item.color)
    expect(item.created).toBe(item.updated)
    expect(store.get(item.id)).toEqual(item)
  })

  it('ST-3: POST keeps a given colour and category', async () => {
    const res = await request(app).post('/api/stickies').send({ text: 'To be', color: '#123ABC', category: 'quote' })
    expect(res.status).toBe(201)
    expect(res.body.item).toMatchObject({ color: '#123ABC', category: 'quote' })
  })

  it('ST-4: POST rejects empty, blank, too long or extra fields', async () => {
    for (const body of [{}, { text: '' }, { text: '   \n ' }, { text: 'x'.repeat(5001) }, { text: 'a', id: 's-000000000009' }]) {
      const res = await request(app).post('/api/stickies').send(body)
      expect(res.status).toBe(400)
    }
    expect(store.size).toBe(0)
  })

  it('ST-5: POST / PUT reject an invalid colour or an unknown category', async () => {
    seed()
    expect((await request(app).post('/api/stickies').send({ text: 'a', color: 'red' })).status).toBe(400)
    expect((await request(app).post('/api/stickies').send({ text: 'a', category: 'todo' })).status).toBe(400)
    expect((await request(app).put('/api/stickies/s-000000000001').send({ color: '#12345' })).status).toBe(400)
    expect((await request(app).put('/api/stickies/s-000000000001').send({ category: 'todo' })).status).toBe(400)
  })

  it('ST-6: PUT updates only the fields sent and bumps updated', async () => {
    const before = seed()
    const res = await request(app).put('/api/stickies/s-000000000001').send({ text: 'Changed' })
    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({ text: 'Changed', color: before.color, category: 'note', created: before.created })
    expect(res.body.item.updated > before.updated).toBe(true)
  })

  it('ST-7: PUT with an empty body is rejected', async () => {
    seed()
    expect((await request(app).put('/api/stickies/s-000000000001').send({})).status).toBe(400)
  })

  it('ST-8: PUT / DELETE of an unknown sticky → 404, an invalid id → 400', async () => {
    expect((await request(app).put('/api/stickies/s-00000000000f').send({ text: 'a' })).status).toBe(404)
    expect((await request(app).delete('/api/stickies/s-00000000000f')).status).toBe(404)
    expect((await request(app).put('/api/stickies/board').send({ text: 'a' })).status).toBe(400)
    expect((await request(app).delete('/api/stickies/S-XYZ')).status).toBe(400)
  })

  it('ST-9: DELETE removes the sticky', async () => {
    seed()
    const res = await request(app).delete('/api/stickies/s-000000000001')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(store.size).toBe(0)
  })

  it('ST-10: source is optional, trimmed, can be cleared, ≤ 500 chars', async () => {
    const res = await request(app).post('/api/stickies').send({ text: 'To be', source: '  Hamlet  ' })
    expect(res.body.item.source).toBe('Hamlet')
    expect((await request(app).post('/api/stickies').send({ text: 'x' })).body.item.source).toBe('')
    const id = res.body.item.id
    expect((await request(app).put(`/api/stickies/${id}`).send({ source: 'https://example.com' })).body.item.source).toBe('https://example.com')
    expect((await request(app).put(`/api/stickies/${id}`).send({ source: '' })).body.item.source).toBe('')
    expect((await request(app).put(`/api/stickies/${id}`).send({ source: 'x'.repeat(501) })).status).toBe(400)
    expect((await request(app).put(`/api/stickies/${id}`).send({ source: 7 })).status).toBe(400)
  })

  it('ST-11: PUT pos (drag & drop in the grid) stores the sort key without touching `updated`; text changes still do', async () => {
    seed()
    const res = await request(app).put('/api/stickies/s-000000000001').send({ pos: -1762000000000.5 })
    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({ pos: -1762000000000.5, updated: '2026-11-01T10:00:00.000Z' })
    expect(store.get('s-000000000001').pos).toBe(-1762000000000.5)
    const res2 = await request(app).put('/api/stickies/s-000000000001').send({ text: 'Changed', pos: 3 })
    expect(res2.body.item.updated).not.toBe('2026-11-01T10:00:00.000Z')
    for (const pos of ['1', null, 1e16]) {
      expect((await request(app).put('/api/stickies/s-000000000001').send({ pos })).status).toBe(400)
    }
    expect((await request(app).post('/api/stickies').send({ text: 'x', pos: 1 })).status).toBe(400)   // only by moving
  })

  it('ST-12: categories — add (id from the label, accents folded), duplicates 409, invalid labels 400; a sticky may use it', async () => {
    let res = await request(app).post('/api/stickies/categories').send({ label: '  Bücher  & Ideen ' })
    expect(res.status).toBe(201)
    expect(res.body.category).toEqual({ id: 'bucher-ideen', label: 'Bücher & Ideen' })
    expect(res.body.categories.map(c => c.id)).toEqual(['note', 'quote', 'intervention', 'other', 'bucher-ideen'])
    expect((await request(app).post('/api/stickies/categories').send({ label: 'bücher & ideen' })).status).toBe(409)
    for (const label of ['', '   ', 'x'.repeat(41), 5]) expect((await request(app).post('/api/stickies/categories').send({ label })).status).toBe(400)
    // 'all' is the filter's "everything": never an id
    expect((await request(app).post('/api/stickies/categories').send({ label: 'All' })).body.category.id).toMatch(/^c-[0-9a-f]{6}$/)
    expect((await request(app).post('/api/stickies').send({ text: 'Read', category: 'bucher-ideen' })).status).toBe(201)
    expect((await request(app).get('/api/stickies')).body.categories).toHaveLength(6)
  })

  it('ST-13: categories — delete moves its stickies (to ?to= or the first remaining) without touching `updated`; the last one stays', async () => {
    seed({ category: 'quote' })
    seed({ id: 's-000000000002', category: 'note' })
    let res = await request(app).delete('/api/stickies/categories/quote')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ moved: 1, to: 'note' })
    expect(store.get('s-000000000001')).toMatchObject({ category: 'note', updated: '2026-11-01T10:00:00.000Z' })
    res = await request(app).delete('/api/stickies/categories/note?to=other')
    expect(res.body).toMatchObject({ moved: 2, to: 'other' })
    expect((await request(app).delete('/api/stickies/categories/intervention?to=nope')).status).toBe(400)
    expect((await request(app).delete('/api/stickies/categories/nope')).status).toBe(404)
    await request(app).delete('/api/stickies/categories/intervention')
    expect((await request(app).delete('/api/stickies/categories/other')).status).toBe(400)   // the last one
    expect(cats.map(c => c.id)).toEqual(['other'])
    // Deleted categories are unknown to POST / PUT
    expect((await request(app).post('/api/stickies').send({ text: 'a', category: 'note' })).status).toBe(400)
    expect((await request(app).post('/api/stickies').send({ text: 'a' })).body.item.category).toBe('other')   // default: the first one
  })

  it('ST-14: PUT category only (drag onto a pack) keeps `updated`', async () => {
    seed()
    const res = await request(app).put('/api/stickies/s-000000000001').send({ category: 'quote' })
    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({ category: 'quote', updated: '2026-11-01T10:00:00.000Z' })
  })

  it('ST-15: export — Markdown per category with all fields, as a download', async () => {
    seed({ text: 'Line 1\nLine 2', source: 'Seneca <x> -->', pos: 5 })
    seed({ id: 's-000000000002', text: 'To be', category: 'quote' })
    const res = await request(app).get('/api/stickies/export')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/markdown/)
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="stickies-\d{4}-\d{2}-\d{2}\.md"/)
    const md = res.text
    expect(md).toMatch(/^# Stickies\n/)
    expect(md).toContain('## Note\n<!-- category: note -->')
    expect(md).toContain('Line 1\nLine 2\n<!-- /sticky -->')
    expect(md).not.toContain('<x> -->')   // escaped inside the comment
    expect(md.indexOf('## Note')).toBeLessThan(md.indexOf('## Quote'))
  })

  it('ST-16: import — round trip of an export; known ids updated, new ones added, unknown categories created', async () => {
    seed({ text: 'Line 1\n<!-- /sticky -->\nLine 3', source: 'Seneca <x> -->', pos: 5 })
    seed({ id: 's-000000000002', text: 'To be', category: 'quote', color: '#93c5fd', source: '' })
    const md = (await request(app).get('/api/stickies/export')).text
    const before = [...store.values()].map(s => ({ ...s }))
    store.clear()
    let res = await request(app).post('/api/stickies/import').send({ markdown: md })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ added: 2, updated: 0, categoriesAdded: 0 })
    for (const s of before) expect(store.get(s.id)).toEqual(s)   // lossless
    res = await request(app).post('/api/stickies/import').send({ markdown: md })
    expect(res.body).toMatchObject({ added: 0, updated: 2 })
    // Hand-written: "## Books" is new, blocks separated by ---, text before any heading → first category
    res = await request(app).post('/api/stickies/import').send({ markdown: 'Loose thought\n\n## Books\nRead **Walden**\n\n---\n\nRead Seneca\n' })
    expect(res.body).toMatchObject({ added: 3, categoriesAdded: 1 })
    expect(cats.find(c => c.id === 'books')).toEqual({ id: 'books', label: 'Books' })
    const texts = [...store.values()].map(s => [s.text, s.category])
    expect(texts).toEqual(expect.arrayContaining([['Loose thought', 'note'], ['Read **Walden**', 'books'], ['Read Seneca', 'books']]))
    for (const s of store.values()) { expect(s.id).toMatch(/^s-[0-9a-f]{12}$/); expect(s.color).toMatch(/^#[0-9a-f]{6}$/i) }
  })

  it('ST-17: import — errors: missing / empty markdown, no stickies in it', async () => {
    expect((await request(app).post('/api/stickies/import').send({})).status).toBe(400)
    expect((await request(app).post('/api/stickies/import').send({ markdown: '  ' })).status).toBe(400)
    expect((await request(app).post('/api/stickies/import').send({ markdown: '# Stickies\n\n## Note\n<!-- category: note -->\n' })).status).toBe(400)
    expect(store.size).toBe(0)
  })
})
