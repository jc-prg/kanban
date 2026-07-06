# Recurring Tasks — Concept

Boards can define **recurring task templates** that automatically create a card at scheduled
intervals. Examples: a weekly review card every Monday, a monthly report reminder on the 1st,
or a yearly renewal reminder each April 15.

---

## Scope

### In scope
- Define recurring templates per board: card text, description, color, priority, link,
  target column
- Recurrence types: daily, weekly (specific weekday(s)), every N weeks on a specific day,
  monthly (specific day-of-month), yearly (specific month + day)
- Configurable `interval` (every N units, e.g. every 2 weeks)
- Start date (inclusive) and optional end date (inclusive)
- Enable/disable toggle per task without deleting it
- Automatic card creation triggered server-side (no browser required)
- Catchup on server restart: missed occurrences within the last 30 days each create a card
- Manual trigger via API (for testing / immediate creation)
- Settings UI within the existing board settings dialog

### Out of scope
- Per-card recurrence (recurrence attached to an existing card rather than a template)
- "Relative" monthly rules like "last Friday of the month" — fixed day-of-month only
- Recurrence exceptions (skip individual occurrences)
- RRULE / iCal import-export of recurrence rules
- Notifications or reminders (card creation is the notification)

---

## Recurrence types

| Type | Controls | Example |
|---|---|---|
| `daily` | `interval` | Every 3 days |
| `weekly` | `interval`, `daysOfWeek` (array, 0=Sun…6=Sat) | Every Monday and Wednesday |
| `monthly` | `interval`, `dayOfMonth` (1–31; clamped to last day if month is shorter) | 1st of every month |
| `yearly` | `interval`, `month` (1–12), `dayOfMonth` (1–31; clamped to last day if month is shorter) | Every April 15 |

`interval` defaults to 1.
For `weekly`, `daysOfWeek` must contain at least one entry.

---

## Data model

### Document `_id: "recurring-tasks"` per board

Stored as a separate CouchDB document in the board's `jc-kanban-<name>` database alongside the
`board` and `notes` documents. This keeps it decoupled from the board state document and avoids
size growth in the critical `PATCH /api/:board/board` path.

```jsonc
{
  "_id": "recurring-tasks",
  "_rev": "…",
  "tasks": [
    {
      "id": "rt-<hex12>",          // uid() — same generator as card IDs
      "enabled": true,
      "card": {
        "text": "Weekly review",   // required; card title text
        "description": "",         // optional Markdown
        "color": "#10b981",        // optional
        "priority": 2,             // optional 1–5
        "link": ""                 // optional http/https
      },
      "targetColumn": "Todo",      // column title (case-insensitive match at runtime)
      "recurrence": {
        "type": "weekly",          // "daily" | "weekly" | "monthly" | "yearly"
        "interval": 1,             // every N units (default 1)
        "daysOfWeek": [1],         // weekly only — array of 0–6 (0=Sun)
        "dayOfMonth": null,        // monthly/yearly — 1–28
        "month": null              // yearly only — 1–12
      },
      "startDate": "2026-01-01",   // YYYY-MM-DD, inclusive
      "endDate": null,             // YYYY-MM-DD or null (no end)
      "lastCreatedDate": "2026-06-30",  // YYYY-MM-DD of last card creation; null if never run
      "nextDueDate": "2026-07-07"  // YYYY-MM-DD precomputed; updated after each run
    }
  ]
}
```

`nextDueDate` is always kept in sync server-side after each creation run. It is used as the
fast check to avoid iterating recurrence rules on every tick.

The `id` prefix `rt-` distinguishes recurring task IDs from card IDs (`id-`) and note IDs
(`n-`), though they never share the same namespace in practice.

---

## Backend

### New module `backend/recurring.js`

Exports:

#### `computeNextDueDate(task, afterDate)`

Pure function. Given a task object and a reference date (e.g. today or `lastCreatedDate`),
returns the next `YYYY-MM-DD` string on which a card should be created, or `null` if the task
has no future occurrence (past `endDate`).

