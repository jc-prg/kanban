# Concept: WebDAV as alternative notes backend

Enable a per-board option to store notes on an external WebDAV server instead
of CouchDB. When active, the kanban app acts as a WebDAV **client**: all notes
reads and writes go to the configured remote. Obsidian points its
*Remotely Save* plugin at the same WebDAV folder, giving seamless
bidirectional access to the same Markdown files.

CouchDB-based notes remain the default and are unaffected for boards that do
not enable the option.

**Status: implemented and refined** — see commit history on `master`.

---

## Architecture overview

```
Browser (kanban UI)
      │ existing notes API  (GET/PUT/PATCH /api/:board/notes)
      │ existing attach API (GET/POST/DELETE /api/:board/notes/attachments/…)
      ▼
Express backend
      │
      ├─ webdavEnabled = false  ──►  CouchDB  (default)
      │
      └─ webdavEnabled = true   ──►  WebDAV client  ──►  WebDAV server
                                     (webdav-notes.js)    (Nextcloud, etc.)
                                                               ▲
                                                        Obsidian (Remotely Save)
```

The frontend notes UI does not change. The notes and attachment API contracts
stay identical; only the storage layer swaps. CouchDB is kept as a
read-through cache and offline fallback even in WebDAV mode.

---

## Board settings

A **Notes storage** section is added to the board settings dialog (board pages
only). It contains:

| Field | Type | Description |
|---|---|---|
| Enable WebDAV notes | toggle | Activates the WebDAV backend for this board |
| Server URL | text | Base URL of the WebDAV collection, e.g. `https://cloud.example.com/remote.php/dav/files/user/kanban/my-board/` |
| Username | text | WebDAV username |
| Password | password | WebDAV password (stored in board settings, see Security note) |
| Test connection | button | Sends a `PROPFIND Depth:0` and shows success / error inline |
| Save WebDAV settings | button | Explicit save — triggers migration when `enabled` changes, then reloads notes |

### Settings schema

```jsonc
"settings": {
  // … existing fields …
  "webdav": {
    "enabled": true,
    "url": "https://…/kanban/my-board/",
    "username": "alice",
    "password": "…"
  }
}
```

**Security note:** WebDAV credentials are stored in the board's CouchDB
document. This is acceptable for a self-hosted single-user application where
CouchDB is not publicly exposed. As a hardening option a later phase could
move credentials to an env-var map keyed by board name.

---

## Data mapping: notes tree ↔ Markdown files

### Tree → files

```
notes.pages
  └─ page { id, title, description, link, linkedCards, attachments, children }
       ├─ no children  →  <title>.md
       └─ has children →  <title>/index.md   (page's own content)
                          <title>/<child>.md  (recursive)
```

Titles are sanitised for use as filenames (characters `/\<>:|*?"` replaced
with `_`). Page metadata is stored in YAML front-matter:

```markdown
---
id: n-abc123
order: 2
link: https://example.com
linkedCards:
  - id-xyz
attachments:
  - photo.png
  - report.pdf
lastModified: 2026-05-15T20:00:00.000Z
---

The page body (description field) goes here as Markdown.
```

Fields recovered on read: `id`, `order`, `link`, `linkedCards`, `attachments`,
`lastModified`. The `title` comes from the filename. On write, the
front-matter is round-tripped verbatim so Obsidian-added metadata is
preserved.

The `order` field is a zero-based integer written by kanban to preserve the
sidebar drag-reorder sequence through WebDAV round-trips. `loadDir` sorts
loaded pages by this value; Obsidian-created files that have no `order` field
sort to the end of the list.

The `attachments` list is the union of `page.attachments` (maintained by the
frontend) and any `(attachment:filename)` links found in the body — so files
referenced in Obsidian-edited markdown are automatically detected.
`lastModified` is stored so the 3-way merge can resolve conflicts without
always preferring local, and so background polling can detect when nothing
actually changed.

### Obsidian vault compatibility

The file/directory structure produced by kanban is a valid Obsidian vault:

- Each leaf page → a standalone `.md` file. Obsidian shows it as a note.
- Each page with children → a directory containing `index.md`. Obsidian
  shows the directory in its file explorer; the `index.md` is the folder's
  own note. The optional **Folder Note** or **Folder Notes** community
  plugins make this first-class in Obsidian's UI.
- Files created by Obsidian (no `id:` front-matter, or unknown id) are
  loaded into the kanban tree as new pages on the next sync. They are
  **never deleted** by kanban's sync unless the user explicitly deletes that
  page inside kanban (see `deletedPageIds` below).

### Deletion tracking: `deletedPageIds`

Kanban must be able to remove files from WebDAV when the user deletes a page,
while leaving Obsidian-created files untouched. To distinguish intentional
deletions from externally-created files, the notes document carries a
`deletedPageIds` array:

```jsonc
{
  "pages": [...],
  "deletedPageIds": ["n-old1", "n-old2"]  // ids explicitly deleted by the user
}
```

When `deleteNotePage(id)` is called in the frontend, the page's id (and all
its children's ids) are appended to `notesState.deletedPageIds`. The next
save (always a structural PUT) sends this list to the backend.

`syncDir` reads the front-matter `id:` field of each orphan file/directory
(a `GET` per orphan) and issues a `DELETE` when:

- the id is in **`allPageIds`** (the set of all ids currently in the tree):
  the page was **renamed or moved** — the new filename/path was already
  written by `syncDir` in the same pass, so removing the stale old path is
  safe; or
- the id is in **`deletedPageIds`**: the page was **explicitly deleted**
  by the user in kanban.

Files created by Obsidian — with no `id:` front-matter or an id not present
in either set — are left completely intact.

After a successful sync the backend clears `deletedPageIds` in the CouchDB
cache. The frontend's copy is cleared on the next `loadNotes()` call.
`mergeNotesStates` unions `deletedPageIds` from both local and remote sides
so pending deletions survive a 3-way merge.

### Attachments

Notes attachments are stored under `_attachments/<pageId>/` relative to the
WebDAV board root:

```
/                            ← board root (.md files here)
/_attachments/               ← all page attachments
/_attachments/n-abc123/      ← attachments for page n-abc123
/_attachments/n-abc123/photo.png
```

The `_attachments` directory and any other `_`-prefixed entries are never
touched by the notes sync — `loadDir` skips them during reads and `syncDir`
excludes them from orphan deletion.

Every attachment fetched from WebDAV is also written to the local
`ATTACHMENTS_DIR/<board>/<pageId>/` directory as a cache. On subsequent
requests the local copy is served directly; WebDAV is only contacted when the
local copy is absent or stale. Uploads write to both WebDAV and local cache
simultaneously. Deletes remove both.

Card attachments are not affected by WebDAV mode; they remain stored locally.

---

## Implementation

### `app/backend/webdav-notes.js`

Self-contained WebDAV client using Node's built-in `http`/`https` — no new
npm dependency. Key internals:

| Function | Description |
|---|---|
| `buildUrl(cfg, relPath)` | Constructs a full URL by percent-encoding each path segment and appending to `cfg.url` |
| `wdRequest(cfg, method, relPath, opts)` | Low-level HTTP request; accepts string or Buffer body; returns `{ status, body, rawBody }` |
| `parsePropfind(xml)` | Regex-based parser; extracts `href`, `isCollection`, and `size` (`getcontentlength`) from multistatus XML; handles both full-URL and path-only hrefs |
| `parseFm(text)` | Parses YAML front-matter + body; recovers `id`, `order`, `link`, `linkedCards`, `attachments`, `lastModified`; also scans body for `(attachment:x)` links |
| `renderMd(page, order)` | Serialises a page to front-matter + body; writes `order` (sibling index), `attachments` (union of field + body links), and `lastModified` |
| `listChildren(cfg, dirRelPath)` | `PROPFIND Depth:1` → `[{ name, isCollection, size }]` for direct children |
| `_readIndex(cfg, dirRelPath)` | Tries to GET `index.md` then `Index.md` from a directory; returns the raw text or `null` |
| `loadDir(cfg, dirRelPath)` | Recursively builds the pages tree; skips `_`-prefixed entries; uses `_readIndex` for directories; sorts pages by `order` (Obsidian-created files without `order` sort last) |
| `loadNotesFromWebdav(cfg)` | Entry point for load — returns `{ pages, deletedPageIds: [] }` |
| `_collectAllIds(pages, out)` | Recursively collects all page ids currently in the tree into a Set — used to detect renames and moves |
| `syncDir(cfg, pages, dirRelPath, deletedIds, allPageIds)` | Recursive sync: writes `order` index into each file via `renderMd(page, i)`; `MKCOL` + `PUT` for new/updated pages; for each orphan reads its front-matter id and deletes if id ∈ `allPageIds` (renamed/moved — new path already written) or id ∈ `deletedIds` (user-deleted); Obsidian-created files (id unknown) are never touched |
| `saveNotesToWebdav(cfg, notes)` | Entry point for save; builds `deletedIds` from `notes.deletedPageIds` and `allPageIds` from the full page tree, passes both to `syncDir` |
| `listAttachmentsFromWebdav(cfg, pageId)` | `PROPFIND` on `_attachments/<pageId>/` → `[{ name, size }]` |
| `getAttachmentFromWebdav(cfg, pageId, filename)` | `GET` → raw `Buffer` |
| `uploadAttachmentToWebdav(cfg, pageId, filename, buffer)` | `MKCOL` parent dirs if needed, then `PUT` |
| `deleteAttachmentFromWebdav(cfg, pageId, filename)` | `DELETE` |
| `mergeForMigration(couchPages, webdavPages)` | Merge helper — see Migration section |
| `testWebdavConnection(cfg)` | `PROPFIND Depth:0` → `{ ok, error? }` |

### `app/backend/schemas.js`

`webdav: { enabled, url, username, password }` added to `_settingsSchema`.
`attachments: string[]` added to the page and patch schemas.
`deletedPageIds: string[]` added to the notes schema.

### `app/backend/routes/notes.js`

`GET`, `PUT`, and `PATCH /:board/notes` each call `getWebdavCfg(db)`:

- **WebDAV active — GET:** loads from WebDAV; ensures `deletedPageIds: []`
  is present on the returned object; updates CouchDB cache in the background
  (fire-and-forget); on WebDAV failure falls back to CouchDB cache. No ETag
  is set in the response (WebDAV has no native ETag concept here).
- **WebDAV active — PUT:** saves full notes body to WebDAV via `syncDir`
  (which processes `deletedPageIds` and deletes the appropriate files); stores
  the notes in CouchDB **with `deletedPageIds` cleared** — the sync already
  handled them. Returns a CouchDB-based ETag for the frontend.
- **WebDAV active — PATCH:** loads from CouchDB cache (fast, avoids a WebDAV
  round-trip); applies `updatedPages`; saves via `syncDir`. Because `PATCH`
  is only triggered for content-only edits (no structural changes), the
  CouchDB cache always has `deletedPageIds: []` at this point — no orphan
  deletions are attempted.
- **WebDAV inactive:** existing CouchDB path unchanged (ETag, `If-Match`,
  rate-limit — all unchanged).

The `GET /:board/notes/export` ZIP route always reads from the CouchDB cache
so it works regardless of WebDAV state.

### `app/backend/routes/board.js`

- **`POST /api/:board/webdav-test`** — tests connection without saving.
- **`PATCH /:board/board` migration trigger** — when `settings.webdav.enabled`
  changes, migration runs synchronously before settings are persisted.

### `app/backend/routes/attachments.js`

All four notes attachment routes check `getWebdavCfg(board)` and dispatch to
WebDAV helpers when active. Each operation also mirrors to/from the local
cache:

| Route | WebDAV | Local cache |
|---|---|---|
| `GET /:pageId` | `PROPFIND` (list) | Fallback if WebDAV unreachable |
| `POST /:pageId` | `PUT` (upload) | Written simultaneously |
| `GET /:pageId/:filename` | `GET` → updates cache | Served if WebDAV unreachable |
| `DELETE /:pageId/:filename` | `DELETE` | Removed simultaneously |

