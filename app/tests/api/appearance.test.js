'use strict'
/**
 * Appearance (skin) API tests — AP-1 … AP-4
 *
 * routes/appearance.js is mounted on its own with global-db.js replaced via require.cache.
 */

const path    = require('path')
const express = require('express')
const request = require('supertest')

const GLOBAL_DB_MODULE = path.resolve(__dirname, '../../backend/global-db.js')

const store = { appearance: null }
require.cache[GLOBAL_DB_MODULE] = {
  id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true, children: [], paths: [],
  exports: {
    getAppearance:  async () => (store.appearance ? { ...store.appearance } : null),
    saveAppearance: async data => { store.appearance = { ...data }; return { ok: true } },
  },
}

const app = express()
app.use(express.json())
app.use('/api', require('../../backend/routes/appearance'))

beforeEach(() => { store.appearance = null })

describe('Appearance API', () => {
  it('AP-1: GET returns the default skin and the known skins when nothing is stored', async () => {
    const res = await request(app).get('/api/appearance')
    expect(res.status).toBe(200)
    expect(res.body.skin).toBe('default')
    expect(res.body.skins).toEqual(expect.arrayContaining(['default', 'glass']))
  })

  it('AP-2: PUT stores a known skin, GET returns it', async () => {
    const put = await request(app).put('/api/appearance').send({ skin: 'glass' })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true, skin: 'glass' })
    expect(store.appearance).toEqual({ skin: 'glass' })
    const res = await request(app).get('/api/appearance')
    expect(res.body.skin).toBe('glass')
  })

  it('AP-3: PUT rejects unknown or missing skins with 400 and stores nothing', async () => {
    for (const body of [{ skin: 'neon' }, {}, { skin: 42 }]) {
      const res = await request(app).put('/api/appearance').send(body)
      expect(res.status).toBe(400)
    }
    expect(store.appearance).toBeNull()
  })

  it('AP-4: GET falls back to the default for a stored skin that no longer exists', async () => {
    store.appearance = { skin: 'removed-skin' }
    const res = await request(app).get('/api/appearance')
    expect(res.body.skin).toBe('default')
  })
})
