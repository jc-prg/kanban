require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nano = require('nano');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

const APP_PASSWORD  = process.env.APP_PASSWORD || 'kanban-pwd';
const SESSION_TOKEN = crypto.createHash('sha256').update(APP_PASSWORD).digest('hex').slice(0, 32);
console.log(`App password source: ${process.env.APP_PASSWORD ? '.env / environment' : 'built-in default'}`);

const COUCHDB_HOST     = process.env.COUCHDB_HOST     || 'localhost';
const COUCHDB_PORT     = process.env.COUCHDB_PORT     || 5984;
const COUCHDB_USER     = process.env.COUCHDB_USER     || 'kanban';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'kanban-pwd';
const DB_PREFIX        = 'jc-kanban-';
const DOC_ID           = 'board';
const PROMPTS_DB_NAME  = 'jc-extension-prompts';
const BACKUP_DIR       = path.join(__dirname, process.env.BACKUP_DIR || 'data');
const BACKUP_INTERVAL_MS = parseInt(process.env.BACKUP_INTERVAL_MS, 10) || 600000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));


let couch;
let promptsDb;

function validBoardName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}

async function getBoardDb(name) {
  const dbName = DB_PREFIX + name;
  try {
    await couch.db.create(dbName);
    console.log(`Board database "${dbName}" created`);
  } catch (err) {
    if (err.statusCode !== 412) throw err;
  }
  const db = couch.use(dbName);
  try {
    await db.get(DOC_ID);
  } catch (err) {
    if (err.statusCode !== 404) throw err;
    await db.insert({ _id: DOC_ID, columns: [] });
    console.log(`Board "${name}" document created (empty)`);
  }
  return db;
}

async function loadBoardData(db) {
  const { _id, _rev, ...data } = await db.get(DOC_ID);
  return data;
}

async function saveBoardData(db, data) {
  const { _rev } = await db.get(DOC_ID);
  await db.insert({ _id: DOC_ID, _rev, ...data });
}

function withBoard(handler) {
  return async (req, res) => {
    const { board } = req.params;
    if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
    try {
      const db = await getBoardDb(board);
      await handler(req, res, db);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: err.message });
    }
  };
}

// ---- Auth ----
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) res.json({ ok: true, token: SESSION_TOKEN });
  else res.status(401).json({ ok: false });
});

app.get('/api/auth/verify', (req, res) => {
  res.json({ ok: req.headers['x-auth-token'] === SESSION_TOKEN });
});

