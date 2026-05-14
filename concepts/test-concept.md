# Test Concept — Kanban App

## Overview

This document proposes an automated test suite for the kanban application. The app has no existing test framework, so this concept covers the recommended tooling, test organization, and specific test cases across all functional areas.

The backend is Express 5 with CouchDB (via `nano`). The frontend is vanilla JS with no bundler. Tests should be practical to run in CI without a browser where possible, falling back to browser-based tests only for frontend-specific behavior.

---

## Recommended Tooling

| Layer | Tool | Reason |
|---|---|---|
| Backend API | **Vitest** or **Jest** + **supertest** | Fast, no browser needed; tests real HTTP routes |
| CouchDB isolation | **pouchdb-adapter-memory** (in-process) or Docker CouchDB | Avoids contaminating real data |
| Frontend units | **Vitest** + **jsdom** | Tests pure JS functions without a browser |
| End-to-end (E2E) | **Playwright** | Cross-browser, reliable, covers UI flows |
| Snapshot / regression | Playwright screenshot snapshots | Catches unintended visual regressions |

Suggested directory layout:

```
tests/
  api/          # supertest API integration tests
  unit/         # pure-function unit tests (state.js, render.js helpers)
  e2e/          # Playwright end-to-end tests
  fixtures/     # sample boards, notes, import payloads
  setup/        # CouchDB mock/seed helpers
```

---

## Running the Tests

```bash
cd app
npm test          # run all tests once
npm run test:watch  # watch mode (re-runs on file change)
```

Individual projects can be filtered with `--project`:

```bash
npx vitest run --project api   # API integration tests only
npx vitest run --project unit  # frontend unit tests only
```

No external services are required — CouchDB is fully mocked.

---

## 1. Backend API Tests (`tests/api/`)

All tests use supertest against a running Express app wired to an in-memory or isolated CouchDB instance. Each test suite seeds its own board document and tears it down after.

### 1.1 Authentication (`auth.test.js`)

| # | Test | Expected |
|---|---|---|
| A-1 | `POST /api/auth` with correct password | 200 `{ ok: true, token: <hex> }` |
| A-2 | `POST /api/auth` with wrong password | 401 |
| A-3 | 5 consecutive wrong passwords trigger lockout | 6th attempt returns 429 regardless of password |
| A-4 | Lockout clears after 15 minutes (mock `Date.now`) | Correct password returns 200 again |
| A-5 | 10 failed attempts in 15-min window trigger rate limit | 429 before consecutive-5 lockout |
| A-6 | `GET /api/auth/verify` with valid token | 200 `{ ok: true }` |
| A-7 | `GET /api/auth/verify` with invalid/expired token | 401 |
| A-8 | `x-api-key` header with configured `API_KEY` | Any protected route returns 200 |
| A-9 | `Authorization: Bearer <key>` with correct API key | Any protected route returns 200 |
| A-10 | Request with no auth | Any protected route returns 401 |

### 1.2 Board Management (`boards.test.js`)

| # | Test | Expected |
|---|---|---|
| B-1 | `GET /api/boards` (authenticated) | Array with stats (totalCards, inboxCount, etc.) |
| B-2 | `POST /api/boards/my-board` — valid name | 201, board created |
| B-3 | `POST /api/boards/My Board` — uppercase / spaces | 400 |
| B-4 | `POST /api/boards/inbox` — reserved name | 400 |
| B-5 | `POST /api/boards/a` — single char name | 400 (min 2 chars) |
| B-6 | `POST /api/boards/<65-char-name>` — exceeds max | 400 |
| B-7 | `POST /api/boards/existing-board` — duplicate | 409 |
| B-8 | `POST /api/boards/my-board/rename` `{ newName: "new" }` | 200, board accessible under new name |
| B-9 | Rename to existing name | 409 |
| B-10 | Rename to "inbox" | 400 |
| B-11 | `DELETE /api/boards/my-board` | 200, board and CouchDB database gone |
| B-12 | `DELETE /api/boards/nonexistent` | 404 |

### 1.3 Board Data — Load & Save (`board-data.test.js`)

