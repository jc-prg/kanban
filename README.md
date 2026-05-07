# Kanban App

> **Single-user application.** Authentication is a single global password with no per-board or per-user access control. One valid session token grants full read/write/delete access to all boards. Do not expose this app to untrusted users or the public internet without additional access controls in front of it.

## Setup & Start

```bash
cd kanban/app
npm install
node server.js
```

Then open: http://localhost:3000

Or via Docker (from project root):
```bash
docker compose up -d --build
```

## Features
- Drag & Drop cards within and between columns
- Add / delete columns (column titles are editable)
- Add / delete cards (card text is editable inline)
- Color tags per card
- Auto-save to `data.json` (debounced, 600ms)

## Files
- `app/server.js` – Express backend (REST API + static file serving)
- `app/public/index.html` – Single-file frontend
- `data/data.json` – Board state (auto-created on first start)

## API
- `GET  /api/board` – Load full board state
- `PUT  /api/board` – Save board state (full replace)
- `GET  /api/all-columns` – All columns as `{ "Title": [cards], … }`
- `GET  /api/column/:name` – Cards in a single column (case-insensitive name)
- `POST /api/move-to/:name` – Move a card to the named column; body: `{ "job-title", "company", "location" }`
- `POST /api/import` – Bulk-import cards; body: JSON array or `{ "relevant": [], "excluded": [] }`; returns `{ added, skipped }`
