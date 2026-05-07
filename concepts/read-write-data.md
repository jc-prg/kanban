# Read / Write Data — Concept

## Current state

### Board

| Mechanism | Detail |
|---|---|
| Load | `GET /api/:board/board` → full document; stored in `state` and snapshot `baseState` |
| Save | `buildPatch(baseState, state)` → `PATCH /api/:board/board` (only changed columns); falls back to `PUT` before first successful load |
| Remote polling | `checkForUpdates()` every 5 s with `If-None-Match`; server returns `304` when unchanged |
| Merge | `mergeStates(base, remote, local)` exists (3-way, field-level for cards); triggered **manually** by clicking the title bar indicator |

**Gaps:**
- Merge is opt-in: the user must notice the indicator and click. Concurrent saves from two devices can overwrite each other's work in the window between polling cycles.
- No HTTP-level conflict guard: the client does not send `If-Match` on save, so a concurrent write is silently overwritten.
- `mergeStates` does not use `lastModified` as a tiebreaker: when both devices edited the same card field, the local change always wins regardless of which was newer.

### Notes

| Mechanism | Detail |
|---|---|
| Load | `GET /api/:board/notes` → full document; stored in `notesState` and snapshot `baseNotesState` |
| Save | `buildNotesPatch(baseNotesState, notesState)` → `PATCH /api/:board/notes` (only changed pages); falls back to `PUT` on structural changes or first load |
| Remote polling | `checkForNotesUpdates()` every 5 s with `If-None-Match`; server returns `304` when unchanged |
| Merge | `mergeNotesStates(base, remote, local)` — 3-way, `lastModified`-aware; applied **automatically** on every poll |

No remaining gaps for notes.

### Cards (individual endpoints)

| Mechanism | Detail |
|---|---|
| History | `GET /api/:board/card/:id` → `{ created, moves, column }` — read-only, no conflict risk |
| Move-to | `POST /api/:board/move-to/:name` — server-side atomic move; writes directly to CouchDB, bypasses the board PATCH flow |
| Attachments | `POST/GET/DELETE /api/:board/cards/attachments/:cardId/:filename` — stored as CouchDB attachments, separate from the board document |

**Gaps:**
- Card attachments are outside the board document and therefore outside the polling/merge cycle. Changes from another device are invisible until page reload.
- `POST /api/:board/move-to/:name` writes directly to CouchDB without a `_rev` guard; a concurrent board PATCH could overwrite the move. The next poll will re-sync, but there is a short window of risk.
- No `If-Match` on card attachment uploads/deletes (low risk in practice — attachments are rarely edited concurrently).

---

## Goals

1. **Consistency** — changes from any device reach all others promptly without data loss.
2. **Minimal bandwidth** — send only what changed; avoid downloading the full document when it hasn't changed.
3. **No UX friction** — auto-merge non-conflicting changes; surface conflicts only when the same field was changed on two devices simultaneously.

---

## Strategy

### Conflict model

Both board and notes are single-user, so true simultaneous edits to the same field are rare but possible (e.g., editing the same card description on a phone and a laptop). The chosen model:

- **3-way merge** for all structured data (columns/cards, note pages): remote wins for structure (add/remove/reorder), local wins for field edits made since the last load (`lastModified` timestamp breaks ties).
- **Last-write-wins per field** when both sides changed the same field — the device with the more recent `lastModified` wins.
- A visible indicator informs the user when a merge was applied.

### Bandwidth

1. **PATCH for notes** — send only added/changed/removed pages, not the full tree.
2. **Conditional GET** — server returns an `ETag` (derived from the CouchDB `_rev`); client sends `If-None-Match` on polls; server returns `304 Not Modified` when unchanged.
3. **Optimistic save guard** — client sends `If-Match: <etag>` on `PATCH`/`PUT`; server returns `409 Conflict` when a concurrent write happened; client re-loads, merges, and retries automatically.

### Polling

Both board and notes poll every 5 s with `If-None-Match`. With `304` responses the cost is negligible (a single round-trip returning ~200 bytes vs. the full document).

Auto-merge replaces the manual "click to merge" flow for the board (already in place for notes):

```
poll result arrived
  └─ 304 → nothing to do
  └─ 200 → remote changed
        ├─ no local pending changes → apply remote, update baseState, re-render
        └─ local pending changes    → mergeStates(baseState, remote, local)
                                       → update state + baseState, re-render, schedule save
```

---

## Data model additions

### Cards — add `lastModified` (already present in code, enforce it)

`lastModified` is already written on `addCard`, `updateCardFull`, `moveCardToColumn`, `updateCardText`. Ensure it is set on **every** mutation and never stripped.

### Note pages — add `lastModified`

