'use strict';
// Git branch shown in Settings → About. Local runs ask git; the Docker image has no repository, so the
// build copies the repository's HEAD file in (docker-compose.yml: additional_contexts `git` → .git-HEAD).
// GIT_BRANCH in the environment overrides both.
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');

/** Branch from the content of a .git/HEAD file: "ref: refs/heads/x" → x, a commit hash → "detached abc1234". */
function branchFromHead(text) {
  const t = String(text || '').trim();
  const m = t.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (m) return m[1];
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(t)) return `detached ${t.slice(0, 7)}`;
  return null;
}

function detectBranch({ env = process.env, useGit = true, headFiles = [path.join(APP_DIR, '.git-HEAD'), path.join(APP_DIR, '..', '.git', 'HEAD')] } = {}) {
  if (env.GIT_BRANCH?.trim()) return env.GIT_BRANCH.trim();
  if (useGit) try {
    const b = execSync('git rev-parse --abbrev-ref HEAD', { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (b && b !== 'HEAD') return b;   // "HEAD" = detached: the HEAD file gives the commit
  } catch { /* no git (Docker image) */ }
  for (const file of headFiles) {
    try {
      const b = branchFromHead(fs.readFileSync(file, 'utf8'));
      if (b) return b;
    } catch { /* not there */ }
  }
  return 'unknown';
}

module.exports = { branchFromHead, detectBranch };
