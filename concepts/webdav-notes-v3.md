# Concept: WebDAV Notes v3 — As Actually Built

This document records what was actually implemented, superseding the planned v2
design in `webdav-notes-v2.md`. It is a faithful description of the production
code, not a new proposal.

---

## Summary table: planned v2 vs. realized

| Area | v2 plan | As built |
|---|---|---|
| Route files | Three new files: `notes-folders.js`, `notes-pages.js`, `notes-sync.js` | All routes consolidated in the existing `routes/notes.js` |
| Sync on open | Full `PROPFIND Depth:infinity` | Shallow `PROPFIND Depth:1` (root only); folder children loaded lazily |
| Manual sync | Full depth-infinity scan | Lazy: root + open folder IDs sent in body; full scan still available |
| Item path tracking | Computed from tree on every call | `wdPath` field stored on items in CouchDB after first write; used as authoritative path |
| Conflict check | `GET /pages/:id/meta` (PROPFIND Depth:0) before PUT | Re-fetches content (`GET /pages/:id/content`) and compares `lastModified` from frontmatter against `_pageLoadedAt` Map |
| State vars removed | `baseNotesState`, `notesEtag`, `notesSaveTimer`, `deletedPageIds` | Only `deletedPageIds` removed; the others are retained for CouchDB-only mode |
| Per-item spinners | `_opInProgress` Map | Single ref-counted `_webdavPending` counter; sync button spins |
| Tree open state key | `notes-tree-state-<boardName>` in sessionStorage | `notes-tree-open-<API_BASE>` in sessionStorage |
| Migration notice | 30-second banner in notes header | Silent server-side migration; no banner |
| Non-MD files | Shown as read-only entries | Silently skipped during sync; not visible in tree |
| Folder descriptions | Optional future field | Not implemented |
| `buildPath` signature | `buildPath(cfg, item, tree)` | `buildPath(item, tree)` — no cfg needed |
| `source` in frontmatter | Not mentioned | Added — kanban URL written into every MD file so Obsidian can back-link |

---

## Data model (as built)

Identical to v2 plan, plus one field: `wdPath` stored on both folders and pages.

```jsonc
{
  "items": [
    {
      "type": "folder",
      "id": "f-abc123",
      "title": "My Section",
      "wdPath": "My Section/",          // stored after first WebDAV op
      "children": [
        {
          "type": "page",
          "id": "n-ghi789",
          "title": "Deep Page",
          "wdPath": "My Section/Deep Page.md",
          "description": "…",           // stored in CouchDB (also fetched fresh from WD on open)
          "link": "",
          "linkedCards": [],
          "hasAttachments": false,
          "lastModified": "2026-05-16T10:00:00.000Z"
        }
      ]
    }
  ],
  "schemaVersion": 2
}
```

### `wdPath` semantics

- Set when an item is first created via the API, or when sync first matches
  the item to a WebDAV entry.
- Used as the authoritative path for all subsequent MOVE / PUT / DELETE calls,
  overriding slug recomputation.
- After a rename or move, `wdPath` is updated to the new path.
- `_updateChildWdPaths(children, oldPrefix, newPrefix)` cascades the change to
  all descendants when a folder is renamed or moved.
- Items without `wdPath` fall back to slug computation (`_titleToSlug`); a
  legacy slug function (`_legacySlug`) is also tried so files created before
  the current algorithm are still matched.

---

## Backend: `webdav-notes.js`

### Functions present (all in one module)

| Function | Notes vs. v2 plan |
|---|---|
| `wdGet`, `wdPut`, `wdDelete`, `wdMove`, `wdMkcol`, `wdPropfind`, `wdGetMeta` | As planned |
| `wdPutBinary(cfg, path, buffer, mimeType)` | Added — for binary attachment uploads over WebDAV (not in v2 plan) |
| `buildPath(item, tree)` | Signature simplified (no `cfg`); consults `item.wdPath` first |
| `getAttachmentPrefix(page, tree)` | New — returns the folder prefix for a page's `_attachments` directory |
| `parseFm(text)` | Unchanged |
| `renderMd(page, attachFiles, source, linkedCardEntries)` | Adds `source` (kanban URL) and resolved card labels to frontmatter |
| `syncFromWebdav(cfg, tree)` | Full `PROPFIND Depth:infinity`; marks absent items `orphaned` |
| `syncRootFromWebdav(cfg, tree)` | **New** — `PROPFIND Depth:1`; used by `GET /notes` and as first step of lazy sync |
| `syncFolderChildrenFromWebdav(cfg, tree, folderId)` | **New** — `PROPFIND Depth:1` on one folder; triggered on expand |
| `deletePageWithAttachments(cfg, page, tree, boardAttachDir)` | Deletes WD file + local attachment files |
| `deleteFolderWithAttachments(cfg, folder, tree, boardAttachDir)` | Recursive WD DELETE + local file cleanup |
| `_updateChildWdPaths(children, oldPrefix, newPrefix)` | Exported — called by rename and move routes |
| `_buildPathMap`, `_titleToSlug`, `_collectPageIds` | Exported for tests |

