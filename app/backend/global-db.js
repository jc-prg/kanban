'use strict';
const { getCouch } = require('./db');

const GLOBAL_DB_NAME      = 'jc-config-dashboard';
const DASHBOARD_CONFIG_ID = 'dashboard-config';

const WEBDAV_DB_NAME = 'jc-config-webdav';

let globalDb;
let webdavDb;

function getGlobalDb()  { return globalDb;  }
function getWebdavDb()  { return webdavDb;  }

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
  let rev;
  try { ({ _rev: rev } = await globalDb.get(DASHBOARD_CONFIG_ID)); } catch (e) { /* new doc */ }
  return globalDb.insert({
    _id: DASHBOARD_CONFIG_ID,
    ...(rev ? { _rev: rev } : {}),
    ...data,
  });
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
  let rev;
  try { ({ _rev: rev } = await webdavDb.get(WEBDAV_ACCOUNTS_ID)); } catch { /* new doc */ }
  return webdavDb.insert({
    _id: WEBDAV_ACCOUNTS_ID,
    ...(rev ? { _rev: rev } : {}),
    accounts,
  });
}

module.exports = { getGlobalDb, getWebdavDb, initGlobalDb, getDashboardConfig, saveDashboardConfig, getWebdavAccounts, saveWebdavAccounts };
