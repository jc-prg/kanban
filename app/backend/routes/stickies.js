'use strict';
// Stickies (Today widget): unstructured notes with a colour and a category, one CouchDB doc each.
const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { writeRateLimit } = require('../auth');
const { withHandler }    = require('../db');
const { listStickies, getSticky, saveSticky, deleteSticky } = require('../global-db');
const { validateStickyCreate, validateStickyUpdate, STICKY_CATEGORIES, STICKY_ID, schemaError } = require('../schemas');

// Paper colours — same list as _STK_COLORS in frontend/today-stickies.js
const STICKY_COLORS = ['#fde68a', '#fdba74', '#f9a8d4', '#c4b5fd', '#93c5fd', '#86efac', '#5eead4', '#d1d5db'];

const newId = () => `s-${crypto.randomBytes(6).toString('hex')}`;

router.get('/stickies', withHandler(async (req, res) => {
  res.json({ items: await listStickies(), categories: STICKY_CATEGORIES });
}));

router.post('/stickies', writeRateLimit, withHandler(async (req, res) => {
  if (!validateStickyCreate(req.body)) return res.status(400).json({ error: schemaError(validateStickyCreate) });
  const now = new Date().toISOString();
  const item = await saveSticky({
    id:       newId(),
    text:     req.body.text,
    source:   (req.body.source || '').trim(),
    color:    req.body.color || STICKY_COLORS[crypto.randomInt(STICKY_COLORS.length)],
    category: req.body.category || 'note',
    created:  now,
    updated:  now,
  });
  res.status(201).json({ item });
}));

router.put('/stickies/:id', writeRateLimit, withHandler(async (req, res) => {
  if (!STICKY_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid sticky id' });
  if (!validateStickyUpdate(req.body)) return res.status(400).json({ error: schemaError(validateStickyUpdate) });
  const stored = await getSticky(req.params.id);
  if (!stored) return res.status(404).json({ error: 'Sticky not found' });
  const changes = { ...req.body };
  if ('source' in changes) changes.source = changes.source.trim();
  // Moving a sticky (pos only) is no change of its content: `updated` stays
  const moved = Object.keys(changes).every(k => k === 'pos');
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
