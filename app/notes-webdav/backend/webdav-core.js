'use strict';

/**
 * Helpers for boards WITHOUT WebDAV (notes kept in CouchDB): folder prefix of a
 * page's local attachment copies and the Markdown rendering of the ZIP export.
 * WebDAV boards use store.js / notes-index.js / webdav-handlers.js instead.
 */

function _titleToSlug(title) {
  return (title || 'untitled')
    .trim()
    .replace(/[/\\:*?"<>|\0]/g, '_')
    || 'untitled';
}

// Legacy slug (used before the current algorithm) — kept for backward-compat matching
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

// Returns the folder prefix (e.g. "folder/sub/") for a page's _attachments location.
// Root-level pages return "".
function getAttachmentPrefix(page, tree) {
  const p = buildPath(page, tree);
  if (!p || !p.includes('/')) return '';
  return p.substring(0, p.lastIndexOf('/') + 1);
}

function renderMd(page, attachmentFiles = [], source = '', linkedCardEntries = null) {
  const lcEntries = linkedCardEntries ?? (page.linkedCards || []);
  const idVal = source ? `[${page.id}](${source})` : page.id;
  const lines = ['---', `id: ${yamlStr(idVal)}`, `title: ${yamlStr(page.title || '')}`];
  if (page.link)           lines.push(`link: ${yamlStr(page.link)}`);
  if (attachmentFiles.length) {
    lines.push('attachments:');
    for (const f of attachmentFiles) lines.push(`  - "[${f}](_attachments/${page.id}_${f})"`);
  }
  if (lcEntries.length) {
    lines.push('linkedCards:');
    for (const e of lcEntries) lines.push(`  - ${yamlStr(e)}`);
  }
  if (page.lastModified)   lines.push(`lastModified: ${page.lastModified}`);
  lines.push('---', '', page.description || '');
  return lines.join('\n');
}

function yamlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

module.exports = { _titleToSlug, buildPath, getAttachmentPrefix, renderMd };
