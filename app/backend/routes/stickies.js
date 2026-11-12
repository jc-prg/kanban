'use strict';
// Stickies (Today widget): unstructured notes with a colour and a category, one CouchDB doc each.
const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { writeRateLimit } = require('../auth');
const { withHandler }    = require('../db');
const { listStickies, getSticky, saveSticky, deleteSticky, getStickyCategories, saveStickyCategories } = require('../global-db');
const { validateStickyCreate, validateStickyUpdate, STICKY_CATEGORIES, STICKY_CATEGORY_ID, STICKY_ID, schemaError } = require('../schemas');
const { stickiesToMarkdown, parseStickiesMarkdown } = require('../stickies-md');

// Paper colours — same list as _STK_COLORS in frontend/today-stickies.js
const STICKY_COLORS = ['#fde68a', '#fdba74', '#f9a8d4', '#c4b5fd', '#93c5fd', '#86efac', '#5eead4', '#d1d5db'];

const newId = () => `s-${crypto.randomBytes(6).toString('hex')}`;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_CATEGORIES = 30;

/** Categories in their order: the saved list, else the defaults. */
async function loadCategories() {
  const list = await getStickyCategories();
  return list && list.length ? list : STICKY_CATEGORIES.map(c => ({ ...c }));
}

/** Category id from a label: lower case, accents folded, a–z 0–9 and hyphens; a random one when empty / taken. Pure apart from the random fallback. */
function categoryIdFor(label, taken) {
  const slug = String(label).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  if (slug && slug !== 'all' && !taken.has(slug)) return slug;
  let id;
  do id = `c-${crypto.randomBytes(3).toString('hex')}`; while (taken.has(id));
  return id;
}

const cleanLabel = l => (typeof l === 'string' ? l.replace(/\s+/g, ' ').trim() : '');

router.get('/stickies', withHandler(async (req, res) => {
  res.json({ items: await listStickies(), categories: await loadCategories() });
}));

// ---- Categories: add / delete (deleting moves its stickies to another one) ----

router.post('/stickies/categories', writeRateLimit, withHandler(async (req, res) => {
  const label = cleanLabel(req.body?.label);
  if (!label || label.length > 40) return res.status(400).json({ error: 'label must be 1–40 characters' });
  const list = await loadCategories();
  if (list.some(c => c.label.toLowerCase() === label.toLowerCase())) return res.status(409).json({ error: `Category "${label}" exists already` });
  if (list.length >= MAX_CATEGORIES) return res.status(400).json({ error: `At most ${MAX_CATEGORIES} categories` });
  const category = { id: categoryIdFor(label, new Set(list.map(c => c.id))), label };
  const categories = await saveStickyCategories([...list, category]);
  res.status(201).json({ category, categories });
}));

router.delete('/stickies/categories/:id', writeRateLimit, withHandler(async (req, res) => {
  const { id } = req.params;
  const list = await loadCategories();
  if (!list.some(c => c.id === id)) return res.status(404).json({ error: 'Category not found' });
  const rest = list.filter(c => c.id !== id);
  if (!rest.length) return res.status(400).json({ error: 'The last category cannot be deleted' });
  // Its stickies go to `?to=` (another category), else the first remaining one
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : rest[0].id;
  if (!rest.some(c => c.id === to)) return res.status(400).json({ error: 'Unknown target category' });
  let moved = 0;
  for (const s of await listStickies()) {
    if ((s.category || 'note') !== id) continue;
    await saveSticky({ ...s, category: to });   // a category change, not an edit of the text: `updated` stays
    moved++;
  }
  const categories = await saveStickyCategories(rest);
  res.json({ ok: true, moved, to, categories });
}));

// ---- Markdown export / import (Settings → Dashboard → Stickies) ----

