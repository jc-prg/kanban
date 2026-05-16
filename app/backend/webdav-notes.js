'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _authHeader(cfg) {
  if (!cfg.user && !cfg.password) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64') };
}

function _resolveUrl(cfg, relPath) {
  const base = cfg.url.endsWith('/') ? cfg.url : cfg.url + '/';
  return base + relPath.replace(/^\//, '');
}

function _titleToSlug(title) {
  return (title || 'untitled')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'untitled';
}

// Extract text content of a named tag, ignoring namespace prefixes.
function _extractTags(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function _hasTag(xml, tag) {
  return new RegExp(`<(?:[\\w-]+:)?${tag}[\\s/>]`, 'i').test(xml);
}

function _parsePropfindXml(xml, baseUrl) {
  const responses = _extractTags(xml, 'response');
  const basePathname = (() => {
    try { return new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').pathname; }
    catch { return '/'; }
  })();

  return responses.map(resp => {
    const rawHref = (_extractTags(resp, 'href')[0] || '').trim();
    let href = rawHref;
    try {
      const u = new URL(rawHref, baseUrl);
      href = decodeURIComponent(u.pathname).slice(basePathname.length);
    } catch { /* keep raw */ }
    href = href.replace(/^\//, '');

    const isCollection    = _hasTag(resp, 'collection');
    const lastModifiedStr = (_extractTags(resp, 'getlastmodified')[0] || '').trim();
    const size            = parseInt((_extractTags(resp, 'getcontentlength')[0] || '').trim(), 10) || 0;
    const lastModified    = lastModifiedStr ? new Date(lastModifiedStr).toISOString() : null;

    return { href, isCollection, lastModified, size };
  }).filter(e => e.href !== '');
}

// ---------------------------------------------------------------------------
// WebDAV primitives
// ---------------------------------------------------------------------------

async function wdGet(cfg, relPath) {
  const r = await fetch(_resolveUrl(cfg, relPath), { headers: _authHeader(cfg) });
  if (!r.ok) { const e = new Error(`GET ${relPath} → ${r.status}`); e.status = r.status; throw e; }
  return r.text();
}

async function wdPut(cfg, relPath, content) {
  const r = await fetch(_resolveUrl(cfg, relPath), {
    method:  'PUT',
    headers: { ..._authHeader(cfg), 'Content-Type': 'text/markdown; charset=utf-8' },
    body:    content,
  });
  if (!r.ok && r.status !== 201 && r.status !== 204)
    throw new Error(`PUT ${relPath} → ${r.status}`);
}

async function wdPutBinary(cfg, relPath, buffer, mimeType = 'application/octet-stream') {
  const r = await fetch(_resolveUrl(cfg, relPath), {
    method:  'PUT',
    headers: { ..._authHeader(cfg), 'Content-Type': mimeType },
    body:    buffer,
  });
  if (!r.ok && r.status !== 201 && r.status !== 204)
    throw new Error(`PUT ${relPath} → ${r.status}`);
}

async function wdDelete(cfg, relPath) {
  const r = await fetch(_resolveUrl(cfg, relPath), { method: 'DELETE', headers: _authHeader(cfg) });
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${relPath} → ${r.status}`);
}

async function wdMove(cfg, fromPath, toPath) {
  const destUrl = _resolveUrl(cfg, toPath);
  const r = await fetch(_resolveUrl(cfg, fromPath), {
    method:  'MOVE',
    headers: { ..._authHeader(cfg), Destination: destUrl, Overwrite: 'T' },
  });
  if (!r.ok) throw new Error(`MOVE ${fromPath} → ${toPath}: HTTP ${r.status}`);
}

async function wdMkcol(cfg, relPath) {
  const r = await fetch(_resolveUrl(cfg, relPath), { method: 'MKCOL', headers: _authHeader(cfg) });
  if (!r.ok && r.status !== 405 && r.status !== 301 && r.status !== 405)
    throw new Error(`MKCOL ${relPath} → ${r.status}`);
}

async function wdPropfind(cfg, relPath, depth = '1') {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:getlastmodified/><D:getcontentlength/><D:resourcetype/></D:prop>
</D:propfind>`;
  const r = await fetch(_resolveUrl(cfg, relPath || ''), {
    method:  'PROPFIND',
    headers: { ..._authHeader(cfg), Depth: depth, 'Content-Type': 'application/xml' },
    body,
  });
  if (!r.ok) throw new Error(`PROPFIND ${relPath} → ${r.status}`);
  return _parsePropfindXml(await r.text(), cfg.url);
}

async function wdGetMeta(cfg, relPath) {
  const entries = await wdPropfind(cfg, relPath, '0');
  // The root entry has href '' or '/', skip it and return the first non-empty one, or the first
  const e = entries.find(x => x.href !== '' && x.href !== '/') || entries[0] || null;
  return e ? { lastModified: e.lastModified, size: e.size } : null;
}

// ---------------------------------------------------------------------------
// Tree path helpers
// ---------------------------------------------------------------------------

// Build map: relPath → item, walking tree and computing paths from titles
function _buildPathMap(items, map, prefix) {
  for (const item of items) {
    const slug = _titleToSlug(item.title);
    if (item.type === 'folder') {
      const p = prefix + slug + '/';
      map.set(p, item);
      _buildPathMap(item.children || [], map, p);
    } else {
      map.set(prefix + slug + '.md', item);
    }
  }
}

// Returns relative WebDAV path for an item given the full tree
function buildPath(item, tree) {
  const map = new Map();
  _buildPathMap(tree, map, '');
  for (const [p, it] of map) { if (it === item || it.id === item.id) return p; }
  return null;
}

// ---------------------------------------------------------------------------
// Front-matter
// ---------------------------------------------------------------------------

function parseFm(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    if (listKey) {
      const item = line.match(/^\s+-\s+(.*)/);
      if (item) { meta[listKey].push(item[1].trim()); continue; }
      listKey = null;
    }
    const kv = line.match(/^(\w+):\s*(.*)/);
    if (!kv) continue;
    if (kv[2].trim() === '') {
      meta[kv[1]] = [];
      listKey = kv[1];
    } else {
      meta[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return { meta, body: m[2] };
}

/** Extract card IDs from linkedCards frontmatter value.
 *  Handles both the new list format (array of "title (id-xxx)" strings)
 *  and the legacy comma-separated string "id-a, id-b". */
function _parseLinkedCards(value) {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : value.split(',').map(s => s.trim());
  return entries
    .map(e => { const m = String(e).match(/\(([^)]+)\)$/); return m ? m[1] : e.trim(); })
    .filter(Boolean);
}

function renderMd(page, attachmentFiles = [], source = '', linkedCardEntries = null) {
  const lcEntries = linkedCardEntries ?? (page.linkedCards || []);
  const lines = ['---', `id: ${page.id}`, `title: ${yamlStr(page.title || '')}`];
  if (source)              lines.push(`source: ${yamlStr(source)}`);
  if (page.link)           lines.push(`link: ${yamlStr(page.link)}`);
  if (lcEntries.length) {
    lines.push('linkedCards:');
    for (const e of lcEntries) lines.push(`  - ${e}`);
  }
  if (page.lastModified)   lines.push(`lastModified: ${page.lastModified}`);
  if (attachmentFiles.length) {
    lines.push('attachments:');
    for (const f of attachmentFiles) lines.push(`  - ${f}`);
  }
  lines.push('---', '', page.description || '');
  return lines.join('\n');
}

function yamlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------------
// Sync: WebDAV → CouchDB
// ---------------------------------------------------------------------------

function _slugMatch(seg, title) {
  return _titleToSlug(title) === seg;
}

// Find or create folder in items by slug, returning it (mutates items if creating)
function _findOrCreateFolder(items, slugSegment) {
  let folder = items.find(it => it.type === 'folder' && _slugMatch(slugSegment, it.title));
  if (!folder) {
    folder = { type: 'folder', id: 'f-' + slugSegment + '-' + Date.now(), title: slugSegment, children: [] };
    items.push(folder);
  }
  return folder;
}

// Return array of all page items in a flat list
function _collectPageIds(items) {
  const ids = [];
  for (const item of items) {
    if (item.type === 'page')   ids.push(item.id);
    if (item.type === 'folder') ids.push(..._collectPageIds(item.children || []));
  }
  return ids;
}

async function syncFromWebdav(cfg, tree) {
  // 1. PROPFIND depth:infinity
  const wdEntries = await wdPropfind(cfg, '', 'infinity');

  // Build path → wdEntry map (skip root itself, _attachments dirs, non-md files at collection level)
  const wdMap = new Map();
  for (const e of wdEntries) {
    const h = e.href.replace(/^\//, '');
    if (!h || h === '' || h.startsWith('_attachments')) continue;
    // Skip hidden files/folders (any path segment starting with '.')
    if (h.split('/').some(seg => seg.startsWith('.'))) continue;
    // Only keep directories and .md files
    if (!e.isCollection && !h.endsWith('.md')) continue;
    wdMap.set(h, e);
  }

  // 2. Build path → item map from cached tree
  const pathMap = new Map();
  _buildPathMap(tree.items || [], pathMap, '');

  const newTree = JSON.parse(JSON.stringify(tree));
  let changed = false;

  // 3. For each WebDAV file/dir, update or create in tree
  for (const [relPath, wdEntry] of wdMap) {
    if (wdEntry.isCollection) {
      // Ensure folder exists in tree — simple flat approach: only root-level folders
      const seg = relPath.replace(/\/$/, '');
      if (!seg.includes('/')) {
        if (!pathMap.has(relPath)) {
          _findOrCreateFolder(newTree.items, seg);
          changed = true;
        }
      }
      continue;
    }

    // .md file
    const existing = pathMap.get(relPath);
    const wdTime   = wdEntry.lastModified ? new Date(wdEntry.lastModified).getTime() : 0;

    if (existing) {
      const cacheTime = existing.lastModified ? new Date(existing.lastModified).getTime() : 0;
      if (wdTime > cacheTime) {
        try {
          const text = await wdGet(cfg, relPath);
          const { meta, body } = parseFm(text);
          existing.description    = body;
          existing.lastModified   = wdEntry.lastModified || new Date().toISOString();
          if (meta.title)         existing.title        = meta.title;
          existing.link           = meta.link || '';
          existing.linkedCards    = _parseLinkedCards(meta.linkedCards);
          existing.hasAttachments = Array.isArray(meta.attachments) ? meta.attachments.length > 0 : !!meta.attachments;
          changed = true;
        } catch { /* skip on error */ }
      }
    } else {
      // New file from WebDAV — create page
      try {
        const text = await wdGet(cfg, relPath);
        const { meta, body } = parseFm(text);
        const segments = relPath.split('/');
        const titleFromSlug = segments[segments.length - 1].replace(/\.md$/, '');
        const newPage = {
          type:           'page',
          id:             meta.id || ('n-wd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
          title:          meta.title || titleFromSlug,
          description:    body,
          link:           meta.link || '',
          linkedCards:    _parseLinkedCards(meta.linkedCards),
          lastModified:   wdEntry.lastModified || new Date().toISOString(),
          hasAttachments: !!meta.attachments,
        };
        // Place in correct folder or root
        if (segments.length > 1) {
          const folderSeg = segments[0];
          const folder    = _findOrCreateFolder(newTree.items, folderSeg);
          folder.children.push(newPage);
        } else {
          newTree.items.push(newPage);
        }
        changed = true;
      } catch { /* skip */ }
    }
  }

  // 4. Mark items absent from WebDAV as orphaned
  for (const [relPath, item] of pathMap) {
    if (item.type === 'page' && !wdMap.has(relPath)) {
      item.orphaned = true;
      changed = true;
    }
  }

  return { tree: newTree, changed };
}

// ---------------------------------------------------------------------------
// Deletion helpers
// ---------------------------------------------------------------------------

async function deletePageWithAttachments(cfg, page, tree, boardAttachDir) {
  const pagePath = buildPath(page, tree);
  if (pagePath) await wdDelete(cfg, pagePath);
  // Also delete WebDAV _attachments/<pageId>/
  await wdDelete(cfg, `_attachments/${page.id}/`);
  // Delete local CouchDB attachment files
  if (boardAttachDir) {
    const localDir = path.join(boardAttachDir, page.id);
    try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

async function deleteFolderWithAttachments(cfg, folder, tree, boardAttachDir) {
  const pageIds  = _collectPageIds(folder.children || []);
  const folderPath = buildPath(folder, tree);
  if (folderPath) await wdDelete(cfg, folderPath);
  // Delete attachment dirs
  for (const id of pageIds) {
    await wdDelete(cfg, `_attachments/${id}/`).catch(() => {});
    if (boardAttachDir) {
      const localDir = path.join(boardAttachDir, id);
      try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }
}

module.exports = {
  wdGet, wdPut, wdPutBinary, wdDelete, wdMove, wdMkcol, wdPropfind, wdGetMeta,
  buildPath, parseFm, renderMd,
  syncFromWebdav, deletePageWithAttachments, deleteFolderWithAttachments,
  _titleToSlug, _buildPathMap, _collectPageIds,
};
