# Concept: Enhanced Link Handling in Markdown Descriptions

Adds wiki-style internal page links, link-type icons, and navigation history to note page descriptions.

---

## Features

| Syntax | Result |
|---|---|
| `[[Page Title]]` | Internal note page link; opens that page on click |
| `[Label](Page Title)` | Internal note page link with custom label (spaces in title are allowed) |
| `[[https://url]]` | External link with open-link icon |
| `[[mailto:user@host]]` | Email link with email icon |
| `[text](https://url)` | Standard external link + open-link icon appended |
| `[text](mailto:…)` / `<email>` | Standard email link + email icon appended |
| `[text](attachment:…)` / `[text](_attachments/…)` | Attachment link + attachment icon appended |

Missing page references (`[[Page That Does Not Exist]]`) render as `⚠ Page That Does Not Exist` in muted italic style instead of a clickable link.

Navigating via a note-page link uses `pushState` so the browser back button returns to the originating page. If the current page has unsaved changes, a confirmation dialog ("Save and continue" / "Cancel") appears first.

---

## Architecture

Three files share the work:

| File | Responsibility |
|---|---|
| `app/frontend/cards.js` | marked extensions + renderer overrides (runs globally for both card and note descriptions) |
| `app/notes-webdav/frontend/notes.js` | `resolveNotePageLinks`, navigation, history management |
| `app/frontend/styles/markdown.css` | `.md-link-icon` styling |

### Why `app/notes-webdav/frontend/notes.js` and NOT `app/frontend/notes.js`

`server.js` mounts two static directories:
- `/` → `app/frontend/` (cards, state, render, …)
- `/notes-webdav` → `app/notes-webdav/frontend/`

`index.html` loads `<script src="/notes-webdav/notes.js">`, which resolves to `app/notes-webdav/frontend/notes.js`. Editing `app/frontend/notes.js` has **no browser effect**. Verify the correct file by checking the `<script>` tags in `index.html` and the static routes in `server.js` before touching any notes-related frontend code.

---

## Part 1 — marked extensions in `cards.js`

### Critical: marked v18 behaviour

- **`[text](href with spaces)` is not valid CommonMark.** marked v18 silently drops it — no `link` token is created and no renderer fires. A `walkTokens` type-change approach also fails for the same reason. The only solution is an inline extension with its own tokenizer that runs *before* the built-in link tokenizer.
- **Returning `false` from `renderer.link`** is unreliable in marked v18 as a "fall through" signal. Avoid it; return a proper string or don't override at all.
- **Extension priority**: `marked.use({ extensions: [...] })` prepends to the extension list — the last registered extension is tried first. `start(src) { return src.indexOf('['); }` makes the extension compete at every `[` character, ensuring it fires before the built-in link tokenizer.

### Helper and URL guard

```js
function _escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

const _notePageUrlRe = /^(?:https?:|ftp:|mailto:|attachment:|_attachments\/|#|\/)/;
```

`_notePageUrlRe` distinguishes "looks like a real URL/scheme" from "this is a page title". It is checked in both tokenizer branches so URL-style content is never treated as an internal page reference.

### Combined `notepage` inline extension

```js
marked.use({
  extensions: [{
    name: 'notepage',
    level: 'inline',
    start(src) { return src.indexOf('['); },
    tokenizer(src) {
      // [[title]], [[title|label]], [[url]], [[url|label]]
      let m = src.match(/^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/);
      if (m) {
        const inner = m[1].trim();
        if (_notePageUrlRe.test(inner)) {
          // [[https://url]] — render as a clean external link (avoids marked
          // producing "[[<a>url</a>]]" with literal brackets showing)
          return { type: 'notepage', raw: m[0], href: inner, label: m[2]?.trim() || inner };
        }
        return { type: 'notepage', raw: m[0], title: inner, label: m[2]?.trim() };
      }
      // [label](title with spaces) — page title, not a URL
      m = src.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (m && !_notePageUrlRe.test(m[2].trimStart()))
        return { type: 'notepage', raw: m[0], title: m[2].trim(), label: m[1].trim() };
    },
    renderer(token) {
      if (token.href) {
        const icon = /^mailto:/i.test(token.href) ? _svgEmail(10,10) : _svgOpenLink(10,10);
        return `<a href="${_escAttr(token.href)}">${_escAttr(token.label)}<span class="md-link-icon">${icon}</span></a>`;
      }
      const display = token.label !== undefined ? token.label : token.title;
      return `<a class="note-page-link" data-note-page-title="${_escAttr(token.title)}" href="#">`
           + `${_escAttr(display)}<span class="md-link-icon">${_svgNotePages(10,10)}</span></a>`;
    }
  }]
});
```

