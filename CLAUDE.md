# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Single-user application.** There is no per-board or per-user access control. One valid session token or API key grants full access to all boards. Do not add multi-user features without first implementing per-board authorization.

## Commands

```bash
cd app
npm install        # install dependencies
npm start          # start server at http://localhost:3000
node backend/server.js  # equivalent to npm start
```

Or via Docker (from project root):
```bash
docker compose up -d --build
```

No build step, no linter, no test framework configured.

## Architecture

Single-page kanban board with a minimal three-layer design:

- **`app/backend/`** — Express 5 backend. Serves `public/` as static files and exposes REST endpoints for auth, board management, and card operations. Persists all data in CouchDB (one `jc-kanban-<name>` database per board, single `board` document each). Uses `nano` as the CouchDB client.
- **`app/frontend/index.html`** — Markup and modal HTML only. References the CSS and JS files below.

### Backend (`app/backend/`)

| File | Contents |
|---|---|
| `server.js` | Entry point — middleware, mount routers, startup (`initDb`, backup intervals) |
| `config.js` | All env vars and derived constants (`PORT`, `BACKUP_DIR`, `DB_PREFIX`, …) |
| `db.js` | CouchDB connection (`initDb`), `getBoardDb`, board/notes CRUD helpers, `withBoard`/`withExistingBoard` wrappers |
| `auth.js` | `safeEqual`, rate-limiting maps, `parseCookies`, `authenticate` middleware, `writeRateLimit`/`uploadRateLimit` |
| `schemas.js` | AJV instance, all `validate*` compiled schemas, `schemaError` |
| `backup.js` | `runBackup`, `runPromptsBackup`, `checkDataDirectories`, `refreshDbSize`/`getDbSizeBytes` |
| `routes/auth.js` | `POST /api/auth`, `GET /api/auth/verify`, `POST /api/auth/logout` |
| `routes/prompts.js` | `GET /api/settings`, `GET/PUT /api/prompts` |
| `routes/boards.js` | `GET /api/boards`, achievements, board create/rename/delete |
| `routes/board.js` | All `/:board/board`, `all-columns`, `column`, `card`, `move-to`, `import` |
| `routes/notes.js` | All `/:board/notes*` including ZIP export |
| `routes/attachments.js` | All notes/card attachment routes + `GET /api/db-size` |

### CSS (`app/frontend/styles/`)

| File | Contents |
|---|---|
| `base.css` | Reset, `:root` design tokens, `body`, grain overlay, scrollbar |
| `layout.css` | Header, title animation, header menu/dropdown, `.btn` variants, save indicator, board wrapper, overview & board grid |
| `column.css` | Column, column header, drag handle, collapsed group, col-btn, cards area, add-card/add-column buttons |
| `card.css` | Card, card-body, more-btn, card-text, meta badges, link badge, drop indicator, load-more button |
| `overlay.css` | Context menus, all modals & dialogs (add/edit card, login, confirm, prompts, card-info, settings), priority/color rows |
| `notes.css` | Notes sidebar, resizer, tree/list, note modal |
| `markdown.css` | Markdown preview pane (card modal + note modal) |

### JS (`app/frontend/`) — load order matters, no bundler

Vendor libraries loaded first: `marked.min.js` (Markdown → HTML), `purify.min.js` (DOMPurify, XSS sanitisation).

