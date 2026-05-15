# Concept: WebDAV as alternative notes backend

Enable a per-board option to store notes on an external WebDAV server instead
of CouchDB. When active, the kanban app acts as a WebDAV **client**: all notes
reads and writes go to the configured remote. Obsidian points its
*Remotely Save* plugin at the same WebDAV folder, giving seamless
bidirectional access to the same Markdown files.

CouchDB-based notes remain the default and are unaffected for boards that do
not enable the option.

**Status: implemented** — commits `1c9487b` (notes + migration) and `fff1aad`
(attachments).

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
  └─ page { id, title, description, link, linkedCards, children }
       ├─ no children  →  <title>.md
       └─ has children →  <title>/index.md   (page's own content)
                          <title>/<child>.md  (recursive)
```

Titles are sanitised for use as filenames (characters `/\<>:|*?"` replaced
with `_`). Page IDs, links, and linked-card references are stored in YAML
front-matter:

```markdown
---
id: n-abc123
link: https://example.com
linkedCards:
  - id-xyz
---

The page body (description field) goes here as Markdown.
```

On read, `id`, `link`, and `linkedCards` are recovered from front-matter;
`title` comes from the filename. On write, the front-matter is round-tripped
verbatim so Obsidian-added metadata is preserved.

### Attachments

Notes attachments are stored under `_attachments/<pageId>/` relative to the
WebDAV board root:

```
/                            ← board root (note .md files here)
/_attachments/               ← all page attachments
/_attachments/n-abc123/      ← attachments for page n-abc123
/_attachments/n-abc123/photo.png
```

The `_attachments` directory and any other `_`-prefixed entries are never
touched by the notes sync — `loadDir` skips them during reads and `syncDir`
excludes them from orphan deletion.

Card attachments are not affected by WebDAV mode; they remain stored locally.

---

## Implementation

### `app/backend/webdav-notes.js` (new file)

Self-contained WebDAV client using Node's built-in `http`/`https` — no new
npm dependency. Key internals:

| Function | Description |
|---|---|
| `buildUrl(cfg, relPath)` | Constructs a full URL by percent-encoding each path segment and appending to `cfg.url` |
| `wdRequest(cfg, method, relPath, opts)` | Low-level HTTP request; accepts string or Buffer body; returns `{ status, body, rawBody }` |
| `parsePropfind(xml)` | Regex-based parser; extracts `href`, `isCollection`, and `size` (`getcontentlength`) from multistatus XML; handles both full-URL and path-only hrefs |
| `parseFm(text)` | Parses YAML front-matter + body from a Markdown string |
| `renderMd(page)` | Serialises a page to front-matter + body Markdown |
| `listChildren(cfg, dirRelPath)` | `PROPFIND Depth:1` → `[{ name, isCollection, size }]` for direct children |
| `loadDir(cfg, dirRelPath)` | Recursively builds the pages tree; skips `_`-prefixed entries |
| `loadNotesFromWebdav(cfg)` | Entry point for load — returns `{ pages }` |
| `syncDir(cfg, pages, dirRelPath)` | Recursive sync: `MKCOL` + `PUT` for new/updated pages; `DELETE` for orphans (skips `_`-prefixed entries) |
| `saveNotesToWebdav(cfg, notes)` | Entry point for save |
| `listAttachmentsFromWebdav(cfg, pageId)` | `PROPFIND` on `_attachments/<pageId>/` → `[{ name, size }]` |
| `getAttachmentFromWebdav(cfg, pageId, filename)` | `GET` → raw `Buffer` |
| `uploadAttachmentToWebdav(cfg, pageId, filename, buffer)` | `MKCOL` parent dirs if needed, then `PUT` |
| `deleteAttachmentFromWebdav(cfg, pageId, filename)` | `DELETE` |
| `mergeForMigration(couchPages, webdavPages)` | Merge helper — see Migration section |
| `testWebdavConnection(cfg)` | `PROPFIND Depth:0` → `{ ok, error? }` |

### `app/backend/schemas.js`

`webdav: { enabled, url, username, password }` added to `_settingsSchema` so
existing board `PATCH` validation accepts it.

