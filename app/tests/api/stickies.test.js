'use strict'
/**
 * Stickies API tests — ST-1 … ST-10
 *
 * routes/stickies.js is mounted on its own with global-db.js replaced via require.cache.
 */

const path    = require('path')
const express = require('express')
const request = require('supertest')

const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')

const store = new Map()
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    listStickies: async () => [...store.values()].sort((a, b) => b.created.localeCompare(a.created)),
    getSticky:    async id => (store.has(id) ? { ...store.get(id) } : null),
    saveSticky:   async item => { store.set(item.id, { ...item }); return { ...item } },
    deleteSticky: async id => store.delete(id),
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

beforeEach(() => store.clear())

describe('Stickies API', () => {
  it('ST-1: GET lists stickies newest first plus the categories', async () => {
    seed()
    seed({ id: 's-000000000002', text: 'Newer', created: '2026-11-02T10:00:00.000Z' })
    const res = await request(app).get('/api/stickies')
    expect(res.status).toBe(200)
    expect(res.body.items.map(i => i.text)).toEqual(['Newer', 'Hello'])
    expect(res.body.categories).toEqual(['note', 'quote', 'intervention', 'other'])
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
})
