const express = require('express');
const router  = express.Router();
const { safeEqual, parseCookies, loginState, issueSessionToken, verifySessionToken,
        RATE_MAX, LOCKOUT_AFTER, LOCKOUT_MS, twoFaRateLimit, revokeAllSessions } = require('../auth');
const { APP_PASSWORD, SESSION_MAX_AGE_MS } = require('../config');
const {
  isTwoFactorEnabled, isIntranet, isDeviceTokenValid,
  generateChallenge, verifyChallenge, generateDeviceToken, sendCodeEmail,
} = require('../twoFactor');

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
  res.clearCookie('kanban-2fa', { path: '/', sameSite: 'strict' });
  res.json({ ok: true });
});

// Invalidate all currently active session tokens immediately.
// Useful after a suspected compromise — forces re-login on all devices.
router.post('/auth/revoke-all', (req, res) => {
  revokeAllSessions();
  res.clearCookie('kanban-session', { path: '/', sameSite: 'strict' });
  res.clearCookie('kanban-2fa', { path: '/', sameSite: 'strict' });
  res.json({ ok: true });
});

// Returns whether 2FA is still required for this request.
// Requires a valid session (not bypassed by authenticate); bypassed by 2FA middleware.
router.get('/auth/check', (req, res) => {
  if (!isTwoFactorEnabled()) return res.json({ ok: true, twoFactorRequired: false });
  const cookies = parseCookies(req);
  const twoFactorRequired = !isIntranet(req.ip) && !isDeviceTokenValid(cookies['kanban-2fa']);
  res.json({ ok: true, twoFactorRequired });
});

// Send a 6-digit code to the configured TWO_FA_EMAIL address.
router.post('/auth/2fa/send', async (req, res) => {
  if (!isTwoFactorEnabled())
    return res.status(400).json({ error: '2FA is not configured' });
  try {
    const { challengeId, code } = generateChallenge();
    await sendCodeEmail(code);
    res.json({ challengeId });
  } catch (err) {
    console.error('2FA send error:', err.message);
    res.status(500).json({ error: `Failed to send code: ${err.message}` });
  }
});

// Verify the submitted code and set an HttpOnly device-token cookie on success.
router.post('/auth/2fa/verify', twoFaRateLimit, (req, res) => {
  if (!isTwoFactorEnabled())
    return res.status(400).json({ error: '2FA is not configured' });
  const { challengeId, code } = req.body || {};
  if (!challengeId || !code)
    return res.status(400).json({ error: 'Missing challengeId or code' });
  if (!verifyChallenge(challengeId, String(code)))
    return res.status(401).json({ error: 'Invalid or expired code' });
  const { token, days } = generateDeviceToken();
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('kanban-2fa', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: days * 86400 * 1000,
  });
  res.json({ ok: true });
});

module.exports = router;
