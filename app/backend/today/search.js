'use strict';
// "Today" search widget: one function per source. Title mode matches the title + subtitle of an
// element (card text / column, note title / folders, event title / location, application job
// title / company); full text adds every text field (never attachments). All words must match,
// case- and accent-insensitive. Mail searches IMAP server-side (dashboard/mail.js#searchMailAccount).
const { getCouch }                        = require('../db');
const { DB_PREFIX, DOC_ID, NOTES_DOC_ID } = require('../config');
const { cardItem }                        = require('./cards');
const { fetchApplicationList, applicationItem, publicBase } = require('./cvapp');
const { fetchRawEvents, filterRange }     = require('../dashboard/calendar');
const { searchMailAccount }               = require('../dashboard/mail');

const LIMIT       = 50;
const CAL_DAYS    = 365;              // events today − 1 year … today + 1 year
const CAL_CACHE_MS = 5 * 60 * 1000;
const CAL_MAX_DAYS = 3 * 366;          // longest window a date range may ask for (recurrences are expanded)
const MAX_DEPTH   = 8;

/** Lower-case, accents removed (same rule as frontend/search.js). */
function fold(str) {
  return String(str ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Search words of a query (folded, deduplicated, empty dropped). */
function queryWords(q) {
  return [...new Set(fold(q).split(/\s+/).filter(Boolean))];
}

/** True when every word occurs in at least one of `fields`. */
function matchesAll(fields, words) {
  const hay = fields.map(fold).join('\n');
  return words.every(w => hay.includes(w));
}

async function _boardNames() {
  const couch = getCouch();
  return (await couch.db.list()).filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
}

function _result(items) {
  return { items: items.slice(0, LIMIT), total: items.length };
}

// ---- Cards ----

async function searchCards(q, { full = false } = {}) {
  const words = queryWords(q);
  const couch = getCouch();
  const out = [];
  await Promise.allSettled((await _boardNames()).map(async board => {
    const doc = await couch.use(DB_PREFIX + board).get(DOC_ID);
    if (doc.settings?.archived) return;
    for (const col of doc.columns || []) {
      for (const card of col.cards || []) {
        if ((card.text || '').startsWith('#')) continue;   // section headers
        const fields = [card.text, col.title];
        if (full) fields.push(card.description, card.link);
        if (matchesAll(fields, words)) out.push(cardItem(board, col, card));
      }
    }
  }));
  // Open cards first, then newest
  out.sort((a, b) => (a.card.done ? 1 : 0) - (b.card.done ? 1 : 0)
    || String(b.card.created || '').localeCompare(String(a.card.created || ''))
    || a.board.localeCompare(b.board));
  return _result(out);
}

// ---- Notes ----

function _walkNotes(items, path, fn, depth = 0) {
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.id !== 'string') continue;
    if (it.type === 'folder' && depth < MAX_DEPTH) _walkNotes(it.children, [...path, it.title || ''], fn, depth + 1);
    else if (it.type === 'page') fn(it, path);
  }
}

async function searchNotes(q, { full = false } = {}) {
  const words = queryWords(q);
  const couch = getCouch();
  const out = [];
  await Promise.allSettled((await _boardNames()).map(async board => {
    const db = couch.use(DB_PREFIX + board);
    const [boardRes, notesRes] = await Promise.allSettled([db.get(DOC_ID), db.get(NOTES_DOC_ID)]);
    if (boardRes.status !== 'fulfilled' || boardRes.value.settings?.archived) return;
    if (notesRes.status !== 'fulfilled') return;
    _walkNotes(notesRes.value.items, [], (page, path) => {
      const fields = [page.title, ...path];
      if (full) fields.push(page.description, page.link);
      if (matchesAll(fields, words)) {
        out.push({ board, id: page.id, title: page.title || '', path,
          ...(page.lastModified ? { lastModified: page.lastModified } : {}) });
      }
    });
  }));
  out.sort((a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || '')) || a.title.localeCompare(b.title));
  return _result(out);
}

// ---- Calendar events ----

const _calCache = new Map();   // "<accountId>|<range>" → { key, at, events }
const DAY_MS = 86_400_000;

function _clearCalCache() { _calCache.clear(); }

/** UTC midnight of a YYYY-MM-DD day. */
function _utcDay(ymd) { return new Date(`${ymd}T00:00:00Z`); }

/**
 * Search window: today ± CAL_DAYS by default; `from` / `to` (YYYY-MM-DD, both inclusive) replace
 * either end — an open end lies CAL_DAYS beyond today or the given end (whichever is further out),
 * at most CAL_MAX_DAYS from the given end. Pure — exported for tests.
 */
function eventRange({ from, to } = {}, now = Date.now()) {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let start = from ? _utcDay(from).getTime() : null;
  let end   = to ? _utcDay(to).getTime() + DAY_MS : null;
  if (start === null) start = end === null ? today - CAL_DAYS * DAY_MS
    : Math.max(Math.min(today, end - DAY_MS) - CAL_DAYS * DAY_MS, end - CAL_MAX_DAYS * DAY_MS);
  if (end === null) end = from ? Math.min(Math.max(today, start) + (CAL_DAYS + 1) * DAY_MS, start + CAL_MAX_DAYS * DAY_MS)
    : today + (CAL_DAYS + 1) * DAY_MS;
  return { rangeStart: new Date(start), rangeEnd: new Date(end) };
}

