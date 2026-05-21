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
| B-13 | `GET /api/achievements/today` (no `?date`) | 200 `{ created, moved, done, createdBoards, movedBoards, doneBoards, hasPast }` with correct counts |
| B-14 | `GET /api/achievements/today?date=2024-01-01` — seeded cards with that date | Correct counts for the specified date |
| B-15 | `GET /api/achievements/today` — archived boards excluded | Archived board's cards not counted |

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

### 1.4 Import, Move-to & Quick-add (`import.test.js`)

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
| I-11 | `POST /api/:board/inbox` — single card object | 200 `{ added: 1, added_items, duplicates: 0 }`, card in Inbox column |
| I-12 | `POST /api/:board/inbox` — array of cards | All non-duplicate cards added |
| I-13 | `POST /api/:board/inbox` — card with text already in any column | `duplicates: 1`, card still inserted but flagged `duplicate: true` |
| I-14 | `POST /api/:board/inbox` — `inboxWithDate: true` | Inbox column title includes today's date |
| I-15 | `POST /api/:board/inbox` — invalid body (missing `text`) | 400 |

### 1.5 Notes API (`notes.test.js`)

| # | Test | Expected |
|---|---|---|
| N-1 | `GET /api/:board/notes` — no notes yet | 200, empty `{ items: [], schemaVersion: 2 }` |
| N-2 | `PUT /api/:board/notes` — valid v2 structure (`items` with folders and pages) | 200 |
| N-3 | `PUT /api/:board/notes` — depth 3 nesting | 200 — depth limit is UI-only; backend accepts any nesting |
| N-4 | `PUT /api/:board/notes` — missing `items` field | 400 |
| N-5 | `PUT /api/:board/notes` — page with invalid id (not `n-`) | 400 |
| N-6 | `POST /api/:board/notes/attachments/:pageId` — upload file | 200 `{ name, size }` |
| N-7 | `GET /api/:board/notes/attachments/:pageId` | Array with uploaded file |
| N-8 | `GET /api/:board/notes/attachments/:pageId/:filename` | 200, correct file content |
| N-9 | `DELETE /api/:board/notes/attachments/:pageId/:filename` | 200 `{ ok: true }`, file gone |
| N-10 | Upload file > 50 MB | 413 |
| N-11 | Upload to invalid pageId (path traversal attempt) | 400 |
| N-12 | `GET /api/:board/notes/export` | 200, ZIP stream with markdown files |
| N-13 | `PATCH /api/:board/notes` — `{ updatedPages: [{ id, description }] }` — page exists | 200 `{ ok: true }`, page description updated; response includes `ETag` header |
| N-14 | `PATCH /api/:board/notes` — `If-Match` header matches current `_rev` | 200, update applied |
| N-15 | `PATCH /api/:board/notes` — `If-Match` header stale (rev mismatch) | 409 conflict |
| N-16 | `PATCH /api/:board/notes` — `updatedPages` references unknown page id | 200, no-op (unknown ids silently skipped) |
| N-17 | `GET /api/db-size` | 200 `{ size }` in bytes |

### 1.7 Notes per-operation API — v2 endpoints (`notes-ops.test.js`)

These endpoints were added in the v2 implementation (all routes live in
`routes/notes.js`). WebDAV is mocked; the tests verify CouchDB mutations and
the correct WebDAV primitive is called.

#### WebDAV config

| # | Test | Expected |
|---|---|---|
| WC-1 | `GET /:board/webdav-config` | 200 `{ enabled, url, user, hasPassword }` — no password in response |
| WC-2 | `PUT /:board/webdav-config` — save credentials | 200; re-GET confirms values stored |
| WC-3 | `POST /:board/webdav-config/test` — mock returns 207 | 200 `{ ok: true }` |
| WC-4 | `POST /:board/webdav-config/test` — mock returns 401 | 200 `{ ok: false, error: "Authentication failed…" }` |
| WC-5 | `POST /:board/webdav-config/test` — connection timeout | 200 `{ ok: false, error: "Connection timed out" }` |

