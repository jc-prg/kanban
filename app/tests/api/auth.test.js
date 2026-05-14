'use strict'
/**
 * Auth API tests — section 1.1 (A-1 … A-10)
 *
 * These tests exercise the Express routes in isolation: no CouchDB required.
 * Rate-limit edge cases (A-3, A-4, A-5) are left for dedicated unit tests of
 * the auth module functions.
 */

// Set env vars before any backend module is loaded (config.js reads them at
// require-time and each test file gets an isolated module registry in Vitest).
process.env.APP_PASSWORD = 'test-password-correct'
process.env.API_KEY      = 'test-api-key-that-is-32chars-long!'
process.env.SESSION_SECRET = 'test-session-secret-32-chars-ok!'

// Suppress config.js startup noise
vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})

const request    = require('supertest')
const { createApp } = require('../setup/createApp')

const app = createApp()

// ---------------------------------------------------------------------------
// POST /api/auth
// ---------------------------------------------------------------------------
describe('POST /api/auth', () => {
  it('A-1: correct password → 200 ok:true and sets kanban-session cookie', async () => {
    const res = await request(app)
      .post('/api/auth')
      .send({ password: 'test-password-correct' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const cookies = res.headers['set-cookie'] ?? []
    expect(cookies.some(c => c.startsWith('kanban-session='))).toBe(true)
  })

  it('A-2: wrong password → 401 ok:false', async () => {
    const res = await request(app)
      .post('/api/auth')
      .send({ password: 'wrong-password' })

    expect(res.status).toBe(401)
    expect(res.body.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/auth/verify
// ---------------------------------------------------------------------------
describe('GET /api/auth/verify', () => {
  it('A-6: valid session cookie → ok:true', async () => {
    // First obtain a session cookie via login
    const loginRes = await request(app)
      .post('/api/auth')
      .send({ password: 'test-password-correct' })
    const cookieHeader = (loginRes.headers['set-cookie'] ?? []).join('; ')

    const verifyRes = await request(app)
      .get('/api/auth/verify')
      .set('Cookie', cookieHeader)

    expect(verifyRes.status).toBe(200)
    expect(verifyRes.body.ok).toBe(true)
  })

  it('A-7: no / invalid cookie → ok:false (not 401 — verify is unprotected)', async () => {
    const res = await request(app).get('/api/auth/verify')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// API key authentication (A-8, A-9, A-10)
// We hit GET /api/boards which is protected. Without CouchDB the handler will
// crash (500), but what matters is that auth *passed* (≠ 401).
// ---------------------------------------------------------------------------
describe('API key authentication on a protected route (GET /api/boards)', () => {
  it('A-8: x-api-key header with correct key → auth passes (not 401)', async () => {
    const res = await request(app)
      .get('/api/boards')
      .set('x-api-key', 'test-api-key-that-is-32chars-long!')

    expect(res.status).not.toBe(401)
  })

  it('A-9: Authorization: Bearer with correct key → auth passes (not 401)', async () => {
    const res = await request(app)
      .get('/api/boards')
      .set('Authorization', 'Bearer test-api-key-that-is-32chars-long!')

    expect(res.status).not.toBe(401)
  })

  it('A-10: no auth credentials → 401', async () => {
    const res = await request(app).get('/api/boards')

    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await request(app).post('/api/auth/logout')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // Cookie should be cleared (maxAge=0 or expires in the past)
    const cookies = res.headers['set-cookie'] ?? []
    expect(cookies.some(c => c.includes('kanban-session=;') || c.includes('Expires=Thu, 01 Jan 1970'))).toBe(true)
  })
})
