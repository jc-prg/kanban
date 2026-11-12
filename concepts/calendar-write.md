# Calendar Write Operations — Concept

Extends the dashboard with the ability to **create, edit, and delete calendar events** directly
from within the dashboard view. Read access (fetching and displaying events) is already
implemented; this concept adds write paths on top of that infrastructure.

---

## Scope

### In scope
- Create a new event on a CalDAV account (title, dates, time, location, description, all-day toggle)
- Edit an existing event fetched from a CalDAV account
- Delete an existing event from a CalDAV account
- Support for both timed and all-day events
- Optimistic concurrency using ETags (prevent overwriting concurrent edits)

### Out of scope
- **iCal-URL accounts** — these are read-only subscription feeds; no write support
- Recurring events (RRULE) — read/display only; editing a recurring event is not supported
- Attendees / invitations (ATTENDEE, RSVP) — display only
- Drag-to-reschedule in the calendar panel
- CalDAV scheduling (iTIP / iMIP)

---

## UI

### Calendar panel header — column options menu

Each calendar account section within the calendar panel has a header row that mirrors the card
column header pattern. A `⋮` button (`.col-btn`) sits at the right edge, identical in
structure and style to the column options button on card columns:

```
┌──────────────────────────────────────────────┐
│  CALENDAR                                    │
│                                              │
│  Work (alice@example.com)               [⋮]  │
│  ──────────────────────────────────────────  │
│  Today …                                     │
│  Tomorrow …                                  │
│  This week …                                 │
│                                              │
│  Personal                               [⋮]  │
│  ──────────────────────────────────────────  │
│  Today …                                     │
└──────────────────────────────────────────────┘
```

Clicking `[⋮]` opens the existing context-menu overlay (reusing the same `.context-menu`
element and `openContextMenu` / close logic already used for card columns in `menus.js`).
The menu contains:

```
┌──────────────────────┐
│  New event           │
│  Show +1 week        │
│  Show +1 month       │
│  Edit accounts       │
└──────────────────────┘
```

- **New event** — opens the event creation modal pre-set to this account. Absent for
  iCal-URL accounts (the menu is still shown but "New event" is omitted).
- **Show +1 week** / **Show +1 month** — extend the lookahead for this account by 7 or 30
  days respectively (see behaviour below). The menu item label reflects the current state,
  e.g. "Show +1 week (now: 14 days)" after the first extension.
- **Edit accounts** — opens the global settings dialog scrolled directly to the Calendar
  accounts section. Uses the same settings dialog already opened by `[⚙ Settings]`, with a
  `#calendar-accounts` anchor target so the section is in view immediately.

### Load more future events

Clicking "Show +1 week" or "Show +1 month" from the column options menu triggers an
incremental fetch for the owning account:

- The extended window is **session-only** — it resets to the configured `lookaheadDays` on
  page reload or navigation away from the dashboard.
- Each invocation is additive: choosing "+1 week" twice extends the window by 14 days total.
  The current lookahead is tracked per account in `_calLookahead` so that accounts with
  different configured `lookaheadDays` values each extend independently.
- A "Showing next N days" note is rendered below the last day group for that account while
  the extended window is active.
- While the fetch is in progress the `[⋮]` button is disabled; already-rendered events
  remain visible (no blank-slate reload).
- New events are appended below the last currently shown day group — events already within
  the original window are not re-fetched or re-rendered.

### Edit and Delete entry points

In the existing **calendar event detail panel**, two action buttons are added to the footer:

```
┌──────────────────────────────────────────────────────────┐
│  Team Standup                                 [✕ Close]  │
│  ──────────────────────────────────────────────────────  │
│  …event fields…                                          │
│  ──────────────────────────────────────────────────────  │
│              [Delete]  [Edit]  [Open in Calendar ↗]      │
└──────────────────────────────────────────────────────────┘
```

- **[Edit]** opens the event modal pre-filled with the event's current data.
- **[Delete]** shows the existing `showConfirm` dialog before issuing the delete request.
- Both buttons are hidden for events from iCal-URL accounts (read-only).
- Events that belong to a recurring series show a note: "This is a recurring event — editing
  is not supported." and the Edit button is disabled.

### Global settings — default timezone

A new field is added to the existing **Dashboard Settings** dialog (the `[⚙ Settings]` panel
described in `concepts/dashboard.md`), in the Calendar accounts section:

```
Calendar accounts                                          [+ Add account]
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Work       https://cal.example.com/dav/  work@ex.  [Edit] [Delete]│
  └─────────────────────────────────────────────────────────────────────┘
  Show events for next: [7 days ▾]

  Default timezone for new events:
  [Europe/Berlin                                                       ▾]
  (Leave blank to use browser timezone)
```

- The selector is the same grouped IANA timezone list used in the event modal.
- An empty / unset value means "use browser locale" — shown as a placeholder, not stored.
- Saved as part of the existing `PUT /api/dashboard/config` call alongside other settings.

### Event modal

