'use strict';
const { getCouch } = require('./db');

const GLOBAL_DB_NAME      = 'jc-global';
const DASHBOARD_CONFIG_ID = 'dashboard-config';

let globalDb;

function getGlobalDb() { return globalDb; }

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

module.exports = { getGlobalDb, initGlobalDb, getDashboardConfig, saveDashboardConfig };
