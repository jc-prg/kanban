'use strict';

// ---- Character icon constants ----
// All unicode/emoji icons used in the UI. Reference these instead of hardcoding chars.
const ICONS = {
  // Navigation & UI chrome
  menu:         '☰',
  collapse:     '▾',
  expand:       '▸',
  submenuArrow: '›',
  moreOptions:  '⋮',
  dragHandle:   '⠿',

  // Actions
  done:         '✓',
  error:        '✗',
  close:        '✕',
  openLink:     '↗',
  download:     '↓',
  copyCode:     '⧉',
  fullscreen:   '⛶',

  // Properties
  color:        '◉',
  checkbox:     '☐',

  // File types (attachment lists)
  fileImage:    '🖼',
  filePdf:      '📄',
  fileWeb:      '🌐',
  fileGeneric:  '📎',
};

// ---- SVG icon builders ----
// Each function returns an HTML string. Width/height default to the most common
// usage size; pass explicit values when a different size is needed.

// Paper clip — attachments (card badges, note indicators, toggle buttons)
function _svgAttachment(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M10 5.5L5.5 10a3 3 0 0 1-4.2-4.2L7 0.8a2 2 0 0 1 2.8 2.8L4.1 9.3A1 1 0 0 1 2.7 7.9L8 2.5"/></svg>`;
}

// Chain link — URL links (note indicators, toggle buttons)
function _svgLink(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M5 7a2.8 2.8 0 0 0 4 .4l1.4-1.4a2.8 2.8 0 0 0-4-4L5.1 3.3"/><path d="M7 5a2.8 2.8 0 0 0-4-.4L1.6 6a2.8 2.8 0 0 0 4 4L6.9 8.7"/></svg>`;
}

// Folded-corner document — notes sidebar, card-linked-in-notes badge
function _svgNoteDoc(w = 11, h = 14) {
  return `<svg viewBox="0 0 11 14" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1.5h6l3 3.5v8H1z"/><path d="M7 1.5V5h3"/></svg>`;
}

// Stacked rectangles — linked cards from a note page
function _svgLinkedCards(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="0.7" y="3.7" width="7" height="5" rx="1"/><path d="M3.7 3V2.3A1 1 0 0 1 4.7 1.3h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H9.7"/></svg>`;
}

// 2×2 grid — navigate to board overview
function _svgAllBoards(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="0.8"/><rect x="7" y="1" width="4" height="4" rx="0.8"/><rect x="1" y="7" width="4" height="4" rx="0.8"/><rect x="7" y="7" width="4" height="4" rx="0.8"/></svg>`;
}

// Calendar — start / end dates
function _svgDate(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="0.7" y="1.7" width="10.6" height="9.6" rx="1.3"/><line x1="0.7" y1="5" x2="11.3" y2="5"/><line x1="3.5" y1="0.7" x2="3.5" y2="3.3"/><line x1="8.5" y1="0.7" x2="8.5" y2="3.3"/></svg>`;
}

// Flag / flagpole — priority level
function _svgPriority(w = 11, h = 13) {
  return `<svg viewBox="0 0 11 13" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="0.7" x2="2" y2="12.3"/><path d="M2 1.5h7.5l-2.2 2.8 2.2 2.7H2"/></svg>`;
}

// Four circles — color palette / color selection
function _svgColorPalette(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="2.2"/><circle cx="9" cy="3" r="2.2"/><circle cx="3" cy="9" r="2.2"/><circle cx="9" cy="9" r="2.2"/></svg>`;
}

// Circle with i dot — card info / history
function _svgCardInfo(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="5.3"/><line x1="6" y1="5.5" x2="6" y2="8.5"/><circle cx="6" cy="3.5" r="0.5" fill="currentColor" stroke="none"/></svg>`;
}

// Pencil — edit card or note
function _svgEdit(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 1.5 L10.5 3.5 L3.5 10.5 L1 11 L1.5 8.5 Z"/><line x1="7" y1="3" x2="9" y2="5"/></svg>`;
}

// Two overlapping rectangles — duplicate / copy
function _svgDuplicate(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="0.5" width="8.5" height="8.5" rx="1.3"/><rect x="0.5" y="3" width="8.5" height="8.5" rx="1.3" fill="var(--surface)"/></svg>`;
}

// Three lines, last shorter — card has a description
function _svgDescription(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="2.5" x2="11" y2="2.5"/><line x1="1" y1="6" x2="11" y2="6"/><line x1="1" y1="9.5" x2="7" y2="9.5"/></svg>`;
}

// Bent arrow — move card(s) to another column
function _svgMoveTo(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2,3 9,3 9,9"/><polyline points="6.5,6.5 9,9 11.5,6.5"/></svg>`;
}

