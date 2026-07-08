const fs   = require('fs');
const path = require('path');
const { JSON_BACKUP_DIR, ATTACHMENTS_DIR, COUCHDB_DATA_DIR, DB_PREFIX, NOTES_DOC_ID } = require('./config');
const { getCouch, getPromptsDb, loadBoardData } = require('./db');

let dbSizeBytes = 0;

function getDbSizeBytes() { return dbSizeBytes; }

function computeDirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += computeDirSize(full);
      else if (entry.isFile()) try { total += fs.statSync(full).size; } catch {}
    }
  } catch {}
  return total;
}

function refreshDbSize() {
  dbSizeBytes = computeDirSize(COUCHDB_DATA_DIR);
}

async function runBackup() {
  try {
    if (!fs.existsSync(JSON_BACKUP_DIR)) fs.mkdirSync(JSON_BACKUP_DIR, { recursive: true });
    const couch = getCouch();
    const all = await couch.db.list();
    const names = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
    for (const name of names) {
      try {
        const db = couch.use(DB_PREFIX + name);
        const data = await loadBoardData(db);
        fs.writeFileSync(path.join(JSON_BACKUP_DIR, `kanban-${name}-board.json`), JSON.stringify(data, null, 2), 'utf-8');
        try {
          const { _id, _rev, ...notesData } = await db.get(NOTES_DOC_ID);
          fs.writeFileSync(path.join(JSON_BACKUP_DIR, `kanban-${name}-notes.json`), JSON.stringify(notesData, null, 2), 'utf-8');
        } catch (e) { if (e.statusCode !== 404) console.error(`Notes backup for board "${name}" failed:`, e.message); }
      } catch (e) { console.error(`Backup for board "${name}" failed:`, e.message); }
    }
    if (names.length) console.log(`Backup completed for: ${names.join(', ')}`);
  } catch (err) { console.error('Backup failed:', err.message); }
}

async function runPromptsBackup() {
  try {
    const result = await getPromptsDb().list({ include_docs: true });
    const docs = result.rows
      .filter(r => !r.id.startsWith('_'))
      .map(r => { const { _id, _rev, ...doc } = r.doc; return { _id, ...doc }; });
    if (!fs.existsSync(JSON_BACKUP_DIR)) fs.mkdirSync(JSON_BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(JSON_BACKUP_DIR, 'extension-prompts.json'), JSON.stringify(docs, null, 2), 'utf-8');
    console.log('Prompts backup saved');
  } catch (err) { console.error('Prompts backup failed:', err.message); }
}

function checkDataDirectories() {
  const dirs = [JSON_BACKUP_DIR, ATTACHMENTS_DIR];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      console.error(`\nSTARTUP WARNING: Cannot write to "${dir}"`);
      console.error(`  Error: ${err.message}`);
      console.error(`  File uploads and backups will fail until this is fixed.`);
      console.error(`  Fix (Docker): run  chown -R 1000:1000 ./data  on the host.\n`);
    }
  }
}

/**
 * Delete card attachment directories that have no matching card in the board document.
 * Only removes directories older than GRACE_MS (60 min) to give the browser time to
 * save the card after uploading — including across browser crashes / tab closes.
 */
async function runOrphanAttachmentCleanup() {
  if (!ATTACHMENTS_DIR || !fs.existsSync(ATTACHMENTS_DIR)) return;
  const GRACE_MS = 60 * 60 * 1000;
  const now      = Date.now();
  try {
    const couch      = getCouch();
    const all        = await couch.db.list();
    const boardNames = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));

    for (const boardName of boardNames) {
      const boardDir = path.join(ATTACHMENTS_DIR, boardName);
      if (!fs.existsSync(boardDir)) continue;

      // Collect all real card IDs for this board
      let cardIds;
      try {
        const db = couch.use(DB_PREFIX + boardName);
        const data = await loadBoardData(db);
        cardIds = new Set((data.columns || []).flatMap(col => (col.cards || []).map(c => c.id)));
      } catch { continue; }

      // Scan for card attachment dirs (id-<hex>) not owned by any card
      let entries;
      try { entries = fs.readdirSync(boardDir, { withFileTypes: true }); } catch { continue; }

      for (const entry of entries) {
        if (!entry.isDirectory() || !/^id-[a-z0-9]{1,12}$/.test(entry.name)) continue;
        if (cardIds.has(entry.name)) continue;
        const dirPath = path.join(boardDir, entry.name);
        try {
          if (now - fs.statSync(dirPath).mtimeMs < GRACE_MS) continue;
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.log(`Cleaned up orphan card attachments: ${boardName}/${entry.name}`);
        } catch {}
      }
    }
  } catch (err) { console.error('Orphan attachment cleanup failed:', err.message); }
}

module.exports = { getDbSizeBytes, refreshDbSize, runBackup, runPromptsBackup, checkDataDirectories, runOrphanAttachmentCleanup };
