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
      uid:           true,
      envelope:      true,
      bodyParts:     ['text'],
      bodyStructure: true,
      flags:         true,
    })) {
      const { attachments } = _findBodyParts(msg.bodyStructure);
      msgs.push({
        id:             String(msg.uid),
        subject:        msg.envelope?.subject || '(no subject)',
        from:           _fmtAddr(msg.envelope?.from?.[0]),
        date:           _fmtDate(msg.envelope?.date),
        preview:        _preview(msg.bodyParts?.get('text')),
        unread:         !msg.flags?.has('\\Seen'),
        hasAttachments: attachments.length > 0,
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
 * Traverse a parsed bodyStructure tree (from imapflow) and return the IMAP
 * section identifiers for the first text/plain and text/html parts found.
 * Root single-part messages have no .part property; BODY[1] is the correct
 * section for them.
 */
function _findBodyParts(struct) {
  let text = null, html = null;
  const attachments = [];
  function visit(node, isRoot) {
    if (!node) return;
    // Root single-part messages have no .part set; IMAP section '1' covers them.
    const part = node.part || (isRoot && !node.childNodes ? '1' : null);
    if (node.type === 'text/plain' && !text && part) text = { part, encoding: (node.encoding || '7bit').toLowerCase() };
    if (node.type === 'text/html'  && !html && part) html = { part, encoding: (node.encoding || '7bit').toLowerCase() };
    const name = node.dispositionParameters?.filename || node.parameters?.name;
    if (part && name) {
      attachments.push({ part, name, type: node.type || 'application/octet-stream', encoding: (node.encoding || 'base64').toLowerCase() });
    }
    (node.childNodes || []).forEach(c => visit(c, false));
  }
  visit(struct, true);
  const bodyParts = new Set([text?.part, html?.part].filter(Boolean));
  return { textPart: text, htmlPart: html, attachments: attachments.filter(a => !bodyParts.has(a.part)) };
}

function _decodePart(buf, encoding) {
  if (!buf) return '';
  if (encoding === 'base64') {
    return Buffer.from(buf.toString('ascii').replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (encoding === 'quoted-printable') {
    // Remove soft line breaks first, then collect raw bytes so that
    // multibyte UTF-8 sequences (e.g. =C3=BC → ü, =E2=9C=85 → ✅)
    // are decoded correctly via Buffer.toString('utf8') rather than
    // String.fromCharCode which treats each byte as a separate code point.
    const qp = buf.toString('utf8').replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < qp.length; ) {
      if (qp[i] === '=' && /^[0-9A-Fa-f]{2}/.test(qp.slice(i + 1, i + 3))) {
        bytes.push(parseInt(qp.slice(i + 1, i + 3), 16));
        i += 3;
      } else {
        bytes.push(qp.charCodeAt(i));
        i++;
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return buf.toString('utf8');
}

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
    // Step 1: envelope + body structure to discover part numbers
    const meta = await client.fetchOne(String(uid), {
      uid:          true,
      envelope:     true,
      bodyStructure: true,
    }, { uid: true });

    if (!meta) return null;

    const { textPart, htmlPart, attachments } = _findBodyParts(meta.bodyStructure);
    const partKeys = [...new Set([textPart?.part, htmlPart?.part].filter(Boolean))];

    // Step 2: fetch discovered body parts; fall back to BODY[TEXT] on any error
    let bodyHtml = '', body = '';
    if (partKeys.length) {
      try {
        const bodyMsg = await client.fetchOne(String(meta.uid), { bodyParts: partKeys }, { uid: true });
        const parts = bodyMsg?.bodyParts;
        if (textPart) body     = _decodePart(parts?.get(textPart.part), textPart.encoding);
        if (htmlPart) bodyHtml = _decodePart(parts?.get(htmlPart.part), htmlPart.encoding);
      } catch {
        try {
          const fb = await client.fetchOne(String(meta.uid), { bodyParts: ['text'] }, { uid: true });
          body = fb?.bodyParts?.get('text')?.toString('utf8') || '';
        } catch { /* ignore — return envelope only */ }
      }
    } else {
      // No recognised MIME part found — try the whole body as plain text
      try {
        const fb = await client.fetchOne(String(meta.uid), { bodyParts: ['text'] }, { uid: true });
        body = fb?.bodyParts?.get('text')?.toString('utf8') || '';
      } catch { /* ignore */ }
    }

    return {
      id:          String(meta.uid),
      subject:     meta.envelope?.subject || '(no subject)',
      from:        _fmtAddr(meta.envelope?.from?.[0]),
      to:          _fmtAddrList(meta.envelope?.to),
      cc:          _fmtAddrList(meta.envelope?.cc),
      date:        _fmtDate(meta.envelope?.date),
      bodyHtml,
      body,
      attachments: attachments.map(a => ({ name: a.name, part: a.part, type: a.type })),
    };
  } finally {
    lock.release();
    await client.logout();
  }
}

// ---- Fetch one attachment ----

/**
 * Fetch a single attachment part by UID and IMAP part number.
 * Returns { data: Buffer, name, type } or null if not found.
 */
async function fetchMailAttachment(account, uid, part) {
  const { folder = 'INBOX' } = account;
  const client = _makeClient(account);
  await client.connect();
  const lock = await client.getMailboxLock(folder);
  try {
    const meta = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    if (!meta) return null;
    const { attachments } = _findBodyParts(meta.bodyStructure);
    const att = attachments.find(a => a.part === part);
    if (!att) return null;

    const msg = await client.fetchOne(String(uid), { bodyParts: [part] }, { uid: true });
    const buf = msg?.bodyParts?.get(part);
    if (!buf) return null;

    let data;
    if (att.encoding === 'base64') {
      data = Buffer.from(buf.toString('ascii').replace(/\s+/g, ''), 'base64');
    } else {
      data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    }
    return { data, name: att.name, type: att.type };
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

// ---- List folders ----

/**
 * List all IMAP folders for an account.
 * Returns [{ path, name }] sorted by path.
 */
async function listMailFolders(account) {
  const client = _makeClient(account);
  await client.connect();
  try {
    const list = await client.list('', '*');
    return list
      .map(f => ({ path: f.path, name: f.name || f.path }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    await client.logout();
  }
}

// ---- Mutate messages ----

/**
 * Mark a message as read (seen=true) or unread (seen=false) by UID.
 */
async function markMailMessage(account, uid, seen) {
  const { folder = 'INBOX' } = account;
  const client = _makeClient(account);
  await client.connect();
  const lock = await client.getMailboxLock(folder);
  try {
    if (seen) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

/**
 * Move a message by UID to targetFolder.
 */
async function moveMailMessage(account, uid, targetFolder) {
  const { folder = 'INBOX' } = account;
  const client = _makeClient(account);
  await client.connect();
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageMove(String(uid), targetFolder, { uid: true });
  } finally {
    lock.release();
    await client.logout();
  }
}

/**
 * Delete a message by UID — moves it to the configured trash folder
 * (account.trashFolder, default: 'Trash').
 */
async function deleteMailMessage(account, uid) {
  return moveMailMessage(account, uid, account.trashFolder || 'Trash');
}

module.exports = {
  fetchMailAccount,
  fetchMailMessage,
  fetchMailAttachment,
  testMailAccount,
  listMailFolders,
  markMailMessage,
  moveMailMessage,
  deleteMailMessage,
};