### Standard link renderer override (icons for http/mailto/attachment)

Registered after the `notepage` extension so it only fires for tokens that the `notepage` extension did not consume:

```js
marked.use({
  renderer: {
    link({ href, title, text }) {
      const h = href || '';
      let icon = '';
      if (/^https?:/i.test(h))                          icon = _svgOpenLink(10, 10);
      else if (/^mailto:/i.test(h))                     icon = _svgEmail(10, 10);
      else if (/^(attachment:|_attachments\/)/.test(h)) icon = _svgAttachment(10, 10);
      const iconHtml = icon ? `<span class="md-link-icon">${icon}</span>` : '';
      const tAttr = title ? ` title="${_escAttr(title)}"` : '';
      return `<a href="${_escAttr(h)}"${tAttr}>${text}${iconHtml}</a>`;
    }
  }
});
```

### DOMPurify config in `renderMarkdown`

`data-note-page-title` must be explicitly whitelisted; DOMPurify (in the version used here) does not pass `data-*` attributes through by default:

```js
function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true }), {
    ALLOWED_URI_REGEXP: /^(?:https?|ftp|mailto|attachment:|_attachments\/)/i,
    ADD_URI_SAFE_ATTR: ['type'],
    ADD_ATTR: ['data-note-page-title'],
  });
}
```

The editor preview (`editor.js`) uses its own DOMPurify call with `{ ADD_ATTR: ['target'] }` as the base. `data-*` attributes are passed through there by the default DOMPurify config, so no additional config is needed for the editor preview path.

---

## Part 2 — Resolution in `notes-webdav/frontend/notes.js`

All functions here live inside the module's closure (indented one level).

### `findNotePageByTitle`

Case-insensitive, recursive search across the full notes tree:

```js
function findNotePageByTitle(title, items) {
  const t = title.trim().toLowerCase();
  for (const item of items) {
    if (item.type === 'page' && item.title.trim().toLowerCase() === t) return item;
    if (item.type === 'folder') { const f = findNotePageByTitle(title, item.children || []); if (f) return f; }
  }
  return null;
}
```

### `resolveNotePageLinks`

Runs after every preview render. Found pages keep their `<a data-note-page-title>` element (the capture click handler below handles navigation). Missing pages are replaced with a warning span:

```js
function resolveNotePageLinks(el) {
  el.querySelectorAll('a[data-note-page-title]').forEach(a => {
    const title = a.getAttribute('data-note-page-title');
    const page  = findNotePageByTitle(title, notesState.items);
    if (!page) {
      const span = document.createElement('span');
      span.className = 'note-page-link--missing';
      const icon = document.createElement('span');
      icon.className = 'note-page-link-icon';
      icon.textContent = '⚠';
      span.append(icon, document.createTextNode(' ' + a.textContent));
      // a.textContent excludes the SVG icon child (SVG has no text content)
      a.replaceWith(span);
    }
  });
}
```

Wire it into the editor's `onPreview` callback:

```js
_editor.create('notePageDesc', {
  onPreview: el => { resolveAttachments(el); resolveNotePageLinks(el); }
});
```

And into the print path (after `await resolveAttachments(root)`):

```js
resolveNotePageLinks(root);
```

### Capture-mode click handler

The editor (`editor.js`) has a bubble-phase click listener on the preview element that activates edit mode. To intercept clicks on note-page links before that fires, use **capture mode** on the editor mount:

```js
document.getElementById('notePageDesc-mount')?.addEventListener('click', async e => {
  const a = e.target.closest('a.note-page-link');
  if (!a) return;
  const title = a.getAttribute('data-note-page-title');
  if (!title) return;
  e.preventDefault();
  e.stopPropagation(); // stops the editor's bubble-phase listener
  const page = findNotePageByTitle(title, notesState.items);
  if (!page) return;
  if (noteModalHasChanges()) {
    const ok = await _showConfirm('This page has unsaved changes.', {
      okLabel: 'Save and continue',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    await submitNote();
  }
  openNoteModal(page.id, false, { push: true });
}, { capture: true });
```

`e.stopPropagation()` in the capture phase prevents the event from reaching both the editor's bubble listener and any other parent handlers.

Register this listener inside `_init()` (the `DOMContentLoaded` wiring function), right after `_editor.create`.

### History management in `openNoteModal`

`openNoteModal` originally always used `history.replaceState`. Add a `push` option:

```js
async function openNoteModal(pageId, focusTitle = false, { push = false } = {}) {
  // ... existing body ...
  if (!_pendingNewPage)
    history[push ? 'pushState' : 'replaceState'](null, '', '#note:' + pageId);
  // ...
}
```

All existing callers (tree item click, deep-link open on page load, etc.) pass no third argument and therefore continue to use `replaceState`. Only the note-page link click handler passes `{ push: true }`.

### `closeNoteModal` — skip history update on popstate

When the browser navigates back, it already changed the URL before `popstate` fires. Calling `replaceState` again in `closeNoteModal` would be a no-op but add confusion. Add a guard:

```js
function closeNoteModal(skipHistory = false) {
  // ...
  if (!skipHistory && location.hash.startsWith('#note:'))
    history.replaceState(null, '', location.pathname + location.search);
  // ...
}
```

### `popstate` listener

Register once in `_init()`:

```js
window.addEventListener('popstate', () => {
  if (location.hash.startsWith('#note:')) {
    openNoteModal(location.hash.slice(6)); // replaceState — URL already set
  } else if (noteModalPageId) {
    closeNoteModal(true); // skipHistory=true — URL already cleared
  }
});
```

---

## Part 3 — CSS (`markdown.css`)

```css
/* Inline link-type icons */
.card-desc-preview .md-link-icon {
  display: inline-block;
  vertical-align: middle;
  margin-left: 3px;
  opacity: 0.65;
}

/* Internal note page links */
a.note-page-link {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}
.note-page-link--missing {
  color: var(--text-muted);
  font-style: italic;
}
.note-page-link--missing .note-page-link-icon {
  margin-right: 0.2em;
  font-style: normal;
}
```

The `.md-link-icon` selector is scoped to `.card-desc-preview` so the icons only appear inside markdown preview panes, not in button labels or other UI that happens to contain `<span class="md-link-icon">`.

---

## Pitfalls summary

| Pitfall | What happens | Fix |
|---|---|---|
| Editing `app/frontend/notes.js` | No browser effect — wrong file | Always edit `app/notes-webdav/frontend/notes.js` for note modal logic |
| `[text](title with spaces)` via `walkTokens` or link renderer | marked v18 never creates a `link` token for spaced hrefs; renderer never fires | Use an inline extension with `start(src) { return src.indexOf('['); }` to intercept before the built-in tokenizer |
| `return false` from `renderer.link` in marked v18 | Does not reliably fall through to default | Return a full HTML string or avoid overriding |
| `[[https://url]]` skipped by tokenizer | marked produces `[[<a>url</a>]]` — literal brackets visible | Detect URL in `[[…]]` inside the tokenizer and emit a `notepage` token with `href` |
| `data-note-page-title` stripped by DOMPurify | Internal page links lose their metadata after sanitization | Add `ADD_ATTR: ['data-note-page-title']` to `renderMarkdown`'s DOMPurify call |
| Click on note-page link activates edit mode | editor.js has a bubble-phase click listener on the preview that calls `_activateEditor` | Use `{ capture: true }` on the mount element and call `e.stopPropagation()` |
| Individual `addEventListener` on each `<a>` after resolve | Listeners are lost if `resolveNotePageLinks` is called again (re-render) | Use a single capture-mode delegate on the stable `#notePageDesc-mount` element |
| `pushState` without `popstate` listener | Back button changes URL but nothing reopens the note | Add a `popstate` listener that calls `openNoteModal` or `closeNoteModal(true)` |
