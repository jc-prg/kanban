'use strict';
const crypto       = require('crypto');
const { ImapFlow } = require('imapflow');
const nodemailer   = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const addressparser = require('nodemailer/lib/addressparser');

const TIMEOUT_MS = 10_000;

// ---- Helpers ----

function _fmtAddr(addr) {
  if (!addr) return '';
  if (!addr.name) return addr.address || '';
  // RFC 5322: a display name with specials ("Doe, Jane") must be quoted, or the comma splits the address list
  const name = /[",;<>@()[\]:\\]/.test(addr.name) ? `"${addr.name.replace(/(["\\])/g, '\\$1')}"` : addr.name;
  return `${name} <${addr.address || ''}>`;
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

function _folderOf(account, folder) {
  return folder || account.folder || 'INBOX';
}

/** Connect, lock `folder`, run fn(client), always release + logout. */
async function _withMailbox(account, folder, fn) {
  const client = _makeClient(account);
  await client.connect();
  const lock = await client.getMailboxLock(_folderOf(account, folder));
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout();
  }
}

/** Connect without selecting a mailbox (folder management). */
async function _withClient(account, fn) {
  const client = _makeClient(account);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

function _summary(msg, withPreview) {
  const { attachments } = _findBodyParts(msg.bodyStructure);
  const flags = msg.flags;
  return {
    id:             String(msg.uid),
    subject:        msg.envelope?.subject || '(no subject)',
    from:           _fmtAddr(msg.envelope?.from?.[0]),
    to:             _fmtAddrList(msg.envelope?.to),
    date:           _fmtDate(msg.envelope?.date),
    messageId:      msg.envelope?.messageId || '',
    ...(withPreview ? { preview: _preview(msg.bodyParts?.get('text')) } : {}),
    unread:         !flags?.has('\\Seen'),
    flagged:        !!flags?.has('\\Flagged'),
    answered:       !!flags?.has('\\Answered'),
    forwarded:      !!flags?.has('$Forwarded'),
    hasAttachments: attachments.length > 0,
    size:           msg.size || 0,
  };
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
      const { to, flagged, answered, forwarded, size, ...summary } = _summary(msg, true);
      msgs.push(summary);
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
      const encoding = (node.encoding || 'base64').toLowerCase();
      // bodyStructure reports the encoded size; base64 inflates by 4/3
      const size = Math.round((node.size || 0) * (encoding === 'base64' ? 0.75 : 1));
      attachments.push({ part, name, type: node.type || 'application/octet-stream', encoding, size });
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
 * Parse a raw "References:" header block into an array of message ids.
 */
function _parseReferences(headers) {
  if (!headers) return [];
  const raw = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const m = raw.match(/^references:\s*(.*)$/im);
  return m ? (m[1].match(/<[^<>\s]+>/g) || []) : [];
}

/**
 * Fetch a single message's full fields by UID from `folder`
 * (default: the account's configured folder).
 * Returns null if the message is not found.
 */
async function fetchMailMessage(account, uid, folder) {
  return _withMailbox(account, folder, async client => {
    // Step 1: envelope + body structure to discover part numbers
    const meta = await client.fetchOne(String(uid), {
      uid:           true,
      envelope:      true,
      bodyStructure: true,
      flags:         true,
      headers:       ['references'],
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

    const env = meta.envelope || {};
    return {
      id:          String(meta.uid),
      subject:     env.subject || '(no subject)',
      from:        _fmtAddr(env.from?.[0]),
      replyTo:     _fmtAddrList(env.replyTo),
      to:          _fmtAddrList(env.to),
      cc:          _fmtAddrList(env.cc),
      date:        _fmtDate(env.date),
      messageId:   env.messageId || '',
      inReplyTo:   env.inReplyTo || '',
      references:  _parseReferences(meta.headers),
      unread:      meta.flags ? !meta.flags.has('\\Seen') : false,
      bodyHtml,
      body,
      attachments: attachments.map(a => ({ name: a.name, part: a.part, type: a.type, size: a.size })),
    };
  });
}

// ---- Raw source ----

/** Full RFC 822 source of a message by UID (Buffer), or null if not found. */
async function fetchMailSource(account, uid, folder) {
  return _withMailbox(account, folder, async client => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    return msg?.source || null;
  });
}

// ---- Fetch one attachment ----

/** Read and decode one attachment part with an open, locked client; null if missing. */
async function _readAttachment(client, uid, part, attachments) {
  const att = attachments.find(a => a.part === part);
  if (!att) return null;
  const msg = await client.fetchOne(String(uid), { bodyParts: [part] }, { uid: true });
  const buf = msg?.bodyParts?.get(part);
  if (!buf) return null;
  const data = att.encoding === 'base64'
    ? Buffer.from(buf.toString('ascii').replace(/\s+/g, ''), 'base64')
    : (Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  return { data, name: att.name, type: att.type };
}

/**
 * Fetch a single attachment part by UID and IMAP part number.
 * Returns { data: Buffer, name, type } or null if not found.
 */
async function fetchMailAttachment(account, uid, part, folder) {
  return _withMailbox(account, folder, async client => {
    const meta = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    if (!meta) return null;
    return _readAttachment(client, uid, part, _findBodyParts(meta.bodyStructure).attachments);
  });
}

/**
 * Fetch several attachment parts of one message over a single connection
 * (used when forwarding). Returns null if the message or any part is missing.
 */
async function fetchMailAttachments(account, uid, parts, folder) {
  return _withMailbox(account, folder, async client => {
    const meta = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    if (!meta) return null;
    const { attachments } = _findBodyParts(meta.bodyStructure);
    const out = [];
    for (const part of parts) {
      const att = await _readAttachment(client, uid, part, attachments);
      if (!att) return null;
      out.push(att);
    }
    return out;
  });
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

// ---- Folders ----

function _mapFolder(f) {
  const flags = f.flags instanceof Set ? f.flags : new Set(f.flags || []);
  return {
    path:       f.path,
    name:       f.name || f.path,
    delimiter:  f.delimiter || '/',
    parent:     f.parentPath || '',
    specialUse: f.specialUse || null,
    noselect:   flags.has('\\Noselect') || flags.has('\\NonExistent'),
    ...(f.status ? { messages: f.status.messages ?? 0, unseen: f.status.unseen ?? 0 } : {}),
  };
}

/**
 * List all IMAP folders for an account, sorted by path.
 * With { status: true } every entry also carries { messages, unseen }; servers
 * that reject LIST-STATUS fall back to the plain listing.
 */
async function listMailFolders(account, { status = false } = {}) {
  return _withClient(account, async client => {
    let list;
    if (status) {
      try { list = await client.list({ statusQuery: { messages: true, unseen: true } }); }
      catch { list = await client.list(); }
    } else {
      list = await client.list();
    }
    return list.map(_mapFolder).sort((a, b) => a.path.localeCompare(b.path));
  });
}

async function createMailFolder(account, path) {
  return _withClient(account, client => client.mailboxCreate(path));
}

async function deleteMailFolder(account, path) {
  return _withClient(account, client => client.mailboxDelete(path));
}

/** Rename a folder; a different parent path moves it in the hierarchy. */
async function renameMailFolder(account, from, to) {
  return _withClient(account, client => client.mailboxRename(from, to));
}

// Trash / spam folders that may be emptied (special-use flag, configured trash or a well-known name)
const _EMPTYABLE_USES  = new Set(['\\Trash', '\\Junk']);
const _EMPTYABLE_NAMES = new Set([
  'trash', 'spam', 'junk', 'junk-e-mail', 'junk e-mail', 'junk-mail', 'gelöschte elemente',
  'gelöschte objekte', 'deleted items', 'deleted messages', 'papierkorb', 'bulk mail',
]);

function isEmptyableFolder(folder, account = {}) {
  if (_EMPTYABLE_USES.has(folder.specialUse)) return true;
  if (account.trashFolder && folder.path === account.trashFolder) return true;
  return _EMPTYABLE_NAMES.has(String(folder.name || folder.path).trim().toLowerCase());
}

/**
 * Permanently delete every message in a trash / spam folder.
 * Other folders are refused (status 400); unknown folders give 404. Returns { deleted }.
 */
async function emptyMailFolder(account, path) {
  return _withClient(account, async client => {
    const folder = (await client.list()).find(f => f.path === path);
    if (!folder) throw Object.assign(new Error('Folder not found'), { status: 404 });
    if (!isEmptyableFolder(folder, account)) throw Object.assign(new Error('Only trash and spam folders can be emptied'), { status: 400 });
    const lock = await client.getMailboxLock(path);
    try {
      const deleted = client.mailbox?.exists ?? 0;
      if (deleted) await client.messageDelete('1:*');
      return { deleted };
    } finally {
      lock.release();
    }
  });
}

/** Resolve a special-use folder (e.g. '\\Sent') via LIST; null if unknown. */
async function _specialFolder(client, use) {
  try {
    const list = await client.list();
    return list.find(f => f.specialUse === use)?.path || null;
  } catch { return null; }
}

// ---- Folder message listing ----

const _LIST_QUERY = { uid: true, envelope: true, bodyStructure: true, flags: true, size: true };

/**
 * One page of message summaries in `folder`, newest first.
 * With `query`, the folder is searched server-side (subject, from, to, body).
 * Returns { messages, total, page, pageSize }.
 */
async function fetchFolderMessages(account, folder, { page = 0, pageSize = 50, query = '' } = {}) {
  return _withMailbox(account, folder, async client => {
    const msgs = [];
    let total;
    if (query) {
      const uids = (await client.search({
        or: [{ subject: query }, { from: query }, { to: query }, { body: query }],
      }, { uid: true })) || [];
      uids.sort((a, b) => b - a);
      total = uids.length;
      const slice = uids.slice(page * pageSize, (page + 1) * pageSize);
      if (slice.length) {
        for await (const msg of client.fetch(slice.join(','), _LIST_QUERY, { uid: true })) msgs.push(_summary(msg));
      }
    } else {
      total = client.mailbox?.exists ?? 0;
      const end   = total - page * pageSize;
      const start = Math.max(1, end - pageSize + 1);
      if (end >= 1) {
        for await (const msg of client.fetch(`${start}:${end}`, _LIST_QUERY)) msgs.push(_summary(msg));
      }
    }
    msgs.sort((a, b) => Number(b.id) - Number(a.id));
    return { messages: msgs, total, page, pageSize };
  });
}

/**
 * Total size of a folder in bytes (sum of RFC822.SIZE — STATUS=SIZE is not widely supported).
 * Returns { size, messages }.
 */
async function fetchFolderSize(account, folder) {
  return _withMailbox(account, folder, async client => {
    const messages = client.mailbox?.exists ?? 0;
    let size = 0;
    if (messages) {
      for await (const msg of client.fetch('1:*', { size: true })) size += msg.size || 0;
    }
    return { size, messages };
  });
}

// ---- Find a message by Message-ID ----

/** Message-ID header of one message (by UID), '' when it has none; null when the message is missing. */
async function fetchMessageId(account, uid, folder) {
  return _withMailbox(account, folder, async client => {
    const meta = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
    return meta ? (meta.envelope?.messageId || '') : null;
  });
}

/**
 * Locate a message by its Message-ID header. Searches `folder` (hint, e.g. where the
 * card was created) first, then the account folder / INBOX, then every other selectable
 * folder. Returns { folder, uid } or null.
 */
async function findMailByMessageId(account, messageId, folder, { hintOnly = false } = {}) {
  return _withClient(account, async client => {
    let paths = [];
    if (!hintOnly) try {
      paths = (await client.list())
        .filter(f => !(f.flags instanceof Set ? f.flags.has('\\Noselect') : (f.flags || []).includes('\\Noselect')))
        .map(f => f.path);
    } catch { /* fall back to the hints */ }
    const order = hintOnly
      ? [folder || account.folder || 'INBOX']
      : [...new Set([folder, account.folder || 'INBOX', ...paths].filter(Boolean))];
    for (const path of order) {
      let lock;
      try { lock = await client.getMailboxLock(path, { readOnly: true }); } catch { continue; }
      try {
        // deleted: false — a client that moves by copy + \Deleted leaves a stale copy behind
        const uids = await client.search({ header: { 'message-id': messageId }, deleted: false }, { uid: true });
        if (uids?.length) return { folder: path, uid: String(Math.max(...uids)) };
      } catch { /* folder not searchable — try the next one */ } finally {
        lock.release();
      }
    }
    return null;
  });
}

// ---- Mutate messages ----

/**
 * Mark a message as read (seen=true) or unread (seen=false) by UID.
 */
async function markMailMessage(account, uid, seen, folder) {
  return _withMailbox(account, folder, async client => {
    if (seen) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    }
  });
}

/**
 * Mark every message in `folder` as read. Returns { messages } (count in the folder).
 */
async function markFolderRead(account, folder) {
  return _withMailbox(account, folder, async client => {
    const messages = client.mailbox?.exists ?? 0;
    if (messages) await client.messageFlagsAdd('1:*', ['\\Seen']);
    return { messages };
  });
}

/**
 * Move a message by UID from `folder` to targetFolder.
 */
async function moveMailMessage(account, uid, targetFolder, folder) {
  return _withMailbox(account, folder, async client => {
    await client.messageMove(String(uid), targetFolder, { uid: true });
  });
}

/**
 * Delete a message by UID — moves it to the trash folder (account.trashFolder,
 * else the server's \Trash folder, else 'Trash'). A message that already is in
 * the trash is deleted permanently. Returns { permanent }.
 */
async function deleteMailMessage(account, uid, folder) {
  const source = _folderOf(account, folder);
  return _withMailbox(account, source, async client => {
    const trash = account.trashFolder || (await _specialFolder(client, '\\Trash')) || 'Trash';
    if (source === trash) {
      await client.messageDelete(String(uid), { uid: true });
      return { permanent: true };
    }
    await client.messageMove(String(uid), trash, { uid: true });
    return { permanent: false };
  });
}

// ---- Send ----

function _smtpSettings(account) {
  const smtp   = account.smtp || {};
  const port   = Number(smtp.port) || 587;
  const secure = smtp.secure === undefined || smtp.secure === 'auto' ? port === 465 : !!smtp.secure;
  return {
    host:   smtp.host,
    port,
    secure,
    auth:   { user: smtp.user || account.user, pass: smtp.password || account.password },
    connectionTimeout: TIMEOUT_MS,
  };
}

/** Bare addresses of a recipient string ("A <a@x>, b@y"). */
function _addresses(str) {
  const out = [];
  (function walk(list) {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address) out.push(a.address);
    }
  })(addressparser(str || ''));
  return out;
}

/**
 * Sender addresses of an account: `smtp.fromAddress` may list several,
 * comma-separated (`a@x.de, Name <b@x.de>`); the first is the default.
 * Falls back to the IMAP user. Entries without a name get `smtp.fromName`.
 */
function senderAddresses(account) {
  const fromName = account.smtp?.fromName || '';
  const out = [];
  for (const a of addressparser(account.smtp?.fromAddress || '')) {
    if (a.address && a.address.includes('@') && !out.some(o => o.address.toLowerCase() === a.address.toLowerCase())) {
      out.push({ name: a.name || fromName, address: a.address });
    }
  }
  if (!out.length && account.user) out.push({ name: fromName, address: account.user });
  return out;
}

/**
 * Send a message via the account's SMTP server and store a copy in the sent
 * folder (account.sentFolder, else the server's \Sent folder). When the mail
 * answers `replyUid` in `replyFolder`, that message gets the \Answered flag;
 * a forwarded `forwardUid` in `forwardFolder` gets $Forwarded.
 * Returns { ok, messageId, warning? } — a failed sent-copy is only a warning.
 */
async function sendMail(account, mail) {
  if (!account.smtp?.host) throw Object.assign(new Error('No SMTP server configured for this account'), { status: 400 });
  const smtp = _smtpSettings(account);
  const senders = senderAddresses(account);
  const sender  = mail.from ? senders.find(s => s.address.toLowerCase() === String(mail.from).trim().toLowerCase()) : senders[0];
  if (!sender) throw Object.assign(new Error('Sender address not configured for this account'), { status: 400 });
  const fromAddress = sender.address;
  const from = sender.name ? { name: sender.name, address: fromAddress } : fromAddress;
  const domain = (fromAddress.split('@')[1] || 'localhost').replace(/[^\w.-]/g, '');
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const date = new Date();

  const opts = {
    from,
    to:        mail.to,
    cc:        mail.cc || undefined,
    bcc:       mail.bcc || undefined,
    subject:   mail.subject || '',
    html:      mail.html || undefined,
    text:      mail.text || '',
    messageId,
    date,
    inReplyTo:  mail.inReplyTo || undefined,
    references: mail.references?.length ? mail.references : undefined,
    attachments: (mail.attachments || []).map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  };

  const recipients = [..._addresses(mail.to), ..._addresses(mail.cc), ..._addresses(mail.bcc)];
  if (!recipients.length) throw Object.assign(new Error('No valid recipient'), { status: 400 });

  const raw = await new MailComposer(opts).compile().build();
  const transporter = nodemailer.createTransport(smtp);
  await transporter.sendMail({ envelope: { from: fromAddress, to: recipients }, raw });

  const result = { ok: true, messageId };
  try {
    const copyNode = new MailComposer(opts).compile();
    copyNode.keepBcc = true;
    const copy = await copyNode.build();
    await _withClient(account, async client => {
      const sent = account.sentFolder || (await _specialFolder(client, '\\Sent')) || 'Sent';
      await client.append(sent, copy, ['\\Seen'], date);
      // Mark the original: \Answered for replies, $Forwarded for forwards (same account only)
      const marks = [];
      if (mail.replyUid && mail.replyFolder) marks.push([mail.replyFolder, mail.replyUid, '\\Answered']);
      if (mail.forwardUid && mail.forwardFolder && !mail.forwardAccount) marks.push([mail.forwardFolder, mail.forwardUid, '$Forwarded']);
      for (const [folder, uid, flag] of marks) {
        const lock = await client.getMailboxLock(folder);
        try { await client.messageFlagsAdd(String(uid), [flag], { uid: true }); }
        finally { lock.release(); }
      }
    });
  } catch (err) {
    result.warning = `Sent, but storing a copy failed: ${err.message}`;
  }
  return result;
}

module.exports = {
  senderAddresses,
  fetchMailAccount,
  fetchMailMessage,
  fetchMessageId,
  findMailByMessageId,
  fetchMailSource,
  fetchMailAttachment,
  fetchMailAttachments,
  fetchFolderMessages,
  fetchFolderSize,
  testMailAccount,
  listMailFolders,
  createMailFolder,
  deleteMailFolder,
  renameMailFolder,
  emptyMailFolder,
  isEmptyableFolder,
  markMailMessage,
  markFolderRead,
  moveMailMessage,
  deleteMailMessage,
  sendMail,
  _parseReferences,
  _addresses,
  _smtpSettings,
};