#### Page operations

| # | Test | Expected |
|---|---|---|
| NP-1 | `POST /:board/notes/pages` — create at root | 201, page in `data.notes.items`; WebDAV PUT called |
| NP-2 | `POST /:board/notes/pages` — create inside folder (`parentId`) | Page appears in folder's `children` |
| NP-3 | `POST /:board/notes/pages` — duplicate `page.id` | 409 |
| NP-4 | `PATCH /:board/notes/pages/:id` — update title | WebDAV MOVE called; new title in returned notes |
| NP-5 | `PATCH /:board/notes/pages/:id` — update content only (same title) | WebDAV PUT called (no MOVE); content in returned notes |
| NP-6 | `PATCH /:board/notes/pages/:id` — unknown id | 404 |
| NP-7 | `DELETE /:board/notes/pages/:id` | Page removed from notes; WebDAV DELETE called |
| NP-8 | `DELETE /:board/notes/pages/:id` — WebDAV DELETE fails | 500; page NOT removed from CouchDB |
| NP-9 | `POST /:board/notes/pages/:id/move` — move to folder | Page appears in target folder; WebDAV MOVE called |
| NP-10 | `POST /:board/notes/pages/:id/move` — move to root (`folderId: null`) | Page at root level |
| NP-11 | `POST /:board/notes/pages/:id/move` — with `targetId` + `position: "before"` | Page inserted before target in array |
| NP-12 | `GET /:board/notes/pages/:id/content` — WebDAV enabled | 200 `{ content, lastModified }` |
| NP-13 | `GET /:board/notes/pages/:id/content` — WebDAV disabled | 400 |
| NP-14 | `GET /:board/notes/pages/:id/meta` | 200 `{ lastModified, size }` |

#### Folder operations

| # | Test | Expected |
|---|---|---|
| NF-1 | `POST /:board/notes/folders` — create at root | Folder in `items`; WebDAV MKCOL called |
| NF-2 | `POST /:board/notes/folders` — create nested (`parentId`) | Folder in parent's `children` |
| NF-3 | `PATCH /:board/notes/folders/:id` — rename | WebDAV MOVE called; `wdPath` updated on folder and all descendants |
| NF-4 | `DELETE /:board/notes/folders/:id` | Folder removed; WebDAV DELETE called |
| NF-5 | `DELETE /:board/notes/folders/:id` — WebDAV DELETE fails | 500; folder NOT removed from CouchDB |
| NF-6 | `POST /:board/notes/folders/:id/move` — move to new parent | Folder and children appear under new parent |
| NF-7 | `POST /:board/notes/folders/:id/sync` | Returns updated subtree; saves if changed |

#### Sync

| # | Test | Expected |
|---|---|---|
| NS-1 | `POST /:board/notes/sync` no body — full scan | `syncFromWebdav` called; new WD files added to tree |
| NS-2 | `POST /:board/notes/sync` `{ folderIds: [] }` — lazy | `syncRootFromWebdav` only |
| NS-3 | `POST /:board/notes/sync` — file absent from WD | Item marked `orphaned: true` |
| NS-4 | `POST /:board/notes/sync` — WebDAV disabled | 200 `{ ok: true, changed: false }` |

### 1.8 Webhook config (`webhook.test.js`)

