# Concept: WebDAV Notes v4 — files are the truth, the index is a cache

Supersedes v3 (`webdav-notes-v3.md`). Implemented in two ports with the same model:

| | Kanban (Node) | CV-App (Python) |
|---|---|---|
| Code | `app/notes-webdav/backend/` | `CV-App/modules/notes-webdav/` |
| Index stored in | the board's CouchDB notes document (`source: "webdav"`) | `data/notes_cache/index.json` + content cache |
| API | id-based routes (unchanged shape), ids resolved to paths | path-based routes (`/api/notes/tree`, `/page?path=` …) |
| Tests | `tests/api/notes-ops.test.js` (fake WebDAV, `tests/setup/fakeDav.js`) | `backend/tests/notes/test_notes.py` (wsgidav, local store) |

## Why v3 failed

Every app kept its own full copy of the tree (titles, order, ids and the text) in its database and matched it against the files with `wdPath` and slug heuristics. With Obsidian and two apps writing the same folder that gave three sources of truth:

- renames/moves outside the app → old entry "orphaned", new entry with the same front matter id → duplicates
- lazy sync only looked at open folders; the full sync attached files of nested folders to the top folder
- write errors were swallowed ("saving to DB cache") → DB-only content, later "not yet uploaded" orphans
- `lastModified` set before the PUT was always older than the server mtime → every saved note was downloaded again
- the front matter was rebuilt on every save → Obsidian properties (`tags`, `aliases`) were lost
- a new HTTP client per request (CV-App) and sequential downloads on the read path → slow tree

## Model

1. **File = note, path = identity.** Title = file name, folders = directories, order = folders first, then alphabetical (like Obsidian). Dot folders and `_attachments/` are not part of the tree.
2. **The index is a cache.** It is rebuilt from the file listing; whatever is missing on the server is gone from the index. No heuristics, no orphans.
3. **Change detection with ETags.** Nextcloud/ownCloud (detected by `oc:fileid`) propagate folder ETags: unchanged root ETag = one `PROPFIND Depth:0`. Otherwise only folders whose ETag changed are listed again (Depth:1). Other servers and full rebuilds: one `Depth:infinity` (fallback: Depth:1 walk). At most 4 listings / 3 downloads at a time — small Nextcloud instances have few PHP workers.
4. **Stale-while-revalidate.** The tree is answered from the index at once; a background check (at most every 5 s) follows, `?wait=1` waits for it. Front matter fields are read in the background for files with a new ETag.
5. **Optimistic locking.** Notes are read with `If-None-Match` (usually 304) and saved with `If-Match`; 412 → conflict dialog (line diff; overwrite / load theirs / save mine as a copy). New files: `If-None-Match: *`; moves: `Overwrite: F`. Errors are reported, never turned into DB-only state. If the server needs more than 2.5 s to answer a read, the cached copy is shown with a hint.
6. **Front matter round trip** (`yaml` / `ruamel.yaml`): unknown keys, order and comments stay. The apps own `id`, `link`, `linkedCards`. Legacy keys `title`, `lastModified`, `attachments`, `source` are removed (CV-App: by the migration; Kanban: also on every write).
7. **Attachments on the server** in `<folder>/_attachments/`, linked in the text with relative Markdown links. Moving a note to another folder takes the attachments it links along (copied if another note there still links them); deleting a note deletes attachments only it links. Obsidian embeds `![[file]]` are resolved by file name.
8. **Ids** (Kanban needs them for card links and deep links): front matter `id` if present and unique, otherwise derived from the path. Both stay resolvable. Writing a note pins its id in the front matter.

## Migration

`POST …/migrate` (dry run by default): writes pages whose text exists only in the old DB tree — also files deleted elsewhere unless the same text lives in another file (= moved outside the app) — uploads local attachment copies, cleans the front matter, then empties the old tree (it stays in the backups). Idempotent. Run CV-App first, then Kanban; a second run on shared files finds nothing to do.

## Recommended Obsidian settings

Files & links → "Default location for new attachments": *In subfolder under current folder*, name `_attachments`; "Use [[Wikilinks]]" off and "New link format": *Relative path to file* — then Obsidian, Kanban and CV-App store and link attachments the same way. (`[[Page]]` links render in both apps' previews; `![[file]]` embeds so far only in the CV-App.)
