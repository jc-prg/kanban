'use strict'
const path    = require('path')
const express = require('express')

const DB_MODULE = path.resolve(__dirname, '../../backend/db.js')

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

  const app = express()
  app.use(express.json({ limit: '10mb' }))

  const { authenticate } = require('../../backend/auth')
  app.use('/api', authenticate)
  app.use('/api', require('../../backend/routes/auth'))
  app.use('/api', require('../../backend/routes/boards'))
  app.use('/api', require('../../backend/routes/board'))

  return app
}

/**
 * Remove all route + db modules from require.cache so that the next
 * createApp() call loads fresh instances (useful between test files).
 */
function clearAppCache() {
  const toDelete = [
    DB_MODULE,
    path.resolve(__dirname, '../../backend/auth.js'),
    path.resolve(__dirname, '../../backend/config.js'),
    path.resolve(__dirname, '../../backend/schemas.js'),
    path.resolve(__dirname, '../../backend/routes/auth.js'),
    path.resolve(__dirname, '../../backend/routes/boards.js'),
    path.resolve(__dirname, '../../backend/routes/board.js'),
  ]
  toDelete.forEach(p => { delete require.cache[p] })
}

module.exports = { createApp, clearAppCache }
