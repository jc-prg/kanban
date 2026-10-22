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
const pendingChallenges = new Map();

function generateChallenge() {
  const challengeId = crypto.randomUUID();
  const code = String(crypto.randomInt(100000, 1000000));
  pendingChallenges.set(challengeId, { code, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return { challengeId, code };
}

function verifyChallenge(challengeId, code) {
  const entry = pendingChallenges.get(challengeId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    pendingChallenges.delete(challengeId);
    return false;
  }
  pendingChallenges.delete(challengeId); // single-use
  return entry.code === String(code);
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

function isAutoSend() {
  return process.env.TWO_FA_AUTO_SEND === 'true';
}

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
  verifyChallenge,
  generateDeviceToken,
  isDeviceTokenValid,
  sendCodeEmail,
};
