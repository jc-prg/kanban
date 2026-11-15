'use strict';
const crypto       = require('crypto');
const { ImapFlow } = require('imapflow');
const nodemailer   = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const addressparser = require('nodemailer/lib/addressparser');
const { decodeText } = require('../charset');

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
  return decodeText(buf).replace(/\s+/g, ' ').trim().slice(0, 120);
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

// ---- Flag colours (Apple Mail convention) ----
// \Flagged marks the message; the colour is a 3-bit index in the keywords $MailFlagBit0..2
// (no bit = red). Clients without colours see a plain flag.

const MAIL_FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const _FLAG_BITS = ['$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2'];

/** Flag colour of a message (Set or array of IMAP flags), null when not flagged. */
function flagColor(flags) {
  const set = flags instanceof Set ? flags : new Set(flags || []);
  if (!set.has('\\Flagged')) return null;
  const n = _FLAG_BITS.reduce((v, bit, i) => v | (set.has(bit) ? 1 << i : 0), 0);
  return MAIL_FLAG_COLORS[n] || 'red';   // 7 (all bits) is unused by Apple
}

/** { add, remove } IMAP flags that set `color` (null = clear the flag). */
function flagChanges(color) {
  if (!color) return { add: [], remove: ['\\Flagged', ..._FLAG_BITS] };
  const n = MAIL_FLAG_COLORS.indexOf(color);
  if (n < 0) throw new Error(`Unknown flag colour: ${color}`);
  const add = ['\\Flagged'], remove = [];
  _FLAG_BITS.forEach((bit, i) => (n & (1 << i) ? add : remove).push(bit));
  return { add, remove };
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
    flagColor:      flagColor(flags),
    answered:      !!flags?.has('\\Answered'),
    forwarded:      !!flags?.has('$Forwarded'),
    hasAttachments: attachments.length > 0,
    size:           msg.size || 0,
  };
}

// ---- Fetch message summaries ----

const FLAGGED_LIMIT = 50;   // flagged messages per account in the Today overview

/**
 * Fetch the most-recent N message summaries from a mail account's folder, plus
 * (`withFlagged`) every flagged message of that folder — newest first, ≤ FLAGGED_LIMIT,
 * however old. Returns { messages, flagged, flaggedTotal }.
 * Throws on connection/auth errors (caller decides how to surface them).
 */
