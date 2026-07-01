# Kanban App

A self-hosted, single-user kanban board with a vanilla JS frontend and a CouchDB-backed Express backend. Manage tasks across multiple boards with drag-and-drop cards, a Markdown notes sidebar, file attachments, a personal dashboard aggregating cards, email (IMAP), and calendar (CalDAV/iCal), and optional WebDAV sync for notes.

> **Single-user application.** Authentication is a single global password with no per-board or per-user access control. One valid session token grants full read/write/delete access to all boards. Do not expose this app to untrusted users or the public internet without additional access controls in front of it.

## Setup & Start

```bash
cd kanban/app
npm install
node backend/server.js
```

Or via Docker (from project root):
```bash
docker compose up -d --build
```

Then open: http://localhost:3000

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