Reuses the existing modal overlay pattern (same backdrop, same `<dialog>` structure used for
card add/edit). A new `<dialog id="calEventModal">` is added to `index.html`.

```
┌─────────────────────────────────────────────────────────┐
│  New event                                   [✕ Close]  │
│  ─────────────────────────────────────────────────────  │
│  Calendar   [Work (alice@example.com)        ▾]         │
│             (selector hidden when editing)              │
│                                                         │
│  Title      [                                        ]  │
│                                                         │
│  All day    [ ] (checkbox)                              │
│                                                         │
│  Start      [2026-07-05]  [10:00]   (time hidden when  │
│  End        [2026-07-05]  [10:30]    all-day checked)  │
│                                                         │
│  Location   [                                        ]  │
│                                                         │
│  Timezone   [Europe/Berlin                          ▾]  │
│             (hidden when All day is checked)            │
│                                                         │
│  Description                                            │
│  ┌─────────────────────────────────────────────────┐   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│                              [Cancel]  [Save event]     │
└─────────────────────────────────────────────────────────┘
```

**Timezone behaviour:**
- The timezone selector is populated from `Intl.supportedValuesOf('timeZone')` (available in
  all modern browsers), grouped by region (Europe/, America/, Asia/, …) for usability.
- The selector default follows this priority chain when creating a new event:
  1. `defaultTimezone` from the dashboard config (set in global settings — see below)
  2. Browser's local timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) as fallback
     when no default is configured
- When editing an existing event the selector is pre-set to the timezone parsed from `DTSTART`
  (e.g. `TZID=Europe/Berlin`); if the event was stored as UTC floating time, the configured
  default timezone (or browser locale fallback) is used instead.
- The timezone selector is hidden (and ignored) when "All day" is checked.

**Validation (client-side):**
- Title is required and must not be blank.
- End must be >= Start (enforced by disabling past end dates in the date picker and by server
  validation).
- For all-day events, times and timezone are hidden and not sent.

**Saving state:** the Save button shows "Saving…" while the request is in flight; on success
the modal closes and the calendar panel refreshes for the affected account; on error an inline
error message is shown inside the modal (never a full-page error).

---

## Backend

### ICS generation (`backend/dashboard/calendar.js`)

Two new exported helpers added to the existing module:

#### `buildIcs(event, uid?)`

Constructs a minimal VCALENDAR/VEVENT ICS string suitable for a CalDAV PUT.

```
Parameters:
  event — {
    title:       string,            // SUMMARY
    allDay:      boolean,
    start:       string,            // ISO date or datetime
    end:         string,            // ISO date or datetime
    location?:   string,            // LOCATION
    description?: string,           // DESCRIPTION
    uid?:        string,            // if omitted, a new UUID-style UID is generated
  }
  uid? — override the event.uid (used when updating an existing event)

Returns: { ics: string, uid: string }
```

Generated ICS structure:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//kanban//kanban//EN
BEGIN:VTIMEZONE                        (omitted for all-day events)
TZID:<timezone>
  ... (standard/daylight components — see below)
