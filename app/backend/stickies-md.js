'use strict';
// Stickies ⇄ Markdown (Settings → Dashboard → Stickies: export / import). Pure functions.
//
// Format — readable as Markdown, every field kept for a lossless round trip:
//
//   # Stickies
//
//   <!-- exported 2026-11-12T10:00:00.000Z · 2 stickies -->
//
//   ## Note
//   <!-- category: note -->
//
//   <!-- sticky: {"id":"s-…","color":"#fde68a","source":"…","created":"…","updated":"…"} -->
//   The text, as typed (several lines)
//   <!-- /sticky -->
//
// Hand-written files work too: under a `## Category` heading, text blocks separated by a line `---`
// become stickies (category created when unknown, id / colour / dates new).

const STICKY_START = /^<!--\s*sticky:\s*(\{.*\})\s*-->\s*$/;
const STICKY_END   = /^<!--\s*\/sticky\s*-->\s*$/;
const CATEGORY_ID  = /^<!--\s*category:\s*([a-z0-9-]{1,32})\s*-->\s*$/;

// JSON inside an HTML comment: no "-->" may appear — escape < and > (still valid JSON)
const _metaJson = obj => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/** Markdown of all stickies, grouped by category in the category order (unknown categories last). */
function stickiesToMarkdown(items, categories, now = new Date()) {
  const known = new Set(categories.map(c => c.id));
  const extra = [...new Set(items.map(s => s.category).filter(c => c && !known.has(c)))].map(id => ({ id, label: id }));
  const out = ['# Stickies', '', `<!-- exported ${now.toISOString()} · ${items.length} stick${items.length === 1 ? 'y' : 'ies'} -->`, ''];
  for (const cat of [...categories, ...extra]) {
    const list = items.filter(s => (s.category || 'note') === cat.id);
    out.push(`## ${cat.label}`, `<!-- category: ${cat.id} -->`, '');
    for (const s of list) {
      const meta = { id: s.id, color: s.color, source: s.source || '', created: s.created, updated: s.updated };
      if (Number.isFinite(s.pos)) meta.pos = s.pos;
      // A text line that would end the block early gets a zero-width space (removed again on import)
      const text = String(s.text || '').split('\n').map(l => (STICKY_END.test(l) ? `\u200b${l}` : l)).join('\n');
      out.push(`<!-- sticky: ${_metaJson(meta)} -->`, text, '<!-- /sticky -->', '');
    }
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Parse an exported or hand-written file → { categories: [{ id?, label }], items: [{ text, category: { id?, label },
 * id?, color?, source?, created?, updated?, pos? }] }. Text before the first `##` goes to `category: null`.
 */
function parseStickiesMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const categories = [];
  const items = [];
  let cat = null;          // { id?, label }
  let block = null;        // sticky with meta: { meta, lines }
  let loose = [];          // hand-written text of the current chunk

  const flushLoose = () => {
    const text = loose.join('\n').trim();
    loose = [];
    if (text) items.push({ text, category: cat });
  };

  for (const line of lines) {
    if (block) {
      if (STICKY_END.test(line)) {
        const text = block.lines.map(l => l.replace(/^\u200b(?=<!--)/, '')).join('\n').replace(/^\n+|\n+$/g, '');
        if (text.trim()) items.push({ ...block.meta, text, category: cat });
        block = null;
      } else block.lines.push(line);
      continue;
    }
    const start = line.match(STICKY_START);
    if (start) {
      flushLoose();
      let meta = {};
      try { meta = JSON.parse(start[1]); } catch { meta = {}; }
      block = { meta: _pickMeta(meta), lines: [] };
      continue;
    }
    const h2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h2 && !/^###/.test(line)) {
      flushLoose();
      cat = { label: h2[1].trim() };
      categories.push(cat);
      continue;
    }
    const cid = line.match(CATEGORY_ID);
    if (cid && cat && !cat.id) { cat.id = cid[1]; continue; }
    if (/^#\s/.test(line) || /^<!--.*-->\s*$/.test(line)) continue;   // title, comments
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { flushLoose(); continue; }
    loose.push(line);
  }
  if (block) {   // unterminated block: keep what is there
    const text = block.lines.join('\n').trim();
    if (text) items.push({ ...block.meta, text, category: cat });
  }
  flushLoose();
  return { categories, items };
}

function _pickMeta(m) {
  const out = {};
  if (typeof m.id === 'string') out.id = m.id;
  if (typeof m.color === 'string') out.color = m.color;
  if (typeof m.source === 'string') out.source = m.source;
  if (typeof m.created === 'string') out.created = m.created;
  if (typeof m.updated === 'string') out.updated = m.updated;
  if (Number.isFinite(m.pos)) out.pos = m.pos;
  return out;
}

module.exports = { stickiesToMarkdown, parseStickiesMarkdown };