| # | Test | Expected |
|---|---|---|
| WH-1 | `GET /:board/webhook-config` — no doc yet | 200 `{ enabled: false, name: '', url: '', method: 'POST' }` |
| WH-2 | `PUT /:board/webhook-config` — valid config | 200 `{ ok: true }`; re-GET returns saved values |
| WH-3 | `PUT /:board/webhook-config` — URL without http/https scheme | 400 |
| WH-4 | `PUT /:board/webhook-config` — invalid method (e.g. `DELETE`) | 200; method silently falls back to previous/default |
| WH-5 | `POST /:board/webhook/trigger` — webhook not configured (no url) | 400 `{ ok: false, error: "…" }` |
| WH-6 | `POST /:board/webhook/trigger` — webhook disabled (`enabled: false`) | 400 |
| WH-7 | `POST /:board/webhook/trigger` — mock target returns 200 | 200 `{ ok: true, status: 200 }` |
| WH-8 | `POST /:board/webhook/trigger` — mock target returns 500 | 200 `{ ok: false, error: "Webhook returned HTTP 500" }` |
| WH-9 | `POST /:board/webhook/trigger` — mock target times out (>10 s) | 200 `{ ok: false, error: "Webhook timed out (10 s)" }` |
| WH-10 | `POST /:board/webhook/trigger` with `method: 'GET'` — no body sent | Mock receives GET request with no Content-Type |

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
| S-6 | Column with `actions: ["markDone"]` applied on card drop | Card `done: true` and `doneAt` set to ISO timestamp after move |
| S-7 | Column with `actions: ["markUndone"]` applied on card drop | Card `done: false` and `doneAt` deleted |
| S-7b | Column with `actions: ["setEndDate"]` | Card `endDate` set to today |
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
| NT-1 | `addNotePage(parentId=null)` creates page at root with unique `n-` id and `type:"page"` | Page appears in `items` |
| NT-2 | `addNoteFolder(parentId)` creates folder with unique `f-` id and `type:"folder"` | Folder in `items` or parent's `children` |
| NT-3 | `deleteNoteItem(id)` on a page removes it; `deleteNoteItem(id)` on a folder removes folder and all contained pages | No orphaned items |
| NT-4 | Linked card appears in page; unlinking removes it | `linkedCards` array updated |
| NT-5 | `buildNotesPatch` — page content change, same tree structure | Returns `{ updatedPages: [changedPage] }` |
| NT-6 | `buildNotesPatch` — page moved between folders (structure change) | Returns `null` (caller falls back to PUT) |

### 2.5 Analytics computations (`analytics.test.js`)

> **Status: not yet implemented.** `analytics.js` is a frontend-only IIFE that closes over the global `state`. Tests require a jsdom environment with a mock `state` injected, similar to `state.test.js`.

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
| E-N-2 | Add top-level page → appears in tree at root |
| E-N-3 | Add folder → add page inside folder → page nested under folder |
| E-N-4 | Add subfolder inside folder → add page inside it; attempt to add third-level subfolder → button absent (UI depth limit = 2 folder levels) |
| E-N-5 | Edit page → markdown description previewed |
| E-N-6 | Upload attachment to page → file listed |
| E-N-7 | Insert attachment as markdown → `![name](url)` appears in editor |
| E-N-8 | Link card to page (via search) → card listed in page |
| E-N-9 | Drag card to page → linked |
| E-N-10 | Reorder pages by drag → new order persists |
| E-N-11 | Export notes → ZIP downloaded |

### 3.7 Attachment uploads (`attachments.spec.js`)

| # | Scenario |
|---|---|
| E-AT-1 | Open card edit modal → upload file → file listed in attachment panel |
| E-AT-2 | Upload file to card → markdown reference (`attachment:filename`) auto-inserted in description |
| E-AT-3 | Card upload indicator: label shows `Uploading…` while POST is in-flight; restores to `+ Upload` after |
| E-AT-4 | Upload file to note page → markdown image reference (`![...](\_attachments/...)`) auto-inserted in description |
| E-AT-5 | Note page upload indicator: label shows `Uploading…` while POST is in-flight; restores to `+ Upload` after |

### 3.8 Settings & board management (`settings.spec.js`)

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
| E-ST-9 | Enable `trackedColumns` for a column title → overview card shows that column's count |
| E-ST-10 | Configure webhook (name + URL) → webhook button appears in board menu → click it → result dialog shown |
| E-ST-11 | Enable `autoSaveDialogs` → open card modal → wait for auto-save interval → modal saves automatically |

### 3.9 Markdown rendering (`markdown.spec.js`)