// ---- Board list / management ----
app.get('/api/boards', async (req, res) => {
  try {
    const all = await couch.db.list();
    res.json(all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length)).sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/boards/:name', async (req, res) => {
  const { name } = req.params;
  if (!validBoardName(name)) return res.status(400).json({ error: 'Invalid board name. Use lowercase letters, digits and hyphens only.' });
  try {
    await getBoardDb(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/boards/:name', async (req, res) => {
  const { name } = req.params;
  if (!validBoardName(name)) return res.status(400).json({ error: 'Invalid board name' });
  try {
    await couch.db.destroy(DB_PREFIX + name);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode === 404 ? 404 : 500).json({ error: err.message });
  }
});

// ---- Prompts (global) ----
const PROMPTS_DOC_ID = 'prompts';
const PROMPTS_DEFAULT = { searchProfile: '', criteriaInclude: '', criteriaExclude: '', searchRadius: '' };

async function loadPrompts() {
  try {
    const { _id, _rev, ...data } = await promptsDb.get(PROMPTS_DOC_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return { ...PROMPTS_DEFAULT };
    throw err;
  }
}

async function savePrompts(data) {
  let rev;
  try { ({ _rev: rev } = await promptsDb.get(PROMPTS_DOC_ID)); } catch (e) { /* new doc */ }
  await promptsDb.insert({ _id: PROMPTS_DOC_ID, ...(rev ? { _rev: rev } : {}), ...data });
}

app.get('/api/prompts', async (req, res) => {
  try { res.json(await loadPrompts()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/prompts', async (req, res) => {
  try {
    const { searchProfile = '', criteriaInclude = '', criteriaExclude = '', searchRadius = '' } = req.body;
    await savePrompts({ searchProfile, criteriaInclude, criteriaExclude, searchRadius });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Board API ----
app.get('/:board/api/board', withBoard(async (req, res, db) => {
  res.json(await loadBoardData(db));
}));

app.put('/:board/api/board', withBoard(async (req, res, db) => {
  await saveBoardData(db, req.body);
  res.json({ success: true });
}));

app.patch('/:board/api/board', withBoard(async (req, res, db) => {
  const { _rev, ...data } = await db.get(DOC_ID);
  const { columnOrder, updatedColumns, removedColumnIds } = req.body;
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
  await db.insert({ _id: DOC_ID, _rev, columns });
  res.json({ success: true });
}));

app.get('/:board/api/all-columns', withBoard(async (req, res, db) => {
  const data = await loadBoardData(db);
  const result = {};
  data.columns.forEach(col => { result[col.title] = col.cards; });
  res.json(result);
}));

app.get('/:board/api/column/:name', withBoard(async (req, res, db) => {
  const name = req.params.name.toLowerCase();
  const data = await loadBoardData(db);
  const col = data.columns.find(c => c.title.toLowerCase() === name);
  if (!col) return res.status(404).json({ error: `Column "${req.params.name}" not found` });
  res.json(col.cards);
}));

app.get('/:board/api/card/:id', withBoard(async (req, res, db) => {
  const data = await loadBoardData(db);
  for (const col of data.columns) {
    const card = col.cards.find(c => c.id === req.params.id);
    if (card) return res.json({ created: card.created || null, moves: card.moves || [], column: col.title });
  }
  res.status(404).json({ error: 'Card not found' });
}));

app.post('/:board/api/move-to/:name', withBoard(async (req, res, db) => {
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

app.post('/:board/api/import', withBoard(async (req, res, db) => {
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
  const inboxTitle = `Inbox ${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.`;
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

// ---- SPA catch-all (must be after all API routes) ----
const SPA_HTML = path.join(__dirname, 'public', 'index.html');
app.get('/:board', (req, res) => res.sendFile(SPA_HTML));
app.get('/:board/*path', (req, res) => res.sendFile(SPA_HTML));

// ---- Backup ----
async function runBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const all = await couch.db.list();
    const names = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
    for (const name of names) {
      try {
        const data = await loadBoardData(couch.use(DB_PREFIX + name));
        fs.writeFileSync(path.join(BACKUP_DIR, `kanban-${name}.json`), JSON.stringify(data, null, 2), 'utf-8');
      } catch (e) { console.error(`Backup for board "${name}" failed:`, e.message); }
    }
    if (names.length) console.log(`Backup completed for: ${names.join(', ')}`);
  } catch (err) { console.error('Backup failed:', err.message); }
}

async function runPromptsBackup() {
  try {
    const result = await promptsDb.list({ include_docs: true });
    const docs = result.rows
      .filter(r => !r.id.startsWith('_'))
      .map(r => { const { _id, _rev, ...doc } = r.doc; return { _id, ...doc }; });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, 'extension-prompts.json'), JSON.stringify(docs, null, 2), 'utf-8');
    console.log('Prompts backup saved');
  } catch (err) { console.error('Prompts backup failed:', err.message); }
}

// ---- Init ----
async function initDb() {
  couch = nano(`http://${encodeURIComponent(COUCHDB_USER)}:${encodeURIComponent(COUCHDB_PASSWORD)}@${COUCHDB_HOST}:${COUCHDB_PORT}`);

  for (let attempt = 1; attempt <= 15; attempt++) {
    try { await couch.db.list(); console.log('CouchDB is ready'); break; }
    catch (err) {
      if (attempt === 15) throw new Error('CouchDB not reachable after 15 attempts');
      console.log(`Waiting for CouchDB... (${attempt}/15)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  try { await couch.db.create(PROMPTS_DB_NAME); console.log(`Database "${PROMPTS_DB_NAME}" created`); }
  catch (err) { if (err.statusCode !== 412) throw err; console.log(`Database "${PROMPTS_DB_NAME}" already exists`); }

  promptsDb = couch.use(PROMPTS_DB_NAME);
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Kanban server running at http://${HOST}:${PORT}`));
    runBackup();
    setInterval(runBackup, BACKUP_INTERVAL_MS);
    runPromptsBackup();
    setInterval(runPromptsBackup, BACKUP_INTERVAL_MS);
  })
  .catch(err => { console.error('Failed to initialize:', err.message); process.exit(1); });