| File | Contents |
|---|---|
| `icons.js` | `ICONS` object (unicode/emoji constants) and SVG icon builder functions (`_svgAttachment`, `_svgLink`, `_svgNoteDoc`, …) |
| `state.js` | API constants, fetch interceptor (auto-attaches session token), `showConfirm`, color/priority constants, state vars, `load`, `buildPatch`, `schedulesSave`, save indicators, `uid`, all state mutations, `mergeStates` |
| `drag.js` | Drag state vars, mouse D&D for columns and cards, touch D&D (`spawnGhost`, `endTouchDrag`, all touch/drag event listeners) |
| `cards.js` | Modal state vars, card add/edit modal (`openModal`, `openEditModal`, `submitCard`, color/priority rows), card-info dialog |
| `render.js` | `escHtml`, `fmtDate`, `safeLink`, `getLinkBadgeHtml`, `render()` |
| `menus.js` | Card context menu, column context menu, `moveAllCards`, header dropdown menu |
| `settings.js` | Title char animation, remote polling, auth (`tryLogin`, `checkAuth`), prompts dialog, settings dialog, `afterAuth`, overview (`initOverview`, `renderBoardGrid`) |
| `notes.js` | Notes sidebar state, load/save (`loadNotes`, `scheduleSaveNotes`), page CRUD (`addNotePage`, `deleteNotePage`), sidebar toggle/resize, note modal (`openNoteModal`, `submitNote`), linked-card creation |
| `inbox.js` | Add-to-inbox modal (`openInboxModal`, `submitInboxCard`) used from the overview and board menu |
| `search.js` | Find-card dialog (`openSearch`, `closeSearch`) — text (all-words, accent-folding), priority, date range, and column filters; results open the edit modal |
| `init.js` | Entry point — calls `initTitleChars()` and `checkAuth()` |

## CouchDB

The board state is stored as a single document (`_id: "board"`) in the `jc-kanban-cards` database. On startup `db.js#initDb`:
1. Retries the CouchDB connection up to 15 times (2 s apart)
2. Creates the `jc-kanban-cards` database if absent
3. Seeds the `board` document from `data/data.json` (or built-in defaults) if absent

All configuration is via `.env` (forwarded to both containers by `docker-compose.yml`):

| Variable | Default | Description |
|---|---|---|
| `APP_PASSWORD` | `kanban-pwd` | Password for the web UI login |
| `API_KEY` | _(empty)_ | Static key for external API access; if unset, only session tokens are accepted |
| `PORT` | `3000` | HTTP port the server listens on |
| `HOST` | `localhost` | Bind address logged on startup |
| `COUCHDB_USER` | `kanban` | CouchDB admin username |
| `COUCHDB_PASSWORD` | `kanban-pwd` | CouchDB admin password |
| `COUCHDB_HOST` | `localhost` | CouchDB hostname (set to `couchdb` by compose) |
| `COUCHDB_PORT` | `5984` | CouchDB port |
| `BACKUP_DIR` | `data/` | Directory for JSON backups (`kanban-<name>-board.json`, `kanban-<name>-notes.json`, `extension-prompts.json`) |
| `BACKUP_INTERVAL_MS` | `600000` | How often backups run (ms); default 10 min |
| `TRUST_PROXY` | _(unset)_ | Set to `1` when running behind exactly one trusted reverse proxy (nginx/caddy); enables correct `req.ip` for rate limiting via `X-Forwarded-For` |

The Fauxton admin UI is available at `http://localhost:5984/_utils`.

## Icons

Before adding an icon, check whether a suitable one already exists in the project's icon library (inline SVGs in `index.html` or reused SVG markup in the JS/CSS). When a new icon is needed, prefer SVG over icon fonts or raster images.

## Frontend Patterns

The frontend maintains a single `state` object (`{ columns: [...] }`). After every mutation, `render()` wipes and rebuilds the board DOM from scratch (React-style, but vanilla JS).

**Auto-save:** mutations call `scheduleSave()` which debounces 600 ms then sends a `PATCH /api/:board/board` with only the changed columns/settings (falls back to `PUT` before the first successful load). A header indicator shows "saving…" / "✓ saved".

**Drag and drop:** uses the HTML5 Drag and Drop API. `dragState` tracks source column/card. `getDropIndex()` computes target insertion point from the pointer Y coordinate.

**Modal:** one reusable modal handles both add and edit card actions. `modalMode` (`'add'` | `'edit'`) controls behaviour; `openModal(colId)` resets all fields, `openEditModal(colId, card)` pre-fills them. Enter submits (except inside the description textarea); Escape closes.

## API endpoints

