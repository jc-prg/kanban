'use strict';
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const { writeRateLimit }                        = require('../auth');
const { getWebdavAccounts, saveWebdavAccounts } = require('../global-db');

function _stripPasswords(accounts) {
  return accounts.map(({ password, ...a }) => ({ ...a, hasPassword: !!password }));
}

// GET /api/webdav-accounts — list all accounts (no passwords)
router.get('/webdav-accounts', async (req, res) => {
  try {
    const accounts = await getWebdavAccounts();
    res.json(_stripPasswords(accounts));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/webdav-accounts — create account
router.post('/webdav-accounts', writeRateLimit, async (req, res) => {
  try {
    const accounts = await getWebdavAccounts();
    const { label, url, user, password } = req.body;
    const id = 'wd-' + crypto.randomBytes(6).toString('hex');
    accounts.push({
      id,
      label:    typeof label    === 'string' ? label.trim()    : '',
      url:      typeof url      === 'string' ? url.trim()      : '',
      user:     typeof user     === 'string' ? user.trim()     : '',
      password: typeof password === 'string' ? password        : '',
    });
    await saveWebdavAccounts(accounts);
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/webdav-accounts/:id — update account
router.put('/webdav-accounts/:id', writeRateLimit, async (req, res) => {
  try {
    const accounts = await getWebdavAccounts();
    const idx = accounts.findIndex(a => a.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Account not found' });
    const { label, url, user, password } = req.body;
    accounts[idx] = {
      id: req.params.id,
      label:    typeof label === 'string' ? label.trim() : accounts[idx].label,
      url:      typeof url   === 'string' ? url.trim()   : accounts[idx].url,
      user:     typeof user  === 'string' ? user.trim()  : accounts[idx].user,
      // keep existing password if none supplied
      password: (typeof password === 'string' && password.length > 0)
        ? password
        : (accounts[idx].password || ''),
    };
    await saveWebdavAccounts(accounts);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/webdav-accounts/:id — remove account
router.delete('/webdav-accounts/:id', writeRateLimit, async (req, res) => {
  try {
    const accounts = await getWebdavAccounts();
    const idx = accounts.findIndex(a => a.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Account not found' });
    accounts.splice(idx, 1);
    await saveWebdavAccounts(accounts);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/webdav-accounts/:id/test — test connectivity for a stored account
router.post('/webdav-accounts/:id/test', writeRateLimit, async (req, res) => {
  try {
    const accounts = await getWebdavAccounts();
    const account  = accounts.find(a => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { url, user, password = '' } = account;
    if (!url) return res.json({ ok: false, error: 'No URL configured for this account' });

    const testUrl = url.endsWith('/') ? url : url + '/';
    const headers = { Depth: '0', 'Content-Type': 'application/xml' };
    if (user || password) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let r;
    try {
      r = await fetch(testUrl, { method: 'PROPFIND', headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (r.status === 207) return res.json({ ok: true, message: `Connected — HTTP ${r.status} Multi-Status` });
    if (r.status === 401 || r.status === 403) return res.json({ ok: false, error: `Authentication failed (HTTP ${r.status})` });
    if (r.status === 405) return res.json({ ok: false, error: `Server reachable but PROPFIND not allowed (HTTP 405) — not a WebDAV endpoint?` });
    return res.json({ ok: false, error: `Unexpected response: HTTP ${r.status}` });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out (8 s)' : err.message;
    res.json({ ok: false, error: msg });
  }
});

module.exports = router;
