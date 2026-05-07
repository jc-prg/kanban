const crypto = require('crypto');
const { SESSION_TOKEN, API_KEY } = require('./config');

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
  if (safeEqual(cookies['kanban-session'] || '', SESSION_TOKEN)) return next();

  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const apiKey = req.headers['x-api-key'] || '';
  if (API_KEY && (safeEqual(bearer, API_KEY) || safeEqual(apiKey, API_KEY))) return next();

  const failCount = recordAuthFailure(req.ip);
  if (failCount > AUTH_FAIL_MAX)
    return res.status(429).json({ error: 'Too many unauthorized requests. Try again later.' });
  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = {
  safeEqual, parseCookies, authenticate,
  loginState, recordAuthFailure,
  writeRateLimit, uploadRateLimit,
  RATE_MAX, LOCKOUT_AFTER, LOCKOUT_MS,
};
