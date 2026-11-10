'use strict';
// "Today" provider: note page trees (titles only) of all active (non-archived) boards, from the
// CouchDB copy (WebDAV boards: as of the last sync), with a `webdav` flag per board.
const { getCouch }                        = require('../db');
const { getWebdavDb, getWebdavAccounts }  = require('../global-db');
const { DB_PREFIX, DOC_ID, NOTES_DOC_ID } = require('../config');

const MAX_DEPTH = 8;

/** Reduce a notes item tree to { type, id, title, lastModified?, children? }; counts pages in `stats`. */
function pruneNoteTree(items, stats = { pages: 0 }, depth = 0) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.id !== 'string') continue;
    if (it.type === 'folder') {
      const children = depth < MAX_DEPTH ? pruneNoteTree(it.children, stats, depth + 1) : [];
      out.push({ type: 'folder', id: it.id, title: it.title || '', children });
    } else if (it.type === 'page') {
      stats.pages++;
      out.push({ type: 'page', id: it.id, title: it.title || '', ...(it.lastModified ? { lastModified: it.lastModified } : {}) });
    }
  }
  return out;
}

/**
 * Whether the board's notes are synced with WebDAV — same rule as routes/notes.js#getWebdavConfig:
 * enabled, and (new format) its account still exists. Errors count as "no".
 */
async function _webdavEnabled(board, accounts) {
  try {
    const doc = await getWebdavDb().get(board);
    if (!doc.enabled) return false;
    return doc.accountId ? (await accounts).some(a => a.id === doc.accountId) : true;
  } catch { return false; }
}

async function fetchNoteTrees() {
  const couch  = getCouch();
  const dbs    = await couch.db.list();
  const names  = dbs.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
  const boards = [];
  const accounts = getWebdavAccounts().catch(() => []);   // loaded once, only awaited when needed
  await Promise.allSettled(names.map(async board => {
    const db = couch.use(DB_PREFIX + board);
    const [boardRes, notesRes] = await Promise.allSettled([db.get(DOC_ID), db.get(NOTES_DOC_ID)]);
    if (boardRes.status !== 'fulfilled' || boardRes.value.settings?.archived) return;
    if (notesRes.status !== 'fulfilled') return;   // board without notes
    const stats = { pages: 0 };
    const items = pruneNoteTree(notesRes.value.items, stats);
    if (stats.pages) boards.push({ board, pages: stats.pages, webdav: await _webdavEnabled(board, accounts), items });
  }));
  boards.sort((a, b) => a.board.localeCompare(b.board));
  return { boards, total: boards.reduce((n, b) => n + b.pages, 0) };
}

module.exports = { fetchNoteTrees, pruneNoteTree };
