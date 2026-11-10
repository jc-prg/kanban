'use strict';

// ---- Character icon constants ----
// All unicode/emoji icons used in the UI. Reference these instead of hardcoding chars.
const ICONS = {
  // Navigation & UI chrome
  collapse:     '▾',
  expand:       '▸',
  submenuArrow: '›',

  // Actions
  done:         '✓',
  error:        '✗',

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
function _svgSettings(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="6" cy="6" r="3.4"/><circle cx="6" cy="6" r="1.3"/><g stroke-width="1.9" stroke-linecap="butt"><line x1="9.30" y1="6.00" x2="11.10" y2="6.00"/><line x1="8.33" y1="8.33" x2="9.61" y2="9.61"/><line x1="6.00" y1="9.30" x2="6.00" y2="11.10"/><line x1="3.67" y1="8.33" x2="2.39" y2="9.61"/><line x1="2.70" y1="6.00" x2="0.90" y2="6.00"/><line x1="3.67" y1="3.67" x2="2.39" y2="2.39"/><line x1="6.00" y1="2.70" x2="6.00" y2="0.90"/><line x1="8.33" y1="3.67" x2="9.61" y2="2.39"/></g></svg>`;
}

function _svgCardInfo(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="5.3"/><line x1="6" y1="5.5" x2="6" y2="8.5"/><circle cx="6" cy="3.5" r="0.5" fill="currentColor" stroke="none"/></svg>`;
}

// Circle with plus — create / new item
function _svgCreate(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="5.3"/><line x1="6" y1="3" x2="6" y2="9"/><line x1="3" y1="6" x2="9" y2="6"/></svg>`;
}

// Pencil — edit card or note
function _svgEdit(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 1.5 L10.5 3.5 L3.5 10.5 L1 11 L1.5 8.5 Z"/><line x1="7" y1="3" x2="9" y2="5"/></svg>`;
}

// Two overlapping rectangles — duplicate / copy / copy code
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

// Three vertical columns — dashboard view
function _svgDashboard(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.7" y="0.7" width="3" height="10.6" rx="1"/><rect x="4.5" y="0.7" width="3" height="10.6" rx="1"/><rect x="8.3" y="0.7" width="3" height="10.6" rx="1"/></svg>`;
}

// Funnel — filter / narrow down a list
function _svgFilter(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 2h9L7 6.5V10L5 10V6.5Z"/></svg>`;
}

// Magnifying glass — show / hide a search field
function _svgSearch(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="5" r="3.5"/><line x1="7.6" y1="7.6" x2="10.8" y2="10.8"/></svg>`;
}

// Two chevrons pointing apart — expand all
function _svgExpandAll(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5 6 1.5 9 4.5M3 7.5 6 10.5 9 7.5"/></svg>`;
}

// Two chevrons pointing together — collapse all
function _svgCollapseAll(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 1.5 6 4.5 9 1.5M3 10.5 6 7.5 9 10.5"/></svg>`;
}

// Landscape rounded rectangle with a single headline — kanban card
function _svgCard(w = 14, h = 10) {
  return `<svg viewBox="0 0 14 10" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.7" y="0.7" width="12.6" height="8.6" rx="1.3"/><line x1="2.5" y1="3.5" x2="9" y2="3.5"/></svg>`;
}

// Single circular arrow — sync / refresh
function _svgSync(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 6a4.5 4.5 0 1 1-1.4-3.2"/><path d="M8.7 1.4L9.1 2.8L7.6 2.4"/></svg>`;
}

// Folder — note folders, file system folders
function _svgFolder(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 5h10v5.5a.8.8 0 0 1-.8.8H1.8a.8.8 0 0 1-.8-.8V5z"/><path d="M1 5V3.5a.8.8 0 0 1 .8-.8h2.7L6 5"/></svg>`;
}

// Four corner brackets — fullscreen / expand to fill
function _svgFullscreen(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4.5V1H4.5"/><path d="M7.5 1H11V4.5"/><path d="M11 7.5V11H7.5"/><path d="M4.5 11H1V7.5"/></svg>`;
}

// Empty square — insert task checkbox in description
function _svgCheckbox(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.7" y="0.7" width="10.6" height="10.6" rx="1.8"/></svg>`;
}

// Square with checkmark — task progress badge on cards
function _svgCheckedBox(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.7" y="0.7" width="10.6" height="10.6" rx="1.8"/><polyline points="2.8,6.2 4.8,8.2 9.2,3.8"/></svg>`;
}

// Three vertical dots — more options / context menu
function _svgMoreOptions(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="currentColor" aria-hidden="true"><circle cx="6" cy="2.5" r="1.2"/><circle cx="6" cy="6" r="1.2"/><circle cx="6" cy="9.5" r="1.2"/></svg>`;
}

// Floppy disk — save
function _svgSave(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.7" y="0.7" width="10.6" height="10.6" rx="1.3"/><rect x="3" y="0.7" width="4.5" height="3.3"/><rect x="2.5" y="6.5" width="7" height="3.5" rx="0.5"/></svg>`;
}

// Upward arrow with baseline — upload file
function _svgUpload(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="8" x2="6" y2="1"/><polyline points="3,3.5 6,1 9,3.5"/><line x1="2" y1="11" x2="10" y2="11"/></svg>`;
}

// Diagonal X — close dialog or dismiss viewer
function _svgClose(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
}

// Trash can — delete item, attachment, or card
function _svgDelete(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="1" y1="3.5" x2="11" y2="3.5"/><path d="M4.5 3.5V2.2h3V3.5"/><path d="M2.2 3.5L2.8 10.5H9.2L9.8 3.5"/><line x1="5" y1="5.5" x2="5" y2="9"/><line x1="7" y1="5.5" x2="7" y2="9"/></svg>`;
}

// Ring with inner dot (bullseye) — change card or column color
function _svgColor(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="6" cy="6" r="5.3"/><circle cx="6" cy="6" r="2" fill="currentColor" stroke="none"/></svg>`;
}

// Landscape frame with mountain and sun — image file attachment
function _svgFileImage(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.7" y="1.7" width="10.6" height="8.6" rx="1.3"/><polyline points="0.7,7.5 3.5,4.5 6.5,7 8.5,5 11.3,7.5"/><circle cx="3.8" cy="4.3" r="1" fill="currentColor" stroke="none"/></svg>`;
}

// Folded document with dense lines — PDF file attachment
function _svgFilePdf(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1.5h6.5l3 3v6.5H1z"/><path d="M7.5 1.5V4.5h3"/><line x1="2.5" y1="6.5" x2="8.5" y2="6.5"/><line x1="2.5" y1="8.5" x2="8.5" y2="8.5"/><line x1="2.5" y1="10.5" x2="6.5" y2="10.5"/></svg>`;
}

// Angle brackets with slash — HTML / web file attachment
function _svgFileWeb(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4,3 1.5,6 4,9"/><polyline points="8,3 10.5,6 8,9"/><line x1="6.5" y1="2" x2="5.5" y2="10"/></svg>`;
}

// Downward arrow with baseline — download file
function _svgDownload(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="1" x2="6" y2="8"/><polyline points="3,5.5 6,8.5 9,5.5"/><line x1="2" y1="11" x2="10" y2="11"/></svg>`;
}

// 2×3 dot grid — drag handle for reordering
function _svgDragHandle(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="currentColor" aria-hidden="true"><circle cx="4" cy="3" r="1"/><circle cx="8" cy="3" r="1"/><circle cx="4" cy="6" r="1"/><circle cx="8" cy="6" r="1"/><circle cx="4" cy="9" r="1"/><circle cx="8" cy="9" r="1"/></svg>`;
}

// Three horizontal lines — hamburger / header menu
function _svgMenu(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="1.5" y1="3" x2="10.5" y2="3"/><line x1="1.5" y1="6" x2="10.5" y2="6"/><line x1="1.5" y1="9" x2="10.5" y2="9"/></svg>`;
}

// Envelope — email / mail account
function _svgEmail(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.7" y="2.5" width="10.6" height="7.5" rx="1.2"/><polyline points="0.7,2.5 6,7 11.3,2.5"/></svg>`;
}

// Arrow curving back to the left — reply to a mail
function _svgReply(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4.5,2.5 1.5,5.5 4.5,8.5"/><path d="M1.5 5.5h5.5a3.5 3.5 0 0 1 3.5 3.5v1"/></svg>`;
}

// Double arrow curving back to the left — reply to all recipients
function _svgReplyAll(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4,2.5 1,5.5 4,8.5"/><polyline points="6.5,2.5 3.5,5.5 6.5,8.5"/><path d="M3.5 5.5h4a3.5 3.5 0 0 1 3.5 3.5v1"/></svg>`;
}

// Arrow curving to the right — forward a mail
function _svgForward(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7.5,2.5 10.5,5.5 7.5,8.5"/><path d="M10.5 5.5H5a3.5 3.5 0 0 0-3.5 3.5v1"/></svg>`;
}

// Opened envelope — mark a mail as read
function _svgMarkRead(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M0.9 5L6 1.5 11.1 5v5.3a.8.8 0 0 1-.8.8H1.7a.8.8 0 0 1-.8-.8z"/><polyline points="0.9,5 6,8.4 11.1,5"/></svg>`;
}

// Closed envelope with a filled dot — mark a mail as unread
function _svgMarkUnread(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0.7" y="3" width="9.6" height="7" rx="1.1"/><polyline points="0.7,3 5.5,7 10.3,3"/><circle cx="10" cy="2.6" r="1.7" fill="currentColor" stroke="none"/></svg>`;
}

// Arrow leaving a box — open external link in a new tab
function _svgOpenLink(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 1.5H2.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V7"/><path d="M7.5 1.5h3v3"/><line x1="5.5" y1="6.5" x2="10.5" y2="1.5"/></svg>`;
}

// Folder with stem and baseline — network/shared folder (e.g. WebDAV remote)
function _svgNetworkFolder(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 3.5h10v4a.8.8 0 0 1-.8.8H1.8a.8.8 0 0 1-.8-.8V3.5z"/><path d="M1 3.5V2a.8.8 0 0 1 .8-.8h2.7L6 3.5"/><line x1="6" y1="8.3" x2="6" y2="10.5"/><line x1="2.5" y1="10.5" x2="9.5" y2="10.5"/></svg>`;
}

// Clock — scheduled cards feature
function _svgSchedule(w = 14, h = 14) {
  return `<svg viewBox="0 0 16 16" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke-width="1.5"/><line x1="8" y1="2" x2="8" y2="3.2" stroke-width="1.5"/><polyline points="8,5 8,8.5 11.5,8.5" stroke-width="1.6"/><circle cx="8" cy="8" r="0.8" fill="currentColor" stroke="none"/></svg>`;
}

// Shield with exclamation mark — blocked mail tracking elements
function _svgShield(w = 14, h = 14) {
  return `<svg viewBox="0 0 16 16" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5 2.5 3.5v4c0 3.3 2.3 5.9 5.5 7 3.2-1.1 5.5-3.7 5.5-7v-4z" stroke-width="1.4"/><line x1="8" y1="5" x2="8" y2="8.6" stroke-width="1.6"/><circle cx="8" cy="10.9" r="0.85" fill="currentColor" stroke="none"/></svg>`;
}

// Shield with check mark — trusted mail sender (remote images allowed)
function _svgShieldCheck(w = 14, h = 14) {
  return `<svg viewBox="0 0 16 16" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5 2.5 3.5v4c0 3.3 2.3 5.9 5.5 7 3.2-1.1 5.5-3.7 5.5-7v-4z" stroke-width="1.4"/><polyline points="5.4,8.1 7.3,10 10.7,6.3" stroke-width="1.6"/></svg>`;
}

// Calendar page with a filled day — the "Today" page
function _svgToday(w = 12, h = 12) {
  return `<svg viewBox="0 0 12 12" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="0.7" y="1.7" width="10.6" height="9.6" rx="1.3"/><line x1="3.5" y1="0.7" x2="3.5" y2="3.3"/><line x1="8.5" y1="0.7" x2="8.5" y2="3.3"/><rect x="3.6" y="5.4" width="4.8" height="3.6" rx="0.6" fill="currentColor" stroke="none"/></svg>`;
}

// ---- Weather (Today page) — 24×24, drawn with currentColor ----
const _WX_CLOUD = 'M7 18.5h10a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-10-.6A3.9 3.9 0 0 0 7 18.5z';
function _wxSvg(w, h, body) {
  return `<svg viewBox="0 0 24 24" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
function _svgWxSun(w = 24, h = 24) {
  return _wxSvg(w, h, '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>');
}
function _svgWxMoon(w = 24, h = 24) {
  return _wxSvg(w, h, '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>');
}
function _svgWxPartly(w = 24, h = 24) {
  return _wxSvg(w, h, '<circle cx="8.5" cy="8.5" r="3.2"/><path d="M8.5 2v1.4M2 8.5h1.4M3.9 3.9l1 1M13.1 3.9l-1 1"/><path d="M9 19.5h8.5a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.8-.4A3.4 3.4 0 0 0 9 19.5z" fill="var(--wx-fill, transparent)"/>');
}
function _svgWxCloud(w = 24, h = 24) {
  return _wxSvg(w, h, `<path d="${_WX_CLOUD}"/>`);
}
function _svgWxRain(w = 24, h = 24) {
  return _wxSvg(w, h, '<path d="M7 15h10a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-10-.6A3.9 3.9 0 0 0 7 15z"/><path d="M8.5 17.5l-1 2.5M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5"/>');
}
function _svgWxSnow(w = 24, h = 24) {
  return _wxSvg(w, h, '<path d="M7 15h10a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-10-.6A3.9 3.9 0 0 0 7 15z"/><path d="M8 18.5h.01M12 20h.01M16 18.5h.01M10 21.5h.01M14 21.5h.01" stroke-width="2.2"/>');
}
function _svgWxThunder(w = 24, h = 24) {
  return _wxSvg(w, h, '<path d="M7 15h10a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-10-.6A3.9 3.9 0 0 0 7 15z"/><path d="M12.5 15.5l-2 3.5h3l-2 3.5"/>');
}
function _svgWxFog(w = 24, h = 24) {
  return _wxSvg(w, h, '<path d="M7 13h10a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-10-.6A3.9 3.9 0 0 0 7 13z"/><path d="M4 16.5h16M6 19.5h12"/>');
}

const SVGICONS = {
  close:          _svgClose,
  shield:         _svgShield,
  shieldCheck:    _svgShieldCheck,
  delete:         _svgDelete,
  color:          _svgColor,
  fileImage:      _svgFileImage,
  filePdf:        _svgFilePdf,
  fileWeb:        _svgFileWeb,
  fileGeneric:    _svgAttachment,
  fullscreen:     _svgFullscreen,
  checkbox:       _svgCheckbox,
  checkedBox:     _svgCheckedBox,
  moreOptions:    _svgMoreOptions,
  save:           _svgSave,
  upload:         _svgUpload,
  download:       _svgDownload,
  dragHandle:     _svgDragHandle,
  menu:           _svgMenu,
  email:          _svgEmail,
  reply:          _svgReply,
  replyAll:       _svgReplyAll,
  forward:        _svgForward,
  markRead:       _svgMarkRead,
  markUnread:     _svgMarkUnread,
  attachment:   _svgAttachment,
  link:         _svgLink,
  noteDoc:      _svgNoteDoc,
  linkedCards:  _svgLinkedCards,
  allBoards:    _svgAllBoards,
  date:         _svgDate,
  priority:     _svgPriority,
  colorPalette: _svgColorPalette,
  cardInfo:     _svgCardInfo,
  settings:     _svgSettings,
  create:       _svgCreate,
  edit:         _svgEdit,
  duplicate:    _svgDuplicate,
  description:  _svgDescription,
  moveTo:       _svgMoveTo,
  actions:      _svgActions,
  notePages:      _svgNotePages,
  card:           _svgCard,
  sync:           _svgSync,
  folder:         _svgFolder,
  networkFolder:  _svgNetworkFolder,
  print:          _svgPrint,
  filter:         _svgFilter,
  dashboard:      _svgDashboard,
  openLink:       _svgOpenLink,
  schedule:       _svgSchedule,
  today:          _svgToday,
  search:         _svgSearch,
  expandAll:      _svgExpandAll,
  collapseAll:    _svgCollapseAll,
  wxSun:          _svgWxSun,
  wxMoon:         _svgWxMoon,
  wxPartly:       _svgWxPartly,
  wxCloud:        _svgWxCloud,
  wxRain:         _svgWxRain,
  wxSnow:         _svgWxSnow,
  wxThunder:      _svgWxThunder,
  wxFog:          _svgWxFog,
};

// ---- Icon registry (used to render the icon library in settings) ----
const ICON_REGISTRY = [
  // Character icons
  { type: 'char', char: ICONS.done,         name: 'Done',           usage: 'Confirms action; marks card as done' },
  { type: 'char', char: ICONS.error,        name: 'Error',          usage: 'Save error or failed operation' },
  { type: 'svg', svg: _svgCheckedBox(16, 16),  name: 'CheckedBox',     usage: 'Checkbox progress badge on cards' },
  { type: 'svg', svg: _svgClose(16, 16),       name: 'Close',          usage: 'Close a dialog or attachment viewer' },
  { type: 'svg', svg: _svgDelete(16, 16),      name: 'Delete',         usage: 'Delete item, attachment, card, or column' },
  { type: 'svg', svg: _svgCreate(16, 16),      name: 'Create / New',   usage: 'Create a new item (event, card, etc.)' },
  { type: 'svg', svg: _svgEdit(16, 16),        name: 'Edit',           usage: 'Open card or note for editing' },
  { type: 'svg', svg: _svgDuplicate(16, 16),   name: 'Duplicate / Copy', usage: 'Duplicate a card; copy code block to clipboard' },
  { type: 'svg', svg: _svgOpenLink(16, 16),    name: 'Open link',      usage: 'Open URL in a new browser tab' },
  { type: 'svg', svg: _svgDownload(16, 16),    name: 'Download',       usage: 'Download an attachment file' },
  { type: 'svg', svg: _svgUpload(16, 16),      name: 'Upload',         usage: 'Upload a file attachment' },
  { type: 'svg', svg: _svgSave(16, 16),        name: 'Save',           usage: 'Save changes' },
  { type: 'svg', svg: _svgFullscreen(16, 16),  name: 'Full screen',    usage: 'Toggle distraction-free full screen mode in card/note modal' },
  { type: 'svg', svg: _svgMoveTo(16, 16),      name: 'Move to',        usage: 'Move card(s) to another column' },
  { type: 'svg', svg: _svgMenu(16, 16),        name: 'Menu',           usage: 'Open the header dropdown menu' },
  { type: 'svg', svg: _svgSettings(16, 16),    name: 'Settings',       usage: 'Open calendar account settings from the calendar view legend' },
  { type: 'svg', svg: _svgDescription(16, 16), name: 'Description',    usage: 'Card has a text description' },
  { type: 'svg', svg: _svgMoreOptions(16, 16), name: 'More options',   usage: 'Open column context menu' },
  { type: 'svg', svg: _svgDragHandle(16, 16),  name: 'Drag handle',    usage: 'Grab to reorder columns' },
  { type: 'char', char: ICONS.collapse,     name: 'Collapse',       usage: 'Collapse column or tree item' },
  { type: 'char', char: ICONS.expand,       name: 'Expand',         usage: 'Expand column or tree item' },
  { type: 'svg', svg: _svgColor(16, 16),       name: 'Color picker',   usage: 'Change card or column color' },
  { type: 'svg', svg: _svgActions(16, 16),      name: 'Actions',        usage: 'Column automation triggers' },
  { type: 'char', char: ICONS.submenuArrow, name: 'Submenu arrow',  usage: 'Indicates a nested submenu' },
  { type: 'svg', svg: _svgCheckbox(16, 16),    name: 'Checkbox',       usage: 'Insert task checkbox in description' },
  { type: 'svg', svg: _svgFileImage(16, 16),   name: 'Image file',     usage: 'Image attachment (jpg, png, gif, …)' },
  { type: 'svg', svg: _svgFilePdf(16, 16),     name: 'PDF file',       usage: 'PDF document attachment' },
  { type: 'svg', svg: _svgFileWeb(16, 16),     name: 'Web / HTML file',usage: 'HTML or web file attachment' },
  { type: 'svg', svg: _svgAttachment(16, 16),  name: 'Generic file',   usage: 'Any other file attachment type' },
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
  { type: 'svg', svg: _svgCard(16, 11),          name: 'Card',             usage: 'Kanban card type indicator (e.g. last-edited list)' },
  { type: 'svg', svg: _svgSync(16, 16),          name: 'Sync',             usage: 'WebDAV sync status and trigger' },
  { type: 'svg', svg: _svgFolder(16, 16),        name: 'Folder',           usage: 'Folder in the notes tree or file system' },
  { type: 'svg', svg: _svgNetworkFolder(16, 16), name: 'Network folder',   usage: 'Remote folder (WebDAV / shared network location)' },
  { type: 'svg', svg: _svgFilter(16, 16),        name: 'Filter',           usage: 'Filter duplicates in a column' },
  { type: 'svg', svg: _svgPrint(16, 16),         name: 'Print',            usage: 'Print a card or column' },
  { type: 'svg', svg: _svgDashboard(16, 16),    name: 'Dashboard',        usage: 'Navigate to the dashboard view' },
  { type: 'svg', svg: _svgToday(16, 16),        name: 'Today',            usage: 'Navigate to the Today page' },
  { type: 'svg', svg: _svgSearch(16, 16),       name: 'Search',           usage: 'Show / hide the filter field of the Today Notes tile' },
  { type: 'svg', svg: _svgExpandAll(16, 16),    name: 'ExpandAll',        usage: 'Open all folders (Today Notes tile)' },
  { type: 'svg', svg: _svgCollapseAll(16, 16),  name: 'CollapseAll',      usage: 'Collapse all folders (Today Notes tile)' },
  { type: 'svg', svg: _svgWxSun(16, 16),        name: 'Weather: clear',   usage: 'Today page weather (clear sky, day)' },
  { type: 'svg', svg: _svgWxMoon(16, 16),       name: 'Weather: night',   usage: 'Today page weather (clear sky, night)' },
  { type: 'svg', svg: _svgWxPartly(16, 16),     name: 'Weather: partly cloudy', usage: 'Today page weather' },
  { type: 'svg', svg: _svgWxCloud(16, 16),      name: 'Weather: cloudy',  usage: 'Today page weather' },
  { type: 'svg', svg: _svgWxRain(16, 16),       name: 'Weather: rain',    usage: 'Today page weather (drizzle, rain, showers)' },
  { type: 'svg', svg: _svgWxSnow(16, 16),       name: 'Weather: snow',    usage: 'Today page weather' },
  { type: 'svg', svg: _svgWxThunder(16, 16),    name: 'Weather: thunder', usage: 'Today page weather' },
  { type: 'svg', svg: _svgWxFog(16, 16),        name: 'Weather: fog',     usage: 'Today page weather' },
  { type: 'svg', svg: _svgEmail(16, 16),        name: 'Email',            usage: 'Mail account / email message' },
  { type: 'svg', svg: _svgReply(16, 16),        name: 'Reply',            usage: 'Reply to a mail (mail view)' },
  { type: 'svg', svg: _svgReplyAll(16, 16),     name: 'Reply all',        usage: 'Reply to all recipients of a mail (mail view)' },
  { type: 'svg', svg: _svgForward(16, 16),      name: 'Forward',          usage: 'Forward a mail (mail view)' },
  { type: 'svg', svg: _svgMarkRead(16, 16),     name: 'Mark read',        usage: 'Mark a mail as read (mail view)' },
  { type: 'svg', svg: _svgMarkUnread(16, 16),   name: 'Mark unread',      usage: 'Mark a mail as unread (mail view)' },
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

// ---- Update a single [data-icon] element dynamically ----
function setIcon(el, key) {
  el.dataset.icon = key;
  if (key in ICONS)         el.textContent = ICONS[key];
  else if (key in SVGICONS) el.innerHTML   = SVGICONS[key]();
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