router.get('/stickies/export', withHandler(async (req, res) => {
  const md = stickiesToMarkdown(await listStickies(), await loadCategories());
  res.set({
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="stickies-${new Date().toISOString().slice(0, 10)}.md"`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(md);
}));

/**
 * Body { markdown } — merged into the stored stickies: a known id is updated, everything else is
 * added; categories are matched by id, then by label (case-insensitive), else created.
 */
router.post('/stickies/import', writeRateLimit, withHandler(async (req, res) => {
  const md = req.body?.markdown;
  if (typeof md !== 'string' || !md.trim()) return res.status(400).json({ error: 'markdown missing' });
  if (md.length > 5_000_000) return res.status(413).json({ error: 'File too large (max 5 MB)' });
  const parsed = parseStickiesMarkdown(md);
  if (!parsed.items.length) return res.status(400).json({ error: 'No stickies found in the file' });

  const list = await loadCategories();
  const taken = new Set(list.map(c => c.id));
  let categoriesAdded = 0;
  const resolve = cat => {   // → category id (created when unknown)
    if (!cat) return list[0].id;
    const byId = cat.id && list.find(c => c.id === cat.id);
    if (byId) return byId.id;
    const byLabel = list.find(c => c.label.toLowerCase() === cat.label.toLowerCase());
    if (byLabel) return byLabel.id;
    const label = cleanLabel(cat.label).slice(0, 40) || 'Imported';
    const id = cat.id && STICKY_CATEGORY_ID.test(cat.id) && cat.id !== 'all' && !taken.has(cat.id) ? cat.id : categoryIdFor(label, taken);
    taken.add(id);
    list.push({ id, label });
    categoriesAdded++;
    return id;
  };

  const existing = new Map((await listStickies()).map(s => [s.id, s]));
  const now = new Date().toISOString();
  const iso = v => (typeof v === 'string' && !isNaN(Date.parse(v)) ? v : null);
  let added = 0, updated = 0, skipped = 0;
  const plan = [];
  for (const it of parsed.items) {
    const text = String(it.text).slice(0, 5000);
    if (!text.trim()) { skipped++; continue; }
    const category = resolve(it.category);
    const stored = STICKY_ID.test(it.id || '') ? existing.get(it.id) : null;
    const item = {
      id:       stored ? stored.id : (STICKY_ID.test(it.id || '') && !plan.some(p => p.id === it.id) ? it.id : newId()),
      text,
      source:   String(it.source ?? stored?.source ?? '').trim().slice(0, 500),
      color:    COLOR.test(it.color || '') ? it.color : stored?.color || STICKY_COLORS[crypto.randomInt(STICKY_COLORS.length)],
      category,
      created:  iso(it.created) || stored?.created || now,
      updated:  iso(it.updated) || now,
    };
    const pos = Number.isFinite(it.pos) ? it.pos : stored?.pos;
    if (Number.isFinite(pos)) item.pos = pos;
    plan.push(item);
    if (stored) updated++; else added++;
  }
  if (categoriesAdded) await saveStickyCategories(list);
  for (const item of plan) await saveSticky(item);
  res.json({ ok: true, added, updated, skipped, categoriesAdded, categories: list });
}));

router.post('/stickies', writeRateLimit, withHandler(async (req, res) => {
  if (!validateStickyCreate(req.body)) return res.status(400).json({ error: schemaError(validateStickyCreate) });
  const categories = await loadCategories();
  if (req.body.category && !categories.some(c => c.id === req.body.category)) return res.status(400).json({ error: 'Unknown category' });
  const now = new Date().toISOString();
  const item = await saveSticky({
    id:       newId(),
    text:     req.body.text,
    source:   (req.body.source || '').trim(),
    color:    req.body.color || STICKY_COLORS[crypto.randomInt(STICKY_COLORS.length)],
    category: req.body.category || (categories.some(c => c.id === 'note') ? 'note' : categories[0].id),
    created:  now,
    updated:  now,
  });
  res.status(201).json({ item });
}));

router.put('/stickies/:id', writeRateLimit, withHandler(async (req, res) => {
  if (!STICKY_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid sticky id' });
  if (!validateStickyUpdate(req.body)) return res.status(400).json({ error: schemaError(validateStickyUpdate) });
  if (req.body.category && !(await loadCategories()).some(c => c.id === req.body.category)) return res.status(400).json({ error: 'Unknown category' });
  const stored = await getSticky(req.params.id);
  if (!stored) return res.status(404).json({ error: 'Sticky not found' });
  const changes = { ...req.body };
  if ('source' in changes) changes.source = changes.source.trim();
  // Moving a sticky (place / category only) is no change of its content: `updated` stays
  const moved = Object.keys(changes).every(k => k === 'pos' || k === 'category');
  const item = await saveSticky({ ...stored, ...changes, updated: moved ? stored.updated : new Date().toISOString() });
  res.json({ item });
}));

router.delete('/stickies/:id', writeRateLimit, withHandler(async (req, res) => {
  if (!STICKY_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid sticky id' });
  if (!await deleteSticky(req.params.id)) return res.status(404).json({ error: 'Sticky not found' });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.STICKY_COLORS = STICKY_COLORS;
module.exports.categoryIdFor = categoryIdFor;
