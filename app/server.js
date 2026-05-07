require('dotenv').config();
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const nano     = require('nano');
const crypto   = require('crypto');
const multer   = require('multer');
const archiver = require('archiver');
const Ajv      = require('ajv');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

const APP_PASSWORD  = process.env.APP_PASSWORD || 'kanban-pwd';
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const API_KEY       = process.env.API_KEY || '';
console.log(`App password source: ${process.env.APP_PASSWORD ? '.env / environment' : 'built-in default'}`);
console.log(`API key: ${API_KEY ? 'set' : 'not set (external API access disabled)'}`);
if (API_KEY && API_KEY.length < 32)
  console.warn('WARNING: API_KEY is shorter than 32 characters — use a strong random key in production');

const COUCHDB_HOST     = process.env.COUCHDB_HOST     || 'localhost';
const COUCHDB_PORT     = process.env.COUCHDB_PORT     || 5984;
const COUCHDB_USER     = process.env.COUCHDB_USER     || 'kanban';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'kanban-pwd';
const DB_PREFIX        = 'jc-kanban-';
const DOC_ID           = 'board';
const NOTES_DOC_ID     = 'notes';
const PROMPTS_DB_NAME  = 'jc-extension-prompts';
const BACKUP_DIR       = path.join(__dirname, process.env.BACKUP_DIR || 'data');
const BACKUP_INTERVAL_MS = parseInt(process.env.BACKUP_INTERVAL_MS, 10) || 600000;
const ATTACHMENTS_DIR  = path.join(BACKUP_DIR, 'attachments');
const JSON_BACKUP_DIR  = path.join(BACKUP_DIR, 'json');
const COUCHDB_DATA_DIR = path.join(BACKUP_DIR, 'couchdb');
const LOG_API_RESPONSES = process.env.LOG_API_RESPONSES === 'true';

let dbSizeBytes = 0;

function computeDirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += computeDirSize(full);
      else if (entry.isFile()) try { total += fs.statSync(full).size; } catch {}
    }
  } catch {}
  return total;
}

function refreshDbSize() {
  dbSizeBytes = computeDirSize(COUCHDB_DATA_DIR);
}

const DB_SIZE_INTERVAL_MS = 15 * 60 * 1000;

// ---- Input validation schemas ----
const ajv = new Ajv({ allErrors: true, strict: false });

const _moveSchema = {
  type: 'object', additionalProperties: false,
  properties: { at: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }
};
const _cardSchema = {
  type: 'object', required: ['id', 'text'], additionalProperties: false,
  properties: {
    id:          { type: 'string', minLength: 1 },
    text:        { type: 'string' },
    color:       { type: 'string' },
    priority:    { type: 'integer', minimum: 1, maximum: 5 },
    description: { type: 'string' },
    link:        { type: 'string' },
    startDate:   { type: 'string' },
    endDate:     { type: 'string' },
    done:         { type: 'boolean' },
    doneAt:       { type: 'string' },
    created:      { type: 'string' },
    lastModified: { type: 'string' },
    moves:        { type: 'array', items: _moveSchema }
  }
};
const _columnSchema = {
  type: 'object', required: ['id', 'title', 'cards'], additionalProperties: false,
  properties: {
    id:      { type: 'string', minLength: 1 },
    title:   { type: 'string' },
    color:   { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
    cards:   { type: 'array', items: _cardSchema }
  }
};
const _settingsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    description:        { type: 'string' },
    archived:           { type: 'boolean' },
    inboxWithDate:      { type: 'boolean' },
    persistCollapse:    { type: 'boolean' },
    collapsedColumnIds: { type: 'array', items: { type: 'string' } },
    trackedColumns:     { type: 'array', items: { type: 'string' } },
    notesSidebarOpen:      { type: 'boolean' },
    notesSidebarWidth:     { type: 'number' },
    notesFontSize:         { type: 'number' },
    autoSaveDialogs:       { type: 'boolean' },
    autoSaveIntervalMin:   { type: 'number' }
  }
};

