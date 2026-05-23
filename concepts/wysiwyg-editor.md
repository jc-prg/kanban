# WYSIWYG Markdown Editor — Implementation Concept

## 1. Goal

Replace the current textarea + toggle-preview pattern in the **card modal** and the **note page modal** with a single editing surface that renders Markdown formatting inline while the user types. The underlying storage format stays plain Markdown; nothing changes in the backend, CouchDB schema, or API.

---

## 2. Current Architecture

Both modals share the same dual-surface pattern:

```
[textarea #cardDesc / #notePageDesc]    ← raw Markdown input
[div #cardDescPreview / #notePageDescPreview]  ← rendered HTML (hidden while editing)
```

Behaviour today:
- On focus: preview hides, textarea appears.
- On blur (with content): textarea hides, preview div shows rendered HTML via `marked.parse()` + `DOMPurify`.
- Toolbar buttons insert Markdown syntax into the textarea at cursor position.
- Attachment upload appends Markdown text (`![name](attachment:name)`) to `textarea.value`.
- `hasUnsavedChanges()` compares `textarea.value` to the snapshot at open time.
- Card/note submit reads `document.getElementById('cardDesc').value`.

The toggle is the main UX friction: the user has to mentally context-switch between "raw text" and "rendered output."

---

## 3. Scope

| Surface | Affected files |
|---|---|
| Card description | `cards.js`, `index.html`, new CSS |
| Note page description | `notes.js`, `index.html`, new CSS |
| Shared editor setup | new `editor.js` |
| Existing vendor libs | `marked.min.js`, `purify.min.js` — **kept** for card rendering in `render.js` and card-info dialog |

Out of scope: card title, note title, search fields, settings.

---

## 4. Library Evaluation

### Constraint recap
- No build step, no bundler.
- Vanilla JS, load order via `<script>` tags.
- ESM `<script type="module">` is acceptable.
- Custom Markdown extension: `==highlight==` → `<mark>`.
- Custom URI schemes: `attachment:<filename>` and `_attachments/<pageId>_<filename>`.
- Attachment images must resolve to blob URLs (auth-gated fetch).

### Options

#### A — CodeMirror 6 (recommended)
**Style:** Typora-like. The user edits plain Markdown text, but the editor decorates it in real time: `**bold**` renders with the `**` hidden and the word styled bold; `# Heading` renders with a heading font. When the cursor enters a decorated region, the raw syntax reappears so the user can edit it.

- Self-hosted as a single pre-built ESM bundle (`frontend/vendor-libs/codemirror-bundle.js`, 593 KB minified). Generated with esbuild from `codemirror` + `@codemirror/lang-markdown`; no CDN dependency, no import map required.
- `@codemirror/lang-markdown` parses Markdown and drives all decorations.
- Storage format: the editor **is** the text. `editor.state.doc.toString()` gives the Markdown string. No serializer needed.
- Toolbar buttons use `editor.dispatch({ changes: { insert: '**' } })` — same logic as today, just targeting the CM API instead of `textarea.value`.
- Attachment paste/drop: same `_handleCardAttachUpload` / `_handleAttachUpload` calls; replace `_appendAttachMd`'s `ta.value +=` with a CM transaction that inserts at the end of the doc.
- `attachment:` images are **not** rendered inside the editor (they stay as literal Markdown text); the resolved preview continues to use the existing `resolveCardAttachments()` function — see §8.
- Bundle size: 593 KB (single self-hosted file, includes all CM 6.0.2 dependencies).
- Implementation effort: **medium** (~400 lines of new glue code).

#### B — ProseMirror (full invisible-syntax WYSIWYG)
**Style:** Notion-like. The user never sees `**` or `#`; the document always looks like the final output. Formatting is applied through toolbar commands or keyboard shortcuts.

- ESM, available from CDN (`prosemirror-state`, `prosemirror-view`, `prosemirror-model`, `prosemirror-markdown`, `prosemirror-keymap`, `prosemirror-commands`, `prosemirror-history`) — 7 modules, ~250 KB.
- Storage: `prosemirror-markdown` serialises the ProseMirror document back to Markdown on save.
- Custom schema node/mark needed for `==highlight==`.
- `attachment:` images need a custom node type: on render, the node fires an async blob-URL fetch and updates `img.src`. On serialise, it emits `![alt](attachment:name)` Markdown.
- Toolbar buttons dispatch ProseMirror commands (`toggleMark(schema.marks.strong)`, etc.).
- The `clickPreviewToEditor` mechanism is eliminated (no separate preview).
- Implementation effort: **high** (~1 000+ lines including custom schema, serialiser patches, image node plugin, input rules for Markdown shortcuts like `**` triggering bold).

#### C — Toast UI Editor (CDN)
- Full CDN build available; switches between WYSIWYG and Markdown modes.
- Ships its own CSS (~80 KB) that conflicts with the project's design system and dark/light theme.
- No control over the toolbar rendering; custom URI schemes require monkey-patching internals.
- Hard to match the existing modal styling without fighting the library.
- **Not recommended.**

