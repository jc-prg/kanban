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
  const cidr = (process.env.INTRANET_CIDR || '').trim();
  if (!cidr) return false;
  try {
    return isInCidr(v4, cidr);
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

function writeTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
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
  const tokens = pruneExpired(readTokens());
  if (!tokens[_hashToken(token)]) return false;
  writeTokens(tokens); // persist pruned list
  return true;
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

module.exports = {
  isIntranet,
  isTwoFactorEnabled,
  generateChallenge,
  verifyChallenge,
  generateDeviceToken,
  isDeviceTokenValid,
  sendCodeEmail,
};
