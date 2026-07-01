'use strict';
const { ImapFlow } = require('imapflow');

const TIMEOUT_MS = 10_000;

// ---- Helpers ----

function _fmtAddr(addr) {
  if (!addr) return '';
  return addr.name ? `${addr.name} <${addr.address || ''}>` : (addr.address || '');
}

function _fmtAddrList(list) {
  return (list || []).map(_fmtAddr).filter(Boolean).join(', ');
}

function _preview(buf) {
  if (!buf) return '';
  return buf.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function _fmtDate(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

function _makeClient(account) {
  const { host, port, tls, user, password } = account;
  return new ImapFlow({
    host,
    port,
    secure:            tls !== false,
    auth:              { user, pass: password },
    logger:            false,
    connectionTimeout: TIMEOUT_MS,
  });
}

// ---- Fetch message summaries ----

/**
 * Fetch the most-recent N message summaries from a mail account.
 * Throws on connection/auth errors (caller decides how to surface them).
 */
async function fetchMailAccount(account) {
  const { folder = 'INBOX', maxMessages = 20 } = account;
  const client = _makeClient(account);

  await client.connect();
  const lock = await client.getMailboxLock(folder);
  try {
    const total = client.mailbox?.exists ?? 0;
    if (total === 0) return [];

    const start = Math.max(1, total - maxMessages + 1);
    const msgs  = [];

    for await (const msg of client.fetch(`${start}:*`, {
      uid:       true,
      envelope:  true,
      bodyParts: ['text'],
    })) {
      msgs.push({
        id:      String(msg.uid),
        subject: msg.envelope?.subject || '(no subject)',
        from:    _fmtAddr(msg.envelope?.from?.[0]),
        date:    _fmtDate(msg.envelope?.date),
        preview: _preview(msg.bodyParts?.get('text')),
      });
    }

    return msgs.reverse();   // newest first
  } finally {
    lock.release();
    await client.logout();
  }
}

// ---- Fetch one full message ----

/**
 * Fetch a single message's full fields by UID.
 * Returns null if the message is not found.
 */
async function fetchMailMessage(account, uid) {
  const { folder = 'INBOX' } = account;
  const client = _makeClient(account);

  await client.connect();
  const lock = await client.getMailboxLock(folder);
  try {
    const msg = await client.fetchOne(String(uid), {
      uid:       true,
      envelope:  true,
      bodyParts: ['text'],
    }, { uid: true });

    if (!msg) return null;

    return {
      id:          String(msg.uid),
      subject:     msg.envelope?.subject || '(no subject)',
      from:        _fmtAddr(msg.envelope?.from?.[0]),
      to:          _fmtAddrList(msg.envelope?.to),
      cc:          _fmtAddrList(msg.envelope?.cc),
      date:        _fmtDate(msg.envelope?.date),
      body:        msg.bodyParts?.get('text')?.toString('utf8') || '',
      attachments: [],   // read-only; names only, no download
    };
  } finally {
    lock.release();
    await client.logout();
  }
}

// ---- Test connectivity ----

/**
 * Test IMAP connectivity for an account.
 * Returns { ok: boolean, error?: string } — never throws.
 */
async function testMailAccount(account) {
  const client = _makeClient(account);
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err) {
    if (err.authenticationFailed || err.code === 'EAUTH') {
      return { ok: false, error: 'Authentication failed' };
    }
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || /timed out/i.test(err.message)) {
      return { ok: false, error: `Connection timed out (${TIMEOUT_MS / 1000} s)` };
    }
    return { ok: false, error: err.message };
  }
}

module.exports = { fetchMailAccount, fetchMailMessage, testMailAccount };
