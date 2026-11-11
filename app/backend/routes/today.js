'use strict';
// "Today" page (/today): config (layouts per breakpoint + widget settings) and widget providers.
const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { writeRateLimit, uploadRateLimit }  = require('../auth');
const { withHandler }                      = require('../db');
const { getTodayConfig, saveTodayConfig, getDashboardConfig } = require('../global-db');
const { validateTodayConfig, QA_ICON_FILE, schemaError } = require('../schemas');
const { TODAY_ICONS_DIR }                  = require('../config');
const { defaultTodayConfig, BREAKPOINTS }  = require('../today/defaults');
const { fetchTodayCards }                  = require('../today/cards');
const { fetchWeather, geocode }            = require('../today/weather');
const { fetchApplications }                = require('../today/cvapp');
const { fetchNoteTrees }                   = require('../today/notes');
const { fetchIcon, saveIcon, pruneIcons, MAX_ICON } = require('../today/quickaccess');
const search                               = require('../today/search');

const _ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Widget providers — one entry per server-side data source. `fetch(settings, req)` gets the
 * widget's stored settings (secrets included); tiles without a provider (progress, boards,
 * agenda's calendar part) use existing endpoints.
 */
const PROVIDERS = {
  cards: {
    fetch: (settings, req) => {
      const date = typeof req.query.date === 'string' && _ISO_DAY.test(req.query.date)
        ? req.query.date : new Date().toISOString().slice(0, 10);
      return fetchTodayCards(date);
    },
  },
  weather: { fetch: settings => fetchWeather(settings) },
  cvapp:   { fetch: settings => fetchApplications(settings) },
  notes:   { fetch: () => fetchNoteTrees() },
};

async function _loadConfig() {
  const stored   = await getTodayConfig();
  const defaults = defaultTodayConfig();
  if (!stored) return defaults;
  return {
    ...defaults,
    ...stored,
    widgets: stored.widgets || {},
    layouts: stored.layouts || defaults.layouts,
  };
}

/** Config for the browser: secrets replaced by has* flags. */
function stripSecrets(cfg) {
  const widgets = { ...(cfg.widgets || {}) };
  if (widgets.cvapp) {
    const { apiKey, ...rest } = widgets.cvapp;
    widgets.cvapp = { ...rest, hasApiKey: !!apiKey };
  }
  return { ...cfg, widgets };
}

/** Keep the stored CV-App key unless a new one is sent; `hasApiKey: false` clears it. */
function mergeSecrets(stored, incoming) {
  const widgets = { ...(incoming.widgets || {}) };
  if (widgets.cvapp) {
    const { hasApiKey, ...cv } = widgets.cvapp;
    const storedKey = stored.widgets?.cvapp?.apiKey;
    if ((!('apiKey' in cv) || cv.apiKey === '') && storedKey && hasApiKey !== false) cv.apiKey = storedKey;
    if (!cv.apiKey) delete cv.apiKey;
    widgets.cvapp = cv;
  }
  return { ...incoming, widgets };
}

/** Semantic checks the JSON schema can't express. Returns an error message or null. */
function checkLayouts(layouts) {
  for (const bp of BREAKPOINTS) {
    const l = layouts?.[bp];
    if (!l) continue;
    const ids = new Set();
    const fill = new Set();   // columns that already have an "available" tile
    for (const t of l.tiles) {
      if (t.col >= l.columns.length) return `layouts.${bp}: tile "${t.id}" is in column ${t.col + 1}, but the layout has ${l.columns.length}`;
      if (ids.has(t.id)) return `layouts.${bp}: tile "${t.id}" appears twice`;
      if (t.size === 'available' && fill.has(t.col)) return `layouts.${bp}: column ${t.col + 1} has more than one tile of size "available"`;
      ids.add(t.id);
      if (t.size === 'available') fill.add(t.col);
    }
  }
  return null;
}

function checkWidgets(widgets) {
  const cv = widgets?.cvapp;
  if (cv) {
    for (const k of ['apiUrl', 'publicUrl']) {
      if (cv[k] && !/^https?:\/\/[^\s]+$/i.test(cv[k])) return `widgets.cvapp.${k} must be an http(s) URL`;
    }
  }
  const qa = widgets?.quickaccess;
  if (qa?.items) {
    const ids = new Set();
    for (const it of qa.items) {
      if (ids.has(it.id)) return `widgets.quickaccess: entry "${it.id}" appears twice`;
      ids.add(it.id);
    }
  }
  const w = widgets?.weather;
  if (w && (('lat' in w) !== ('lon' in w))) return 'widgets.weather needs both lat and lon';
  return null;
}

router.get('/today/config', withHandler(async (req, res) => {
  res.json(stripSecrets(await _loadConfig()));
}));

