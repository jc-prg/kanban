const express      = require('express');
const router  = express.Router();
const { writeRateLimit } = require('../auth');
const { getPromptsDb, upsertDoc } = require('../db');
const { API_KEY }        = require('../config');
const { version, repository } = require('../../package.json');

const { detectBranch } = require('../build-info');

const _branch = detectBranch();

const PROMPTS_DOC_ID  = 'prompts';
const PROMPTS_DEFAULT = { searchProfile: '', criteriaInclude: '', criteriaExclude: '', searchRadius: '' };

async function loadPrompts() {
  try {
    const { _id, _rev, ...data } = await getPromptsDb().get(PROMPTS_DOC_ID);
    return data;
  } catch (err) {
    if (err.statusCode === 404) return { ...PROMPTS_DEFAULT };
    throw err;
  }
}

async function savePrompts(data) {
  await upsertDoc(getPromptsDb(), PROMPTS_DOC_ID, data);
}

router.get('/settings', (req, res) => {
  res.json({ apiKeyConfigured: !!API_KEY, version, branch: _branch, repository: repository || '' });
});

router.get('/prompts', async (req, res) => {
  try { res.json(await loadPrompts()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/prompts', writeRateLimit, async (req, res) => {
  try {
    const { searchProfile = '', criteriaInclude = '', criteriaExclude = '', searchRadius = '' } = req.body;
    await savePrompts({ searchProfile, criteriaInclude, criteriaExclude, searchRadius });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
