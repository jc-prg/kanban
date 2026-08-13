'use strict';

/**
 * StorageAdapter — implement all methods to connect notes-webdav to any database.
 *
 * All methods are async. Errors should be thrown as plain Error objects; the
 * router catches them and returns HTTP 500.
 *
 * @interface StorageAdapter
 */

/**
 * Load the notes tree for a board.
 *
 * @function loadNotes
 * @param {string} boardName
 * @returns {Promise<{items: Array, schemaVersion: number}>} Notes document (without _id/_rev)
 */

/**
 * Load the notes document together with its current revision for optimistic locking.
 *
 * @function loadNotesWithRev
 * @param {string} boardName
 * @returns {Promise<{data: object, rev: string|null}>}
 */

/**
 * Persist the notes tree. Returns the new opaque revision string used for
 * ETag / If-Match conflict detection.
 *
 * @function saveNotes
 * @param {string} boardName
 * @param {object} data  Notes document (without _id/_rev)
 * @returns {Promise<{rev: string}>}
 */

/**
 * Load the raw per-board WebDAV config document (without credentials resolved).
 * Returns {} if no config has been saved yet.
 *
 * @function loadWebdavConfig
 * @param {string} boardName
 * @returns {Promise<object>}  e.g. { enabled, accountId, subfolder } or { enabled, url, user, password }
 */

/**
 * Persist the per-board WebDAV config document.
 *
 * @function saveWebdavConfig
 * @param {string} boardName
 * @param {object} cfg
 * @returns {Promise<void>}
 */

/**
 * Resolve a board's WebDAV config into the effective { enabled, url, user, password }
 * needed to make HTTP requests. Handles both the new accountId+subfolder format and
 * the legacy inline format.
 *
 * @function resolveWebdavCfg
 * @param {string} boardName
 * @returns {Promise<{enabled: boolean, url: string, user: string, password: string}>}
 */

/**
 * Load all global WebDAV accounts. Returns [] if none have been saved.
 *
 * @function loadWebdavAccounts
 * @returns {Promise<Array<{id: string, label: string, url: string, user: string, password: string}>>}
 */

/**
 * Persist the full global WebDAV accounts list (replace all).
 *
 * @function saveWebdavAccounts
 * @param {Array} accounts
 * @returns {Promise<void>}
 */
