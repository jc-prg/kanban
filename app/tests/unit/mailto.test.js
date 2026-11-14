'use strict'
/**
 * mailto: links → compose prefill — MT-1 … MT-3
 *
 * _mailtoPrefill is extracted from frontend/dashboard.js (from its declaration to the next one).
 */

const fs   = require('fs')
const path = require('path')

let prefill

beforeAll(() => {
  const src   = fs.readFileSync(path.resolve(__dirname, '../../frontend/dashboard.js'), 'utf8')
  const start = src.indexOf('function _mailtoPrefill(')
  const end   = src.indexOf('/** Whether a mail account can send')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  prefill = new Function(`${src.slice(start, end)}\nreturn _mailtoPrefill;`)()
})

const plain = v => JSON.parse(JSON.stringify(v))

test('MT-1 plain address, several addresses, encoded characters', () => {
  expect(plain(prefill('mailto:bob@ex.com'))).toEqual({ to: 'bob@ex.com', cc: '', bcc: '', subject: '', body: '' })
  expect(prefill('MAILTO:a@ex.com,b@ex.com').to).toBe('a@ex.com,b@ex.com')
  expect(prefill('mailto:J%C3%BCrgen%20M%C3%BCller%20%3Cj%40ex.com%3E').to).toBe('Jürgen Müller <j@ex.com>')
})

test('MT-2 header fields: subject, body (line breaks), cc / bcc, extra to; keys case-insensitive', () => {
  const p = prefill('mailto:bob@ex.com?Subject=Hi%20there&body=Line%201%0D%0ALine%202&cc=c@ex.com&BCC=x@ex.com&to=d@ex.com&cc=e@ex.com')
  expect(plain(p)).toEqual({ to: 'bob@ex.com, d@ex.com', cc: 'c@ex.com, e@ex.com', bcc: 'x@ex.com', subject: 'Hi there', body: 'Line 1\nLine 2' })
  // "+" stays a plus (RFC 6068), unknown fields ignored, no address
  expect(plain(prefill('mailto:?subject=1+1&in-reply-to=%3Cx%3E'))).toEqual({ to: '', cc: '', bcc: '', subject: '1+1', body: '' })
})

test('MT-3 not a mailto link / broken encoding', () => {
  expect(prefill('https://ex.com')).toBeNull()
  expect(prefill('')).toBeNull()
  expect(prefill('mailto:bob@ex.com?subject=100%').subject).toBe('100%')
})