### Slug algorithm

Current: `_titleToSlug` preserves case and most characters; only
`/ \ : * ? " < > |` and null bytes are replaced with `_`.

Legacy: `_legacySlug` lowercases and converts spaces to hyphens. Both are
tried during sync path matching to handle files created before the algorithm
changed.

---

## Backend: `routes/notes.js`

All v2 per-operation routes are in this single file alongside the pre-existing
GET/PUT/PATCH/export routes.

### Routes added in v2 implementation

| Method | Path | WebDAV action | Notes |
|---|---|---|---|
| `GET` | `/:board/webdav-config` | — | Returns config without password |
| `POST` | `/:board/webdav-config/test` | PROPFIND Depth:0 | Connectivity test |
| `PUT` | `/:board/webdav-config` | — | Saves config to CouchDB `webdav-config` doc |
| `GET` | `/:board/notes/pages/:id/content` | GET | Returns `{ content, lastModified }` |
| `GET` | `/:board/notes/pages/:id/meta` | PROPFIND Depth:0 | Returns `{ lastModified, size }` |
| `POST` | `/:board/notes/pages` | PUT (new file) + MKCOL if needed | Body: `{ page, parentId }` |
| `PATCH` | `/:board/notes/pages/:id` | MOVE (rename) + PUT (content) | Combined in one call |
| `DELETE` | `/:board/notes/pages/:id` | DELETE file + attachment cleanup | Aborts if WebDAV fails |
| `POST` | `/:board/notes/pages/:id/move` | MKCOL + MOVE | Body: `{ folderId, targetId, position }` |
| `POST` | `/:board/notes/folders` | MKCOL | Body: `{ folder, parentId }` |
| `PATCH` | `/:board/notes/folders/:id` | MOVE | Cascades `wdPath` on children |
| `DELETE` | `/:board/notes/folders/:id` | DELETE (recursive) + local cleanup | Aborts if WebDAV fails |
| `POST` | `/:board/notes/folders/:id/move` | MOVE | Cascades `wdPath` on children |
| `POST` | `/:board/notes/folders/:id/sync` | PROPFIND Depth:1 | Sync one folder's children |
| `POST` | `/:board/notes/sync` | PROPFIND (shallow or full) | Body `{ folderIds }` for lazy; omit for full |

### WebDAV config storage

Stored in CouchDB as `_id: "webdav-config"` per board (`enabled`, `url`,
`user`, `password`). Password is never sent to the client; `GET
/:board/webdav-config` returns `hasPassword: boolean` instead.

### v1 → v2 migration (server-side)

`normalizeNotes(data)` runs on every `GET /notes` read:
- `schemaVersion === 2` → pass through.
- `data.pages` present → run `migrateV1ToV2`.
- Otherwise → return empty `{ items: [], schemaVersion: 2 }`.

`migrateV1ToV2` / `_migratePageToItems`:
- Page without children → `{ type: "page", ... }`.
- Page with children → `{ type: "folder", ... }` whose `children` contain:
  - The page itself as a leaf (only if it had a non-empty `description`).
  - All children, recursively migrated the same way.

This differs slightly from the v2 plan (which promoted children to root level);
here they stay nested inside the new folder.

---

## Sync architecture (three-tier lazy sync)

This is the most significant deviation from the v2 plan.

```
GET /notes
  └─ syncRootFromWebdav    PROPFIND Depth:1  (only root items)

Folder expand in UI
  └─ POST /notes/folders/:id/sync
       └─ syncFolderChildrenFromWebdav   PROPFIND Depth:1  (one folder)

Manual sync button
  └─ POST /notes/sync   body: { folderIds: [...notesExpanded] }
       └─ syncRootFromWebdav
       └─ syncFolderChildrenFromWebdav  (for each open folder)
       — or —
  └─ POST /notes/sync   (no body)
       └─ syncFromWebdav   PROPFIND Depth:infinity  (full scan)
```

**Rationale:** A full depth-infinity PROPFIND on a large vault is slow and
downloads content for every changed file. The lazy approach loads only what is
visible in the open tree, making notes-open fast regardless of vault size.

---

## Frontend state (as built)

### State variables retained from v1/v2 transition

| Variable | Why retained |
|---|---|
| `baseNotesState` | Used by `buildNotesPatch` for CouchDB-only mode (PATCH diffing) |
| `notesEtag` | Used in CouchDB-only mode `PUT`/`PATCH` for optimistic concurrency |
| `notesSaveTimer` | Used by `scheduleSaveNotes` for CouchDB-only mode |

### New state variables

