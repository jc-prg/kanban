'use strict';
const crypto = require('crypto');
const { DB_PREFIX, DOC_ID } = require('./config');
const { getCouch, loadBoardData, saveBoardData, upsertDoc } = require('./db');

const RT_DOC_ID = 'recurring-tasks';

// ---------------------------------------------------------------------------
// Pure date helpers
// ---------------------------------------------------------------------------

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Last day of the given month (1-based month). */
function _lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Clamp day to the number of days in that month. */
function _clampDay(year, month, day) {
  return Math.min(day, _lastDayOfMonth(year, month));
}

/** Return the timestamp (ms since epoch) of the Sunday that starts the week containing d. */
function _weekStartMs(d) {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() - copy.getUTCDay());
  copy.setUTCHours(0, 0, 0, 0);
  return copy.getTime();
}

// ---------------------------------------------------------------------------
// computeNextDueDate
// ---------------------------------------------------------------------------

/**
 * Return the next due date (YYYY-MM-DD) strictly AFTER `afterDate`, or null if
 * there are no future occurrences (endDate exceeded or schedule impossible).
 *
 * @param {object} task  - task object with recurrence, startDate, endDate
 * @param {string} afterDate - YYYY-MM-DD
 */
function computeNextDueDate(task, afterDate) {
  const { recurrence, startDate, endDate } = task;
  const { type, interval = 1 } = recurrence;

  // Clamp afterDate to just before startDate so the first result is >= startDate
  if (afterDate < startDate) afterDate = addDays(startDate, -1);

  const afterD   = new Date(afterDate   + 'T00:00:00Z');
  const startD   = new Date(startDate   + 'T00:00:00Z');
  const MS_DAY   = 86400000;
  const MS_WEEK  = 7 * MS_DAY;

  let candidate;

  // ---- daily ----
  if (type === 'daily') {
    const diff = afterD.getTime() - startD.getTime();
    if (diff < 0) {
      // afterDate is before startDate → first occurrence is startDate
      candidate = startDate;
    } else {
      const intervals = Math.floor(diff / (interval * MS_DAY));
      const d = new Date(startD);
      d.setUTCDate(d.getUTCDate() + (intervals + 1) * interval);
      candidate = d.toISOString().slice(0, 10);
    }
  }

  // ---- weekly ----
  else if (type === 'weekly') {
    const { daysOfWeek } = recurrence;
    if (!daysOfWeek || daysOfWeek.length === 0) return null;

    const startWeek = _weekStartMs(startD);
    // Walk forward from max(afterDate+1, startDate)
    const walkFrom = new Date(Math.max(afterD.getTime() + MS_DAY, startD.getTime()));
    const limit = interval * 7 + 7;

    for (let i = 0; i < limit; i++) {
      const d   = new Date(walkFrom.getTime() + i * MS_DAY);
      const wd  = d.getUTCDay();
      if (daysOfWeek.includes(wd)) {
        const weekDiff = Math.round((_weekStartMs(d) - startWeek) / MS_WEEK);
        if (weekDiff >= 0 && weekDiff % interval === 0) {
          candidate = d.toISOString().slice(0, 10);
          break;
        }
      }
    }
  }

  // ---- monthly ----
  else if (type === 'monthly') {
    const { dayOfMonth } = recurrence;
    const startMon  = startD.getUTCMonth() + 1;  // 1-based
    const startYear = startD.getUTCFullYear();
    const afterMon  = afterD.getUTCMonth() + 1;
    const afterYear = afterD.getUTCFullYear();

    const totalMonthsFromStart = (afterYear - startYear) * 12 + (afterMon - startMon);
    const cycleIdx = Math.max(0, Math.floor(totalMonthsFromStart / interval));

    for (let c = cycleIdx; c <= cycleIdx + 1; c++) {
      const totalMonths = (startMon - 1) + c * interval;  // 0-based months from Jan of startYear
      const yr = startYear + Math.floor(totalMonths / 12);
      const mo = (totalMonths % 12) + 1;                  // 1-based
      const d  = _clampDay(yr, mo, dayOfMonth);
      const cand = `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (cand > afterDate) { candidate = cand; break; }
    }
  }

  // ---- yearly ----
  else if (type === 'yearly') {
    const { dayOfMonth, month: rMonth } = recurrence;
    const startYear = startD.getUTCFullYear();
    const afterYear = afterD.getUTCFullYear();
    const cycleIdx  = Math.max(0, Math.floor((afterYear - startYear) / interval));

    for (let c = cycleIdx; c <= cycleIdx + 1; c++) {
      const yr   = startYear + c * interval;
      const d    = _clampDay(yr, rMonth, dayOfMonth);
      const cand = `${yr}-${String(rMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (cand > afterDate) { candidate = cand; break; }
    }
  }

  if (!candidate) return null;
  if (endDate && candidate > endDate) return null;
  return candidate;
}

// ---------------------------------------------------------------------------
// getDueDates
// ---------------------------------------------------------------------------

/**
 * Return all due dates in the half-open interval [from, to) as YYYY-MM-DD strings.
 * `from` is inclusive; `to` is exclusive.
 */
function getDueDates(task, from, to) {
  const dates = [];
  // First occurrence on or after `from` = next occurrence after (from - 1)
  let current = computeNextDueDate(task, addDays(from, -1));
  while (current && current < to) {
    dates.push(current);
    current = computeNextDueDate(task, current);
    if (dates.length > 400) break; // safety cap
  }
  return dates;
}

// ---------------------------------------------------------------------------
// createDueCards
// ---------------------------------------------------------------------------

/**
 * Insert one card into the target column of `boardState`.
 * When `dueDates.length > 1`, appends " (Nx missed)" to the description.
 * Returns { created: 1, skipped: 0 } or { created: 0, skipped: 1 }.
 */
async function createDueCards(db, task, dueDates, boardState) {
  if (dueDates.length === 0) return { created: 0, skipped: 0 };

  const today = new Date().toISOString().slice(0, 10);

  // Find target column (case-insensitive), then inbox fallback, then first column
  const cols = boardState.columns || [];
  const targetTitle = task.targetColumn;
  let col = cols.find(c => c.title.toLowerCase() === targetTitle.toLowerCase());
  if (!col) col = cols.find(c => c.title.toLowerCase().startsWith('inbox'));
  if (!col) col = cols[0];
  if (!col) return { created: 0, skipped: 0 };

  // Deduplication: same text + created today already in target column
  const dup = col.cards.find(c => c.text === task.card.text && c.created === today);
  if (dup) return { created: 0, skipped: 1 };

  // Build description with optional missed count suffix
  const missedCount = dueDates.length;
  const baseDesc   = task.card.description || '';
  const desc = missedCount > 1
    ? (baseDesc ? `${baseDesc} (${missedCount}x missed)` : `(${missedCount}x missed)`)
    : baseDesc;

  const newCard = {
    id:      'id-' + crypto.randomBytes(6).toString('hex'),
    text:    task.card.text,
    created: today,
    ...(desc                ? { description: desc }           : {}),
    ...(task.card.color     ? { color:       task.card.color } : {}),
    ...(task.card.priority  ? { priority:    task.card.priority } : {}),
    ...(task.card.link      ? { link:        task.card.link }  : {}),
  };

  col.cards.push(newCard);
  await saveBoardData(db, boardState);
  return { created: 1, skipped: 0 };
}

// ---------------------------------------------------------------------------
// runRecurringCheck
// ---------------------------------------------------------------------------

async function runRecurringCheck() {
  const couch = getCouch();
  if (!couch) return;

  const today     = new Date().toISOString().slice(0, 10);
  const lookback  = addDays(today, -30);

  let allDbs;
  try {
    allDbs = await couch.db.list();
  } catch (err) {
    console.error('[recurring] Could not list databases:', err.message);
    return;
  }

  const boardDbs = allDbs.filter(n => n.startsWith(DB_PREFIX));

  for (const dbName of boardDbs) {
    const db = couch.use(dbName);

    let rtDoc;
    try {
      rtDoc = await db.get(RT_DOC_ID);
    } catch (err) {
      if (err.statusCode === 404) continue;
      console.error(`[recurring] ${dbName}: error loading doc:`, err.message);
      continue;
    }

    if (!Array.isArray(rtDoc.tasks) || rtDoc.tasks.length === 0) continue;

    let changed = false;

    for (const task of rtDoc.tasks) {
      if (!task.enabled) continue;
      if (!task.nextDueDate || task.nextDueDate > today) continue;

      try {
        const from = task.lastCreatedDate
          ? addDays(task.lastCreatedDate, 1)
          : task.startDate;
        const effectiveFrom = from < lookback ? lookback : from;
        const dueDates = getDueDates(task, effectiveFrom, addDays(today, 1));
        if (dueDates.length === 0) continue;

        const boardState = await loadBoardData(db);
        const { created } = await createDueCards(db, task, dueDates, boardState);

        if (created > 0) {
          task.lastCreatedDate = today;
          task.nextDueDate     = computeNextDueDate(task, today);
          changed = true;
          console.log(`[recurring] ${dbName}: created card for "${task.card.text}" (${dueDates.length} due date(s))`);
        }
      } catch (err) {
        console.error(`[recurring] ${dbName} task "${task.id}":`, err.message);
      }
    }

    if (changed) {
      try {
        await upsertDoc(db, RT_DOC_ID, { tasks: rtDoc.tasks });
      } catch (err) {
        console.error(`[recurring] ${dbName}: failed to save updated tasks:`, err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function _msUntilMidnight() {
  const now      = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight - now;
}

function initRecurring() {
  runRecurringCheck().catch(err => console.error('[recurring] Initial check failed:', err.message));
  setTimeout(() => {
    runRecurringCheck().catch(err => console.error('[recurring] Scheduled check failed:', err.message));
    setInterval(
      () => runRecurringCheck().catch(err => console.error('[recurring] Scheduled check failed:', err.message)),
      24 * 60 * 60 * 1000
    );
  }, _msUntilMidnight());
}

module.exports = {
  addDays,
  computeNextDueDate,
  getDueDates,
  createDueCards,
  runRecurringCheck,
  initRecurring,
};
