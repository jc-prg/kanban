# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Single-user application.** There is no per-board or per-user access control. One valid session token or API key grants full access to all boards. Do not add multi-user features without first implementing per-board authorization.

## Commands

```bash
cd app
npm install        # install dependencies
npm start          # start server at http://localhost:3000
node backend/server.js  # equivalent to npm start
```

Or via Docker (from project root):
```bash
docker compose up -d --build
```

The `kanban` container only mounts `./data`; all code (backend, `app/frontend/`, `app/notes-webdav/`) is baked into the image. After any code change, rebuild (`docker compose up -d --build kanban`) — otherwise the running app keeps the old frontend, or the frontend calls routes the running backend does not know (plain `HTTP 404`).

No build step, no linter. Tests: `npm test` (Vitest, unit + API) and `npm run test:e2e` (Playwright, requires running server).

## Architecture

Single-page kanban board with a minimal three-layer design:

- **`app/backend/`** — Express 5 backend. Serves `public/` as static files and exposes REST endpoints for auth, board management, and card operations. Persists all data in CouchDB (one `jc-kanban-<name>` database per board, single `board` document each). Uses `nano` as the CouchDB client.
- **`app/frontend/index.html`** — Markup and modal HTML only. References the CSS and JS files below.

### Backend (`app/backend/`)

