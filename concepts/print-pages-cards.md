# Print View — Cards and Note Pages

## Goal

Allow a single card or a single note page to be printed cleanly: title and description (rendered as Markdown) as the main body, all remaining metadata in a compact footer. Multiple items (e.g. all cards in a column) print on separate pages.

---

## Approach — `@media print` with a dedicated print root

A hidden `<div id="print-root">` sits in `index.html` alongside the main `#app` wrapper. A `@media print` rule in `print.css` hides `#app` and makes `#print-root` the only visible element. When a print is triggered:

1. Generate the print HTML and inject it into `#print-root`.
2. Call `window.print()`.
3. Clear `#print-root` in the `window.onafterprint` callback.

This avoids pop-up windows and keeps all existing CSS (e.g. the markdown styles in `markdown.css`) naturally available to the print output.

### Why not a new window?

`window.open()` requires an extra user gesture allowance and cannot reuse existing vendor libraries (marked, DOMPurify) or CSS files without duplicating them. The `@media print` approach is lighter and more reliable.

---

## Trigger points

| Where | Action | Prints |
|---|---|---|
| Card edit modal footer | "Print" button | The single open card |
| Note modal toolbar | "Print" button | The single open note page |
| Column context menu | "Print column" | All cards in the column, one per page |

The column print is optional for a first iteration; the single-item triggers are the primary goal.

---

## Print layout — Card

```
┌─────────────────────────────────────────────────────────────┐
│  Board: my-board                          Column: Done       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Card title                                                 │
│                                                             │
│  [rendered markdown description]                            │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Priority: P2   Created: 2024-01-10   Done: 2024-01-21     │
│  Start: 2024-01-05 → End: 2024-01-20                       │
│  Link: https://example.com                                  │
│  ID: id-abc123                                              │
└─────────────────────────────────────────────────────────────┘
```

**Footer fields (only shown when the field has a value):**

| Field | Source |
|---|---|
| Priority | `card.priority` → label "P1"–"P5" |
| Created | `card.created` |
| Done / Done at | `card.done`, `card.doneAt` |
| Start → End | `card.startDate`, `card.endDate` |
| Link | `card.link` |
| ID | `card.id` |

Column name comes from the `state.columns` array (the column that contains this card). Board name from the URL path segment.

---

## Print layout — Note page

```
┌─────────────────────────────────────────────────────────────┐
│  Board: my-board          Research › Web APIs               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Page title                                                 │
│                                                             │
│  [rendered markdown description]                            │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Last modified: 2024-01-15                                  │
│  Link: https://example.com                                  │
│  Linked cards: "Card A", "Card B"                           │
│  Attachments: document.pdf, image.png                       │
│  ID: n-abc123                                               │
└─────────────────────────────────────────────────────────────┘
```

**Footer fields (only shown when the field has a value):**

| Field | Source |
|---|---|
| Last modified | `page.lastModified` formatted as local date |
| Link | `page.link` |
| Linked cards | `page.linkedCards` → card titles resolved from `state` |
| Attachments | fetched from `GET /api/:board/notes/attachments/:pageId` — file names only |
| ID | `page.id` |

Folder path (breadcrumb) is built with `getNotePath()` which already exists in `notes.js`.

---

## Multi-card (column) print

Each card becomes a `.print-item` block. Between items add `break-after: page` so they land on separate sheets. The column header prints once as a leading page title or as a repeated header using CSS `@page` named pages (simpler: just render it as the first block above the cards).

---

## Files to change

### New: `app/frontend/styles/print.css`

```css
/* Loaded unconditionally; all rules are inside @media print */
@media print {
  /* Hide everything except the print root */
  body > *:not(#print-root) { display: none !important; }
  #print-root { display: block; }

  /* One item per page */
  .print-item + .print-item { break-before: page; }

  /* Layout */
  .print-header { ... }   /* board + column/path line */
  .print-title  { ... }   /* h1-level card/page title */
  .print-body   { ... }   /* markdown area */
  .print-footer { ... }   /* metadata rows */
  .print-footer-row { ... }
}

/* Screen: hide the print root entirely */
#print-root { display: none; }
```

Markdown styles from `markdown.css` are already global and apply inside `#print-root` without changes.

### `app/frontend/index.html`

1. Add `<link rel="stylesheet" href="styles/print.css">` in `<head>`.
2. Add `<div id="print-root"></div>` just before `</body>`.

### `app/frontend/cards.js`

Add `printCard(card)`:

```js
function printCard(card) {
  const col = state.columns.find(c => c.cards.some(x => x.id === card.id));
  const board = location.pathname.replace(/^\//, '') || 'kanban';
  // build footer rows from card fields
  // inject HTML into #print-root
  // window.print()
  // window.onafterprint = () => { document.getElementById('print-root').innerHTML = ''; };
}
```

Add a "Print" `<button>` in the card edit modal footer (alongside the existing Cancel/Save buttons). The button is only visible when `modalMode === 'edit'` (a new card has no data worth printing). Call `printCard(state.columns.flatMap(c=>c.cards).find(c=>c.id===editCardId))`.

### `app/frontend/notes.js`

Add `printNote(pageId)`:

```js
async function printNote(pageId) {
  const page = findNotePage(pageId, notesState.items);
  const path = getNotePath(pageId, notesState.items);
  // resolve linkedCards to titles from state
  // optionally fetch attachment list via NOTES_ATTACH_API
  // build and inject HTML into #print-root
  // window.print()
  // window.onafterprint cleanup
}
```

Add a "Print" button to the note modal toolbar row (same row as the delete button at the bottom, or as an icon button in the header area).

### `app/frontend/menus.js` (optional, column print)

In the column context menu builder, add a "Print column" item that calls `printColumn(colId)` — a function that iterates `col.cards` and builds one `.print-item` per card.

---

## Edge cases

| Case | Handling |
|---|---|
| No description | Print only the title + footer; skip the markdown body area |
| Very long description | Browser's native pagination handles page breaks; no special treatment needed |
| Card color | Omit background color in print (ink-saving); keep priority label text only |
| Attachment list fetch fails | Show "attachments: (unavailable)" in footer; don't block print |
| Note page with no linked cards in current state (card deleted) | Show card ID in italic with "(removed)" label |
| `lastModified` absent on old notes | Omit the field from footer |
| Printing while modal is open | `#print-root` is injected then `window.print()` is called; the modal itself is hidden by the `@media print` rule because it is a child of `body` but not `#print-root` |

---

## Non-goals

- Printing an entire board or all note pages at once (out of scope for this iteration).
- PDF export — the browser's native "Save as PDF" from the print dialog covers this for free.
- Custom page headers/footers via `@page` — browser defaults (URL, date, page number) are acceptable.
