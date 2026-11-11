'use strict';
const express = require('express');
const router  = express.Router();
const { writeRateLimit } = require('../auth');
const { getAppearance, saveAppearance } = require('../global-db');

// Skins the frontend knows (styles/skin-<id>.css; 'default' = no skin stylesheet rules)
const SKINS        = ['default', 'glass'];
const DEFAULT_SKIN = 'default';

router.get('/appearance', async (req, res) => {
  try {
    const stored = await getAppearance();
    const skin = SKINS.includes(stored?.skin) ? stored.skin : DEFAULT_SKIN;
    res.json({ skin, skins: SKINS });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/appearance', writeRateLimit, async (req, res) => {
  const { skin } = req.body || {};
  if (!SKINS.includes(skin)) return res.status(400).json({ error: `skin must be one of: ${SKINS.join(', ')}` });
  try {
    await saveAppearance({ skin });
    res.json({ ok: true, skin });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.SKINS = SKINS;