END:VTIMEZONE
BEGIN:VEVENT
UID:<uid>
DTSTAMP:<now UTC>
DTSTART[;TZID=<timezone>|;VALUE=DATE]:<start>
DTEND[;TZID=<timezone>|;VALUE=DATE]:<end>
SUMMARY:<title>
LOCATION:<location>         (omitted when empty)
DESCRIPTION:<description>   (omitted when empty)
END:VEVENT
END:VCALENDAR
```

- **Timed events:** `DTSTART;TZID=Europe/Berlin:20260706T100000` — local wall-clock time with
  a named TZID, never UTC floating time. A matching `VTIMEZONE` component is embedded in the
  VCALENDAR so the ICS is self-contained and importable by any client.
- **All-day events:** `DTSTART;VALUE=DATE:YYYYMMDD` / `DTEND;VALUE=DATE:YYYYMMDD` (end =
  start + 1 day per iCalendar spec for single-day events). No VTIMEZONE included.
- **VTIMEZONE generation:** `buildIcs` calls a new helper `_buildVTimezone(tzid)` that uses
  the `Intl.DateTimeFormat` API (Node 18+) to derive the UTC offsets for the STANDARD and
  DAYLIGHT sub-components for the current year. This avoids bundling a full tz database while
  producing a standards-compliant VTIMEZONE block. Only one transition pair per year is
  emitted (sufficient for CalDAV compliance); for zones without DST only a STANDARD component
  is included.
- Long field values are folded at 75 octets per RFC 5545.

#### `resolveEventUrl(account, uid, headers, signal)`

Returns the CalDAV resource URL for a given event UID.

Strategy:
1. Resolve the calendar collection URL via the existing `_resolveCalendarUrl` (already cached).
2. Return `{collectionUrl}/{uid}.ics` — the conventional naming pattern used by most CalDAV
   servers (Nextcloud, Baikal, Radicale).
3. If a `href` was previously stored (from parsing the CalDAV REPORT response), use it directly
   (more reliable for servers that use non-UID-based filenames).

To enable option 3, `parseEvents` is extended to also return `href` when called from
`fetchRawEvents` (the href comes from the surrounding CalDAV XML response block, not the ICS
itself). Stored in the event object as an optional field; stripped from the list API response
but preserved in the `_calEventMap` on the frontend.

### New routes (`backend/routes/dashboard.js`)

All new routes require the same `authenticate` middleware and the existing `writeRateLimit`.

| Method   | Path                                              | Description                          |
|----------|---------------------------------------------------|--------------------------------------|
| `POST`   | `/api/dashboard/calendar/:accountId/events`       | Create a new event                   |
| `PUT`    | `/api/dashboard/calendar/:accountId/event/:uid`   | Update an existing event             |
| `DELETE` | `/api/dashboard/calendar/:accountId/event/:uid`   | Delete an event                      |

#### `GET /api/dashboard/calendar/:accountId` — extended lookahead (existing route, extended)

The existing route is extended to accept an optional `?days=<n>` query parameter:

- `n` must be an integer in the range **1–365**; values outside this range are clamped.
- When present, overrides the account's configured `lookaheadDays` for this request only.
- The server passes `n` to `fetchCalendarAccount` as `{ lookaheadDays: n }`, which already
  threads it through to `_buildReportBody` and `filterEvents`.
- No change to the response shape; the frontend uses the same partial-refresh merge path.

Example: `GET /api/dashboard/calendar/ca-def456?days=30`

#### `POST /api/dashboard/calendar/:accountId/events`

Request body:
```jsonc
{
  "title":       "Team Standup",
  "allDay":      false,
  "start":       "2026-07-06T10:00:00Z",
  "end":         "2026-07-06T10:30:00Z",
  "location":    "https://meet.example.com/standup",  // optional
  "description": "Daily sync"                          // optional
}
```

Server steps:
1. Look up the account; reject with 404 if not found.
2. Reject with 400 if account type is `ical-url`.
3. Validate body fields (title required; end >= start; date strings parseable).
4. Generate a UID: `crypto.randomUUID()` (Node 19+) or `require('crypto').randomUUID()`.
5. Call `buildIcs(body, uid)` to produce the ICS string.
6. Resolve the calendar URL via `_resolveCalendarUrl`.
7. `PUT {calendarUrl}/{uid}.ics` with:
   - `Content-Type: text/calendar; charset=utf-8`
   - `If-None-Match: *` (create only — 412 if a resource with this UID already exists)
8. On 201/204 from server: return `{ ok: true, uid }`.
9. On CalDAV error: return 502 with the CalDAV status and body.

#### `PUT /api/dashboard/calendar/:accountId/event/:uid`

Request body:
```jsonc
{
  "title":       "Team Standup (updated)",
  "allDay":      false,
  "start":       "2026-07-06T10:00:00Z",
  "end":         "2026-07-06T11:00:00Z",
  "location":    "",
  "description": "",
  "etag":        "\"abc123\""   // optional — used for If-Match if present
}
```

Server steps:
1. Look up the account; reject with 404 if not found.
2. Reject with 400 if account type is `ical-url`.
3. Resolve the event URL (using stored href or `{calendarUrl}/{uid}.ics`).
4. Call `buildIcs(body, uid)` to reconstruct the ICS (preserves the original UID).
5. `PUT {eventUrl}` with:
   - `Content-Type: text/calendar; charset=utf-8`
   - `If-Match: {etag}` if etag was supplied (optimistic concurrency); omit header otherwise
6. On 204: return `{ ok: true }`.
7. On 412 (ETag mismatch): return 409 `{ error: "Event was modified by someone else — please reload." }`.
8. On other CalDAV error: return 502.

#### `DELETE /api/dashboard/calendar/:accountId/event/:uid`

Server steps:
1. Look up account; 404 if not found.
2. Reject with 400 if `ical-url`.
3. Resolve event URL.
4. `DELETE {eventUrl}` with optional `If-Match: {etag}` if the frontend passes one.
5. On 204: clear the URL cache entry for this account and return `{ ok: true }`.
6. On 404 from CalDAV: return 404 `{ error: "Event not found (already deleted?)" }`.
7. On 412: return 409 `{ error: "Event was modified — please reload." }`.
8. On other CalDAV error: 502.

### Validation (`backend/schemas.js`)

Add `validateCalendarEvent` schema:

```jsonc
{
  "type": "object",
  "required": ["title", "allDay", "start", "end"],
  "properties": {
    "title":       { "type": "string", "minLength": 1, "maxLength": 500 },
    "allDay":      { "type": "boolean" },
    "start":       { "type": "string" },
    "end":         { "type": "string" },
    "timezone":    { "type": "string", "maxLength": 100 },  // IANA tz name; omitted for all-day
    "location":    { "type": "string", "maxLength": 500 },
    "description": { "type": "string", "maxLength": 10000 },
    "etag":        { "type": "string" }
  },
  "additionalProperties": false
}
```

Server-side cross-field validation:
- `new Date(end) >= new Date(start)`
- If `allDay` is false and `timezone` is present, validate it is a known IANA timezone using
  `Intl.supportedValuesOf('timeZone')` (Node 18+). Unknown timezones are rejected with 400.

---

## Frontend

### State

In `dashboard.js`, the `_calEventMap` already caches `"accountId\0uid" → event object` on
each render. Extend the stored event object to also hold:
- `accountType` — `"caldav"` | `"ical-url"` (to gate write buttons)
- `etag` — the CalDAV ETag returned alongside the event (or `null`)
- `href` — the resource path, if returned by the REPORT response (for reliable URL resolution)
- `hasRrule` — `true` if the event contains an RRULE (recurring; disable editing)
- `timezone` — IANA timezone name parsed from the event's `DTSTART;TZID=` parameter (e.g.
  `"Europe/Berlin"`), or `null` for all-day events or UTC floating-time events

A separate module-level Map `_calLookahead` (keyed by `accountId`) tracks the current
lookahead in days for each account. Initialised lazily from `account.lookaheadDays` when the
dashboard first loads; incremented by the "Load more" buttons. Reset to `null` (i.e. use the
configured default) when the user navigates away from the dashboard.

The `etag` comes from the `<D:getetag>` element in the CalDAV REPORT XML response. Currently
`fetchRawEvents` discards it. Extend `_extractIcsBlocks` / the REPORT parsing to also extract
ETags and `href`s and associate them with parsed events by position.

`timezone` is extracted by `parseEvents` from the `DTSTART` property parameter:
`ve.getFirstProperty('dtstart').getParameter('tzid')` via ical.js. Stored on the event object
and passed through to the frontend in the calendar panel API response.

### New functions in `dashboard.js`

#### `openCalEventModal(accountId?, event?)`

- Opens `#calEventModal`.
- When `accountId` is provided and `event` is null: create mode — populate the account
  selector, set default dates (today, +1 hour), clear all fields. Set the timezone selector
  to `_defaultTimezone` if set, otherwise to the browser's local timezone.
