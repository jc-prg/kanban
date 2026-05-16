# Concept: WebDAV Notes v2 — Folders, Pages, and Immediate Sync

This document supersedes `webdav-notes.md` and describes the redesigned notes
system. It incorporates the original requirements, analysis of what was
unreliable in v1, and a set of proposed improvements.

**Status: planned — not yet implemented.**

---

## Summary of changes from v1

| Area | v1 | v2 |
|---|---|---|
| Data model | Pages with unlimited nested subpages | Folders (containers) + Pages (leaves); max two levels |
| WebDAV writes | Debounced batch sync via `syncDir` | Immediate per-operation calls |
| WebDAV reads | 5-second background poll | On notes-open + manual sync button only |
| Page content loading | Stored inline in CouchDB | Fetched fresh from WebDAV on open; CouchDB is metadata-only cache |
| Conflict handling | 3-way merge (silent) | Timestamp check before save; user confirms overwrite |
| Deletion | `deletedPageIds` array, deferred | Immediate WebDAV DELETE including attachments |
| Tree open/close state | Not persisted | Remembered in `sessionStorage` (client only) |
| `children` field on pages | Present | Removed |
| `index.md` folders | Used for folder-level content | No longer needed; folders are pure containers |

---

## Requirement review and proposed improvements

### 1. Folders and Pages as separate concepts

**Requirement:** Folders can contain folders and pages. Pages can no longer
contain subpages.

**Assessment:** Sound. The v1 unlimited nesting produced `index.md` files
inside every directory and made the tree logic unnecessarily complex. Two
levels (folder / page) map cleanly to a WebDAV directory tree.

**Proposed improvement:** Give folders an optional description field so they
can serve as lightweight section notes (visible in a tooltip or collapsed
preview). This is optional; the core design works without it.

---

### 2. Immediate WebDAV operations

**Requirement:** Every structural change (create, rename, move, delete) is
written to WebDAV immediately, not deferred to a batch sync.

**Assessment:** Correct direction. The v1 batch sync caused subtle race
conditions and made it hard to reason about the server state. Immediate ops
are simpler and the user gets faster feedback.

**Concerns and mitigations:**

- **WebDAV unavailable:** The UI must handle network errors per operation.
  Proposal: each operation is **optimistic** — the UI updates immediately,
  then a request fires. On failure, the change is rolled back and an inline
  error is shown ("Rename failed — could not reach WebDAV server"). Changes
  are not queued for later (no hidden retry logic).

- **Rename vs. Move:** Both use the HTTP `MOVE` method, which is atomic on
  the server. The backend should issue a single `MOVE` request rather than
  `GET` + `PUT` + `DELETE`.

- **Concurrent edits from Obsidian:** Still last-write-wins (see conflict
  section below). Acceptable for single-user.

---

### 3. Immediate page content saves

**Requirement:** Editing a page saves its content to WebDAV immediately.

**Assessment:** "Immediately" interpreted as debounced (≈ 1–2 s after the
user stops typing) rather than on every keystroke. A fully synchronous save
on each keypress would create too many WebDAV requests.

**Proposed behavior:**
1. User edits page content in the note modal.
2. A 1.5 s debounce timer fires.
3. Backend performs a conflict check (PROPFIND `getlastmodified` on the file).
4. If no conflict → PUT the new content.
5. If conflict detected → interrupt the timer, show the conflict dialog (see
   section 7).

CouchDB is updated after a successful WebDAV write.

---

### 4. Load page content fresh from server

**Requirement:** Before opening an MD file, fetch it from the server and show
a loading indicator.

**Assessment:** Good. This avoids showing stale cached content when Obsidian
has made edits since the last sync.