Algorithm per type:
- **daily**: `afterDate + interval days`
- **weekly**: starting from `afterDate + 1 day`, walk forward until a day whose `getDay()`
  is in `daysOfWeek`; if `interval > 1`, advance by `interval` full weeks from the last
  matched week boundary before doing the day-of-week scan
- **monthly**: next occurrence of `dayOfMonth` in the next `interval` months after the month
  containing `afterDate`; if the target month has fewer days than `dayOfMonth`, use the last
  day of that month (e.g. day=31 in February → Feb 28/29)
- **yearly**: next occurrence of `month/dayOfMonth` in the next `interval` years after the
  year containing `afterDate`; same last-day-of-month clamping as monthly

Clamps to `startDate` if no prior run exists (`lastCreatedDate === null`).
Returns `null` if the computed date exceeds `endDate`.

#### `getDueDates(task, from, to)`

Returns all due dates in the half-open interval `[from, to)` as an array of `YYYY-MM-DD`
strings. Used for catchup (from = server start minus 30 days, to = today + 1).

#### `createDueCards(db, task, dueDates, boardState)`

Given a CouchDB `nano` db handle, a task, an array of due dates (sorted ascending), and the
current board state document, inserts **one card** into the target column regardless of how
many due dates are in the array, then saves the board document. Returns
`{ created: number, skipped: number }`.

When `dueDates.length > 1`, the card's `description` field has `" (Nx missed)"` appended,
where N = `dueDates.length` (the total count including today). When `dueDates.length === 1`
the description is unchanged.

Deduplication: a card is skipped if the target column already contains a card with the same
`text` value AND a `created` date equal to today. This prevents double-creation if the server
restarts mid-processing on the same day.

If the named `targetColumn` does not exist, the card is placed in the inbox column. The
inbox column is identified by the same logic used elsewhere in the app: the column whose
title starts with `"Inbox"` (case-insensitive), preferring the first such column. If no
inbox column exists either, the card falls back to the first column. The target column match
is case-insensitive.

#### `runRecurringCheck()`

Top-level function called by the scheduler. Steps:
1. List all board names via `getBoardDb` helper (iterates `jc-kanban-*` databases).
2. For each board: load the `recurring-tasks` document (skip if absent).
3. For each enabled task with `nextDueDate <= today`:
   a. Collect all due dates from `lastCreatedDate` (or `startDate`) up to and including today
      via `getDueDates`; the lookback window is 30 days.
   b. Load the board document; call `createDueCards` (creates exactly one card; appends
      missed count to description when > 1 due date was found).
   c. Update the task: `lastCreatedDate = today`, `nextDueDate = computeNextDueDate(task, today)`.
4. Save the updated `recurring-tasks` document if any tasks were modified.
5. Log created/skipped counts.

#### `initRecurring()`

Called once on server startup (in `server.js` after `initDb`). Runs an immediate
`runRecurringCheck()`, then schedules the next run for the following midnight
(`setTimeout` → `setInterval` at 24 h). The midnight calculation is:

```js
function msUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight - now;
}
```

After the first midnight trigger, `setInterval(runRecurringCheck, 24 * 60 * 60 * 1000)` keeps
it running daily. This ensures cards are created at the start of each calendar day regardless
of when the server was started.

### New routes (`backend/routes/recurring.js`)