| # | Scenario |
|---|---|
| E-M-1 | Description with `**bold**` → `<strong>` in preview |
| E-M-2 | Description with `<script>` → stripped by DOMPurify |
| E-M-3 | Task list `- [ ] item` → interactive checkbox in preview |
| E-M-4 | Code block → copy button present |
| E-M-5 | `[toc]` in note description → table of contents rendered |
| E-M-6 | ~~`[subpages]` in note → child page titles rendered~~ — **removed**: pages no longer have children in v2; only folders contain items |

### 3.10 Import flow (`import.spec.js`)

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

**Phase 2.5 — Notes v2 per-operation API** ✓ complete
- [x] WebDAV config endpoints (WC-1–5)
- [x] Page operations (NP-1–14)
- [x] Folder operations (NF-1–7)
- [x] Sync (NS-1–4)
- [x] Unit: `buildNotesPatch` structural vs. content changes (NT-5–6, covered as NT-4e/4f)

**Phase 3 — E2E** ✓ complete
- [x] Auth, board CRUD, drag-drop, search E2E (sections 3.1–3.5)
- [x] Notes E2E (section 3.6)
- [x] Attachment upload indicator + description auto-insert E2E (section 3.7, E-AT-1..E-AT-5)

**Phase 3.5 — Missing API coverage** (identified after Phase 3)
- [x] Webhook config tests (section 1.8, WH-1..WH-10) — new `webhook.test.js`
- [x] Quick-add inbox endpoint (I-11..I-15, add to `import.test.js`)
- [x] Achievements API (B-13..B-15, add to `boards.test.js`)
- [x] PATCH /notes + ETag (N-13..N-17, add to `notes.test.js`)
- [x] `doneAt` field on markDone/markUndone actions (S-6, S-7 — update `state.test.js`)
- [x] Analytics unit tests (section 2.5, AN-1..AN-12) — new `analytics.test.js`

**Phase 4 — Reliability**
- [ ] Concurrency and edge cases (section 5)
- [ ] Settings and import E2E (sections 3.8–3.10) including webhook trigger and trackedColumns
- [ ] Visual regression snapshots

---

## 8. Test Data & Fixtures

Create `tests/fixtures/` with:

- `board-minimal.json` — one column, one card, no optional fields
- `board-full.json` — multiple columns, cards with all fields, settings
- `notes-simple.json` — flat pages at root, no folders (`schemaVersion: 2`)
- `notes-nested.json` — folders containing pages, one level of nesting (`schemaVersion: 2`)
- `import-plain.json` — plain array for import
- `import-classified.json` — `{ relevant, excluded }` format
- `import-jobs.json` — job-application objects

Each fixture should be self-contained and stable (no dynamic dates unless test injects them).

---

## 9. Keeping Coverage Current

### 9.1 Update this doc before coding

Treat `concepts/test-concept.md` as a spec, not a retrospective. When planning a new feature, add the test case rows here *first* — even as stubs. This makes gaps visible during review and forces thinking about the contract before the implementation.

### 9.2 Write tests alongside the feature, not after

Each feature commit should include both the implementation and its tests. The gaps found during Phase 3.5 (webhook config, achievements endpoint, `/inbox` endpoint) all share the same root cause: the code shipped in one phase and tests were deferred to a later one that never had the same priority. Treat tests as part of the definition of done.

### 9.3 Run the full suite before every release

Before cutting a version tag, always run `/test` to confirm the full suite (unit + E2E) passes. The `/release` skill asks this as a first step. If tests fail, fix them before bumping the version — a tagged release should be a known-good state.

### 9.4 Use this doc as a release checklist

Before tagging, scan the phasing section for any `[ ]` items related to the changes being released. If a feature is shipping, its corresponding test rows should be checked. A 30-second scan is enough; no automation required.

### 9.5 Keep the test skill in sync

When new spec files are added or selectors change, update `.claude/skills/test/SKILL.md` (the E2E file table and key selectors section) at the same time. The skill drives test failure diagnosis — stale docs cause unnecessary debugging time.
