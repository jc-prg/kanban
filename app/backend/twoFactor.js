'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const nodemailer = require('nodemailer');
const { BACKUP_DIR, SESSION_SECRET } = require('./config');

// ─── IP / intranet check ─────────────────────────────────────────────────────

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isInCidr(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - parseInt(bits, 10))) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}

function isIntranet(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const cidrs = (process.env.INTRANET_CIDR || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!cidrs.length) return false;
  try {
    return cidrs.some(cidr => isInCidr(v4, cidr));
  } catch {
    return false;
  }
}

// ─── Pending challenges (in-memory, 10 min TTL) ──────────────────────────────

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const pendingChallenges = new Map(); // challengeId → { code, expiresAt, attempts, sessionKey }
const sessionChallenges = new Map(); // sessionKey  → challengeId

function _dropChallenge(challengeId) {
  const entry = pendingChallenges.get(challengeId);
  if (!entry) return;
  pendingChallenges.delete(challengeId);
  if (sessionChallenges.get(entry.sessionKey) === challengeId) sessionChallenges.delete(entry.sessionKey);
}

// One pending challenge per session: concurrent tabs / repeated 2FA_REQUIRED
// responses reuse the existing challenge (isNew: false → no new email), so every
// tab verifies against the same code. `force` (explicit "resend") replaces it.
function generateChallenge(sessionKey, { force = false } = {}) {
  const existingId = sessionChallenges.get(sessionKey);
  if (existingId) {
    const existing = pendingChallenges.get(existingId);
    if (existing && Date.now() <= existing.expiresAt && !force)
      return { challengeId: existingId, code: existing.code, isNew: false };
    _dropChallenge(existingId);
  }
  const challengeId = crypto.randomUUID();
  const code = String(crypto.randomInt(100000, 1000000));
  pendingChallenges.set(challengeId, { code, expiresAt: Date.now() + CHALLENGE_TTL_MS, attempts: 0, sessionKey });
  sessionChallenges.set(sessionKey, challengeId);
  return { challengeId, code, isNew: true };
}

// Removes the challenge (e.g. when sending the email failed) so the next request starts fresh.
function discardChallenge(challengeId) {
  _dropChallenge(challengeId);
}

function verifyChallenge(challengeId, code) {
  const entry = pendingChallenges.get(challengeId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    _dropChallenge(challengeId);
    return false;
  }
  if (entry.code === String(code)) {
    _dropChallenge(challengeId); // single-use
    return true;
  }
  // A typo shouldn't burn the code; give up after a few wrong attempts
  if (++entry.attempts >= CHALLENGE_MAX_ATTEMPTS) _dropChallenge(challengeId);
  return false;
}

// ─── Device tokens (file-backed, survives restarts) ──────────────────────────

const TOKENS_FILE = path.join(BACKUP_DIR, '2fa-tokens.json');

function _hashToken(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Write to a temp file and rename, so a failed write (e.g. disk full) leaves the
// existing tokens file intact instead of truncating it.
function writeTokens(tokens) {
  const tmp = `${TOKENS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2));
    fs.renameSync(tmp, TOKENS_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function pruneExpired(tokens) {
  const now = new Date().toISOString();
  const pruned = {};
  for (const [t, exp] of Object.entries(tokens)) {
    if (exp > now) pruned[t] = exp;
  }
  return pruned;
}

function generateDeviceToken() {
  const days = parseInt(process.env.TWO_FA_VALIDITY_DAYS || '30', 10);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + days * 86400 * 1000).toISOString();
  const tokens = pruneExpired(readTokens());
  tokens[_hashToken(token)] = expiresAt;
  writeTokens(tokens);
  return { token, days };
}

function isDeviceTokenValid(token) {
  if (!token) return false;
  const all    = readTokens();
  const tokens = pruneExpired(all);
  if (Object.keys(tokens).length !== Object.keys(all).length) {
    // Persisting the pruned list is housekeeping — never fail the request over it
    try { writeTokens(tokens); } catch (err) { console.warn('2FA token prune failed:', err.message); }
  }
  return !!tokens[_hashToken(token)];
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendCodeEmail(code) {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  // SMTP_SECURE=true → direct SSL (port 465); false → STARTTLS; auto-detect from port
  const secure = process.env.SMTP_SECURE !== undefined
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure, // force STARTTLS when not using direct SSL
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to:   process.env.TWO_FA_EMAIL,
    subject: 'Kanban login code',
    text: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.`,
  });
}

// ─── Is 2FA enabled? ─────────────────────────────────────────────────────────

function isTwoFactorEnabled() {
  return !!(process.env.TWO_FA_EMAIL && process.env.SMTP_HOST);
}

// When true, the frontend sends the verification code immediately instead of
// showing the "Send verification code" button first.
function isAutoSend() {
  return process.env.TWO_FA_AUTO_SEND === 'true';
}

module.exports = {
  isIntranet,
  isAutoSend,
  isTwoFactorEnabled,
  generateChallenge,
  discardChallenge,
  verifyChallenge,
  generateDeviceToken,
  isDeviceTokenValid,
  sendCodeEmail,
};
