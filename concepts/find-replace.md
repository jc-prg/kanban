# Concept: In-Modal Find & Replace

Adds a floating find/replace bar to the card-edit and note modals, triggered by **Ctrl+F** (find) and **Ctrl+R** (find & replace). Operates entirely within the currently-open modal's description field — no backend involvement, no cross-board search.

---

## Scope and behaviour

- Works inside the two modals that contain a CodeMirror markdown editor: **card edit modal** and **note page modal**.
- **Ctrl+F** opens the bar in find-only mode (single row: find input + counter + ↑↓ nav + close).
- **Ctrl+R** opens the bar in replace mode (adds a second row: replace input + Replace + All buttons).
- While the bar is open, the editor **stays in editing mode** — it does not switch to preview.
- Pressing Escape or the ✕ button closes the bar and returns focus to the CodeMirror editor.
- If text is selected in the editor (or the preview) when the bar opens, that text is pre-filled into the find input and the first match is highlighted immediately.

---

## Where the code lives

Everything is in **`app/frontend/editor.js`** (the CodeMirror wrapper module), starting at the comment `// ---- in-modal find bar (Ctrl+F / Ctrl+R inside card/note modals) ----`. Styling is in **`app/frontend/styles/overlay.css`** under the matching comment.

No HTML changes are needed — the bar is created dynamically and appended to the `.modal` element inside each modal-backdrop.

---

## Editor–modal mapping

```js
const _editorModalMap = { cardDesc: 'modal', notePageDesc: 'noteModal' };
```

Each CodeMirror editor has an ID (`cardDesc`, `notePageDesc`). The map points to the `id` of the containing modal-backdrop `<div>`. This is all that ties the find bar to a specific modal.

To support a new modal with its own editor, add one entry here.

---

## Find state object

One state object per editor, stored in `_findState: Map<editorId, state>`.

```js
{
  bar,          // the outer .modal-find-bar <div>
  input,        // find <input>
  counter,      // <span> showing "N / M"
  replaceRow,   // the second .modal-find-row--replace <div>
  replaceInput, // replace <input>
  matches,      // [{ from, to }, …] — character offsets into the CM doc
  idx,          // index of the currently-highlighted match
  editorId,     // 'cardDesc' | 'notePageDesc'
}
```

The state is created lazily by `_createFindBar(editorId)` on first open and reused on subsequent opens. `_closeFindBar` clears the inputs and match list but leaves the DOM in place.

---

## Bar HTML structure

```html
<div class="modal-find-bar" style="display:none">

  <!-- Row 1: always visible -->
  <div class="modal-find-row">
    <input class="modal-find-input" placeholder="Find in text…">
    <span class="modal-find-counter"></span>
    <button class="modal-find-btn" data-dir="-1">↑</button>
    <button class="modal-find-btn" data-dir="1">↓</button>
    <button class="modal-find-close">✕</button>
  </div>

  <!-- Row 2: hidden until Ctrl+R -->
  <div class="modal-find-row modal-find-row--replace" style="display:none">
    <input class="modal-find-input modal-find-replace-input" placeholder="Replace with…">
    <button class="modal-find-replace-btn" data-act="replace-one">Replace</button>
    <button class="modal-find-replace-btn" data-act="replace-all">All</button>
  </div>

</div>
```

The bar is appended to the inner `.modal` element (not the backdrop) so it scrolls with the modal content and can be positioned absolutely relative to the modal box.

---

## CSS

`.modal-find-bar` is positioned `absolute; top: 10px; right: 56px` (just left of the fullscreen button). The JS sets `display: flex | none`; the CSS sets `flex-direction: column` so the two rows stack vertically.

```css
.modal-find-bar   { flex-direction: column; gap: 2px; /* + position/bg/border/shadow */ }
.modal-find-row   { display: flex; align-items: center; gap: 3px; }
.modal-find-input { background: transparent; border: none; width: 150px; font-size: 13px; }
.modal-find-input--nomatch { color: #f87171; }   /* red when 0 results */
.modal-find-replace-btn    { font-size: 11px; /* same hover style as .modal-find-btn */ }
```

All buttons have `mousedown` → `e.preventDefault()` to prevent them from stealing focus from the editor or the find input.