| # | Test | Expected |
|---|---|---|
| D-1 | `GET /api/:board/board` — fresh board | 200, valid board schema with columns array |
| D-2 | `PUT /api/:board/board` — valid full replacement | 200 |
| D-3 | `PUT /api/:board/board` — missing `columns` field | 400 (AJV validation) |
| D-4 | `PUT /api/:board/board` — card with priority outside 1–5 | 400 |
| D-5 | `PUT /api/:board/board` — card with invalid link (not http/https) | 400 |
| D-6 | `PATCH /api/:board/board` — add column | 200, column present in subsequent GET |
| D-7 | `PATCH /api/:board/board` — remove column by id | 200, column absent in subsequent GET |
| D-8 | `PATCH /api/:board/board` — update card text | 200, new text returned |
| D-9 | `PATCH /api/:board/board` — update settings | 200, settings persisted |
| D-10 | `GET /api/:board/all-columns` | Object keyed by column title |
| D-11 | `GET /api/:board/column/:name` — case-insensitive match | 200, cards array |
| D-12 | `GET /api/:board/column/nonexistent` | 404 |
| D-13 | `GET /api/:board/card/:id` — card with move history | 200, `{ created, moves, column }` |
| D-14 | `GET /api/:board/card/:id` — unknown id | 404 |

### 1.4 Import & Move-to (`import.test.js`)

| # | Test | Expected |
|---|---|---|
| I-1 | `POST /api/:board/import` — plain array | Cards land in Inbox, each with own color |
| I-2 | `POST /api/:board/import` — `{ relevant, excluded }` | Relevant = green, excluded = red |
| I-3 | Import job-application objects | `text` = "title \| company \| location", `description` = reason |
| I-4 | Duplicate card (same `text` already in any column) | Skipped, counted in `skipped` |
| I-5 | Import creates Inbox column if absent | Column created at position 0 |
| I-6 | Import with `inboxWithDate: true` | Column title includes today's date |
| I-7 | `POST /api/:board/move-to/:name` — match by title | 200, card in target column |
| I-8 | `POST /api/:board/move-to/nonexistent-column` | 404 |
| I-9 | `POST /api/:board/move-to` — card not found | 404 |
| I-10 | Move-to with `location: "test-city"` Easter egg | 200, `success: true`, card not actually moved |

### 1.5 Notes API (`notes.test.js`)

| # | Test | Expected |
|---|---|---|
| N-1 | `GET /api/:board/notes` — no notes yet | 200, empty `{ pages: [] }` |
| N-2 | `PUT /api/:board/notes` — valid nested structure | 200 |
| N-3 | `PUT /api/:board/notes` — depth 3 (grandchild) | 400 |
| N-4 | `PUT /api/:board/notes` — missing `pages` field | 400 |
| N-5 | `PUT /api/:board/notes` — page with invalid id (not `n-`) | 400 |
| N-6 | `POST /api/:board/notes/attachments/:pageId` — upload file | 200 `{ name, size }` |
| N-7 | `GET /api/:board/notes/attachments/:pageId` | Array with uploaded file |
| N-8 | `GET /api/:board/notes/attachments/:pageId/:filename` | 200, correct file content |
| N-9 | `DELETE /api/:board/notes/attachments/:pageId/:filename` | 200 `{ ok: true }`, file gone |
| N-10 | Upload file > 50 MB | 413 |
| N-11 | Upload to invalid pageId (path traversal attempt) | 400 |
| N-12 | `GET /api/:board/notes/export` | 200, ZIP stream with markdown files |

### 1.6 Card Attachments (`card-attachments.test.js`)

| # | Test | Expected |
|---|---|---|
| CA-1 | Upload file to card — valid cardId | 200 `{ name, size }` |
| CA-2 | `GET /api/:board/cards/attachments` | Array of card IDs with attachments |
| CA-3 | `GET /api/:board/cards/attachments/:cardId` | Array of `{ name, size }` |
| CA-4 | Download card attachment | 200, correct file |
| CA-5 | Delete card attachment | 200, gone from list |
| CA-6 | Upload with invalid cardId (`../../etc/passwd`) | 400 |
| CA-7 | `GET /api/:board/attachment-stats` | `{ count, size }` |

---

## 2. Frontend Unit Tests (`tests/unit/`)

Pure-function tests using Vitest + jsdom. No network calls.

### 2.1 State mutations (`state.test.js`)