All `/api/*` routes require authentication via one of:
- **Session token** (browser): `x-auth-token: <token>` — obtained via `POST /api/auth`
- **API key** (external tools): `x-api-key: <key>` or `Authorization: Bearer <key>` — requires `API_KEY` set in `.env`

### Auth & global

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth` | Login; body: `{ "password" }`; returns `{ ok, token }` |
| `GET` | `/api/auth/verify` | Check if the current session token is valid |
| `GET` | `/api/settings` | Returns `{ apiKey }` (null if not configured) |
| `GET` | `/api/prompts` | Load global search prompts |
| `PUT` | `/api/prompts` | Save global search prompts; body: `{ searchProfile, criteriaInclude, criteriaExclude, searchRadius }` |

### Board management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/boards` | List all boards with card counts and metadata |
| `POST` | `/api/boards/:name` | Create a board (name: lowercase alphanumeric + hyphens, ≤ 64 chars, not `inbox`) |
| `POST` | `/api/boards/:name/rename` | Rename a board; body: `{ "newName" }` (≤ 12 chars) |
| `DELETE` | `/api/boards/:name` | Delete a board and all its data |

### Board data (`:board` = board name)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/:board/board` | Load full board state |
| `PUT` | `/api/:board/board` | Full replace of board state |
| `PATCH` | `/api/:board/board` | Partial update; body: `{ columnOrder?, updatedColumns?, removedColumnIds?, settings? }` |
| `GET` | `/api/:board/all-columns` | All columns as `{ "Title": [cards], … }` |
| `GET` | `/api/:board/column/:name` | Cards in a named column (case-insensitive) |
| `GET` | `/api/:board/card/:id` | Card history: `{ created, moves, column }` |
| `POST` | `/api/:board/move-to/:name` | Move a card to the named column (see below) |
| `POST` | `/api/:board/import` | Bulk-import cards (see below) |
| `GET` | `/api/:board/notes` | Load notes document |
| `PUT` | `/api/:board/notes` | Replace notes document; body: full notes object |
| `GET` | `/api/:board/notes/export` | Download notes as a ZIP archive (Markdown + attachments) |
| `GET` | `/api/:board/attachment-stats` | Returns `{ count, size }` for all attachments on the board |
| `GET` | `/api/:board/webdav-config` | Load WebDAV config: `{ enabled, url, user, hasPassword }` |
| `PUT` | `/api/:board/webdav-config` | Save WebDAV config; body: `{ enabled, url, user, password? }` |
| `POST` | `/api/:board/webdav-config/test` | Test WebDAV connectivity; returns `{ ok, message?, error? }` |
| `GET` | `/api/:board/webhook-config` | Load webhook config: `{ enabled, name, url, method }` |
| `PUT` | `/api/:board/webhook-config` | Save webhook config; body: `{ enabled, name, url, method }` |
| `POST` | `/api/:board/webhook/trigger` | Fire the configured webhook server-side; returns `{ ok, status?, error? }` |

WebDAV config is stored as a separate CouchDB document (`_id: "webdav-config"`) per board. When enabled, notes are synced with the configured WebDAV server (e.g. Nextcloud). Credentials are stored server-side and never sent to the browser.

Webhook config is stored as a separate CouchDB document (`_id: "webhook-config"`) per board. The configured button name appears in the board menu; clicking it fires `POST /:board/webhook/trigger` which makes a server-side HTTP request (GET/POST/PUT/PATCH) to the URL and returns the result in a dialog.

### Notes attachments (`:pageId` format: `n-<alphanumeric>`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/:board/notes/attachments/:pageId` | List attachments; returns `[{ name, size }]` |
| `POST` | `/api/:board/notes/attachments/:pageId` | Upload file (multipart `file` field, max 50 MB); returns `{ name, size }` |
| `GET` | `/api/:board/notes/attachments/:pageId/:filename` | Download attachment file |
| `DELETE` | `/api/:board/notes/attachments/:pageId/:filename` | Delete attachment; returns `{ ok: true }` |