- When `event` is provided: edit mode — hide account selector, pre-fill all fields from the
  event object stored in `_calEventMap`. Set the timezone selector to `event.timezone` if
  non-null, otherwise fall back to `_defaultTimezone` or browser locale.

#### `_submitCalEvent()`

Called by the Save button. Reads form values, constructs the request body, calls
`POST .../events` or `PUT .../event/:uid` depending on modal mode. On success: closes modal,
calls `_refreshCalendarAccount(accountId)` to reload just the affected account's panel section.

#### `_deleteCalEvent(accountId, uid)`

Called by the Delete button in the event detail panel. Shows `showConfirm`, then calls
`DELETE .../event/:uid`. On success: closes the detail panel, calls
`_refreshCalendarAccount(accountId)`.

#### `_loadMoreCalEvents(accountId, extraDays)`

Called by the "+1 week" (extraDays=7) and "+1 month" (extraDays=30) buttons.

Steps:
1. Compute `newDays = (_calLookahead.get(accountId) ?? configuredLookahead) + extraDays`.
   Cap at 365.
2. Disable the account's `[⋮]` button for the duration of the request.
3. Call `GET /api/dashboard/calendar/:accountId?days=newDays`.
4. From the response, extract only events whose `start` falls **after** the previously loaded
   window end (i.e. events already shown are not duplicated). Append these to `_calEventMap`.
5. Update `_calLookahead.set(accountId, newDays)`.
6. Append new day-group DOM nodes below the last existing day group for this account
   (do not re-render the whole panel — avoid disrupting scroll position).
7. Show/update the "Showing next N days" note and re-enable the `[⋮]` button.
8. If the response returns fewer events than expected (sparse far-future calendar), still
   update the lookahead so subsequent clicks extend correctly.

#### `_refreshCalendarAccount(accountId)`

Partially refreshes the calendar panel for a single account without reloading mail, cards, or
other calendar accounts. This avoids the latency of a full `GET /api/dashboard/data` call
(which fetches all sources in parallel) and prevents the mail and cards panels from flickering.

