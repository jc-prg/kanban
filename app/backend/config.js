const crypto = require('crypto');
const path   = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

const APP_PASSWORD  = process.env.APP_PASSWORD || 'kanban-pwd';
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const API_KEY       = process.env.API_KEY || '';

console.log(`App password source: ${process.env.APP_PASSWORD ? '.env / environment' : 'built-in default'}`);
console.log(`API key: ${API_KEY ? 'set' : 'not set (external API access disabled)'}`);
if (API_KEY && API_KEY.length < 32)
  console.warn('WARNING: API_KEY is shorter than 32 characters — use a strong random key in production');

const COUCHDB_HOST     = process.env.COUCHDB_HOST     || 'localhost';
const COUCHDB_PORT     = process.env.COUCHDB_PORT     || 5984;
const COUCHDB_USER     = process.env.COUCHDB_USER     || 'kanban';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'kanban-pwd';
const DB_PREFIX        = 'jc-kanban-';
const DOC_ID           = 'board';
const NOTES_DOC_ID     = 'notes';
const PROMPTS_DB_NAME  = 'jc-extension-prompts';
const BACKUP_DIR       = path.join(__dirname, '..', process.env.BACKUP_DIR || 'data');
const BACKUP_INTERVAL_MS = parseInt(process.env.BACKUP_INTERVAL_MS, 10) || 600000;
const ATTACHMENTS_DIR  = path.join(BACKUP_DIR, 'attachments');
const JSON_BACKUP_DIR  = path.join(BACKUP_DIR, 'json');
const COUCHDB_DATA_DIR = path.join(BACKUP_DIR, 'couchdb');
const LOG_API_RESPONSES   = process.env.LOG_API_RESPONSES === 'true';
const DB_SIZE_INTERVAL_MS = 15 * 60 * 1000;

module.exports = {
  PORT, HOST,
  APP_PASSWORD, SESSION_TOKEN, API_KEY,
  COUCHDB_HOST, COUCHDB_PORT, COUCHDB_USER, COUCHDB_PASSWORD,
  DB_PREFIX, DOC_ID, NOTES_DOC_ID, PROMPTS_DB_NAME,
  BACKUP_DIR, BACKUP_INTERVAL_MS, ATTACHMENTS_DIR, JSON_BACKUP_DIR, COUCHDB_DATA_DIR,
  LOG_API_RESPONSES, DB_SIZE_INTERVAL_MS,
};
