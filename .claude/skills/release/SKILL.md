---
name: release
description: Commit all pending changes and cut a new versioned release for the kanban app. Use this skill whenever the user wants to release, bump the version, tag a release, or says things like "release this", "cut a release", "bump the version", "/release", "release as patch/minor/major", or "tag this as a new version".
---

# Release

Commit the current changes and bump the app version in one guided flow.

## Step 0 — Offer to run tests first

Ask the user: "Run `/test` before releasing? (yes / no)"

- If **yes**: run both test suites (`npm test` then `npm run test:e2e`) and show a compact pass/fail summary. If any tests fail, stop and report the failures — do not proceed to Step 1 until the user confirms they want to release anyway or the failures are fixed.
- If **no** (or if the user already confirmed tests pass): proceed directly to Step 1.
- If the user provided "just do it" or similar upfront, skip this question and proceed to Step 1.

## Step 1 — Determine the release type

If the user specified `patch`, `minor`, or `major` (in the trigger phrase or as an argument), use that.

Otherwise, run:
```bash
cd /mnt/Daten/projects/test/kanban && git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline 2>&1
```

Use the commits since the last tag to suggest a type, then ask the user to confirm:
- Only `fix:` commits → suggest **patch**
- Any `feat:` commit → suggest **minor**
- Any breaking change mention → suggest **major**

Show the suggestion clearly: "Suggested release type: **minor** (new features present). Confirm, or choose patch / major?"

Wait for confirmation before proceeding.

## Step 2 — Show what will be committed

Run these two commands and show a compact summary:

```bash
cd /mnt/Daten/projects/test/kanban && git status --short
```
```bash
cd /mnt/Daten/projects/test/kanban && git diff --stat HEAD
```

List the changed files and briefly describe what will be included.

## Step 3 — Compose the commit message

Look at the staged/unstaged changes and the commits since the last tag, then draft a conventional commit message. Show it to the user:

```
<type>: <short summary>
```

Use `feat:` if any new features are included, `fix:` for bug-fix-only changes, `chore:` for pure maintenance. Ask: "Commit message — does this look right, or would you like to change it?"

Wait for confirmation or correction before proceeding.

## Step 4 — Commit the changes

Stage all tracked modified files and commit:

```bash
cd /mnt/Daten/projects/test/kanban && git add -u
```
```bash
cd /mnt/Daten/projects/test/kanban && git commit -m "<confirmed message>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

If `git add -u` shows nothing to stage (already clean), skip the commit and proceed to Step 5.

If the commit fails (e.g. pre-commit hook), report the error clearly and stop — do not proceed to version bump until the working tree is committed cleanly.

## Step 5 — Bump the version

Run `npm version` with `--no-git-tag-version` to avoid it failing on untracked files, then create the commit and tag manually:

```bash
cd /mnt/Daten/projects/test/kanban/app && npm version <type> --no-git-tag-version
```

Capture the new version string from the output (e.g. `v1.0.1`), then:

```bash
cd /mnt/Daten/projects/test/kanban && git add app/package.json && git commit -m "v<X.Y.Z>" && git tag v<X.Y.Z>
```

## Step 6 — Confirm

Show the new version and the tag:

```bash
cd /mnt/Daten/projects/test/kanban && git tag --sort=-version:refname | head -3
```

Report: "Released **vX.Y.Z** — commit and tag created. Run `git push && git push --tags` to push to remote."

## Notes

- Never force-push or push automatically — leave that to the user
- If the user says "just do it" or provides all info upfront (e.g. "release as minor"), skip the confirmation prompts and proceed directly
- Always ask about running tests first (Step 0) unless the user explicitly bypassed it