Card attachment routes (`/cards/attachments/…`) are always local.

### `app/frontend/notes.js` — save & sync state machine

#### State variables

| Variable | Purpose |
|---|---|
| `notesState` | Live working copy of the notes tree; includes `deletedPageIds: string[]` |
| `baseNotesState` | Snapshot from the last successful server sync — used as the merge ancestor |
| `notesEtag` | CouchDB ETag (null in WebDAV mode — no ETags returned) |
| `notesSaveTimer` | Debounce timer handle; non-null means a save is queued |
| `_notesSaveInFlight` | True while the save HTTP request is in flight (timer is null but request not yet complete) |
| `_lastNotesSync` | `Date.now()` of the last completed `loadNotes()` — used to suppress redundant sidebar reloads |

#### Save flow

1. Any mutation calls `scheduleSaveNotes()` → 600 ms debounce.
2. When the timer fires: `notesSaveTimer = null`, `_notesSaveInFlight = true`.
   In WebDAV mode the ↻ button starts spinning (`_setWebdavSyncing(true)`).
3. Computes `buildNotesPatch(baseNotesState, notesState)`:
   - Content-only changes → **PATCH** `{ updatedPages: [...] }`
   - Structure changes (add/remove/reorder/delete) → **PUT** full body
     (includes `deletedPageIds` so the backend can clean up WebDAV)
   - No diff → return early (no request)
4. On success: `baseNotesState = notesState`; ETag updated (CouchDB mode);
   `_setWebdavSaveError(null)` clears any previous error indicator.
5. On failure (WebDAV mode): `_setWebdavSaveError(msg)` colours the ↻ button
   red and sets its tooltip to the error message.
6. On 409 (CouchDB mode only): calls `loadNotes()` then 3-way merges and retries.
7. `_notesSaveInFlight = false` and `_setWebdavSyncing(false)` in `finally`.

#### `loadNotes()` — safe reload with local-change preservation

Called on initial load, manual ↻ click, and sidebar open in WebDAV mode
(throttled — skipped if the last sync was within 10 seconds).

- Normalises `deletedPageIds: []` on the incoming remote object.
- If local unsaved changes exist (`notesState !== baseNotesState`), runs
  `mergeNotesStates` and re-queues `scheduleSaveNotes()` rather than
  discarding the local edits.
- Sets `_lastNotesSync = Date.now()` after completing.
- If the note modal is open (`noteModalPageId` is set), calls
  `loadAttachments(noteModalPageId)` to refresh the attachment list.

#### `deleteNotePage(id)` — deletion tracking

Removes the page from `notesState.pages` and appends the page's id plus all
its children's ids (via `_collectPageIds`) to `notesState.deletedPageIds`.
This list is sent to the backend on the next PUT, where it drives the
WebDAV orphan-deletion logic.

#### `mergeNotesStates(base, remote, local)` — 3-way merge

Unions `deletedPageIds` from both `remote` and `local` so that pending
deletions survive a 3-way merge and are still sent to the backend on the
next save.

#### `checkForNotesUpdates()` — 5-second background poll

- **CouchDB mode:** sends `If-None-Match` ETag; 304 = no work; on change
  runs 3-way merge and re-queues save.
- **WebDAV mode:** skips the poll entirely when `notesSaveTimer` is set,
  `_notesSaveInFlight` is true, or `notesState !== baseNotesState`. This
  prevents the poll from racing with an ongoing save or overwriting edits
  not yet on the server. When idle and settled, the poll fetches from
  WebDAV (no ETag) and merges any Obsidian-side changes.

#### `_updateWebdavSidebarUi()`

Changes the sidebar label to **WebDAV Notes** and shows the ↻ sync button
when WebDAV is active. Called after every `loadNotes()`.

#### `_setWebdavSyncing(bool)` / `_setWebdavSaveError(msg)`

`_setWebdavSyncing` adds/removes a CSS spin animation on the ↻ button.
Called at the start and end of both `loadNotes()` and the save fetch in
`scheduleSaveNotes()`.

