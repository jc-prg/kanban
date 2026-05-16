const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { writeRateLimit }                                      = require('../auth');
const { withBoard, withExistingBoard, loadBoardData, saveBoardData } = require('../db');
const { validateBoard, validateBoardPatch, validateInboxCards, schemaError } = require('../schemas');
const { DOC_ID }                                              = require('../config');

// ---------------------------------------------------------------------------
// Webhook config — stored per board under _id 'webhook-config'
// ---------------------------------------------------------------------------
const WEBHOOK_CFG_ID = 'webhook-config';

async function _loadWebhookDoc(db) {
  try {
    const { _id, _rev, ...data } = await db.get(WEBHOOK_CFG_ID);
    return { _rev, ...data };
  } catch (err) {
    if (err.statusCode === 404) return {};
    throw err;
  }
}

router.get('/:board/webhook-config', withExistingBoard(async (req, res, db) => {
  try {
    const doc = await _loadWebhookDoc(db);
    res.json({ enabled: doc.enabled ?? false, name: doc.name || '', url: doc.url || '', method: doc.method || 'POST' });
  } catch (err) { res.status(500).json({ error: err.message }); }
}));

router.put('/:board/webhook-config', writeRateLimit, withBoard(async (req, res, db) => {
  try {
    const { enabled, name, url, method } = req.body;
    if (typeof url === 'string' && url.trim() && !/^https?:\/\//.test(url.trim()))
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH']);
    const existing = await _loadWebhookDoc(db);
    const safeMethod = (typeof method === 'string' && ALLOWED_METHODS.has(method.toUpperCase()))
      ? method.toUpperCase() : (existing.method || 'POST');
    const doc = {
      _id:     WEBHOOK_CFG_ID,
      ...(existing._rev ? { _rev: existing._rev } : {}),
      enabled: !!enabled,
      name:    typeof name === 'string' ? name.trim().slice(0, 64) : (existing.name || ''),
      url:     typeof url  === 'string' ? url.trim()               : (existing.url  || ''),
      method:  safeMethod,
    };
    await db.insert(doc);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
}));

router.post('/:board/webhook/trigger', writeRateLimit, withExistingBoard(async (req, res, db) => {
  try {
    const doc = await _loadWebhookDoc(db);
    if (!doc.enabled || !doc.url)
      return res.status(400).json({ ok: false, error: 'Webhook not configured or disabled' });
    const method = doc.method || 'POST';
    const payload = { board: req.params.board, triggeredAt: new Date().toISOString() };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let r;
    try {
      const hasBody = method !== 'GET';
      r = await fetch(doc.url, {
        method,
        headers: hasBody ? { 'Content-Type': 'application/json' } : {},
        ...(hasBody ? { body: JSON.stringify(payload) } : {}),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (r.ok) res.json({ ok: true, status: r.status });
    else      res.json({ ok: false, error: `Webhook returned HTTP ${r.status}` });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Webhook timed out (10 s)' : err.message;
    res.json({ ok: false, error: msg });
  }
}));

router.get('/:board/board', withExistingBoard(async (req, res, db) => {
  const { _id, _rev, ...data } = await db.get(DOC_ID);
  const etag = `"${_rev}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('ETag', etag);
  res.json(data);
}));

function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) { if (val !== null) out[k] = stripNulls(val); }
    return out;
  }
  return v;
}

router.put('/:board/board', writeRateLimit, withBoard(async (req, res, db) => {
  const body = stripNulls(req.body);
  if (!validateBoard(body))
    return res.status(400).json({ error: 'Invalid board data', details: schemaError(validateBoard) });
  const ifMatch = req.headers['if-match'];
  if (ifMatch) {
    const { _rev } = await db.get(DOC_ID);
    if (ifMatch !== `"${_rev}"`) return res.status(409).json({ error: 'conflict' });
  }
  const result = await saveBoardData(db, body);
  res.setHeader('ETag', `"${result.rev}"`);
  res.json({ success: true });
}));

router.patch('/:board/board', writeRateLimit, withBoard(async (req, res, db) => {
  if (!validateBoardPatch(req.body)) {
    const details = schemaError(validateBoardPatch);
    console.error(`[PATCH /${req.params.board}/board] schema validation failed:`, details);
    return res.status(400).json({ error: 'Invalid patch data', details });
  }
  const { _rev, ...data } = await db.get(DOC_ID);
  const ifMatch = req.headers['if-match'];
  if (ifMatch && ifMatch !== `"${_rev}"`) return res.status(409).json({ error: 'conflict' });
  const { columnOrder, updatedColumns, removedColumnIds, settings } = req.body;
  let columns = data.columns;

  if (removedColumnIds?.length) {
    const removed = new Set(removedColumnIds);
    columns = columns.filter(c => !removed.has(c.id));
  }
  if (updatedColumns?.length) {
    for (const col of updatedColumns) {
      const idx = columns.findIndex(c => c.id === col.id);
      if (idx !== -1) columns[idx] = col; else columns.push(col);
    }
  }
  if (columnOrder?.length) {
    const map = new Map(columns.map(c => [c.id, c]));
    columns = columnOrder.map(id => map.get(id)).filter(Boolean);
  }
  const update = { ...data, columns };
  if (settings !== undefined) {
    update.settings = settings;
    delete update.description;
    delete update.inboxWithDate;
    delete update.persistCollapse;
    delete update.collapsedColumnIds;
  }
  const result = await db.insert({ _id: DOC_ID, _rev, ...update });
  res.setHeader('ETag', `"${result.rev}"`);
  res.json({ success: true });
}));

router.get('/:board/all-columns', withBoard(async (req, res, db) => {
  const data = await loadBoardData(db);
  const result = {};
  data.columns.forEach(col => { result[col.title] = col.cards; });
  res.json(result);
}));

router.get('/:board/column/:name', withBoard(async (req, res, db) => {
  const name = req.params.name.toLowerCase();
  const data = await loadBoardData(db);
  const col = data.columns.find(c => c.title.toLowerCase() === name);
  if (!col) return res.status(404).json({ error: `Column "${req.params.name}" not found` });
  res.json(col.cards);
}));

router.get('/:board/card/:id', withBoard(async (req, res, db) => {
  const data = await loadBoardData(db);
  for (const col of data.columns) {
    const card = col.cards.find(c => c.id === req.params.id);
    if (card) return res.json({ created: card.created || null, moves: card.moves || [], column: col.title });
  }
  res.status(404).json({ error: 'Card not found' });
}));

router.post('/:board/move-to/:name', writeRateLimit, withBoard(async (req, res, db) => {
  const targetName = req.params.name.toLowerCase();
  const { 'job-title': jobTitle, company, location } = req.body;
  const input = { 'job-title': jobTitle, company, location };
  const text = [jobTitle, company, location].filter(Boolean).join(' | ');
  const reply = (moved, toColumn, success) => res.json({ toBeMoved: input, moved, toColumn, success });

  if (!text) return reply(null, null, false);
  if (location === 'test-city') return reply(null, null, true);

  const data = await loadBoardData(db);
  const targetCol = data.columns.find(c => c.title.toLowerCase() === targetName);
  if (!targetCol) return reply(null, req.params.name, false);

  let card = null, sourceColTitle = null;
  for (const col of data.columns) {
    const idx = col.cards.findIndex(c => c.text === text);
    if (idx !== -1) { sourceColTitle = col.title; [card] = col.cards.splice(idx, 1); break; }
  }
  if (!card) return reply(null, targetCol.title, false);

  if (!card.moves) card.moves = [];
  card.moves.push({ at: new Date().toISOString(), from: sourceColTitle, to: targetCol.title });

  const actions = targetCol.actions || [];
  if (actions.includes('markDone'))   { card.done = true;  card.doneAt = new Date().toISOString(); }
  if (actions.includes('markUndone')) { card.done = false;  delete card.doneAt; }

  targetCol.cards.unshift(card);
  await saveBoardData(db, data);
  reply(card, targetCol.title, true);
}));

router.post('/:board/import', writeRateLimit, withBoard(async (req, res, db) => {
  const body = req.body;
  let rawItems;
  if (Array.isArray(body)) {
    rawItems = body.map(i => ({ item: i, color: i.color, bucket: 'relevant' }));
  } else if (body && (Array.isArray(body.relevant) || Array.isArray(body.excluded))) {
    rawItems = [
      ...(body.relevant || []).map(i => ({ item: i, color: '#10b981', bucket: 'relevant' })),
      ...(body.excluded || []).map(i => ({ item: i, color: '#ef4444', bucket: 'excluded' })),
    ];
  } else {
    return res.status(400).json({ error: 'Expected a JSON array or an object with "relevant"/"excluded" arrays' });
  }

  const data = await loadBoardData(db);
  const now = new Date();
  const inboxTitle = (data.settings?.inboxWithDate ?? false)
    ? `Inbox ${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.`
    : 'Inbox';
  let inbox = data.columns.find(c => c.title === inboxTitle);
  if (!inbox) {
    inbox = { id: 'id-' + crypto.randomBytes(6).toString('hex'), title: inboxTitle, cards: [], color: '#06b6d4' };
    data.columns.unshift(inbox);
  }

  const existingTexts = new Set(data.columns.flatMap(c => c.cards.map(card => card.text)));
  const relevant_items = [], excluded_items = [], duplicate_items = [];

  for (const { item, color, bucket } of rawItems) {
    const normalized = { ...item };
    if (normalized['job-title'] || normalized.company || normalized.location) {
      normalized.text = [normalized['job-title'], normalized.company, normalized.location].filter(Boolean).join(' | ');
      if (normalized.reason) normalized.description = normalized.reason;
    }
    if (!normalized.text) continue;

    const isDuplicate = existingTexts.has(normalized.text);
    const card = {
      id: 'id-' + crypto.randomBytes(6).toString('hex'),
      text: normalized.text,
      color: color || normalized.color || '#06b6d4',
      created: new Date().toISOString().slice(0, 10),
    };
    if (normalized.priority)    card.priority    = normalized.priority;
    if (normalized.description) card.description = normalized.description;
    if (normalized.link)        card.link        = normalized.link;
    if (normalized.startDate)   card.startDate   = normalized.startDate;
    if (normalized.endDate)     card.endDate     = normalized.endDate;
    if (normalized.done)        { card.done = true; if (normalized.doneAt) card.doneAt = normalized.doneAt; }
    if (isDuplicate) card.duplicate = true; else existingTexts.add(normalized.text);

    inbox.cards.push(card);
    if (isDuplicate) duplicate_items.push(card);
    else if (bucket === 'excluded') excluded_items.push(card); else relevant_items.push(card);
  }

  await saveBoardData(db, data);
  res.json({
    relevant:   relevant_items.length,  relevant_items,
    excluded:   excluded_items.length,  excluded_items,
    duplicates: duplicate_items.length, duplicate_items,
  });
}));

router.post('/:board/inbox', writeRateLimit, withBoard(async (req, res, db) => {
  if (!validateInboxCards(req.body))
    return res.status(400).json({ error: 'Invalid card data', details: schemaError(validateInboxCards) });

  const items = Array.isArray(req.body) ? req.body : [req.body];
  const data = await loadBoardData(db);
  const now = new Date();
  const inboxTitle = (data.settings?.inboxWithDate ?? false)
    ? `Inbox ${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.`
    : 'Inbox';
  let inbox = data.columns.find(c => c.title === inboxTitle);
  if (!inbox) {
    inbox = { id: 'id-' + crypto.randomBytes(6).toString('hex'), title: inboxTitle, cards: [], color: '#06b6d4' };
    data.columns.unshift(inbox);
  }

  const existingTexts = new Set(data.columns.flatMap(c => c.cards.map(card => card.text)));
  const added_items = [], duplicate_items = [];

  for (const item of items) {
    const isDuplicate = existingTexts.has(item.text);
    const card = {
      id:      'id-' + crypto.randomBytes(6).toString('hex'),
      created: now.toISOString().slice(0, 10),
      ...item,
    };
    if (isDuplicate) card.duplicate = true; else existingTexts.add(item.text);
    inbox.cards.unshift(card);
    if (isDuplicate) duplicate_items.push(card); else added_items.push(card);
  }

  await saveBoardData(db, data);
  res.json({
    added: added_items.length, added_items,
    duplicates: duplicate_items.length, duplicate_items,
  });
}));

module.exports = router;
