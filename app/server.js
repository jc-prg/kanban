require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nano = require('nano');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const DATA_FILE = path.join(__dirname, process.env.INITIAL_DATA || 'data.json');

const APP_PASSWORD     = process.env.APP_PASSWORD     || 'kanban-pwd';
const crypto = require('crypto');
const SESSION_TOKEN = crypto.createHash('sha256').update(APP_PASSWORD).digest('hex').slice(0, 32);
console.log(`App password source: ${process.env.APP_PASSWORD ? '.env / environment' : 'built-in default'}`);

const COUCHDB_HOST     = process.env.COUCHDB_HOST     || 'localhost';
const COUCHDB_PORT     = process.env.COUCHDB_PORT     || 5984;
const COUCHDB_USER     = process.env.COUCHDB_USER     || 'kanban';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'kanban-pwd';
const DB_NAME       = 'jc-kanban-cards';
const DOC_ID        = 'board';
const PROMPTS_DB_NAME = 'jc-kanban-prompts';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_DATA = {
  columns: [
    { id: 'col-1', title: 'ToDo', cards: [
      { id: 'card-1', text: 'Plan project scope', color: '#f59e0b' },
      { id: 'card-2', text: 'Setup repository', color: '#6366f1' }
    ]},
    { id: 'col-2', title: 'Doing', cards: [
      { id: 'card-3', text: 'Design UI mockups', color: '#10b981' }
    ]},
    { id: 'col-3', title: 'Done', cards: [
      { id: 'card-4', text: 'Define requirements', color: '#ec4899' }
    ]}
  ]
};

let db;
let promptsDb;

