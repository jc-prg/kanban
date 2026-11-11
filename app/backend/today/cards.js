'use strict';
// "Today" provider: date-relevant cards across all active (non-archived) boards.
const { getCouch }         = require('../db');
const { DB_PREFIX, DOC_ID } = require('../config');

const MAX_PER_LIST = 50;

function _addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function _item(board, col, card) {
  const { id, text, priority, color, startDate, endDate, done, description, link, unread, mailRef, calEvent, created } = card;
  return {
    board, column: col.title,
    card: { id, text, priority, color, startDate, endDate, done, description: !!description, link: link || '',
            unread: !!unread, hasMailRef: !!mailRef, hasCalEvent: !!calEvent, created },
  };
}

/**
 * Sort cards of one board document into the "Today" lists.
 * `today` is the client's local date (YYYY-MM-DD) — the server may run in UTC.
 */
function classifyBoardCards(board, doc, today, out) {
  const tomorrow = _addDays(today, 1);
  const weekEnd  = _addDays(today, 6);   // 7 days incl. today
  for (const col of doc.columns || []) {
    for (const card of col.cards || []) {
      if ((card.text || '').startsWith('#')) continue;   // section headers
      if (card.unread) out.unread.push(_item(board, col, card));
      if (card.done) continue;
      if (card.endDate) {
        if (card.endDate < today)          out.overdue.push(_item(board, col, card));
        else if (card.endDate === today)   out.dueToday.push(_item(board, col, card));
        else if (card.endDate === tomorrow) out.dueTomorrow.push(_item(board, col, card));
      }
      if (card.endDate > today && card.endDate <= weekEnd) out.dueWeek.push(_item(board, col, card));
      if (card.startDate === today && card.endDate !== today) out.startsToday.push(_item(board, col, card));
      if (card.startDate > today && card.startDate <= weekEnd && card.endDate !== card.startDate) out.startsWeek.push(_item(board, col, card));
    }
  }
}

async function fetchTodayCards(today) {
  const couch  = getCouch();
  const dbs    = await couch.db.list();
  const boards = dbs.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
  // dueWeek / startsWeek: tomorrow … today + 6 (agenda in 7-day mode)
  const out = { overdue: [], dueToday: [], startsToday: [], dueTomorrow: [], dueWeek: [], startsWeek: [], unread: [] };
  await Promise.allSettled(boards.map(async board => {
    const doc = await couch.use(DB_PREFIX + board).get(DOC_ID);
    if (doc.settings?.archived) return;
    classifyBoardCards(board, doc, today, out);
  }));
  const byDate = key => (a, b) => (a.card[key] || '').localeCompare(b.card[key] || '') || (a.card.priority || 9) - (b.card.priority || 9);
  out.overdue.sort(byDate('endDate'));
  for (const k of ['dueToday', 'startsToday', 'dueTomorrow']) out[k].sort((a, b) => (a.card.priority || 9) - (b.card.priority || 9));
  out.dueWeek.sort(byDate('endDate'));
  out.startsWeek.sort(byDate('startDate'));
  out.unread.sort((a, b) => (b.card.created || '').localeCompare(a.card.created || ''));
  const counts = {};
  for (const k of Object.keys(out)) { counts[k] = out[k].length; out[k] = out[k].slice(0, MAX_PER_LIST); }
  return { ...out, counts, date: today };
}

module.exports = { fetchTodayCards, classifyBoardCards, cardItem: _item };