async function fetchMailAccount(account, { withFlagged = false } = {}) {
  const { folder = 'INBOX', maxMessages = 20 } = account;
  const client = _makeClient(account);

  await client.connect();
  const lock = await client.getMailboxLock(folder);
  try {
    const total = client.mailbox?.exists ?? 0;
    if (total === 0) return { messages: [], flagged: [], flaggedTotal: 0 };

    const start = Math.max(1, total - maxMessages + 1);
    const msgs  = [];

    for await (const msg of client.fetch(`${start}:*`, {
      uid:           true,
      envelope:      true,
      bodyParts:     ['text'],
      bodyStructure: true,
      flags:         true,
    })) {
      const { to, answered, forwarded, size, ...summary } = _summary(msg, true);
      msgs.push(summary);
    }

    let flagged = [], flaggedTotal = 0;
    if (withFlagged) {
      const uids = (await client.search({ flagged: true }, { uid: true })) || [];
      flaggedTotal = uids.length;
      // Highest UIDs = most recently arrived; the shown ones are then sorted by date
      const pick = [...uids].sort((a, b) => b - a).slice(0, FLAGGED_LIMIT);
      if (pick.length) {
        for await (const msg of client.fetch(pick.join(','), _LIST_QUERY, { uid: true })) {
          const { to, answered, forwarded, size, ...summary } = _summary(msg, false);
          flagged.push(summary);
        }
        flagged.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      }
    }

    return { messages: msgs.reverse(), flagged, flaggedTotal };   // newest first
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
/** File extension for an image MIME type (image/svg+xml → svg, image/jpeg → jpg). */
function _imageExt(type) {
  const sub = String(type || '').split('/')[1]?.toLowerCase() || '';
  return { 'svg+xml': 'svg', jpeg: 'jpg', pjpeg: 'jpg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico' }[sub]
    || sub.replace(/[^a-z0-9]/g, '').slice(0, 5) || 'img';
}

function _findBodyParts(struct) {
  let text = null, html = null;
  const attachments = [];
  function visit(node, isRoot) {
    if (!node) return;
    // Root single-part messages have no .part set; IMAP section '1' covers them.
    const part = node.part || (isRoot && !node.childNodes ? '1' : null);
    const charset = (node.parameters?.charset || '').toLowerCase();
    if (node.type === 'text/plain' && !text && part) text = { part, encoding: (node.encoding || '7bit').toLowerCase(), charset };
    if (node.type === 'text/html'  && !html && part) html = { part, encoding: (node.encoding || '7bit').toLowerCase(), charset };
    // Content-ID: inline images are referenced from the HTML as <img src="cid:…">
    const cid = typeof node.id === 'string' ? node.id.trim().replace(/^<|>$/g, '') : '';
    const isImage = /^image\//i.test(node.type || '');
    // Inline images may come without a file name — named after their part then; so may the calendar part of an
    // invitation (Outlook / Google: text/calendar next to the text and HTML body) — listed as invite.ics, but only
    // when the mail has no named calendar file (Google sends both: the same invitation twice)
    const filename = node.dispositionParameters?.filename || node.parameters?.name || '';
    const inlineCal = !filename && /^text\/calendar$/i.test(node.type || '');
    const name = filename ||
      (cid && isImage ? `image-${String(part).replace(/\./g, '-')}.${_imageExt(node.type)}` : '') ||
      (inlineCal && part ? 'invite.ics' : '');
    if (part && name) {
      const encoding = (node.encoding || 'base64').toLowerCase();
      // bodyStructure reports the encoded size; base64 inflates by 4/3
      const size = Math.round((node.size || 0) * (encoding === 'base64' ? 0.75 : 1));
      attachments.push({ part, name, type: node.type || 'application/octet-stream', encoding, size, ...(cid ? { cid } : {}),
        ...(inlineCal ? { _inlineCal: true } : {}) });
    }
    (node.childNodes || []).forEach(c => visit(c, false));
  }
  visit(struct, true);
  const bodyParts = new Set([text?.part, html?.part].filter(Boolean));
  const isCal = a => /^(text\/calendar|application\/(ics|x-ics|calendar))$/i.test(a.type) || /\.(ics|ical|ifb|vcs)$/i.test(a.name);
  const namedCal = attachments.some(a => !a._inlineCal && isCal(a));
  return {
    textPart: text, htmlPart: html,
    attachments: attachments.filter(a => !bodyParts.has(a.part) && !(a._inlineCal && namedCal)).map(({ _inlineCal, ...a }) => a),
  };
}

/** Transfer-decoded bytes of a body part (base64 / quoted-printable / 7bit / 8bit / binary). */
function _partBytes(buf, encoding) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (encoding === 'base64') return Buffer.from(raw.toString('ascii').replace(/\s+/g, ''), 'base64');
  if (encoding === 'quoted-printable') {
    // Byte-wise (latin1 keeps every byte as one char): soft line breaks out, =XX → byte; the charset is
    // applied to the resulting bytes, so multi-byte sequences (=C3=BC → ü) and 8-bit charsets both work
    const qp = raw.toString('latin1').replace(/=\r?\n/g, '');
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
    return Buffer.from(bytes);
  }
  return raw;
}

/** HTML parts without a charset parameter may name it in a <meta> tag. */
function _htmlMetaCharset(bytes) {
  const head = bytes.subarray(0, 2048).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}

/** Body part → string in its charset (Content-Type parameter; HTML: else <meta>; else UTF-8 / windows-1252). */
function _decodePart(buf, encoding, charset = '', html = false) {
  if (!buf) return '';
  const bytes = _partBytes(buf, encoding);
  return decodeText(bytes, charset || (html ? _htmlMetaCharset(bytes) : ''));
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
        if (textPart) body     = _decodePart(parts?.get(textPart.part), textPart.encoding, textPart.charset);
        if (htmlPart) bodyHtml = _decodePart(parts?.get(htmlPart.part), htmlPart.encoding, htmlPart.charset, true);
      } catch {
        try {
          const fb = await client.fetchOne(String(meta.uid), { bodyParts: ['text'] }, { uid: true });
          body = decodeText(fb?.bodyParts?.get('text'));
        } catch { /* ignore — return envelope only */ }
      }
    } else {
      // No recognised MIME part found — try the whole body as plain text
      try {
        const fb = await client.fetchOne(String(meta.uid), { bodyParts: ['text'] }, { uid: true });
        body = decodeText(fb?.bodyParts?.get('text'));
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
      flagged:     !!meta.flags?.has('\\Flagged'),
      flagColor:   flagColor(meta.flags),
      bodyHtml,
      body,
      attachments: attachments.map(a => ({ name: a.name, part: a.part, type: a.type, size: a.size, ...(a.cid ? { cid: a.cid } : {}) })),
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
  // Transfer decoding (base64, quoted-printable — e.g. an invitation's inline text/calendar part)
  return { data: _partBytes(buf, att.encoding), name: att.name, type: att.type };
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

// Folder index per folder: { sig, items: [{ uid, t, from }], dupes: Set } — reused while UIDVALIDITY / UIDNEXT / EXISTS
// are unchanged (new, removed or moved messages change one of them; flag changes don't matter)
const _folderIndexCache = new Map();
// UIDs with attachments per folder: { sig, uids: Set } — only scanned when the attachment filter is used
const _attachIndexCache = new Map();
const _INDEX_CACHE_MAX = 50;

/** List orders of the mail view: newest first (default), oldest first, sender A–Z (then newest first). */
const MAIL_SORTS = ['date', 'date-asc', 'from'];

function _cachePut(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > _INDEX_CACHE_MAX) cache.delete(cache.keys().next().value);
}

function _itemTime(it) {
  const t = new Date(it.envelope?.date || it.internalDate || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Sort key of a sender: display name, else the address — lower case. */
function _senderKey(addr) {
  return String(addr?.name || addr?.address || '').trim().toLowerCase();
}

/** UIDs sorted by date / time, latest first (Date header, else the arrival time; ties: higher UID first). Pure. */
function sortUidsByDate(items) {
  return orderFolderIndex(items.map(it => ({ uid: it.uid, t: _itemTime(it), from: '' })));
}

/**
 * Filter + order a folder index ([{ uid, t, from }]). Pure.
 * since / before: ms timestamps (since inclusive, before exclusive); only: Set of UIDs to keep.
 * sort: 'date' (latest first; ties: higher UID first), 'date-asc' (oldest first; ties: lower UID first),
 * 'from' (sender A–Z, accent- and case-insensitive; same sender latest first). Returns UIDs.
 */
function orderFolderIndex(items, { sort = 'date', since = null, before = null, only = null } = {}) {
  const list = items.filter(it =>
    (since == null || it.t >= since) && (before == null || it.t < before) && (!only || only.has(it.uid)));
  const byDate = (a, b) => b.t - a.t || b.uid - a.uid;
  if (sort === 'date-asc') list.sort((a, b) => a.t - b.t || a.uid - b.uid);
  else if (sort === 'from') {
    list.sort((a, b) => (a.from ? 0 : 1) - (b.from ? 0 : 1)
      || a.from.localeCompare(b.from, undefined, { sensitivity: 'base' }) || byDate(a, b));
  } else list.sort(byDate);
  return list.map(it => it.uid);
}

function _mailboxSig(client) {
  const mb = client.mailbox || {};
  return mb.uidValidity != null && mb.uidNext != null ? `${mb.uidValidity}:${mb.uidNext}:${mb.exists}` : null;
}

/** First message id of an In-Reply-To value ('' when none). */
function _firstMsgId(v) {
  return (String(v || '').match(/<[^<>\s]+>/) || [''])[0];
}

/**
 * All messages of the selected mailbox as { items: [{ uid, t, from, mid, irt, refs }], dupes } — dupes = Set of
 * the UIDs that are duplicate copies (findDuplicateUids: the largest copy of a group is the original);
 * mid / irt / refs = Message-ID, In-Reply-To, References (conversation threads).
 */
async function _folderIndex(client, account, folder) {
  const key = `${account.id}\n${folder}`;
  const sig = _mailboxSig(client);
  const hit = sig && _folderIndexCache.get(key);
  if (hit && hit.sig === sig) return hit;
  const items = [], raw = [];
  if (client.mailbox?.exists) {
    const query = { uid: true, envelope: true, internalDate: true, size: true, headers: ['references'] };
    for await (const msg of client.fetch('1:*', query)) {
      items.push({ uid: msg.uid, t: _itemTime(msg), from: _senderKey(msg.envelope?.from?.[0]),
        mid: (msg.envelope?.messageId || '').trim(), irt: _firstMsgId(msg.envelope?.inReplyTo),
        refs: _parseReferences(msg.headers) });
      raw.push({ uid: msg.uid, envelope: msg.envelope, internalDate: msg.internalDate, size: msg.size });
    }
  }
  const index = { sig, items, dupes: new Set(findDuplicateUids(raw)) };
  if (sig) _cachePut(_folderIndexCache, key, index);
  return index;
}

/** UIDs of the selected mailbox's messages with attachments (same rule as `hasAttachments` of the summaries). */
async function _attachmentUids(client, account, folder) {
  const key = `${account.id}\n${folder}`;
  const sig = _mailboxSig(client);
  const hit = sig && _attachIndexCache.get(key);
  if (hit && hit.sig === sig) return hit.uids;
  const uids = new Set();
  if (client.mailbox?.exists) {
    for await (const msg of client.fetch('1:*', { uid: true, bodyStructure: true })) {
      if (_findBodyParts(msg.bodyStructure).attachments.length) uids.add(msg.uid);
    }
  }
  if (sig) _cachePut(_attachIndexCache, key, { sig, uids });
  return uids;
}

const _FETCH_CHUNK = 500;   // UIDs per FETCH command ("Load all" of a big folder)

/**
 * UIDs of the selected mailbox that pass the list filters, in list order (see fetchFolderMessages).
 * `query` = IMAP search in subject / from / to / body.
 */
async function _listUids(client, account, folder, { query = '', sort = 'date', since = null, before = null,
  attachments = false, duplicates = false } = {}, index = null) {
  const { items, dupes } = index || await _folderIndex(client, account, folder);
  let only = duplicates ? dupes : null;
  if (query) {
    const found = (await client.search({
      or: [{ subject: query }, { from: query }, { to: query }, { body: query }],
    }, { uid: true })) || [];
    only = new Set(only ? found.filter(u => only.has(u)) : found);
  }
  if (attachments) {
    const withAtt = await _attachmentUids(client, account, folder);
    only = only ? new Set([...only].filter(u => withAtt.has(u))) : withAtt;
  }
  return orderFolderIndex(items, { sort, since, before, only });
}

/**
 * One page of a folder (or of the search results in it). Order: `sort` (MAIL_SORTS, default latest first).
 * Filters: `query` (IMAP search in subject / from / to / body), `since` / `before` (ms, Date header, else
 * arrival time), `attachments`, `duplicates` (only duplicate copies — findDuplicateUids). `all` returns every
 * message from `page` on (the mail view's "Load all").
 * Returns { messages, total, page, pageSize }.
 * `threads`: conversations instead (_fetchThreadPage) — pages count threads.
 */
async function fetchFolderMessages(account, folder, opts = {}) {
  if (opts.threads) return _withClient(account, client => _fetchThreadPage(client, account, folder, opts));
  const { page = 0, pageSize = 50, all = false } = opts;
  return _withMailbox(account, folder, async client => {
    const index = await _folderIndex(client, account, folder);
    const { dupes } = index;
    const uids  = await _listUids(client, account, folder, opts, index);
    const total = uids.length;
    const slice = uids.slice(page * pageSize, all ? undefined : (page + 1) * pageSize);
    const msgs  = [];
    for (let i = 0; i < slice.length; i += _FETCH_CHUNK) {
      const chunk = slice.slice(i, i + _FETCH_CHUNK);
      for await (const msg of client.fetch(chunk.join(','), _LIST_QUERY, { uid: true })) msgs.push(_summary(msg));
    }
    const pos = new Map(slice.map((u, i) => [String(u), i]));
    msgs.sort((a, b) => pos.get(a.id) - pos.get(b.id));
    // Duplicate copy anywhere in the folder (the list's "duplicate" label — same set as the duplicates filter)
    for (const m of msgs) m.duplicate = dupes.has(Number(m.id));
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

// ---- Duplicates ----

/** Lower-case bare addresses of an envelope address list, sorted. */
function _envAddrs(list) {
  return (list || []).map(a => (a.address || a.name || '').trim().toLowerCase()).filter(Boolean).sort().join(',');
}

/**
 * UIDs of duplicate messages: same sender, recipients (To), subject and exact date / time (Date header, else
 * the arrival time), plus
 *   - the same Message-ID when the message has one — size is ignored then: copies of one message often differ
 *     in size (headers added on delivery / move, attachments stripped by a client or re-encoded);
 *   - the same size when it has none.
 * The largest copy of each group is kept (no attachment is lost; ties: lowest UID), the others are returned. Pure.
 * msgs: [{ uid, envelope: { from, to, subject, date, messageId }, internalDate, size }]
 */
function findDuplicateUids(msgs) {
  const groups = new Map();
  for (const m of msgs) {
    const env = m.envelope || {};
    const date = env.date || m.internalDate;
    const time = date ? new Date(date).getTime() : NaN;
    const mid = (env.messageId || '').trim();
    const key = JSON.stringify([_envAddrs(env.from), _envAddrs(env.to), (env.subject || '').trim(),
                                Number.isNaN(time) ? '' : time, mid ? `mid:${mid}` : `size:${m.size ?? ''}`]);
    (groups.get(key) || groups.set(key, []).get(key)).push(m);
  }
  const dupes = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (b.size || 0) - (a.size || 0) || a.uid - b.uid);
    dupes.push(...g.slice(1).map(m => m.uid));
  }
  return dupes.sort((a, b) => a - b);
}

/** Scan `folder` for duplicates. Returns { messages, uids } (uids = the copies to delete). */
async function findDuplicateMessages(account, folder) {
  return _withMailbox(account, folder, async client => {
    const messages = client.mailbox?.exists ?? 0;
    const msgs = [];
    if (messages) {
      for await (const msg of client.fetch('1:*', { uid: true, envelope: true, internalDate: true, size: true })) {
        msgs.push({ uid: msg.uid, envelope: msg.envelope, internalDate: msg.internalDate, size: msg.size });
      }
    }
    return { messages, uids: findDuplicateUids(msgs) };
  });
}

// ---- Conversation threads ----

/**
 * Reply tree of messages — JWZ threading without subject matching (no false merges of "Re: Invoice"). Pure.
 * list: [{ key, mid, irt, refs, t }] — key unique per message copy; nodes with the same mid are copies of one
 * message. Parent = In-Reply-To, else the last References entry; the References chain links the ancestors (a
 * message's own headers win over what other messages say about it); links that would close a cycle are refused.
 * A missing ancestor stays as a placeholder only while it holds ≥ 2 children, else its children move up.
 * Returns { nodes: Map(id → { id, keys, parent, children: [id] (oldest first), t }), nodeOf: Map(key → id),
 * threadOf: Map(key → root id) }. Node ids: `m:<Message-ID>`, `k:<key>` for messages without one.
 */
function buildThreads(list) {
  const nodes = new Map();
  const get = id => nodes.get(id) || nodes.set(id, { id, keys: [], parent: null, children: [], t: Infinity }).get(id);
  // true when `a` is `b` or one of its ancestors
  const above = (a, b) => {
    for (let n = b, i = 0; n && i < 100_000; n = n.parent ? nodes.get(n.parent) : null, i++) if (n.id === a) return true;
    return false;
  };
  const link = (parentId, childId, force) => {
    if (parentId === childId) return;
    const c = get(childId);
    if (c.parent === parentId || (c.parent && !force) || above(childId, get(parentId))) return;
    c.parent = parentId;
  };
  const nodeOf = new Map(), chains = [];
  for (const it of list) {
    const id = it.mid ? `m:${it.mid}` : `k:${it.key}`;
    const n = get(id);
    n.keys.push(it.key);
    n.t = Math.min(n.t, it.t ?? Infinity);
    nodeOf.set(it.key, id);
    if (!it.mid) continue;
    const chain = (it.refs || []).filter(r => r !== it.mid);
    if (it.irt && it.irt !== it.mid && chain[chain.length - 1] !== it.irt) chain.push(it.irt);
    chains.push([id, chain.map(r => `m:${r}`)]);
  }
  for (const [, chain] of chains) for (let i = 1; i < chain.length; i++) link(chain[i - 1], chain[i], false);
  for (const [id, chain] of chains) if (chain.length) link(chain[chain.length - 1], id, true);

  const kids = new Map();
  const kidsOf = id => kids.get(id) || kids.set(id, []).get(id);
  for (const n of nodes.values()) if (n.parent) kidsOf(n.parent).push(n.id);
  // Missing ancestors with < 2 children go; their child moves up
  for (let changed = true; changed;) {
    changed = false;
    for (const n of [...nodes.values()]) {
      if (n.keys.length || kidsOf(n.id).length >= 2) continue;
      for (const c of kidsOf(n.id)) { nodes.get(c).parent = n.parent; if (n.parent) kidsOf(n.parent).push(c); }
      if (n.parent) { const pk = kidsOf(n.parent); pk.splice(pk.indexOf(n.id), 1); }
      kids.delete(n.id);
      nodes.delete(n.id);
      changed = true;
    }
  }
  // Placeholders take the time of their earliest child; siblings oldest first
  const time = id => { const n = nodes.get(id); if (n.t === Infinity && !n.keys.length) n.t = Math.min(...kidsOf(id).map(time)); return n.t; };
  for (const n of nodes.values()) n.children = kidsOf(n.id).sort((a, b) => time(a) - time(b) || (a < b ? -1 : 1));
  const rootOf = new Map();
  const root = id => {
    if (rootOf.has(id)) return rootOf.get(id);
    const n = nodes.get(id);
    const r = n.parent ? root(n.parent) : id;
    rootOf.set(id, r);
    return r;
  };
  const threadOf = new Map();
  for (const [key, id] of nodeOf) threadOf.set(key, root(id));
  return { nodes, nodeOf, threadOf };
}

const _threadIndexCache = new Map();   // account id → { sig, idx: Map(folder → folder index), …buildThreads }

/**
 * Folders a conversation is collected from: every selectable folder except trash / spam (isEmptyableFolder),
 * plus `openFolder` itself. LIST-STATUS gives the signature to reuse cached folder indexes without selecting them.
 */
async function _threadFolders(client, account, openFolder) {
  let list;
  try { list = await client.list({ statusQuery: { messages: true, uidNext: true, uidValidity: true } }); }
  catch { list = await client.list(); }
  const out = (list || []).filter(f => {
    const m = _mapFolder(f);
    return !m.noselect && (f.path === openFolder || !isEmptyableFolder(m, account));
  });
  if (!out.some(f => f.path === openFolder)) out.push({ path: openFolder });
  return out;
}

/** Folder index of `f` (a LIST entry) — from the cache when its LIST-STATUS signature matches; null if not selectable. */
async function _folderIndexAt(client, account, f) {
  const st = f.status;
  if (st?.uidValidity != null && st.uidNext != null) {
    const hit = _folderIndexCache.get(`${account.id}\n${f.path}`);
    if (hit && hit.sig === `${st.uidValidity}:${st.uidNext}:${st.messages}`) return hit;
  }
  let lock;
  try { lock = await client.getMailboxLock(f.path, { readOnly: true }); } catch { return null; }
  try { return await _folderIndex(client, account, f.path); } finally { lock.release(); }
}

/** Conversation threads of the whole account (_threadFolders), rebuilt only when a folder changed. */
async function _threadIndex(client, account, openFolder) {
  const idx = new Map();
  for (const f of await _threadFolders(client, account, openFolder)) {
    const i = await _folderIndexAt(client, account, f);
    if (i) idx.set(f.path, i);
  }
  const sig = [...idx].map(([p, i]) => `${p}\n${i.sig}`).join('\n\n');
  const hit = _threadIndexCache.get(account.id);
  if (hit && hit.sig === sig && [...idx.values()].every(i => i.sig)) return hit;
  const list = [];
  for (const [path, i] of idx) for (const it of i.items) list.push({ key: `${path}\n${it.uid}`, mid: it.mid, irt: it.irt, refs: it.refs, t: it.t });
  const res = { sig, idx, ...buildThreads(list) };
  _cachePut(_threadIndexCache, account.id, res);
  return res;
}

function _splitKey(key) {
  const i = key.lastIndexOf('\n');
  return [key.slice(0, i), Number(key.slice(i + 1))];
}

/**
 * A thread in tree order (depth first, siblings oldest first): [{ node, parent, depth, key | null }] — key null =
 * placeholder of a missing message. Copies: every copy in `folder`, else the first one.
 */
function _threadEntries(t, rootId, folder, fallbackKey) {
  if (!t.nodes.has(rootId)) return [{ node: rootId, parent: null, depth: 0, key: fallbackKey }];
  const out = [];
  const walk = (id, parent, depth) => {
    const n = t.nodes.get(id);
    const here = n.keys.filter(k => _splitKey(k)[0] === folder);
    const keys = here.length ? here : n.keys.slice(0, 1);
    if (!keys.length) out.push({ node: id, parent, depth, key: null });
    for (const k of keys) out.push({ node: id, parent, depth, key: k });
    for (const c of n.children) walk(c, id, depth + 1);
  };
  walk(rootId, null, 0);
  return out;
}

/**
 * Summaries for thread entries (one read-only lock per folder): [{ …summary, folder, node, parent, depth, foreign,
 * duplicate, match? }] and { placeholder: true, node, parent, depth } for missing messages; entries whose message
 * is gone are dropped. `matches` (Set of UIDs in `folder`) marks the hits of a filtered list.
 */
async function _threadMessages(client, t, entries, folder, matches = null) {
  const byFolder = new Map();
  for (const e of entries) {
    if (!e.key) continue;
    const [f, uid] = _splitKey(e.key);
    (byFolder.get(f) || byFolder.set(f, []).get(f)).push(uid);
  }
  const msgs = new Map();
  for (const [f, uids] of byFolder) {
    let lock;
    try { lock = await client.getMailboxLock(f, { readOnly: true }); } catch { continue; }
    try {
      for (let i = 0; i < uids.length; i += _FETCH_CHUNK) {
        for await (const msg of client.fetch(uids.slice(i, i + _FETCH_CHUNK).join(','), _LIST_QUERY, { uid: true })) {
          msgs.set(`${f}\n${msg.uid}`, msg);
        }
      }
    } finally {
      lock.release();
    }
  }
  const out = [];
  for (const e of entries) {
    const base = { node: e.node, parent: e.parent, depth: e.depth };
    if (!e.key) { out.push({ ...base, placeholder: true }); continue; }
    const msg = msgs.get(e.key);
    if (!msg) continue;
    const [f, uid] = _splitKey(e.key);
    out.push({ ..._summary(msg), folder: f, ...base, foreign: f !== folder, duplicate: !!t.idx.get(f)?.dupes.has(uid),
      ...(matches && f === folder ? { match: matches.has(uid) } : {}) });
  }
  return out;
}

/**
 * Conversation page of a folder: threads with ≥ 1 message in `folder` that passes the list filters, ordered by
 * their first message in list order, paged by thread (`all` = every thread from `page` on). Each thread carries
 * its messages from every folder (_threadFolders) in tree order. Returns { threads: [{ id, messages }],
 * messages (the page's messages in `folder`), total (threads), totalMessages, page, pageSize }.
 */
async function _fetchThreadPage(client, account, folder, { page = 0, pageSize = 50, all = false, ...opts } = {}) {
  const t = await _threadIndex(client, account, folder);
  let uids;
  const lock = await client.getMailboxLock(folder);
  try { uids = await _listUids(client, account, folder, opts, t.idx.get(folder)); } finally { lock.release(); }
  const filtered = !!(opts.query || opts.since != null || opts.before != null || opts.attachments || opts.duplicates);
  const order = [], first = new Map();
  for (const uid of uids) {
    const key = `${folder}\n${uid}`;
    const id = t.threadOf.get(key) || `k:${key}`;
    if (!first.has(id)) { first.set(id, key); order.push(id); }
  }
  const ids = order.slice(page * pageSize, all ? undefined : (page + 1) * pageSize);
  const parts = ids.map(id => _threadEntries(t, id, folder, first.get(id)));
  const msgs = await _threadMessages(client, t, parts.flat(), folder, filtered ? new Set(uids) : null);
  const byNode = new Map();
  for (const m of msgs) (byNode.get(m.node) || byNode.set(m.node, []).get(m.node)).push(m);
  const threads = ids.map((id, i) => ({
    id, messages: [...new Set(parts[i].map(e => e.node))].flatMap(n => byNode.get(n) || []),
  })).filter(th => th.messages.some(m => !m.placeholder && !m.foreign));
  return {
    threads, messages: threads.flatMap(th => th.messages.filter(m => !m.placeholder && !m.foreign)),
    total: order.length, totalMessages: uids.length, page, pageSize,
  };
}

/**
 * Conversation of one message for the reader: { id, messages } (tree order, every folder — _threadMessages);
 * null when the message is not in the folder.
 */
async function fetchThread(account, uid, folder) {
  folder = _folderOf(account, folder);
  return _withClient(account, async client => {
    const t = await _threadIndex(client, account, folder);
    const key = `${folder}\n${uid}`;
    const id = t.threadOf.get(key);
    if (!id) return null;
    return { id, messages: await _threadMessages(client, t, _threadEntries(t, id, folder, key), folder) };
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

/**
 * Search every selectable folder of an account — or only `folders` — (Today Find widget / Find dialog;
 * `since` / `before` = Date header range, `before` exclusive). The IMAP search runs on
 * `word` (subject / from / to / cc, plus body with `full`); `accept(summary)` re-checks the
 * other words. Newest first, ≤ `perFolder` per folder and `limit` overall; stops after
 * `budgetMs` and flags the result `truncated`. Returns { messages (with `folder`), total, truncated }.
 */
async function searchMailAccount(account, word, { full = false, accept = () => true, perFolder = 20, limit = 50, budgetMs = 20_000,
  folders = null, since = null, before = null } = {}) {
  const started = Date.now();
  return _withClient(account, async client => {
    // `folders`: only these (the Find dialog's folder filter), else every selectable folder
    const paths = folders ? [...folders] : (await client.list())
      .filter(f => !_mapFolder(f).noselect)
      .map(f => f.path);
    // Account folder (INBOX) first, then the rest alphabetically
    const first = account.folder || 'INBOX';
    paths.sort((a, b) => (b === first) - (a === first) || a.localeCompare(b));
    const keys = [{ subject: word }, { from: word }, { to: word }, { cc: word }];
    if (full) keys.push({ body: word });
    // Date range on the Date header (SENTSINCE / SENTBEFORE — `before` is exclusive)
    const dates = { ...(since ? { sentSince: since } : {}), ...(before ? { sentBefore: before } : {}) };
    const messages = [];
    let total = 0, truncated = false;
    for (const path of paths) {
      if (Date.now() - started > budgetMs) { truncated = true; break; }
      let lock;
      try { lock = await client.getMailboxLock(path, { readOnly: true }); } catch { continue; }
      try {
        const uids = ((await client.search({ or: keys, deleted: false, ...dates }, { uid: true })) || []).sort((a, b) => b - a);
        if (!uids.length) continue;
        const found = [];
        for await (const msg of client.fetch(uids.slice(0, 200).join(','), _LIST_QUERY, { uid: true })) {
          const s = { ..._summary(msg), cc: _fmtAddrList(msg.envelope?.cc), folder: path };
          if (accept(s)) found.push(s);
        }
        found.sort((a, b) => Number(b.id) - Number(a.id));
        total += found.length + Math.max(0, uids.length - 200);
        messages.push(...found.slice(0, perFolder));
      } catch { /* folder not searchable — skip */ } finally {
        lock.release();
      }
    }
    messages.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return { messages: messages.slice(0, limit), total, truncated };
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
 * Flag messages by UID (set) with an Apple Mail colour (MAIL_FLAG_COLORS), or clear the flag (null).
 * Servers without custom keywords keep just \Flagged (imapflow drops flags the mailbox doesn't allow).
 */
async function flagMailMessage(account, uid, color, folder) {
  const { add, remove } = flagChanges(color);
  return _withMailbox(account, folder, async client => {
    if (add.length)    await client.messageFlagsAdd(String(uid), add, { uid: true });
    if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
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
  MAIL_FLAG_COLORS,
  flagColor,
  flagChanges,
  flagMailMessage,
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
  searchMailAccount,
  testMailAccount,
  listMailFolders,
  createMailFolder,
  deleteMailFolder,
  renameMailFolder,
  emptyMailFolder,
  isEmptyableFolder,
  markMailMessage,
  markFolderRead,
  findDuplicateUids,
  buildThreads,
  fetchThread,
  sortUidsByDate,
  orderFolderIndex,
  MAIL_SORTS,
  findDuplicateMessages,
  moveMailMessage,
  deleteMailMessage,
  sendMail,
  _parseReferences,
  _addresses,
  _smtpSettings,
};
