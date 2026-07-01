'use strict'
const path    = require('path')
const express = require('express')

const DB_MODULE          = path.resolve(__dirname, '../../backend/db.js')
const BACKUP_MODULE      = path.resolve(__dirname, '../../backend/backup.js')
const GLOBAL_DB_MODULE   = path.resolve(__dirname, '../../backend/global-db.js')
const DASHBOARD_ROUTE    = path.resolve(__dirname, '../../backend/routes/dashboard.js')
const CALENDAR_MODULE    = path.resolve(__dirname, '../../backend/dashboard/calendar.js')
const MAIL_MODULE        = path.resolve(__dirname, '../../backend/dashboard/mail.js')

/**
 * Creates a test Express app.
 *
 * @param {object} [dbMock]  Optional plain object to inject as the db module.
 *   Pass this before any route modules are loaded — the function pokes it into
 *   require.cache so subsequent require('../db') calls inside routes get the
 *   mock instead of the real CouchDB client.
 */
function createApp(dbMock) {
  if (dbMock) {
    require.cache[DB_MODULE] = {
      id:       DB_MODULE,
      filename: DB_MODULE,
      loaded:   true,
      exports:  dbMock,
      children: [],
      paths:    [],
    }
  }

  // Stub global-db if the test hasn't already injected its own mock.
  if (!require.cache[GLOBAL_DB_MODULE]) {
    require.cache[GLOBAL_DB_MODULE] = {
      id: GLOBAL_DB_MODULE, filename: GLOBAL_DB_MODULE, loaded: true,
      exports: {
        getDashboardConfig:  async () => ({ mailAccounts: [], cardSources: [], calendarAccounts: [], autoRefreshMs: 0 }),
        saveDashboardConfig: async () => ({ ok: true }),
        initGlobalDb:        async () => {},
        getGlobalDb:         () => ({}),
        getWebdavDb:         () => ({
          get:    async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }) },
          insert: async (doc) => ({ ok: true, id: doc._id, rev: '1-abc' }),
        }),
      },
      children: [], paths: [],
    }
  }

  // Always stub backup.js — tests never need real CouchDB backup logic.
  if (!require.cache[BACKUP_MODULE]) {
    require.cache[BACKUP_MODULE] = {
      id: BACKUP_MODULE, filename: BACKUP_MODULE, loaded: true,
      exports: {
        getDbSizeBytes:      () => 0,
        runBackup:           async () => {},
        checkDataDirectories: () => {},
        refreshDbSize:       () => {},
      },
      children: [], paths: [],
    }
  }

  const app = express()
  app.use(express.json({ limit: '10mb' }))

  const { authenticate } = require('../../backend/auth')
  app.use('/api', authenticate)
  app.use('/api', require('../../backend/routes/auth'))
  app.use('/api', require('../../backend/routes/boards'))
  app.use('/api', require('../../backend/routes/board'))
  app.use('/api', require('../../backend/routes/notes'))
  app.use('/api', require('../../backend/routes/attachments'))
  app.use('/api', require('../../backend/routes/dashboard'))

  return app
}

/**
 * Remove all route + db modules from require.cache so that the next
 * createApp() call loads fresh instances (useful between test files).
 */
function clearAppCache() {
  const toDelete = [
    DB_MODULE,
    BACKUP_MODULE,
    path.resolve(__dirname, '../../backend/auth.js'),
    path.resolve(__dirname, '../../backend/config.js'),
    path.resolve(__dirname, '../../backend/schemas.js'),
    path.resolve(__dirname, '../../backend/routes/auth.js'),
    path.resolve(__dirname, '../../backend/routes/boards.js'),
    path.resolve(__dirname, '../../backend/routes/board.js'),
    path.resolve(__dirname, '../../backend/routes/notes.js'),
    path.resolve(__dirname, '../../backend/routes/attachments.js'),
    GLOBAL_DB_MODULE,
    DASHBOARD_ROUTE,
    CALENDAR_MODULE,
    MAIL_MODULE,
  ]
  toDelete.forEach(p => { delete require.cache[p] })
}

module.exports = { createApp, clearAppCache }
