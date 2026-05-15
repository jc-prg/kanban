# Concept: WebDAV as alternative notes backend

Enable a per-board option to store notes on an external WebDAV server instead
of CouchDB. When active, the kanban app acts as a WebDAV **client**: all notes
reads and writes go to the configured remote. Obsidian points its
*Remotely Save* plugin at the same WebDAV folder, giving seamless
bidirectional access to the same Markdown files.

CouchDB-based notes remain the default and are unaffected for boards that do
not enable the option.

---

## Architecture overview

```
Browser (kanban UI)
      │ existing notes API  (GET/PUT /api/:board/notes)
      ▼
Express backend
      │
      ├─ webdavEnabled = false  ──►  CouchDB  (current default)
      │
      └─ webdavEnabled = true   ──►  WebDAV client  ──►  WebDAV server
                                                          (Nextcloud, etc.)
                                                               ▲
                                                        Obsidian (Remotely Save)
```

The frontend does not change. The notes API contract stays identical; only the
storage layer swaps.

---

## Board settings

A new **WebDAV** section is added to the board settings dialog (only shown on
board views, not the overview). It contains:

| Field | Type | Description |
|---|---|---|
| Enable WebDAV notes | toggle | Activates the WebDAV backend for this board |
| Server URL | text | Base URL of the WebDAV collection, e.g. `https://cloud.example.com/remote.php/dav/files/user/kanban/my-board/` |
| Username | text | WebDAV username |
| Password | password | WebDAV password (stored in board settings, see Security note) |
| Test connection | button | Sends a `PROPFIND` to the URL and shows success / error inline |

### Settings schema addition

```jsonc
"settings": {
  // … existing fields …
  "webdav": {
    "enabled": true,
    "url": "https://…/kanban/my-board/",
    "username": "alice",
    "password": "…"   // see Security note
  }
}
```

**Security note:** WebDAV credentials are stored in the board's CouchDB
document. This is acceptable for a self-hosted single-user application where
CouchDB is not publicly exposed. As a hardening option a later phase could
move credentials to an env-var map keyed by board name.

---

## Data mapping: notes tree ↔ Markdown files

The notes document is translated to a directory of Markdown files on the
WebDAV server. The same mapping is used for all reads and writes.

### Tree → files

```
notes.pages
  └─ page { id, title, description, link, linkedCards, children }
       ├─ no children  →  <title>.md
       └─ has children →  <title>/index.md   (page's own content)
                          <title>/<child>.md  (recursive)
```

### File content (YAML front-matter + body)

```markdown
---
id: n-abc123
link: https://example.com
linkedCards:
  - id-xyz
---

The page body (description field) goes here as Markdown.
```

On read the front-matter fields `id`, `link`, and `linkedCards` are recovered;
`title` comes from the filename (strip `.md`, decode percent-encoding).
On write only `description` is updated (the front-matter fields are
round-tripped verbatim to preserve Obsidian-added metadata).

### Attachments

Notes attachments are stored in a sibling `_attachments/<pageId>/` folder on
the WebDAV server. The existing attachment API routes proxy `GET`/`PUT`/
`DELETE` to those paths when WebDAV mode is active.

---

## Backend changes

### `app/backend/db.js` — WebDAV adapter

Add two functions alongside `loadNotesData` / `saveNotesData`:

```js
async function loadNotesFromWebdav(settings)  { … }  // PROPFIND + GET → notes object
async function saveNotesToWebdav(settings, notes) { … }  // diff old vs new → PUT / DELETE / MKCOL
```

The adapter:
1. Issues a `PROPFIND Depth:1` to enumerate existing `.md` files.
2. Fetches each file with `GET` and parses front-matter + body.
3. Reconstructs the `{ pages: […] }` tree from the file hierarchy.
4. On save, computes the minimal set of `PUT` / `DELETE` / `MKCOL` calls needed
   to reconcile the new tree with what exists on the server.

No new npm dependency is required: `node:https` / `node-fetch` (already
indirectly available via Express deps) is enough for simple WebDAV calls.
If a richer client is preferred, `webdav` (npm, MIT) provides a clean API.

### `app/backend/routes/notes.js` — dispatch

```js
async function getNotesBackend(db, settings) {
  if (settings?.webdav?.enabled) return loadNotesFromWebdav(settings.webdav);
  return loadNotesData(db);
}

async function saveNotesBackend(db, settings, data) {
  if (settings?.webdav?.enabled) return saveNotesToWebdav(settings.webdav, data);
  return saveNotesData(db, data);
}
```

The `GET /:board/notes` and `PUT /:board/notes` handlers call these wrappers
instead of `loadNotesData` / `saveNotesData` directly. Everything else
(validation, ETag, rate-limiting) remains unchanged.

### `app/backend/routes/boards.js` — settings endpoint

The new `webdav` sub-object must be accepted by the settings `PATCH` handler
and persisted to the board document. The password field should be excluded from
`GET /api/boards` list responses (return `webdav.enabled` and `webdav.url` but
omit `webdav.password`).

### New endpoint: `POST /api/:board/settings/webdav/test`