// Lightning bolt — column automation actions
function _svgActions(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="currentColor" aria-hidden="true"><path d="M7 0.5L2.5 6.5H5.5L5 11.5L9.5 5.5H6.5Z"/></svg>`;
}

// Lined rectangle — note pages list
function _svgNotePages(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="1.5" y="0.7" width="9" height="10.6" rx="1.3"/><line x1="3.5" y1="4" x2="8.5" y2="4"/><line x1="3.5" y1="6.5" x2="8.5" y2="6.5"/><line x1="3.5" y1="9" x2="6.5" y2="9"/></svg>`;
}

// Printer — print card or column
function _svgPrint(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="0.7" width="6" height="2.8" rx="0.8"/><rect x="0.7" y="3" width="10.6" height="5.5" rx="1.3"/><rect x="3" y="6.3" width="6" height="3" rx="0.5"/><circle cx="9" cy="5.5" r="0.6" fill="currentColor" stroke="none"/></svg>`;
}

// Funnel — filter / narrow down a list
function _svgFilter(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 2h9L7 6.5V10L5 10V6.5Z"/></svg>`;
}

// Single circular arrow — sync / refresh
function _svgSync(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 6a4.5 4.5 0 1 1-1.4-3.2"/><path d="M8.7 1.4L9.1 2.8L7.6 2.4"/></svg>`;
}

// Folder — note folders, file system folders
function _svgFolder(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 5h10v5.5a.8.8 0 0 1-.8.8H1.8a.8.8 0 0 1-.8-.8V5z"/><path d="M1 5V3.5a.8.8 0 0 1 .8-.8h2.7L6 5"/></svg>`;
}

// Folder with stem and baseline — network/shared folder (e.g. WebDAV remote)
function _svgNetworkFolder(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 3.5h10v4a.8.8 0 0 1-.8.8H1.8a.8.8 0 0 1-.8-.8V3.5z"/><path d="M1 3.5V2a.8.8 0 0 1 .8-.8h2.7L6 3.5"/><line x1="6" y1="8.3" x2="6" y2="10.5"/><line x1="2.5" y1="10.5" x2="9.5" y2="10.5"/></svg>`;
}

const SVGICONS = {
  attachment:   _svgAttachment,
  link:         _svgLink,
  noteDoc:      _svgNoteDoc,
  linkedCards:  _svgLinkedCards,
  allBoards:    _svgAllBoards,
  date:         _svgDate,
  priority:     _svgPriority,
  colorPalette: _svgColorPalette,
  cardInfo:     _svgCardInfo,
  edit:         _svgEdit,
  duplicate:    _svgDuplicate,
  description:  _svgDescription,
  moveTo:       _svgMoveTo,
  actions:      _svgActions,
  notePages:      _svgNotePages,
  sync:           _svgSync,
  folder:         _svgFolder,
  networkFolder:  _svgNetworkFolder,
  print:          _svgPrint,
  filter:         _svgFilter,
};