async function _accountEvents(acc, now, range) {
  const key = `${acc.url}\0${acc.user || ''}\0${acc.calendarName || ''}`;
  const { rangeStart, rangeEnd } = range;
  const slot = `${acc.id}|${range.custom ? `${rangeStart.toISOString()}|${rangeEnd.toISOString()}` : 'default'}`;
  const hit = _calCache.get(slot);
  if (hit && hit.key === key && now - hit.at < CAL_CACHE_MS) return hit.events;
  const { events } = await fetchRawEvents(acc, undefined, { rangeStart, rangeEnd });
  const inRange = filterRange(events, rangeStart, rangeEnd);
  _calCache.set(slot, { key, at: now, events: inRange });
  return inRange;
}

/**
 * One hit per event UID: the next occurrence that has not ended, else the most recent one.
 * Pure — exported for tests.
 */
function pickOccurrences(events, now = Date.now()) {
  const byUid = new Map();
  for (const ev of events) {
    const end  = new Date(ev.end || ev.start).getTime();
    const cur  = byUid.get(ev.uid);
    if (!cur) { byUid.set(ev.uid, ev); continue; }
    const curEnd = new Date(cur.end || cur.start).getTime();
    const upcoming = end >= now, curUpcoming = curEnd >= now;
    if (upcoming && (!curUpcoming || ev.start < cur.start)) byUid.set(ev.uid, ev);
    else if (!upcoming && !curUpcoming && ev.start > cur.start) byUid.set(ev.uid, ev);
  }
  return [...byUid.values()];
}

/**
 * `accounts` = calendar accounts of the dashboard config (credentials included). Without a date
 * range one hit per event (pickOccurrences); with `from` / `to` every occurrence in the range,
 * earliest first.
 */
async function searchEvents(q, { full = false, accounts = [], now = Date.now(), from, to } = {}) {
  const words = queryWords(q);
  const custom = !!(from || to);
  const range = { ...eventRange({ from, to }, now), custom };
  if ((range.rangeEnd - range.rangeStart) / DAY_MS > CAL_MAX_DAYS) {
    throw Object.assign(new Error('Date range too long for events (max. 3 years)'), { statusCode: 400 });
  }
  const errors = [];
  const out = [];
  await Promise.all(accounts.map(async acc => {
    let events;
    try { events = await _accountEvents(acc, now, range); }
    catch (e) { errors.push(`${acc.label || acc.id}: ${e.message}`); return; }
    const hits = events.filter(ev => matchesAll(full ? [ev.title, ev.location, ev.description] : [ev.title, ev.location], words));
    for (const ev of custom ? hits : pickOccurrences(hits, now)) {
      out.push({ ...ev, accountId: acc.id, label: acc.label || '', color: acc.color || null,
        webUrl: acc.webInterfaceUrl || '', accountType: acc.type || 'caldav' });
    }
  }));
  // Upcoming first (soonest first), then past ones (most recent first)
  const end = ev => new Date(ev.end || ev.start).getTime();
  if (custom) out.sort((a, b) => new Date(a.start) - new Date(b.start));
  else out.sort((a, b) => {
    const ua = end(a) >= now, ub = end(b) >= now;
    if (ua !== ub) return ua ? -1 : 1;
    return ua ? String(a.start).localeCompare(String(b.start)) : String(b.start).localeCompare(String(a.start));
  });
  if (errors.length && !out.length && errors.length === accounts.length) throw new Error(errors.join('; '));
  return { ..._result(out), ...(errors.length ? { errors } : {}) };
}

// ---- Mail ----

/**
 * IMAP searches one word (the longest — most selective). Title mode checks all words on the
 * summary (subject, from, to, cc); in full text a hit may be in the body, which the summary
 * doesn't contain, so the IMAP result is kept as is.
 */
async function searchMail(account, q, { full = false, folder, from, to } = {}) {
  const words = queryWords(q);
  const word  = q.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  const res = await searchMailAccount(account, word, {
    full, limit: LIMIT,
    ...(folder ? { folders: [folder], perFolder: LIMIT } : {}),
    ...(from ? { since: _utcDay(from) } : {}),
    ...(to ? { before: new Date(_utcDay(to).getTime() + DAY_MS) } : {}),
    accept: full ? () => true : s => matchesAll([s.subject, s.from, s.to, s.cc], words),
  });
  return { items: res.messages, total: res.total, ...(res.truncated ? { truncated: true } : {}) };
}

// ---- Applications (CV-App) ----

const _CV_FULL = ['location', 'job_description', 'fit_assessment', 'research', 'interviews', 'notes',
  'progress', 'status_note', 'salary_note', 'check_report'];

async function searchApplications(q, { full = false, settings = {} } = {}) {
  const words = queryWords(q);
  const base  = publicBase(settings.publicUrl);
  const out = (await fetchApplicationList(settings)).filter(a => {
    const fields = [a.title, a.company];
    if (full) {
      for (const k of _CV_FULL) fields.push(a[k]);
      for (const d of Array.isArray(a.drafts) ? a.drafts : []) fields.push(d?.label, d?.content);
    }
    return matchesAll(fields, words);
  });
  out.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return { ..._result(out.map(a => applicationItem(a, base))), appUrl: base };
}

module.exports = {
  searchCards, searchNotes, searchEvents, searchMail, searchApplications,
  fold, queryWords, matchesAll, pickOccurrences, eventRange, _clearCalCache, LIMIT,
};
