const crypto = require('crypto');
const fs     = require('fs');
const { SESSION_SECRET, SESSION_MAX_AGE_MS, API_KEY, REVOCATION_FILE } = require('./config');

function safeEqual(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  if (sa.length !== sb.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sa), Buffer.from(sb));
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

const TWO_FA_WINDOW_MS = 10 * 60 * 1000; // matches challenge TTL
const TWO_FA_MAX       = 10;             // max verify attempts per window
const twoFaMap         = new Map();       // ip -> { count, windowStart }

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

function twoFaRateLimit(req, res, next) {
  const ip  = req.ip;
  const now = Date.now();
  let s = twoFaMap.get(ip);
  if (!s || now > s.windowStart + TWO_FA_WINDOW_MS) {
    s = { count: 0, windowStart: now };
    twoFaMap.set(ip, s);
  }
  s.count++;
  if (s.count > TWO_FA_MAX)
    return res.status(429).json({ error: 'Too many verification attempts. Try again later.' });
  next();
}

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
  for (const [ip, s] of twoFaMap)
    if (now > s.windowStart + TWO_FA_WINDOW_MS) twoFaMap.delete(ip);
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

// ── Session revocation ────────────────────────────────────────────────────────

let _revokedBefore = 0; // ms timestamp; tokens issued before this are rejected

function _loadRevocation() {
  try { _revokedBefore = JSON.parse(fs.readFileSync(REVOCATION_FILE, 'utf8')).revokedBefore || 0; } catch { _revokedBefore = 0; }
}

function revokeAllSessions() {
  _revokedBefore = Date.now();
  try { fs.writeFileSync(REVOCATION_FILE, JSON.stringify({ revokedBefore: _revokedBefore })); } catch {}
}

_loadRevocation();

// ── Token issue / verify ──────────────────────────────────────────────────────

function issueSessionToken() {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try {
    const { iat } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof iat === 'number' && Date.now() - iat < SESSION_MAX_AGE_MS && iat >= _revokedBefore;
  } catch { return false; }
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function authenticate(req, res, next) {
  if (req.path === '/auth' || req.path === '/auth/verify' || req.path === '/auth/logout') return next();

  const cookies = parseCookies(req);
  if (verifySessionToken(cookies['kanban-session'])) return next();

  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const apiKey = req.headers['x-api-key'] || '';
  if (API_KEY && (safeEqual(bearer, API_KEY) || safeEqual(apiKey, API_KEY))) {
    req.authedByApiKey = true;
    return next();
  }

  const failCount = recordAuthFailure(req.ip);
  if (failCount > AUTH_FAIL_MAX)
    return res.status(429).json({ error: 'Too many unauthorized requests. Try again later.' });
  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = {
  safeEqual, parseCookies, authenticate,
  issueSessionToken, verifySessionToken,
  loginState, recordAuthFailure,
  writeRateLimit, uploadRateLimit, twoFaRateLimit,
  revokeAllSessions,
  RATE_MAX, LOCKOUT_AFTER, LOCKOUT_MS,
};