const validateBoard = ajv.compile({
  type: 'object', required: ['columns'], additionalProperties: false,
  properties: { columns: { type: 'array', items: _columnSchema }, settings: _settingsSchema }
});
const validateBoardPatch = ajv.compile({
  type: 'object', additionalProperties: false,
  properties: {
    columnOrder:      { type: 'array', items: { type: 'string' } },
    updatedColumns:   { type: 'array', items: _columnSchema },
    removedColumnIds: { type: 'array', items: { type: 'string' } },
    settings:         _settingsSchema
  }
});
const validateNotes = ajv.compile({
  type: 'object', required: ['pages'], additionalProperties: false,
  properties: { pages: { type: 'array', items: { $ref: '#/definitions/page' } } },
  definitions: {
    page: {
      type: 'object', required: ['id', 'title'], additionalProperties: false,
      properties: {
        id:             { type: 'string', minLength: 1 },
        title:          { type: 'string' },
        description:    { type: 'string' },
        link:           { type: 'string' },
        linkedCards:    { type: 'array', items: { type: 'string' } },
        hasAttachments: { type: 'boolean' },
        lastModified:   { type: 'string' },
        children:       { type: 'array', items: { $ref: '#/definitions/page' } }
      }
    }
  }
});
const _notePagePatchSchema = {
  type: 'object', required: ['id'], additionalProperties: false,
  properties: {
    id:             { type: 'string', minLength: 1 },
    title:          { type: 'string' },
    description:    { type: 'string' },
    link:           { type: 'string' },
    linkedCards:    { type: 'array', items: { type: 'string' } },
    hasAttachments: { type: 'boolean' },
    lastModified:   { type: 'string' }
  }
};
const validateNotesPatch = ajv.compile({
  type: 'object', additionalProperties: false,
  properties: {
    updatedPages: { type: 'array', items: _notePagePatchSchema }
  }
});

function schemaError(validate) {
  return validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const REDACT_REQ_KEYS  = new Set(['password']);
const REDACT_RES_KEYS  = new Set(['token', 'apiKey']);

function redact(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, keys.has(k) ? '[redacted]' : v]));
}

if (LOG_API_RESPONSES) {
  app.use('/api', (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      console.log(`[API] ${req.method} ${req.originalUrl}`);
      if (req.body && Object.keys(req.body).length) console.log('  req :', JSON.stringify(redact(req.body, REDACT_REQ_KEYS)));
      console.log('  res :', JSON.stringify(redact(body, REDACT_RES_KEYS)));
      return originalJson(body);
    };
    next();
  });
}


let couch;
let promptsDb;

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
  return db.insert({ _id: DOC_ID, _rev, ...data });
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

