# Dashboard — Concept

A new read-only aggregation view accessible from the header/overview. Shows emails from IMAP
inboxes, cards from selected boards/columns, and upcoming calendar events from CalDAV/iCal
sources — all managed via global settings.

---

## Dashboard layout

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  ◎ DASHBOARD                                                        [⚙ Settings]    │
├──────────────────────┬───────────────────────────┬──────────────────────────────────┤
│  📧 MAIL              │  📋 CARDS                   │  📅 CALENDAR                      │
│                      │                            │                                  │
│  work@example.com    │  Jobs · Inbox (5)          │  ◷ Today  Tue 1 Jul 2026         │
│  ──────────────────  │  ────────────────────────  │  ──────────────────────────────  │
│  ● Meeting prep      │  ▸ Apply at Acme Corp      │  10:00  Team Standup             │
│    Jane Doe  10:23   │  ▸ Review portfolio        │         (calendar: Work)         │
│  ● Re: Project upd.  │  ▸ Send CV to XYZ Ltd      │  14:30  Client Call              │
│    Tom Smith 09:45   │                            │  16:00  Sprint Review            │
│  ● Invoice #1042     │  Tasks · In Progress (2)   │                                  │
│    accounts@ 09:12   │  ────────────────────────  │  ◷ Tomorrow  Wed 2 Jul           │
│  [3 more…]           │  ▸ Write quarterly report  │  ──────────────────────────────  │
│                      │    ⚑ P1  📎  due Jul 5     │  09:00  Doctor appointment       │
│  personal@mail.de    │  ▸ Fix bug #42             │         (calendar: Personal)     │
│  ──────────────────  │                            │  11:00  Project Review           │
│  ● Weekend plans     │                            │                                  │
│    Anna    08:30     │                            │  ◷ This week                     │
│  ● Parcel tracking   │                            │  ──────────────────────────────  │
│    DHL     yesterday │                            │  Thu  09:30  Dentist             │
│                      │                            │  Fri  14:00  Team offsite        │
└──────────────────────┴───────────────────────────┴──────────────────────────────────┘
```

**Column rules:**
- Three columns, equal width; each scrolls independently if content overflows.
- MAIL groups messages by account. CARDS groups by board → column. CALENDAR groups by day.
- Header shows the section icon and title; `[⚙ Settings]` opens the dashboard settings pane.
- A manual **Refresh** button (and optional auto-refresh interval, e.g. 5 min) triggers a
  server-side re-fetch from all external sources.

---

## Detail views

Clicking a mail message or calendar event opens a detail panel (slide-in overlay on the
right side, or a modal on narrow screens). Cards already have the existing edit modal.

### Mail detail

```
┌──────────────────────────────────────────────────────────┐
│  ✉ Meeting prep                               [✕ Close]  │
│  ──────────────────────────────────────────────────────  │
│  From:     Jane Doe <jane@example.com>                   │
│  To:       me@work.com                                   │
│  Date:     Tue 1 Jul 2026, 10:23                         │
│  Subject:  Meeting prep for Thursday                     │
│  ──────────────────────────────────────────────────────  │
│                                                          │
│  Hi,                                                     │
│  just a quick reminder about the prep tasks for our      │
│  Thursday session. Please review the attached agenda…    │
│                                                          │
│  Attachments: agenda.pdf (42 KB)                         │
│  ──────────────────────────────────────────────────────  │
│  Account: work@example.com                               │
│                          [Open in Webmail ↗] [✕ Close]  │
└──────────────────────────────────────────────────────────┘
```

Shown fields (all optional — only rendered when present):
`from`, `to`, `cc`, `date`, `subject`, plain-text body (first ~50 lines), attachment names
and sizes (no download — read-only). "Open in Webmail" links to the account's configured
web interface URL, opened in a new tab.

### Calendar event detail

```
┌──────────────────────────────────────────────────────────┐
│  📅 Team Standup                              [✕ Close]  │
│  ──────────────────────────────────────────────────────  │
│  When:      Tue 1 Jul 2026, 10:00 – 10:30               │
│  Where:     https://meet.example.com/standup             │
│  Calendar:  Work (alice@example.com)                     │
│  Status:    Confirmed · Organiser: Bob Smith             │
│  ──────────────────────────────────────────────────────  │
│  Description:                                            │
│  Daily sync — bring blockers and status updates.         │
│  Agenda: https://docs.example.com/standup-notes          │
│  ──────────────────────────────────────────────────────  │
│                      [Open in Calendar ↗] [✕ Close]     │
└──────────────────────────────────────────────────────────┘
```

Shown fields: `SUMMARY`, `DTSTART`/`DTEND`, `LOCATION`, calendar label + account user,
`STATUS`, `ORGANIZER`, `DESCRIPTION`. "Open in Calendar" links to the account's configured
web interface URL, opened in a new tab.

---

## Settings UI

A new "Dashboard" section in the global Settings dialog (accessible from the header ⚙ icon,
same entry point used for prompts today):

```
Dashboard Settings
──────────────────────────────────────────────────────────────────────────
Mail accounts                                              [+ Add account]
  ┌─────────────────────────────────────────────────────────────────────┐
  │  work@example.com   imap.example.com:993  INBOX   [Edit] [Delete]  │
  │  personal@mail.de   mail.de:993           INBOX   [Edit] [Delete]  │
  └─────────────────────────────────────────────────────────────────────┘
  Account form fields:
    Label, IMAP host, port, TLS toggle, username, password
    Web interface URL: [https://mail.example.com          ]
      → shown as "Open in Webmail ↗" button in the mail detail view
  Max messages per account: [20 ▾]

Card sources                                               [+ Add source]
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Board: jobs     Columns: Inbox, Applied        [Edit] [Delete]    │
  │  Board: tasks    Columns: In Progress           [Edit] [Delete]    │
  └─────────────────────────────────────────────────────────────────────┘

Calendar accounts                                          [+ Add account]
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Work       https://cal.example.com/dav/  work@ex.  [Edit] [Delete]│
  │  Personal   https://ckloud.de/next/…      alice     [Edit] [Delete]│
  └─────────────────────────────────────────────────────────────────────┘
  Account form fields:
    Label, type (CalDAV / iCal URL), CalDAV URL, username, password
    Web interface URL: [https://ckloud.de/next/apps/calendar]
      → shown as "Open in Calendar ↗" button in the event detail view
  Show events for next: [7 days ▾]

Auto-refresh interval: [5 min ▾]   (off | 1 min | 5 min | 15 min | 30 min)
──────────────────────────────────────────────────────────────────────────
                                                    [Cancel]  [Save]
```

---

## Data model

### Global config document

Stored in a new CouchDB database `jc-kanban-global` as document `_id: "dashboard-config"`.
This is intentionally global (not per-board) — the same accounts feed all boards.

```jsonc
{
  "_id": "dashboard-config",

  "mailAccounts": [
    {
      "id": "ma-abc123",
      "label": "work@example.com",
      "host": "imap.example.com",
      "port": 993,
      "tls": true,
      "user": "work@example.com",
      "password": "...",        // stored server-side, never sent to browser
      "folder": "INBOX",
      "maxMessages": 20,
      "webInterfaceUrl": "https://mail.example.com"  // optional, shown as "Open in Webmail" link
    }
  ],

  "cardSources": [
    {
      "id": "cs-xyz789",
      "board": "jobs",
      "columns": ["Inbox", "Applied"]  // empty array = all columns
    }
  ],

  "calendarAccounts": [
    {
      "id": "ca-def456",
      "label": "Personal",
      "type": "caldav",              // "caldav" | "ical-url"
      "url": "https://ckloud.de/next/remote.php/dav/calendars/alice/personal/",
      "user": "alice",
      "password": "...",             // stored server-side, never sent to browser
      "lookaheadDays": 7,
      "webInterfaceUrl": "https://ckloud.de/next/apps/calendar"  // optional, shown as "Open in Calendar" link
    }
  ],

  "autoRefreshMs": 300000            // 0 = disabled
}
```

**Why a separate database?**
The prompts config today uses a flat JSON file (`extension-prompts.json`). For the dashboard
the config is structured and grows over time — a CouchDB document is a cleaner fit and keeps
all persistent state in one place. The `jc-kanban-global` database can host other future
global documents (audit log, global labels, etc.).

**Password handling:** passwords are stored in CouchDB server-side and are **never** returned
to the browser. The settings UI shows `••••••••` for existing accounts and only sends a
password when the user types a new value (empty string = keep existing).

---

## Backend

### New module: `backend/global-db.js`

Manages the `jc-kanban-global` CouchDB database: `initGlobalDb()`, `getDashboardConfig()`,
`saveDashboardConfig(doc)`. Called from `server.js` startup alongside `initDb`.

### New modules: `backend/dashboard/`

| File | Contents |
|---|---|
| `mail.js` | IMAP fetch: connect via `imapflow`, read N messages from the configured folder, return `[{ id, subject, from, date, preview }]`. Connections are opened per-request (read-only; no persistent connection needed). |
| `calendar.js` | CalDAV fetch: HTTP `PROPFIND`/`REPORT` the CalDAV collection, parse `.ics` resources with `ical.js`, filter to the lookahead window, return `[{ uid, title, start, end, location, calendarLabel }]`. |
| `cards.js` | Read board documents from existing CouchDB databases via `getBoardDb`, filter to configured columns, return normalised card summaries. |

### New route file: `backend/routes/dashboard.js`

All routes require authentication (same `authenticate` middleware as the rest of the API).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/config` | Returns config — **passwords omitted/masked** |
| `PUT` | `/api/dashboard/config` | Save config; merge passwords: if field is empty/absent, keep existing stored value |
| `GET` | `/api/dashboard/data` | Fetch all three data sources in parallel, return combined result |
| `GET` | `/api/dashboard/mail/:accountId` | Fetch mail for one account (per-panel refresh) |
| `GET` | `/api/dashboard/calendar/:accountId` | Fetch calendar for one account (per-panel refresh) |
| `GET` | `/api/dashboard/cards` | Return aggregated card data from all configured sources |
| `GET` | `/api/dashboard/mail/:accountId/message/:uid` | Fetch full message: headers + plain-text body + attachment list |
| `GET` | `/api/dashboard/calendar/:accountId/event/:uid` | Fetch full event fields for a single UID |
| `POST` | `/api/dashboard/mail/:accountId/test` | Test IMAP connection; returns `{ ok, error? }` |
| `POST` | `/api/dashboard/calendar/:accountId/test` | Test CalDAV connectivity; returns `{ ok, error? }` |

`GET /api/dashboard/data` response shape:

```jsonc
{
  "mail": [
    {
      "accountId": "ma-abc123",
      "label": "work@example.com",
      "messages": [
        { "id": "…", "subject": "Meeting prep", "from": "Jane Doe", "date": "…", "preview": "…" }
      ],
      "error": null      // or error string if fetch failed
    }
  ],
  "cards": [
    {
      "sourceId": "cs-xyz789",
      "board": "jobs",
      "column": "Inbox",
      "cards": [
        { "id": "id-abc", "text": "Apply at Acme", "priority": 1, "color": "#10b981",
          "endDate": "2026-07-05", "hasAttachments": false }
      ]
    }
  ],
  "calendar": [
    {
      "accountId": "ca-def456",
      "label": "Personal",
      "events": [
        { "uid": "…", "title": "Dentist", "start": "2026-07-03T09:00:00",
          "end": "2026-07-03T10:00:00", "location": "" }
      ],
      "error": null
    }
  ],
  "fetchedAt": "2026-07-01T10:00:00Z"
}
```

Errors in one source (e.g. IMAP unreachable) are isolated in that source's `error` field;
the other panels still render. The server fetches all sources via `Promise.allSettled` with
a per-source timeout of 10 s.

---

## Frontend

### New files

| File | Contents |
|---|---|
| `frontend/dashboard.js` | Dashboard state, fetch logic (`loadDashboard`, `scheduleDashboardRefresh`), render functions for all three panels. |
| `frontend/styles/dashboard.css` | Dashboard grid layout, panel styles, mail/event/card item styles. |

### Routing

The frontend is a single-page app with the active view controlled by `window.location.hash`.
The dashboard becomes a third top-level view:

| Hash | View |
|---|---|
| `` (empty) | Overview grid |
| `#board:<name>` | Board view |
| `#dashboard` | Dashboard view |

`init.js` / `settings.js` (`afterAuth`) reads the hash and calls the appropriate init
function.

### Navigation entry points

The dashboard is reachable from two places, each covering a different context:

#### 1. `headerHomeBtn` board-switch menu (board view)

In board view, `.board-switch-wrap` is shown and `headerHomeBtn` opens the
`boardSwitchMenu` dropdown (quick board switcher). **Dashboard is prepended as the first
entry** in that dropdown, above the board list:

```
┌──────────────────┐
│  ◎ Dashboard     │  ← new first entry (links to #dashboard)
│  ─────────────  │
│  ● jobs          │
│  ● tasks         │
│  ● personal      │
└──────────────────┘
```

HTML addition inside `#boardSwitchMenu` (rendered by `initBoardSwitchMenu()`):

```html
<a class="board-switch-item board-switch-dashboard" href="#dashboard">
  Dashboard
</a>
<div class="board-switch-separator"></div>
<!-- existing board entries follow -->
```

#### 2. Dashboard icon button in the overview (global view)

In the overview, `.board-switch-wrap` is hidden (`display:none`). A new standalone
icon button `#dashboardBtn` is added to `.header-menu`, **positioned to the left of
`#headerMenuBtn`**:

```html
<!-- existing: notesToggleBtn (hidden in overview) -->
<!-- existing: board-switch-wrap (hidden in overview) -->
<a class="header-menu-btn" id="dashboardBtn" href="#dashboard" title="Dashboard">
  <span data-icon="dashboard" ...></span>
</a>
<!-- existing: headerMenuBtn -->
```

The button uses the same `.header-menu-btn` style as `headerHomeBtn`. It is hidden in
board view (where `headerHomeBtn`'s dropdown already provides the Dashboard entry) and
shown only when the overview is active — mirroring the inverse visibility logic of
`.board-switch-wrap`.

#### Visibility matrix

| Element | Overview | Board view | Dashboard view |
|---|---|---|---|
| `#dashboardBtn` (new icon) | **visible** | hidden | hidden |
| `.board-switch-wrap` (`headerHomeBtn`) | hidden | visible | hidden |
| Dashboard entry in `boardSwitchMenu` | — | **visible (first)** | — |

#### `headerDropdown` (hamburger menu)

A `menuDashboard` entry is also added as the **first item** in the existing `#headerDropdown`,
visible on all views:

```html
<button class="header-dd-item" id="menuDashboard">Dashboard</button>
<!-- existing: menuInbox, menuFindCard, … -->
```

### Detail panel

Clicking a mail item or calendar event calls a dedicated fetch endpoint
(`GET /api/dashboard/mail/:accountId/message/:uid` and `GET /api/dashboard/calendar/:accountId/event/:uid`)
that returns the full message body / event fields. The detail panel renders over the
dashboard without leaving the view. The `webInterfaceUrl` (if set) is passed through
as-is from the config and rendered as an `<a target="_blank">` link — it is never
validated or fetched server-side.

Cards keep their existing click behaviour (opens the edit modal).

### Refresh behaviour

- On `#dashboard` load: `loadDashboard()` calls `GET /api/dashboard/data`.
- If `autoRefreshMs > 0`: `setInterval(loadDashboard, autoRefreshMs)` while the view is active; cleared on navigation away.
- Manual refresh button in dashboard header triggers `loadDashboard()` immediately.
- A "last refreshed at HH:MM" indicator shows data freshness.
- Failed sub-sources show an inline error badge (`⚠ Could not reach imap.example.com`) without blocking other panels.

---

## npm dependencies (new)

| Package | Purpose |
|---|---|
| `imapflow` | IMAP client — modern async API, TLS built-in, well-maintained |
| `ical.js` | iCal / CalDAV event parsing (same library used by Nextcloud/Thunderbird) |

No new frontend dependencies — the dashboard renders with vanilla JS and the existing CSS
design tokens.

---

## Security

- All account credentials live only in CouchDB server-side and are never serialised into
  API responses.
- `GET /api/dashboard/config` strips all `password` fields before sending to the browser.
- `PUT /api/dashboard/config`: if the received account object has no `password` field (or an
  empty string), the server merges the existing stored password — identical to the WebDAV
  config pattern already in place.
- No email body content is stored; only subject + a short `preview` string (first 120 chars
  of the plain-text part) is returned to the frontend.
- CalDAV and IMAP fetches are entirely server-side — no credentials ever reach the browser.
- The same `authenticate` middleware protects all `/api/dashboard/*` routes.
- Rate limiting: PUT config covered by existing `writeRateLimit`; GET data routes get a new
  `dashboardRateLimit` (20 req/min) to prevent hammering external servers.

---

## Implementation phases

### Phase 1 — Infrastructure + Cards panel (no new npm deps)

1. Create `jc-kanban-global` database via `initGlobalDb()` on server startup.
2. Implement `GET /api/dashboard/config` and `PUT /api/dashboard/config`.
3. Implement `GET /api/dashboard/cards` reading from existing board databases.
4. Dashboard view skeleton in frontend: hash routing, three-column layout, settings dialog
   for card sources.
5. Render cards panel from API data.

### Phase 2 — Calendar panel

1. Add `ical.js` dependency.
2. Implement `backend/dashboard/calendar.js` — CalDAV PROPFIND + iCal parse + lookahead filter.
3. Add `GET /api/dashboard/calendar/:accountId` and `POST …/test` endpoint.
4. Integrate into `GET /api/dashboard/data`.
5. Render calendar panel; settings UI for calendar accounts.

### Phase 3 — Mail panel

1. Add `imapflow` dependency.
2. Implement `backend/dashboard/mail.js` — IMAP connect, fetch headers + preview.
3. Add `GET /api/dashboard/mail/:accountId` and `POST …/test` endpoint.
4. Integrate into `GET /api/dashboard/data`.
5. Render mail panel; settings UI for mail accounts.

### Phase 4 — Polish

- Auto-refresh toggle and interval selector in settings.
- Per-panel manual refresh button.
- Error state rendering (inline warning badge per failed source).
- Responsive layout: stack panels vertically on narrow screens.
- Connection-test buttons in the settings account forms.

---

## Tests

Follows the conventions of `concepts/test-concept.md`. New test files are added alongside
the feature implementation (section 9.2 of the test concept).

### Mock strategy

| Layer | Approach |
|---|---|
| IMAP (`imapflow`) | `vi.mock('imapflow')` — stub `ImapFlow` class; `connect`, `fetchOne`, `logout` return controlled data |
| CalDAV (`fetch`) | `vi.stubGlobal('fetch', ...)` — intercept PROPFIND / REPORT requests by URL pattern |
| CouchDB (`jc-kanban-global`) | Same `createApp` pattern as existing API tests — inject mock nano into `require.cache` before loading `global-db.js` |
| Board databases (card sources) | Reuse existing board mock; seed via `apiPut /api/:board/board` |

---

### API tests (`tests/api/dashboard.test.js`)

#### Global config

| # | Test | Expected |
|---|---|---|
| DB-1 | `GET /api/dashboard/config` — no config saved yet | 200 `{ mailAccounts: [], cardSources: [], calendarAccounts: [], autoRefreshMs: 0 }` |
| DB-2 | `PUT /api/dashboard/config` — valid config; then re-`GET` | 200 on PUT; GET returns saved structure |
| DB-3 | `GET /api/dashboard/config` — account with password saved | `password` field absent from response; `hasPassword: true` present |
| DB-4 | `PUT /api/dashboard/config` — update mail account, `password` field omitted | Existing stored password preserved; `hasPassword` still true |
| DB-5 | `PUT /api/dashboard/config` — update calendar account, `password: ""` | Existing stored password preserved |
| DB-6 | `GET /api/dashboard/config` — unauthenticated | 401 |
| DB-7 | `PUT /api/dashboard/config` — `webInterfaceUrl` on mail account | Saved; re-GET returns it (not sensitive, not stripped) |
| DB-8 | `PUT /api/dashboard/config` — `webInterfaceUrl` on calendar account | Saved; re-GET returns it |

#### Card sources

| # | Test | Expected |
|---|---|---|
| DB-9 | `GET /api/dashboard/cards` — card source references seeded board/column | 200, cards from that column returned |
| DB-10 | `GET /api/dashboard/cards` — column filter applied: only listed columns included | Cards from unlisted columns absent |
| DB-11 | `GET /api/dashboard/cards` — `columns: []` (all columns) | Cards from all columns returned |
| DB-12 | `GET /api/dashboard/cards` — board does not exist | Source entry returned with `error` field set; no 500 |

#### Mail

| # | Test | Expected |
|---|---|---|
| DB-13 | `GET /api/dashboard/mail/:accountId` — IMAP mock returns 3 messages | 200 `{ messages: [{ id, subject, from, date, preview }], error: null }` |
| DB-14 | `GET /api/dashboard/mail/:accountId` — IMAP mock throws connection error | 200 `{ messages: [], error: "…" }` (not 500) |
| DB-15 | `GET /api/dashboard/mail/:accountId/message/:uid` — IMAP mock returns full message | 200 `{ subject, from, to, cc, date, body, attachments }` |
| DB-16 | `GET /api/dashboard/mail/:accountId/message/:uid` — uid not found | 404 |
| DB-17 | `GET /api/dashboard/mail/:accountId` — unknown `accountId` | 404 |
| DB-18 | `POST /api/dashboard/mail/:accountId/test` — mock IMAP handshake succeeds | 200 `{ ok: true }` |
| DB-19 | `POST /api/dashboard/mail/:accountId/test` — mock throws auth error | 200 `{ ok: false, error: "Authentication failed" }` |
| DB-20 | `POST /api/dashboard/mail/:accountId/test` — mock times out | 200 `{ ok: false, error: "Connection timed out (10 s)" }` |

#### Calendar

| # | Test | Expected |
|---|---|---|
| DB-21 | `GET /api/dashboard/calendar/:accountId` — CalDAV mock returns 2 events within lookahead | 200 `{ events: [{ uid, title, start, end, location }], error: null }` |
| DB-22 | `GET /api/dashboard/calendar/:accountId` — event `DTSTART` beyond `lookaheadDays` | Event excluded from result |
| DB-23 | `GET /api/dashboard/calendar/:accountId` — multi-day event overlapping window boundary | Event included |
| DB-24 | `GET /api/dashboard/calendar/:accountId` — CalDAV mock returns 401 | 200 `{ events: [], error: "Authentication failed (HTTP 401)" }` |
| DB-25 | `GET /api/dashboard/calendar/:accountId/event/:uid` — full fields returned | 200 `{ uid, title, start, end, location, status, organizer, description }` |
| DB-26 | `GET /api/dashboard/calendar/:accountId/event/:uid` — uid not found | 404 |
| DB-27 | `POST /api/dashboard/calendar/:accountId/test` — mock returns 207 | 200 `{ ok: true }` |
| DB-28 | `POST /api/dashboard/calendar/:accountId/test` — mock returns 401 | 200 `{ ok: false, error: "Authentication failed (HTTP 401)" }` |
| DB-29 | `POST /api/dashboard/calendar/:accountId/test` — mock times out | 200 `{ ok: false, error: "Connection timed out (8 s)" }` |

#### Combined data endpoint

| # | Test | Expected |
|---|---|---|
| DB-30 | `GET /api/dashboard/data` — all sources configured and mocked successfully | 200; `mail`, `cards`, `calendar` all populated; `fetchedAt` present |
| DB-31 | `GET /api/dashboard/data` — one IMAP account unreachable | Other sources returned normally; failed source has `error` field; no 500 |
| DB-32 | `GET /api/dashboard/data` — all sources time out | 200 with all `error` fields set (server uses `Promise.allSettled`) |
| DB-33 | `GET /api/dashboard/data` — unauthenticated | 401 |

---

### Unit tests (`tests/unit/dashboard.test.js`)

Pure function tests using Vitest. No network calls. IMAP and CalDAV modules are not
loaded; only helper functions from `backend/dashboard/calendar.js` and config merge
logic from `backend/global-db.js` are tested in isolation.

#### Config password merge

| # | Test | Expected |
|---|---|---|
| DU-1 | `mergeAccountPassword(existing, incoming)` — incoming has no `password` field | Returns existing password unchanged |
| DU-2 | `mergeAccountPassword` — incoming has `password: ""` | Returns existing password unchanged |
| DU-3 | `mergeAccountPassword` — incoming has new non-empty password | Returns new password |
| DU-4 | `stripPasswords(config)` — config with passwords on all account types | Returned object has no `password` fields; `hasPassword: true` added where password was set |

#### Calendar event filtering

| # | Test | Expected |
|---|---|---|
| DU-5 | `filterEvents(events, lookaheadDays)` — event starts tomorrow, lookahead 7 days | Included |
| DU-6 | `filterEvents` — event starts 8 days from now, lookahead 7 | Excluded |
| DU-7 | `filterEvents` — all-day event (`DATE` not `DATE-TIME`) within window | Included |
| DU-8 | `filterEvents` — multi-day event: starts before today, ends within window | Included (overlap with window) |
| DU-9 | `filterEvents` — event started yesterday, ended yesterday | Excluded |
| DU-10 | `filterEvents` — empty events array | Returns `[]` |

---

### E2E tests (`tests/e2e/dashboard.spec.js`)

Run against a live server. Mail and CalDAV are mocked at the HTTP level using
Playwright route interception (`page.route`) for the `/api/dashboard/*` endpoints.
The board used for card sources is seeded via `PUT /api/:board/board` in `beforeAll`.

#### Dashboard view

| # | Scenario |
|---|---|
| E-DB-1 | Click "Dashboard" link in header → URL hash becomes `#dashboard`; three panel headings visible |
| E-DB-2 | Cards panel shows cards from configured board/column; card count matches seeded data |
| E-DB-3 | Click a card in cards panel → existing edit modal opens for that card |
| E-DB-4 | Refresh button clicked → loading indicator shown → panels re-render with fresh data |
| E-DB-5 | One source returns `error` → error badge visible in that panel; other two panels render normally |
| E-DB-6 | Navigate away to a board and back → panels re-render (no stale content) |

#### Mail detail

| # | Scenario |
|---|---|
| E-DB-7 | Click a mail item → detail panel slides in with subject, from, date, body preview |
| E-DB-8 | Mail detail: `webInterfaceUrl` configured for account → "Open in Webmail ↗" link present with correct `href` |
| E-DB-9 | Mail detail: no `webInterfaceUrl` → "Open in Webmail" link absent |
| E-DB-10 | Close detail panel (✕ or Escape) → detail panel gone; dashboard still visible |

#### Calendar event detail

| # | Scenario |
|---|---|
| E-DB-11 | Click a calendar event → detail panel shows title, when (formatted), calendar label |
| E-DB-12 | Event detail: location present → shown in detail panel |
| E-DB-13 | Event detail: description present → rendered as text |
| E-DB-14 | Calendar detail: `webInterfaceUrl` configured → "Open in Calendar ↗" link with correct `href` |
| E-DB-15 | Calendar detail: no `webInterfaceUrl` → "Open in Calendar" link absent |

#### Account Settings dialog

| # | Scenario |
|---|---|
| E-DB-16 | Open Account Settings → mail accounts section visible |
| E-DB-17 | Add mail account (fill all fields including webInterfaceUrl) → appears in account list |
| E-DB-18 | Edit mail account — leave password field blank → account saved; existing password retained (hasPassword still true on re-open) |
| E-DB-19 | Delete mail account → removed from list |
| E-DB-20 | Add calendar account with `webInterfaceUrl` → link appears in event detail view |
| E-DB-21 | Connection-test button for mail account → result message shown inline |
| E-DB-22 | Connection-test button for calendar account → result message shown inline |

---

### Phasing

Add to the dashboard implementation phases:

| Phase | Tests to write |
|---|---|
| Phase 1 (cards panel) | DB-1..DB-12, DU-1..DU-4, E-DB-1..E-DB-3 |
| Phase 2 (calendar) | DB-21..DB-29, DU-5..DU-10, E-DB-11..E-DB-15, E-DB-20, E-DB-22 |
| Phase 3 (mail) | DB-13..DB-20, E-DB-7..E-DB-10, E-DB-17..E-DB-19, E-DB-21 |
| Phase 4 (combined + polish) | DB-30..DB-33, E-DB-4..E-DB-6, E-DB-16 |

---

## Out of scope (initial version)

- Sending emails or replying (read-only by design for phases 1–3).
- Creating or editing calendar events (read-only).
- Push notifications / WebSocket for real-time mail arrival.
- OAuth2 / app-password flows (plain credentials for now; document the recommendation to
  use app-specific passwords where providers support it, e.g. Google App Passwords).
- Per-board dashboard configuration (global config only).
