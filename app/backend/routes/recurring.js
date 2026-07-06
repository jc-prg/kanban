'use strict';
const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();

const { writeRateLimit }                            = require('../auth');
const { withExistingBoard, loadBoardData, upsertDoc } = require('../db');
const { validateRecurringTasks, schemaError }       = require('../schemas');
const { addDays, computeNextDueDate, getDueDates, createDueCards } = require('../recurring');

const RT_DOC_ID = 'recurring-tasks';

async function _loadRtDoc(db) {
  try {
    const { _id, _rev, ...data } = await db.get(RT_DOC_ID);
    return { _rev, tasks: [], ...data };
  } catch (err) {
    if (err.statusCode === 404) return { tasks: [] };
    throw err;
  }
}

function _crossValidate(tasks) {
  for (const task of tasks) {
    const r = task.recurrence;
    if (r.type === 'weekly' && (!r.daysOfWeek || r.daysOfWeek.length === 0))
      return 'Weekly tasks must specify daysOfWeek';
    if (r.type === 'monthly' && !r.dayOfMonth)
      return 'Monthly tasks must specify dayOfMonth';
    if (r.type === 'yearly' && (!r.month || !r.dayOfMonth))
      return 'Yearly tasks must specify month and dayOfMonth';
    if (task.endDate && task.endDate < task.startDate)
      return 'endDate must be >= startDate';
  }
  return null;
}

// GET /api/:board/recurring-tasks
router.get('/:board/recurring-tasks', withExistingBoard(async (req, res, db) => {
  try {
    const doc = await _loadRtDoc(db);
    res.json({ tasks: doc.tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// PUT /api/:board/recurring-tasks
router.put('/:board/recurring-tasks', writeRateLimit, withExistingBoard(async (req, res, db) => {
  try {
    if (!validateRecurringTasks(req.body))
      return res.status(400).json({ error: schemaError(validateRecurringTasks) });

    const crossErr = _crossValidate(req.body.tasks);
    if (crossErr) return res.status(400).json({ error: crossErr });

    const tasks = req.body.tasks.map(task => {
      const id = task.id || ('rt-' + crypto.randomBytes(6).toString('hex'));
      const afterDate = task.lastCreatedDate
        ? task.lastCreatedDate
        : addDays(task.startDate, -1);
      const nextDueDate = computeNextDueDate(task, afterDate);
      return { ...task, id, nextDueDate };
    });

    await upsertDoc(db, RT_DOC_ID, { tasks });
    res.json({ ok: true, tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// POST /api/:board/recurring-tasks/:id/run
router.post('/:board/recurring-tasks/:id/run', writeRateLimit, withExistingBoard(async (req, res, db) => {
  try {
    const rtDoc = await _loadRtDoc(db);
    const task  = rtDoc.tasks.find(t => t.id === req.params.id);
    if (!task)         return res.status(404).json({ error: 'Task not found' });
    if (!task.enabled) return res.status(400).json({ error: 'task is disabled' });

    const today = new Date().toISOString().slice(0, 10);
    const from  = task.lastCreatedDate
      ? addDays(task.lastCreatedDate, 1)
      : task.startDate;
    const effectiveFrom = (from < task.startDate) ? task.startDate : from;
    let dueDates = getDueDates(task, effectiveFrom, addDays(today, 1));

    // If no due dates yet (future task), allow creating for today if startDate <= today
    if (dueDates.length === 0 && today >= task.startDate) dueDates = [today];
    if (dueDates.length === 0) return res.json({ created: 0, skipped: 1 });

    const boardState = await loadBoardData(db);
    const result     = await createDueCards(db, task, dueDates, boardState);

    if (result.created > 0) {
      task.lastCreatedDate = today;
      task.nextDueDate     = computeNextDueDate(task, today);
      await upsertDoc(db, RT_DOC_ID, { tasks: rtDoc.tasks });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

module.exports = router;
