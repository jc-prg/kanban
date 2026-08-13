'use strict';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function _sanitize(val) {
  if (Array.isArray(val)) return val.map(_sanitize);
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val)
        .filter(([k]) => !DANGEROUS_KEYS.has(k))
        .map(([k, v]) => [k, _sanitize(v)])
    );
  }
  return val;
}

async function _upsertDoc(db, id, data) {
  let rev;
  try { ({ _rev: rev } = await db.get(id)); } catch { /* new doc */ }
  return db.insert({ _id: id, ...(rev ? { _rev: rev } : {}), ..._sanitize(data) });
}

// ---------------------------------------------------------------------------
// v1 → v2 migration for notes schema
// ---------------------------------------------------------------------------

function _migrateV1ToV2(data) {
  if (!data || data.schemaVersion === 2) return data;
  // v1 has a pages array (flat list of pages/folders with nested structure)
  // Convert to v2 items array
  if (Array.isArray(data.pages)) {
    return { schemaVersion: 2, items: data.pages };
  }
  return data;
}

// ---------------------------------------------------------------------------
// CouchDB adapter
// ---------------------------------------------------------------------------

/**
 * CouchDB-backed StorageAdapter for notes-webdav.
 *
 * @param {object}   options
 * @param {function} options.getCouch               - () => nano.ServerScope (called lazily)
 * @param {function} [options.getBoardDb]           - async (boardName) => nano.DocumentScope — override for tests/DI
 * @param {function} [options.getWebdavDb]          - () => nano.DocumentScope — override for tests/DI
 * @param {function} [options.getWebdavAccountsFn]  - async () => accounts[] — override for tests/DI
 * @param {function} [options.saveWebdavAccountsFn] - async (accounts) => void — override for tests/DI
 * @param {string}   [options.dbPrefix]             - Board DB prefix, default 'jc-kanban-'
 * @param {string}   [options.webdavDbName]         - DB for WebDAV config, default 'jc-config-webdav'
 * @param {string}   [options.notesDocId]           - Document _id for notes per board, default 'notes'
 * @param {boolean}  [options.autoCreateWebdavDb]   - Create webdav DB lazily on first use, default true
 */
class CouchDbAdapter {
  constructor({ getCouch, getBoardDb, getWebdavDb, getWebdavAccountsFn, saveWebdavAccountsFn, dbPrefix = 'jc-kanban-', webdavDbName = 'jc-config-webdav', notesDocId = 'notes', autoCreateWebdavDb = true }) {
    this._getCouch              = getCouch;
    this._getBoardDbFn          = getBoardDb || null;           // optional DI override
    this._getWebdavDbFn         = getWebdavDb || null;          // optional DI override
    this._getWebdavAccountsFn   = getWebdavAccountsFn || null;  // optional DI override
    this._saveWebdavAccountsFn  = saveWebdavAccountsFn || null; // optional DI override
    this._dbPrefix         = dbPrefix;
    this._webdavDbName     = webdavDbName;
    this._notesDocId       = notesDocId;
    this._autoCreateWebdavDb = autoCreateWebdavDb;
    this._webdavDb         = null;
  }

  async _getBoardDb(boardName) {
    if (this._getBoardDbFn) return this._getBoardDbFn(boardName);
    return this._getCouch().use(this._dbPrefix + boardName);
  }

  async _getWebdavDb() {
    // If an explicit getter was injected (e.g. from tests / global-db), use it every time.
    if (this._getWebdavDbFn) return this._getWebdavDbFn();
    if (this._webdavDb) return this._webdavDb;
    const couch = this._getCouch();
    if (this._autoCreateWebdavDb) {
      try {
        await couch.db.create(this._webdavDbName);
      } catch (err) {
        if (err.statusCode !== 412) throw err;
      }
    }
    this._webdavDb = couch.use(this._webdavDbName);
    return this._webdavDb;
  }

  // ---- Notes document ----

  async loadNotes(boardName) {
    const db = await this._getBoardDb(boardName);
    try {
      const { _id, _rev, ...data } = await db.get(this._notesDocId);
      return _migrateV1ToV2(data) || { items: [], schemaVersion: 2 };
    } catch (err) {
      if (err.statusCode === 404) return { items: [], schemaVersion: 2 };
      throw err;
    }
  }

  async loadNotesWithRev(boardName) {
    const db = await this._getBoardDb(boardName);
    try {
      const { _id, _rev, ...data } = await db.get(this._notesDocId);
      return { data: _migrateV1ToV2(data) || { items: [], schemaVersion: 2 }, rev: _rev };
    } catch (err) {
      if (err.statusCode === 404) return { data: { items: [], schemaVersion: 2 }, rev: null };
      throw err;
    }
  }

  async saveNotes(boardName, data) {
    const db = await this._getBoardDb(boardName);
    const result = await _upsertDoc(db, this._notesDocId, data);
    return { rev: result.rev };
  }

  // ---- Per-board WebDAV config ----

  async _loadBoardWebdavDoc(boardName) {
    const db = await this._getWebdavDb();
    try {
      const { _id, _rev, ...data } = await db.get(boardName);
      return { _rev, ...data };
    } catch (err) {
      if (err.statusCode === 404) return {};
      throw err;
    }
  }

  async loadWebdavConfig(boardName) {
    const doc = await this._loadBoardWebdavDoc(boardName);
    const { _rev, ...safe } = doc;
    return safe;
  }

  async saveWebdavConfig(boardName, cfg) {
    const db = await this._getWebdavDb();
    const doc = await this._loadBoardWebdavDoc(boardName);
    const rev = doc._rev;
    await db.insert({ _id: boardName, ...(rev ? { _rev: rev } : {}), ..._sanitize(cfg) });
  }

  /** Resolve effective { enabled, url, user, password } for HTTP requests. */
  async resolveWebdavCfg(boardName) {
    const doc = await this._loadBoardWebdavDoc(boardName);
    if (!doc.enabled) return { enabled: false, url: '', user: '', password: '' };

    // New format: accountId + optional subfolder
    if (doc.accountId) {
      const accounts = await this.loadWebdavAccounts();
      const account  = accounts.find(a => a.id === doc.accountId);
      if (!account) return { enabled: false, url: '', user: '', password: '' };
      const base      = account.url.endsWith('/') ? account.url : account.url + '/';
      const subfolder = (doc.subfolder || '').replace(/^\/|\/$/g, '');
      const url       = subfolder ? base + subfolder + '/' : base;
      return { enabled: true, url, user: account.user || '', password: account.password || '' };
    }

    // Legacy inline format
    return { enabled: true, url: doc.url || '', user: doc.user || '', password: doc.password || '' };
  }

  // ---- Global WebDAV accounts ----

  async loadWebdavAccounts() {
    if (this._getWebdavAccountsFn) return this._getWebdavAccountsFn();
    const db = await this._getWebdavDb();
    try {
      const { accounts } = await db.get('accounts');
      return Array.isArray(accounts) ? accounts : [];
    } catch (err) {
      if (err.statusCode === 404) return [];
      throw err;
    }
  }

  async saveWebdavAccounts(accounts) {
    if (this._saveWebdavAccountsFn) return this._saveWebdavAccountsFn(accounts);
    const db = await this._getWebdavDb();
    await _upsertDoc(db, 'accounts', { accounts });
  }
}

module.exports = CouchDbAdapter;