Steps:
1. Call `GET /api/dashboard/calendar/:accountId?days=<currentLookahead>`, where
   `currentLookahead` is taken from `_calLookahead.get(accountId)` (preserves any
   user-extended window; falls back to the account's configured `lookaheadDays`).
2. Merge the result into the in-memory last-fetched data structure, replacing only the entry
   for `accountId` (keyed by `accountId` in the calendar array).
3. Update `_calEventMap` for the affected account: remove all entries whose key starts with
   `accountId\0`, then insert the fresh events.
4. Re-render only the calendar panel DOM (`_renderCalendarPanel()`), leaving the mail and
   cards panel DOM untouched.
5. Update the "last refreshed at HH:MM" timestamp shown in the calendar panel header.

Optimistic local update (applied before the network call):
- After a **create**: insert a provisional event object into `_calEventMap` and into the
  rendered panel immediately, marked with a `cal-event--provisional` CSS class. When the
  network call completes, replace the provisional entry with the server-confirmed event
  (including its real ETag). If the call fails, remove the provisional entry and show an
  inline error in the panel.
- After an **edit**: update the event in `_calEventMap` and re-render the panel immediately
  with the new field values, similarly marked provisional until the refresh confirms.
- After a **delete**: remove the event from `_calEventMap` and the panel immediately. If the
  delete request fails, re-insert the event and show an error.

This gives the UI an instant response feel while the CalDAV request is in flight.

### Changes to the event detail panel render

In the `_renderCalEventDetail(event)` function:
- Add a `data-account-id` and `data-uid` attribute to the detail panel root.
- Append Edit and Delete buttons (hidden via CSS when `event.accountType === 'ical-url'` or
  `event.hasRrule === true`).
- Pass `event.etag` to `_deleteCalEvent` and store it in the modal for `_submitCalEvent`.

### Rendered HTML — calendar account header (dynamic, built in `dashboard.js`)

Each calendar account section is rendered with the same `.col-btn` pattern as card columns:

```html
<div class="dash-cal-account">
  <div class="dash-cal-account-header">
    <span class="dash-cal-account-label">Work (alice@example.com)</span>
    <button class="col-btn" title="Calendar options"
            data-account-id="ca-def456">⋮</button>
  </div>
  <div class="dash-cal-account-body">
    <!-- day groups rendered here -->
    <p class="dash-cal-lookahead-note" hidden>Showing next 14 days</p>
  </div>
</div>
```

The `[⋮]` click handler calls `openContextMenu` (from `menus.js`) with a dynamically built
items array:

```js
const items = [];
if (account.type !== 'ical-url') {
  items.push({ label: 'New event', action: () => openCalEventModal(accountId, null) });
}
const days = _calLookahead.get(accountId) ?? account.lookaheadDays ?? 7;
items.push(
  { label: `Show +1 week (now: ${days} days)`,  action: () => _loadMoreCalEvents(accountId, 7)  },
  { label: `Show +1 month (now: ${days} days)`, action: () => _loadMoreCalEvents(accountId, 30) },
  { separator: true },
  { label: 'Edit accounts', action: () => openSettingsDialog('calendar-accounts') },
);
openContextMenu(event, items);
```

`openSettingsDialog(section)` is an extension to the existing settings-open function in
`settings.js`. It opens the settings dialog and scrolls the element with `id="calendar-accounts"`
into view. The `id` is added to the Calendar accounts `<section>` heading inside the settings
dialog HTML.

### New HTML (`index.html`)

```html
<dialog id="calEventModal" class="modal">
  <div class="modal-header">
    <span id="calEventModalTitle">New event</span>
    <button class="modal-close-btn" id="calEventModalClose">✕</button>
  </div>
  <div class="modal-body">
    <label>Calendar
      <select id="calEventAccount"></select>
    </label>
    <label>Title <input type="text" id="calEventTitle" maxlength="500"></label>
    <label class="cal-event-allday-row">
      <input type="checkbox" id="calEventAllDay"> All day
    </label>
    <div class="cal-event-time-row">
      <label>Start <input type="date" id="calEventStartDate"> <input type="time" id="calEventStartTime"></label>
      <label>End   <input type="date" id="calEventEndDate">   <input type="time" id="calEventEndTime"></label>
    </div>
    <label>Location    <input type="text" id="calEventLocation" maxlength="500"></label>
    <div class="cal-event-tz-row">
      <label>Timezone <select id="calEventTimezone"></select></label>
    </div>
    <label>Description <textarea id="calEventDescription" rows="4"></textarea></label>
    <p class="cal-event-error" id="calEventError" hidden></p>
  </div>
  <div class="modal-footer">
    <button class="btn btn-secondary" id="calEventCancelBtn">Cancel</button>
    <button class="btn btn-primary"   id="calEventSaveBtn">Save event</button>
  </div>
</dialog>
```

---

## ETag handling

CalDAV servers return an ETag for each resource in the REPORT response
(`<D:getetag>"abc123"</D:getetag>`). The frontend stores the ETag per event in `_calEventMap`.

On edit or delete, the stored ETag is sent as `If-Match`. If the server returns 412, the
user sees: "This event was changed elsewhere. Please close and reopen to refresh." — no silent
overwrite.

For newly created events (where no ETag was received yet), no `If-Match` is sent.

---

## Security

- All three write routes sit behind `authenticate` + `writeRateLimit` (same as all other
  mutating routes).
- Account lookup by `accountId` is strict — requests for unknown accounts get 404, not a
  proxy to an arbitrary URL.
- The CalDAV URL used for PUT/DELETE is constructed from the stored server-side config only;
  no client-supplied URL is ever used for the CalDAV request (prevents SSRF).
- `title`, `location`, `description` are inserted into the ICS with proper RFC 5545 escaping
  (backslash-escape `,`, `;`, `\`, newlines) in `buildIcs` — no raw interpolation.
- `validateCalendarEvent` schema rejects unknown properties (`additionalProperties: false`).
- iCal-URL accounts are rejected at the route level (400) before any outgoing request is made.

---

## Data model additions

### Dashboard config document

One new optional top-level field is added to the existing `jc-config-dashboard` document:

```jsonc
{
  // … existing fields (mailAccounts, cardSources, calendarAccounts, autoRefreshMs) …
  "defaultTimezone": "Europe/Berlin"   // optional; IANA timezone name; absent = use browser locale
}
```

This field is returned as-is by `GET /api/dashboard/config` (not sensitive), saved via the
existing `PUT /api/dashboard/config`, and validated by extending `validateDashboardConfig` in
`schemas.js` with `"defaultTimezone": { "type": "string", "maxLength": 100 }` (optional).
Server-side it is validated as a known IANA name using `Intl.supportedValuesOf('timeZone')`,
the same check applied to event bodies.

The frontend reads `defaultTimezone` from the config it already fetches during `initDashboard`
and stores it in a module-level variable `_defaultTimezone` for use in `openCalEventModal`.

### Event data (in-memory only)

No other CouchDB schema changes. The event write operations are pass-through to CalDAV.
`fetchRawEvents` now also returns `etag`, `href`, and `timezone` per event, held in the
in-memory `_calEventMap` on the frontend for the duration of the session.

---

## API summary

| Method   | Path                                              | Auth | Rate limit   | Description           |
|----------|---------------------------------------------------|------|--------------|-----------------------|
| `POST`   | `/api/dashboard/calendar/:accountId/events`       | yes  | writeRateLimit | Create event        |
| `PUT`    | `/api/dashboard/calendar/:accountId/event/:uid`   | yes  | writeRateLimit | Update event        |
| `DELETE` | `/api/dashboard/calendar/:accountId/event/:uid`   | yes  | writeRateLimit | Delete event        |

Existing read routes are unchanged.

---

## Implementation phases

### Phase 1 — Backend write primitives

1. Add `_buildVTimezone(tzid)` helper to `backend/dashboard/calendar.js` using
   `Intl.DateTimeFormat` to derive STANDARD / DAYLIGHT offset data for the current year.
2. Add `buildIcs(event, uid?)` using `_buildVTimezone` for timed events.
3. Extend `fetchRawEvents` / `_extractIcsBlocks` to capture `etag`, `href`, and `timezone`
   per event.
4. Extend `parseEvents` to extract `TZID` from `DTSTART` and return it as `timezone`.
5. Add `resolveEventUrl(account, uid, headers, signal)`.
6. Add `POST`, `PUT`, `DELETE` routes in `backend/routes/dashboard.js`.
7. Extend the existing `GET /dashboard/calendar/:accountId` route to accept and clamp a
   `?days=<n>` query parameter (1–365), forwarding it to `fetchCalendarAccount`.
8. Add `validateCalendarEvent` (including `timezone` field) to `schemas.js`.
9. Extend `validateDashboardConfig` in `schemas.js` with the optional `defaultTimezone` field;
   add server-side IANA validation for it in the `PUT /api/dashboard/config` route.

### Phase 2 — Frontend modal

1. Add `<dialog id="calEventModal">` to `index.html` with the timezone `<select>`.
2. Add CSS for the modal (including `.cal-event-tz-row`) to `dashboard.css`.
3. In `dashboard.js`: populate `#calEventTimezone` from `Intl.supportedValuesOf('timeZone')`,
   grouped by region prefix. Also populate the `#dashDefaultTimezone` selector in the settings
   dialog using the same list. Store `config.defaultTimezone` in `_defaultTimezone` when the
   config is loaded; use it as the modal default, falling back to browser locale timezone.
4. Implement `openCalEventModal`, `_submitCalEvent`, `_deleteCalEvent` in `dashboard.js`.
5. Implement `_refreshCalendarAccount` with optimistic local updates (provisional CSS class,
   merge into `_calEventMap`, partial DOM re-render).
6. Render each calendar account section with a `.col-btn` (`[⋮]`) header button; wire it to
   `openContextMenu` with a dynamically built items array (New event, Show +1 week, Show
   +1 month). Initialise `_calLookahead` from each account's configured `lookaheadDays`;
   clear `_calLookahead` on navigation away from the dashboard view.
7. Wire up Edit / Delete buttons in the event detail panel; hide timezone selector when
   All-day is checked.

### Phase 3 — Polish

- Disable Save button during in-flight request; re-enable on error.
- Keyboard: Enter submits (except in description textarea), Escape closes modal.
- On success toast: "Event saved" / "Event deleted" (reuse the existing save indicator style).
- Handle 409 (ETag conflict) with a user-friendly inline error.
- Provisional event items (optimistic updates) styled with reduced opacity and a spinner icon
  until confirmed or rolled back.

---

## Tests

Follows `concepts/test-concept.md` conventions. Tests are written alongside the feature.

### New backend helper unit tests (`tests/unit/calendar-write.test.js`)

| # | Test | Expected |
|---|---|---|
| CW-1 | `buildIcs` — timed event | ICS contains `DTSTART`, `DTEND`, `SUMMARY`, valid UID |
| CW-2 | `buildIcs` — all-day event | `DTSTART;VALUE=DATE`, `DTEND;VALUE=DATE` (end = start + 1 day) |
| CW-3 | `buildIcs` — location and description present | `LOCATION` and `DESCRIPTION` lines in ICS |
| CW-4 | `buildIcs` — description with commas/semicolons/backslashes | Characters properly escaped |
| CW-5 | `buildIcs` — long SUMMARY (> 75 chars) | Line folded per RFC 5545 |
| CW-6 | `buildIcs` — uid provided | Output UID matches provided uid |
| CW-7 | `buildIcs` — uid omitted | A non-empty UID is generated |
| CW-8 | `buildIcs` — end < start | Throws `Error('end must be >= start')` |
| CW-9 | `buildIcs` — timed event with `timezone: "Europe/Berlin"` | `DTSTART;TZID=Europe/Berlin:…` present; `BEGIN:VTIMEZONE` / `TZID:Europe/Berlin` present |
| CW-10 | `buildIcs` — timed event with `timezone: "America/New_York"` (DST zone) | Both `BEGIN:STANDARD` and `BEGIN:DAYLIGHT` sub-components present in VTIMEZONE block |
| CW-11 | `buildIcs` — timed event with `timezone: "Asia/Kolkata"` (no DST) | Only `BEGIN:STANDARD` present; no `BEGIN:DAYLIGHT` |
| CW-12 | `buildIcs` — all-day event | No VTIMEZONE block; no TZID on DTSTART |
| CW-13 | `_buildVTimezone("UTC")` | Returns empty string (UTC needs no VTIMEZONE per RFC 5545) |
| CW-14 | `parseEvents` — ICS with `DTSTART;TZID=Europe/Berlin` | Returned event has `timezone: "Europe/Berlin"` |
| CW-15 | `parseEvents` — ICS with `DTSTART;VALUE=DATE` | Returned event has `timezone: null` |
| CW-16 | `parseEvents` — ICS with `DTSTART:` (UTC floating) | Returned event has `timezone: null` |

#### Load more — API (extend `tests/api/dashboard.test.js`)

| # | Test | Expected |
|---|---|---|
| CW-LM-1 | `GET /dashboard/calendar/:accountId?days=14` — mock returns events in days 8–14 | 200; events in the extended window included |
| CW-LM-2 | `GET /dashboard/calendar/:accountId?days=0` | Clamped to 1; no 400 |
| CW-LM-3 | `GET /dashboard/calendar/:accountId?days=400` | Clamped to 365; no 400 |
| CW-LM-4 | `GET /dashboard/calendar/:accountId?days=abc` | Clamped to configured `lookaheadDays` (non-numeric treated as absent) |

#### Config — default timezone

These extend the existing `tests/api/dashboard.test.js` suite, not a new file.

| # | Test | Expected |
|---|---|---|
| CW-DT-1 | `PUT /api/dashboard/config` with `defaultTimezone: "Europe/Berlin"` | 200; re-GET returns `defaultTimezone: "Europe/Berlin"` |
| CW-DT-2 | `PUT /api/dashboard/config` with unknown timezone string | 400 |
| CW-DT-3 | `PUT /api/dashboard/config` with `defaultTimezone` absent | Existing value preserved (same merge logic as passwords) |
| CW-DT-4 | `PUT /api/dashboard/config` with `defaultTimezone: ""` | Field cleared; re-GET returns no `defaultTimezone` field |
| CW-DT-5 | `GET /api/dashboard/config` — `defaultTimezone` set | Returned in response (not sensitive, not stripped) |

### New API tests (`tests/api/calendar-write.test.js`)

Mock strategy: `vi.stubGlobal('fetch', ...)` to intercept CalDAV PUT/DELETE; same `createApp`
pattern as existing dashboard tests.

#### Create

| # | Test | Expected |
|---|---|---|
| CW-17 | `POST .../events` — valid body with timezone, CalDAV mock returns 201 | 200 `{ ok: true, uid: '…' }`; PUT body sent to CalDAV contains `VTIMEZONE` and `DTSTART;TZID=` |
| CW-18 | `POST .../events` — CalDAV mock returns 412 (UID collision) | 502 with error |
| CW-19 | `POST .../events` — `ical-url` account | 400 `{ error: '…read-only…' }` |
| CW-20 | `POST .../events` — title missing | 400 schema error |
| CW-21 | `POST .../events` — end before start | 400 `{ error: 'end must be >= start' }` |
| CW-22 | `POST .../events` — unknown IANA timezone | 400 |
| CW-23 | `POST .../events` — all-day event, timezone field present | Ignored; ICS uses `VALUE=DATE` with no VTIMEZONE |
| CW-24 | `POST .../events` — unknown accountId | 404 |
| CW-25 | `POST .../events` — unauthenticated | 401 |

#### Update

| # | Test | Expected |
|---|---|---|
| CW-26 | `PUT .../event/:uid` — valid body, CalDAV mock returns 204 | 200 `{ ok: true }` |
| CW-27 | `PUT .../event/:uid` — etag supplied, CalDAV returns 412 | 409 `{ error: '…modified…' }` |
| CW-28 | `PUT .../event/:uid` — `ical-url` account | 400 |
| CW-29 | `PUT .../event/:uid` — CalDAV mock returns 404 | 502 |
| CW-30 | `PUT .../event/:uid` — unauthenticated | 401 |

#### Delete

| # | Test | Expected |
|---|---|---|
| CW-31 | `DELETE .../event/:uid` — CalDAV mock returns 204 | 200 `{ ok: true }` |
| CW-32 | `DELETE .../event/:uid` — CalDAV mock returns 404 | 404 |
| CW-33 | `DELETE .../event/:uid` — etag supplied, CalDAV returns 412 | 409 |
| CW-34 | `DELETE .../event/:uid` — `ical-url` account | 400 |
| CW-35 | `DELETE .../event/:uid` — unauthenticated | 401 |

### E2E tests (`tests/e2e/dashboard.spec.js` — append)

Playwright route interception mocks the CalDAV write endpoints.

| # | Scenario |
|---|---|
| E-CW-1 | Click `[⋮]` on a CalDAV account → context menu shows "New event", "Show +1 week", "Show +1 month", "Edit accounts" |
| E-CW-1b | Click `[⋮]` on an iCal-URL account → context menu shows "Show +1 week", "Show +1 month", "Edit accounts" (no "New event") |
| E-CW-1c | Click "New event" in context menu → modal opens with today's date pre-filled, account pre-set to that account |
| E-CW-2 | Fill modal and click "Save event" → mock returns 201 → modal closes → calendar panel refreshes |
| E-CW-3 | Save with empty title → inline validation error visible, request not sent |
| E-CW-4 | Open event detail → Edit button visible for CalDAV account; click → modal opens pre-filled |
| E-CW-5 | Edit modal save → mock returns 204 → modal closes → panel refreshes |
| E-CW-6 | ETag conflict on save → 409 returned → inline error shown inside modal |
| E-CW-7 | Delete button in event detail → confirm dialog → mock returns 204 → detail panel closed |
| E-CW-8 | Event from iCal-URL account → Edit and Delete buttons hidden in detail panel |
| E-CW-9  | Recurring event (hasRrule) → Edit button disabled, tooltip "Recurring events cannot be edited" |
| E-CW-10 | All-day checkbox toggled → time inputs and timezone selector hidden; date-only values sent in request body |
| E-CW-11 | No `defaultTimezone` configured → timezone selector defaults to browser locale timezone on new event |
| E-CW-17 | `defaultTimezone: "Asia/Tokyo"` set in dashboard settings → new event modal opens with "Asia/Tokyo" pre-selected |
| E-CW-18 | Dashboard settings: change default timezone, save → re-open settings → new value shown |
| E-CW-12 | Existing event with `timezone: "America/New_York"` → Edit modal opens with selector pre-set to "America/New_York" |
| E-CW-13 | After save: calendar panel re-renders without mail or cards panel changing (no full reload) |
| E-CW-14 | Optimistic create: event appears in panel immediately with provisional style; confirmed after network response |
| E-CW-15 | Optimistic delete: event disappears from panel immediately; stays gone after network response |
| E-CW-16 | Optimistic update rolls back: provisional event reverts to original on 502 network error |
| E-CW-19 | Open `[⋮]` menu → click "Show +1 week" → menu closes → `[⋮]` disabled during fetch → new day groups appended → "Showing next 14 days" note visible → `[⋮]` re-enabled |
| E-CW-20 | Open `[⋮]` menu after first extension → label reads "Show +1 week (now: 14 days)" |
| E-CW-21 | Click "Show +1 month" after "+1 week" → total = configured + 7 + 30 days; events for additional period appended |
| E-CW-22 | After a write (create/edit/delete) the refresh uses the extended lookahead — previously loaded week-2 events remain visible |
| E-CW-23 | Navigate away from dashboard and back → lookahead resets to configured default; extra day groups gone |
| E-CW-24 | Click "Edit accounts" in context menu → settings dialog opens with Calendar accounts section visible in viewport |

---

## Open questions

1. **Href vs UID-based URL** — Most servers use `{uid}.ics` as the filename, but some (e.g.
   older Baikal) use opaque filenames. The href captured from the REPORT response is the
   authoritative path and should be preferred when available. If absent (e.g. event was just
   created by this app), `{calendarUrl}/{uid}.ics` is used.

2. **VTIMEZONE completeness** — The `_buildVTimezone` approach using `Intl.DateTimeFormat`
   produces a single-year STANDARD/DAYLIGHT pair. This is sufficient for CalDAV compliance
   but may not satisfy strict iCalendar validators that expect multi-year RRULE-based
   VTIMEZONE definitions. If compatibility issues arise with specific clients, the approach
   can be replaced by shipping a pre-built tz database (e.g. `tzdata-ical`) as a backend
   dependency.