// Partial update: top-level keys that are sent replace the stored ones (layouts / widgets / showBar)
router.put('/today/config', writeRateLimit, withHandler(async (req, res) => {
  if (!validateTodayConfig(req.body)) return res.status(400).json({ error: schemaError(validateTodayConfig) });
  const err = checkLayouts(req.body.layouts) || checkWidgets(req.body.widgets);
  if (err) return res.status(400).json({ error: err });

  const stored = await _loadConfig();
  const incoming = 'widgets' in req.body ? mergeSecrets(stored, req.body) : req.body;
  const merged = { ...stored, ...incoming };
  await saveTodayConfig(merged);
  if ('widgets' in req.body) pruneIcons(merged).catch(() => {});   // icons of removed Quick access entries
  res.json({ ok: true, config: stripSecrets(merged) });
}));

router.post('/today/config/reset-layouts', writeRateLimit, withHandler(async (req, res) => {
  const merged = { ...(await _loadConfig()), layouts: defaultTodayConfig().layouts };
  await saveTodayConfig(merged);
  res.json({ ok: true, config: stripSecrets(merged) });
}));

router.get('/today/widgets/:id', withHandler(async (req, res) => {
  const provider = Object.hasOwn(PROVIDERS, req.params.id) ? PROVIDERS[req.params.id] : null;
  if (!provider) return res.status(404).json({ error: 'Unknown widget' });
  const cfg = await _loadConfig();
  try {
    res.json(await provider.fetch(cfg.widgets?.[req.params.id] || {}, req));
  } catch (e) {
    res.status(e.statusCode || 502).json({ error: e.message || 'Widget failed' });
  }
}));

// ---- Search widget: one request per source (mail: per account), so fast sources show first ----

const SEARCH_TYPES = ['cards', 'notes', 'events', 'mail', 'applications'];

/** Sources the search can use: { types, mailAccounts: [{ id, label, color }] }. */
router.get('/today/search', withHandler(async (req, res) => {
  const [cfg, dash] = await Promise.all([_loadConfig(), getDashboardConfig()]);
  const mail = dash.mailAccounts || [];
  const types = ['cards', 'notes'];
  if ((dash.calendarAccounts || []).length) types.push('events');
  if (mail.length) types.push('mail');
  if (/^https?:\/\//i.test(cfg.widgets?.cvapp?.apiUrl || '')) types.push('applications');
  res.json({ types, mailAccounts: mail.map(a => ({ id: a.id, label: a.label || a.id, color: a.color || null, webInterfaceUrl: a.webInterfaceUrl || null })) });
}));

router.get('/today/search/:type', withHandler(async (req, res) => {
  const { type } = req.params;
  if (!SEARCH_TYPES.includes(type)) return res.status(404).json({ error: 'Unknown search type' });
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2 || q.length > 200) return res.status(400).json({ error: 'q must be 2–200 characters' });
  const full = req.query.full === '1' || req.query.full === 'true';
  try {
    if (type === 'cards') return res.json(await search.searchCards(q, { full }));
    if (type === 'notes') return res.json(await search.searchNotes(q, { full }));
    if (type === 'applications') {
      const cfg = await _loadConfig();
      return res.json(await search.searchApplications(q, { full, settings: cfg.widgets?.cvapp || {} }));
    }
    const dash = await getDashboardConfig();
    if (type === 'events') return res.json(await search.searchEvents(q, { full, accounts: dash.calendarAccounts || [] }));
    const account = (dash.mailAccounts || []).find(a => a.id === req.query.account);
    if (!account) return res.status(404).json({ error: 'Mail account not found' });
    res.json(await search.searchMail(account, q, { full }));
  } catch (e) {
    res.status(e.statusCode || 502).json({ error: e.message || 'Search failed' });
  }
}));

// ---- Quick access icons (stored once under TODAY_ICONS_DIR, content-addressed names) ----

router.post('/today/quickaccess/icon', writeRateLimit, withHandler(async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2000) return res.status(400).json({ error: 'url must be an http(s) URL' });
  try {
    res.json(await fetchIcon(url));
  } catch (e) {
    res.status(e.statusCode || 502).json({ error: e.message || 'Icon could not be loaded' });
  }
}));

const _iconUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ICON, files: 1 } }).single('file');

router.post('/today/quickaccess/icon/upload', uploadRateLimit, (req, res) => {
  _iconUpload(req, res, async err => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image too large (max 512 KB)' : err.message });
    if (!req.file) return res.status(400).json({ error: 'file missing' });
    try {
      res.json(await saveIcon(req.file.buffer));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });
});

router.get('/today/quickaccess/icon/:file', (req, res) => {
  const { file } = req.params;
  if (!QA_ICON_FILE.test(file)) return res.status(400).json({ error: 'Invalid icon name' });
  res.set({
    'Cache-Control': 'private, max-age=31536000, immutable',   // content-addressed name
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",   // SVG opened directly
  });
  res.sendFile(file, { root: TODAY_ICONS_DIR }, err => {
    if (err && !res.headersSent) res.status(err.statusCode === 404 || err.code === 'ENOENT' ? 404 : 500).json({ error: 'Icon not found' });
  });
});

router.get('/today/geocode', withHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2 || q.length > 100) return res.status(400).json({ error: 'q must be 2–100 characters' });
  try {
    res.json({ results: await geocode(q) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

module.exports = router;
module.exports.stripSecrets = stripSecrets;
module.exports.mergeSecrets = mergeSecrets;