// ---- Icon registry (used to render the icon library in settings) ----
const ICON_REGISTRY = [
  // Character icons
  { type: 'char', char: ICONS.done,         name: 'Done',           usage: 'Confirms action; marks card as done' },
  { type: 'char', char: ICONS.error,        name: 'Error',          usage: 'Save error or failed operation' },
  { type: 'char', char: ICONS.close,        name: 'Close / Delete', usage: 'Remove item; close dialog or viewer' },
  { type: 'svg', svg: _svgEdit(16, 16),        name: 'Edit',           usage: 'Open card or note for editing' },
  { type: 'svg', svg: _svgDuplicate(16, 16),   name: 'Duplicate',      usage: 'Create a copy of a card' },
  { type: 'char', char: ICONS.openLink,     name: 'Open link',      usage: 'Open URL in a new browser tab' },
  { type: 'char', char: ICONS.download,     name: 'Download',       usage: 'Download an attachment file' },
  { type: 'char', char: ICONS.fullscreen,   name: 'Full screen',    usage: 'Toggle distraction-free full screen mode in card/note modal' },
  { type: 'svg', svg: _svgMoveTo(16, 16),      name: 'Move to',        usage: 'Move card(s) to another column' },
  { type: 'char', char: ICONS.menu,         name: 'Menu',           usage: 'Open the header dropdown menu' },
  { type: 'svg', svg: _svgDescription(16, 16), name: 'Description',    usage: 'Card has a text description' },
  { type: 'char', char: ICONS.moreOptions,  name: 'More options',   usage: 'Open column context menu' },
  { type: 'char', char: ICONS.dragHandle,   name: 'Drag handle',    usage: 'Grab to reorder columns' },
  { type: 'char', char: ICONS.collapse,     name: 'Collapse',       usage: 'Collapse column or tree item' },
  { type: 'char', char: ICONS.expand,       name: 'Expand',         usage: 'Expand column or tree item' },
  { type: 'char', char: ICONS.color,        name: 'Color picker',   usage: 'Change card or column color' },
  { type: 'svg', svg: _svgActions(16, 16),      name: 'Actions',        usage: 'Column automation triggers' },
  { type: 'char', char: ICONS.submenuArrow, name: 'Submenu arrow',  usage: 'Indicates a nested submenu' },
  { type: 'char', char: ICONS.checkbox,     name: 'Checkbox',       usage: 'Insert task checkbox in description' },
  { type: 'char', char: ICONS.fileImage,    name: 'Image file',     usage: 'Image attachment (jpg, png, gif, …)' },
  { type: 'char', char: ICONS.filePdf,      name: 'PDF file',       usage: 'PDF document attachment' },
  { type: 'char', char: ICONS.fileWeb,      name: 'Web / HTML file',usage: 'HTML or web file attachment' },
  { type: 'char', char: ICONS.fileGeneric,  name: 'Generic file',   usage: 'Any other file attachment type' },
  // SVG icons
  { type: 'svg', svg: _svgAttachment(16, 16),   name: 'Attachment',      usage: 'Card or note has file attachments' },
  { type: 'svg', svg: _svgLink(16, 16),         name: 'Link (chain)',     usage: 'URL link on a note page' },
  { type: 'svg', svg: _svgNoteDoc(12, 15),      name: 'Note / Document',  usage: 'Toggle notes sidebar; card linked to note' },
  { type: 'svg', svg: _svgLinkedCards(16, 16),  name: 'Linked cards',     usage: 'Cards linked from a note page' },
  { type: 'svg', svg: _svgAllBoards(16, 16),    name: 'All boards',       usage: 'Navigate to board overview' },
  { type: 'svg', svg: _svgDate(16, 16),         name: 'Date',             usage: 'Card start / end dates' },
  { type: 'svg', svg: _svgPriority(14, 16),     name: 'Priority',         usage: 'Card priority level (1–5)' },
  { type: 'svg', svg: _svgColorPalette(16, 16), name: 'Color palette',    usage: 'Color selection in card modal' },
  { type: 'svg', svg: _svgCardInfo(16, 16),       name: 'Card info',        usage: 'Card info / history (context menu and card modal)' },
  { type: 'svg', svg: _svgNotePages(16, 16),     name: 'Note pages',       usage: 'Note pages linked to this card' },
  { type: 'svg', svg: _svgSync(16, 16),          name: 'Sync',             usage: 'WebDAV sync status and trigger' },
  { type: 'svg', svg: _svgFolder(16, 16),        name: 'Folder',           usage: 'Folder in the notes tree or file system' },
  { type: 'svg', svg: _svgNetworkFolder(16, 16), name: 'Network folder',   usage: 'Remote folder (WebDAV / shared network location)' },
  { type: 'svg', svg: _svgFilter(16, 16),        name: 'Filter',           usage: 'Filter duplicates in a column' },
  { type: 'svg', svg: _svgPrint(16, 16),         name: 'Print',            usage: 'Print a card or column' },
];

// ---- Render icon library grid ----
function renderIconLibrary() {
  const grid = document.getElementById('iconLibraryGrid');
  if (!grid) return;
  grid.innerHTML = [...ICON_REGISTRY].sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const preview = entry.type === 'char'
      ? `<span class="icon-lib-glyph">${entry.char}</span>`
      : `<span class="icon-lib-svg">${entry.svg}</span>`;
    const badge = entry.type === 'svg' ? '<span class="icon-lib-badge">svg</span>' : '';
    return `<div class="icon-lib-item">
      <span class="icon-lib-preview">${preview}</span>
      <span class="icon-lib-meta">
        <span class="icon-lib-name">${entry.name}${badge}</span>
        <span class="icon-lib-usage">${entry.usage}</span>
      </span>
    </div>`;
  }).join('');
}

// ---- Init: fill [data-icon] placeholders in static HTML ----
function initIcons() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const key = el.dataset.icon;
    const w   = el.dataset.iconW !== undefined ? +el.dataset.iconW : undefined;
    const h   = el.dataset.iconH !== undefined ? +el.dataset.iconH : undefined;
    if (key in ICONS) {
      el.textContent = ICONS[key];
    } else if (key in SVGICONS) {
      el.innerHTML = SVGICONS[key](w, h);
    }
  });
}
document.addEventListener('DOMContentLoaded', initIcons);