| # | Test | Expected |
|---|---|---|
| S-1 | `addColumn()` increments column count, assigns color from rotation | State reflects new column |
| S-2 | `deleteColumn(id)` removes column and all its cards | Column absent, no orphaned cards |
| S-3 | `addCard(colId, text)` sets `created` to today (ISO), generates unique `id` | Card present with correct fields |
| S-4 | `addCard` with priority=6 | Clamped or rejected (check boundary) |
| S-5 | `moveCardToColumn(cardId, fromColId, toColId)` updates `moves` array | Move recorded `{ at, from, to }` |
| S-6 | Column with `actions: ["markDone"]` applied on card drop | Card `done: true` after move |
| S-7 | Column with `actions: ["setEndDate"]` | Card `endDate` set to today |
| S-8 | `buildPatch(base, local, remote)` — remote structural change + local card edit | Both preserved in result |
| S-9 | `buildPatch` — same card edited both locally and remotely | Remote wins (documented behaviour) |
| S-10 | `uid()` returns unique value on repeated calls | No duplicates across 1000 calls |

### 2.2 Rendering helpers (`render.test.js`)

| # | Test | Expected |
|---|---|---|
| R-1 | `escHtml('<script>alert(1)</script>')` | Entities escaped, no raw `<` |
| R-2 | `safeLink('javascript:alert(1)')` | Returns `null` or `''` |
| R-3 | `safeLink('https://example.com')` | Returns input unchanged |
| R-4 | `safeLink('http://example.com')` | Returns input unchanged |
| R-5 | `fmtDate('2024-01-05')` | Returns locale-friendly string |
| R-6 | `getLinkBadgeHtml` for a LinkedIn URL | Returns LinkedIn SVG badge |
| R-7 | Card text starting with `#` renders as label (no edit button) | DOM contains label class |
| R-8 | Card past `endDate` renders overdue class | DOM element has overdue indicator |

### 2.3 Search logic (`search.test.js`)

| # | Test | Expected |
|---|---|---|
| SR-1 | Search "café" matches card "Cafe" (diacritic-insensitive) | Result includes card |
| SR-2 | All-words filter: "foo bar" matches "foo in bar" but not "foo" alone | Correct filter |
| SR-3 | Priority filter: select priority 1 only | Returns only priority-1 cards |
| SR-4 | Column filter: uncheck a column | Cards from that column excluded |
| SR-5 | Date range: cards with endDate outside range | Excluded from results |
| SR-6 | Page search returns breadcrumb path for nested pages | Path reflects tree hierarchy |
| SR-7 | Empty query returns all cards | No filtering applied |

### 2.4 Notes helpers (`notes.test.js`)

| # | Test | Expected |
|---|---|---|
| NT-1 | `addNotePage(parentId)` creates child with unique `n-` id | Page appears in tree |
| NT-2 | Adding child to depth-2 node is prevented | No grandchild created |
| NT-3 | `deleteNotePage(id)` removes page and all its children | No orphaned children |
| NT-4 | Linked card appears in page; unlinking removes it | `linkedCards` array updated |

### 2.5 Analytics computations (`analytics.test.js`)

The `run()` functions in `analytics.js` are pure computations over card/state data and should be tested in isolation by injecting a mock `state` object.

| # | Test | Expected |
|---|---|---|
| AN-1 | `done-per-month` — card with `doneAt` | Counted in correct month and week bucket |
| AN-2 | `done-per-month` — card moved to a `done*` column, no `doneAt` | Counted using move date |
| AN-3 | `done-per-month` — card with both `doneAt` and a move to done* column | Counted exactly once (doneAt takes priority) |
| AN-4 | `done-per-month` — card with no `doneAt` and no move to done* column | Not counted |
| AN-5 | `done-per-month` — move to non-done column is ignored | Only done* moves count |
| AN-6 | `moved-to-column` — card moved multiple times | Each move produces one entry per destination |
| AN-7 | `moved-to-column` — column filter (selColumns) restricts destination columns | Only selected destination columns included |
| AN-8 | `moved-to-column` — columns ordered by board column order | Output columns match board order, not insertion order |
| AN-9 | `word-freq` — common short words filtered by minLength | Words below threshold excluded |
| AN-10 | `split-position` — card text with delimiter `\|` at position 1 | Correct field extracted and counted |
| AN-11 | `date-duration` — card with `startDate` and `endDate` | Duration in days computed correctly |
| AN-12 | `date-duration` — card with only `startDate` | Appears in startOnly bucket |

---

