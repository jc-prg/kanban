# notes-webdav

A self-contained notes + WebDAV sync module for Express apps. Drop the folder into any project to add a Markdown notes sidebar with optional WebDAV (Nextcloud, ownCloud, …) sync.

## What it provides

- **Backend** — REST routes for notes CRUD, per-page attachments, WebDAV sync, and global WebDAV account management.
- **Frontend** — `notes.js` (wrapped in `initNotes(cfg)`) + `notes.css` for the sidebar, tree, and note editor.
- **HTML snippets** — Reference copies of the three HTML blocks to paste into your app's markup.

## Prerequisites

- Node 18+, Express 5
- CouchDB (via `nano`) — or bring your own storage adapter
- Vendor libs loaded before `notes.js`: `marked`, `DOMPurify`

---

## Backend wiring (3 steps)

### 1. Create the adapter

```js
// app/backend/notes-adapter.js
const { CouchDbAdapter } = require('./notes-webdav/backend');
const db       = require('./db');
const globalDb = require('./global-db');

module.exports = new CouchDbAdapter({
  getCouch:             db.getCouch,
  getBoardDb:           name => db.getBoardDb(name),
  getWebdavDb:          () => globalDb.getWebdavDb(),
  getWebdavAccountsFn:  () => globalDb.getWebdavAccounts(),
  saveWebdavAccountsFn: accounts => globalDb.saveWebdavAccounts(accounts),
});
```

### 2. Mount the routers

```js
const { createNotesRouter, createAccountsRouter } = require('./notes-webdav/backend');
const notesAdapter = require('./notes-adapter');
const { withBoard, withExistingBoard, writeRateLimit, uploadRateLimit } = require('./db');
const { ATTACHMENTS_DIR } = require('./config');

// Card-linking callback — returns a Map<cardId, card> for the board
async function resolveCards(boardName) {
  const db   = await getBoardDb(boardName);
  const doc  = await db.get('board').catch(() => ({ columns: [] }));
  const map  = new Map();
  for (const col of doc.columns || [])
    for (const card of col.cards || [])
      map.set(card.id, { ...card, colId: col.id });
  return map;
}

app.use('/api', createNotesRouter({
  adapter:         notesAdapter,
  withBoard,
  withExistingBoard,
  writeRateLimit,
  uploadRateLimit,
  attachmentsDir:  ATTACHMENTS_DIR,
  resolveCards,
}));
app.use('/api', createAccountsRouter({ adapter: notesAdapter, writeRateLimit }));
```

### 3. Serve the frontend

```js
app.use('/notes-webdav', express.static(path.join(__dirname, 'notes-webdav', 'frontend')));
```

---

## Frontend wiring

### HTML snippets

Paste the three snippets from `frontend/html-snippets/` into your app's HTML:

| Snippet | Where to paste |
|---|---|
| `notes-sidebar.html` | Inside the board layout, alongside your main content area |
| `note-modal.html` | At the end of `<body>`, before `<script>` tags |
| `webdav-settings.html` | Inside your settings dialog, as a section block |

Add the CSS and JS (after `marked.min.js` and `purify.min.js`):

```html
<link rel="stylesheet" href="/notes-webdav/notes.css">
<!-- ... your other scripts ... -->
<script src="/notes-webdav/notes.js"></script>
```

### Call `initNotes(cfg)` once after auth + board load

```js
window._notesModule = initNotes({
  apiBase:      '/api/my-board',   // prefix for all notes API calls
  boardName:    'my-board',        // used in document.title + print footer
  webdavEnabled: false,            // initial state (update after loading config)

  hooks: {
    scheduleSave:       () => myApp.scheduleSave(),
    render:             () => myApp.render(),
    showConfirm:        (msg, opts) => myApp.showConfirm(msg, opts), // Promise<bool>
    escHtml:            s => myApp.escHtml(s),
    openEditModal:      (colId, card) => myApp.openEditModal(colId, card),
    uid:                () => myApp.uid(),            // returns unique string ID
    getColumns:         () => myApp.state.columns,   // current columns array
    getSettings:        () => myApp.state.settings,  // current settings object
    getCardAttachCount: id => myApp.cardAttachMap.get(id) ?? null,
    createCard:         text => myApp.createCardInInbox(text), // returns cardId
  },

  icons: {
    collapse:         '▸',     // string or HTML
    expand:           '▾',
    done:             '✓',
    svgNetworkFolder: (w, h) => `<svg …>`,   // all icon functions: (w,h) => string
    svgFolder:        (w, h) => `<svg …>`,
    svgDelete:        (w, h) => `<svg …>`,
    svgClose:         (w, h) => `<svg …>`,
    svgAttachment:    (w, h) => `<svg …>`,
    svgAttachmentSm:  (w, h) => `<svg …>`,  // small variant (falls back to svgAttachment)
    svgFileImage:     (w, h) => `<svg …>`,
    svgFilePdf:       (w, h) => `<svg …>`,
    svgFileWeb:       (w, h) => `<svg …>`,
    svgLink:          (w, h) => `<svg …>`,
    svgLinkedCards:   (w, h) => `<svg …>`,
    svgSync:          (w, h) => `<svg …>`,
  },

  markdown: {
    render: text => DOMPurify.sanitize(marked.parse(text)),
  },

  editor: {
    // CodeMirror / textarea editor integration
    create:      (fieldId, opts) => createMarkdownEditor(fieldId, opts),
    setValue:    (fieldId, text) => setEditorValue(fieldId, text),
    getValue:    fieldId => getEditorValue(fieldId),
    isActive:    fieldId => isEditorActive(fieldId),
    focus:       fieldId => focusEditor(fieldId),
    applyFormat: (fieldId, fmt) => applyEditorFormat(fieldId, fmt),
  },

  print: {
    buildItem: ({ board, context, title, body, footerRows }) => /* HTML string */ '',
    trigger:   rootEl => window.print(),
    fmtDate:   date => date.toLocaleDateString(),
  },
});

await window._notesModule.loadNotes();
```

