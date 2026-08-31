require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const path    = require('path');

const { PORT, HOST, BACKUP_INTERVAL_MS, DB_SIZE_INTERVAL_MS, LOG_API_RESPONSES, ATTACHMENTS_DIR } = require('./config');
const { initDb, getCouch, withBoard, withExistingBoard } = require('./db');
const { initGlobalDb }                    = require('./global-db');
const { authenticate, parseCookies, writeRateLimit, uploadRateLimit } = require('./auth');
const { isTwoFactorEnabled, isIntranet, isDeviceTokenValid } = require('./twoFactor');
const { runBackup, runPromptsBackup, checkDataDirectories, refreshDbSize, runOrphanAttachmentCleanup } = require('./backup');
const { initRecurring } = require('./recurring');

const { createNotesRouter, createAccountsRouter } = require('../notes-webdav/backend');
const notesAdapter = require('./notes-adapter');

async function resolveCards(boardName) {
  try {
    const db = getCouch().use('jc-kanban-' + boardName);
    const { columns } = await db.get('board');
    const map = new Map();
    for (const col of columns || [])
      for (const card of col.cards || [])
        map.set(card.id, card.text);
    return map;
  } catch { return new Map(); }
}

const app = express();

// Trust exactly one upstream reverse proxy (nginx/caddy) so req.ip reflects
// the real client IP from X-Forwarded-For rather than the proxy's IP.
// Only enable this when the app is behind a trusted proxy — without it,
// all clients share one rate-limit bucket; with it in a direct-exposure
// setup, clients could spoof X-Forwarded-For to bypass rate limits.
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      scriptSrcAttr:  ["'none'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", "data:", "blob:", "https:"],
      connectSrc:     ["'self'"],
      frameSrc:       ["'self'", "blob:"],   // blob: needed for the PDF iframe viewer
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/notes-webdav', express.static(path.join(__dirname, '..', 'notes-webdav', 'frontend')));

if (LOG_API_RESPONSES) {
  const REDACT_REQ_KEYS = new Set(['password']);
  const REDACT_RES_KEYS = new Set(['token', 'apiKey']);
  function redact(obj, keys) {
    if (!obj || typeof obj !== 'object') return obj;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, keys.has(k) ? '[redacted]' : v]));
  }
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

app.use('/api', authenticate);

// 2FA middleware — skips auth routes; enforces device-token cookie for external IPs.
// Completely inactive when TWO_FA_EMAIL / SMTP_HOST are not configured.
app.use('/api', (req, res, next) => {
  if (!isTwoFactorEnabled()) return next();
  if (req.path === '/auth' || req.path.startsWith('/auth/')) return next();
  if (req.authedByApiKey) return next();
  if (isIntranet(req.ip)) return next();
  const cookies = parseCookies(req);
  if (isDeviceTokenValid(cookies['kanban-2fa'])) return next();
  return res.status(403).json({ error: '2FA_REQUIRED' });
});

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/prompts'));
app.use('/api', require('./routes/boards'));
app.use('/api', require('./routes/board'));
app.use('/api', createNotesRouter({ adapter: notesAdapter, withBoard, withExistingBoard, writeRateLimit, attachmentsDir: ATTACHMENTS_DIR, resolveCards }));
app.use('/api', require('./routes/attachments'));
app.use('/api', require('./routes/dashboard'));
app.use('/api', createAccountsRouter({ adapter: notesAdapter, writeRateLimit }));
app.use('/api', require('./routes/recurring'));
app.use('/api', require('./routes/templates'));

const SPA_HTML = path.join(__dirname, '..', 'frontend', 'index.html');
app.get('/focus',              (req, res) => res.sendFile(SPA_HTML));
app.get('/dashboard',          (req, res) => res.redirect(301, '/focus'));
app.get('/inbox',              (req, res) => res.sendFile(SPA_HTML));
app.get('/board/:board',       (req, res) => res.sendFile(SPA_HTML));
app.get('/board/:board/*path', (req, res) => res.sendFile(SPA_HTML));

initDb()
  .then(() => initGlobalDb())
  .then(() => {
    checkDataDirectories();
    app.listen(PORT, () => console.log(`Kanban server running at http://${HOST}:${PORT}`));
    runBackup();                    setInterval(runBackup,                    BACKUP_INTERVAL_MS);
    runPromptsBackup();             setInterval(runPromptsBackup,             BACKUP_INTERVAL_MS);
    refreshDbSize();                setInterval(refreshDbSize,                DB_SIZE_INTERVAL_MS);
    runOrphanAttachmentCleanup();   setInterval(runOrphanAttachmentCleanup,   60 * 60 * 1000);
    initRecurring();
  })
  .catch(err => { console.error('Failed to initialize:', err.message); process.exit(1); });
