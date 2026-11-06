'use strict';
const { getCouch, upsertDoc } = require('./db');

const GLOBAL_DB_NAME      = 'jc-config-dashboard';
const DASHBOARD_CONFIG_ID = 'dashboard-config';

const WEBDAV_DB_NAME     = 'jc-config-webdav';
const TEMPLATES_DB_NAME  = 'jc-config-templates';

let globalDb;
let webdavDb;
let templatesDb;

function getGlobalDb()    { return globalDb;    }
function getWebdavDb()    { return webdavDb;    }
function getTemplatesDb() { return templatesDb; }

async function initGlobalDb() {
  const couch = getCouch();

  try {
    await couch.db.create(GLOBAL_DB_NAME);
    console.log(`Database "${GLOBAL_DB_NAME}" created`);
  } catch (err) {
    if (err.statusCode !== 412) throw err;
    console.log(`Database "${GLOBAL_DB_NAME}" already exists`);
  }
  globalDb = couch.use(GLOBAL_DB_NAME);

  try {
    await couch.db.create(WEBDAV_DB_NAME);
    console.log(`Database "${WEBDAV_DB_NAME}" created`);
  } catch (err) {
    if (err.statusCode !== 412) throw err;
    console.log(`Database "${WEBDAV_DB_NAME}" already exists`);
  }
  webdavDb = couch.use(WEBDAV_DB_NAME);

  try {
    await couch.db.create(TEMPLATES_DB_NAME);
    console.log(`Database "${TEMPLATES_DB_NAME}" created`);
  } catch (err) {
    if (err.statusCode !== 412) throw err;
    console.log(`Database "${TEMPLATES_DB_NAME}" already exists`);
  }
  templatesDb = couch.use(TEMPLATES_DB_NAME);
}

async function getDashboardConfig() {
  try {
    const { _id, _rev, ...data } = await globalDb.get(DASHBOARD_CONFIG_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return {
      mailAccounts:     [],
      cardSources:      [],
      calendarAccounts: [],
      autoRefreshMs:    0,
    };
    throw err;
  }
}

async function saveDashboardConfig(data) {
  return upsertDoc(globalDb, DASHBOARD_CONFIG_ID, data);
}

const WEBDAV_ACCOUNTS_ID = 'accounts';

async function getWebdavAccounts() {
  try {
    const { accounts } = await webdavDb.get(WEBDAV_ACCOUNTS_ID);
    return Array.isArray(accounts) ? accounts : [];
  } catch (err) {
    if (err.statusCode === 404) return [];
    throw err;
  }
}

async function saveWebdavAccounts(accounts) {
  return upsertDoc(webdavDb, WEBDAV_ACCOUNTS_ID, { accounts });
}

async function getMailAccount(accountId) {
  const config = await getDashboardConfig();
  return (config.mailAccounts || []).find(a => a.id === accountId) || null;
}

async function getCalAccount(accountId) {
  const config = await getDashboardConfig();
  return (config.calendarAccounts || []).find(a => a.id === accountId) || null;
}

const RECENT_FOLDERS_ID = 'mail-recent-folders';

async function getRecentFolders() {
  try {
    const { _id, _rev, ...data } = await globalDb.get(RECENT_FOLDERS_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return {};
    throw err;
  }
}

async function addRecentFolder(accountId, folder) {
  const current = await getRecentFolders();
  const list = Array.isArray(current[accountId]) ? current[accountId] : [];
  current[accountId] = [folder, ...list.filter(f => f !== folder)].slice(0, 3);
  return upsertDoc(globalDb, RECENT_FOLDERS_ID, current);
}

// Mail → card links, keyed by Message-ID (stable across folder moves, unlike IMAP UIDs):
// { [accountId]: { [messageId]: [{ board, cardId }] } }
const MAIL_CARD_LINKS_ID = 'mail-card-links';

async function _getMailCardLinksDoc() {
  try {
    const { _id, _rev, ...data } = await globalDb.get(MAIL_CARD_LINKS_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return {};
    throw err;
  }
}

/** Links of one account: { [messageId]: [{ board, cardId }] }. */
async function getMailCardLinks(accountId) {
  const doc = await _getMailCardLinksDoc();
  return doc[accountId] && typeof doc[accountId] === 'object' ? doc[accountId] : {};
}

/** Add a card link to a message; returns false when it already existed. */
async function addMailCardLink(accountId, messageId, board, cardId) {
  const doc  = await _getMailCardLinksDoc();
  const acc  = doc[accountId] && typeof doc[accountId] === 'object' ? doc[accountId] : {};
  const list = Array.isArray(acc[messageId]) ? acc[messageId] : [];
  if (list.some(r => r.board === board && r.cardId === cardId)) return false;
  acc[messageId] = [...list, { board, cardId }];
  doc[accountId] = acc;
  await upsertDoc(globalDb, MAIL_CARD_LINKS_ID, doc);
  return true;
}

module.exports = { getGlobalDb, getWebdavDb, getTemplatesDb, initGlobalDb, getDashboardConfig, saveDashboardConfig, getWebdavAccounts, saveWebdavAccounts, getMailAccount, getCalAccount, getRecentFolders, addRecentFolder, getMailCardLinks, addMailCardLink };
