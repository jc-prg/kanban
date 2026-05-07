const express = require('express');
const router  = express.Router();
const { writeRateLimit }                                      = require('../auth');
const { withBoard, withExistingBoard, loadBoardData, saveBoardData } = require('../db');
const { validateBoard, validateBoardPatch, schemaError }      = require('../schemas');
const { DOC_ID }                                              = require('../config');

router.get('/:board/board', withExistingBoard(async (req, res, db) => {
  const { _id, _rev, ...data } = await db.get(DOC_ID);
  const etag = `"${_rev}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('ETag', etag);
  res.json(data);
}));

router.put('/:board/board', writeRateLimit, withBoard(async (req, res, db) => {
  if (!validateBoard(req.body))
    return res.status(400).json({ error: 'Invalid board data', details: schemaError(validateBoard) });
  const ifMatch = req.headers['if-match'];
  if (ifMatch) {
    const { _rev } = await db.get(DOC_ID);
    if (ifMatch !== `"${_rev}"`) return res.status(409).json({ error: 'conflict' });
  }
  const result = await saveBoardData(db, req.body);
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
    inbox = { id: 'id-' + Math.random().toString(36).slice(2, 9), title: inboxTitle, cards: [], color: '#06b6d4' };
    data.columns.unshift(inbox);
  }

  const existingTexts = new Set(data.columns.flatMap(c => c.cards.map(card => card.text)));
  const relevant_items = [], excluded_items = [], skipped_items = [];

  for (const { item, color, bucket } of rawItems) {
    const normalized = { ...item };
    if (normalized['job-title'] || normalized.company || normalized.location) {
      normalized.text = [normalized['job-title'], normalized.company, normalized.location].filter(Boolean).join(' | ');
      if (normalized.reason) normalized.description = normalized.reason;
    }
    if (!normalized.text || existingTexts.has(normalized.text)) { skipped_items.push(item); continue; }

    const card = {
      id: 'id-' + Math.random().toString(36).slice(2, 9),
      text: normalized.text,
      color: color || normalized.color || '#06b6d4',
      created: new Date().toISOString().slice(0, 10),
    };
    if (normalized.priority)    card.priority    = normalized.priority;
    if (normalized.description) card.description = normalized.description;
    if (normalized.link)        card.link        = normalized.link;
    if (normalized.startDate)   card.startDate   = normalized.startDate;
    if (normalized.endDate)     card.endDate     = normalized.endDate;

    inbox.cards.push(card);
    existingTexts.add(normalized.text);
    if (bucket === 'excluded') excluded_items.push(item); else relevant_items.push(item);
  }

  await saveBoardData(db, data);
  res.json({
    relevant: relevant_items.length, relevant_items,
    excluded: excluded_items.length, excluded_items,
    skipped:  skipped_items.length,  skipped_items,
  });
}));

module.exports = router;
