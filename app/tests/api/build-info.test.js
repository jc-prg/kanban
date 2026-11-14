'use strict'
/**
 * Git branch for Settings → About — BI-1 … BI-3 (backend/build-info.js)
 */
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const { branchFromHead, detectBranch } = require('../../backend/build-info')

test('BI-1 branchFromHead: branch ref, detached commit, garbage', () => {
  expect(branchFromHead('ref: refs/heads/master\n')).toBe('master')
  expect(branchFromHead('ref: refs/heads/feature/mail-view')).toBe('feature/mail-view')
  expect(branchFromHead('e046564d5f0c1a2b3c4d5e6f708192a3b4c5d6e7')).toBe('detached e046564')
  expect(branchFromHead('')).toBeNull()
  expect(branchFromHead('nonsense')).toBeNull()
})

test('BI-2 detectBranch: GIT_BRANCH wins; without git the HEAD files in order; else unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-'))
  const a = path.join(dir, 'a'), b = path.join(dir, 'b')
  fs.writeFileSync(b, 'ref: refs/heads/release\n')
  expect(detectBranch({ env: { GIT_BRANCH: ' staging ' }, headFiles: [b] })).toBe('staging')
  expect(detectBranch({ env: {}, useGit: false, headFiles: [a, b] })).toBe('release')   // a missing → b
  fs.writeFileSync(a, 'ref: refs/heads/image-build\n')
  expect(detectBranch({ env: {}, useGit: false, headFiles: [a, b] })).toBe('image-build')
  expect(detectBranch({ env: {}, useGit: false, headFiles: [path.join(dir, 'none')] })).toBe('unknown')
})

test('BI-3 detectBranch in this checkout: the current branch (git or .git/HEAD)', () => {
  const head = fs.readFileSync(path.resolve(__dirname, '../../../.git/HEAD'), 'utf8')
  const expected = branchFromHead(head)
  expect(detectBranch({ env: {} })).toBe(expected)
  expect(detectBranch({ env: {}, useGit: false })).toBe(expected)
})
