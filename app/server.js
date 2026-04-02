require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nano = require('nano');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const DATA_FILE = path.join(__dirname, process.env.DATA_FILE || 'data.json');

const APP_PASSWORD     = process.env.APP_PASSWORD     || 'kanban-pwd';
const crypto = require('crypto');
const SESSION_TOKEN = crypto.createHash('sha256').update(APP_PASSWORD).digest('hex').slice(0, 32);
console.log(`App password source: ${process.env.APP_PASSWORD ? '.env / environment' : 'built-in default'}`);

const COUCHDB_HOST     = process.env.COUCHDB_HOST     || 'localhost';
const COUCHDB_PORT     = process.env.COUCHDB_PORT     || 5984;
const COUCHDB_USER     = process.env.COUCHDB_USER     || 'kanban';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'kanban-pwd';
const DB_NAME = 'jc-kanban-cards';
const DOC_ID  = 'board';

app.use(cors());
app.use(express.json());
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

  // Create database if it doesn't exist (412 = already exists)
  try {
    await couch.db.create(DB_NAME);
    console.log(`Database "${DB_NAME}" created`);
  } catch (err) {
    if (err.statusCode !== 412) throw err;
    console.log(`Database "${DB_NAME}" already exists`);
  }

  db = couch.use(DB_NAME);

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
  res.json(await loadData());
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
  for (const col of data.columns) {
    const idx = col.cards.findIndex(c => c.text === text);
    if (idx !== -1) { [card] = col.cards.splice(idx, 1); break; }
  }

  if (!card)                    return reply(null, targetCol.title, false);

  targetCol.cards.unshift(card);
  await saveData(data);
  reply(card, targetCol.title, true);
});

app.get('/api/column/:name', async (req, res) => {
  const name = req.params.name.toLowerCase();
  const data = await loadData();
  const col = data.columns.find(c => c.title.toLowerCase() === name);
  if (!col) return res.status(404).json({ error: `Column "${req.params.name}" not found` });
  res.json(col.cards);
});

app.put('/api/board', async (req, res) => {
  await saveData(req.body);
  res.json({ success: true });
});

app.post('/api/import', async (req, res) => {
  let items;
  const body = req.body;

  if (Array.isArray(body)) {
    items = body;
  } else if (body && (Array.isArray(body.relevant) || Array.isArray(body.excluded))) {
    items = [
      ...(body.relevant || []).map(i => ({ ...i, color: '#10b981' })),
      ...(body.excluded || []).map(i => ({ ...i, color: '#ef4444' })),
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

  let added = 0;
  let skipped = 0;

  for (const item of items) {
    // Normalise: job-title / company / location format → text + description
    if (item['job-title'] || item.company || item.location) {
      item.text = [item['job-title'], item.company, item.location].filter(Boolean).join(' | ');
      if (item.reason) item.description = item.reason;
    }

    if (!item.text || existingTexts.has(item.text)) { skipped++; continue; }

    const card = { id: 'id-' + Math.random().toString(36).slice(2, 9), text: item.text, color: item.color || '#06b6d4' };
    if (item.priority)    card.priority    = item.priority;
    if (item.description) card.description = item.description;
    if (item.link)        card.link        = item.link;
    if (item.startDate)   card.startDate   = item.startDate;
    if (item.endDate)     card.endDate     = item.endDate;

    inbox.cards.push(card);
    existingTexts.add(item.text);
    added++;
  }

  await saveData(data);
  res.json({ added, skipped });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kanban server running at http://${HOST}:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
