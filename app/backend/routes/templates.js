'use strict';
const express = require('express');
const router  = express.Router();

const { writeRateLimit }            = require('../auth');
const { upsertDoc }                 = require('../db');
const { getTemplatesDb }            = require('../global-db');
const { validateTemplates, schemaError } = require('../schemas');

const TEMPLATES_DOC_ID = 'templates';

async function _loadTemplates() {
  try {
    const { _id, _rev, ...data } = await getTemplatesDb().get(TEMPLATES_DOC_ID);
    return { items: [], ...data };
  } catch (err) {
    if (err.statusCode === 404) return { items: [] };
    throw err;
  }
}

// GET /api/templates
router.get('/templates', async (req, res) => {
  try {
    res.json(await _loadTemplates());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/templates
router.put('/templates', writeRateLimit, async (req, res) => {
  try {
    if (!validateTemplates(req.body))
      return res.status(400).json({ error: schemaError(validateTemplates) });

    await upsertDoc(getTemplatesDb(), TEMPLATES_DOC_ID, { items: req.body.items });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
