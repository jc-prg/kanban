// attach-list.js — where an uploaded file's Markdown goes in a card / note description.
import { test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(path.join(__dirname, '../../frontend/attach-list.js'), 'utf8')
const { _attachListRange, _attachmentEdit } = new Function(`${src}; return { _attachListRange, _attachmentEdit }`)()

const apply = (text, e) => text.slice(0, e.from) + e.insert + text.slice(e.to)
const pdf = '[a.pdf](_attachments/a.pdf)'
const kdbx = '[b.kdbx](_attachments/b.kdbx)'
const img = '![p.png](_attachments/p.png)'

test('AL-1 files: the list at the end is created once, then extended; a file already listed is skipped', () => {
  let t = 'Some text\n\n'
  t = apply(t, _attachmentEdit(t, pdf))
  expect(t).toBe(`Some text\n\n---\n- ${pdf}`)
  t = apply(t, _attachmentEdit(t, kdbx))
  expect(t).toBe(`Some text\n\n---\n- ${pdf}\n- ${kdbx}`)
  expect(_attachmentEdit(t, pdf)).toBeNull()
  // trailing blank lines after an existing list
  expect(apply(`${t}\n\n`, _attachmentEdit(`${t}\n\n`, '[c](c)'))).toBe(`${t}\n- [c](c)\n\n`)
  // empty description
  expect(apply('', _attachmentEdit('', pdf))).toBe(`---\n- ${pdf}`)
})

test('AL-2 only a trailing "---" + link items counts as the list', () => {
  expect(_attachListRange('a\n\n---\n\nb')).toBeNull()                 // ordinary rule
  expect(_attachListRange('a\n\n---\n- plain item')).toBeNull()        // not a link
  expect(_attachListRange('a\n\n---')).toBeNull()                      // no items
  const t = `a\n\n---\n- ${pdf}\n`
  expect(_attachListRange(t)).toEqual({ start: 3, end: t.length - 1 })
  // a rule in the text and the list at the end: the file joins the list
  const t2 = `a\n\n---\n\nb\n\n---\n- ${pdf}`
  expect(apply(t2, _attachmentEdit(t2, kdbx))).toBe(`${t2}\n- ${kdbx}`)
})

test('AL-3 images: at the last edit cursor; without one above the list, else at the end', () => {
  const t = `Hello world\n\n---\n- ${pdf}`
  const e = _attachmentEdit(t, img, { image: true, cursor: 5 })
  expect(apply(t, e)).toBe(`Hello\n${img}\n world\n\n---\n- ${pdf}`)   // on a line of its own
  expect(e.cursor).toBe(6 + img.length)
  // a second image at the remembered cursor: its own line below the first
  const t1 = apply(t, e)
  expect(apply(t1, _attachmentEdit(t1, img, { image: true, cursor: e.cursor }))).toBe(`Hello\n${img}\n${img}\n world\n\n---\n- ${pdf}`)
  // cursor at a line start / end: no extra newlines
  expect(apply('a\nb', _attachmentEdit('a\nb', img, { image: true, cursor: 2 }))).toBe(`a\n${img}\nb`)
  expect(apply('a\nb', _attachmentEdit('a\nb', img, { image: true, cursor: 1 }))).toBe(`a\n${img}\nb`)
  expect(apply(t, _attachmentEdit(t, img, { image: true }))).toBe(`Hello world\n\n${img}\n\n---\n- ${pdf}`)
  // cursor inside the list → above it
  const e2 = _attachmentEdit(t, img, { image: true, cursor: t.length })
  expect(apply(t, e2)).toBe(`Hello world\n\n${img}\n\n---\n- ${pdf}`)
  expect(e2.cursor).toBe('Hello world\n\n'.length + img.length)
  expect(apply('Hi\n', _attachmentEdit('Hi\n', img, { image: true }))).toBe(`Hi\n\n${img}`)
})

test('AL-4 a remembered cursor keeps its place when a file is listed after it', () => {
  const t = 'Hello world'
  const e = _attachmentEdit(t, pdf, { cursor: 5 })
  expect(e.cursor).toBe(5)
  const t2 = `Hello\n\n---\n- ${pdf}`
  expect(_attachmentEdit(t2, kdbx, { cursor: t2.length }).cursor).toBe(t2.length)
})