## 3. End-to-End Tests (`tests/e2e/`)

Run against a live server (local or CI Docker Compose). Each test file gets a fresh board created via API before the suite and deleted after.

### 3.1 Authentication flow (`auth.spec.js`)

| # | Scenario |
|---|---|
| E-A-1 | Visit app → login prompt shown → enter password → board visible |
| E-A-2 | Wrong password → error message → fields still shown |
| E-A-3 | Reload page with valid token in sessionStorage → no login prompt |
| E-A-4 | Clear sessionStorage → redirect to login |

### 3.2 Board overview (`overview.spec.js`)

| # | Scenario |
|---|---|
| E-O-1 | Overview shows all boards with card counts |
| E-O-2 | Create new board from overview → navigates to empty board |
| E-O-3 | Archived board hidden from overview (unless toggled) |

### 3.3 Column & card CRUD (`board.spec.js`)

| # | Scenario |
|---|---|
| E-B-1 | Add a column → column appears with title input |
| E-B-2 | Rename column (blur title input) → title persists after reload |
| E-B-3 | Delete column (context menu) → column gone, confirm dialog |
| E-B-4 | Add card via + button → modal opens → fill title → submit → card visible |
| E-B-5 | Edit card → change title, description, priority, dates → save → card updated |
| E-B-6 | Delete card (context menu) → card removed with confirmation |
| E-B-7 | Card with `#` prefix renders as label (no edit button, not counted) |
| E-B-8 | Card with `endDate` in past shows overdue badge |
| E-B-9 | "Mark as done" → card shows done checkmark |
| E-B-10 | Load more: board with 31+ cards in one column shows "Load more" button |

### 3.4 Drag and drop (`drag.spec.js`)

| # | Scenario |
|---|---|
| E-D-1 | Drag card from column A to column B → card in correct position |
| E-D-2 | Drop into column with `markDone` action → card.done becomes true |
| E-D-3 | Drag column to reorder → new order persists after reload |
| E-D-4 | Drag card to linked note page → confirmation → card linked to page |

### 3.5 Search (`search.spec.js`)

| # | Scenario |
|---|---|
| E-S-1 | Ctrl+F opens search dialog |
| E-S-2 | Type query → matching cards appear |
| E-S-3 | Click result → edit modal opens for that card |
| E-S-4 | Filter by column checkbox → cards from other columns hidden |
| E-S-5 | Toggle to Pages mode → note page results shown |
| E-S-6 | Escape closes search |

### 3.6 Notes sidebar (`notes.spec.js`)

| # | Scenario |
|---|---|
| E-N-1 | Open notes sidebar → tree renders |
| E-N-2 | Add top-level page → appears in tree |
| E-N-3 | Add child page → nested under parent |
| E-N-4 | Add grandchild page → blocked (max depth 2) |
| E-N-5 | Edit page → markdown description previewed |
| E-N-6 | Upload attachment to page → file listed |
| E-N-7 | Insert attachment as markdown → `![name](url)` appears in editor |
| E-N-8 | Link card to page (via search) → card listed in page |
| E-N-9 | Drag card to page → linked |
| E-N-10 | Reorder pages by drag → new order persists |
| E-N-11 | Export notes → ZIP downloaded |

### 3.7 Settings & board management (`settings.spec.js`)

| # | Scenario |
|---|---|
| E-ST-1 | Change board description → shown in overview grid |
| E-ST-2 | Archive board → disappears from active overview |
| E-ST-3 | Enable `inboxWithDate` → imported inbox column has today's date |
| E-ST-4 | Enable `persistCollapse` → collapse a column → reload → still collapsed |
| E-ST-5 | Export board JSON → valid JSON downloaded |
| E-ST-6 | Import board JSON → board state replaced |
| E-ST-7 | Rename board → URL changes, redirected to new board |
| E-ST-8 | Delete board → redirect to overview, board gone |

### 3.8 Markdown rendering (`markdown.spec.js`)

| # | Scenario |
|---|---|
| E-M-1 | Description with `**bold**` → `<strong>` in preview |
| E-M-2 | Description with `<script>` → stripped by DOMPurify |
| E-M-3 | Task list `- [ ] item` → interactive checkbox in preview |
| E-M-4 | Code block → copy button present |
| E-M-5 | `[toc]` in note description → table of contents rendered |
| E-M-6 | `[subpages]` in note → child page titles rendered |