| File | Contents |
|---|---|
| `server.js` | Entry point — middleware, mount routers, startup (`initDb`, backup intervals) |
| `config.js` | All env vars and derived constants (`PORT`, `BACKUP_DIR`, `DB_PREFIX`, …) |
| `db.js` | CouchDB connection (`initDb`), `getBoardDb`, board/notes CRUD helpers, `withBoard`/`withExistingBoard` wrappers |
| `auth.js` | `safeEqual`, rate-limiting maps, `parseCookies`, `authenticate` middleware, `writeRateLimit`/`uploadRateLimit` |
| `charset.js` | Text from other servers: `decodeText(buf, charset)` (declared charset via `TextDecoder`; UTF-8 — declared or not — checked, invalid bytes decoded as windows-1252 instead of U+FFFD), `charsetFromContentType`, `responseText(res)` (fetch body by its Content-Type charset). Used for mail body parts (`_decodePart` in `dashboard/mail.js`: transfer decoding to bytes, then the part's `charset` parameter, for HTML else its `<meta charset>`) and calendar responses (`dashboard/calendar.js`) |
| `schemas.js` | AJV instance, all `validate*` compiled schemas, `schemaError` |
| `backup.js` | `runBackup`, `runPromptsBackup`, `checkDataDirectories`, `refreshDbSize`/`getDbSizeBytes` |
| `routes/auth.js` | `POST /api/auth`, `GET /api/auth/verify`, `POST /api/auth/logout` |
| `routes/prompts.js` | `GET /api/settings`, `GET/PUT /api/prompts` |
| `routes/appearance.js` | `GET/PUT /api/appearance` — app skin (`SKINS`: `default`, `glass`), doc `appearance` in `jc-config-dashboard` (`getAppearance` / `saveAppearance` in `global-db.js`) |
| `routes/boards.js` | `GET /api/boards`, achievements, board create/rename/delete |
| `routes/board.js` | All `/:board/board`, `all-columns`, `column`, `card`, `move-to`, `import` |
| `routes/notes.js` | All `/:board/notes*` including ZIP export |
| `routes/attachments.js` | All notes/card attachment routes + `GET /api/db-size` |
| `routes/dashboard.js` | All `/api/dashboard/*` routes (config, data, mail, calendar) |
| `routes/today.js` | `/api/today/*` — Today page config (layouts per breakpoint, widget settings; CV-App key stripped / preserved like mail passwords) and the widget-provider registry `PROVIDERS` (`GET /today/widgets/:id`) |
| `routes/stickies.js` | `/api/stickies` — Stickies widget CRUD (`GET` list newest first + categories, `POST`, `PUT /:id` partial, `DELETE /:id`), categories (`POST /categories`, `DELETE /categories/:id` — `loadCategories`, `categoryIdFor`), Markdown `GET /export` / `POST /import` (`stickies-md.js`); one doc per sticky in `jc-config-stickies` (`listStickies` — ids `s-…` only / `getSticky` / `saveSticky` / `deleteSticky` in `global-db.js`) plus the doc `categories` `{ list: [{ id, label }] }` (`getStickyCategories` / `saveStickyCategories`; none = the defaults `STICKY_CATEGORIES`), validated by `validateStickyCreate` / `validateStickyUpdate` (`schemas.js`, `STICKY_CATEGORY_ID`, `STICKY_ID`; the route checks that the category exists); `STICKY_COLORS` = palette for the random default colour (same list as `_STK_COLORS` in `today-stickies.js`); backed up to `BACKUP_DIR/stickies.json` + `stickies-categories.json` (`runStickiesBackup`) |
| `stickies-md.js` | Stickies ⇄ Markdown, pure: `stickiesToMarkdown(items, categories)` (`## Label` + `<!-- category: id -->` per category, each sticky between `<!-- sticky: {json meta} -->` and `<!-- /sticky -->`, `<` / `>` escaped in the JSON, a text line equal to the end marker gets a zero-width space), `parseStickiesMarkdown(md)` (also hand-written files: `##` headings, stickies separated by `---` lines, text before the first heading → first category) |
| `today/defaults.js` | Default Today layouts (`xl`, `lg`, `sm`; `md` derived) |
| `today/quickaccess.js` | Quick access icons — `discoverIcons` (page `<link rel=icon / apple-touch-icon>` + web app manifest + `/apple-touch-icon.png`, `/favicon.ico`; regex-parsed, ranked by size: large raster app icons > SVG (`SVG_SCORE` 120, favicon SVGs are tab glyphs) > small favicons; `data:` icons decoded), `fetchIcon` (first candidate that is a real image by magic bytes, ≤ 512 KB), `saveIcon` → `TODAY_ICONS_DIR/qa-<sha1/16>.<ext>` (content-addressed, so the browser caches it forever), `pruneIcons` (unreferenced icons older than 1 h, run after config PUTs with `widgets`) |
| `today/cards.js` | `fetchTodayCards(date)` — overdue / due today / starts today / due tomorrow / due + starting in the next 6 days (`dueWeek`, `startsWeek`) / unread cards across all non-archived boards (`classifyBoardCards`) |
| `today/weather.js` | Open-Meteo forecast (`fetchWeather`, 7 forecast days → `today`, `tomorrow`, `days`, 15-min cache per location) and geocoding (`geocode`) |
| `today/notes.js` | `fetchNoteTrees()` — note trees of all non-archived boards reduced to `{ type, id, title, lastModified?, children? }` (`pruneNoteTree`, no bodies), boards without pages skipped; `webdav` = notes synced with WebDAV (enabled config whose account exists, or legacy inline config — the tile shows a cloud after the board name); `{ boards: [{ board, pages, webdav, items }], total }` |
| `today/search.js` | Search widget sources — `searchCards`, `searchNotes`, `searchEvents` (calendar accounts, today ± 365 days, raw events cached 5 min per account, one hit per UID via `pickOccurrences`: next occurrence, else the latest past one), `searchMail` (→ `searchMailAccount` in `dashboard/mail.js`: every selectable folder, account folder first; IMAP searches the longest word, title mode re-checks all words on subject / from / to / cc; ≤ 20 per folder, 50 per account, 20 s budget → `truncated`), `searchApplications` (raw CV-App list from `fetchApplicationList`). Title mode = card text + column, note title + folder path, event title + location, job title + company; full text adds descriptions / note bodies / links, mail bodies, all CV-App text fields + drafts (never attachments). All words, case- and accent-insensitive (`fold`, `matchesAll`); ≤ 50 items + `total` per source; archived boards and `#` cards skipped |
| `today/cvapp.js` | CV-App applications (`fetchApplicationList`: `GET {apiUrl}/api/applications` with `x-api-key`, raw list cached 5 min — also used by the search; `fetchApplications` summarises it). `summariseApplications` uses the CV-App's definitions: active = Research / Vorbereitung / Versendet / Gespräch / Angebot (counts per status, `active` list most advanced first) plus `recent` (all except Abgebrochen, last updated first); items carry `statusNote`, `progress`, `appliedAt`. The tile shows the counters of the current selection (Active: server `statuses`; Recent: `_todayCvStatusCounts` of the recent list, all statuses) as CV-App status labels (`_TODAY_CV_STATUS` colours) that filter the list by status (click again = all; `localStorage` `today-cvapp-status`, `_todayCvFilterChip`), toggles Active / Recent per browser (`localStorage` `today-cvapp-list`), the send date of Versendet coloured by age (14 / 28 / 42 days) and note + progress behind an (i) button |
| `dashboard/mail.js` | IMAP/SMTP helpers — `fetchMailAccount` (Today overview: `{ messages, flagged, flaggedTotal }`, flagged only with `withFlagged`), Apple Mail flag colours (`flagColor`, `flagChanges`, `flagMailMessage`), `fetchFolderMessages` (paged/search), `fetchMailMessage`, folder CRUD (`listMailFolders`, `createMailFolder`, `renameMailFolder`, `deleteMailFolder`), `sendMail` (nodemailer + IMAP APPEND to the sent folder); every message function takes an optional `folder` |
| `dashboard/calendar.js` | CalDAV/iCal helpers — `fetchCalendarAccount`, `fetchCalendarEvent`, `testCalendarAccount` |

### CSS (`app/frontend/styles/`)

| File | Contents |
|---|---|
| `base.css` | Reset, `:root` design tokens (incl. `--scrollbar` / `--scrollbar-active` — idle thumbs very dark in dark mode; `--page-bg` = Today page + `.board-area`, `--panel-bg` = Today widgets + board columns), `body`, grain overlay, scrollbar |
| `layout.css` | Header, title animation, header menu/dropdown (entries = `.header-dd-icon` + `.header-dd-label` — change a label via its span, never the button's `textContent`), `.btn` variants, save indicator, board wrapper, board-count badges |
| `column.css` | Column, column header, drag handle, collapsed group, col-btn, cards area, add-card/add-column buttons |
| `card.css` | Card, card-body, more-btn, card-text, meta badges, link badge, drop indicator, load-more button |
| `overlay.css` | Safe-area variables `--safe-top/right/bottom/left` on `:root` (`env(safe-area-inset-*)`; tests override them to simulate an iPhone); `.modal-backdrop` is padded by them, so dialogs are centred inside the safe area and full-screen dialogs stop at the status bar / home indicator (the iOS status bar blurs what lies beneath it); dialog heights never use a percentage of the backdrop (WebKit leaves it unresolved — the 95dvh editors then reached up under the status bar): `.modal` max-height `min(90dvh, var(--modal-safe-h))` (`--modal-safe-h` = 100dvh + `--vp-dvh-gap` − safe top / bottom; editors `height: min(95dvh, …)`), full-screen dialogs fill the backdrop via `align-self: stretch`, the backdrop centres with `align-items: safe center` (never above the top); E2E E-T-55. Full-screen panel dialogs (`.modal--fullscreen.panel`) drop the backdrop padding and cover the screen: the header runs under the status bar (statusbar.css), the body / editor keep clear of the home indicator. Context menus, all modals & dialogs (add/edit card, login, confirm, prompts, card-info, settings), priority/color rows. Dialogs in the detail panel format (`.panel-modal`: card / note editors, settings, achievement history): `.panel` box, `.dashboard-detail-titlebar` header along the top edge instead of an `<h2>` (`.panel-modal-bar`), close icon with `data-close-via="<Close button id>"` (clicks that button — `init.js`; the Close buttons themselves stay in the DOM `hidden`); editors (`.edit-modal`) also carry the fullscreen icon, the card dialog's header is tinted with the card colour (`renderColorRow`), field contents sans-serif |
| `notes.css` | Notes sidebar (docked to header, left and bottom edge — not a column: `.panel` / `.panel-hdr` colours without corners, frame line only towards the board), resizer, tree/list, note modal |
| `markdown.css` | Markdown preview pane (card modal + note modal) |
| `dashboard.css` | Overlay host (`#dashboard`), mail / card items, detail modal (card / note layout `.dash-doc-detail`), calendar event dialog (`#calEventModal`, same format as the detail panel: `.panel`, `.dashboard-detail-titlebar` tinted with the calendar colour — `_calModalTint` in `dashboard.js`), settings drag handles, sticky editor in the detail panel (`.stk-detail*`, `.stk-swatch`, `.stk-cat`) |
| `mailview.css` | Mail view — same overlay slot as `calview.css`; folder tree, message list, reader, compose editor (white in dark mode — `.mv-editor` under `prefers-color-scheme: dark`), folder picker; one column at a time on phones (`data-pane`) |
| `today.css` | Today page — dark mode: page lighter (`body.route-today`, `--today-page-bg`, class set in `initToday`), widgets keep `--bg`; calendar / mail view headers in the widget header format and, on small screens, the widgets' edge distance; Today bar, edit bar, column grid (`--today-col-h`; column scrollbars `.today-col` close to the page background (15 % `--scrollbar-active` in `--page-bg`), `--scrollbar-active` while hovered; tile size classes `today-tile--f1/f23/f12/f13/auto/fill`), agenda / attention / widget tiles, Quick access (`.today-qa--s/m/l` set `--today-qa-box` / `--today-qa-w` / `--today-qa-gap`: icon edge + 5 px margin, minimum column width — as many per row as fit — and gap; title below the icon; accent glow (`drop-shadow` on app icons, `box-shadow` on frames); app icons bare (`.today-qa-icon--img`), emoji / letter framed (`--box`); `.today-qa-img--invert` inverts in dark mode), Settings → Dashboard widget rows, `.today-hscroll-btn` (‹ › of `_todayHScroll`, all tiles): 50 % opacity, hover = opaque with accent circle + arrow; Stickies tile (`.today-stk-*`: stack, paper (`--stk-color`, `--stk-tilt` = slot angle, footer category + source — font scales with the paper via container units, `4.352cqw` = 0.68rem at 250 px, drag `--stk-dx` / `--stk-drot`, fly-off `--stk-fly`), slider; papers dimmed in dark mode) |
| `panel.css` | Widget format shared by Today tiles, board columns, the notes sidebar, the dashboard detail panel and the calendar / mail view headers: `.panel` (box: `--panel-bg`, 8 px corners), `.panel-hdr` (header bar + accent-tinted background / bottom line), `.panel-hdr-title` (title colour). `--hdr-accent` = column colour (`--col-color`), detail colour (`--detail-accent`) or `--accent`. Loaded after the component stylesheets — don't re-add header backgrounds / colours there. Also the menu / popup format (`--menu-bg`, `--menu-border`, `--menu-shadow`, `--menu-hover` on `:root`): context menus + submenus (also the calendar burger menu), header dropdown, board switcher, mail sender list, emoji picker, folder pickers, linked-card search results; one item hover (danger items excluded) |
| `skin-glass.css` | Skin "glass" — overrides only, every rule scoped to `:root[data-skin="glass"]`; restyles `.panel` / `.panel-hdr` / `.panel-hdr-title` (plus `#calView` / `#mailView` panels) as coloured glass, header colours via `--hdr-accent`; tunables as `--glass-*` on `:root`; backdrop blur only on Today headers (stacked headers). A new skin = `skin-<id>.css` + id in `SKINS` + option in `#skinOptions` |
| `statusbar.css` | Loaded last. **Every top bar that runs under the iOS status bar** (full-screen detail / editor dialogs, full-screen Stickies tile, attachment viewer, calendar / mail view in full-screen mode): Safari 26 tints the status bar with the fixed top element's background colour and lays a blur over the band and header top when it can't read one solid colour (translucent / gradient backgrounds, `backdrop-filter`, a border on the top edge — the glass skin). So these bars are flat and opaque (`--hdr-bg`: set on `.panel-hdr` in panel.css, flat glass equivalent in skin-glass.css), without filter / box-shadow, content below `--statusbar-band` (safe top + up to 16 px). Centred dialogs: an opaque band above them (`.modal-backdrop::before`). A new full-screen surface adds its top bar here and to E2E E-T-54 |
| `calview.css` | Calendar view — panel covering the dashboard grid (full-screen on phones), week/work-week time grid, all-day row, month grid. Phones (≤ 639 px): `.cv-week` scrolls both ways, `.cv-weektop` (day heads + all-day row) sticky at the top, the hours column and the gutter cells above it sticky at the left (`--cv-sticky-bg`, set by the glass skin) — only the days scroll horizontally; `.cv-edge-offer` |

### JS (`app/frontend/`) — load order matters, no bundler

Vendor libraries loaded first: `marked.min.js` (Markdown → HTML), `purify.min.js` (DOMPurify, XSS sanitisation).

| File | Contents |
|---|---|
| `viewport.js` | Loaded in `<head>` after `skin.js`: iOS Home-Screen app (standalone, `black-translucent`, `viewport-fit=cover`) whose layout viewport ends short of the screen bottom — `_vpGap` (pure: expected screen height − measured height, only iOS standalone, 1–100 px) applied separately to the fixed layer (probe `position: fixed; inset: 0` → `--vp-gap`: full-screen overlays `.modal-backdrop`, phone `.calview` / `.mailview` extend by it) and to `100dvh` (probe → `--vp-dvh-gap`: `body` height) — iOS may already size one of them to the full screen, and a shared gap pushed page / view bottoms off the screen; class `vp-gap` on `<html>`, updated on resize / rotation / pageshow. Page and view bottoms keep clear of the home indicator (`--safe-bottom` in `#today` / `.board-wrapper` phone padding, phone view inset). Keyboard: the on-screen keyboard can leave the standalone viewport shrunk (dark band at the bottom) and the document scrolled — after an editable field loses focus (`focusout`, `visualViewport` resize; 150 / 600 ms) `heal()` scrolls the document back and, when a measure is shorter than the tallest seen at that width without the keyboard (`_vpShrunk`, pure), toggles `body` display in one task (scroll positions restored) and measures again. `?vpdebug=1` overlays the measured values (screen, inner, visualViewport, fixed height, safe insets, gap, tallest, scrollY) for checking on a device |
| `skin.js` | Loaded in `<head>`: applies the skin cached in `localStorage` `app-skin` as `<html data-skin>` before the first paint |
| `icons.js` | `ICONS` object (unicode/emoji constants) and SVG icon builder functions (`_svgAttachment`, `_svgLink`, `_svgNoteDoc`, …) |
| `state.js` | `ROUTE` (`'board'` | `'today'`), board context `BOARD_NAME` / `API_BASE` / `API` (`let`: `setBoardContext(name)` switches them on Today, `flushBoardSave()` runs a pending save now), API constants, fetch interceptor (auto-attaches session token), `showConfirm`, color/priority constants, state vars, `load`, `buildPatch`, `schedulesSave`, save indicators, `uid`, all state mutations, `mergeStates` |
| `drag.js` | Drag state vars, mouse D&D for columns and cards, touch D&D (`spawnGhost`, `endTouchDrag`, all touch/drag event listeners) |
| `cards.js` | Modal state vars, card add/edit modal (`openModal`, `openEditModal`, `submitCard`, color/priority rows), card-info dialog |
| `render.js` | `escHtml`, `fmtDate`, `safeLink`, `getLinkBadgeHtml`, `boardBadgesHtml` (board column counts for the Today Boards tile — tooltip = column title(s), aggregates use `columnBadges[].columns` from `GET /api/boards`), `render()` |
| `menus.js` | Card context menu, column context menu, `moveAllCards`, header dropdown menu |
| `settings.js` | Title char animation, remote polling (board page, or Today while an in-place card dialog is open), auth (`tryLogin`, `checkAuth`), prompts dialog, settings dialog (one "Settings" menu item; on a board page a Board | Global switch in the header — `#settingsScope`, `applySettingsScope`, sections listed in `BOARD_SECTIONS` / `GLOBAL_SECTIONS`; opens with the board scope, `openSettingsDialog(section)` picks the section's scope; elsewhere global only), `afterAuth` (routes by `ROUTE`: Today → `initToday`, board → load board + notes), `_createNotesModule` (notes module config shared by the board page and Today), `createBoardAndOpen` |
| `notes.js` | Notes sidebar state, load/save (`loadNotes`, `scheduleSaveNotes`), page CRUD (`addNotePage`, `deleteNotePage`), sidebar toggle/resize, note modal (`openNoteModal`, `submitNote`), linked-card creation |
| `search.js` | Find dialog (`openSearch`, `closeSearch`) in the panel format (`.panel-modal`, close icon → hidden `#searchCloseBtn`). Opens with an overview of the categories (`#searchOverview`, big icons: Cards, Pages, Events, Mail — Events / Mail only when accounts exist, `GET /api/today/search`); a pick shows `#searchMain` and an icon switch in the header bar (`.search-scope`, `setSearchMode(mode)`, `null` = overview). Cards / pages: text (all-words, accent-folding), priority, date range, and column filters, filtered in the browser; results open the edit modal; on Today it searches all boards (≥ 3 characters) and results open in place. Events / mail: server-side (`GET /api/today/search/:type`, ≥ 3 characters, debounced, results kept per query + filters — `_remote`) with an account filter (`#searchAccount`, per mode in `_account`), date range (`#searchFrom` / `#searchTo`), mail also a folder (`#searchMailFolder`, folders of the chosen account, loaded on demand) and "Message text" (full text); events always full text; result dates carry the year unless it is the current one; results open the detail panel (`_openEventDetail` / `_openMailDetail` after `_initOverlayHost`, also on board pages). `openSearch({ text })` prefills the text (Find tile's magnifier action). Filter rows: row gap = distance text field → filters (12 px; mail's date range is a second row via `.search-range-break`); ≤ 500 px a grid keeps them to two rows (mail: account | folder, from | to | "Body"; events: account, from | to; cards: priority, start | end | Columns button → column list as a popup, `toggleColumnPopup`) |
| `dashboard.js` | Shared helpers of the Today page (the Focus view it came from is gone) — detail panel (card and note panels share one layout, `.dash-doc-detail` in dashboard.css — the body becomes a flex column via `:has()`, so mail / event panels are unaffected: table fixed at the top, `.dash-doc-bottom` (attachments, linked notes) at the bottom, the Markdown text scrolling in between in a rounded box `.dash-doc-preview` — dark a shade darker than the panel, light white on a darker panel; "No description." / "No text." when empty; on small screens — ≤ 767 px wide or ≤ 500 px high — nothing is fixed and the whole body scrolls; `_openCardDetail` — viewing does not mark the card read (the board and Edit → `openEditModal` do; the link badge on Today rows still does); Board row shows `board › column` once the board is loaded, cards in the Scheduled column get a Scheduled row from `_dashScheduleHtml` (one-time date → target column, ⚠ when past; recurring rhythm · next date → target, from / until; uses `_describeRecurrenceBrief` / `_schedSortKey` from `scheduled.js`); its Edit button and linked-note links edit in place via `_todayEditCard` / `_todayEditNote`, href kept for new tabs; `_openEventDetail` — no footer: the header Edit button opens `openCalEventModal` (CalDAV only; a series first asks "This occurrence" / "Entire series" via `openContextMenu`), Delete only in the event context menu, an online meeting shows under Where as a direct link via `_todayMeetingLink` / `_todayMeetingHtml` from `today.js`; `_openMailDetail(accountId, msgId, folder?)` — no webmail link; the header Edit icon opens the mail in the mail view (`_openMailInView(accountId, msgId, folder?, mode?)`: opens the view on the folder — default the account folder — and the message; `mode` `reply` / `replyall` / `forward` then opens the compose form; href = `/today?mail=…&folder=…&mid=<Message-ID>` for new tabs); `_openNoteDetail(board, pageId)` — note page read-only like a card: board / folder / link / changed / linked cards table, Markdown body (attachment links via `_resolveDashNoteAttachments`), attachment list (viewer / download), header Edit → `_todayEditNote`, href = page on the board; a hidden `[data-note-detail]` marker in the body lets a slow load stop when another panel replaced it), event / mail context menus (the static mail menu: Open / Reply / Forward in the mail view — `#mailCtxOpen` / `#mailCtxReply` / `#mailCtxForward` via `_openMailInView`, no webmail entry — and a Flag submenu `#mailCtxFlagWrap`), mail flags shared with the mail view (`_MAIL_FLAGS` — Apple colours, same order as the backend; `_mailFlagHtml`, `_mailFlagMenuItems`, `_mailSetFlag`, `_mailFlag` for Today rows), calendar event modal (`openCalEventModal(…, prefill)` — create mode: `{ start, end, allDay }` and / or `{ title, description, onSaved() }`), `_detailCloseHook` (run once by `_closeDetail` — the Stickies panel flushes its save there), API helpers (`_dashPatchCard`, `_dashDeleteCard`, `_dashMoveCard`); `_reloadCardsPanel` / `_reloadMailPanel` / `_refreshCalendarAccount` just refresh the Today tiles (`_todayRefresh`). Mail privacy (shared with the mail view): `_renderMailBody` → `_renderMailHtml` runs `_mailPrivacyHtml` (DOMPurify, then removes tracking elements — 1–2 px / hidden images, tracker hosts / paths, also in CSS — always, and remote images / backgrounds / CSS `url()` unless the sender is trusted; `@import` always dropped) plus a CSP `<meta>` in the iframe (`_mailCsp`); privacy bar ("N remote images blocked" expands the list of blocked URLs — `blockedUrls`, plain text, never fetched; blocked image placeholders get a `Blocked: <url>` tooltip) with the checkboxes "Load images" (this mail only — `msg._jcLoadImages`, `_mailImagesAllowed`; gone when the mail is reopened) and, once ticked, "Trust sender" (saved) — the images part only for mails that contain remote images (`remote` count, trusted or not) — and a shield icon whose tooltip lists blocked trackers; image attachments of trusted senders are shown below the body (`_mailAppendGallery` / `_mailRenderGallery`, ≤ 30, fetched as blobs with a 60-entry object-URL cache; callers pass `attachments: { url, open }` to `_renderMailBody`); trusted senders get a green shield-check badge after the From address (`_mailTrustedBadgeHtml`, kept in sync by `_mailSyncTrustedBadges`); trusted senders cached in `_mailTrusted`. Overlay host: on Today and on board pages the calendar / mail views open over the page — `_initOverlayHost` (detail panel moved to `<body>` + config globals, once), `_syncOverlayHost` shows `#dashboard` (calendar and mail views) instead of `#today` while a view is open; the views count as views of their own — `_syncViewHeader` hides the open view's header icon (`#dashboardCalBtn` / `#dashboardMailBtn`, they only open, never toggle) and shows the dashboard icon `#todayBtn` (on Today it closes the view, on a board it links to `/today`), on a board `body.view-open` also hides the notes / scheduled toggles; header order: page-specific icons (notes / scheduled toggles, Today's Refresh), dashboard, boards, calendar, mail, menu — on board pages ≤ 500 px calendar / mail move into the menu (`#menuCalendar` / `#menuMail`, `.header-dd-item--mobile-only` shown via `.is-enabled`); on a board `#dashboard.dashboard--board` is fixed below the header over the board (never loads Today: header Mail / Calendar buttons, the card dialog's event / mail links — `_openCardRefInPlace` in cards.js — and `?cal=` / `?mail=` on a board URL, reopened at the end of `afterAuth`); URL state `?cal=…` / `?mail=…` on the current page, back button via `_isOverlayHostPage` |
| `calview.js` | Calendar view (week / work week / month) opened from Today — `openCalView`, `_cvLoad` (`?from&to`), timed events show title + location (or the online-meeting link via `_todayMeetingLink` from `today.js`, `_cvEvLocHtml`) on one sans-serif line each, pointer drag/resize/create (touch: an explicit edit mode first — a tap marks the event (`.cv-ev--touch-edit`, pulsing outline), after `_CV_TOUCH_ARM_MS` 1 s it can be moved / resized (`.cv-ev--touch-ready`, `touch-action: none`, big resize handle); it ends `_CV_TOUCH_KEEP_MS` 5 s after the last change, on a touch elsewhere, or on a second tap, which opens the details; until then touches on events scroll the grid (`.cv-ev` `touch-action: pan-x pan-y`); `_cvTouchEdit` matched by account + UID + nearest start since keys change on every load, re-applied after renders by `_cvMarkTouchEdit`), `_cvBuildMoveBody`, hour zoom (Ctrl +/-/0, Ctrl+wheel; 24 h … 6 h visible, stored in `localStorage`); calendar legend (2+ accounts: footer; on phones view modes, New event and calendar toggles live in a burger menu) hides accounts via `localStorage` `cal-view-hidden`; URL state `/today?cal=<mode>&date=<YYYY-MM-DD>`. Week views on phones: the hours stay fixed while the days scroll (vertical scroller = `.cv-week` there, `.cv-scroll` elsewhere — always go through `_cvVScroll()`); a new range centres the focus day, else today when it is in the range (`_cvRangeKey`; re-renders of the same range keep the horizontal position); swiping past the first / last day shows a "Previous / Next week" button at that edge (`_cvEdgeStart` / `_cvEdgeMove` touch listeners, `_cvShowEdgeOffer`; pulling on past `_CV_EDGE_JUMP_PX` in the same gesture, or a second pull while it is shown — also one starting on the button — jumps there directly, `_cvEdgeJump`; it opens that week at its last / first day, gone after 5 s or a scroll). Phones (`_cvIsPhone`, same media query as the CSS): month taps don't hit single entries — a tap opens the day overview (bottom sheet `#calViewDayList`), a double tap opens that week centred on the day (`_cvNavigate(anchor, mode, focusDay)`); Prev / Today / Next float at the bottom. Loaded after `dashboard.js` (uses its globals) |
| `mailview.js` | Mail view opened from Today (attention tile / header mail button) — `openMailView`, `closeMailView`, `_mvInitFromUrl`; folder tree for all accounts (collapse state in `localStorage` `mail-view-collapsed`; folders hidden via the context menu — Hide folder, with their subfolders, saved in the settings (`GET/PUT /api/dashboard/mail-hidden-folders`, `_mvLoadHidden` / `_mvSaveHidden`; an old per-browser list in `localStorage` `mail-view-hidden` is moved there once), kept across rename / move — are left out, a "Show more … (N)" row below the account's folders reveals them dimmed (`.mv-folder--hidden`, `_mvShowHidden`) where the menu offers Show folder; context menu: new/rename/move/delete, mark all as read (folders with unread mail), Delete duplicates (`_mvDeleteDuplicates`: `…/duplicates` scan, confirm with the count, then DELETE in UID sets of ≤ 500 — to the trash, permanently inside trash / spam), empty for trash / spam folders — destructive actions confirm via `showConfirm`, drag messages or folders onto folders), paged list (rows wrapped in `.mv-msg-wrap`; flagged messages show a flag in their colour — `_mailFlagHtml`; Flag submenu in the message context menu, Flag button in the reader toolbar (`_mvFlagMenuAt`), key `s` flags red / clears — `_mvSetFlag`, `_mvToggleFlag`; duplicates among the loaded messages — same rules as Delete duplicates, `_mvDuplicateIds`, largest copy = original — get the duplicate-card badge `.card-duplicate-badge`; on phones touch swipes reveal icon actions — left: Move (folder picker) + Delete, right: Mark read / unread + Flag (orange, `_MV_SWIPE_FLAG`; Clear flag when flagged); `_mvWireSwipe`, `_mvSwipeSnap`, layers created on demand, `touch-action: pan-y` keeps vertical scrolling native) with server-side search and multi-selection (Shift+click adds a range, Ctrl/Cmd+click toggles; context menu, Delete key, `u` and drag & drop act on the selection with one UID-set request), reader (right-click on an address in the header: trust / untrust it — `_mvAddressMenu`; action buttons show icons only when `#mailViewReaderActions` is narrower than 670 px — CSS container query `mv-actions`; uses `_renderMailBody` from `dashboard.js`, attachments via `openAttachmentViewer`; (i) button after Delete shows the raw source, `_mvOpenSource`; mails with both HTML and plain text show HTML first with a `TXT` ⇄ `</>` toggle — `_mvToggleFormat`, `_renderMailBody(…, { plain, toggle })` in `dashboard.js`, which renders its own toggle in the detail panel), compose in the reader pane (`_mvOpenCompose(mode, prefill)` — new messages: `{ to, subject, body (plain text), onSent() }`; From picker = custom listbox, one entry per account × sender address from the comma-separated SMTP `fromAddress`, shown as account colour swatch + address, choice in hidden `from` / `fromAddr` inputs — `_mvFromPickerHtml`, `_mvWireFromPicker`; reply preselects the address the mail was sent to — `_mvParseSenders`, `_mvReplySender`; quoted originals go through `_mailPrivacyHtml`; contenteditable + `execCommand` toolbar with an emoji picker (category tabs + Recent in `localStorage` `mail-emoji-recent`; inserts at the last caret position saved by `_mvSaveEditorRange`, Shift+click keeps it open — `_mvInsertEmoji`), attachments, reply / reply all / forward — forward keeps the original attachments as removable chips, attached server-side). Exclusive with the calendar view: opening one hides the other and takes over its history entry. URL state `/today?mail=<accountId>&folder=<path>` (`&mid=<Message-ID>` opens a message by Message-ID, then is dropped). Loaded after `calview.js` |
| `today.js` | Today page (`/today`, `initToday` dispatched from `afterAuth`). Tile registry `TODAY_TILES` (`agenda`, `attention`, `weather`, `cvapp`, `progress`, `quickaccess`, `boards`, `notes`, plus `search` from `today-search.js` — `{ title, load, render, actions, scales? }` — `scales`: content fits the tile height instead of scrolling, an `available` tile then fills the column's rest (`.today-tile--scales`) and never counts as overflowing — as "fit content" (`container`) its content height still counts in `_todayColumnNeed`; a new source = optional backend provider + one entry). Layout engine: breakpoints `TODAY_BPS` (xl ≥ 1600 / lg ≥ 1200 / md ≥ 768 / sm), ≤ 4 columns with width weights 1–3, tile sizes `1/1 · 2/3 · 1/2 · 1/3 · container` relative to the column height, plus `available` (content height, shrinks to the space the other tiles leave, body scrolls; one per column — `_todayOneAvailable` demotes extra ones to `container`, the tile just set / dragged wins); a column whose tiles need more than its height (`_todayColumnNeed`, checked by `_todayFitColumns` on resize, tile renders, `<details>` toggles, collapse and edit mode) shows its `available` tile at full content height (`.today-col--over`), and on multi-column layouts its headers become a sticky stack — tiles scrolled past keep their header at the top, tiles further down at the bottom (`.today-col--stack`: tiles `display: contents`, headers sticky at `--today-stack-i` × (`--today-hdr-h` + 5 px `--today-stack-gap`), the gap kept clear by page-coloured box-shadows); both off while editing; `_todayResolveLayout` uses the breakpoint's own layout or derives it from the next larger one (`_todayFold`: dropped columns' tiles go to the lowest column; on one column fractions ≥ 1/2 become `container`; derived column count also limited by 320 px per column). Today bar: date, weather reduced to icon + current temperature (details in its tooltip; hidden on phones), quick actions, CW label in the widget header colours, phones: full-screen calendar / mail view via a header icon next to their Refresh (`[data-view-fs]`, `_todayViewFs` / `_todaySetViewFs`, class `views-fs` on `<html>`, `localStorage` `view-fullscreen`; today.css: the view covers the screen and the app header, its header runs under the status bar). Board menu in the header (`settings.js`, `#boardSwitchMenu`): all active boards — only a board page leaves out its own board (`ROUTE === 'board'`; on Today `BOARD_NAME` is just the in-place edit context). Icon-only Refresh between Mail and Edit (phones: `.today-bar-refresh-sm` in the first line, right of the date — date, widget-mode button and Refresh never wrap apart; when the long date doesn't fit, `_todayFitBarDate` (ResizeObserver on the bar) switches to `_todayShortDate`: short weekday + DD.MM.YYYY; the header refresh button is hidden while the bar is shown and no calendar / mail view is open, and while a view is open — the views have their own refresh icon in their header, `#calViewRefresh` / `#mailViewRefresh` → `_todayRefreshAll`; `_todaySyncRefreshBtn`, `.in-today-bar` / `.in-view-bar`). Edit mode (pencil = last, icon-only action of the Today bar, `#todayEditBtn`, hidden on phones, highlighted while editing; menu item "Edit layout" on phones or with the bar hidden) edits the current breakpoint in place and follows window resizes (`_todayEditResize`: each breakpoint keeps its own draft in `_todayEdit.drafts`, the edit bar lists other changed sizes, Save writes all of them — `_todayEditLayouts`; on extra-large screens the size badge is a drop-down — `_todayEditSwitch(bp)` previews a smaller size by narrowing the grid to `_TODAY_PREVIEW_W` (`.today--preview`), so every size can be edited there): drag handle (pointer events), size select, hide, + column / + tile, reset to derived; saved via `PUT /api/today/config { layouts }`. Achievements tile (`progress`): shown day in the header (Today / Yesterday / date, in the count slot), day navigation like the overview's achievements (‹ / › / back to today as tile actions, plus a statistics icon (`SVGICONS.stats`) that opens the achievement history — `openAchievementHistory` from `analytics.js` — `_todayAchOffset`, `_todaySetAchOffset`; ‹ disabled without `hasPast`, actions support `disabled`), card lists as tooltips (`cardsTooltip` from `settings.js`). Boards tile: active boards as cards (name like the overview, counts from `boardBadgesHtml(…, { numbersOnly: true })` in a second row — numbers only, column name(s) in the tooltip; equal-width grid, columns per row = as many as fit the widest card measured off-screen, ≥ 2 — `_todayBoardCols` / `_todayFitBoards`, ResizeObserver; `.today-boards-compact` tightens paddings when two per row are too narrow), a folder action that lists archived boards in the same grid, dimmed with a dashed border (`_todayShowArchived` / `_todayToggleArchived`, `localStorage` `today-boards-archived`), and a collapsible "Last edited" (`_recentItemHtml`; card entries sit in `.today-swipe` wrappers and swipe like Needs attention — `_TODAY_SWIPE_ROW`, `_todaySwipeCard` resolves board / card id from the data attributes, the tile reloads after an action; cards open the detail panel via `_openLinkedCard`, href = `/board/<b>#card:<id>` for new tabs; notes link to the page on the board); (+) action opens an inline new-board form (`_todayToggleNewBoard`; uses `createBoardAndOpen` from `settings.js`, shared with the overview's "Create board"; typed name kept across refreshes, Escape closes). Notes tile: collapsible tree per board → folders → pages (`_todayRenderNotes`; open boards / folders kept in `localStorage` `today-notes-open`), header actions: magnifier shows / hides the filter field (hidden by default; hiding or Escape on an empty field clears it — `_todayToggleNotesSearch`), open next level (one folder level per click: the closed, visible boards / folders at the shallowest depth) / collapse all (`_todayNotesOpenAll`); filter (`_todayFilterNoteTree`: all words, accent-insensitive, matching folders keep their children); a page click opens the note detail panel (`_openNoteDetail`, Edit there = note dialog in place); modifier / middle click follows its link `/board/<board>#note:<id>`, which opens the note directly. Agenda = calendar events (`?from&to`, tagged into `_calEventMap`) merged with due / starting cards (`_todayAgendaDay` per day, `_todayAgendaDays`, now line); events with a Teams / Webex / Google Meet / Zoom URL in the location, else the description, get an "<open-link icon> <Provider>" link opening the meeting in a new tab — `_todayMeetingLink`, `_TODAY_MEETING_PROVIDERS`); range today + tomorrow or the upcoming week via the tile's "7 days" toggle (`widgets.agenda.days` 2 | 7 in the Today config). Needs attention lists unread mails and flagged mails (`flagged` row, any age, flag colour before the subject; unflagging drops the row — `_todayDropMail(acc, id, list)` removes from one list or, without `list`, all). On small screens (≤ 767 px or ≤ 500 px high, touch): mail and card rows sit in `.today-swipe` wrappers and swipe like the mail view's list (`_todayWireSwipe`, reuses `_mvSwipeSnap` and the `.mv-swipe-*` CSS) — mails: right = Mark as read (unread mails) + Flag (orange) / Clear flag, left = Move (folder picker) + Delete; cards: right = Edit (`_todayEditCard`), left = Move to column + Delete (confirms); pickers via `_todayPick` (modal list in the mail-view picker look, `.today-picker`), mail folders `_todayPickMailFolder` (recent folders first, the account folder left out). Double-click on a tile header collapses / expands it to the header — on small screens (≤ 767 px, `_todaySmall`) a single tap (`_todaySetCollapsed`, `.today-tile--collapsed` overrides the size; ignored in edit mode and on header buttons). The collapsed widgets are saved per breakpoint in the Today config (`collapsed: { xl?, lg?, md?, sm? }`, `PUT /api/today/collapsed`, debounced and queued — `_todayStoreCollapsed`), so every device of that size opens in the same state; reapplied on a breakpoint change and taken over from the server on every Today refresh (`_todaySyncCollapsed`, skipped while a save is pending); the old `localStorage` `today-collapsed` is only the fallback for a size never saved. A collapsed tile's header hides its action icons and shows one chevron (`.today-tile-expand`) that opens it. Widget-mode button left of the phone Refresh (`[data-bar="collapse"]`, `.today-bar-collapse`, small screens only) cycles all open → one at a time → all collapsed (`_todayCycleCollapseMode`, `localStorage` `today-collapse-mode`, `_todayCollapsedForMode` pure; icon / tooltip show the current mode — `_todaySyncCollapseBtn`); "one at a time" makes opening a tile collapse the other shown tiles, the other two modes are one-shot. No tile ever scrolls horizontally: wide content gets `data-hscroll` and is wrapped by `_todayHScroll` (hidden scrollbar, ‹ › buttons only where content is cut off). Details reuse `dashboard.js` (`_openCardDetail`, `_openEventDetail`, `_openMailDetail`, context menus); `#dashboardDetail` is moved to `<body>` and calendar / mail views open as overlays (`_isOverlayHostPage` / `_syncOverlayHost` include `/today`). Quick access tile (`quickaccess`, data = `widgets.quickaccess` of the Today config, no request): links (new tab) as icon with the title below it in an auto-fill grid — app icons stand alone, emojis and the letter fallback sit in a framed area (`_todayQaIconBoxHtml`), image icons with `invertDark` are inverted in dark mode; the first `visible` (default 8, 0 = all) shown, the rest behind "Show more … (N)" (`_todayQaSplit`, `localStorage` `today-qa-more`); icons = stored image (`/api/today/quickaccess/icon/<file>`), emoji or the title's first letter (also when an image fails — `_todayQaImgFallback`); gear action opens Settings → Dashboard with the row expanded (`_todayOpenWidgetSettings` / `_todayExpandWidget`). Its settings block (`_todayQaWire`): always-shown count, icon size Small / Medium / Large, Show titles toggle (off: `.today-qa--notitles`, icons only, columns as narrow as the icon; title stays in the tooltip), entry list (drag to reorder, edit, delete), add / edit form — URL, title (default: host), image = app icon (Fetch icon / Upload image…, fetched automatically on save; "Invert in dark mode" checkbox) or emoji (picker reuses `_MV_EMOJI` / `_mvRenderEmojiPop` from `mailview.js`). Weather tile: "7 days" action toggles the hourly strip / the 7-day forecast below the same top area (current state, today's range, sunrise; `_todayWeatherDays`, `_todaySetWeatherDays`, `widgets.weather.days` 1 | 7; the following 6 days in a row like the hours (today is the top area) — date without weekday, icon, max, min, rain — `_todayWeatherWeekHtml` from the provider's `days`). Weather (tile + bar) goes through `_todayWeather()`: reused for 15 min by the quiet auto-refresh, refetched on manual / non-quiet loads. Auto-refresh: all tiles every `refreshMinutes` (Today config, default 1, 0 = off; `_todaySchedule`) — quiet reload (`loadToday({ quiet })`) keeps scroll position, open `<details>` and expanded (i) infos (`_todaySaveState` / `_todayRestoreState`), a failing tile keeps its content; hidden tabs skip and catch up on `visibilitychange`. Settings → Dashboard (section `#todaySection`, labelled "Dashboard" in the settings; `initTodaySettings`, `loadTodaySettings`): Today bar toggle, refresh interval, Widgets list built from `TODAY_TILES` (`_todayRenderWidgetRows`: toggle per widget — on = not in `disabled` and placed in a stored layout (`_todayWidgetShown`), `_todayKnownTiles` skips them, activating re-adds the tile to stored layouts that lack it — `_todayLayoutsWith`; widgets with `settings: true` get their `[data-wset=<id>]` block from `#todayWidgetSettings` as a collapsed body — agenda range, reset layouts, weather location search, CV-App URLs + key. Loaded after `mailview.js` |
| `today-search.js` | Find tile (`TODAY_TILES.search`, title "Find", registered after `today.js`; header magnifier action opens the Find dialog with the typed text — `openSearch({ text })`): input (searches from 3 characters — `_TS_MIN_CHARS`), then one row per available source (`GET /api/today/search`) with an include checkbox on the right (`.today-search-check`; All / None above them), "Full text" tile action; prefs `{ off, full }` in `localStorage` `today-search`. One request per source, mail one per account (`_tsSlots`), results kept per query + mode (`_ts.key`) — ticking a source only fetches what is missing, the auto-refresh never searches again, and the tile body is built once (`_tsBuild`) so typing is never disturbed; debounce 350 ms, Enter = now, Escape clears, `AbortController` drops stale searches. While a search request runs (`_tsBusy`), Today reloads nothing else: `loadToday` (auto-refresh, refresh buttons, settings, tab catch-up — a manual one flashes "Refresh after the search") and `_todayRefresh` (after card / mail actions) are collected in `_todayDeferred` and run once when the search is done (`_tsSettled` → `_todayRunDeferred`; a held full load replaces the partial ones). Rows are always shown: a ticked source with hits is a collapsed `<details>` category (summary: name + hit count, ⚠ when a source failed; the checkbox is the click target, so ticking doesn't open it), otherwise a plain row without triangle — "0" / dots cycling "" → "." → ".." → "..." while searching (`.today-search-dots`, CSS `content` keyframes; static "..." with reduced motion) / nothing before a query, dimmed when unticked (`.today-search-group--empty` / `--off`; opened categories kept in `_ts.open` while results stream in, reset by a new query or mode); `_tsGroup` merges mail accounts newest first. Rows reuse the Today row markup so the grid delegation in `today.js` opens them: cards → `_openCardDetail` (done cards: filled check circle, struck through — `_todayKanbanCardHtml`), events → `_openEventDetail` (tagged into `_calEventMap`), mail → `_openMailDetail(…, folder)` (`data-folder`; no mail context menu for these rows — it acts on the account folder), notes → `_openNoteDetail`, applications → CV-App link in a new tab |
| `today-stickies.js` | Stickies tile (`TODAY_TILES.stickies`, registered after `today-search.js`): stack of square stickies — the current one on top, up to 3 of the following behind it, rotated per stack slot (`_stkAngles` = [top, 1st, 2nd, 3rd behind], up to 4 different angles ±1.5–6°, ≥ 1.5° apart, neighbours leaning opposite ways — `_stkNewAngle`; every flip shifts them — `_stkShiftAngles`: forward the papers move up keeping their angle and the last slot gets a fresh one, backward the new top gets a fresh one; slider / dice jumps shift too); footer line = category + source (`.today-stk-foot`: `.today-stk-cat`, `.today-stk-src` in the same font, case as typed, cut with … — `_stkLinkify` makes http(s) URLs links shown without the scheme, opening in a new tab instead of the sticky); text formatted by `_stkFormat` (escaped, then `**bold**`, `*italic*` / `_italic_`, `__underline__`, `~~strike~~` within one line, `{-}` = soft hyphen / hyphenation point; conversions drop `{-}` — `_stkStripHyphens`) and scaled to fit the square (`_stkFitText`, binary search of the font size 3–64 px; words never break — `overflow-wrap: normal`, so the longest word decides the width, re-run by a ResizeObserver; size from the tile width; every size but "fit content" (container) also scales to the height so nothing scrolls — `_stkLayout`; such a tile wider than high puts the slider upright along its right border, `.today-stk--wide`; dark mode: black slider track with a thin light outline; the tile is `scales: true`, so as `available` it takes the column's remaining space). The frame (stack + slider) is kept while the count is unchanged, so a dragged slider / keyboard focus survive flipping. Order: `_stkSort` by `_stkOrderKey` (= `stickyOrderKey` in `global-db.js`: `pos` once moved, else minus the creation time — newest first). Fullscreen (tile action, `_stkSetFs`, `.today-tile--fs`: the tile covers the screen incl. the app header, below dialogs; Escape leaves it unless a dialog / the detail panel is open — capture-phase `_stkFsKey`; header taps don't collapse it): larger screens show all (filtered) stickies in a grid (`_stkRenderGrid`, `.today-stk-grid` / `.today-stk-cell`, random tilt per position, ±1.5–6° both ways, kept for the session — `_stkGridAngles` / `_stkGridTilts`), a click opens the detail panel, drag & drop moves one (mouse / pen at once, touch after a 300 ms hold — `.today-stk-cell--armed`; target from layout offsets, not hit-testing, so gliding neighbours (FLIP) aren't hit; `_stkGridDropped` → `_stkPosBetween` the new neighbours' keys → `PUT { pos }`); small screens (`_todaySmall`) keep the stack, scaled to the full screen and centred below the chips, the dice as a round button in the lower right corner instead of the header's dice / settings (`_stkPhoneFs`, `_stkSyncDiceFab`, `.today-stk-body--phonefs`, `.today-stk-dice-fab`); resizing across the limit switches. Flip: range slider (hidden on small screens; no ‹ › buttons), ← / → on the focused stack, swipe / drag of the top sticky (pointer events, `touch-action: pan-y`; past 30 % of its width or a flick it flies off — swipe left = next; re-renders wait while dragging — `_stkDrag`). Current sticky = id in `localStorage` `today-stickies-pos`. Categories are editable (`_stkCats` from `GET /api/stickies`, `_stkSetCats`; defaults `_STK_DEFAULT_CATEGORIES`; new stickies `_stkDefaultCat`). Fullscreen grid mode (body `.today-stk-body--grid`, flex column): sticky head bar = chips + keyword field (`.today-stk-q`, `_stkQuery`, `_stkMatches` — all words in text + source, accent-insensitive; Escape clears it before leaving fullscreen), the grid (`.today-stk-gridbox`), and the category packs in the lower 280 px (`.today-stk-packs`, sticky at the bottom, edge to edge — the fullscreen tile has no frame; `_stkPacksHtml`: up to 3 papers per category or a dashed empty box, name, count, delete icon (`_stkDeleteCat`, confirm; its stickies move to the first remaining category; never the last one), + box (`_stkStartAddCat`: inline name, Enter / blur saves, Escape cancels), widget settings icon in the lower left corner (`[data-stk-settings]` — the header drops dice and settings in grid mode); a click on a pack filters by it (again: All); dragging a sticky onto a pack moves it there (`_stkGridDragMove` checks the packs first — `.today-stk-pack--drop`, no reordering meanwhile — `_stkMoveToCategory` → `PUT { category }`). Bar / packs use `background: inherit` from the body (skins tint it). `_stkReload` refetches the tile past the per-refresh fetch cache. Category filter: chips All + one per category with counts above the stack (`.today-stk-filter`, `_stkSetFilter`; categories without stickies hidden except the selected one; always one line — wrapped by `_todayHScroll` (`.today-stk-filter-wrap`), scrolls sideways without a scrollbar, ‹ › only where chips are cut off, the selected chip kept in view — `_stkChipIntoView`; the last selection is saved in the Today config `widgets.stickies.filter`, so it is the same on all devices — PUTs queued, only the last response replaces `_todayCfg`; the old `localStorage` `today-stickies-filter` is only a fallback; `_stkFilter` / `_stkCounts` pure) — the stack, slider, keys, swipe and random pick work on the filtered list (`_stkVisible`), the header count stays the total, a new sticky starts in the filtered category. Random rhythm: `widgets.stickies.rhythm` (minutes: 10, 30, 60 … 1440; 0 = only on request) — on each tile render `_stkDue` → `_stkPickRandom` (never the current one) brings a random sticky to the top, last pick in `localStorage` `today-stickies-random`; dice action = now. Double-click (mouse) / tap (touch — opened on the following click, so it doesn't land in the text field; no keyboard on phones) opens the detail panel (`_stkOpenDetail`, also (+) for a new one, created on the first non-empty save): textarea on the sticky colour + formatting hint, source field, colour swatches, category; footer buttons icon-only (label as tooltip / aria-label): Save (saves and closes — `_stkSaveAndClose`, also Ctrl+Enter), Save & add another, Delete, Turn into …; a new sticky gets "Save & add another" (also Ctrl+Shift+Enter — `_stkSaveAndNew`: flushes, then a blank sticky in the same category; disabled while empty, kept after the first autosave via `ed.isNew`); saved debounced 600 ms (`_stkFlush`, queued), flushed on close via `_detailCloseHook` (`dashboard.js`); footer "Turn into" Mail / Event / Card / Note page (`_stkConvert`: `_stkSplit` → title = first line ≤ 120 chars, quotes as Markdown blockquote, source as "— source" / "Source: …" — `_stkMarkdown`, plain text for mail / event — `_stkPlain`; mail via `_todayCompose({ subject, body, onSent })`, event via `_todayNewEvent({ title, description, onSaved })`, card via `openInboxModal`, note page via `_todayPick` board + `_todayNewNote`) — once the target is saved, "Delete the sticky?" (Delete / Keep, `_stkAfterConvert`); Delete with confirm |
| `init.js` | Entry point — calls `initTitleChars()` and `checkAuth()`; generic `[data-close-via]` click handler for dialog header close icons |

## CouchDB

**Database naming convention:**
- `jc-kanban-<name>` — one database per board (e.g. `jc-kanban-cards`)
- `jc-config-<name>` — global/shared config databases (e.g. `jc-config-dashboard`, `jc-config-prompts`, `jc-config-stickies` — one doc per sticky)

The board state is stored as a single document (`_id: "board"`) in the `jc-kanban-cards` database. On startup `db.js#initDb`:
1. Retries the CouchDB connection up to 15 times (2 s apart)
2. Creates the `jc-kanban-cards` database if absent
3. Seeds the `board` document from `data/data.json` (or built-in defaults) if absent

All configuration is via `.env` (forwarded to both containers by `docker-compose.yml`):

| Variable | Default | Description |
|---|---|---|
| `APP_PASSWORD` | `kanban-pwd` | Password for the web UI login |
| `API_KEY` | _(empty)_ | Static key for external API access; if unset, only session tokens are accepted |
| `PORT` | `3000` | HTTP port the server listens on |
| `HOST` | `localhost` | Bind address logged on startup |
| `COUCHDB_USER` | `kanban` | CouchDB admin username |
| `COUCHDB_PASSWORD` | `kanban-pwd` | CouchDB admin password |
| `COUCHDB_HOST` | `localhost` | CouchDB hostname (set to `couchdb` by compose) |
| `COUCHDB_PORT` | `5984` | CouchDB port |
| `BACKUP_DIR` | `data/` | Directory for JSON backups (`kanban-<name>-board.json`, `kanban-<name>-notes.json`, `extension-prompts.json`, `stickies.json`, `stickies-categories.json`); also holds `attachments/` and the Quick access icons (`today-icons/`) |
| `BACKUP_INTERVAL_MS` | `600000` | How often backups run (ms); default 10 min |
| `BASE_PATH` | _(empty)_ | URL prefix when served from a subdirectory (e.g. `/folder`). Routes are mounted both under the prefix and at `/`, so proxies may forward or strip it. `index.html` asset URLs are rewritten server-side; frontend code uses app-absolute paths (`/api/…`, `/board/…`) — the fetch interceptor in `state.js` prefixes `/api/` calls, and navigation links must use `appUrl(path)` / `${BASE_PATH}` |
| `FIX_PERMISSIONS` | _(unset = off)_ | Docker build only (build arg via `docker-compose.yml`): `1` runs `mkdir -p /app/data && chmod 700 && chown -R node:node /app` in the image — slow (node_modules). The `./data` bind mount hides the image's `/app/data`, so its permissions come from the host directory (must be writable by uid 1000) either way |
| `TEST_INSTANCE` | _(unset)_ | `1` shows an amber "Test" label in the app header (injected into `index.html` by `sendSpa` in `server.js`; a small tag on the header's top edge above the start of the title, on every screen size — `.test-instance-label` in `layout.css`) |
| `TRUST_PROXY` | _(unset)_ | Set to `1` when running behind exactly one trusted reverse proxy (nginx/caddy); enables correct `req.ip` for rate limiting via `X-Forwarded-For` |

The Fauxton admin UI is available at `http://localhost:5984/_utils`.

## Icons

Before adding an icon, check whether a suitable one already exists in the project's icon library (inline SVGs in `index.html` or reused SVG markup in the JS/CSS). When a new icon is needed, prefer SVG over icon fonts or raster images.

## Frontend Patterns

The frontend maintains a single `state` object (`{ columns: [...] }`). After every mutation, `render()` wipes and rebuilds the board DOM from scratch (React-style, but vanilla JS).

**Auto-save:** mutations call `scheduleSave()` which debounces 600 ms then sends a `PATCH /api/:board/board` with only the changed columns/settings (falls back to `PUT` before the first successful load). A header indicator shows "saving…" / "✓ saved".

**Drag and drop:** uses the HTML5 Drag and Drop API. `dragState` tracks source column/card. `getDropIndex()` computes target insertion point from the pointer Y coordinate.

**Modal:** one reusable modal handles both add and edit card actions. `modalMode` (`'add'` | `'edit'`) controls behaviour; `openModal(colId)` resets all fields, `openEditModal(colId, card)` pre-fills them. Enter submits (except inside the description textarea); Escape closes.

**Entry point & routes:** `/today` is the start page. The server redirects `/`, `/index.html`, `/focus`, `/dashboard` (302, query kept — old `?cal=` / `?mail=` deep links still work) and `/inbox` (→ `/today?inbox[&board=…]`, opens the add-to-inbox modal) there. The only other page is `/board/<name>`.

**In-place editing on Today:** "Edit" on a card (context menu, detail panel, search result) or Edit in the note detail panel (Notes tile / search open `_openNoteDetail` first; linked notes in the card detail open the dialog directly) opens the normal card / note dialog on Today without rendering the board (`_todayEditCard`, `_todayEditNote` in `today.js`, serialised by `_todayEditSerial`). Edit from the detail panel passes `{ fullscreen }` (the panel's mode, `_detailFullscreen`): the card dialog via `toggleCardFullscreen` (cards.js), the note dialog via `setNoteFullscreen` of the notes module (`app/notes-webdav/frontend/notes.js` — the module actually loaded; `app/frontend/notes.js` is not referenced by `index.html`). It flushes pending saves, calls `setBoardContext(board)` + `load()` (board JSON only; `render()` is a no-op unless `ROUTE === 'board'`), and for notes creates the notes module once (`_createNotesModule({ headless: true, goToBoard, onClose })` — no sidebar, no `#note:` hash) and switches it with `setBoard()`. Saves go through the usual `schedulesSave` / notes save paths of that board. **Go to board** (`#modalGoBoardBtn`, `#noteModalGoBoardBtn`) closes the dialog like Close (asks about unsaved changes), flushes the save and navigates to `/board/<b>#card:<id>` / `#note:<id>`, which reopens the dialog there. Closing refreshes the Today tiles. New pages in place: `_todayNewNote(board, { title, description, onCreated })` (Stickies → Note page) calls the module's `addNotePage(parentId, prefill)` — the prefilled page counts as unsaved (closing asks), `onCreated(pageId)` fires after its first save.

## API endpoints

All `/api/*` routes require authentication via one of:
- **Session token** (browser): `x-auth-token: <token>` — obtained via `POST /api/auth`
- **API key** (external tools): `x-api-key: <key>` or `Authorization: Bearer <key>` — requires `API_KEY` set in `.env`

### Auth & global

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth` | Login; body: `{ "password" }`; returns `{ ok, token }` |
| `GET` | `/api/auth/verify` | Check if the current session token is valid |
| `GET` | `/api/settings` | Returns `{ apiKey }` (null if not configured) |
| `GET` | `/api/prompts` | Load global search prompts |
| `GET` | `/api/appearance` | `{ skin, skins }` — active skin (`default` when nothing / an unknown one is stored) |
| `PUT` | `/api/appearance` | Body `{ skin }` (one of `skins`, else 400); returns `{ ok, skin }`. Set in Settings → Appearance (`#appearanceSection`, global only); `loadAppearance()` in `afterAuth` applies the server value (`applySkin` in `settings.js`, cached for `skin.js`) |
| `PUT` | `/api/prompts` | Save global search prompts; body: `{ searchProfile, criteriaInclude, criteriaExclude, searchRadius }` |

### Board management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/boards` | List all boards with card counts and metadata |
| `POST` | `/api/boards/:name` | Create a board (name: lowercase alphanumeric + hyphens, ≤ 64 chars, not `inbox`) |
| `POST` | `/api/boards/:name/rename` | Rename a board; body: `{ "newName" }` (≤ 12 chars) |
| `DELETE` | `/api/boards/:name` | Delete a board and all its data |

### Board data (`:board` = board name)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/:board/board` | Load full board state |
| `PUT` | `/api/:board/board` | Full replace of board state |
| `PATCH` | `/api/:board/board` | Partial update; body: `{ columnOrder?, updatedColumns?, removedColumnIds?, settings? }` |
| `GET` | `/api/:board/all-columns` | All columns as `{ "Title": [cards], … }` |
| `GET` | `/api/:board/column/:name` | Cards in a named column (case-insensitive) |
| `GET` | `/api/:board/card/:id` | Card history: `{ created, moves, column }` |
| `POST` | `/api/:board/move-to/:name` | Move a card to the named column (see below) |
| `POST` | `/api/:board/import` | Bulk-import cards (see below) |
| `GET` | `/api/:board/notes` | Load notes document |
| `PUT` | `/api/:board/notes` | Replace notes document; body: full notes object |
| `GET` | `/api/:board/notes/export` | Download notes as a ZIP archive (Markdown + attachments) |
| `GET` | `/api/:board/attachment-stats` | Returns `{ count, size }` for all attachments on the board |
| `GET` | `/api/:board/webdav-config` | Load WebDAV config: `{ enabled, url, user, hasPassword }` |
| `PUT` | `/api/:board/webdav-config` | Save WebDAV config; body: `{ enabled, url, user, password? }` |
| `POST` | `/api/:board/webdav-config/test` | Test WebDAV connectivity; returns `{ ok, message?, error? }` |
| `GET` | `/api/:board/webhook-config` | Load webhook config: `{ enabled, name, url, method }` |
| `PUT` | `/api/:board/webhook-config` | Save webhook config; body: `{ enabled, name, url, method }` |
| `POST` | `/api/:board/webhook/trigger` | Fire the configured webhook server-side; returns `{ ok, status?, error? }` |

WebDAV config is stored globally in `jc-config-webdav`, with each board's config as a separate document keyed by board name. When enabled, notes are synced with the configured WebDAV server (e.g. Nextcloud). Credentials are stored server-side and never sent to the browser.

Webhook config is stored as a separate CouchDB document (`_id: "webhook-config"`) per board. The configured button name appears in the board menu; clicking it fires `POST /:board/webhook/trigger` which makes a server-side HTTP request (GET/POST/PUT/PATCH) to the URL and returns the result in a dialog.

### Notes attachments (`:pageId` format: `n-<alphanumeric>`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/:board/notes/attachments/:pageId` | List attachments; returns `[{ name, size }]` |
| `POST` | `/api/:board/notes/attachments/:pageId` | Upload file (multipart `file` field, max 50 MB); returns `{ name, size }` |
| `GET` | `/api/:board/notes/attachments/:pageId/:filename` | Download attachment file |
| `DELETE` | `/api/:board/notes/attachments/:pageId/:filename` | Delete attachment; returns `{ ok: true }` |

### Card attachments (`:cardId` format: `id-<alphanumeric>`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/:board/cards/attachments` | List all card IDs that have at least one attachment |
| `GET` | `/api/:board/cards/attachments/:cardId` | List attachments for a card; returns `[{ name, size }]` |
| `POST` | `/api/:board/cards/attachments/:cardId` | Upload file (multipart `file` field, max 50 MB); returns `{ name, size }` |
| `GET` | `/api/:board/cards/attachments/:cardId/:filename` | Download attachment file |
| `DELETE` | `/api/:board/cards/attachments/:cardId/:filename` | Delete attachment; returns `{ ok: true }` |

### Today page (global)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/today/config` | `{ showBar, refreshMinutes (0–60, default 1), disabled: [widget id], collapsed?: { xl?, lg?, md?, sm?: [widget id] }, widgets: { agenda?: { days: 2 | 7 }, stickies?: { rhythm: 0 | 10 | 30 | 60 | 120 | 240 | 480 | 1440, filter?: 'all' | category id }, weather?: { lat, lon, label, days?: 1 | 7 }, cvapp?: { apiUrl, publicUrl, hasApiKey }, quickaccess?: { visible (0–50), size: 's' | 'm' | 'l', showTitles? (default true), items: [{ id: 'qa-…', url, title?, icon: { type: 'image', file, invertDark? } | { type: 'emoji', value } }] } }, layouts: { xl?, lg?, md?, sm? } }`; defaults when nothing is stored (doc `today-config` in `jc-config-dashboard`) |
| `PUT` | `/api/today/config` | Partial update — top-level keys sent replace the stored ones. Layout: `{ columns: [{ width: 1–3 }] (1–4), tiles: [{ id, col, order, size }] }`; 400 for a tile outside the columns, twice, or a second `available` tile in one column (sizes `1/1 · 2/3 · 1/2 · 1/3 · container · available`). `cvapp.apiKey` kept when omitted, cleared with `hasApiKey: false`. Returns `{ ok, config }` |
| `PUT` | `/api/today/collapsed` | Body `{ bp: 'xl' \| 'lg' \| 'md' \| 'sm', tiles: [widget id] (≤ 50) }` — replaces only that breakpoint's list of collapsed widgets (`collapsed` in the Today config; not accepted by `PUT /api/today/config`). Returns `{ ok, collapsed }` |
| `POST` | `/api/today/config/reset-layouts` | Restore the default layouts (widget settings kept) |
| `GET` | `/api/today/widgets/:id` | Widget data: `cards` (`?date=YYYY-MM-DD`, the client's local day), `weather`, `cvapp`, `notes`. 400 = not configured, 502 = upstream error, 404 = unknown widget |
| `GET` | `/api/today/search` | Sources the Find widget / dialog can use: `{ types: ['cards', 'notes', 'events'?, 'mail'?, 'applications'?], mailAccounts: [{ id, label, color, webInterfaceUrl }], calendarAccounts: [{ id, label, color }] }` (events / mail when accounts exist, applications when the CV-App URL is set) |
| `GET` | `/api/today/search/:type?q=&full=1[&account=][&from=&to=][&folder=]` | Search one source (`cards`, `notes`, `events`, `mail` — needs `account`, `applications`); `q` 3–200 chars (else 400). Find dialog filters: `from` / `to` (YYYY-MM-DD, inclusive, `from` ≤ `to`, else 400) for events and mail; `account` for events (one calendar, unknown 404); `folder` for mail (only that folder). Events without a range: today ± 1 year, one hit per UID; with a range every occurrence in it, earliest first (window ≤ 3 years, 400 beyond; one open end is clamped — `eventRange`). Mail range = IMAP `SENTSINCE` / `SENTBEFORE`; unknown type / mail account 404, CV-App not configured 400, upstream error 502. Returns `{ items (≤ 50), total, truncated?, errors? }` — items: cards `{ board, column, card }`, notes `{ board, id, title, path, lastModified? }`, events = event + `accountId, label, color, webUrl`, mail = message summary + `folder`, applications like the cvapp widget (`url` = CV-App deep link) |
| `GET` | `/api/stickies` | Stickies widget: `{ items: [{ id: 's-<12 hex>', text, source, color, category, created, updated, pos? }] (by `stickyOrderKey`: newest first unless moved), categories: [{ id, label }] }` (db `jc-config-stickies`; categories default Note / Quote / Intervention / Other) |
| `POST` | `/api/stickies/categories` | Body `{ label }` (1–40 chars, unique case-insensitive, ≤ 30 categories) → 201 `{ category: { id, label }, categories }`; id = label slug (accents folded, never `all`), else `c-<6 hex>`; 409 duplicate |
| `DELETE` | `/api/stickies/categories/:id` | `?to=` target (default: the first remaining category); its stickies move there (`updated` kept) → `{ ok, moved, to, categories }`; 404 unknown, 400 last category / unknown target |
| `GET` | `/api/stickies/export` | All stickies as Markdown download (`stickies-YYYY-MM-DD.md`, format: `stickies-md.js`). Settings → Dashboard → Stickies "Export" (`_stkExportMd`) |
| `POST` | `/api/stickies/import` | Body `{ markdown }` (≤ 5 MB) — merged: known ids updated, others added (valid ids kept, else new), categories matched by id, then label, else created; invalid colours → palette. Returns `{ ok, added, updated, skipped, categoriesAdded, categories }`; 400 nothing found. Settings "Import…" (`_stkImportMd`, reloads the tile) |
| `POST` | `/api/stickies` | Body `{ text (1–5000, not blank), source? (≤ 500, trimmed, '' = none), color? (#rrggbb, default random from the palette), category? (an existing category id; default note, else the first one) }` → 201 `{ item }`; 400 unknown category |
| `PUT` | `/api/stickies/:id` | Partial `{ text?, source?, color?, category?, pos? }` (at least one; `pos` = sort key from drag & drop in the fullscreen grid — a change of `pos` and / or `category` only keeps `updated`) → `{ item }`; 404 unknown, 400 invalid id / fields |
| `DELETE` | `/api/stickies/:id` | `{ ok: true }`; 404 unknown |
| `GET` | `/api/today/geocode?q=` | Place search for the weather location (Open-Meteo geocoding) |
| `POST` | `/api/today/quickaccess/icon` | Body `{ url }` → finds, downloads and stores the site's best icon; returns `{ file }` (502 = no icon found) |
| `POST` | `/api/today/quickaccess/icon/upload` | Multipart `file` (≤ 512 KB, PNG / JPEG / GIF / WebP / ICO / SVG, checked by magic bytes) → `{ file }` |
| `GET` | `/api/today/quickaccess/icon/:file` | Stored icon (`qa-<16 hex>.<ext>`), `Cache-Control: immutable`, `nosniff`, sandbox CSP |

### Dashboard (global)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/config` | Load dashboard config: `{ mailAccounts, calendarAccounts, defaultTimezone? }` (settings of the removed Focus view — `cardSources`, `autoRefreshMs`, `recentLimit`, `panel*`, `cardGrouped`, `calendarGrouped` — are dropped on read and write) |
| `PUT` | `/api/dashboard/config` | Save dashboard config |
| `GET` | `/api/dashboard/mail` | Summaries from all mail accounts: per account `{ accountId, label, color, webInterfaceUrl, folder, messages (latest `maxMessages`), flagged (every flagged message of the account folder, any age, newest ≤ 50 — IMAP `SEARCH FLAGGED`), flaggedTotal, error }` — Needs attention lists unread and flagged mails |
| `GET` | `/api/dashboard/mail/:accountId` | Messages for one account |
| `GET` | `/api/dashboard/mail/:accountId/messages` | One page of a folder for the mail view: `?folder=&page=&q=` (50/page, sorted by date / time latest first — Date header, else arrival time; the folder's date order is fetched once (`sortUidsByDate`, cached per folder while UIDVALIDITY / UIDNEXT / EXISTS are unchanged) and paged by UID; `q` = IMAP search in subject/from/to/body); returns `{ messages, total, page, pageSize }` |
| `GET` | `/api/dashboard/mail/:accountId/duplicates` | `?folder=` → `{ messages, uids }`: duplicate copies in the folder — same sender, To, subject, exact date / time (Date header, else arrival time) and Message-ID; size only for messages without one (copies of one mail often differ in size: headers added on delivery / move, attachments stripped or re-encoded) — `findDuplicateUids` in `dashboard/mail.js`; the largest copy of each group is kept (ties: lowest UID), `uids` are the others. Deleted by the mail view's folder menu "Delete duplicates" via `DELETE …/message/:uids` |
| `GET` | `/api/dashboard/mail/:accountId/folder-size` | `?folder=` → `{ size, messages }`; size = sum of `RFC822.SIZE` (no `STATUS=SIZE` in imapflow). Shown in the mail view's folder-column footer |
| `GET` | `/api/dashboard/mail/:accountId/message/:uid` | Full message (envelope + body, `messageId`, `inReplyTo`, `references`, `replyTo`) |
| `GET` | `/api/dashboard/mail/:accountId/message/:uid/source` | Raw RFC 822 source as `text/plain` (`nosniff`); shown by the reader's (i) button in the attachment viewer, downloadable as `.eml` |
| `GET` | `/api/dashboard/mail/:accountId/message/:uid/attachment/:part` | Download one attachment |
| `POST` | `/api/dashboard/mail/:accountId/test` | Test IMAP connectivity; returns `{ ok, error? }` |
| `GET` | `/api/dashboard/mail/:accountId/folders` | List IMAP folders; returns `{ folders: [{ path, name, delimiter, parent, specialUse, noselect }] }`; `?status=1` adds `messages`, `unseen` |
| `POST` | `/api/dashboard/mail/:accountId/folders` | Create folder; body: `{ path }` |
| `POST` | `/api/dashboard/mail/:accountId/folders/rename` | Rename or move a folder; body: `{ from, to }` (INBOX refused) |
| `DELETE` | `/api/dashboard/mail/:accountId/folders?path=` | Delete folder (INBOX refused) |
| `POST` | `/api/dashboard/mail/:accountId/folders/mark-read` | Mark all messages of a folder read (`\Seen` on `1:*`); body: `{ path }`; returns `{ ok, messages }` |
| `POST` | `/api/dashboard/mail/:accountId/folders/empty` | Permanently delete all messages of a trash / spam folder; body: `{ path }`. Only folders with special use `\Trash` / `\Junk`, the configured `trashFolder` or a well-known name (Trash, Spam, Junk, Junk-E-Mail, Gelöschte Elemente, Deleted Items, Papierkorb, …) — others 400. Returns `{ ok, deleted }` |
| `POST` | `/api/dashboard/mail/:accountId/send` | Send via the account's SMTP server; multipart: `payload` (JSON `{ from?, to, cc?, bcc?, subject, html, text, inReplyTo?, references?, replyUid?, replyFolder?, forwardUid?, forwardFolder?, forwardParts?, forwardAccount? }`) + `files` (≤ 10 × 25 MB, all attachments ≤ 50 MB). `from` = one of the account's sender addresses (default: the first; others 400). `forwardParts` = IMAP parts of the original that the server attaches itself (from `forwardAccount`, default the sending account). Copy appended to the sent folder; replied message gets `\Answered`, forwarded one `$Forwarded` (same account only). Returns `{ ok, messageId, warning? }` |
| `PATCH` | `/api/dashboard/mail/:accountId/message/:uid` | Mark read/unread and / or flag; body: `{ seen?: bool, flag?: 'red' \| 'orange' \| 'yellow' \| 'green' \| 'blue' \| 'purple' \| 'gray' \| null }` (at least one; `null` clears). Flags follow Apple Mail: `\Flagged` + colour index in the keywords `$MailFlagBit0..2` (red = no bit; `flagColor` / `flagChanges` / `MAIL_FLAG_COLORS` in `dashboard/mail.js`; servers without custom keywords keep just `\Flagged`). Message summaries and full messages carry `flagged` + `flagColor` |
| `GET` | `/api/dashboard/mail-hidden-folders` | Folders hidden in the mail view's tree: `{ folders: { [accountId]: [path] } }` (doc `mail-hidden-folders` in `jc-config-dashboard`) |
| `PUT` | `/api/dashboard/mail-hidden-folders` | Body `{ accountId, folders: [path] }` (≤ 500, deduplicated) replaces that account's list (empty = none); unknown account 404, invalid paths 400. Returns `{ ok, folders }`. Listed in Settings → Sources → Mail ("Hidden folders", `loadMailHidden` in `settings.js`, eye button = show again) |
| `GET` | `/api/dashboard/mail-trusted-senders` | Senders whose remote images the mail views load: `{ senders: [lower-case address] }` (doc `mail-trusted-senders` in `jc-config-dashboard`) |
| `PUT` | `/api/dashboard/mail-trusted-senders` | Trust / untrust a sender; body: `{ address, trusted: bool }`; returns `{ ok, senders }`. Managed in Settings → Sources → Mail ("Trusted senders", `loadMailTrusted` in `settings.js`) and via the toggle on each mail |
| `POST` | `/api/dashboard/mail/:accountId/message/:uid/cards` | Link a kanban card to the mail; body: `{ board, cardId }` (`?folder=`). Stored in `jc-config-dashboard` doc `mail-card-links` under the message's Message-ID (422 if it has none). Returns `{ ok, messageId, unchanged? }` |
| `GET` | `/api/dashboard/mail/:accountId/locate` | `?messageId=&folder=&scope=` → `{ folder, uid }`: IMAP `SEARCH HEADER Message-ID` (skipping `\Deleted` copies) in the hint folder, the account folder, then every selectable folder; `scope=hint` searches only the hint folder. 404 if gone. The frontend tries `scope=hint` first, then searches everything behind a cancellable `showProgress` dialog |
| `POST` | `/api/dashboard/mail/:accountId/message/:uid/move` | Move to folder; body: `{ folder: string }` |
| `DELETE` | `/api/dashboard/mail/:accountId/message/:uid` | Move to trash (`trashFolder` account config, else the server's `\Trash` folder, else `'Trash'`); inside the trash it deletes permanently. Returns `{ ok, permanent }` |
| `GET` | `/api/dashboard/calendar` | Events from all calendar accounts |
| `GET` | `/api/dashboard/calendar/:accountId` | Events for one account; `?days=n` (lookahead from today) or `?from=YYYY-MM-DD&to=YYYY-MM-DD` (explicit range, `to` exclusive, ≤ 62 days — used by the calendar view) |
| `GET` | `/api/dashboard/calendar/:accountId/event/:uid` | Full event detail |
| `POST` | `/api/dashboard/calendar/:accountId/event/:uid/cards` | Link a kanban card to the event; body: `{ board, cardId, href? }`. Adds a hidden `X-JC-KANBAN-CARD:<board>/<cardId>` property to every VEVENT of the stored ICS (everything else kept; `If-Match` with one retry on 412). CalDAV only. Returns `{ ok, unchanged? }` |
| `POST` | `/api/dashboard/calendar/:accountId/test` | Test CalDAV/iCal connectivity; returns `{ ok, error? }` |

All mail message routes accept an optional `?folder=<path>` (default: the account's `folder` or `INBOX`). `PATCH`, `…/move` and `DELETE` on `message/:uid` also accept a UID set (`3,7,9`, ≤ 500) for bulk actions from the mail view's multi-selection.

**Mail ↔ card links:** same principle — mails are immutable, so the hidden ID is the Message-ID (stable across folder moves, unlike IMAP UIDs). The card gets `mailRef: { accountId, messageId, folder?, subject }` (folder = search hint); the server keeps `{ [accountId]: { [messageId]: [{ board, cardId }] } }` and adds `cardRefs` to messages in all mail list/message responses. The card opens the mail via `/today?mail=<acc>&folder=<hint>&mid=<Message-ID>` (`openMailViewMessage` → `…/locate`).

**Calendar ↔ card links:** "Create card" in the event context menu (dashboard calendar panel and calendar view) opens the add-to-inbox modal prefilled from the event; the card gets `calEvent: { accountId, uid }`, the event a hidden `X-JC-KANBAN-CARD` property. Both sides use stable IDs (CalDAV UID, card ID), so moving/editing the event keeps the link. Events expose links as `cardRefs: [{ board, cardId }]`; full-rebuild PUTs (non-recurring edits, calendar-view drags) must pass `cardRefs` through — series patches and occurrence overrides keep them server-side.

Dashboard config is stored in `jc-config-dashboard`. Card sources reference board names and column titles. Mail and calendar credentials are stored server-side and never sent to the browser. Mail accounts may carry `sentFolder`, `trashFolder` and `smtp: { host, port, secure (true | false | 'auto'), user?, password?, fromName?, fromAddress? }` — `fromAddress` may list several comma-separated senders (`a@x, Name <b@x>`, first = default; `senderAddresses` in `dashboard/mail.js`); SMTP user/password fall back to the IMAP credentials; `smtp.password` is stripped like `password` (`smtp.hasPassword` instead) and preserved on PUT when omitted.

## Move-to endpoint

`POST /api/:board/move-to/:name` — finds a card by composite text and moves it to the named column.

Body: `{ "job-title": "…", "company": "…", "location": "…" }` — card is looked up as `job-title | company | location`.

Returns `{ toBeMoved, moved, toColumn, success }`.

## Import endpoint

`POST /api/:board/import` — bulk-imports cards from external tools (e.g. n8n). Two accepted body formats:

**Plain array** — all items land in the inbox with their own color:
```json
[{ "text": "Card title", "priority": 1, "link": "https://…" }]
```

**Classified object** — `relevant` items get green (`#10b981`), `excluded` items get red (`#ef4444`):
```json
{ "relevant": [{ "text": "…" }], "excluded": [{ "text": "…" }] }
```

Job-application objects with `job-title`, `company`, `location`, and `reason` fields are auto-converted: `text` becomes `job-title | company | location` and `description` becomes `reason`.

Cards are deduplicated by `text` across all columns. New cards are prepended to the "Inbox" column (created at position 0 if absent; the column name includes today's date when `inboxWithDate` is enabled in settings).

Returns `{ relevant, relevant_items, excluded, excluded_items, skipped, skipped_items }`.

## Data Model

### Board document (`_id: "board"`)

```jsonc
{
  "columns": [
    {
      "id": "string",
      "title": "string",
      "color": "string",        // optional, drives the column dot color
      "actions": [],            // optional, auto-applied when a card is moved into this column
                                // values: "markDone" | "markUndone" | "setStartDate" | "setEndDate"
      "cards": [
        {
          "id": "string",
          "text": "string",
          "color": "string",    // optional
          "priority": 1,        // optional, 1 (highest) – 5 (lowest)
          "description": "string", // optional, rendered as Markdown
          "link": "string",     // optional, http/https only
          "startDate": "YYYY-MM-DD", // optional
          "endDate": "YYYY-MM-DD",   // optional
          "done": false,        // optional boolean, set via "Mark as done"
          "unread": true,       // optional; true for cards created via API (/import, /inbox), recurring tasks or the scheduler.
                                // Opening (board / Edit dialog — not the Today detail panel) or moving the card sets it to false (never deleted — mergeStates needs the key)
          "created": "YYYY-MM-DD",   // set automatically on card creation
          "calEvent": { "accountId": "ca-…", "uid": "…" }, // optional; calendar event the card was created from
          "mailRef": { "accountId": "ma-…", "messageId": "<…>", "folder": "…", "subject": "…" }, // optional; mail the card was created from
          "moves": [            // optional, appended on every column move
            { "at": "ISO-8601", "from": "column title", "to": "column title" }
          ]
        }
      ]
    }
  ],
  "settings": {                 // optional, board-level configuration
    "description": "string",   // shown as the board tooltip on Today
    "archived": false,          // moves the board to "Archived boards" on Today
    "inboxWithDate": false,     // prefix imported inbox columns with today's date
    "persistCollapse": false,   // save collapsed column state across sessions
    "collapsedColumnIds": [],   // persisted when persistCollapse is true
    "trackedColumns": [],       // column titles shown as card counts on Today
    "autoSaveDialogs": false,   // auto-save card/note dialogs on a timer
    "autoSaveIntervalMin": 5    // interval in minutes for autoSaveDialogs (default 5, omitted when 5)
  }
}
```

### Notes document (`_id: "notes"`)

Stored as a separate CouchDB document per board. Schema version 2 — older v1 documents (with a `pages` array) are migrated automatically on read.

```jsonc
{
  "schemaVersion": 2,
  "items": [
    // folder — may contain any mix of pages and sub-folders
    {
      "type":     "folder",
      "id":       "string",
      "title":    "string",
      "children": []         // recursive — same item structure
    },
    // page
    {
      "type":         "page",
      "id":           "string",
      "title":        "string",
      "description":  "string",   // optional, rendered as Markdown
      "link":         "string",   // optional, http/https only
      "linkedCards":  [],         // optional, card IDs linked to this page
      "hasAttachments": false,    // optional, true when files have been uploaded
      "lastModified": "ISO-8601"  // optional, set on save
    }
  ]
}
```

### Sticky document (`jc-config-stickies`, `_id` = `s-<12 hex>`)

```jsonc
{
  "text":     "string",          // 1–5000 chars, plain text
  "source":   "string",          // author, book, URL …; '' = none (≤ 500)
  "color":    "#fde68a",         // paper colour; default random from STICKY_COLORS
  "category": "note",            // id of a category (doc `categories` in jc-config-stickies, default note | quote | intervention | other)
  "created":  "ISO-8601",
  "updated":  "ISO-8601",
  "pos":      -1762941600000.5   // optional sort key, set by drag & drop (stickyOrderKey: else -created)
}
```

### WebDAV file format (on the server)

Each note page is stored as a Markdown file with a YAML front-matter block. Folders map to WebDAV collections (directories).

**Directory layout:**
```
<webdav-root>/
  page-title.md              # root-level page (slug = title with / \ : * ? " < > | replaced by _)
  folder-name/               # folder (same slugging)
    child-page.md
    _attachments/            # attachments for pages inside this folder
      <pageId>_filename.ext
  _attachments/              # attachments for root-level pages
    <pageId>_filename.ext
```

**File format:**
```markdown
---
id: "[n-abc123](https://host/board#note:n-abc123)"
title: "My Note"
link: "https://example.com" # optional
attachments:                 # optional — Markdown links: "[filename](_attachments/pageId_filename)"
  - "[document.pdf](_attachments/n-abc123_document.pdf)"
linkedCards:                 # optional — Markdown links: "[title](url/board#card:id-xxx)"; any []() in the title are stripped
  - "[Some card](https://host/board#card:id-abc123)"
lastModified: 2024-01-15T10:30:00.000Z
---

Markdown body of the note…
```

The `id` front-matter field ties the file back to the CouchDB item. On first sync the app writes its internal ID; files created directly on the WebDAV server (without an `id` field) get a generated `n-wd-<hex>` ID when imported. The `wdPath` field stored on CouchDB items tracks the authoritative relative path after any renames or moves, so the file is found even if the title slug would differ.

### WebDAV config document

Stored in the global `jc-config-webdav` database, one document per board (`_id` = board name). Never exposed to the browser (password stays server-side).

```jsonc
{
  "enabled": true,
  "url":     "https://dav.example.com/notes/",
  "user":    "alice",
  "password": "s3cr3t"           // stored on the server, never returned to the frontend
}
```

### Webhook config document (`_id: "webhook-config"`)

Stored as a separate CouchDB document per board.

```jsonc
{
  "enabled": true,
  "name":    "Deploy",           // label shown as the board menu button
  "url":     "https://hooks.example.com/…",
  "method":  "POST"              // GET | POST | PUT | PATCH
}
```