Used by the "Test connection" button. Sends a `PROPFIND Depth:0` to the
configured URL with the supplied credentials and returns `{ ok, error }`.
Does not save anything.

---

## Frontend changes

### Settings dialog — new WebDAV section

Shown only on board pages (same condition as `boardDescSection`):

```html
<div id="webdavSection">
  <h3>Notes storage</h3>
  <label>
    <input type="checkbox" id="webdavEnabledToggle">
    Use WebDAV server instead of local database
  </label>
  <div id="webdavFields">   <!-- hidden when toggle is off -->
    <input id="webdavUrl"      type="url"      placeholder="https://…/kanban/board/">
    <input id="webdavUsername" type="text"     placeholder="Username">
    <input id="webdavPassword" type="password" placeholder="Password">
    <button id="webdavTestBtn">Test connection</button>
    <span   id="webdavTestResult"></span>
  </div>
</div>
```

`settings.js` reads/writes these fields alongside the existing settings fields.
The password input is pre-filled only if a password is already stored
(`value = storedPassword ? '••••••••' : ''`; a real change clears and
re-enters).

### Save behaviour

WebDAV settings are saved via the existing `PATCH /api/:board/board` settings
path. No separate save button — the main "Save settings" action covers it.

---

## Migration when switching backends

### General rules

- **Nothing is ever deleted** during a migration. Both sides are treated as
  additive sources.
- Pages are merged at the top level. Nested children are carried along with
  their parent and are not individually deduplicated.
- A top-level title collision (case-insensitive match) is resolved by
  appending ` (from webdav)` to the title of the WebDAV page. The CouchDB
  page title is kept as-is.

### CouchDB → WebDAV (enabling WebDAV)

1. Read the current CouchDB notes document (may be empty).
2. Fetch the current state from the WebDAV server (may be empty or pre-existing
   Obsidian vault).
3. Merge top-level pages:
   - Pages that exist only in CouchDB are written to WebDAV as new `.md` files.
   - Pages that exist only on WebDAV are added to the merged result as-is.
   - Pages whose titles collide at the top level: the WebDAV page is renamed
     to `<title> (from webdav)` before merging; both pages are kept.
4. The merged result becomes the new authoritative state and is written to the
   WebDAV server.
5. The CouchDB notes document is updated to reflect the merged state (kept as
   read-through cache; see Limitations).
6. `webdav.enabled = true` is saved to board settings.

### WebDAV → CouchDB (disabling WebDAV)

1. Fetch the current state from the WebDAV server.
2. Read the current CouchDB notes document.
3. Apply the same merge logic:
   - Pages only on WebDAV are added to the CouchDB document.
   - Pages only in CouchDB are kept.
   - Title collisions at the top level: the WebDAV page is renamed
     `<title> (from webdav)` before merging; both pages are kept.
4. The merged result is written to CouchDB.
5. `webdav.enabled = false` is saved to board settings.

Both migrations are triggered automatically by the settings save handler when
it detects a change in `webdav.enabled`.

---

## Obsidian setup

1. Install the **Remotely Save** community plugin.
2. In plugin settings choose **WebDAV** as the remote type.
3. Enter the same URL, username, and password configured in board settings.
4. Run *Sync* — Obsidian downloads all `.md` files.
5. Edits in Obsidian are pushed back on the next sync; the kanban app reads
   them on the next `GET /api/:board/notes` call.

> One Obsidian vault per board is the natural mapping. The vault root
> corresponds to the board's WebDAV collection root.

---

## Limitations and open questions

| Topic | Note |
|---|---|
| **Concurrent writes** | If Obsidian and the kanban UI write simultaneously, last write wins (no `_rev` locking on WebDAV). Acceptable for a single-user app; can be mitigated by saving from the UI only on explicit user action when WebDAV mode is active. |
| **Offline / unreachable server** | Notes load must degrade gracefully when the WebDAV server is unreachable. Suggestion: return a cached copy from CouchDB (the last-known state is still written there as a read-through cache). |
| **ETag / polling** | The `checkForUpdates` polling in `settings.js` currently checks the board ETag. Notes polling is separate (`loadNotes` on sidebar open). No change needed; Obsidian changes will appear the next time the sidebar is opened or notes are reloaded. |
| **Credential exposure** | Storing the WebDAV password in the board document means it appears in JSON backups. Document this clearly in the settings UI. |
| **Large vaults** | A full PROPFIND + GET on every `loadNotes` call is expensive for large vaults. Add a lightweight ETag / `Last-Modified` check: issue `PROPFIND` first; if the collection `getlastmodified` has not changed since the last load, return the cached notes object. |
| **Page ID stability** | IDs (`n-abc123`) are stored in front-matter. If Obsidian renames a file without preserving front-matter, the ID is lost on the next read and a new one must be generated. The page link to cards will break. Consider treating `title` (filename) as the stable key when no `id` front-matter is present. |
| **npm dependency** | The `webdav` npm package (MIT, well-maintained) removes the need to hand-roll PROPFIND XML parsing. Worth adding given the scope of WebDAV interaction involved. |
