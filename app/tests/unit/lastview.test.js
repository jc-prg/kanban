// lastview.js — decision whether a page load goes back to the last view (pure part only; the IIFE
// after it touches location / storage and is covered by E2E E-T-58).
import { test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(path.join(__dirname, '../../frontend/lastview.js'), 'utf8')
const pure = src.slice(0, src.indexOf('(function () {'))
const { _lvShouldRestore, _lvRestorable } = new Function(`${pure}; return { _lvShouldRestore, _lvRestorable }`)()

const base = { standalone: false, navType: 'navigate', fromApp: false, fresh: true, path: '/today', last: '/board/cards#card:id-1' }

test('LV-1 browser: a new session on the plain start page restores; a running session or an in-app link does not', () => {
  expect(_lvShouldRestore(base).restore).toBe(true)
  expect(_lvShouldRestore({ ...base, fresh: false }).restore).toBe(false)
  expect(_lvShouldRestore({ ...base, fromApp: true }).restore).toBe(false)
})

test('LV-2 Home-Screen app: every launch restores, even when sessionStorage survived; reloads / back-forward do not', () => {
  const app = { ...base, standalone: true, fresh: false }
  expect(_lvShouldRestore(app)).toEqual({ restore: true, reason: 'app launch' })
  expect(_lvShouldRestore({ ...app, navType: 'reload' }).restore).toBe(false)
  expect(_lvShouldRestore({ ...app, navType: 'back_forward' }).restore).toBe(false)
  expect(_lvShouldRestore({ ...app, fromApp: true }).restore).toBe(false)
  // navigation type unknown: the session marker decides
  expect(_lvShouldRestore({ ...app, navType: null }).restore).toBe(false)
  expect(_lvShouldRestore({ ...app, navType: null, fresh: true }).restore).toBe(true)
})

test('LV-3 only from the plain /today, only to another restorable view', () => {
  expect(_lvShouldRestore({ ...base, path: '/today?cal=week' }).restore).toBe(false)
  expect(_lvShouldRestore({ ...base, path: '/board/cards' }).restore).toBe(false)
  expect(_lvShouldRestore({ ...base, last: '/today' }).restore).toBe(false)
  expect(_lvShouldRestore({ ...base, last: null }).restore).toBe(false)
  expect(_lvShouldRestore({ ...base, last: '/today?inbox' }).restore).toBe(false)
})

test('LV-4 _lvRestorable: Today and board pages, never the inbox form or other paths', () => {
  expect(_lvRestorable('/today?mail=ma-1&folder=INBOX')).toBe(true)
  expect(_lvRestorable('/board/my-board#note:n-1')).toBe(true)
  expect(_lvRestorable('/today?board=x&inbox')).toBe(false)
  expect(_lvRestorable('/api/boards')).toBe(false)
  expect(_lvRestorable('/board/Bad_Name')).toBe(false)
})