**Proposed behavior:**
- Opening a note modal triggers a `GET /<page-path>.md` from WebDAV.
- A spinner replaces the content area until the response arrives.
- On success: display the fetched content and record `lastFetched` timestamp.
- On failure: show the CouchDB-cached version with a warning banner ("Could
  not reach WebDAV — showing cached version").
- The `lastFetched` timestamp is stored in `sessionStorage` per page ID and
  used for conflict detection during saves.

---

### 5. Sync behavior

**Requirement:** Sync on notes-open and on manual button click. No 5-second
background poll in WebDAV mode.

**Assessment:** Correct. The 5-second poll was a performance liability and
source of save-race bugs. On-demand sync is sufficient for a single user.

**Proposed sync algorithm (efficient):**

1. `PROPFIND Depth:infinity` on the board root → list of all files with
   `getlastmodified` and `getcontentlength`.
2. Compare file list against the CouchDB metadata cache.
3. For files **newer on WebDAV** than in cache: fetch content and update
   cache.
4. For files **present on WebDAV but absent in cache**: create new page entry.
5. For files **absent on WebDAV but present in cache** (Obsidian deleted
   them): mark page as `orphaned` in the tree (show with strikethrough or
   warning icon). Do not auto-delete from the tree — let the user confirm.
6. Update `lastSynced` timestamp in `sessionStorage`.

This avoids fetching the full content of every file on every sync; only
changed files are downloaded.

> **Improvement over stated requirement:** The requirement says conflict
> resolution uses the CouchDB or file timestamp. Point 5 above adds a safer
> behavior: instead of silently dropping Obsidian-deleted pages, they surface
> as `orphaned` so the user can decide. This prevents accidental data loss.

---

### 6. Deletion with confirmation

**Requirement:** Deleting a page or folder requires a confirmation step. Page
deletion also deletes all its attachments.

**Assessment:** Required for irreversible operations. Confirmation dialog
should list what will be deleted (folder name and count of contained pages,
or page name and count of its attachments).

**Proposed behavior:**

- **Page delete:** confirm dialog → `DELETE /<path>.md` + `DELETE
  /_attachments/<pageId>/` → remove from CouchDB cache → remove from tree.
- **Folder delete:** confirm dialog listing all contained pages → `DELETE
  /<folder>/` (recursive, one request) + delete attachment directories for
  each contained page → update CouchDB cache.

If any WebDAV DELETE fails, report the error and leave the local tree
unchanged (no partial deletes).

---

### 7. Conflict detection before save

**Requirement:** Before saving, check whether a newer version exists on the
server. If so, show a warning and require the user to confirm overwrite or
cancel.

**Assessment:** Essential for shared-access scenarios (Obsidian + kanban).

**Proposed behavior:**

1. When the page is opened, record `serverLastModified` from the PROPFIND
   response (or from the file's `lastModified` front-matter field).
2. Before any PUT, re-fetch `getlastmodified` via PROPFIND Depth:0 (one
   cheap metadata request).
3. If the server time > `serverLastModified`: show conflict dialog.
   - **"Overwrite"** — proceed with PUT.
   - **"Cancel"** — discard the pending save; reload content from server
     into the editor.
4. After a successful save, update `serverLastModified`.

> **Improvement:** Offer a third option "Show diff" — display a side-by-side
> view of the local and server versions. This is a significant extra
> implementation effort; it is marked as a future enhancement and not
> required for the initial v2 implementation.

---

### 8. Tree open/close state in sessionStorage

**Requirement:** Remember which folders are expanded/collapsed; restore on
notes-open and reload. No server-side persistence.

**Assessment:** `sessionStorage` is the right tool — persists for the
browser session, cleared on tab close, no backend changes needed.

**Implementation:** Key `notes-tree-state-<boardName>` → JSON `Set` of
expanded folder IDs. Updated on every expand/collapse toggle; read on
`loadNotes()` to restore state before rendering.

---

### 9. Transition: existing subpages moved to root

**Requirement:** If v1 subpages exist in the data, surface them at the root
level as a transition.

**Assessment:** Reasonable for backward compatibility. On first load after
the upgrade, a migration function flattens the tree:

1. Walk the old `pages` array recursively.
2. Every page with `children` is converted to a folder.
3. Its children, if they have no further children, become root-level pages.
4. If a child still has children of its own (depth ≥ 3), those grandchildren
   are also promoted to root level (repeated until flat).
5. The migration runs once and writes the flattened result back to CouchDB.

A migration notice is shown in the notes header: "Notes structure has been
updated — subpages moved to root."

---

### 10. Non-MD files are read-only

**Requirement:** Files with extensions other than `.md` are displayed in the
file tree but cannot be edited or created through the kanban UI.

**Assessment:** Correct. The kanban UI only creates `.md` pages. Images,
PDFs, and other files that appear in the WebDAV directory are shown as
read-only entries (icon + filename + size). They can be downloaded but not
modified through the UI.

This applies to `_attachments/` contents as well — those are managed through
the separate attachment UI, not the notes tree.

---

## Data model v2

### Notes document (CouchDB, `_id: "notes"`)

The top-level `pages` array is replaced by `items` containing a flat-within-
folders tree. **Pages are always leaves; only folders can have children.**

```jsonc
{
  "items": [
    {
      "type": "folder",
      "id": "f-abc123",
      "title": "My Section",
      "children": [
        {
          "type": "folder",
          "id": "f-def456",
          "title": "Nested Section",
          "children": [
            {
              "type": "page",
              "id": "n-ghi789",
              "title": "Deep Page",
              "link": "",
              "linkedCards": [],
              "attachments": [],
              "lastModified": "2026-05-16T10:00:00.000Z"
            }
          ]
        },
        {
          "type": "page",
          "id": "n-jkl012",
          "title": "Section Page",
          "link": "",
          "linkedCards": [],
          "attachments": [],
          "lastModified": "2026-05-16T09:00:00.000Z"
        }
      ]
    },
    {
      "type": "page",
      "id": "n-mno345",
      "title": "Root Page",
      "link": "",
      "linkedCards": [],
      "attachments": [],
      "lastModified": "2026-05-16T08:00:00.000Z"
    }
  ],
  "schemaVersion": 2
}
```

**Changes from v1:**
- `pages` → `items`
- Each item has a `type` field: `"folder"` or `"page"`
- `description` (page body) is **not stored in CouchDB** in WebDAV mode —
  it is fetched from WebDAV on demand. In CouchDB-only mode, `description`
  is stored inline as before.
- `order` field removed — order is determined by array position, preserved
  on every write.
- `deletedPageIds` array removed — deletions are immediate.
- `schemaVersion: 2` field added for migration detection.

---

## WebDAV file structure v2

```
/<board-root>/
  root-page.md                ← page at root level
  my-section/                 ← folder
    section-page.md           ← page inside folder
    nested-section/           ← nested folder
      deep-page.md
  _attachments/               ← never touched by notes sync
    n-mno345/
      photo.png
```

**Rules:**
- Folders → WebDAV collections (directories).
- Pages → `.md` files with YAML front-matter.
- No `index.md` files — folders are pure containers with no body content.
- Files not ending in `.md` at the note level are treated as read-only
  entries; they are listed but not editable.
- `_attachments/` and any `_`-prefixed entry are excluded from the notes
  tree entirely.

### Front-matter format (simplified)

```markdown
---
id: n-abc123
link: https://example.com
linkedCards:
  - id-xyz
attachments:
  - photo.png
lastModified: 2026-05-16T10:00:00.000Z
---

Page body as Markdown.
```

Fields removed from v1: `order` (not needed — array position used on read).

---

## Backend architecture v2

### Immediate-operation API surface

Each structural change has its own dedicated endpoint. This replaces the
monolithic `PUT /notes` + `syncDir` approach.

#### Folder operations

| Method | Path | Body | WebDAV action |
|---|---|---|---|
| `POST` | `/api/:board/notes/folders` | `{ title, parentId? }` | `MKCOL` |
| `PATCH` | `/api/:board/notes/folders/:id` | `{ title }` | `MOVE` |
| `DELETE` | `/api/:board/notes/folders/:id` | — | `DELETE` (recursive) + attachment cleanup |
| `POST` | `/api/:board/notes/folders/:id/move` | `{ newParentId? }` | `MOVE` |

#### Page operations

| Method | Path | Body | WebDAV action |
|---|---|---|---|
| `POST` | `/api/:board/notes/pages` | `{ title, folderId? }` | `PUT` (empty file) |
| `PATCH` | `/api/:board/notes/pages/:id` | `{ title?, content?, link?, linkedCards?, attachments? }` | `MOVE` (rename) or `PUT` (content) or both |
| `DELETE` | `/api/:board/notes/pages/:id` | — | `DELETE` file + `DELETE _attachments/<id>/` |
| `POST` | `/api/:board/notes/pages/:id/move` | `{ folderId? }` | `MOVE` |

#### Sync

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/:board/notes/sync` | Full PROPFIND scan; returns updated tree + changed pages |
| `GET` | `/api/:board/notes/pages/:id/content` | Fetch page content fresh from WebDAV |
| `GET` | `/api/:board/notes/pages/:id/meta` | PROPFIND Depth:0 → `{ lastModified, size }` for conflict check |

#### Legacy (CouchDB mode only — unchanged)

`GET /api/:board/notes`, `PUT /api/:board/notes`, `PATCH /api/:board/notes`
remain for boards without WebDAV enabled.

---

### `app/backend/webdav-notes.js` v2 functions

| Function | Description |
|---|---|
| `wdMove(cfg, fromPath, toPath)` | Issues `MOVE` with `Destination:` header; handles 409 (parent missing) |
| `wdDelete(cfg, path)` | `DELETE`; tolerates 404 |
| `wdMkcol(cfg, path)` | `MKCOL`; creates parent dirs if needed |
| `wdPut(cfg, path, content)` | `PUT` string or Buffer |
| `wdGet(cfg, path)` | `GET` → string |
| `wdPropfind(cfg, path, depth)` | Returns `[{ href, isCollection, lastModified, size }]` |
| `wdGetMeta(cfg, path)` | PROPFIND Depth:0 → `{ lastModified, size }` |
| `buildPath(cfg, item, tree)` | Computes the relative WebDAV path for a page or folder given the current tree |
| `parseFm(text)` | Unchanged from v1 |
| `renderMd(page)` | Simplified — no `order` field |
| `syncFromWebdav(cfg, cachedTree)` | Efficient sync: PROPFIND Depth:inf → diff against cache → fetch only changed files |
| `flattenV1Tree(v1pages)` | One-time migration: flattens v1 subpages to root |
| `deletePageWithAttachments(cfg, pageId, pagePath)` | DELETE page file + DELETE `_attachments/<pageId>/` |
| `deleteFolderWithAttachments(cfg, folderPath, pageIds)` | DELETE folder (recursive) + DELETE attachment dirs for all contained pages |

---

## Frontend changes

### State model

```js
// Replaces notesState.pages + deletedPageIds
notesState = {
  items: [],          // folders and pages tree
  schemaVersion: 2
}

// Per-page content cache (sessionStorage, keyed by page id)
// { content, serverLastModified, fetchedAt }
```

### Removed state variables

- `baseNotesState` — no longer needed (no 3-way merge)
- `notesEtag` — removed (immediate ops don't use ETags)
- `notesSaveTimer`, `_notesSaveInFlight` — replaced by per-operation request tracking
- `deletedPageIds` — removed (deletions are immediate)

### New state variables

| Variable | Purpose |
|---|---|
| `_pageContentCache` | `Map<pageId, { content, serverLastModified, fetchedAt }>` — in-memory cache for open pages |
| `_treeOpenState` | `Set<folderId>` — expanded folders; persisted to `sessionStorage` |
| `_syncInProgress` | Boolean; disables the sync button and shows spinner while syncing |
| `_opInProgress` | `Map<itemId, string>` — items with a pending WebDAV operation (shows per-item spinner) |

### Key frontend functions (new/changed)

| Function | Description |
|---|---|
| `openNoteModal(pageId)` | Shows spinner; fetches content via `GET /notes/pages/:id/content`; falls back to cache on error |
| `savePageContent(pageId, content)` | Checks conflict via `GET /notes/pages/:id/meta`; on conflict shows dialog; then PATCH |
| `createFolder(title, parentId)` | POST → optimistic UI update → rollback on error |
| `renameFolder(id, newTitle)` | PATCH → optimistic → rollback |
| `moveFolder(id, newParentId)` | POST move → optimistic → rollback |
| `deleteFolder(id)` | Confirm dialog → DELETE → remove from tree |
| `createPage(title, folderId)` | POST → optimistic → rollback |
| `renamePage(id, newTitle)` | PATCH → optimistic → rollback |
| `movePage(id, newFolderId)` | POST move → optimistic → rollback |
| `deletePage(id)` | Confirm dialog (shows attachment count) → DELETE → remove from tree |
| `syncNotes()` | POST sync → merges returned tree changes → updates tree UI |
| `restoreTreeOpenState()` | Reads `sessionStorage`; re-expands folders after render |
| `migrateV1Notes(v1data)` | Runs `flattenV1Tree` client-side; saves result; shows migration banner |

### Removed frontend functions

- `checkForNotesUpdates()` — polling removed entirely in WebDAV mode
- `mergeNotesStates()` — no longer needed
- `buildNotesPatch()` — replaced by per-operation endpoints
- `scheduleSaveNotes()` — replaced by per-operation saves + content debounce

---

## Sync conflict resolution

**Rule:** When `POST /api/:board/notes/sync` detects that a WebDAV file is
newer than the cached version, the WebDAV file wins (remote wins on sync).

**Rationale:** Sync is triggered explicitly by the user. At that point, if
Obsidian has newer content, the user is asking to import those changes.

**Exception:** If the user has the page open in the note modal at the moment
sync runs, the open page is NOT overwritten. A banner appears: "This page
was updated on the server. Reload to see the latest version." The user can
then close and reopen the page, or ignore the notice.

---

## Migration plan

### Step 1: Schema detection and migration

On `GET /api/:board/notes`, the backend inspects the stored document:

- `schemaVersion === 2` → serve as-is.
- No `schemaVersion` (v1 data) → run `flattenV1Tree(doc.pages)` to produce
  `{ items, schemaVersion: 2 }`; save back to CouchDB; serve the result.

The migration is non-destructive: original v1 page data is preserved, only
the structure changes.

### Step 2: WebDAV structure update (if WebDAV is enabled)

If WebDAV is active when the migration fires, the backend:

1. Reads the current WebDAV tree.
2. Moves any `index.md` files (v1 folder-with-content pattern) to `<folder-
   title>-index.md` at the parent level, with a title suffix to avoid
   collisions.
3. Runs a full sync to bring the WebDAV structure in line with the migrated
   tree.

### Step 3: Frontend migration notice

On the first load after migration, the notes header shows: "Notes structure
updated — subpages moved to root level." The notice disappears after 30 s or
on manual dismiss.

---

## Implementation plan

The following work items are listed in dependency order.

### Phase A — Backend: schema + migration

1. Update `schemas.js`: add `type: "folder"|"page"` to item schema; make
   `children` valid only on folders; remove `deletedPageIds`; add
   `schemaVersion`.
2. Add `flattenV1Tree(pages)` to `webdav-notes.js`.
3. Update `routes/notes.js` `GET` handler: detect v1 schema and migrate on
   read.

### Phase B — Backend: immediate-operation endpoints

4. Add `wdMove`, `wdDelete` (with 404 tolerance), `buildPath` to
   `webdav-notes.js`.
5. Create `routes/notes-folders.js`: `POST`, `PATCH`, `DELETE`, `POST move`
   for folders.
6. Create `routes/notes-pages.js`: `POST`, `PATCH`, `DELETE`, `POST move`
   for pages; `GET content`; `GET meta`.
7. Create `routes/notes-sync.js`: `POST sync` using `syncFromWebdav`.
8. Mount new routers in `server.js`; deprecate (but keep) the old `PUT
   /notes` for CouchDB-only mode.
9. Update `deletePageWithAttachments` to delete `_attachments/<id>/` in the
   same operation.

### Phase C — Frontend: state and rendering

10. Update `notes.js` state variables (remove old, add new as above).
11. Rewrite `renderNotesTree()` to handle `type: "folder"` and `type: "page"`
    items; render folder expand/collapse with `_treeOpenState`.
12. Implement `restoreTreeOpenState()` + `sessionStorage` persistence.
13. Implement `syncNotes()` calling `POST /notes/sync`; update tree on result.
14. Remove `checkForNotesUpdates()` poll and `mergeNotesStates()`.

### Phase D — Frontend: CRUD operations

15. Implement `createFolder`, `renameFolder`, `moveFolder`, `deleteFolder`
    (with confirm dialog).
16. Implement `createPage`, `renamePage`, `movePage`, `deletePage` (with
    confirm dialog showing attachment count).
17. Implement per-item spinner using `_opInProgress` map.
18. Add optimistic update + rollback pattern for all ops.

### Phase E — Frontend: note modal

19. Update `openNoteModal` to fetch content fresh from WebDAV (with loading
    spinner).
20. Implement debounced save (1.5 s) calling `PATCH /notes/pages/:id`.
21. Implement conflict check via `GET /notes/pages/:id/meta` before save.
22. Implement conflict dialog ("Overwrite" / "Cancel").

### Phase F — Frontend: migration UX

23. Detect v1 → v2 migration in `loadNotes()` response.
24. Show migration notice banner for 30 s.
25. Update notes header: keep ↻ sync button; label stays "WebDAV Notes" when
    WebDAV active.

### Phase G — Tests

26. Unit tests for `flattenV1Tree` and `buildPath`.
27. API tests for all new endpoints (create, rename, move, delete folder/page).
28. API test for `POST /notes/sync` with mock PROPFIND responses.
29. Frontend unit tests for `restoreTreeOpenState` and conflict dialog flow.

---

## Open questions

| Topic | Question |
|---|---|
| **Offline queue** | Should failed immediate ops be queued for retry, or should they always fail fast and require manual retry? Recommendation: fail fast — no hidden queue. |
| **Diff view** | Conflict dialog shows only "Overwrite / Cancel" for v2. A diff view is a future enhancement. |
| **Folder descriptions** | Should folders optionally carry a description (shown as tooltip or section header)? Not required for v2; easy to add later as an optional `description` field on folder items. |
| **Attachment migration** | When switching from WebDAV → CouchDB, attachments still need a separate migration step (not in scope for v2). |
| **Orphan files** | Files deleted in Obsidian and detected by sync are marked `orphaned` in the tree. Should they be auto-deleted after the next explicit sync? Recommendation: no — always require user action. |
| **Non-MD file management** | Non-MD files are shown read-only. Should they be downloadable through the UI? Recommendation: yes — a download icon next to the filename is sufficient. |