#### D — Custom contenteditable
- Build a WYSIWYG editor from scratch on a `contenteditable` div.
- Cursor/caret management, IME input, selection across nodes, undo/redo, and clipboard handling are all notoriously difficult to implement correctly.
- **Not recommended** — high risk, high maintenance.

---

## 5. Recommended Approach: CodeMirror 6

### Why
- **Markdown stays as text.** No serialiser, no round-trip risk. What the user types is exactly what gets saved — the decorations are purely visual.
- **Custom extensions are easy.** `==highlight==` is a MarkdownIt-style extension in `@codemirror/lang-markdown`; `attachment:` URIs just remain literal text in the editor.
- **Toolbar is nearly unchanged.** Buttons still insert Markdown syntax; only the target API changes from `textarea.selectionStart/setRangeText` to CodeMirror dispatch transactions.
- **No CDN dependency.** All CodeMirror 6 packages are pre-bundled into a single self-hosted ESM file (`/vendor-libs/codemirror-bundle.js`) built with esbuild. The app works fully offline.
- **Test compatibility.** E2E tests that currently read `#cardDesc` via `inputValue()` can read the editor value via a small `window.getEditorValue('cardDesc')` helper exposed in `editor.js`.

### What a user sees
| Action | Today | With CodeMirror |
|---|---|---|
| Open card (with description) | Preview shown; must click/focus to edit | Description already shown formatted; click anywhere to start editing |
| Type `**bold**` | Sees literal `**bold**` in textarea | `**` hides as soon as cursor leaves the word; text appears bold |
| Type `# Heading` | Sees `# Heading` in textarea | `#` hides; line renders at heading size |
| Upload/paste image | Appended as `![name](attachment:name)` text | Same, appended as Markdown text (resolves in preview on save, as now) |
| Save | Reads `textarea.value` | Reads `editor.state.doc.toString()` |

---

## 6. Integration Map

### 6.1 New file: `frontend/editor.js`

Owns the CodeMirror setup. Exposes a minimal surface:

```js
// Initialise an editor in place of a textarea element
function createMarkdownEditor(textareaId, { onChange } = {}) { … }

// Read current Markdown content
function getEditorValue(textareaId) { … }

// Set Markdown content (e.g. when opening a card)
function setEditorValue(textareaId, markdown) { … }

// Insert text at current cursor (replaces _appendAttachMd's textarea write)
function insertAtCursor(textareaId, text) { … }

// Expose on window for E2E tests
window.getEditorValue = getEditorValue;
```

Imports CodeMirror symbols directly from the bundle:

```js
import { EditorView, EditorState, basicSetup, markdown } from '/vendor-libs/codemirror-bundle.js';
```

Loaded as `<script type="module" src="/editor.js">` before `cards.js` and `notes.js`.

### 6.2 `index.html`

- No import map needed — `editor.js` imports directly from `/vendor-libs/codemirror-bundle.js`.
- Replace `<textarea id="cardDesc">` with `<div id="cardDesc-mount">` (CodeMirror mounts here); keep a hidden `<textarea id="cardDesc" style="display:none">` for any code not yet migrated (optional transitional shim).
- Same for `<textarea id="notePageDesc">`.
- Remove `<div id="cardDescPreview">` and `<div id="notePageDescPreview">` — no longer needed.
- Remove toolbar toggle buttons (`#cardDescToggle`, `#noteDescToggle` if present).

### 6.3 `cards.js`

| Change | Detail |
|---|---|
| Remove `showDescEditor()` / `showDescPreview()` / `showMarkdownPreview()` | Editor is always in edit mode |
| Remove blur handler that triggers preview | Not needed |
| Remove `clickPreviewToEditor` calls | No preview div |
| `openModal()` | Call `setEditorValue('cardDesc', '')` instead of `ta.value = ''` |
| `openEditModal()` | Call `setEditorValue('cardDesc', card.description \|\| '')` |
| `submitCard()` | Read `getEditorValue('cardDesc')` instead of `#cardDesc.value` |
| `_appendAttachMd('cardDesc', …)` | Call `insertAtCursor('cardDesc', mdText)` |
| Paste / drop handlers | Keep as-is; they call `_handleCardAttachUpload` which calls `_appendAttachMd` |
| Toolbar buttons (`_cardToolbar`) | Replace `ta.setRangeText(…)` with `insertAtCursor(…)` or a CM `toggleMark` command |
| `resolveCardAttachments(el)` | Invoked on the rendered card-info dialog (not the editor) — **unchanged** |

### 6.4 `notes.js`

Mirror of the card changes for `notePageDesc`:

| Change | Detail |
|---|---|
| Remove `showNoteDescEditor()` / `showNoteDescPreview()` | |
| `openNoteModal()` | `setEditorValue('notePageDesc', page.description \|\| '')` |
| `_submitNote()` | `getEditorValue('notePageDesc')` |
| `_notePageHasUnsavedChanges()` | Compare `getEditorValue('notePageDesc')` to `noteModalOrig.desc` |
| `_appendAttachMd('notePageDesc', …)` | `insertAtCursor('notePageDesc', mdText)` |
| `_applyNoteFormat(action)` (toolbar) | CM dispatch transaction instead of `setRangeText` |

