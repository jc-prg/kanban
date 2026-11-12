'use strict';
const { getCouch, upsertDoc } = require('./db');

const GLOBAL_DB_NAME      = 'jc-config-dashboard';
const DASHBOARD_CONFIG_ID = 'dashboard-config';

const WEBDAV_DB_NAME     = 'jc-config-webdav';
const TEMPLATES_DB_NAME  = 'jc-config-templates';
const STICKIES_DB_NAME   = 'jc-config-stickies';   // one doc per sticky (Today Stickies widget)

let globalDb;
let webdavDb;
let templatesDb;
let stickiesDb;

function getGlobalDb()    { return globalDb;    }
function getWebdavDb()    { return webdavDb;    }
function getTemplatesDb() { return templatesDb; }
function getStickiesDb()  { return stickiesDb;  }

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

  try {
    await couch.db.create(STICKIES_DB_NAME);
    console.log(`Database "${STICKIES_DB_NAME}" created`);
  } catch (err) {
    if (err.statusCode !== 412) throw err;
    console.log(`Database "${STICKIES_DB_NAME}" already exists`);
  }
  stickiesDb = couch.use(STICKIES_DB_NAME);
}

async function getDashboardConfig() {
  try {
    const { _id, _rev, ...data } = await globalDb.get(DASHBOARD_CONFIG_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return {
      mailAccounts:     [],
      calendarAccounts: [],
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

// Senders whose remote images may load in the mail view: { senders: ['lower@case.addr'] }
const MAIL_TRUSTED_ID = 'mail-trusted-senders';

async function getTrustedSenders() {
  try {
    const doc = await globalDb.get(MAIL_TRUSTED_ID);
    return Array.isArray(doc.senders) ? doc.senders : [];
  } catch (err) {
    if (err.statusCode === 404) return [];
    throw err;
  }
}

/** Add or remove one (lower-cased) sender address; returns the new list. */
async function setTrustedSender(address, trusted) {
  const list = (await getTrustedSenders()).filter(a => a !== address);
  if (trusted) list.push(address);
  await upsertDoc(globalDb, MAIL_TRUSTED_ID, { senders: list });
  return list;
}

// Mail folders hidden in the mail view's folder tree: { folders: { [accountId]: [path] } }
const MAIL_HIDDEN_ID = 'mail-hidden-folders';

async function getHiddenFolders() {
  try {
    const doc = await globalDb.get(MAIL_HIDDEN_ID);
    return doc.folders && typeof doc.folders === 'object' ? doc.folders : {};
  } catch (err) {
    if (err.statusCode === 404) return {};
    throw err;
  }
}

/** Replace the hidden folders of one account (empty list = none); returns all accounts' lists. */
async function setHiddenFolders(accountId, paths) {
  const folders = await getHiddenFolders();
  if (paths.length) folders[accountId] = paths; else delete folders[accountId];
  await upsertDoc(globalDb, MAIL_HIDDEN_ID, { folders });
  return folders;
}

const TODAY_CONFIG_ID = 'today-config';

/** "Today" page config (/today); null when none was saved yet (the route falls back to defaults). */
async function getTodayConfig() {
  try {
    const { _id, _rev, ...data } = await globalDb.get(TODAY_CONFIG_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function saveTodayConfig(data) {
  return upsertDoc(globalDb, TODAY_CONFIG_ID, data);
}

const APPEARANCE_ID = 'appearance';

/** App-wide appearance (skin); null when none was saved yet. */
async function getAppearance() {
  try {
    const { _id, _rev, ...data } = await globalDb.get(APPEARANCE_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function saveAppearance(data) {
  return upsertDoc(globalDb, APPEARANCE_ID, data);
}

// ---- Stickies (Today widget): { id, text, color, category, created, updated } ----

function _stickyOut({ _id, _rev, ...doc }) { return { id: _id, ...doc }; }

/** All stickies, newest first. */
async function listStickies() {
  const result = await stickiesDb.list({ include_docs: true });
  return result.rows
    .filter(r => !r.id.startsWith('_') && r.doc)
    .map(r => _stickyOut(r.doc))
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

/** One sticky or null. */
async function getSticky(id) {
  try {
    return _stickyOut(await stickiesDb.get(id));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function saveSticky({ id, ...data }) {
  await upsertDoc(stickiesDb, id, data);
  return { id, ...data };
}

/** false when the sticky did not exist. */
async function deleteSticky(id) {
  try {
    const { _rev } = await stickiesDb.get(id);
    await stickiesDb.destroy(id, _rev);
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

module.exports = { listStickies, getSticky, saveSticky, deleteSticky, getStickiesDb, getAppearance, saveAppearance, getTodayConfig, saveTodayConfig, getGlobalDb, getWebdavDb, getTemplatesDb, initGlobalDb, getDashboardConfig, saveDashboardConfig, getWebdavAccounts, saveWebdavAccounts, getMailAccount, getCalAccount, getRecentFolders, addRecentFolder, getMailCardLinks, addMailCardLink, getTrustedSenders, setTrustedSender, getHiddenFolders, setHiddenFolders };
