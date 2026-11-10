'use strict';
// "Today" page (/today): config (layouts per breakpoint + widget settings) and widget providers.
const express = require('express');
const router  = express.Router();
const { writeRateLimit }                   = require('../auth');
const { withHandler }                      = require('../db');
const { getTodayConfig, saveTodayConfig } = require('../global-db');
const { validateTodayConfig, schemaError } = require('../schemas');
const { defaultTodayConfig, BREAKPOINTS }  = require('../today/defaults');
const { fetchTodayCards }                  = require('../today/cards');
const { fetchWeather, geocode }            = require('../today/weather');
const { fetchApplications }                = require('../today/cvapp');

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
    for (const t of l.tiles) {
      if (t.col >= l.columns.length) return `layouts.${bp}: tile "${t.id}" is in column ${t.col + 1}, but the layout has ${l.columns.length}`;
      if (ids.has(t.id)) return `layouts.${bp}: tile "${t.id}" appears twice`;
      ids.add(t.id);
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
