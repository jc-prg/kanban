const nano = require('nano');
const {
  COUCHDB_HOST, COUCHDB_PORT, COUCHDB_USER, COUCHDB_PASSWORD,
  DB_PREFIX, DOC_ID, NOTES_DOC_ID, PROMPTS_DB_NAME,
} = require('./config');

let couch;
let promptsDb;

function getCouch()     { return couch; }
function getPromptsDb() { return promptsDb; }

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitize(val) {
  if (Array.isArray(val)) return val.map(sanitize);
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val)
        .filter(([k]) => !DANGEROUS_KEYS.has(k))
        .map(([k, v]) => [k, sanitize(v)])
    );
  }
  return val;
}

function validBoardName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64 && name !== 'inbox';
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
  return db.insert({ _id: DOC_ID, _rev, ...sanitize(data) });
}

async function loadNotesData(db) {
  try {
    const { _id, _rev, ...data } = await db.get(NOTES_DOC_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return { pages: [] };
    throw err;
  }
}

async function upsertDoc(db, id, data) {
  let rev;
  try { ({ _rev: rev } = await db.get(id)); } catch { /* new doc */ }
  return db.insert({ _id: id, ...(rev ? { _rev: rev } : {}), ...sanitize(data) });
}

async function saveNotesData(db, data) {
  return upsertDoc(db, NOTES_DOC_ID, data);
}

function withHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: err.message });
    }
  };
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

function withExistingBoard(handler) {
  return async (req, res) => {
    const { board } = req.params;
    if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
    try {
      const all = await couch.db.list();
      if (!all.includes(DB_PREFIX + board)) return res.status(404).json({ error: 'Board not found' });
      const db = couch.use(DB_PREFIX + board);
      await handler(req, res, db);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: err.message });
    }
  };
}

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

module.exports = {
  getCouch, getPromptsDb,
  validBoardName, getBoardDb,
  loadBoardData, saveBoardData,
  loadNotesData, saveNotesData,
  upsertDoc, withHandler, withBoard, withExistingBoard,
  initDb,
};
