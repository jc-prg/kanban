# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
cd app
npm install        # install dependencies
npm start          # start server at http://localhost:3000
node server.js     # equivalent to npm start
```

Or via Docker (from project root):
```bash
docker compose up -d --build
```

No build step, no linter, no test framework configured.

## Architecture

Single-page kanban board with a minimal three-layer design:

- **`app/server.js`** — Express 5 backend. Serves `public/` as static files and exposes six REST endpoints. Persists all data in CouchDB (`jc-kanban-cards` database, single `board` document). Uses `nano` as the CouchDB client.
- **`app/public/index.html`** — Markup and modal HTML only. References `style.css` and `app.js`.
- **`app/public/style.css`** — All styles. Uses CSS custom properties defined on `:root` for the design system (colors, spacing, radius).
- **`app/public/app.js`** — All frontend logic. No framework, no bundler.
- **`data/data.json`** — Optional seed file. Used once on first startup to populate the CouchDB board document if it doesn't exist yet.

## CouchDB

The board state is stored as a single document (`_id: "board"`) in the `jc-kanban-cards` database. On startup `server.js`:
1. Retries the CouchDB connection up to 15 times (2 s apart)
2. Creates the `jc-kanban-cards` database if absent
3. Seeds the `board` document from `data/data.json` (or built-in defaults) if absent

CouchDB credentials are set in `.env` and forwarded to both containers via `docker-compose.yml`:

| Variable | Default | Description |
|---|---|---|
| `COUCHDB_USER` | `kanban` | Admin username |
| `COUCHDB_PASSWORD` | `kanban-pwd` | Admin password |
| `COUCHDB_HOST` | `localhost` | Hostname (set to `couchdb` by compose) |
| `COUCHDB_PORT` | `5984` | Port |

The Fauxton admin UI is available at `http://localhost:5984/_utils`.

## Frontend Patterns

The frontend maintains a single `state` object (`{ columns: [...] }`). After every mutation, `render()` wipes and rebuilds the board DOM from scratch (React-style, but vanilla JS).

**Auto-save:** mutations call `scheduleSave()` which debounces 600 ms then `PUT /api/board` with the full state. A header indicator shows "saving…" / "saved".

**Drag and drop:** uses the HTML5 Drag and Drop API. `dragState` tracks source column/card. `getDropIndex()` computes target insertion point from the pointer Y coordinate.

**Modal:** one reusable modal handles both add and edit card actions. `modalMode` (`'add'` | `'edit'`) controls behaviour; `openModal(colId)` resets all fields, `openEditModal(colId, card)` pre-fills them. Enter submits (except inside the description textarea); Escape closes.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/board` | Load full board state |
| `PUT` | `/api/board` | Save board state (full replace) |
| `GET` | `/api/all-columns` | All columns as `{ "Title": [cards], … }` |
| `GET` | `/api/column/:name` | Cards in a single column (case-insensitive) |
| `POST` | `/api/move-to/:name` | Move a card to the named column; body: `{ "job-title", "company", "location" }`; returns `{ toBeMoved, moved, toColumn, success }` |
| `POST` | `/api/import` | Bulk-import cards (see below) |

## Import endpoint

`POST /api/import` — accepts a JSON array of card objects from external tools (e.g. n8n). For each item:
- Skips if `text` is missing or already exists in any column (deduplication by `text`)
- Appends new cards to the "Inbox" column, creating it at position 0 if absent
- Returns `{ added: N, skipped: N }`

All card fields are accepted (`text` required, all others optional — same schema as below).

## Data Model

```jsonc
{
  "columns": [
    {
      "id": "string",
      "title": "string",
      "color": "string",       // optional, drives the column dot color
      "cards": [
        {
          "id": "string",
          "text": "string",
          "color": "string",
          "priority": 1,       // optional, 1 (highest) – 5 (lowest)
          "description": "string", // optional
          "link": "string",    // optional, http/https only
          "startDate": "YYYY-MM-DD", // optional
          "endDate": "YYYY-MM-DD"    // optional
        }
      ]
    }
  ]
}
```
