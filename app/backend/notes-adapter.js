'use strict';

/**
 * Singleton CouchDB adapter for the notes-webdav module.
 * Imported by server.js (for router mounting) and routes/attachments.js
 * (for resolveWebdavCfg calls).
 */
const { CouchDbAdapter } = require('../notes-webdav/backend');
const db       = require('./db');
const globalDb = require('./global-db');

// Pass all DB accessors as functions so that test mocks of global-db / db are respected.
module.exports = new CouchDbAdapter({
  getCouch:             db.getCouch,
  getBoardDb:           (name) => db.getBoardDb(name),
  getWebdavDb:          () => globalDb.getWebdavDb(),
  getWebdavAccountsFn:  () => globalDb.getWebdavAccounts(),
  saveWebdavAccountsFn: (accounts) => globalDb.saveWebdavAccounts(accounts),
});
