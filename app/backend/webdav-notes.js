'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

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
    .replace(/[/\\:*?"<>|\0]/g, '_')
    || 'untitled';
}

// Legacy slug (used before the current algorithm) — kept for backward-compat matching
function _legacySlug(title) {
  return (title || 'untitled')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'untitled';
}

function _randomHex(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
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

// Build map: relPath → item.
// Items with a stored wdPath are keyed by that path (authoritative).
// Items without wdPath fall back to the current slug; legacy slugs are added
// as alias entries (and folders recurse under both prefixes) so that files
// created before the slug algorithm change are still matched.
function _buildPathMap(items, map, prefix) {
  for (const item of items) {
    if (item.type === 'folder') {
      const p = item.wdPath || (prefix + _titleToSlug(item.title) + '/');
      if (!item.wdPath) {
        const lp = prefix + _legacySlug(item.title) + '/';
        if (lp !== p) {
          map.set(lp, item);
          _buildPathMap(item.children || [], map, lp); // children under legacy prefix
        }
      }
      map.set(p, item);
      _buildPathMap(item.children || [], map, p);
    } else {
      const p = item.wdPath || (prefix + _titleToSlug(item.title) + '.md');
      if (!item.wdPath) {
        const lp = prefix + _legacySlug(item.title) + '.md';
        if (lp !== p) map.set(lp, item);
      }
      map.set(p, item);
    }
  }
}

// Returns relative WebDAV path for an item.
// Uses item.wdPath if stored; otherwise computes from tree structure,
// honouring parent folders' stored wdPaths as prefixes.
function buildPath(item, tree) {
  if (item.wdPath) return item.wdPath;
  function _find(items, prefix) {
    for (const it of items) {
      const p = it.wdPath || (prefix + _titleToSlug(it.title) + (it.type === 'folder' ? '/' : '.md'));
      if (it === item || it.id === item.id) return p;
      if (it.type === 'folder') { const r = _find(it.children || [], p); if (r) return r; }
    }
    return null;
  }
  return _find(tree, '');
}

// Recursively update wdPath on all descendants of a folder after it is
// renamed or moved (oldPrefix → newPrefix).
function _updateChildWdPaths(children, oldPrefix, newPrefix) {
  for (const item of children) {
    if (item.wdPath && item.wdPath.startsWith(oldPrefix))
      item.wdPath = newPrefix + item.wdPath.slice(oldPrefix.length);
    if (item.type === 'folder') _updateChildWdPaths(item.children || [], oldPrefix, newPrefix);
  }
}

// Returns the folder prefix (e.g. "folder/sub/") for a page's _attachments location.
// Root-level pages return "".
function getAttachmentPrefix(page, tree) {
  const p = buildPath(page, tree);
  if (!p || !p.includes('/')) return '';
  return p.substring(0, p.lastIndexOf('/') + 1);
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
  return { meta, body: m[2].replace(/^\r?\n/, '') };
}

/** Extract card IDs from linkedCards frontmatter value.
 *  Handles both the new list format (array of "title (id-xxx)" strings)
 *  and the legacy comma-separated string "id-a, id-b". */
function _parseLinkedCards(value) {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : value.split(',').map(s => s.trim());
  return entries
    .map(e => {
      const s = String(e).replace(/^"(.*)"$/, '$1'); // strip YAML quotes
      // New format: "[title](url#card:id-xxx)"
      const newFmt = s.match(/#card:(id-[a-z0-9]+)\)/);
      if (newFmt) return newFmt[1];
      // Old format: "title (id-xxx)"
      const oldFmt = s.match(/\(([^)]+)\)$/);
      if (oldFmt) return oldFmt[1];
      return s.trim();
    })
    .filter(Boolean);
}

function renderMd(page, attachmentFiles = [], source = '', linkedCardEntries = null) {
  const lcEntries = linkedCardEntries ?? (page.linkedCards || []);
  const lines = ['---', `id: ${page.id}`, `title: ${yamlStr(page.title || '')}`];
  if (source)              lines.push(`source: ${yamlStr(source)}`);
  if (page.link)           lines.push(`link: ${yamlStr(page.link)}`);
  if (lcEntries.length) {
    lines.push('linkedCards:');
    for (const e of lcEntries) lines.push(`  - ${yamlStr(e)}`);
  }
  if (page.lastModified)   lines.push(`lastModified: ${page.lastModified}`);
  if (attachmentFiles.length) {
    lines.push('attachments:');
    for (const f of attachmentFiles) lines.push(`  - "[${f}](_attachments/${page.id}_${f})"`);
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

// Find or create folder in items, returning it (mutates items if creating).
// Matching: stored wdPath first, then slug comparison against title.
// New folders get a random ID that doesn't embed the name.
function _findOrCreateFolder(items, slugSegment, wdPath) {
  let folder = wdPath
    ? items.find(it => it.type === 'folder' && it.wdPath === wdPath)
    : null;
  if (!folder)
    folder = items.find(it => it.type === 'folder' && _slugMatch(slugSegment, it.title));
  if (!folder) {
    folder = { type: 'folder', id: 'f-' + _randomHex(), title: slugSegment, children: [] };
    items.push(folder);
  }
  if (wdPath && !folder.wdPath) folder.wdPath = wdPath;
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

// Shared helper: apply a WebDAV entry's content to an existing item.
function _applyWdContent(existing, relPath, meta, body, wdEntry) {
  if (!existing.wdPath) existing.wdPath = relPath;
  existing.description    = body;
  existing.lastModified   = wdEntry.lastModified || new Date().toISOString();
  if (meta.title)         existing.title        = meta.title;
  existing.link           = meta.link || '';
  existing.linkedCards    = _parseLinkedCards(meta.linkedCards);
  existing.hasAttachments = Array.isArray(meta.attachments) ? meta.attachments.length > 0 : !!meta.attachments;
  delete existing.orphaned;
}

// Shared helper: build a new page item from a WebDAV file entry.
function _newPageFromWd(relPath, meta, body, wdEntry) {
  return {
    type:           'page',
    id:             meta.id || ('n-wd-' + _randomHex()),
    wdPath:         relPath,
    title:          meta.title || relPath.split('/').pop().replace(/\.md$/, ''),
    description:    body,
    link:           meta.link || '',
    linkedCards:    _parseLinkedCards(meta.linkedCards),
    lastModified:   wdEntry.lastModified || new Date().toISOString(),
    hasAttachments: !!meta.attachments,
  };
}

async function syncFromWebdav(cfg, tree) {
  const wdEntries = await wdPropfind(cfg, '', 'infinity');

  const wdMap = new Map();
  for (const e of wdEntries) {
    const h = e.href.replace(/^\//, '');
    if (!h || h === '' || h.split('/').includes('_attachments')) continue;
    if (h.split('/').some(seg => seg.startsWith('.'))) continue;
    if (!e.isCollection && !h.endsWith('.md')) continue;
    wdMap.set(h, e);
  }

  // Build pathMap from newTree so mutations affect the returned tree.
  const newTree = JSON.parse(JSON.stringify(tree));
  const pathMap = new Map();
  _buildPathMap(newTree.items || [], pathMap, '');

  let changed = false;
  const matchedIds = new Set();

  for (const [relPath, wdEntry] of wdMap) {
    if (wdEntry.isCollection) {
      const seg = relPath.replace(/\/$/, '');
      if (!seg.includes('/')) {
        const existing = pathMap.get(relPath);
        if (existing) {
          matchedIds.add(existing.id);
          if (!existing.wdPath) { existing.wdPath = relPath; changed = true; }
          delete existing.orphaned;
        } else {
          const folder = _findOrCreateFolder(newTree.items, seg, relPath);
          matchedIds.add(folder.id);
          // Rebuild so children of the new folder are visible in subsequent lookups.
          pathMap.clear();
          _buildPathMap(newTree.items, pathMap, '');
          changed = true;
        }
      }
      continue;
    }

    const existing = pathMap.get(relPath);
    const wdTime   = wdEntry.lastModified ? new Date(wdEntry.lastModified).getTime() : 0;

    if (existing) {
      matchedIds.add(existing.id);
      const cacheTime = existing.lastModified ? new Date(existing.lastModified).getTime() : 0;
      if (!existing.wdPath || wdTime > cacheTime) {
        try {
          const text = await wdGet(cfg, relPath);
          const { meta, body } = parseFm(text);
          _applyWdContent(existing, relPath, meta, body, wdEntry);
          changed = true;
        } catch { /* skip on error */ }
      } else {
        if (!existing.wdPath) { existing.wdPath = relPath; changed = true; }
        delete existing.orphaned;
      }
    } else {
      try {
        const text = await wdGet(cfg, relPath);
        const { meta, body } = parseFm(text);
        const newPage = _newPageFromWd(relPath, meta, body, wdEntry);
        matchedIds.add(newPage.id);
        const segments = relPath.split('/');
        if (segments.length > 1) {
          const folderSeg = segments[0];
          const folder = _findOrCreateFolder(newTree.items, folderSeg, folderSeg + '/');
          folder.children.push(newPage);
        } else {
          newTree.items.push(newPage);
        }
        changed = true;
      } catch { /* skip */ }
    }
  }

  // Mark pages absent from WebDAV as orphaned.
  function _markOrphans(items) {
    for (const item of items) {
      if (item.type !== 'folder' && !matchedIds.has(item.id)) {
        if (!item.orphaned) { item.orphaned = true; changed = true; }
      }
      if (item.type === 'folder') _markOrphans(item.children || []);
    }
  }
  _markOrphans(newTree.items);

  return { tree: newTree, changed };
}

// Shallow sync — only root-level items (folders + .md files at the root).
// Folder children are left untouched so they can be loaded lazily.
async function syncRootFromWebdav(cfg, tree) {
  const wdEntries = await wdPropfind(cfg, '', '1');

  const wdMap = new Map();
  for (const e of wdEntries) {
    const h = e.href.replace(/^\//, '');
    if (!h || h === '') continue;
    if (h.split('/').includes('_attachments')) continue;
    if (h.split('/').some(seg => seg.startsWith('.'))) continue;
    if (!e.isCollection && !h.endsWith('.md')) continue;
    wdMap.set(h, e);
  }

  const newTree = JSON.parse(JSON.stringify(tree));
  const pathMap = new Map();
  _buildPathMap(newTree.items || [], pathMap, '');

  let changed = false;
  const matchedIds = new Set();

  for (const [relPath, wdEntry] of wdMap) {
    if (wdEntry.isCollection) {
      const seg = relPath.replace(/\/$/, '');
      const existing = pathMap.get(relPath);
      if (existing) {
        matchedIds.add(existing.id);
        if (!existing.wdPath) { existing.wdPath = relPath; changed = true; }
        delete existing.orphaned;
      } else {
        const folder = _findOrCreateFolder(newTree.items, seg, relPath);
        matchedIds.add(folder.id);
        changed = true;
      }
      continue;
    }
    const existing = pathMap.get(relPath);
    const wdTime   = wdEntry.lastModified ? new Date(wdEntry.lastModified).getTime() : 0;
    if (existing) {
      matchedIds.add(existing.id);
      const cacheTime = existing.lastModified ? new Date(existing.lastModified).getTime() : 0;
      if (!existing.wdPath || wdTime > cacheTime) {
        try {
          const text = await wdGet(cfg, relPath);
          const { meta, body } = parseFm(text);
          _applyWdContent(existing, relPath, meta, body, wdEntry);
          changed = true;
        } catch { /* skip */ }
      } else if (!existing.wdPath) {
        existing.wdPath = relPath; changed = true;
      }
    } else {
      try {
        const text = await wdGet(cfg, relPath);
        const { meta, body } = parseFm(text);
        const newPage = _newPageFromWd(relPath, meta, body, wdEntry);
        matchedIds.add(newPage.id);
        newTree.items.push(newPage);
        changed = true;
      } catch { /* skip */ }
    }
  }

  // Mark root-level items absent from WebDAV as orphaned (scoped to what we queried).
  for (const item of newTree.items) {
    if (!matchedIds.has(item.id)) {
      if (!item.orphaned) { item.orphaned = true; changed = true; }
    }
  }

  return { tree: newTree, changed };
}

// Sync direct children of one folder from WebDAV (PROPFIND depth:1).
// Used when a folder is expanded in the UI.
async function syncFolderChildrenFromWebdav(cfg, tree, folderId) {
  // Locate the folder — prefer stored wdPath, fall back to computed.
  const folderItem = (() => {
    function _find(items) {
      for (const it of items) {
        if (it.id === folderId && it.type === 'folder') return it;
        if (it.type === 'folder') { const r = _find(it.children || []); if (r) return r; }
      }
      return null;
    }
    return _find(tree.items || []);
  })();
  if (!folderItem) return { tree, changed: false };

  const folderPath = buildPath(folderItem, tree.items || []);
  if (!folderPath) return { tree, changed: false };

  let wdEntries;
  try { wdEntries = await wdPropfind(cfg, folderPath, '1'); }
  catch { return { tree, changed: false }; }

  const wdMap = new Map();
  for (const e of wdEntries) {
    const h = e.href.replace(/^\//, '');
    if (!h || h === folderPath || h === folderPath.replace(/\/$/, '')) continue;
    if (h.split('/').includes('_attachments')) continue;
    if (h.split('/').some(seg => seg.startsWith('.'))) continue;
    if (!e.isCollection && !h.endsWith('.md')) continue;
    wdMap.set(h, e);
  }

  const newTree    = JSON.parse(JSON.stringify(tree));
  const newPathMap = new Map();
  _buildPathMap(newTree.items, newPathMap, '');
  const newFolderItem = newPathMap.get(folderPath);
  if (!newFolderItem) return { tree, changed: false };
  if (!newFolderItem.children) newFolderItem.children = [];

  let changed = false;
  const matchedIds = new Set();

  for (const [relPath, wdEntry] of wdMap) {
    if (wdEntry.isCollection) {
      const existing = newPathMap.get(relPath);
      if (existing) {
        matchedIds.add(existing.id);
        if (!existing.wdPath) { existing.wdPath = relPath; changed = true; }
        delete existing.orphaned;
      } else {
        const seg = relPath.replace(/\/$/, '').split('/').pop();
        const folder = _findOrCreateFolder(newFolderItem.children, seg, relPath);
        matchedIds.add(folder.id);
        newPathMap.clear();
        _buildPathMap(newTree.items, newPathMap, '');
        changed = true;
      }
      continue;
    }
    const existing = newPathMap.get(relPath);
    const wdTime   = wdEntry.lastModified ? new Date(wdEntry.lastModified).getTime() : 0;
    if (existing) {
      matchedIds.add(existing.id);
      const cacheTime = existing.lastModified ? new Date(existing.lastModified).getTime() : 0;
      if (!existing.wdPath || wdTime > cacheTime) {
        try {
          const text = await wdGet(cfg, relPath);
          const { meta, body } = parseFm(text);
          _applyWdContent(existing, relPath, meta, body, wdEntry);
          changed = true;
        } catch { /* skip */ }
      } else if (!existing.wdPath) {
        existing.wdPath = relPath; changed = true;
      }
    } else {
      try {
        const text = await wdGet(cfg, relPath);
        const { meta, body } = parseFm(text);
        const newPage = _newPageFromWd(relPath, meta, body, wdEntry);
        matchedIds.add(newPage.id);
        newFolderItem.children.push(newPage);
        newPathMap.clear();
        _buildPathMap(newTree.items, newPathMap, '');
        changed = true;
      } catch { /* skip */ }
    }
  }

  // Mark direct children of this folder absent from WebDAV as orphaned.
  for (const item of newFolderItem.children) {
    if (!matchedIds.has(item.id)) {
      if (!item.orphaned) { item.orphaned = true; changed = true; }
    }
  }

  return { tree: newTree, changed };
}

// ---------------------------------------------------------------------------
// Deletion helpers
// ---------------------------------------------------------------------------

// Returns original filenames (without the "<pageId>_" prefix) for a page's attachments.
function _listLocalAttachments(boardAttachDir, pageId, prefix = '') {
  if (!boardAttachDir) return [];
  const dir = path.join(boardAttachDir, prefix, '_attachments');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(n => !n.startsWith('.') && n.startsWith(pageId + '_'))
      .map(n => n.slice(pageId.length + 1));
  } catch { return []; }
}

async function deletePageWithAttachments(cfg, page, tree, boardAttachDir) {
  const pagePath = buildPath(page, tree);
  const prefix   = pagePath && pagePath.includes('/') ? pagePath.substring(0, pagePath.lastIndexOf('/') + 1) : '';
  if (pagePath) await wdDelete(cfg, pagePath);
  const attachFiles = _listLocalAttachments(boardAttachDir, page.id, prefix);
  for (const f of attachFiles)
    await wdDelete(cfg, `${prefix}_attachments/${page.id}_${f}`).catch(() => {});
  if (boardAttachDir) {
    for (const f of attachFiles) {
      try { fs.unlinkSync(path.join(boardAttachDir, prefix, '_attachments', `${page.id}_${f}`)); } catch { /* ok */ }
    }
  }
}

async function deleteFolderWithAttachments(cfg, folder, tree, boardAttachDir) {
  // Collect pages with their attachment prefixes before the folder is removed from the tree
  const pageInfos = [];
  function _collect(items) {
    for (const item of items) {
      if (item.type === 'page') {
        const p      = buildPath(item, tree);
        const prefix = p && p.includes('/') ? p.substring(0, p.lastIndexOf('/') + 1) : '';
        pageInfos.push({ id: item.id, prefix });
      }
      if (item.type === 'folder') _collect(item.children || []);
    }
  }
  _collect(folder.children || []);

  const folderPath = buildPath(folder, tree);
  if (folderPath) await wdDelete(cfg, folderPath); // WebDAV recursive delete covers _attachments inside

  if (boardAttachDir) {
    for (const { id, prefix } of pageInfos) {
      for (const f of _listLocalAttachments(boardAttachDir, id, prefix)) {
        try { fs.unlinkSync(path.join(boardAttachDir, prefix, '_attachments', `${id}_${f}`)); } catch { /* ok */ }
      }
    }
  }
}

module.exports = {
  wdGet, wdPut, wdPutBinary, wdDelete, wdMove, wdMkcol, wdPropfind, wdGetMeta,
  buildPath, getAttachmentPrefix, parseFm, renderMd,
  syncFromWebdav, syncRootFromWebdav, syncFolderChildrenFromWebdav,
  deletePageWithAttachments, deleteFolderWithAttachments,
  _titleToSlug, _buildPathMap, _collectPageIds, _updateChildWdPaths,
};
