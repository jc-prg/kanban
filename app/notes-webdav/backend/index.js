'use strict';

/**
 * notes-webdav — self-contained WebDAV-backed notes module for Express apps.
 *
 * Usage:
 *   const { createNotesRouter, createAccountsRouter, CouchDbAdapter } = require('./notes-webdav/backend');
 *
 *   const adapter = new CouchDbAdapter({ getCouch });
 *
 *   app.use('/api', createNotesRouter({ adapter, withBoard, withExistingBoard, ... }));
 *   app.use('/api', createAccountsRouter({ adapter, writeRateLimit }));
 *
 * See README.md for full integration guide.
 */
module.exports = {
  createNotesRouter:    require('./notes-router'),
  createAccountsRouter: require('./accounts-router'),
  CouchDbAdapter:       require('./adapters/couch'),
};