Mounted under `/:board` in `server.js` (same scope as board routes).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/:board/recurring-tasks` | Load the `recurring-tasks` document; returns `{ tasks: [] }` if absent |
| `PUT` | `/api/:board/recurring-tasks` | Full replace of the tasks array; recomputes `nextDueDate` for each task server-side |
| `POST` | `/api/:board/recurring-tasks/:id/run` | Immediately run a single task (create cards for today if due or overdue); useful for testing |

All routes require `authenticate` middleware. `PUT` and `POST` also require `writeRateLimit`.

#### `PUT /api/:board/recurring-tasks`

Request body:
```jsonc
{
  "tasks": [ /* array of task objects */ ]
}
```

Server steps:
1. Validate with `validateRecurringTasks` (AJV schema).
2. For each task: if `id` is absent, assign `uid()`. Recompute `nextDueDate` from
   `lastCreatedDate` (or `startDate`).
3. Upsert the `recurring-tasks` document via `db.insert` (includes `_rev` for updates).
4. Return `{ ok: true, tasks: [...] }` with the updated task array.

#### `POST /api/:board/recurring-tasks/:id/run`

Runs the named task immediately (regardless of `nextDueDate`), creates a card for today,
and returns `{ created, skipped }`. Does not update `nextDueDate` (the regular scheduler
handles that on next tick). Used from the UI's "Run now" button.

### Validation (`backend/schemas.js`)

Add `validateRecurringTasks`:

```jsonc
{
  "type": "object",
  "required": ["tasks"],
  "properties": {
    "tasks": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "required": ["card", "targetColumn", "recurrence", "startDate"],
        "properties": {
          "id":           { "type": "string", "pattern": "^rt-[a-z0-9]{1,12}$" },
          "enabled":      { "type": "boolean" },
          "card": {
            "type": "object",
            "required": ["text"],
            "properties": {
              "text":        { "type": "string", "minLength": 1, "maxLength": 300 },
              "description": { "type": "string", "maxLength": 10000 },
              "color":       { "type": "string", "maxLength": 20 },
              "priority":    { "type": "integer", "minimum": 1, "maximum": 5 },
              "link":        { "type": "string", "maxLength": 2000 }
            },
            "additionalProperties": false
          },
          "targetColumn": { "type": "string", "minLength": 1, "maxLength": 200 },
          "recurrence": {
            "type": "object",
            "required": ["type"],
            "properties": {
              "type":       { "enum": ["daily", "weekly", "monthly", "yearly"] },
              "interval":   { "type": "integer", "minimum": 1, "maximum": 365 },
              "daysOfWeek": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 }, "minItems": 1, "maxItems": 7 },
              "dayOfMonth": { "type": "integer", "minimum": 1, "maximum": 31 },
              "month":      { "type": "integer", "minimum": 1, "maximum": 12 }
            },
            "additionalProperties": false
          },
          "startDate":        { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
          "endDate":          { "type": ["string", "null"], "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
          "lastCreatedDate":  { "type": ["string", "null"], "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
          "nextDueDate":      { "type": ["string", "null"], "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

Cross-field validation in the route handler:
- `weekly` tasks must have `daysOfWeek` with at least one entry
- `monthly` tasks must have `dayOfMonth`
- `yearly` tasks must have both `month` and `dayOfMonth`
- `endDate`, if present, must be >= `startDate`

---

## Frontend

### Settings dialog — new section

A new "Recurring tasks" section is appended to the existing board settings dialog
(`#settingsDialog`). It follows the same visual pattern as other settings sections.

```
Recurring tasks                                       [+ Add task]
┌──────────────────────────────────────────────────────────────────┐
│  [●] Weekly review     weekly Mon     → next: 2026-07-07  [✎][✕]│
│  [○] Monthly report    monthly 1st    → next: 2026-08-01  [✎][✕]│
│  [●] Annual renewal    yearly Apr 15  → next: 2027-04-15  [✎][✕]│
└──────────────────────────────────────────────────────────────────┘
```

- `[●]` / `[○]` — toggle button; filled = enabled, empty = disabled
- Next due date shown as relative (`tomorrow`, `in 3 days`) if within 7 days, otherwise
  as `MMM DD` or `MMM DD, YYYY` for future years
- `[✎]` — opens the edit form for this task
- `[✕]` — deletes with a confirm dialog
- `[+ Add task]` — opens the add form (blank)

### Add/Edit form (inline, below the list)

Opens inline within the settings dialog, similar to the add-column/add-card inputs.

```
┌──────────────────────────────────────────────────────────────────┐
│  Card text   [                                                 ]  │
│  Description [                                                 ]  │
│  Color       [●][●][●][●][●]                                     │
│  Priority    [1][2][3][4][5]                                      │
│  Link        [                                                 ]  │
│                                                                   │
│  Target column  [Todo              ▾]                             │
│                                                                   │
│  Repeats        [Weekly            ▾]                             │
│  Every          [1] week(s)                                       │
│  On             [Mon][Tue][Wed][Thu][Fri][Sat][Sun]               │
│         (shown for weekly; day-of-month picker for monthly/yearly)│
│                                                                   │
│  Start date  [2026-07-01]                                         │
│  End date    [          ]  (optional)                             │
│                                                                   │
│                              [Cancel]  [Save task]                │
└──────────────────────────────────────────────────────────────────┘
```

The recurrence controls adapt to the selected type:
- **Daily**: "Every [N] day(s)" — no day selector
- **Weekly**: "Every [N] week(s) on [day toggles]"
- **Monthly**: "Every [N] month(s) on day [1–28]" — numeric input or small select
- **Yearly**: "Every [N] year(s) on [month ▾] [day 1–28]"

The Target column dropdown is populated from the current board's column titles.

### State management

Recurring tasks are loaded and saved separately from the board state.

New frontend module `app/frontend/recurring.js` (loaded after `settings.js`):

| Function | Description |
|---|---|
| `loadRecurringTasks()` | `GET /api/:board/recurring-tasks`; stores in module-level `_recurringTasks` |
| `saveRecurringTasks()` | `PUT /api/:board/recurring-tasks` with `_recurringTasks`; debounced by 300 ms |
| `openRecurringForm(task?)` | Opens the add/edit form; null = add mode |
| `submitRecurringTask()` | Validates and upserts into `_recurringTasks`, calls `saveRecurringTasks()` |
| `toggleRecurringTask(id)` | Flips `enabled`; calls `saveRecurringTasks()` |
| `deleteRecurringTask(id)` | Removes from array after confirm; calls `saveRecurringTasks()` |
| `renderRecurringList()` | Rebuilds the task list DOM inside the settings section |
| `formatNextDue(dateStr)` | Returns human-readable relative/absolute label |
| `runTaskNow(id)` | `POST /api/:board/recurring-tasks/:id/run`; shows toast with result |

`loadRecurringTasks()` is called from `afterAuth` alongside board load, so the settings dialog
always has current data when opened.

### New HTML (`index.html`)

A new `<section id="settingsRecurring">` block is added inside `#settingsDialog`, after the
existing board-level settings fields:

```html
<section id="settingsRecurring">
  <h3 class="settings-section-title">Recurring tasks
    <button class="btn btn-small" id="addRecurringBtn">+ Add task</button>
  </h3>
  <ul id="recurringList" class="recurring-list"></ul>
  <div id="recurringForm" class="recurring-form" hidden>
    <!-- form fields — see above -->
  </div>
</section>
```

---

## Catchup and missed-occurrence policy

When the server starts (or after extended downtime), `runRecurringCheck()` creates **at most
one card per task** regardless of how many occurrences were missed. The missed count is
computed and appended to the card's description so the user knows how many were skipped.

Format appended to `card.description`:
```
 (3x missed)
```
(a single space, then `(Nx missed)` where N is the total number of due dates in the lookback
window including today's; omitted when N=1, i.e. only the current due date was missed).

Example: a daily task missed for 4 days creates one card with `" (4x missed)"` appended to
its description, not 4 separate cards.

The lookback window is **30 calendar days**. Occurrences older than 30 days are not counted.

- A task that was disabled (`enabled: false`) generates no cards regardless.
- The `lastCreatedDate` is always updated to today after catchup, so the next scheduled run
  advances correctly from today, not from the oldest missed date.
- The `created` field on the card is set to today (not the first missed date), consistent
  with how cards created interactively are dated.

---

## Security

- All routes require `authenticate` middleware.
- `PUT` and `POST /run` use `writeRateLimit`.
- The `targetColumn` value is treated as a search key against the board's existing columns;
  it is never used as a filesystem path or injected into queries unescaped.
- Card `link` is validated against the same `http/https`-only pattern used elsewhere.
- Maximum 50 tasks per board (enforced by schema `maxItems: 50`).
- Card text and description pass through the same `escHtml` sanitisation used by all other
  card renders on the frontend; no raw HTML is interpolated.
- `POST /api/:board/recurring-tasks/:id/run` validates the `:id` matches a task in the board's
  document before acting, preventing enumeration attacks.

---

## API summary

| Method | Path | Auth | Rate limit | Description |
|---|---|---|---|---|
| `GET` | `/api/:board/recurring-tasks` | yes | — | List all tasks |
| `PUT` | `/api/:board/recurring-tasks` | yes | writeRateLimit | Replace tasks array |
| `POST` | `/api/:board/recurring-tasks/:id/run` | yes | writeRateLimit | Run one task now |

---

## Implementation phases

### Phase 1 — Backend core

1. Add `computeNextDueDate(task, afterDate)` and `getDueDates(task, from, to)` to
   `backend/recurring.js`.
2. Add `createDueCards(db, task, dueDates, boardState)`.
3. Add `runRecurringCheck()` and `initRecurring()`.
4. Add `validateRecurringTasks` schema to `schemas.js`.
5. Add `GET`, `PUT` routes in `backend/routes/recurring.js`; mount in `server.js`.
6. Call `initRecurring()` in `server.js` after `initDb`.

### Phase 2 — Run-now endpoint + frontend

1. Add `POST /api/:board/recurring-tasks/:id/run` route.
2. Add `recurring.js` frontend module with all functions listed above.
3. Add HTML section to `index.html` and CSS to `settings.css` (or `overlay.css`).
4. Wire `loadRecurringTasks()` into `afterAuth`.

### Phase 3 — Polish

- "Run now" button with toast feedback.
- Inline validation in the form (required text, valid dates, weekday required for weekly).
- Keyboard: Enter submits form, Escape cancels.
- Next-due refresh after saving (recalculate `nextDueDate` client-side for instant feedback
  before server response).

---

## Tests

Follows `concepts/test-concept.md` conventions. Tests are written alongside the feature.

### Unit tests (`tests/unit/recurring.test.js`)

Pure function tests — no DB, no server.

| # | Test | Expected |
|---|---|---|
| RC-1 | `computeNextDueDate` daily, interval=1, lastCreated=Mon | Returns Tue |
| RC-2 | `computeNextDueDate` daily, interval=3, lastCreated=Mon | Returns Thu |
| RC-3 | `computeNextDueDate` weekly Mon, lastCreated=Mon | Returns next Mon (+7 days) |
| RC-4 | `computeNextDueDate` weekly Mon+Wed, lastCreated=Mon | Returns Wed same week |
| RC-5 | `computeNextDueDate` weekly interval=2 Mon, lastCreated=Mon | Returns Mon +14 days |
| RC-6 | `computeNextDueDate` monthly day=15, lastCreated=Jul 15 | Returns Aug 15 |
| RC-7 | `computeNextDueDate` monthly interval=3 day=1, lastCreated=Jan 1 | Returns Apr 1 |
| RC-8 | `computeNextDueDate` yearly Apr 15, lastCreated=Apr 15 2026 | Returns Apr 15 2027 |
| RC-9 | `computeNextDueDate` yearly interval=2 Apr 15, lastCreated=Apr 15 2026 | Returns Apr 15 2028 |
| RC-10 | `computeNextDueDate` daily, result exceeds `endDate` | Returns null |
| RC-11 | `computeNextDueDate` task never run (`lastCreatedDate=null`), startDate=future | Returns startDate |
| RC-12 | `computeNextDueDate` task never run, startDate=past | Returns first occurrence >= startDate |
| RC-13 | `getDueDates` daily, interval=1, from=Mon, to=Fri | Returns Mon, Tue, Wed, Thu |
| RC-14 | `getDueDates` weekly Mon, from=Tue, to=Mon+14 | Returns two Mondays |
| RC-15 | `getDueDates` monthly day=31, month=Feb | Returns 28th (or 29th in leap year) |
| RC-15b | `getDueDates` monthly day=31, month=Apr | Returns 30th |
| RC-16 | `getDueDates` with endDate mid-range | Only returns dates up to endDate |
| RC-17 | `getDueDates` disabled task | Returns empty array (caller responsibility; tested for clarity) |

### API tests (`tests/api/recurring.test.js`)

| # | Test | Expected |
|---|---|---|
| RC-A1 | `GET /api/:board/recurring-tasks` — no document exists | 200 `{ tasks: [] }` |
| RC-A2 | `PUT` valid task array | 200; re-GET returns same tasks with server-assigned `nextDueDate` |
| RC-A3 | `PUT` invalid schema (missing `card.text`) | 400 |
| RC-A4 | `PUT` weekly task missing `daysOfWeek` | 400 cross-field validation error |
| RC-A5 | `PUT` monthly task missing `dayOfMonth` | 400 |
| RC-A6 | `PUT` yearly task missing `month` | 400 |
| RC-A7 | `PUT` `endDate` before `startDate` | 400 |
| RC-A8 | `PUT` > 50 tasks | 400 |
| RC-A9 | `POST /recurring-tasks/:id/run` — task due today | 200 `{ created: 1, skipped: 0 }`; card appears in board |
| RC-A10 | `POST /recurring-tasks/:id/run` — card already exists today (dedup) | 200 `{ created: 0, skipped: 1 }` |
| RC-A11 | `POST /recurring-tasks/:id/run` — unknown id | 404 |
| RC-A12 | `POST /recurring-tasks/:id/run` — disabled task | 400 `{ error: "task is disabled" }` |
| RC-A13 | `GET`, `PUT`, `POST /run` — unauthenticated | 401 |
| RC-A14 | `POST /run` — targetColumn not found, inbox column exists → card in inbox column | 200; card in inbox column |
| RC-A15 | `POST /run` — targetColumn not found, no inbox column → card in column[0] | 200; card in column[0] |
| RC-A16 | `POST /run` — task with 3 missed dates (lastCreatedDate 3 days ago) → single card with `" (3x missed)"` in description | 200 `{ created: 1 }`; card description ends with `" (3x missed)"` |
| RC-A17 | `POST /run` — task due exactly today (no missed) → card description unchanged | 200; no `" (Nx missed)"` appended |

### E2E tests (`tests/e2e/recurring.spec.js`)

| # | Scenario |
|---|---|
| E-RC-1 | Open settings → "Recurring tasks" section visible; empty state shown |
| E-RC-2 | Click "+ Add task" → form appears; fill in weekly Monday task; Save → appears in list with next-due label |
| E-RC-3 | Toggle task off → indicator changes to disabled; toggle back on |
| E-RC-4 | Edit a task → form pre-filled; change interval; Save → list updates |
| E-RC-5 | Delete a task → confirm dialog → task removed from list |
| E-RC-6 | "Run now" button on enabled task → card appears in target column on the board |
| E-RC-7 | Set end date in the past → task shown as "expired" in list (no next-due date) |
| E-RC-8 | "Run now" button on disabled task → 400 error toast shown; no card created |
| E-RC-9 | Task with `lastCreatedDate` 3 days ago → "Run now" → created card's description ends with "(3x missed)" |

---

## Resolved design decisions

1. **`POST /run` on a disabled task** — returns 400 `{ error: "task is disabled" }`. The
   caller (UI "Run now" button) always knows the enabled state before calling; a 400 is
   the clearest signal and prevents accidental triggering via direct API calls.

2. **Monthly/yearly day > 28** — `dayOfMonth` accepts 1–31. When the target month has fewer
   days, the last day of that month is used (e.g. Jan 31 → Feb 28/29 → Mar 31). This
   enables natural "end of month" patterns without a separate concept.

3. **Target column not found** — falls back to the inbox column (first column whose title
   starts with `"Inbox"`, case-insensitive). If no inbox column exists, falls back to the
   first column. No error is raised; the card is always created somewhere visible.

4. **Catchup granularity** — creates exactly one card per task per catchup run regardless
   of missed count. The number of missed occurrences is appended to the card description as
   `" (Nx missed)"` (omitted when N=1). `lastCreatedDate` advances to today so scheduling
   continues correctly from today.

5. **Board export/import** — the `recurring-tasks` document is included in any future
   board backup/export feature alongside the `board` and `notes` documents.
