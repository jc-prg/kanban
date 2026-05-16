const express = require('express');
const router  = express.Router();
const { writeRateLimit } = require('../auth');
const { getPromptsDb }   = require('../db');
const { API_KEY }        = require('../config');

const PROMPTS_DOC_ID  = 'prompts';
const PROMPTS_DEFAULT = { searchProfile: '', criteriaInclude: '', criteriaExclude: '', searchRadius: '' };

// ---------------------------------------------------------------------------
// WebDAV config — stored in the prompts DB under _id 'webdav-config'
// ---------------------------------------------------------------------------
const WEBDAV_CFG_ID = 'webdav-config';

async function _loadWebdavDoc() {
  try {
    const { _id, _rev, ...data } = await getPromptsDb().get(WEBDAV_CFG_ID);
    return { _rev, ...data };
  } catch (err) {
    if (err.statusCode === 404) return {};
    throw err;
  }
}

/** Returns full config including password — for internal backend use only. */
async function getWebdavConfig() {
  const doc = await _loadWebdavDoc();
  return { enabled: doc.enabled ?? false, url: doc.url || '', user: doc.user || '', password: doc.password || '' };
}

router.get('/webdav-config', async (req, res) => {
  try {
    const doc = await _loadWebdavDoc();
    res.json({
      enabled:     doc.enabled     ?? false,
      url:         doc.url         || '',
      user:        doc.user        || '',
      hasPassword: !!(doc.password),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/webdav-config/test', writeRateLimit, async (req, res) => {
  try {
    // Use values from request body; fall back to stored config for missing fields.
    const stored   = await getWebdavConfig();
    const url      = (typeof req.body.url  === 'string' && req.body.url.trim())  ? req.body.url.trim()  : stored.url;
    const user     = (typeof req.body.user === 'string')                          ? req.body.user.trim() : stored.user;
    // Only use body password when explicitly provided; otherwise use stored.
    const password = (typeof req.body.password === 'string' && req.body.password.length > 0)
      ? req.body.password
      : stored.password;

    if (!url) return res.json({ ok: false, error: 'No WebDAV URL configured' });

    const testUrl = url.endsWith('/') ? url : url + '/';
    const headers = { Depth: '0', 'Content-Type': 'application/xml' };
    if (user || password)
      headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let r;
    try {
      r = await fetch(testUrl, { method: 'PROPFIND', headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (r.status === 207)
      return res.json({ ok: true, message: `Connected — HTTP ${r.status} Multi-Status` });
    if (r.status === 401 || r.status === 403)
      return res.json({ ok: false, error: `Authentication failed (HTTP ${r.status})` });
    if (r.status === 405)
      return res.json({ ok: false, error: `Server reachable but PROPFIND not allowed (HTTP 405) — not a WebDAV endpoint?` });
    return res.json({ ok: false, error: `Unexpected response: HTTP ${r.status}` });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out (8 s)' : err.message;
    res.json({ ok: false, error: msg });
  }
});

router.put('/webdav-config', writeRateLimit, async (req, res) => {
  try {
    const { enabled, url, user, password } = req.body;
    const existing = await _loadWebdavDoc();
    const doc = {
      _id:     WEBDAV_CFG_ID,
      ...(existing._rev ? { _rev: existing._rev } : {}),
      enabled: !!enabled,
      url:     (typeof url  === 'string' ? url.trim()  : existing.url  || ''),
      user:    (typeof user === 'string' ? user.trim() : existing.user || ''),
      // Only overwrite password when a non-empty string is sent
      password: (typeof password === 'string' && password.length > 0)
        ? password
        : (existing.password || ''),
    };
    await getPromptsDb().insert(doc);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function loadPrompts() {
  try {
    const { _id, _rev, ...data } = await getPromptsDb().get(PROMPTS_DOC_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return { ...PROMPTS_DEFAULT };
    throw err;
  }
}

async function savePrompts(data) {
  let rev;
  try { ({ _rev: rev } = await getPromptsDb().get(PROMPTS_DOC_ID)); } catch (e) { /* new doc */ }
  await getPromptsDb().insert({ _id: PROMPTS_DOC_ID, ...(rev ? { _rev: rev } : {}), ...data });
}

router.get('/settings', (req, res) => {
  res.json({ apiKeyConfigured: !!API_KEY });
});

router.get('/prompts', async (req, res) => {
  try { res.json(await loadPrompts()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/prompts', writeRateLimit, async (req, res) => {
  try {
    const { searchProfile = '', criteriaInclude = '', criteriaExclude = '', searchRadius = '' } = req.body;
    await savePrompts({ searchProfile, criteriaInclude, criteriaExclude, searchRadius });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.getWebdavConfig = getWebdavConfig;
