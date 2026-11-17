'use strict';

/**
 * Front matter round trip. Keys the app does not own (Obsidian properties such
 * as tags, aliases, …), their order and comments stay as they are; the app
 * only reads/writes its own keys (APP_KEYS).
 */

const YAML = require('yaml');

const APP_KEYS    = ['id', 'link', 'linkedCards', 'attachments'];
// Written by earlier versions; removed when the app writes a note
const LEGACY_KEYS = ['title', 'lastModified', 'source'];

const FM_RE       = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const EMPTY_FM_RE = /^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/;
const TO_STRING   = { lineWidth: 0, flowCollectionPadding: false };

/**
 * @returns {{ body, doc, raw, valid, newline, dirty }}
 *   doc: YAML.Document (null = no front matter), raw: original front matter text,
 *   valid: false = unparsable YAML, kept verbatim
 */
function parse(text) {
  const newline = text.slice(0, 2000).includes('\r\n') ? '\r\n' : '\n';
  const m = FM_RE.exec(text);
  if (!m) {
    const em = EMPTY_FM_RE.exec(text);
    if (em) return { body: text.slice(em[0].length), doc: new YAML.Document({}), raw: '', valid: true, newline, dirty: false };
    return { body: text, doc: null, raw: null, valid: true, newline, dirty: false };
  }
  const raw = m[1];
  const body = text.slice(m[0].length);
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length || (doc.contents !== null && !YAML.isMap(doc.contents)))
    return { body, doc: null, raw, valid: false, newline, dirty: false };
  if (doc.contents === null) doc.contents = doc.createNode({});
  return { body, doc, raw, valid: true, newline, dirty: false };
}

function get(note, key, dflt = undefined) {
  if (!note.doc) return dflt;
  const v = note.doc.get(key);
  return v === undefined || v === null ? dflt : (YAML.isNode(v) ? v.toJSON() : v);
}

function has(note, key) { return !!note.doc && note.doc.has(key); }

/** Sets an app key; null/""/[] removes it. Returns false when the YAML is unparsable. */
function set(note, key, value) {
  if (!note.valid) return false;
  const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
  if (!note.doc) {
    if (empty) return true;
    note.doc = new YAML.Document({});
  }
  if (empty) {
    if (note.doc.has(key)) { note.doc.delete(key); note.dirty = true; }
    return true;
  }
  if (JSON.stringify(get(note, key)) !== JSON.stringify(value)) {
    note.doc.set(key, value);
    note.dirty = true;
  }
  return true;
}

function remove(note, ...keys) {
  if (!note.valid || !note.doc) return false;
  let changed = false;
  for (const k of keys) if (note.doc.has(k)) { note.doc.delete(k); changed = true; }
  if (changed) note.dirty = true;
  return changed;
}

function render(note) {
  const nl = note.newline;
  if (!note.valid) return `---${nl}${note.raw}${nl}---${nl}${note.body}`;
  if (!note.doc) return note.body;
  const empty = !note.doc.contents || !note.doc.contents.items?.length;
  if (empty && !note.raw) return note.body;
  let fm = (!note.dirty && note.raw !== null) ? note.raw : note.doc.toString(TO_STRING).replace(/\n+$/, '');
  if (nl !== '\n' && note.dirty) fm = fm.replace(/\n/g, nl);
  if (!fm.trim() || fm.trim() === '{}') return `---${nl}---${nl}${note.body}`;
  return `---${nl}${fm}${nl}---${nl}${note.body}`;
}

/** Stable page id from the front matter (older files store "[id](url)"). */
function noteId(note) {
  const v = get(note, 'id');
  if (!v) return '';
  const s = String(v).trim();
  const m = /^\[([^\]]+)\]\(.*\)$/.exec(s);
  return m ? m[1] : s;
}

/** Card ids from linkedCards ("[Title](…#card:id-x)" or bare ids). */
function linkedCards(note) {
  const v = get(note, 'linkedCards');
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return list.map(e => {
    const s = String(e).trim().replace(/^"|"$/g, '');
    const m = /#card:(id-[a-z0-9]+)\)/.exec(s) || /.*\(([^)]+)\)$/.exec(s);
    return m ? m[1] : s;
  }).filter(Boolean);
}

module.exports = { APP_KEYS, LEGACY_KEYS, parse, render, get, has, set, remove, noteId, linkedCards };