### `app/backend/routes/notes.js`

`GET`, `PUT`, and `PATCH /:board/notes` each call `getWebdavCfg(db)` to check
whether WebDAV is active:

- **WebDAV active:** load from / save to WebDAV; also write to CouchDB as cache.
  On load failure falls back to CouchDB cache silently.
- **WebDAV inactive:** existing CouchDB path unchanged (ETag, `If-Match`,
  rate-limit — all unchanged).

The `GET /:board/notes/export` ZIP route always reads from the CouchDB cache
so it works regardless of WebDAV state.

### `app/backend/routes/board.js`

- **`POST /api/:board/webdav-test`** — tests connection without saving; returns
  `{ ok, error? }`.
- **`PATCH /:board/board` migration trigger** — when the patch includes
  `settings.webdav.enabled` and its value changes, migration runs synchronously
  before the settings are persisted. Migration failure is non-fatal (logged
  server-side; settings are saved regardless).

### `app/backend/routes/attachments.js`

All four notes attachment routes check `getWebdavCfg(board)` and dispatch to
WebDAV helpers when active:

| Route | WebDAV path | WebDAV method |
|---|---|---|
| `GET /:board/notes/attachments/:pageId` | `_attachments/<pageId>/` | `PROPFIND` |
| `POST /:board/notes/attachments/:pageId` | `_attachments/<pageId>/<filename>` | `PUT` (multer memoryStorage) |
| `GET /:board/notes/attachments/:pageId/:filename` | `_attachments/<pageId>/<filename>` | `GET` → `Buffer` → `res.send` |
| `DELETE /:board/notes/attachments/:pageId/:filename` | `_attachments/<pageId>/<filename>` | `DELETE` |

Card attachment routes (`/cards/attachments/…`) are always local.

### `app/frontend/index.html` + `app/frontend/settings.js`

- `#webdavSection` (hidden on overview, shown on board pages) with the fields
  listed in Board settings above.
- Enable toggle shows/hides the credentials fields.
- Password field shows `••••••••` when a password is stored; the stored value
  is re-used on save unless the field is changed.
- "Save WebDAV settings" does a direct (non-debounced) `PATCH` so migration
  completes before the button re-enables, then calls `loadNotes()`.

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
   read-through cache).
6. `webdav.enabled = true` is saved to board settings.

### WebDAV → CouchDB (disabling WebDAV)

1. Fetch the current state from the WebDAV server.
2. Read the current CouchDB notes document.
3. Apply the same merge logic (WebDAV-side title collisions renamed).
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
> corresponds to the board's WebDAV collection root. Attachments appear in the
> `_attachments/` subfolder; Obsidian will not treat them as note files.

---

## Limitations and open questions

| Topic | Note |
|---|---|
| **Concurrent writes** | If Obsidian and the kanban UI write simultaneously, last write wins (no `_rev` locking on WebDAV). Acceptable for a single-user app. |
| **Offline / unreachable server** | Implemented: load failure silently falls back to the CouchDB cache. The cache is updated on every successful save. |
| **ETag / polling** | Notes are reloaded from WebDAV every time the sidebar opens. No ETags in WebDAV mode (skipped). Obsidian changes appear on the next sidebar open. |
| **Credential exposure** | Storing the WebDAV password in the board document means it appears in JSON backups. Noted in the settings UI. |
| **Large vaults** | A full PROPFIND + GET on every `loadNotes` call is expensive for large vaults. Future optimisation: cache `Last-Modified` and skip re-fetching unchanged files. |
| **Page ID stability** | IDs (`n-abc123`) are stored in front-matter. If Obsidian renames a file and drops the front-matter, a new ID is generated and card links break. Mitigation: treat `title` (filename) as stable key when no `id` front-matter is present. |
| **Attachment migration** | When switching backends, only note pages are merged. Attachments are not migrated — files stored locally stay local; files on WebDAV stay on WebDAV. A manual migration step or a future `/_migrate-attachments` endpoint would be needed. |
| **npm dependency** | Implemented without a new dependency using Node's built-in `http`/`https` and a regex-based PROPFIND parser. |