### Card attachments (`:cardId` format: `id-<alphanumeric>`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/:board/cards/attachments` | List all card IDs that have at least one attachment |
| `GET` | `/api/:board/cards/attachments/:cardId` | List attachments for a card; returns `[{ name, size }]` |
| `POST` | `/api/:board/cards/attachments/:cardId` | Upload file (multipart `file` field, max 50 MB); returns `{ name, size }` |
| `GET` | `/api/:board/cards/attachments/:cardId/:filename` | Download attachment file |
| `DELETE` | `/api/:board/cards/attachments/:cardId/:filename` | Delete attachment; returns `{ ok: true }` |

## Move-to endpoint

`POST /api/:board/move-to/:name` — finds a card by composite text and moves it to the named column.

Body: `{ "job-title": "…", "company": "…", "location": "…" }` — card is looked up as `job-title | company | location`.

Returns `{ toBeMoved, moved, toColumn, success }`.

## Import endpoint

`POST /api/:board/import` — bulk-imports cards from external tools (e.g. n8n). Two accepted body formats:

**Plain array** — all items land in the inbox with their own color:
```json
[{ "text": "Card title", "priority": 1, "link": "https://…" }]
```

**Classified object** — `relevant` items get green (`#10b981`), `excluded` items get red (`#ef4444`):
```json
{ "relevant": [{ "text": "…" }], "excluded": [{ "text": "…" }] }
```

Job-application objects with `job-title`, `company`, `location`, and `reason` fields are auto-converted: `text` becomes `job-title | company | location` and `description` becomes `reason`.

Cards are deduplicated by `text` across all columns. New cards are prepended to the "Inbox" column (created at position 0 if absent; the column name includes today's date when `inboxWithDate` is enabled in settings).

Returns `{ relevant, relevant_items, excluded, excluded_items, skipped, skipped_items }`.

## Data Model

### Board document (`_id: "board"`)

```jsonc
{
  "columns": [
    {
      "id": "string",
      "title": "string",
      "color": "string",        // optional, drives the column dot color
      "actions": [],            // optional, auto-applied when a card is moved into this column
                                // values: "markDone" | "markUndone" | "setStartDate" | "setEndDate"
      "cards": [
        {
          "id": "string",
          "text": "string",
          "color": "string",    // optional
          "priority": 1,        // optional, 1 (highest) – 5 (lowest)
          "description": "string", // optional, rendered as Markdown
          "link": "string",     // optional, http/https only
          "startDate": "YYYY-MM-DD", // optional
          "endDate": "YYYY-MM-DD",   // optional
          "done": false,        // optional boolean, set via "Mark as done"
          "created": "YYYY-MM-DD",   // set automatically on card creation
          "moves": [            // optional, appended on every column move
            { "at": "ISO-8601", "from": "column title", "to": "column title" }
          ]
        }
      ]
    }
  ],
  "settings": {                 // optional, board-level configuration
    "description": "string",   // shown in the board overview grid
    "archived": false,          // hides the board from the active overview
    "inboxWithDate": false,     // prefix imported inbox columns with today's date
    "persistCollapse": false,   // save collapsed column state across sessions
    "collapsedColumnIds": [],   // persisted when persistCollapse is true
    "trackedColumns": [],       // column titles shown as card counts in the overview
    "autoSaveDialogs": false,   // auto-save card/note dialogs on a timer
    "autoSaveIntervalMin": 5    // interval in minutes for autoSaveDialogs (default 5, omitted when 5)
  }
}
```

### Notes document (`_id: "notes"`)

Stored as a separate CouchDB document per board.

```jsonc
{
  "pages": [
    {
      "id": "string",
      "title": "string",
      "description": "string",  // optional, rendered as Markdown
      "link": "string",          // optional, http/https only
      "linkedCards": [],         // optional, card IDs linked to this page
      "hasAttachments": false,   // optional, true when files have been uploaded
      "children": []             // optional, nested pages (same structure, recursive)
    }
  ]
}
```