### Public API

| Method | Description |
|---|---|
| `loadNotes()` | Fetch notes from API (and sync WebDAV if enabled) |
| `updateWebdavEnabled(bool)` | Call after saving WebDAV config to update UI |
| `syncNotesWithWebdav()` | Manually trigger a WebDAV sync |
| `toggleNotesSidebar()` | Open/close the sidebar |
| `restoreNotesSidebar()` | Restore sidebar open state + width from settings |
| `openNoteModal(pageId)` | Open the note editor for a page |
| `closeNoteModal()` | Close the note editor |
| `linkCardToPage(cardId, pageId)` | Link a card to a note page (confirms with user) |
| `printNote(pageId)` | Print a note page |
| `findNotePage(id, items)` | Find a page by ID in the notes tree |
| `findNoteItem(id, items)` | Find any item (page or folder) by ID |
| `getNotesState()` | Returns the current notes state object |
| `buildToc(el)` | Resolve `[toc]` in a rendered markdown element |
| `resolveAttachments(el)` | Replace attachment `<img>` src with blob URLs |
| `renderNotesTree()` | Force a tree re-render |

### Card-to-page drag linking

The drag listeners reference your app's touch-drag state, so they must live in the host app. Wire them like this:

```js
let _notesDragCard = null, _notesDragOverItem = null;

document.addEventListener('dragstart', e => {
  _notesDragCard = null; _notesDragOverItem = null;
  const cardEl = e.target.closest('[data-card-id]');
  const colEl  = cardEl?.closest('[data-col-id]');
  if (cardEl && colEl) _notesDragCard = { cardId: cardEl.dataset.cardId };
}, true);

document.addEventListener('dragover', e => {
  if (!_notesDragCard) return;
  const item = e.target.closest('.notes-tree-item--page');
  if (_notesDragOverItem && _notesDragOverItem !== item) {
    _notesDragOverItem.classList.remove('notes-tree-item--drag-over');
    _notesDragOverItem = null;
  }
  if (!item) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  if (_notesDragOverItem !== item) { item.classList.add('notes-tree-item--drag-over'); _notesDragOverItem = item; }
}, true);

document.addEventListener('drop', async e => {
  const item = _notesDragOverItem;
  if (item) item.classList.remove('notes-tree-item--drag-over');
  _notesDragOverItem = null;
  if (!item || !_notesDragCard) return;
  e.preventDefault(); e.stopPropagation();
  const { cardId } = _notesDragCard; _notesDragCard = null;
  const pageId = item.dataset.itemId || item.dataset.pageId;
  await window._notesModule?.linkCardToPage(cardId, pageId);
}, true);
```

---

## Storage adapter interface

Implement these methods to use a non-CouchDB backend:

```js
class MyAdapter {
  async loadNotes(boardName)                   // → { schemaVersion: 2, items: [] }
  async loadNotesWithRev(boardName)            // → { data: {...}, rev: string|null }
  async saveNotes(boardName, data)             // → { rev: string }
  async loadWebdavConfig(boardName)            // → { enabled, accountId, subfolder, ... }
  async saveWebdavConfig(boardName, cfg)       // → void
  async resolveWebdavCfg(boardName)            // → { enabled, url, user, password }
  async loadWebdavAccounts()                   // → [{ id, label, url, user, password }]
  async saveWebdavAccounts(accounts)           // → void
}
```

---

## REST API routes mounted by the module

All routes are prefixed with `/api` (the `app.use('/api', ...)` mount point).

### Notes routes (`createNotesRouter`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/:board/notes` | Load notes document |
| `PUT` | `/:board/notes` | Replace notes document |
| `PATCH` | `/:board/notes` | Partial update (WebDAV-mode ops) |
| `POST` | `/:board/notes/pages` | Create a page (WebDAV mode) |
| `GET` | `/:board/notes/pages/:pageId/content` | Get page content + lastModified |
| `PATCH` | `/:board/notes/pages/:pageId` | Update a page (WebDAV mode) |
| `DELETE` | `/:board/notes/pages/:pageId` | Delete a page (WebDAV mode) |
| `GET` | `/:board/notes/export` | ZIP download of all notes + attachments |
| `GET` | `/:board/webdav-config` | Load WebDAV config |
| `PUT` | `/:board/webdav-config` | Save WebDAV config |
| `POST` | `/:board/webdav-config/test` | Test WebDAV connection |
| `GET` | `/:board/notes/attachments/:pageId` | List page attachments |
| `POST` | `/:board/notes/attachments/:pageId` | Upload attachment |
| `GET` | `/:board/notes/attachments/:pageId/:filename` | Download attachment |
| `DELETE` | `/:board/notes/attachments/:pageId/:filename` | Delete attachment |

### Account routes (`createAccountsRouter`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/webdav-accounts` | List global WebDAV accounts |
| `POST` | `/webdav-accounts` | Create account |
| `PUT` | `/webdav-accounts/:id` | Update account |
| `DELETE` | `/webdav-accounts/:id` | Delete account |