### 6.5 CSS (`overlay.css` or new `editor.css`)

- Style the CodeMirror container (`#cardDesc-mount .cm-editor`) to match the existing textarea: same border, border-radius, background, padding, font, `min-height`, `max-height` + scroll.
- Dark/light theme tokens from `:root` forwarded into CodeMirror's theme extension.
- `.cm-content` font: `var(--font-mono)` or the body font — to be decided.
- Hide the CM selection gutter (line numbers off by default in CM6 — keep off).

---

## 7. Challenges & Mitigations

### 7.1 Load order
CodeMirror must be initialised before `cards.js` and `notes.js` call `createMarkdownEditor`. Solution: `<script type="module" src="/editor.js">` is placed before the other scripts; the module system guarantees it resolves before the dependent scripts run (they can also be converted to modules, or `editor.js` can expose its API on `window` synchronously). The bundle file (`/vendor-libs/codemirror-bundle.js`) is a plain static asset served by Express — no special server config required.

### 7.2 `attachment:` image resolution
CodeMirror renders the Markdown text; it does **not** render `![alt](attachment:name)` as an `<img>`. This is intentional — the editor shows the Markdown source and the user understands it as a reference. The resolved image appears:
- In the card-info dialog (existing `resolveCardAttachments` — unchanged).
- In the notes preview pane if one is introduced later.

If inline image preview inside the editor is wanted in a future phase, a custom CM `DecorationSet` widget can replace `![…](attachment:…)` spans with a lazy-loaded `<img>`.

### 7.3 E2E test compatibility
Tests like `await page.locator('#cardDesc').inputValue()` will fail once the textarea is removed. Mitigations:
- Expose `window.getEditorValue('cardDesc')` and use `page.evaluate(() => getEditorValue('cardDesc'))` in tests.
- Or: keep the hidden textarea as a write-through mirror (editor `onChange` → `textarea.value = …`), so existing `inputValue()` calls keep working at the cost of a redundant element.

### 7.4 `==highlight==` extension
CodeMirror's Markdown parser accepts custom `InlineParser` extensions. A small parser that tokenises `==…==` and emits a `mark` decoration keeps the existing highlight feature working in the editor.

### 7.5 Undo/redo
CodeMirror 6 ships built-in undo/redo (`@codemirror/commands` `history` extension). The existing `Ctrl+Z` browser undo on the textarea is replaced. The native browser undo on `contenteditable` that CodeMirror uses internally is scoped to the editor.

### 7.6 Auto-save dialogs
The `autoSaveDialogs` feature reads textarea values (`#cardDesc.value`) on a timer. Must be updated to call `getEditorValue()`.

### 7.7 Mobile / touch
CodeMirror 6 handles mobile input reasonably. The virtual keyboard will open as normal. No special handling needed.

---

## 8. What Stays Unchanged

- All backend code, API, CouchDB schema.
- `render.js` — card body Markdown rendering in the board uses `marked` + DOMPurify as today.
- `marked.min.js` and `purify.min.js` — still used for card-info dialog and `render.js`.
- Attachment upload handlers (`_handleCardAttachUpload`, `_handleAttachUpload`).
- Paste and drag-drop image upload (added in v1.5.1).
- `resolveCardAttachments` / `resolveAttachments` for the card-info dialog and notes viewer.
- All other modals (settings, confirm, search, prompts).
- State management and save/patch logic in `state.js`.

---

## 9. Open Questions

1. **Inline image preview inside the editor?** Out of scope for the initial implementation; can be added as a CM widget decoration later.
2. **Syntax highlighting for code blocks?** CodeMirror can load language extensions lazily. Adds complexity; suggest deferring.
3. **Convert note/card toolbar buttons to ProseMirror-style keyboard shortcuts only?** The toolbar stays; keyboard shortcuts (`Ctrl+B`, `Ctrl+I`) can be added as a bonus via CM keybindings.
4. **Side-by-side split view (editor + preview)?** Not needed if decorations are good enough. Could be offered as an optional toggle for power users.
5. **ProseMirror migration later?** The `getEditorValue()` / `setEditorValue()` / `insertAtCursor()` API in `editor.js` is designed to be backend-agnostic — swapping the CM implementation for a ProseMirror one later would only require changing `editor.js`.

---

## 10. Proposed Implementation Order

1. **Phase 1 — editor.js scaffold**: Initialise CodeMirror 6 in both mount points; wire up `getEditorValue` / `setEditorValue` / `insertAtCursor`; keep old textarea as write-through mirror so nothing breaks yet.
2. **Phase 2 — cards.js migration**: Replace textarea reads/writes; remove preview toggle; adapt toolbar buttons.
3. **Phase 3 — notes.js migration**: Same for note page editor.
4. **Phase 4 — CSS polish**: Match editor container to design system; dark/light themes.
5. **Phase 5 — `==highlight==` extension**: Add custom inline parser.
6. **Phase 6 — test updates**: Replace `inputValue('#cardDesc')` calls with `page.evaluate(() => getEditorValue('cardDesc'))`.