---

## Core functions

### `_createFindBar(editorId)`
Called once per editor on first open. Builds the DOM, registers all event listeners, stores the state in `_findState`. Returns the state object.

### `_openFindBar(editorId, mode = 'find')`
1. Calls `_createFindBar` (no-op if already created).
2. **Pre-fills from selection:** reads the CodeMirror selection (editor mode) or `window.getSelection()` scoped to the preview element (preview mode). Only uses single-line text ≤ 200 chars.
3. Calls `_runFind(st)` if there is a value (pre-filled or leftover from last open).
4. Shows the bar (`display: flex`).
5. If `mode === 'replace'`, shows the replace row. Focus always goes to the find input first.

### `_closeFindBar(st)`
Hides the bar, clears both inputs, clears `matches` / `idx`, hides the replace row. Then either re-renders the preview (if in preview mode, to strip highlights) or calls `entry.view.focus()` (if in editor mode, to return keyboard control to CodeMirror).

### `_showReplaceRow(st)`
Sets `st.replaceRow.style.display = 'flex'`. Called on Ctrl+R or when Ctrl+R is pressed while the bar is already open.

### `_runFind(st)`
Reads `st.input.value`, escapes it as a literal string, and runs a global case-insensitive regex against the full CodeMirror document text. Stores `{ from, to }` pairs in `st.matches` (capped at 500). Calls `_findGoto(st, 0)` on the first match, or updates the counter to `0 / 0` if nothing found.

### `_findNavigate(st, dir)`
Increments/decrements `st.idx` with wrap-around, then calls `_findGoto`.

### `_findGoto(st, idx)`
- **Editor active:** dispatches a CodeMirror selection change to highlight the match and scroll it into view.
- **Preview mode:** calls `_applyFindHighlights` to re-render the preview HTML with `<span class="modal-find-hl">` wrappers (current match gets `modal-find-hl--current`), then scrolls the current span into view.

### `_replaceOne(st)`
Takes `st.matches[st.idx]`, dispatches a single CodeMirror `changes` operation replacing that range with `st.replaceInput.value`, then calls `_runFind(st)` to rebuild the match list with updated offsets.

### `_replaceAll(st)`
Dispatches all matches as a single CodeMirror `changes` array (CodeMirror adjusts offsets internally for simultaneous multi-range replacements), then calls `_runFind(st)`.

---

## Keeping the editor in edit mode

By default, when the CodeMirror `editorWrap` loses focus, a `focusout` handler calls `_deactivateEditor` (switches to preview). Moving focus to the find bar would normally trigger this.

**Fix:** the `focusout` handler checks `_findState` for the editor and skips deactivation if the new focus target is inside the find bar:

```js
editorWrap.addEventListener('focusout', e => {
  const st = _findState.get(id);
  if (st?.bar.contains(e.relatedTarget)) return;   // ← find bar keeps editor active
  if (!editorWrap.contains(e.relatedTarget)) _deactivateEditor(id);
});
```

---

## Keyboard shortcuts

All listeners use `{ capture: true }` so they intercept keystrokes before the browser acts (Ctrl+F would open browser find; Ctrl+R would reload the page).

| Key | Context | Action |
|---|---|---|
| Ctrl+F | Modal open | Open bar (find mode), or re-focus find input if already open |
| Ctrl+R | Modal open | Open bar (replace mode), or show replace row + focus find input |
| Enter | Find input | Navigate to next match |
| Shift+Enter | Find input | Navigate to previous match |
| Ctrl+R | Find input | Show replace row, focus replace input |
| Enter | Replace input | Replace current match |
| Ctrl+F | Replace input | Focus find input |
| Escape | Either input | Close the bar |

---

## Integration with the rest of the codebase

- **`closeModalFind(editorId)`** — exposed on `window`; called by `cards.js` and `notes.js` when their modals close, so the bar is reset cleanly even if it was open.
- **No changes to `cards.js`, `notes.js`, or `index.html`** are needed to add the feature. The bar is self-contained in `editor.js`.
- **Adding a new editor/modal pair:** register it in `_editorModalMap` and make sure `closeModalFind(editorId)` is called when that modal closes.