`_setWebdavSaveError` colours the ↻ button red and sets a tooltip when a
save fails; passing `null` restores the default style.

### `app/frontend/index.html` + `app/frontend/settings.js`

- `#webdavSection` (hidden on overview, shown on board pages).
- Enable toggle shows/hides the credentials fields.
- Password field shows `••••••••` when stored; re-used on save unless changed.
- "Save WebDAV settings" does a direct `PATCH`, waits for migration to
  complete, then calls `loadNotes()`.
- Notes sidebar header: label (`#notesSidebarLabel`) and sync button
  (`#notesSyncBtn`) are updated dynamically by `_updateWebdavSidebarUi()`.
- Attachment upload row shows a spinning hint ("Uploading to WebDAV…" /
  "Uploading…") and disables the Upload button while in flight.

---

## Migration when switching backends

### General rules

- **Nothing is ever deleted** during a migration. Both sides are treated as
  additive sources.
- Pages are merged at the top level. Nested children are carried along with
  their parent and are not individually deduplicated.
- A top-level title collision (case-insensitive match) is resolved by
  appending ` (from webdav)` to the title of the WebDAV page.

### CouchDB → WebDAV (enabling WebDAV)

1. Read the current CouchDB notes document (may be empty).
2. Fetch the current state from the WebDAV server (may be empty or pre-existing
   Obsidian vault).
3. Merge top-level pages (see collision rule above).
4. Write merged result to WebDAV.
5. Update CouchDB cache.
6. Save `webdav.enabled = true`.

### WebDAV → CouchDB (disabling WebDAV)

1. Fetch the current state from WebDAV.
2. Read CouchDB notes document.
3. Apply the same merge logic.
4. Write merged result to CouchDB.
5. Save `webdav.enabled = false`.

Both migrations are triggered automatically when `webdav.enabled` changes.

---

## Obsidian setup

1. Install the **Remotely Save** community plugin.
2. In plugin settings choose **WebDAV** as the remote type.
3. Enter the same URL, username, and password configured in board settings.
4. Run *Sync* — Obsidian downloads all `.md` files.
5. Edits in Obsidian are pushed back on the next sync; the kanban app reads
   them on the next sidebar open (throttled to once per 10 s) or manual ↻ click.

> One Obsidian vault per board is the natural mapping. The vault root
> corresponds to the board's WebDAV collection root. Attachments appear in the
> `_attachments/` subfolder — Obsidian will see this folder but not treat its
> contents as note files.

For the best experience with folder pages (`<title>/index.md`), install the
**Folder Notes** or **Folder Note** community plugin in Obsidian. Without it,
`index.md` appears as a regular note inside the folder rather than as the
folder's own page, which is functionally equivalent but slightly less polished.

---

## Limitations and open questions

| Topic | Note |
|---|---|
| **Concurrent writes** | If Obsidian and the kanban UI write simultaneously, last write wins (no `_rev` locking on WebDAV). Acceptable for a single-user app. |
| **Offline / unreachable server** | Load failure falls back to CouchDB cache silently. Attachment fetch falls back to local disk cache. Save failure colours the ↻ button red with a tooltip. |
| **Polling cost** | Each WebDAV poll is a full PROPFIND + GET pass (no ETags). The poll is suppressed while any save is pending or in-flight, and while local edits are not yet committed. Future optimisation: use `getlastmodified` from PROPFIND to skip re-fetching unchanged files. |
| **Page ID stability** | IDs (`n-abc123`) are in front-matter. If Obsidian renames a file and drops the front-matter, a new ID is generated and card links break. Mitigation: treat `title` (filename) as stable key when no `id` is present. |
| **Attachment migration** | When switching backends, only note pages are merged. Attachments are not migrated automatically. A future `/_migrate-attachments` endpoint would be needed. |
| **Credential exposure** | The WebDAV password appears in the board's CouchDB document and JSON backups. Noted in the settings UI. |
| **Orphan-check cost** | Deleting a page causes `syncDir` to `GET` each orphan file's front-matter to confirm its id before deleting. Cost is proportional to the number of Obsidian-native files that share the same directory — typically zero or a few. |
