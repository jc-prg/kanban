'use strict';

/**
 * One-time migration of a WebDAV board from the old model (tree + content
 * mirrored in CouchDB, attachment copies on local disk) to "files on the
 * server are the truth". The old tree is kept as the document "notes-legacy"
 * when the index is first built (notes-index.js).
 *
 * - Pages whose text exists only in the DB are written to the server (also
 *   ones whose file was deleted elsewhere, unless the same text lives in
 *   another file = moved/renamed outside the app).
 * - If the DB copy is newer than the file and differs, it is saved next to it
 *   as "<name> (from Kanban).md"; the file itself is not touched.
 * - Local attachment copies missing on the server are uploaded.
 * - Legacy front matter keys are removed (see webdav-handlers.js _cleanupLegacy).
 * Idempotent: a second run finds nothing to do.
 */

const fs   = require('fs');
const path = require('path');
const fm   = require('./frontmatter');
const { ATTACH_DIR } = require('./notes-index');
const { parentOf, nameOf, joinPath } = require('./store');

const MD_TYPE = 'text/markdown; charset=utf-8';

const slug = t => String(t || 'untitled').trim().replace(/[/\\:*?"<>|\x00]/g, '_') || 'untitled';
const legacySlug = t => String(t || 'untitled').trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '_')
  .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'untitled';

function* oldPages(items, prefix = '') {
  for (const it of items || []) {
    if (it.type === 'folder') {
      const fp = String(it.wdPath || (prefix + slug(it.title) + '/')).replace(/^\/+|\/+$/g, '') + '/';
      yield* oldPages(it.children, fp);
    } else {
      const cands = [];
      if (it.wdPath) cands.push(String(it.wdPath).replace(/^\/+|\/+$/g, ''));
      cands.push(prefix + slug(it.title) + '.md', prefix + legacySlug(it.title) + '.md');
      yield [it, [...new Set(cands)]];
    }
  }
}

async function runMigration({ idx, adapter, board, attachmentsDir, dryRun = true, cleanup, fileName, unique }) {
  const report = {
    dry_run: dryRun, board, pages_in_db: 0, uploaded: [], restored: [], conflict_copies: [], moved_elsewhere: [],
    attachments_uploaded: [], frontmatter_cleaned: [], invalid_frontmatter: [],
  };
  await idx.revalidate({ full: true });
  await idx.waitFrontmatter();

  const bodies = new Map();
  for (const p of idx.allNotePaths()) {
    const b = fm.parse((await idx.read(p)).text).body.trim();
    if (!bodies.has(b)) bodies.set(b, p);
  }

  // 1. Pages of the old DB tree
  const legacy = (await adapter.loadLegacyNotes?.(board)) || {};
  for (const [page, cands] of oldPages(legacy.items)) {
    report.pages_in_db++;
    const desc = String(page.description || '');
    const p = cands.find(c => idx.exists(c));
    if (p) {
      const { text } = await idx.read(p);
      if (fm.parse(text).body.trim() === desc.trim()) continue;
      const dbTime = Date.parse(page.lastModified || ''), srv = Date.parse(idx.entry(p)?.m || '');
      if (dbTime && srv && dbTime > srv + 60000) {
        const target = unique(idx, parentOf(p), fileName(nameOf(p).replace(/\.md$/, '') + ' (from Kanban)'), '.md');
        report.conflict_copies.push(target);
        if (!dryRun) await idx.noteWritten(target, await idx.store.put(target, desc, { contentType: MD_TYPE, createOnly: true }), desc, Buffer.byteLength(desc));
      }
      continue;
    }
    if (!desc.trim()) continue;
    if (bodies.has(desc.trim())) { report.moved_elsewhere.push(`${cands[0]} → ${bodies.get(desc.trim())}`); continue; }
    const target = idx.exists(cands[0])
      ? unique(idx, parentOf(cands[0]), fileName(nameOf(cands[0]).replace(/\.md$/, '') + ' (from Kanban)'), '.md')
      : cands[0];
    report[page.wdPath ? 'restored' : 'uploaded'].push(target);
    if (!dryRun) {
      if (parentOf(target)) await idx.store.mkdirs(parentOf(target));
      await idx.noteWritten(target, await idx.store.put(target, desc, { contentType: MD_TYPE, createOnly: true }), desc, Buffer.byteLength(desc));
    }
  }

  // 2. Local attachment copies → server (same relative path)
  const base = attachmentsDir ? path.join(attachmentsDir, board) : null;
  const walk = (dir, rel = '') => {
    let out = [];
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), r));
      else if (r.split('/').includes(ATTACH_DIR)) out.push(r);
    }
    return out;
  };
  for (const rel of base ? walk(base).sort() : []) {
    if (idx.exists(rel)) continue;
    report.attachments_uploaded.push(rel);
    if (!dryRun) {
      await idx.store.mkdirs(parentOf(rel));
      const data = fs.readFileSync(path.join(base, rel));
      await idx.noteWritten(rel, await idx.store.put(rel, data), null, data.length);
    }
  }

  // 3. Legacy front matter keys
  for (const p of idx.allNotePaths()) {
    const { text, etag } = await idx.read(p);
    const note = fm.parse(text);
    if (!note.valid) {
      if (fm.LEGACY_KEYS.some(k => new RegExp(`(^|\\n)${k}:`).test(note.raw || ''))) report.invalid_frontmatter.push(p);
      continue;
    }
    if (!note.doc) continue;
    const changed = cleanup(note, nameOf(p).replace(/\.md$/i, ''));
    if (!changed.length) continue;
    report.frontmatter_cleaned.push(`${p}: ${changed.join(', ')}`);
    if (!dryRun) {
      const out = fm.render(note);
      await idx.noteWritten(p, await idx.store.put(p, out, { contentType: MD_TYPE, ifMatch: etag }), out, Buffer.byteLength(out));
    }
  }

  // 4. The old tree is no longer needed (the regular board backups still hold it)
  if (!dryRun && legacy.items?.length) await adapter.saveLegacyNotes(board, { ...legacy, items: [], migrated: new Date().toISOString() });
  return report;
}

module.exports = { runMigration };