### 3.9 Import flow (`import.spec.js`)

| # | Scenario |
|---|---|
| E-I-1 | POST plain array via API → cards appear in Inbox column |
| E-I-2 | POST `{ relevant, excluded }` → relevant (green) and excluded (red) cards in Inbox |
| E-I-3 | Re-import same cards → no duplicates added |

---

## 4. Security Tests (`tests/api/security.test.js`)

| # | Test | Expected |
|---|---|---|
| SEC-1 | Path traversal in filename: `../../etc/passwd` | 400, file not accessed |
| SEC-2 | Path traversal in pageId: `n-../../secret` | 400 |
| SEC-3 | Path traversal in cardId: `id-../../../../secret` | 400 |
| SEC-4 | Board name with `../` | 400 |
| SEC-5 | XSS via card title stored, retrieved, rendered | Entities escaped in JSON; DOMPurify in preview |
| SEC-6 | Upload HTML file with `<script>` → download → verify no execution context | Served with correct Content-Type |
| SEC-7 | Timing-safe auth: measure time diff between wrong-user vs wrong-password | Negligible difference (< 1ms threshold on repeated sampling) |
| SEC-8 | Session token not accepted after new login (token reuse) | Depends on implementation — document behaviour |

---

## 5. Concurrency & Edge-case Tests

| # | Test | Expected |
|---|---|---|
| C-1 | Two simultaneous PATCHes to same board | Neither is silently lost (one wins; log or retry on `_rev` conflict) |
| C-2 | Load board while save is in flight | No corrupted state (debounce + merge handles it) |
| C-3 | Empty board (`columns: []`) renders without errors | Blank board shown, add-column button visible |
| C-4 | Board with 500 cards across columns | All columns render; load-more paging works |
| C-5 | Column with 0 cards | Renders, drop target active |
| C-6 | Card with all optional fields missing | Renders with no badges/dates |
| C-7 | Card with all optional fields set | All metadata shown correctly |
| C-8 | CouchDB unreachable on startup | Server retries 15× then exits with clear error |
| C-9 | CouchDB connection drops mid-session | PATCH returns 503; auto-save indicator shows error |

---

## 6. CI Integration

```yaml
# Suggested GitHub Actions workflow structure
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install && npx vitest run tests/unit

  api:
    runs-on: ubuntu-latest
    services:
      couchdb:
        image: couchdb:3
        env:
          COUCHDB_USER: kanban
          COUCHDB_PASSWORD: kanban-pwd
        ports: ["5984:5984"]
    steps:
      - uses: actions/checkout@v4
      - run: npm install && npx vitest run tests/api

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker compose up -d --build
      - run: npx playwright install --with-deps
      - run: npx playwright test tests/e2e
      - uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
```

---

## 7. Priority & Phasing

Implement in this order to get coverage fastest:

**Phase 1 — Foundation (high value, low effort)** ✓ complete
- [x] Backend API tests: auth (A-1,2,6–10), board CRUD (B-1–12), board data (D-1–14) — 38 tests
- [x] Unit tests: state mutations (S-1–10, 23 tests), render helpers (R-1–6, 13 tests) — 36 tests

**Phase 2 — Core flows** ✓ complete
- [x] Backend: import, notes, attachments (sections 1.4–1.6) — 39 tests
- [x] Unit: search logic, notes helpers (sections 2.3–2.4) — 31 tests
- [x] Security tests (section 4) — 15 tests

**Phase 3 — E2E**
- [ ] Auth, board CRUD, drag-drop, search E2E (sections 3.1–3.5)
- [ ] Notes E2E (section 3.6)

**Phase 4 — Reliability**
- [ ] Concurrency and edge cases (section 5)
- [ ] Settings and import E2E (sections 3.7–3.9)
- [ ] Visual regression snapshots

---

## 8. Test Data & Fixtures

Create `tests/fixtures/` with:

- `board-minimal.json` — one column, one card, no optional fields
- `board-full.json` — multiple columns, cards with all fields, settings
- `notes-simple.json` — flat pages, no children
- `notes-nested.json` — pages with one level of children
- `import-plain.json` — plain array for import
- `import-classified.json` — `{ relevant, excluded }` format
- `import-jobs.json` — job-application objects

Each fixture should be self-contained and stable (no dynamic dates unless test injects them).
