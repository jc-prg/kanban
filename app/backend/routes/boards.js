const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { writeRateLimit }                          = require('../auth');
const { getCouch, validBoardName, getBoardDb, loadBoardData } = require('../db');
const { DB_PREFIX, DOC_ID, ATTACHMENTS_DIR }      = require('../config');

function getBoardAttachStats(name) {
  const boardDir = path.join(ATTACHMENTS_DIR, name);
  let count = 0, size = 0;
  if (!fs.existsSync(boardDir)) return { count, size };
  for (const sub of fs.readdirSync(boardDir)) {
    const subDir = path.join(boardDir, sub);
    try {
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const file of fs.readdirSync(subDir).filter(n => !n.startsWith('.'))) {
        count++;
        size += fs.statSync(path.join(subDir, file)).size;
      }
    } catch {}
  }
  return { count, size };
}

router.get('/boards', async (req, res) => {
  try {
    const couch = getCouch();
    const all = await couch.db.list();
    const names = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length)).sort();
    const boards = await Promise.all(names.map(async name => {
      try {
        const data = await loadBoardData(couch.use(DB_PREFIX + name));
        const visibleCards    = col => col.cards.filter(c => !c.text?.startsWith('#'));
        const totalCards      = data.columns.reduce((s, c) => s + visibleCards(c).length, 0);
        const inboxCount      = data.columns.filter(c => /^inbox/i.test(c.title)).reduce((s, c) => s + visibleCards(c).length, 0);
        const todoCount       = data.columns.filter(c => /^todo/i.test(c.title)).reduce((s, c) => s + visibleCards(c).length, 0);
        const inProgressCount = data.columns.filter(c => /^in.?progress/i.test(c.title) || /^doing$/i.test(c.title)).reduce((s, c) => s + visibleCards(c).length, 0);
        const trackedCounts   = (data.settings?.trackedColumns || []).map(title => {
          const col = data.columns.find(c => c.title === title);
          return col ? { title, count: visibleCards(col).length, color: col.color || null } : null;
        }).filter(Boolean);
        const { count: attachCount, size: attachSize } = getBoardAttachStats(name);
        return { name, description: data.settings?.description || '', archived: data.settings?.archived || false, totalCards, inboxCount, todoCount, inProgressCount, trackedCounts, attachCount, attachSize };
      } catch (e) {
        return { name, description: '', totalCards: 0, inboxCount: 0, todoCount: 0, inProgressCount: 0, trackedCounts: [], attachCount: 0, attachSize: 0 };
      }
    }));
    res.json(boards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/achievements/range', async (req, res) => {
  try {
    const to   = req.query.to || new Date().toISOString().slice(0, 10);
    const fromD = new Date(to + 'T00:00:00Z');
    fromD.setUTCDate(fromD.getUTCDate() - 27);
    const from = req.query.from || fromD.toISOString().slice(0, 10);

    const couch = getCouch();
    const all   = await couch.db.list();
    const names = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));

    // Build per-day buckets for the requested range
    const days = {};
    const cur = new Date(from + 'T00:00:00Z');
    const end = new Date(to   + 'T00:00:00Z');
    while (cur <= end) {
      days[cur.toISOString().slice(0, 10)] = { created: 0, inboxCreated: 0, moved: 0, done: 0 };
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    let hasBefore = false;

    await Promise.all(names.map(async name => {
      try {
        const data = await loadBoardData(couch.use(DB_PREFIX + name));
        if (data.settings?.archived) return;
        for (const col of data.columns) {
          for (const card of col.cards) {
            if (card.created) {
              const cDate = card.created.slice(0, 10);
              if (cDate < from) hasBefore = true;
              if (days[cDate]) {
                days[cDate].created++;
                const isInbox = /^inbox/i.test(col.title) || card.moves?.some(m => /^inbox/i.test(m.from));
                if (isInbox) days[cDate].inboxCreated++;
              }
            }
            for (const m of (card.moves || [])) {
              if (!m.at) continue;
              const mDate = m.at.slice(0, 10);
              if (mDate < from) hasBefore = true;
              if (days[mDate]) days[mDate].moved++;
            }
            const doneAt = card.doneAt;
            const doneMoves = !doneAt ? (card.moves || []).filter(m => m.at && /^done/i.test(m.to)) : [];
            const doneDate = doneAt
              ? doneAt.slice(0, 10)
              : doneMoves.length ? doneMoves[doneMoves.length - 1].at.slice(0, 10) : null;
            if (doneDate) {
              if (doneDate < from) hasBefore = true;
              if (days[doneDate]) days[doneDate].done++;
            }
          }
        }
      } catch (e) { /* skip broken boards */ }
    }));

    const result = Object.entries(days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, c]) => ({ date, ...c }));

    res.json({ days: result, hasBefore });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/achievements/today', async (req, res) => {
  try {
    const today = req.query.date || new Date().toISOString().slice(0, 10);
    const couch = getCouch();
    const all   = await couch.db.list();
    const names = all.filter(n => n.startsWith(DB_PREFIX)).map(n => n.slice(DB_PREFIX.length));
    let created = 0, moved = 0, done = 0, inboxCreated = 0, hasPast = false;
    const createdBoards = {}, movedBoards = {}, doneBoards = {}, inboxCreatedBoards = {};
    await Promise.all(names.map(async name => {
      try {
        const data = await loadBoardData(couch.use(DB_PREFIX + name));
        if (data.settings?.archived) return;
        for (const col of data.columns) {
          for (const card of col.cards) {
            if (card.created?.startsWith(today)) {
              created++;
              createdBoards[name] = (createdBoards[name] || 0) + 1;
              const isInbox = /^inbox/i.test(col.title) || card.moves?.some(m => /^inbox/i.test(m.from));
              if (isInbox) { inboxCreated++; inboxCreatedBoards[name] = (inboxCreatedBoards[name] || 0) + 1; }
            }
            if (card.moves?.some(m => m.at?.startsWith(today))) { moved++; movedBoards[name] = (movedBoards[name] || 0) + 1; }
            const donByFlag = card.doneAt?.startsWith(today);
            const doneByMove = !donByFlag && card.moves?.some(m => m.at?.startsWith(today) && /^done/i.test(m.to));
            if (donByFlag || doneByMove) { done++; doneBoards[name] = (doneBoards[name] || 0) + 1; }
            if (!hasPast) {
              if (card.created && card.created < today) hasPast = true;
              else if (card.moves?.some(m => m.at?.slice(0, 10) < today)) hasPast = true;
              else if (card.doneAt && card.doneAt.slice(0, 10) < today) hasPast = true;
              else if (card.moves?.some(m => /^done/i.test(m.to) && m.at?.slice(0, 10) < today)) hasPast = true;
            }
          }
        }
      } catch (e) { /* skip broken boards */ }
    }));
    res.json({ created, moved, done, inboxCreated, createdBoards, movedBoards, doneBoards, inboxCreatedBoards, hasPast });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/boards/:name', writeRateLimit, async (req, res) => {
  const { name } = req.params;
  if (!validBoardName(name)) return res.status(400).json({ error: 'Invalid board name. Use lowercase letters, digits and hyphens only.' });
  try {
    await getBoardDb(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/boards/:name/rename', writeRateLimit, async (req, res) => {
  const { name } = req.params;
  const { newName } = req.body;
  if (!validBoardName(name)) return res.status(400).json({ error: 'Invalid board name' });
  if (!validBoardName(newName) || newName.length > 12)
    return res.status(400).json({ error: 'Invalid new name. Use up to 12 lowercase letters, digits and hyphens.' });
  if (name === newName) return res.status(400).json({ error: 'New name is identical to current name' });
  try {
    const couch = getCouch();
    try {
      await couch.db.create(DB_PREFIX + newName);
    } catch (err) {
      if (err.statusCode === 412) return res.status(409).json({ error: 'A board with that name already exists' });
      throw err;
    }
    const data = await loadBoardData(couch.use(DB_PREFIX + name));
    await couch.use(DB_PREFIX + newName).insert({ _id: DOC_ID, ...data });
    await couch.db.destroy(DB_PREFIX + name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/boards/:name', writeRateLimit, async (req, res) => {
  const { name } = req.params;
  if (!validBoardName(name)) return res.status(400).json({ error: 'Invalid board name' });
  try {
    await getCouch().db.destroy(DB_PREFIX + name);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode === 404 ? 404 : 500).json({ error: err.message });
  }
});

module.exports = router;
