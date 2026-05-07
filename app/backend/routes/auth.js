const express = require('express');
const router  = express.Router();
const { safeEqual, parseCookies, loginState, issueSessionToken, verifySessionToken,
        RATE_MAX, LOCKOUT_AFTER, LOCKOUT_MS } = require('../auth');
const { APP_PASSWORD, SESSION_MAX_AGE_MS } = require('../config');

router.post('/auth', (req, res) => {
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
    res.cookie('kanban-session', issueSessionToken(), {
      httpOnly: true, sameSite: 'strict', secure, path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });
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

router.get('/auth/verify', (req, res) => {
  const cookies = parseCookies(req);
  res.json({ ok: verifySessionToken(cookies['kanban-session']) });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('kanban-session', { path: '/', sameSite: 'strict' });
  res.json({ ok: true });
});

module.exports = router;