async function saveNotesData(db, data) {
  let rev;
  try { ({ _rev: rev } = await db.get(NOTES_DOC_ID)); } catch (e) { /* new doc */ }
  return db.insert({ _id: NOTES_DOC_ID, ...(rev ? { _rev: rev } : {}), ...data });
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

// ---- Auth protection ----
// Timing-safe comparison using fixed-length 128-byte buffers to avoid length leaks
function safeEqual(a, b) {
  const bufA = Buffer.alloc(128);
  const bufB = Buffer.alloc(128);
  Buffer.from(String(a || '')).copy(bufA, 0, 0, 128);
  Buffer.from(String(b || '')).copy(bufB, 0, 0, 128);
  return crypto.timingSafeEqual(bufA, bufB);
}

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15-minute sliding window
const RATE_MAX       = 10;             // max login attempts per window
const LOCKOUT_AFTER  = 5;             // consecutive failures before lockout
const LOCKOUT_MS     = 15 * 60 * 1000;
const loginMap       = new Map();      // ip -> { count, windowStart, consecutive, lockedUntil }

const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000; // window for API auth-failure tracking
const AUTH_FAIL_MAX       = 20;             // max failed auth attempts per window before 429
const authFailMap         = new Map();      // ip -> { count, windowStart }

const WRITE_WINDOW_MS  = 15 * 60 * 1000;  // 15-minute window for write rate limiting
const WRITE_MAX        = 200;              // max write requests per window
const UPLOAD_MAX       = 30;              // max upload requests per window
const writeMap         = new Map();        // ip -> { count, windowStart }
const uploadMap        = new Map();        // ip -> { count, windowStart }

function makeWriteLimiter(map, max) {
  return function writeLimiter(req, res, next) {
    const ip  = req.ip;
    const now = Date.now();
    let s = map.get(ip);
    if (!s || now > s.windowStart + WRITE_WINDOW_MS) {
      s = { count: 0, windowStart: now };
      map.set(ip, s);
    }
    s.count++;
    if (s.count > max)
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    next();
  };
}

const writeRateLimit  = makeWriteLimiter(writeMap,  WRITE_MAX);
const uploadRateLimit = makeWriteLimiter(uploadMap, UPLOAD_MAX);

// Purge expired entries every window cycle
setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of loginMap)
    if (now > s.windowStart + RATE_WINDOW_MS && now > s.lockedUntil) loginMap.delete(ip);
  for (const [ip, s] of authFailMap)
    if (now > s.windowStart + AUTH_FAIL_WINDOW_MS) authFailMap.delete(ip);
  for (const [ip, s] of writeMap)
    if (now > s.windowStart + WRITE_WINDOW_MS) writeMap.delete(ip);
  for (const [ip, s] of uploadMap)
    if (now > s.windowStart + WRITE_WINDOW_MS) uploadMap.delete(ip);
}, WRITE_WINDOW_MS);

function loginState(ip) {
  const now = Date.now();
  let s = loginMap.get(ip);
  if (!s) { s = { count: 0, windowStart: now, consecutive: 0, lockedUntil: 0 }; loginMap.set(ip, s); }
  if (now > s.windowStart + RATE_WINDOW_MS) { s.count = 0; s.windowStart = now; } // reset window
  return s;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  let s = authFailMap.get(ip);
  if (!s || now > s.windowStart + AUTH_FAIL_WINDOW_MS) {
    s = { count: 0, windowStart: now };
    authFailMap.set(ip, s);
  }
  s.count++;
  if (s.count === AUTH_FAIL_MAX)
    console.warn(`Auth rate limit reached for IP ${ip} — blocking further unauthenticated requests`);
  return s.count;
}

// ---- Cookie helpers ----
function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

// ---- Auth middleware ----
function authenticate(req, res, next) {
  if (req.path === '/auth' || req.path === '/auth/verify' || req.path === '/auth/logout') return next();

  const cookies = parseCookies(req);
  if (safeEqual(cookies['kanban-session'] || '', SESSION_TOKEN)) return next();

  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const apiKey = req.headers['x-api-key'] || '';
  if (API_KEY && (safeEqual(bearer, API_KEY) || safeEqual(apiKey, API_KEY))) return next();

  const failCount = recordAuthFailure(req.ip);
  if (failCount > AUTH_FAIL_MAX)
    return res.status(429).json({ error: 'Too many unauthorized requests. Try again later.' });
  res.status(401).json({ error: 'Unauthorized' });
}

app.use('/api', authenticate);