async function initDb() {
  const couch = nano(
    `http://${encodeURIComponent(COUCHDB_USER)}:${encodeURIComponent(COUCHDB_PASSWORD)}@${COUCHDB_HOST}:${COUCHDB_PORT}`
  );

  // Wait for CouchDB to become available
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      await couch.db.list();
      console.log('CouchDB is ready');
      break;
    } catch (err) {
      if (attempt === 15) throw new Error('CouchDB not reachable after 15 attempts');
      console.log(`Waiting for CouchDB... (${attempt}/15)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Create databases if they don't exist (412 = already exists)
  for (const name of [DB_NAME, PROMPTS_DB_NAME]) {
    try {
      await couch.db.create(name);
      console.log(`Database "${name}" created`);
    } catch (err) {
      if (err.statusCode !== 412) throw err;
      console.log(`Database "${name}" already exists`);
    }
  }

  db = couch.use(DB_NAME);
  promptsDb = couch.use(PROMPTS_DB_NAME);

  // Seed board document if absent
  try {
    await db.get(DOC_ID);
    console.log('Board document found, skipping seed');
  } catch (err) {
    if (err.statusCode !== 404) throw err;
    let seedData = DEFAULT_DATA;
    if (fs.existsSync(DATA_FILE)) {
      try {
        seedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        console.log(`Seeding from ${DATA_FILE}`);
      } catch (e) {
        console.log('Could not parse data file, using default data');
      }
    }
    await db.insert({ _id: DOC_ID, ...seedData });
    console.log('Board document seeded');
  }
}

async function loadData() {
  const { _id, _rev, ...data } = await db.get(DOC_ID);
  return data;
}

async function saveData(data) {
  const { _rev } = await db.get(DOC_ID);
  await db.insert({ _id: DOC_ID, _rev, ...data });
}

const BACKUP_FILE         = path.join(__dirname, process.env.BACKUP_FILE         || 'data/kanban-cards.json');
const PROMPTS_BACKUP_FILE = path.join(__dirname, process.env.PROMPTS_BACKUP_FILE || 'data/kanban-prompts.json');
const BACKUP_INTERVAL_MS  = parseInt(process.env.BACKUP_INTERVAL_MS, 10) || 600000;

async function runBackup() {
  try {
    const data = await loadData();
    const dir = path.dirname(BACKUP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`Backup saved to ${BACKUP_FILE}`);
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}

async function runPromptsBackup() {
  try {
    const result = await promptsDb.list({ include_docs: true });
    const docs = result.rows
      .filter(r => !r.id.startsWith('_'))
      .map(r => { const { _id, _rev, ...doc } = r.doc; return { _id, ...doc }; });
    const dir = path.dirname(PROMPTS_BACKUP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROMPTS_BACKUP_FILE, JSON.stringify(docs, null, 2), 'utf-8');
    console.log(`Prompts backup saved to ${PROMPTS_BACKUP_FILE}`);
  } catch (err) {
    console.error('Prompts backup failed:', err.message);
  }
}

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    res.json({ ok: true, token: SESSION_TOKEN });
  } else {
    res.status(401).json({ ok: false });
  }
});

app.get('/api/auth/verify', (req, res) => {
  const token = req.headers['x-auth-token'];
  res.json({ ok: token === SESSION_TOKEN });
});

app.get('/api/board', async (req, res) => {
  try {
    res.json(await loadData());
  } catch (err) {
    console.error('Failed to load board:', err.message);
    res.status(500).json({ error: 'Failed to load board', details: err.message });
  }
});

app.get('/api/all-columns', async (req, res) => {
  const data = await loadData();
  const result = {};
  data.columns.forEach(col => { result[col.title] = col.cards; });
  res.json(result);
});

app.post('/api/move-to/:name', async (req, res) => {
  const targetName = req.params.name.toLowerCase();
  const { 'job-title': jobTitle, company, location } = req.body;
  const input = { 'job-title': jobTitle, company, location };
  const text = [jobTitle, company, location].filter(Boolean).join(' | ');

  const reply = (moved, toColumn, success) => res.json({ toBeMoved: input, moved, toColumn, success });

  if (!text)                    return reply(null, null,            false);
  if (location === 'test-city') return reply(null, null,            true);

  const data = await loadData();
  const targetCol = data.columns.find(c => c.title.toLowerCase() === targetName);
  if (!targetCol)               return reply(null, req.params.name, false);

  let card = null;
  let sourceColTitle = null;
  for (const col of data.columns) {
    const idx = col.cards.findIndex(c => c.text === text);
    if (idx !== -1) { sourceColTitle = col.title; [card] = col.cards.splice(idx, 1); break; }
  }

  if (!card)                    return reply(null, targetCol.title, false);

  if (!card.moves) card.moves = [];
  card.moves.push({ at: new Date().toISOString(), from: sourceColTitle, to: targetCol.title });

  targetCol.cards.unshift(card);
  await saveData(data);
  reply(card, targetCol.title, true);
});

app.get('/api/card/:id', async (req, res) => {
  try {
    const data = await loadData();
    for (const col of data.columns) {
      const card = col.cards.find(c => c.id === req.params.id);
      if (card) return res.json({ created: card.created || null, moves: card.moves || [], column: col.title });
    }
    res.status(404).json({ error: 'Card not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/column/:name', async (req, res) => {
  const name = req.params.name.toLowerCase();
  const data = await loadData();
  const col = data.columns.find(c => c.title.toLowerCase() === name);
  if (!col) return res.status(404).json({ error: `Column "${req.params.name}" not found` });
  res.json(col.cards);
});

app.patch('/api/board', async (req, res) => {
  try {
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
        if (idx !== -1) columns[idx] = col;
        else columns.push(col);
      }
    }

    if (columnOrder?.length) {
      const map = new Map(columns.map(c => [c.id, c]));
      columns = columnOrder.map(id => map.get(id)).filter(Boolean);
    }

    await db.insert({ _id: DOC_ID, _rev, columns });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to patch board:', err.message);
    res.status(500).json({ error: 'Failed to patch board', details: err.message });
  }
});

app.put('/api/board', async (req, res) => {
  try {
    await saveData(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save board:', err.message);
    res.status(500).json({ error: 'Failed to save board', details: err.message });
  }
});

app.post('/api/import', async (req, res) => {
  let items;
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

  const data = await loadData();

  // Find or create dated Inbox column
  const now = new Date();
  const inboxTitle = `Inbox ${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.`;
  let inbox = data.columns.find(c => c.title === inboxTitle);
  if (!inbox) {
    inbox = { id: 'id-' + Math.random().toString(36).slice(2, 9), title: inboxTitle, cards: [], color: '#06b6d4' };
    data.columns.unshift(inbox);
  }

  // Collect all existing card texts for deduplication
  const existingTexts = new Set(data.columns.flatMap(c => c.cards.map(card => card.text)));

  const relevant_items = [];
  const excluded_items = [];
  const skipped_items  = [];

  for (const { item, color, bucket } of rawItems) {
    const normalized = { ...item };
    // Normalise: job-title / company / location format → text + description
    if (normalized['job-title'] || normalized.company || normalized.location) {
      normalized.text = [normalized['job-title'], normalized.company, normalized.location].filter(Boolean).join(' | ');
      if (normalized.reason) normalized.description = normalized.reason;
    }

    if (!normalized.text || existingTexts.has(normalized.text)) {
      skipped_items.push(item);
      continue;
    }

    const card = { id: 'id-' + Math.random().toString(36).slice(2, 9), text: normalized.text, color: color || normalized.color || '#06b6d4', created: new Date().toISOString().slice(0, 10) };
    if (normalized.priority)    card.priority    = normalized.priority;
    if (normalized.description) card.description = normalized.description;
    if (normalized.link)        card.link        = normalized.link;
    if (normalized.startDate)   card.startDate   = normalized.startDate;
    if (normalized.endDate)     card.endDate     = normalized.endDate;

    inbox.cards.push(card);
    existingTexts.add(normalized.text);
    if (bucket === 'excluded') excluded_items.push(item);
    else                       relevant_items.push(item);
  }

  await saveData(data);
  res.json({
    relevant:       relevant_items.length,
    relevant_items,
    excluded:       excluded_items.length,
    excluded_items,
    skipped:        skipped_items.length,
    skipped_items,
  });
});

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
  try {
    res.json(await loadPrompts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/prompts', async (req, res) => {
  try {
    const { searchProfile = '', criteriaInclude = '', criteriaExclude = '', searchRadius = '' } = req.body;
    await savePrompts({ searchProfile, criteriaInclude, criteriaExclude, searchRadius });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kanban server running at http://${HOST}:${PORT}`);
    });
    runBackup();
    setInterval(runBackup, BACKUP_INTERVAL_MS);
    runPromptsBackup();
    setInterval(runPromptsBackup, BACKUP_INTERVAL_MS);
  })
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
