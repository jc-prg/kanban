---
name: test
description: Run the kanban app's test suite (`npm test` in the `app/` directory), display a clear pass/fail summary, and — when tests fail — analyze each failure, identify the root cause, and propose concrete code fixes. Use this skill whenever the user wants to run tests, check if tests pass, debug a failing test, or fix test errors. Trigger phrases include "run tests", "run the tests", "/test", "are tests passing", "fix failing tests", "what tests are broken", "test the app".
---

# Test Runner

Run the test suite, report results, and fix any failures.

## Step 1 — Run the tests

```bash
cd /mnt/Daten/projects/test/kanban/app && npm test 2>&1
```

## Step 2 — Report the results

Show a compact summary:
- Total / passed / failed / skipped count and duration
- If all pass: update MEMORY.md (see Step 2a) then confirm success and stop here

## Step 2a — Update test count in MEMORY.md (only when all tests pass)

Parse the total passed count from the vitest output (the number after "Tests" in the summary line, e.g. `Tests  190 passed`).

Update `/home/jean/.claude/projects/-mnt-Daten-projects-test-kanban/memory/MEMORY.md`:
- Find the line that records the most recent completed phase total (e.g. `### Phase 2 (complete) — 81 additional tests (155 total)` or similar)
- If the new total differs from what's recorded, add or update a note reflecting the current count

Specifically, look for patterns like `(NNN total)` anywhere in the Test Suite section and update to match the current passing count. If the count already matches, skip silently.

## Step 3 — Analyze failures (only if tests failed)

For each failing test:

1. **Show the failure** — test name, file path, error message, and the most relevant stack frame
2. **Read the source** — open the failing test file and the source file it exercises
3. **Diagnose the root cause** — distinguish between:
   - A real bug in the source code (fix the source)
   - A broken assertion that no longer matches the implementation (update the test)
   - A missing or changed API / function signature
   - An environment or setup issue
4. **Propose a concrete fix** — show the exact change needed (diff or code block)

Group fixes by file. If multiple tests fail for the same root cause, explain that once rather than repeating.

## Step 4 — Offer to apply fixes

After presenting all fixes, ask: "Should I apply these fixes?"

- If yes: apply each fix with the Edit tool, then re-run `npm test` to confirm they pass
- If no: leave the code unchanged

## Notes

- Never apply fixes without the user's confirmation
- If a fix is uncertain, say so and present alternatives rather than guessing
- Prefer fixing source code over changing tests, unless the test expectation is genuinely wrong
- When re-running after a fix, show only the new summary (not the full output again)