// ---- Auth ----
app.post('/api/auth', (req, res) => {
  const ip = req.ip;
  const s  = loginState(ip);

  if (Date.now() < s.lockedUntil)
    return res.status(429).json({ ok: false, error: 'Too many failed attempts. Try again later.' });
  if (s.count >= RATE_MAX)
    return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });

  s.count++;
  const { password } = req.body;
  if (safeEqual(password, APP_PASSWORD)) {
    s.consecutive = 0;
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('kanban-session', SESSION_TOKEN, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
    res.json({ ok: true });
  } else {
    s.consecutive++;
    if (s.consecutive >= LOCKOUT_AFTER) {
      s.lockedUntil = Date.now() + LOCKOUT_MS;
      console.warn(`Login locked for IP ${ip} after ${s.consecutive} consecutive failures`);
    } else {
      console.warn(`Failed login from IP ${ip} (${s.consecutive} consecutive)`);
    }
    res.status(401).json({ ok: false });
  }
});

app.get('/api/auth/verify', (req, res) => {
  const cookies = parseCookies(req);
  res.json({ ok: safeEqual(cookies['kanban-session'] || '', SESSION_TOKEN) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('kanban-session', { path: '/', sameSite: 'strict' });
  res.json({ ok: true });
});

// ---- Global settings ----
app.get('/api/settings', (req, res) => {
  res.json({ apiKeyConfigured: !!API_KEY });
});

// ---- Board list / management ----
function getBoardAttachStats(name) {
  const boardDir = path.join(ATTACHMENTS_DIR, name);
  let count = 0, size = 0;
  if (!fs.existsSync(boardDir)) return { count, size };
  for (const sub of fs.readdirSync(boardDir)) {
    const subDir = path.join(boardDir, sub);
    try {
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const file of fs.readdirSync(subDir).filter(n => !n.startsWith('.'))) {
        count++;
        size += fs.statSync(path.join(subDir, file)).size;
      }
    } catch {}
  }
  return { count, size };
}

app.get('/api/boards', async (req, res) => {
  try {
    const all = await couch.db.list();
    const names = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length)).sort();
    const boards = await Promise.all(names.map(async name => {
      try {
        const data = await loadBoardData(couch.use(DB_PREFIX + name));
        const visibleCards    = col => col.cards.filter(c => !c.text?.startsWith('#'));
        const totalCards      = data.columns.reduce((s, c) => s + visibleCards(c).length, 0);
        const inboxCount      = data.columns.filter(c => /^inbox/i.test(c.title)).reduce((s, c) => s + visibleCards(c).length, 0);
        const todoCount       = data.columns.filter(c => /^todo/i.test(c.title)).reduce((s, c) => s + visibleCards(c).length, 0);
        const inProgressCount = data.columns.filter(c => /^in.?progress/i.test(c.title) || /^doing$/i.test(c.title)).reduce((s, c) => s + visibleCards(c).length, 0);
        const trackedCounts   = (data.settings?.trackedColumns || []).map(title => {
          const col = data.columns.find(c => c.title === title);
          return col ? { title, count: visibleCards(col).length, color: col.color || null } : null;
        }).filter(Boolean);
        const { count: attachCount, size: attachSize } = getBoardAttachStats(name);
        return { name, description: data.settings?.description || '', archived: data.settings?.archived || false, totalCards, inboxCount, todoCount, inProgressCount, trackedCounts, attachCount, attachSize };
      } catch (e) {
        return { name, description: '', totalCards: 0, inboxCount: 0, todoCount: 0, inProgressCount: 0, trackedCounts: [], attachCount: 0, attachSize: 0 };
      }
    }));
    res.json(boards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/achievements/today', async (req, res) => {
  try {
    const today = req.query.date || new Date().toISOString().slice(0, 10);
    const all   = await couch.db.list();
    const names = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
    let created = 0, moved = 0, done = 0, hasPast = false;
    const createdBoards = {}, movedBoards = {}, doneBoards = {};
    await Promise.all(names.map(async name => {
      try {
        const data = await loadBoardData(couch.use(DB_PREFIX + name));
        if (data.settings?.archived) return;
        for (const col of data.columns) {
          for (const card of col.cards) {
            if (card.created?.startsWith(today)) { created++; createdBoards[name] = (createdBoards[name] || 0) + 1; }
            if (card.moves?.some(m => m.at?.startsWith(today))) { moved++; movedBoards[name] = (movedBoards[name] || 0) + 1; }
            const donByFlag = card.doneAt?.startsWith(today);
            const doneByMove = !donByFlag && card.moves?.some(m => m.at?.startsWith(today) && /^done/i.test(m.to));
            if (donByFlag || doneByMove) { done++; doneBoards[name] = (doneBoards[name] || 0) + 1; }
            if (!hasPast) {
              if (card.created && card.created < today) hasPast = true;
              else if (card.moves?.some(m => m.at?.slice(0, 10) < today)) hasPast = true;
              else if (card.doneAt && card.doneAt.slice(0, 10) < today) hasPast = true;
              else if (card.moves?.some(m => /^done/i.test(m.to) && m.at?.slice(0, 10) < today)) hasPast = true;
            }
          }
        }
      } catch (e) { /* skip broken boards */ }
    }));
    res.json({ created, moved, done, createdBoards, movedBoards, doneBoards, hasPast });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/boards/:name', writeRateLimit, async (req, res) => {
  const { name } = req.params;
  if (!validBoardName(name)) return res.status(400).json({ error: 'Invalid board name. Use lowercase letters, digits and hyphens only.' });
  try {
    await getBoardDb(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/boards/:name/rename', writeRateLimit, async (req, res) => {
  const { name } = req.params;
  const { newName } = req.body;
  if (!validBoardName(name)) return res.status(400).json({ error: 'Invalid board name' });
  if (!validBoardName(newName) || newName.length > 12)
    return res.status(400).json({ error: 'Invalid new name. Use up to 12 lowercase letters, digits and hyphens.' });
  if (name === newName) return res.status(400).json({ error: 'New name is identical to current name' });
  try {
    // Fail fast if target already exists
    try {
      await couch.db.create(DB_PREFIX + newName);
    } catch (err) {
      if (err.statusCode === 412) return res.status(409).json({ error: 'A board with that name already exists' });
      throw err;
    }
    // Copy data to new DB (fresh DB has no doc yet, so insert directly)
    const data = await loadBoardData(couch.use(DB_PREFIX + name));
    await couch.use(DB_PREFIX + newName).insert({ _id: DOC_ID, ...data });
    // Remove old DB
    await couch.db.destroy(DB_PREFIX + name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/boards/:name', writeRateLimit, async (req, res) => {
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

app.put('/api/prompts', writeRateLimit, async (req, res) => {
  try {
    const { searchProfile = '', criteriaInclude = '', criteriaExclude = '', searchRadius = '' } = req.body;
    await savePrompts({ searchProfile, criteriaInclude, criteriaExclude, searchRadius });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Board API ----
app.get('/api/:board/board', withExistingBoard(async (req, res, db) => {
  const { _id, _rev, ...data } = await db.get(DOC_ID);
  const etag = `"${_rev}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('ETag', etag);
  res.json(data);
}));

app.put('/api/:board/board', writeRateLimit, withBoard(async (req, res, db) => {
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

app.patch('/api/:board/board', writeRateLimit, withBoard(async (req, res, db) => {
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

app.get('/api/:board/all-columns', withBoard(async (req, res, db) => {
  const data = await loadBoardData(db);
  const result = {};
  data.columns.forEach(col => { result[col.title] = col.cards; });
  res.json(result);
}));

app.get('/api/:board/column/:name', withBoard(async (req, res, db) => {
  const name = req.params.name.toLowerCase();
  const data = await loadBoardData(db);
  const col = data.columns.find(c => c.title.toLowerCase() === name);
  if (!col) return res.status(404).json({ error: `Column "${req.params.name}" not found` });
  res.json(col.cards);
}));

app.get('/api/:board/notes', withExistingBoard(async (req, res, db) => {
  try {
    const { _id, _rev, ...data } = await db.get(NOTES_DOC_ID);
    const etag = `"${_rev}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.json(data);
  } catch (err) {
    if (err.statusCode === 404) return res.json({ pages: [] });
    throw err;
  }
}));

app.put('/api/:board/notes', writeRateLimit, withBoard(async (req, res, db) => {
  if (!validateNotes(req.body))
    return res.status(400).json({ error: 'Invalid notes data', details: schemaError(validateNotes) });
  const ifMatch = req.headers['if-match'];
  if (ifMatch) {
    let rev;
    try { ({ _rev: rev } = await db.get(NOTES_DOC_ID)); } catch (e) { /* new doc — no conflict */ }
    if (rev && ifMatch !== `"${rev}"`) return res.status(409).json({ error: 'conflict' });
  }
  const result = await saveNotesData(db, req.body);
  res.setHeader('ETag', `"${result.rev}"`);
  res.json({ ok: true });
}));

app.patch('/api/:board/notes', writeRateLimit, withBoard(async (req, res, db) => {
  if (!validateNotesPatch(req.body))
    return res.status(400).json({ error: 'Invalid notes patch', details: schemaError(validateNotesPatch) });
  const { updatedPages = [] } = req.body;
  if (!updatedPages.length) return res.json({ ok: true });
  let notes, currentRev;
  try {
    const { _id, _rev, ...data } = await db.get(NOTES_DOC_ID);
    currentRev = _rev;
    notes = data;
  } catch (err) {
    if (err.statusCode === 404) { notes = { pages: [] }; }
    else throw err;
  }
  const ifMatch = req.headers['if-match'];
  if (ifMatch && currentRev && ifMatch !== `"${currentRev}"`) return res.status(409).json({ error: 'conflict' });
  function upsertPage(pages, patch) {
    for (const p of pages) {
      if (p.id === patch.id) { Object.assign(p, patch); return true; }
      if (p.children?.length && upsertPage(p.children, patch)) return true;
    }
    return false;
  }
  for (const page of updatedPages) upsertPage(notes.pages, page);
  const result = await saveNotesData(db, notes);
  res.setHeader('ETag', `"${result.rev}"`);
  res.json({ ok: true });
}));

app.get('/api/:board/card/:id', withBoard(async (req, res, db) => {
  const data = await loadBoardData(db);
  for (const col of data.columns) {
    const card = col.cards.find(c => c.id === req.params.id);
    if (card) return res.json({ created: card.created || null, moves: card.moves || [], column: col.title });
  }
  res.status(404).json({ error: 'Card not found' });
}));

app.post('/api/:board/move-to/:name', writeRateLimit, withBoard(async (req, res, db) => {
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

app.post('/api/:board/import', writeRateLimit, withBoard(async (req, res, db) => {
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

// ---- Notes Attachments ----
// Files live at ATTACHMENTS_DIR/<board>/<pageId>/<filename>

function safePageId(id) {
  return typeof id === 'string' && /^n-[a-z0-9]{1,20}$/.test(id);
}
function safeFilename(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && !/[/\\]/.test(name) && !name.includes('..');
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(ATTACHMENTS_DIR, req.params.board, req.params.pageId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const safe = file.originalname
        .replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_')
        .replace(/^\./, '_').slice(0, 200) || 'file';
      cb(null, safe);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.get('/api/:board/notes/attachments/:pageId', (req, res) => {
  const { board, pageId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safePageId(pageId))   return res.status(400).json({ error: 'Invalid page id' });
  const dir = path.join(ATTACHMENTS_DIR, board, pageId);
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    const files = fs.readdirSync(dir).filter(n => !n.startsWith('.')).map(name => ({
      name, size: fs.statSync(path.join(dir, name)).size,
    }));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/:board/notes/attachments/:pageId', uploadRateLimit, (req, res) => {
  const { board, pageId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safePageId(pageId))   return res.status(400).json({ error: 'Invalid page id' });
  upload.single('file')(req, res, err => {
    if (err)       return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ name: req.file.filename, size: req.file.size });
  });
});

app.get('/api/:board/notes/attachments/:pageId/:filename', (req, res) => {
  const { board, pageId, filename } = req.params;
  if (!validBoardName(board) || !safePageId(pageId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  const fp = path.join(ATTACHMENTS_DIR, board, pageId, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(fp);
});

app.delete('/api/:board/notes/attachments/:pageId/:filename', writeRateLimit, (req, res) => {
  const { board, pageId, filename } = req.params;
  if (!validBoardName(board) || !safePageId(pageId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  try { fs.unlinkSync(path.join(ATTACHMENTS_DIR, board, pageId, filename)); } catch {}
  res.json({ ok: true });
});

// ---- Card Attachments ----
// Files live at ATTACHMENTS_DIR/<board>/<cardId>/<filename>

function safeCardId(id) {
  return typeof id === 'string' && /^id-[a-z0-9]{1,10}$/.test(id);
}

// Returns all card IDs that have at least one attachment file.
app.get('/api/:board/cards/attachments', (req, res) => {
  const { board } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  const boardDir = path.join(ATTACHMENTS_DIR, board);
  if (!fs.existsSync(boardDir)) return res.json([]);
  try {
    const ids = fs.readdirSync(boardDir).filter(name => {
      if (!safeCardId(name)) return false;
      const dir = path.join(boardDir, name);
      try {
        return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).some(f => !f.startsWith('.'));
      } catch { return false; }
    });
    res.json(ids);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const uploadCard = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(ATTACHMENTS_DIR, req.params.board, req.params.cardId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const safe = file.originalname
        .replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_')
        .replace(/^\./, '_').slice(0, 200) || 'file';
      cb(null, safe);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.get('/api/:board/cards/attachments/:cardId', (req, res) => {
  const { board, cardId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safeCardId(cardId))   return res.status(400).json({ error: 'Invalid card id' });
  const dir = path.join(ATTACHMENTS_DIR, board, cardId);
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    const files = fs.readdirSync(dir).filter(n => !n.startsWith('.')).map(name => ({
      name, size: fs.statSync(path.join(dir, name)).size,
    }));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/:board/cards/attachments/:cardId', uploadRateLimit, (req, res) => {
  const { board, cardId } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  if (!safeCardId(cardId))   return res.status(400).json({ error: 'Invalid card id' });
  uploadCard.single('file')(req, res, err => {
    if (err)       return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ name: req.file.filename, size: req.file.size });
  });
});

app.get('/api/:board/cards/attachments/:cardId/:filename', (req, res) => {
  const { board, cardId, filename } = req.params;
  if (!validBoardName(board) || !safeCardId(cardId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  const fp = path.join(ATTACHMENTS_DIR, board, cardId, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(fp);
});

app.delete('/api/:board/cards/attachments/:cardId/:filename', writeRateLimit, (req, res) => {
  const { board, cardId, filename } = req.params;
  if (!validBoardName(board) || !safeCardId(cardId) || !safeFilename(filename))
    return res.status(400).json({ error: 'Invalid request' });
  try { fs.unlinkSync(path.join(ATTACHMENTS_DIR, board, cardId, filename)); } catch {}
  res.json({ ok: true });
});

app.get('/api/:board/attachment-stats', (req, res) => {
  const { board } = req.params;
  if (!validBoardName(board)) return res.status(400).json({ error: 'Invalid board name' });
  const boardDir = path.join(ATTACHMENTS_DIR, board);
  if (!fs.existsSync(boardDir)) return res.json({ count: 0, size: 0 });
  let count = 0, size = 0;
  try {
    for (const sub of fs.readdirSync(boardDir)) {
      const subDir = path.join(boardDir, sub);
      try {
        if (!fs.statSync(subDir).isDirectory()) continue;
        for (const file of fs.readdirSync(subDir).filter(n => !n.startsWith('.'))) {
          count++;
          size += fs.statSync(path.join(subDir, file)).size;
        }
      } catch {}
    }
    res.json({ count, size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/db-size', (req, res) => {
  res.json({ size: dbSizeBytes });
});

app.get('/api/:board/notes/export', withExistingBoard(async (req, res, db) => {
  const { board } = req.params;
  const notes    = await loadNotesData(db);
  const boardDir = path.join(ATTACHMENTS_DIR, board);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => console.error('ZIP error:', err.message));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="notes-${board}.zip"`);
  archive.pipe(res);

  function addPages(pages, prefix) {
    for (const p of pages) {
      const dir = prefix + (p.title || 'Untitled').replace(/[/\\<>:|*?"]/g, '_').trim() + '/';
      const md  = (p.description || '').replace(/\(attachment:([^)\s]+)\)/g, '(./attachments/$1)');
      archive.append(md, { name: dir + 'page.md' });
      const aDir = path.join(boardDir, p.id);
      if (fs.existsSync(aDir))
        fs.readdirSync(aDir).filter(n => !n.startsWith('.')).forEach(f =>
          archive.file(path.join(aDir, f), { name: dir + 'attachments/' + f }));
      if (p.children?.length) addPages(p.children, dir);
    }
  }

  addPages(notes.pages || [], '');
  await archive.finalize();
}));

// ---- SPA catch-all (must be after all API routes) ----
const SPA_HTML = path.join(__dirname, 'public', 'index.html');
app.get('/:board', (req, res) => res.sendFile(SPA_HTML));
app.get('/:board/*path', (req, res) => res.sendFile(SPA_HTML));

// ---- Backup ----
async function runBackup() {
  try {
    if (!fs.existsSync(JSON_BACKUP_DIR)) fs.mkdirSync(JSON_BACKUP_DIR, { recursive: true });
    const all = await couch.db.list();
    const names = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
    for (const name of names) {
      try {
        const db = couch.use(DB_PREFIX + name);
        const data = await loadBoardData(db);
        fs.writeFileSync(path.join(JSON_BACKUP_DIR, `kanban-${name}-board.json`), JSON.stringify(data, null, 2), 'utf-8');
        try {
          const { _id, _rev, ...notesData } = await db.get(NOTES_DOC_ID);
          fs.writeFileSync(path.join(JSON_BACKUP_DIR, `kanban-${name}-notes.json`), JSON.stringify(notesData, null, 2), 'utf-8');
        } catch (e) { if (e.statusCode !== 404) console.error(`Notes backup for board "${name}" failed:`, e.message); }
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
    if (!fs.existsSync(JSON_BACKUP_DIR)) fs.mkdirSync(JSON_BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(JSON_BACKUP_DIR, 'extension-prompts.json'), JSON.stringify(docs, null, 2), 'utf-8');
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

// ---- Startup directory check ----
function checkDataDirectories() {
  const dirs = [JSON_BACKUP_DIR, ATTACHMENTS_DIR];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      console.error(`\nSTARTUP WARNING: Cannot write to "${dir}"`);
      console.error(`  Error: ${err.message}`);
      console.error(`  File uploads and backups will fail until this is fixed.`);
      console.error(`  Fix (Docker): run  chown -R 1000:1000 ./data  on the host.\n`);
    }
  }
}

initDb()
  .then(() => {
    checkDataDirectories();
    app.listen(PORT, () => console.log(`Kanban server running at http://${HOST}:${PORT}`));
    runBackup();
    setInterval(runBackup, BACKUP_INTERVAL_MS);
    runPromptsBackup();
    setInterval(runPromptsBackup, BACKUP_INTERVAL_MS);
    refreshDbSize();
    setInterval(refreshDbSize, DB_SIZE_INTERVAL_MS);
  })
  .catch(err => { console.error('Failed to initialize:', err.message); process.exit(1); });