| Variable | Purpose |
|---|---|
| `_pageLoadedAt` | `Map<pageId, lastModified>` — records frontmatter `lastModified` at page-open time; used for conflict detection on save |
| `notesExpanded` | `Set<folderId>` — expanded folders; saved to `sessionStorage` on change |
| `_syncInProgress` | Boolean; prevents concurrent syncs |
| `_webdavPending` | Ref counter; sync-button spin while any WebDAV op is in flight |
| `_pendingNewPage` | `{ page, parentId }` — CouchDB mode only: new page held until first save |

### `_notesOp(method, url, body)`

Central helper for all per-operation WebDAV calls. Increments `_webdavPending`
before the fetch, decrements in `finally`. Every successful call returns
`data.notes` which is applied via `_applyNotesResult`, replacing `notesState`
and `baseNotesState` atomically.

---

## Conflict detection (as built)

Not via `GET /pages/:id/meta` as planned, but via a second content fetch:

1. On `openNoteModal`: fetch `GET /pages/:id/content` → store
   `data.lastModified` in `_pageLoadedAt.set(pageId, lastModified)`.
2. On `submitNote` (save): fetch `GET /pages/:id/content` again → compare
   `data.lastModified` against `_pageLoadedAt.get(pageId)`.
3. If server time > loaded-at time → show confirm dialog
   ("Overwrite" / "Cancel").
4. On overwrite → proceed with PATCH; on cancel → return without saving.

The `/meta` endpoint exists and works but is not used in the current save flow.

---

## Tree drag-and-drop (not in v2 plan)

Full drag-and-drop reordering is implemented for both mouse and touch:

- **Mouse:** HTML5 drag events on `#notesTreeBody`. Drop zones: `before`,
  `after`, `into` (folder only), determined by pointer Y within the target
  item's bounding box.
- **Touch:** Custom touch handler cloning a ghost element. Auto-scrolls the
  sidebar when dragging near the edges.
- **WebDAV mode:** Optimistic tree mutation, then `POST /pages/:id/move` or
  `POST /folders/:id/move`. On error: `loadNotes()` reloads to undo.
- **CouchDB mode:** `scheduleSaveNotes()`.
- Move is blocked while `_treeMoveInProgress` is true (set during the WebDAV
  call).

---

## Note modal: content loading and save (as built)

### Open

1. Pre-fill fields from CouchDB cache immediately.
2. Show loading overlay.
3. `GET /pages/:id/content` → replace `notePageDesc` textarea value.
4. Store `data.lastModified` in `_pageLoadedAt`.
5. Hide loading overlay; switch to preview if content is non-empty.

Falls back to cached content silently if the fetch fails.

### Save (`submitNote`)

1. Read title / description / link from form fields.
2. **WebDAV mode only:** conflict check (see above).
3. `PATCH /pages/:id` with `{ title, description, link, linkedCards }`.
4. `_applyNotesResult` updates `notesState`.
5. Show "saved" flash message.

**CouchDB mode:** skips steps 2–4; mutates `notesState` directly and calls
`scheduleSaveNotes()`.

---

## Attachment handling (as built)

Attachments are stored on the **local filesystem** (not on WebDAV), keyed as
`<ATTACHMENTS_DIR>/<board>/<folderPrefix>/_attachments/<pageId>_<filename>`.

`getAttachmentPrefix(page, tree)` derives the folder prefix from the page's
WebDAV path so attachments follow the page when it is moved between folders.

`renderMd` includes an `attachments:` frontmatter list so Obsidian can see
which files belong to the page.

`deletePageWithAttachments` also deletes the local files. `deleteFolderWithAttachments` collects all page infos before the folder is removed from the tree (so `buildPath` still works), then deletes the WebDAV folder recursively and cleans up local files.

---

## Orphaned items

Items absent from WebDAV during sync get `orphaned: true` set on the item.
The UI renders them with class `notes-tree-item--orphaned`. They remain in
the tree until the user manually deletes them. No auto-deletion.

Orphan scope per sync function:
- `syncRootFromWebdav` — marks root-level items not seen in PROPFIND.
- `syncFolderChildrenFromWebdav` — marks direct children of one folder.
- `syncFromWebdav` — marks all pages anywhere in the tree.

---

## What was not implemented from v2

| v2 feature | Status |
|---|---|
| Separate route files (`notes-folders.js` etc.) | Skipped — all in `routes/notes.js` |
| Migration notice banner (30 s) | Skipped — migration is silent |
| Non-MD files shown as read-only entries | Skipped — silently filtered out |
| Folder description field | Skipped (marked optional in v2) |
| Diff view in conflict dialog | Skipped (future enhancement in v2) |
| WebDAV structure update on migration (move `index.md`) | Skipped |
| Phase G unit/API tests for new endpoints | Pending (Phase 3 test work) |