```jsonc
{
  "id": "n-abc123",
  "title": "…",
  "description": "…",
  "lastModified": "2026-05-03T14:22:00Z"   // new — set on every submitNote()
}
```

### Notes PATCH body (new server endpoint)

```jsonc
{
  "updatedPages":   [{ "id": "n-abc", …full page… }],
  "removedPageIds": ["n-xyz"]
}
```

The server applies the patch to the stored tree (DFS traversal to locate pages by ID, identical logic to the board PATCH handler).

---

## Implementation plan

### IMPLEMENTED: Phase 1 — Notes PATCH + `baseNotesState` (highest impact, self-contained)

**Server (`server.js`)**

1. Add `PATCH /api/:board/notes` handler:
   - Validate body schema: `{ updatedPages?: Page[], removedPageIds?: string[] }`.
   - Load current notes document.
   - Apply `removedPageIds` (DFS remove).
   - Apply `updatedPages` (DFS upsert by `id`; append at root level if not found).
   - Save and respond `{ success: true }`.

**Client (`notes.js` / `state.js`)**

2. Track `baseNotesState = null` (snapshot after last server load/save).
3. Implement `buildNotesPatch(base, current)`:
   - DFS both trees, collect pages that were added or changed (compare by `id` + full JSON).
   - Collect IDs present in base but absent in current → `removedPageIds`.
4. In `scheduleSaveNotes()`: send `PATCH` when `baseNotesState` exists; fall back to `PUT` otherwise.
5. On successful save: `baseNotesState = JSON.parse(JSON.stringify(notesState))`.

*Board PATCH + `baseState` were already in place before Phase 1 (predates this plan).*

### IMPLEMENTED: Phase 2 — `lastModified` on note pages + notes polling + auto-merge

**Client (`notes.js`)**

1. In `submitNote()` and `addNotePage()`: set `page.lastModified = new Date().toISOString()`.
2. New `checkForNotesUpdates()`: poll `GET /api/:board/notes` every 5 s, guarded by `notesSaveTimer` (skip while a save is in-flight).
3. `mergeNotesStates(base, remote, local)`:
   - Remote wins for structure (page add/remove/reorder in tree).
   - Local wins for field edits; when both sides changed the same field, the page with the newer `lastModified` wins.
4. Auto-merge applied on every poll — no user interaction required.

*Board polling (`checkForUpdates`, every 5 s) was already in place; board auto-merge is still manual (Phase 5).*

### IMPLEMENTED: Phase 3 — Conditional GET (ETag / 304)

**Server**

1. In `GET /api/:board/board`: set `ETag: "<_rev>"` header; honour `If-None-Match` → `304`.
2. Same for `GET /api/:board/notes`.

**Client**

1. Store `boardEtag` and `notesEtag` after each load/save.
2. In `checkForUpdates()` and `checkForNotesUpdates()`: send `If-None-Match: <etag>`; skip processing on 304.
3. Update stored etag on every 200 response and after every save.

### IMPLEMENTED: Phase 4 — Optimistic save guard (If-Match / 409)

Applies to both board and notes saves.

**Server**

1. In `PATCH /api/:board/board` and `PATCH /api/:board/notes` (and `PUT` fallbacks): read `If-Match` header; compare against current CouchDB `_rev`; return `409 { error: "conflict" }` on mismatch.

**Client**

1. In `schedulesSave()` and `scheduleSaveNotes()`: include `If-Match: <etag>` in the request.
2. On 409: `await load()` (or `await loadNotes()`), merge, and retry once.

### IMPLEMENTED: Phase 5 — Auto-merge on poll for board

Replace the existing manual "click to merge" flow for the board with the same auto-merge logic already used for notes. The board `mergeStates` function should also be updated to use `lastModified` as a tiebreaker for card field conflicts (currently local always wins regardless of age).

Steps:

1. In `mergeStates`: when both local and remote changed the same card field, compare `lCard.lastModified` vs `mCard.lastModified` and keep the newer value (mirrors `mergeNotesStates`).
2. In `checkForUpdates()`: on a 200 response, if `saveTimer` is active (local pending changes), call `mergeStates(baseState, remote, state)` and apply automatically. If no pending changes, apply remote directly.
3. Remove (or keep as no-op) the manual title-click merge path.

This is low-risk once Phase 4 is in place and `mergeStates` is updated.

---

## Risk and rollback notes

- Phases 1–3 are additive (new endpoints, new client fields); the existing `PUT` fallback remains, so partial deployment is safe.
- Phase 4 changes error handling on existing endpoints. Deploy server and client together to avoid spurious 409s from old clients that don't send `If-Match`.
- Phase 5 removes user-triggered merge. Only do this after Phase 4 is confirmed working and `mergeStates` is updated with `lastModified` tiebreaking.
