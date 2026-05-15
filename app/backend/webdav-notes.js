'use strict';
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

// ─── Low-level HTTP ───────────────────────────────────────────────────────────

function buildUrl(cfg, relPath) {
  const base = cfg.url.endsWith('/') ? cfg.url : cfg.url + '/';
  if (!relPath) return new URL(base);
  const trailingSlash = relPath.endsWith('/');
  const encoded = relPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return new URL(encoded + (trailingSlash ? '/' : ''), base);
}

function wdRequest(cfg, method, relPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url  = buildUrl(cfg, relPath);
    const auth = 'Basic ' + Buffer.from(`${cfg.username || ''}:${cfg.password || ''}`).toString('base64');
    const headers = { Authorization: auth, ...opts.headers };
    // Accept both string and Buffer bodies
    const body = opts.body != null
      ? (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8'))
      : null;
    if (body) {
      headers['Content-Length'] = String(body.length);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream';
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => {
        const rawBody = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: rawBody.toString('utf8'), rawBody });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── PROPFIND XML parsing ─────────────────────────────────────────────────────

function parsePropfind(xml) {
  const results = [];
  const blockRe = /<[^:>\s/]+:response\b[^>]*>([\s\S]*?)<\/[^:>\s/]+:response>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const inner = m[1];
    const hrefM = /<[^:>\s/]+:href\b[^>]*>\s*([^\s<]+)\s*<\/[^:>\s/]+:href>/i.exec(inner);
    if (!hrefM) continue;
    let href;
    try   { href = decodeURIComponent(new URL(hrefM[1].trim(), 'http://x').pathname); }
    catch { href = decodeURIComponent(hrefM[1].trim()); }
    const isCollection = /<[^:>\s/]+:collection\s*\/>/i.test(inner);
    const sizeM = /<[^:>\s/]+:getcontentlength\b[^>]*>(\d+)<\/[^:>\s/]+:getcontentlength>/i.exec(inner);
    const size  = sizeM ? parseInt(sizeM[1], 10) : undefined;
    results.push({ href, isCollection, size });
  }
  return results;
}

// ─── Front-matter helpers ─────────────────────────────────────────────────────

function parseFm(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/s.exec(text);
  if (!m) return { id: '', link: '', linkedCards: [], body: text.trim() };

  const fmText = m[1];
  const body   = m[2].trim();
  const meta   = {};

  for (const line of fmText.split('\n')) {
    const kv = /^(\w+):\s*(.+)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const lcBlock = /^linkedCards:\s*\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(fmText);
  meta.linkedCards = lcBlock
    ? [...lcBlock[1].matchAll(/[ \t]+-\s*(.+)/g)].map(lm => lm[1].trim())
    : [];

  return { id: meta.id || '', link: meta.link || '', linkedCards: meta.linkedCards, body };
}

function renderMd(page) {
  let out = '---\n';
  out += `id: ${page.id}\n`;
  if (page.link) out += `link: ${page.link}\n`;
  if (page.linkedCards?.length) {
    out += 'linkedCards:\n';
    for (const c of page.linkedCards) out += `  - ${c}\n`;
  }
  out += '---\n';
  if (page.description) out += '\n' + page.description;
  return out;
}

// ─── Filename utils ───────────────────────────────────────────────────────────

function toFilename(title) {
  return (title || 'untitled').replace(/[/\\<>:|*?"]/g, '_').trim() || 'untitled';
}

// ─── Directory listing ────────────────────────────────────────────────────────

const PF_BODY          = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
const PF_BODY_WITH_SIZE = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>';
const PF_HEADERS       = { 'Depth': '1', 'Content-Type': 'application/xml' };

async function listChildren(cfg, dirRelPath) {
  const dirUrl      = buildUrl(cfg, dirRelPath ? dirRelPath + '/' : '');
  const dirPathname = decodeURIComponent(dirUrl.pathname);

  const res = await wdRequest(cfg, 'PROPFIND', dirRelPath ? dirRelPath + '/' : '', {
    headers: PF_HEADERS, body: PF_BODY,
  });

  if (res.status === 404) return [];
  if (res.status !== 207) throw new Error(`PROPFIND ${dirRelPath || '/'}: HTTP ${res.status}`);

  return parsePropfind(res.body)
    .map(({ href, isCollection, size }) => {
      if (!href.startsWith(dirPathname)) return null;
      const name = href.slice(dirPathname.length).replace(/\/$/, '');
      if (!name || name.includes('/')) return null;
      return { name, isCollection, size };
    })
    .filter(Boolean);
}

// ─── Load notes from WebDAV ───────────────────────────────────────────────────

async function loadDir(cfg, dirRelPath) {
  let children;
  try { children = await listChildren(cfg, dirRelPath); }
  catch { return []; }

  const pages = [];

  for (const { name, isCollection } of children) {
    if (name.startsWith('_')) continue;   // skip _attachments and similar reserved dirs
    const childRel = dirRelPath ? `${dirRelPath}/${name}` : name;

    if (isCollection) {
      const page = {
        id: 'n-' + crypto.randomBytes(6).toString('hex'),
        title: name, description: '', link: '', linkedCards: [],
      };
      try {
        const r = await wdRequest(cfg, 'GET', `${childRel}/index.md`, {});
        if (r.status === 200) {
          const fm   = parseFm(r.body);
          page.id    = fm.id || page.id;
          page.description = fm.body;
          page.link        = fm.link;
          page.linkedCards = fm.linkedCards;
        }
      } catch {}
      page.children = await loadDir(cfg, childRel);
      pages.push(page);

    } else if (name.endsWith('.md') && name !== 'index.md') {
      try {
        const r = await wdRequest(cfg, 'GET', childRel, {});
        if (r.status === 200) {
          const fm = parseFm(r.body);
          pages.push({
            id:          fm.id || 'n-' + crypto.randomBytes(6).toString('hex'),
            title:       name.slice(0, -3),
            description: fm.body,
            link:        fm.link,
            linkedCards: fm.linkedCards,
            children:    [],
          });
        }
      } catch {}
    }
  }

  return pages;
}

async function loadNotesFromWebdav(cfg) {
  const pages = await loadDir(cfg, '');
  return { pages };
}

// ─── Save notes to WebDAV ─────────────────────────────────────────────────────

async function syncDir(cfg, pages, dirRelPath) {
  const targetMap = new Map();
  for (const page of pages) {
    const fn = toFilename(page.title);
    if ((page.children || []).length > 0) targetMap.set(fn, 'dir');
    else                                  targetMap.set(fn + '.md', 'file');
  }

  let existing = [];
  try { existing = await listChildren(cfg, dirRelPath); } catch {}

  for (const page of pages) {
    const fn  = toFilename(page.title);
    const rel = dirRelPath ? `${dirRelPath}/${fn}` : fn;
    const hasChildren = (page.children || []).length > 0;

    if (hasChildren) {
      if (existing.some(e => e.name === fn + '.md' && !e.isCollection))
        await wdRequest(cfg, 'DELETE', `${rel}.md`, {}).catch(() => {});
      const mkr = await wdRequest(cfg, 'MKCOL', rel, {});
      if (mkr.status !== 201 && mkr.status !== 405 && mkr.status !== 409)
        throw new Error(`MKCOL ${rel}: HTTP ${mkr.status}`);
      await wdRequest(cfg, 'PUT', `${rel}/index.md`, { body: renderMd(page) });
      await syncDir(cfg, page.children, rel);
    } else {
      if (existing.some(e => e.name === fn && e.isCollection))
        await wdRequest(cfg, 'DELETE', rel + '/', {}).catch(() => {});
      await wdRequest(cfg, 'PUT', `${rel}.md`, { body: renderMd(page) });
    }
  }

  // Delete orphans — skip underscore-prefixed entries (_attachments etc.)
  for (const { name, isCollection } of existing) {
    if (!targetMap.has(name) && !name.startsWith('_')) {
      const entryRel = dirRelPath ? `${dirRelPath}/${name}` : name;
      await wdRequest(cfg, 'DELETE', isCollection ? entryRel + '/' : entryRel, {}).catch(() => {});
    }
  }
}

async function saveNotesToWebdav(cfg, notes) {
  await syncDir(cfg, notes.pages || [], '');
}

// ─── Attachment helpers ───────────────────────────────────────────────────────

// Attachments live at  _attachments/<pageId>/<filename>  relative to the board root.

async function listAttachmentsFromWebdav(cfg, pageId) {
  const dirRel      = `_attachments/${pageId}`;
  const dirUrl      = buildUrl(cfg, dirRel + '/');
  const dirPathname = decodeURIComponent(dirUrl.pathname);

  const res = await wdRequest(cfg, 'PROPFIND', dirRel + '/', {
    headers: { 'Depth': '1', 'Content-Type': 'application/xml' },
    body: PF_BODY_WITH_SIZE,
  });

  if (res.status === 404) return [];
  if (res.status !== 207) return [];

  return parsePropfind(res.body)
    .map(({ href, isCollection, size }) => {
      if (isCollection) return null;
      if (!href.startsWith(dirPathname)) return null;
      const name = href.slice(dirPathname.length).replace(/\/$/, '');
      if (!name || name.includes('/')) return null;
      return { name, size: size ?? 0 };
    })
    .filter(Boolean);
}

async function getAttachmentFromWebdav(cfg, pageId, filename) {
  const res = await wdRequest(cfg, 'GET', `_attachments/${pageId}/${filename}`, {});
  if (res.status === 404) { const e = new Error('Not found'); e.status = 404; throw e; }
  if (res.status !== 200) throw new Error(`GET attachment: HTTP ${res.status}`);
  return res.rawBody;
}

async function uploadAttachmentToWebdav(cfg, pageId, filename, buffer) {
  // Ensure parent directories exist (ignore 405/409 = already exists)
  await wdRequest(cfg, 'MKCOL', '_attachments', {}).catch(() => {});
  await wdRequest(cfg, 'MKCOL', `_attachments/${pageId}`, {}).catch(() => {});
  const res = await wdRequest(cfg, 'PUT', `_attachments/${pageId}/${filename}`, { body: buffer });
  if (res.status !== 201 && res.status !== 204)
    throw new Error(`PUT attachment failed: HTTP ${res.status}`);
}

async function deleteAttachmentFromWebdav(cfg, pageId, filename) {
  await wdRequest(cfg, 'DELETE', `_attachments/${pageId}/${filename}`, {});
}

// ─── Migration merge ──────────────────────────────────────────────────────────

function mergeForMigration(couchPages, webdavPages) {
  const couchTitles = new Set((couchPages || []).map(p => p.title.toLowerCase()));
  const renamedWebdav = (webdavPages || []).map(p =>
    couchTitles.has(p.title.toLowerCase())
      ? { ...p, title: `${p.title} (from webdav)` }
      : p
  );
  return [...(couchPages || []), ...renamedWebdav];
}

// ─── Test connection ──────────────────────────────────────────────────────────

async function testWebdavConnection(cfg) {
  try {
    const res = await wdRequest(cfg, 'PROPFIND', '', {
      headers: { 'Depth': '0', 'Content-Type': 'application/xml' },
      body: PF_BODY,
    });
    if (res.status === 207 || res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'Authentication failed (wrong username or password)' };
    if (res.status === 403) return { ok: false, error: 'Access denied' };
    if (res.status === 404) return { ok: false, error: 'Directory not found — check the URL' };
    return { ok: false, error: `Server returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  loadNotesFromWebdav,
  saveNotesToWebdav,
  mergeForMigration,
  testWebdavConnection,
  listAttachmentsFromWebdav,
  getAttachmentFromWebdav,
  uploadAttachmentToWebdav,
  deleteAttachmentFromWebdav,
};
