'use strict'
/**
 * viewport.js — VP-1 … VP-2: _vpGap (missing viewport height of the iOS Home-Screen app)
 * The pure function is extracted from the source; the IIFE (browser globals) is not run.
 */
const fs   = require('fs')
const path = require('path')

const src = fs.readFileSync(path.resolve(__dirname, '../../frontend/viewport.js'), 'utf8')
const fnSrc = src.slice(src.indexOf('function _vpGap'), src.indexOf('\n}\n', src.indexOf('function _vpGap')) + 2)
const _vpGap = new Function(`${fnSrc}; return _vpGap;`)()

const iphone = { standalone: true, ios: true, screenW: 402, screenH: 874 }

test('VP-1 iOS standalone: the band below a short viewport, portrait and landscape', () => {
  expect(_vpGap({ ...iphone, innerW: 402, innerH: 812 })).toBe(62)
  expect(_vpGap({ ...iphone, innerW: 402, innerH: 874 })).toBe(0)     // healthy
  expect(_vpGap({ ...iphone, innerW: 874, innerH: 380 })).toBe(22)    // landscape: screen.width is the height
})

test('VP-2 no gap outside the iOS standalone app or for implausible values (keyboard, desktop)', () => {
  expect(_vpGap({ ...iphone, standalone: false, innerW: 402, innerH: 812 })).toBe(0)
  expect(_vpGap({ ...iphone, ios: false, innerW: 402, innerH: 812 })).toBe(0)
  expect(_vpGap({ ...iphone, innerW: 402, innerH: 500 })).toBe(0)     // > 100 px: not this bug
  expect(_vpGap({ ...iphone, innerW: 402, innerH: 900 })).toBe(0)
})
