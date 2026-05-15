# Refactoring proposal: server.js

`server.js` is currently ~1080 lines, all in one file. This proposes splitting it into focused modules with no logic changes.

## Proposed structure

```
app/
├── server.js              ← entry point only: init, middleware, mount routers, start
├── config.js              ← all env vars and constants
├── db.js                  ← nano connection, getBoardDb, load/save board & notes
├── auth.js                ← safeEqual, rate limiting maps, authenticate middleware
├── schemas.js             ← AJV instance, all validate* functions, schemaError
├── backup.js              ← runBackup, runPromptsBackup, checkDataDirectories
└── routes/
    ├── auth.js            ← POST /api/auth, GET /api/auth/verify, POST /api/auth/logout
    ├── boards.js          ← GET/POST/DELETE /api/boards, rename, achievements
    ├── board.js           ← GET/PUT/PATCH /api/:board/board, all-columns, column, card, move-to, import
    ├── notes.js           ← GET/PUT/PATCH /api/:board/notes, notes/export
    ├── attachments.js     ← all /notes/attachments and /cards/attachments routes, db-size
    └── prompts.js         ← GET/PUT /api/prompts, GET /api/settings
```

## What moves where

| Current location | Moves to |
|---|---|
| `const PORT`, `APP_PASSWORD`, `DB_PREFIX`, `BACKUP_DIR`, etc. | `config.js` |
| `couch`, `getBoardDb`, `loadBoardData`, `saveBoardData`, `loadNotesData`, `saveNotesData` | `db.js` |
| `safeEqual`, `loginMap`, `authFailMap`, `loginState`, `recordAuthFailure`, `authenticate` | `auth.js` |
| `ajv`, `validateBoard`, `validateBoardPatch`, `validateNotes`, `validateNotesPatch`, `schemaError` | `schemas.js` |
| `runBackup`, `runPromptsBackup`, `checkDataDirectories`, `computeDirSize`, `refreshDbSize` | `backup.js` |
| Auth routes (`/api/auth*`) | `routes/auth.js` |
| Board management routes | `routes/boards.js` |
| Per-board data routes | `routes/board.js` |
| Notes routes | `routes/notes.js` |
| Attachment routes + `/api/db-size` | `routes/attachments.js` |
| Prompts + global settings | `routes/prompts.js` |

## What `server.js` becomes (~30 lines)

```js
require('dotenv').config();
const express = require('express');
const path    = require('path');
const { PORT, HOST, BACKUP_INTERVAL_MS } = require('./config');
const { initDb }           = require('./db');
const { authenticate }     = require('./auth');
const { runBackup, runPromptsBackup, checkDataDirectories,
        refreshDbSize, DB_SIZE_INTERVAL_MS } = require('./backup');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// ... logging middleware ...
app.use('/api', authenticate);

app.use('/api',        require('./routes/auth'));
app.use('/api',        require('./routes/prompts'));
app.use('/api/boards', require('./routes/boards'));
app.use('/api',        require('./routes/board'));
app.use('/api',        require('./routes/notes'));
app.use('/api',        require('./routes/attachments'));

const SPA_HTML = path.join(__dirname, 'public', 'index.html');
app.get('/:board',       (req, res) => res.sendFile(SPA_HTML));
app.get('/:board/*path', (req, res) => res.sendFile(SPA_HTML));

initDb().then(() => {
  checkDataDirectories();
  app.listen(PORT, () => console.log(`Kanban server running at http://${HOST}:${PORT}`));
  runBackup();        setInterval(runBackup,        BACKUP_INTERVAL_MS);
  runPromptsBackup(); setInterval(runPromptsBackup, BACKUP_INTERVAL_MS);
  refreshDbSize();    setInterval(refreshDbSize,    DB_SIZE_INTERVAL_MS);
}).catch(err => { console.error('Failed to initialize:', err.message); process.exit(1); });
```

## Key decisions

- **`withBoard` / `withExistingBoard`** move to `db.js` — they depend on `couch`, which lives there anyway
- **`upload` / `uploadCard` multer instances** unify into one configurable factory in `attachments.js` — they are identical except for the path segment name (`pageId` vs `cardId`)
- **`safeFilename` / `safePageId` / `safeCardId`** stay in `attachments.js` — only used there
- **`validBoardName`** goes to `db.js` — used by `withBoard`/`withExistingBoard` and imported by route files that need it
- No logic changes, no new dependencies — pure reorganization

## What NOT to change

- The logic inside each handler (it's clean)
- The flat `express.Router` pattern (no need for nested routers)
- The AJV schemas (already well-organized, just extracted to their own file)

## Suggested implementation order

1. `config.js` — no dependencies, unblocks everything else
2. `schemas.js` — depends only on `ajv`
3. `db.js` — depends on `config.js`
4. `auth.js` — depends on `config.js`
5. `backup.js` — depends on `config.js` and `db.js`
6. Route files — depend on `db.js`, `schemas.js`, `auth.js`
7. `server.js` — last, wires everything together
