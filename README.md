# Kanban App

> **Single-user application.** Authentication is a single global password with no per-board or per-user access control. One valid session token grants full read/write/delete access to all boards. Do not expose this app to untrusted users or the public internet without additional access controls in front of it.

## Setup & Start

```bash
cd kanban/app
npm install
node backend/server.js
```

Then open: http://localhost:3000

Or via Docker (from project root):
```bash
docker compose up -d --build
```

## Features
- Multiple boards — create, rename, archive, delete
- Drag & drop cards within and between columns; drag columns to reorder
- Add / edit / delete cards with color tags, priority, dates, description (Markdown), and link badge
- Notes sidebar per board — hierarchical pages and folders, Markdown editor, WebDAV sync
- Full-text search across all cards with priority, date-range, and column filters
- Card and note attachments (upload, download, paste image)
- **Dashboard** — personal overview page showing cards from configured board columns, IMAP mail accounts, and CalDAV / iCal calendar accounts; right-click card context menu; drag-to-reorder sources
- WebDAV sync: sync notes with a WebDAV server (e.g. Nextcloud) per board — credentials stored server-side
- Webhook trigger: configure a URL and label per board; fires a server-side HTTP request and shows the response
- Auto-save (debounced 600 ms); print view for cards and notes

## Files

```
app/
  backend/
    server.js           Express entry point
    config.js           Env vars and derived constants
    db.js               CouchDB helpers
    auth.js             Authentication middleware
    routes/             REST API routers
    dashboard/          Dashboard data fetchers (mail.js, calendar.js)
  frontend/
    index.html          HTML shell + modal markup
    styles/             CSS (base, layout, column, card, overlay, notes, dashboard, …)
    *.js                Vanilla JS modules (icons, state, render, menus, dashboard, …)
data/                   JSON backups (auto-created)
```

## API

Full API reference is in `CLAUDE.md`. Key endpoint groups:

- `POST /api/auth` — login
- `GET/POST/DELETE /api/boards/:name` — board management
- `GET/PUT/PATCH /api/:board/board` — board state
- `GET /api/:board/all-columns` — all columns with cards
- `POST /api/:board/import` — bulk card import
- `GET/PUT /api/:board/notes` — notes document
- `GET/PUT /api/:board/webdav-config` — WebDAV config
- `GET/PUT /api/:board/webhook-config` — webhook config
- `GET/PUT /api/dashboard/config` — dashboard config (card sources, mail, calendar accounts)
- `GET /api/dashboard/data` — fetch all dashboard data in parallel
