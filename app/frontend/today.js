'use strict';

// ---- Today page (/today) ----
// One page for "what matters today": a configurable grid of tiles (agenda, needs attention,
// widgets). Layouts are stored per breakpoint (≤ 4 columns, tile height relative to the column);
// a breakpoint without its own layout is derived from the next larger one (_todayResolveLayout).
// Details open in the shared detail panel / calendar view / mail view (dashboard.js, calview.js,
// mailview.js), so this file only renders summaries.

const TODAY_BPS = [
  { key: 'xl', min: 1600, cols: 3, label: 'Extra large (≥ 1600 px)' },
  { key: 'lg', min: 1200, cols: 2, label: 'Large (≥ 1200 px)' },
  { key: 'md', min: 768,  cols: 2, label: 'Medium (≥ 768 px)' },
  { key: 'sm', min: 0,    cols: 1, label: 'Small (< 768 px)' },
];
// `available` = fit content, at most the space the other tiles leave in the column (one per column)
const TODAY_SIZES      = ['1/1', '2/3', '1/2', '1/3', 'container', 'available'];
const _TODAY_SIZE_FRAC = { '1/1': 1, '2/3': 2 / 3, '1/2': 1 / 2, '1/3': 1 / 3 };
const _TODAY_SIZE_CLS  = { '1/1': 'f1', '2/3': 'f23', '1/2': 'f12', '1/3': 'f13', container: 'auto', available: 'fill' };
const _TODAY_SIZE_LABEL = { container: 'fit content', available: 'available space' };
const _TODAY_MIN_COL_W = 320;
const _TODAY_GAP       = 16;
const _TODAY_SOON_DAYS = 2;   // "Needs attention": cards due within this many days after today

// ---- Layout engine (pure; unit-tested) ----

/** Breakpoint key for a viewport width. */
function _todayBpFor(width) {
  return (TODAY_BPS.find(b => width >= b.min) || TODAY_BPS[TODAY_BPS.length - 1]).key;
}

/** Relative height of a tile for balancing; `container` counts as 1/3. */
function _todaySizeWeight(size) {
  return _TODAY_SIZE_FRAC[size] ?? 1 / 3;
}

/**
 * Only one `available` tile per column: `keepId` (if given) wins, else the first in order;
 * the others become `container`. `tiles` must be sorted by column + order. Mutates and returns it.
 */
function _todayOneAvailable(tiles, keepId) {
  const keep = new Map();
  if (keepId) for (const t of tiles) if (t.id === keepId && t.size === 'available') keep.set(t.col, t.id);
  for (const t of tiles) {
    if (t.size !== 'available') continue;
    if (!keep.has(t.col)) keep.set(t.col, t.id);
    if (keep.get(t.col) !== t.id) t.size = 'container';
  }
  return tiles;
}

/** Drop unknown / duplicate tiles, clamp columns, sort by column + order and renumber orders. */
function _todayNormalise(layout, known) {
  const columns = (layout?.columns?.length ? layout.columns : [{ width: 1 }]).slice(0, 4).map(c => ({ width: Math.min(3, Math.max(1, c.width | 0 || 1)) }));
  const seen  = new Set();
  const tiles = [];
  for (const t of layout?.tiles || []) {
    if (!known.includes(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    tiles.push({
      id: t.id,
      col: Math.min(columns.length - 1, Math.max(0, t.col | 0)),
      order: t.order ?? tiles.length,
      size: TODAY_SIZES.includes(t.size) ? t.size : 'container',
    });
  }
  tiles.sort((a, b) => a.col - b.col || a.order - b.order);
  const next = columns.map(() => 0);
  for (const t of tiles) t.order = next[t.col]++;
  return { columns, tiles: _todayOneAvailable(tiles) };
}

/**
 * Fold a layout onto `n` columns: columns ≥ n are dropped and their tiles (in column, then order
 * sequence) go to the remaining column with the smallest summed height. On one column, tall
 * fractions (≥ 1/2) become `container` so phones don't get several full-screen scroll boxes.
 */
function _todayFold(layout, n) {
  let { columns, tiles } = layout;
  if (columns.length > n) {
    columns = columns.slice(0, n);
    const keep  = tiles.filter(t => t.col < n);
    const moved = tiles.filter(t => t.col >= n);
    const load  = columns.map(() => 0);
    const next  = columns.map(() => 0);
    for (const t of keep) { load[t.col] += _todaySizeWeight(t.size); next[t.col] = Math.max(next[t.col], t.order + 1); }
    tiles = [...keep];
    for (const t of moved) {
      let c = 0;
      for (let i = 1; i < n; i++) if (load[i] < load[c] - 1e-9) c = i;
      load[c] += _todaySizeWeight(t.size);
      tiles.push({ ...t, col: c, order: next[c]++ });
    }
    tiles.sort((a, b) => a.col - b.col || a.order - b.order);
    tiles = _todayOneAvailable(tiles.map(t => ({ ...t })));
  }
  if (columns.length === 1) {
    tiles = tiles.map(t => (_TODAY_SIZE_FRAC[t.size] ?? 0) >= 0.5 ? { ...t, size: 'container' } : t);
  }
  return { columns, tiles };
}

/**
 * Layout to show for breakpoint `bp`: its own layout, else one derived from the next larger
 * breakpoint that has one (else the next smaller, else all tiles stacked). `width` (optional)
 * limits the column count of a derived layout to what fits at _TODAY_MIN_COL_W.
 * Returns { columns, tiles, derived, from }.
 */
function _todayResolveLayout(layouts, bp, known, width) {
  const idx = Math.max(0, TODAY_BPS.findIndex(b => b.key === bp));
  const own = layouts?.[bp];
  if (own) return { ..._todayNormalise(own, known), derived: false, from: bp };

  let from = null;
  for (let i = idx - 1; i >= 0 && !from; i--) if (layouts?.[TODAY_BPS[i].key]) from = TODAY_BPS[i].key;
  for (let i = idx + 1; i < TODAY_BPS.length && !from; i++) if (layouts?.[TODAY_BPS[i].key]) from = TODAY_BPS[i].key;
  const src = from
    ? _todayNormalise(layouts[from], known)
    : { columns: [{ width: 1 }], tiles: known.map((id, i) => ({ id, col: 0, order: i, size: 'container' })) };

  let n = TODAY_BPS[idx].cols;
  if (width) n = Math.min(n, Math.max(1, Math.floor(width / _TODAY_MIN_COL_W)));
  return { ..._todayFold(src, Math.max(1, Math.min(n, src.columns.length))), derived: true, from };
}

// ---- Agenda model (pure; unit-tested) ----

function _todayLocalDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _todayAddDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return _todayLocalDay(new Date(y, m - 1, d + n));
}

/** Local midnight of a YYYY-MM-DD day. */
function _todayDayStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Sort events and cards into one day: all-day row (all-day events, timed events continuing from
 * an earlier day, cards starting today), timed events by start, and due cards. `nowIndex` = index
 * in `timed` before which the now line goes (-1 when `now` is not on this day).
 */
function _todayAgendaDay(events, cards, day, now) {
  const start = _todayDayStart(day), end = _todayDayStart(_todayAddDays(day, 1));
  const allDay = [], timed = [];
  for (const ev of events) {
    if (!ev.start) continue;
    if (ev.allDay) {
      const s = ev.start.slice(0, 10);
      const e = ev.end ? ev.end.slice(0, 10) : _todayAddDays(s, 1);   // DTEND exclusive
      if (s <= day && day < (e > s ? e : _todayAddDays(s, 1))) allDay.push({ kind: 'event', ev });
      continue;
    }
    const s = new Date(ev.start);
    const e = ev.end && new Date(ev.end) > s ? new Date(ev.end) : s;   // zero-length = a point in time
    const instant = +e === +s;
    if (!(s < end && (instant ? s >= start : e > start))) continue;
    if (s < start) allDay.push({ kind: 'event', ev, continues: true });
    else timed.push({ kind: 'event', ev, past: instant ? s < now : e <= now });
  }
  timed.sort((a, b) => new Date(a.ev.start) - new Date(b.ev.start) || (a.ev.title || '').localeCompare(b.ev.title || ''));
  for (const c of cards.starts || []) allDay.push({ kind: 'card', ...c, why: 'starts' });
  const due = (cards.due || []).map(c => ({ kind: 'card', ...c, why: 'due' }));
  let nowIndex = -1;
  if (now >= start && now < end) {
    nowIndex = timed.findIndex(t => new Date(t.ev.start) > now);
    if (nowIndex < 0) nowIndex = timed.length;
  }
  return { day, allDay, timed, due, nowIndex };
}

/**
 * `n` consecutive day models from `today` (2 = today + tomorrow, 7 = the upcoming week).
 * Day 0 uses dueToday / startsToday, later days dueWeek / startsWeek of the cards provider.
 */
function _todayAgendaDays(events, cards, today, n, now) {
  const days = [];
  for (let i = 0; i < n; i++) {
    const day = _todayAddDays(today, i);
    const c = i === 0
      ? { due: cards.dueToday || [], starts: cards.startsToday || [] }
      : { due: (cards.dueWeek || cards.dueTomorrow || []).filter(x => x.card.endDate === day),
          starts: (cards.startsWeek || []).filter(x => x.card.startDate === day) };
    days.push(_todayAgendaDay(events, c, day, now));
  }
  return days;
}

/** Number of agenda days: 7 (upcoming week) or 2 (today + tomorrow). */
function _todayAgendaRange(cfg) {
  return cfg?.widgets?.agenda?.days === 7 ? 7 : 2;
}

// ---- Weather helpers (pure; unit-tested) ----

/** WMO weather code → { icon, label }. */
function _todayWeatherKind(code, isDay = true) {
  const c = Number(code);
  if (c === 0)                      return { icon: isDay ? 'wxSun' : 'wxMoon', label: 'Clear' };
  if (c === 1 || c === 2)           return { icon: isDay ? 'wxPartly' : 'wxCloud', label: c === 1 ? 'Mostly clear' : 'Partly cloudy' };
  if (c === 3)                      return { icon: 'wxCloud', label: 'Overcast' };
  if (c === 45 || c === 48)         return { icon: 'wxFog', label: 'Fog' };
  if (c >= 51 && c <= 57)           return { icon: 'wxRain', label: 'Drizzle' };
  if (c >= 61 && c <= 67)           return { icon: 'wxRain', label: 'Rain' };
  if (c >= 71 && c <= 77)           return { icon: 'wxSnow', label: 'Snow' };
  if (c >= 80 && c <= 82)           return { icon: 'wxRain', label: 'Showers' };
  if (c === 85 || c === 86)         return { icon: 'wxSnow', label: 'Snow showers' };
  if (c >= 95)                      return { icon: 'wxThunder', label: 'Thunderstorm' };
  return { icon: 'wxCloud', label: '' };
}

/** First upcoming hour with ≥ 50 % precipitation probability, or null. */
function _todayNextRain(hours) {
  return (hours || []).find(h => (h.precip ?? 0) >= 50) || null;
}

/** ISO 8601 week number. */
function _todayIsoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86_400_000 + 1) / 7);
}

// ---- State ----

let _todayCfg      = null;    // GET /api/today/config
let _todayExpandWidget = null; // widget row to expand when Settings → Today opens (tile action)
let _todayBp       = null;    // breakpoint of the shown layout
let _todayLayout   = null;    // resolved layout on screen
let _todayEdit     = null;    // { bp, draft, dirty } while editing
let _todayFetchMemo = new Map();   // url → promise, one load cycle
let _todayTimer    = null;
let _todayStale    = false;   // a refresh was skipped while the tab was hidden
const _todayTileEls = new Map();   // tile id → <section>
const _todayCardMap = new Map();   // "board\0cardId" → { board, card }

function _todayFetchJson(url) {
  if (!_todayFetchMemo.has(url)) {
    _todayFetchMemo.set(url, fetch(url).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
      return data;
    }));
  }
  return _todayFetchMemo.get(url);
}

function _todayToday() { return _todayLocalDay(new Date()); }

function _todayCardsUrl() { return `/api/today/widgets/cards?date=${_todayToday()}`; }

function _todayFmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

// Board names never contain '/' (a NUL separator would not survive an HTML attribute)
function _todayCardKey(board, id) { return `${board}/${id}`; }

/** Short status message in the header (settings.js#flashIndicator is not global). */
function _todayFlash(text) {
  const el = document.getElementById('dashboardFetchedAt');
  clearTimeout(_fetchedAtTimer);
  el.innerHTML = text;
  el.classList.add('show');
  _fetchedAtTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function _todayRegisterCard(item) {
  _todayCardMap.set(_todayCardKey(item.board, item.card.id), { board: item.board, card: item.card });
}

/** Compact card row (agenda due list, attention lists). */
/**
 * Compact card like the "Last edited" entries of the Boards tile (dashboard.js#_recentItemHtml):
 * one title line, then card icon · board · column · due date (red overdue / orange soon),
 * plus a circle to mark it as done.
 */
function _todayKanbanCardHtml(item) {
  _todayRegisterCard(item);
  const { board, column, card } = item;
  const today    = _todayToday();
  const warnDate = _todayAddDays(today, _TODAY_SOON_DAYS);
  const isOverdue = card.endDate && card.endDate < today && !card.done;
  const isWarning = !isOverdue && card.endDate && card.endDate >= today && card.endDate <= warnDate && !card.done;
  const dateCls = 'card-date' + (isOverdue ? ' card-date--overdue' : isWarning ? ' card-date--warning' : '');
  const date  = card.endDate ? `<span class="${dateCls}">${escHtml(fmtDate(card.endDate))}</span>` : '';
  // Link badge as on the board cards (card.css positions it in the top-right corner)
  const href  = card.link ? safeLink(card.link) : '';
  const link  = href ? getLinkBadgeHtml(card.link, href) : '';
  const color = card.color ? ` style="--card-color:${escHtml(card.color)}"` : '';
  return `<div class="card dashboard-recent-item today-kcard${link ? ' today-kcard--link' : ''}${card.unread ? ' card--unread' : ''}" data-card-key="${escHtml(_todayCardKey(board, card.id))}"${color}>
    <button class="today-check" data-act="done" title="Mark as done" aria-label="Mark as done"></button>
    <div class="card-body">
      <div class="card-text" title="${escHtml(card.text || '')}">${escHtml(card.text || '')}</div>
      <div class="card-meta"><span class="dashboard-recent-icon">${SVGICONS.card(14, 10)}</span><span class="dashboard-recent-context">${escHtml(board)} · ${escHtml(column)}</span>${date}${link}</div>
    </div>
  </div>`;
}

// Weather (tile + Today bar): reused for 15 minutes by the automatic refresh (the server caches
// Open-Meteo for as long); a failed request is not kept.
const _TODAY_WEATHER_MS = 15 * 60 * 1000;
let _todayWeatherCache = null;   // { at, promise }

function _todayWeather() {
  if (!_todayWeatherCache || Date.now() - _todayWeatherCache.at >= _TODAY_WEATHER_MS) {
    const promise = _todayFetchJson('/api/today/widgets/weather');
    _todayWeatherCache = { at: Date.now(), promise };
    promise.catch(() => { if (_todayWeatherCache?.promise === promise) _todayWeatherCache = null; });
  }
  return _todayWeatherCache.promise;
}

// ---- Tile registry ----
// { title, desc, settings? (block [data-wset=<id>] in Settings → Today), load() → data, render(body, data),
//   actions?() → [{ icon, title, run }] }
// A new source = an optional backend provider (routes/today.js PROVIDERS) + one entry here.

const TODAY_TILES = {
  agenda: {
    title: 'Agenda',
    desc: 'Calendar events and due / starting cards of today and tomorrow or the upcoming week',
    settings: true,
    load: _todayLoadAgenda,
    render: _todayRenderAgenda,
    actions: () => [
      { label: '7 days', title: 'Show the upcoming week (7 days incl. today)', active: _todayAgendaRange(_todayCfg) === 7,
        run: () => _todaySetAgendaRange(_todayAgendaRange(_todayCfg) === 7 ? 2 : 7) },
      { icon: SVGICONS.create(12, 12), title: 'New event', run: () => _todayNewEvent() },
      { icon: SVGICONS.date(12, 12),   title: 'Calendar view', run: () => _todayOpenCal('week') },
    ],
  },
  attention: {
    title: 'Needs attention',
    desc: 'Unread mail, overdue cards, cards due today or soon, new cards',
    load: _todayLoadAttention,
    render: _todayRenderAttention,
    actions: () => [{ icon: SVGICONS.email(12, 12), title: 'Mail view', run: () => _todayOpenMail() }],
  },
  weather: {
    title: 'Weather',
    desc: 'Forecast for the rest of the day (Open-Meteo), updated every 15 minutes',
    settings: true,
    load: () => _todayWeather(),
    render: _todayRenderWeather,
  },
  cvapp: {
    title: 'Applications',
    desc: 'Active and recently updated applications from the CV-App',
    settings: true,
    load: () => _todayFetchJson('/api/today/widgets/cvapp'),
    render: _todayRenderCvApp,
    actions: () => {
      const url = _todayCfg?.widgets?.cvapp?.publicUrl;
      const recent = _todayCvMode() === 'recent';
      return [
        { label: 'Recent', title: recent ? 'Showing recently updated applications — click for active ones' : 'Show recently updated applications instead of the active ones',
          active: recent, run: () => _todaySetCvMode(recent ? 'active' : 'recent') },
        ...(url ? [{ icon: SVGICONS.openLink(12, 12), title: 'Open CV-App', run: () => window.open(url, '_blank', 'noopener,noreferrer') }] : []),
      ];
    },
  },
  progress: {
    title: 'Achievements',
    desc: 'Cards added to inboxes, created, moved and done today — or on an earlier day',
    load: () => _todayFetchJson(`/api/achievements/today?date=${_todayAddDays(_todayToday(), _todayAchOffset)}`),
    render: _todayRenderProgress,
    // Day navigation: ‹ earlier, › later (up to today), back to today
    actions: () => [
      ...(_todayAchOffset < 0 ? [{ icon: SVGICONS.sync(12, 12), title: 'Jump to today', run: () => _todaySetAchOffset(0) }] : []),
      { label: '‹', title: 'Previous day', disabled: !_todayAchHasPast, run: () => _todaySetAchOffset(_todayAchOffset - 1) },
      { label: '›', title: 'Next day', disabled: _todayAchOffset >= 0, run: () => _todaySetAchOffset(_todayAchOffset + 1) },
      { icon: SVGICONS.stats(13, 13), title: 'Statistics (achievement history)', run: () => openAchievementHistory() },
    ],
  },
  quickaccess: {
    title: 'Quick access',
    desc: 'Direct links to web apps and pages — app icon or emoji',
    settings: true,
    load: () => Promise.resolve(_todayCfg?.widgets?.quickaccess || {}),
    render: _todayRenderQuickAccess,
    actions: () => [{ icon: SVGICONS.settings(12, 12), title: 'Edit entries', run: () => _todayOpenWidgetSettings('quickaccess') }],
  },
  boards: {
    title: 'Boards',
    desc: 'Boards with open counts and the last edited cards',
    load: () => Promise.all([
      _todayFetchJson('/api/boards'),
      _todayFetchJson('/api/dashboard/recent?limit=8').catch(() => []),
    ]),
    render: _todayRenderBoards,
    actions: () => [
      { icon: SVGICONS.folder(12, 12), title: _todayShowArchived() ? 'Hide archived boards' : 'Show archived boards', active: _todayShowArchived(),
        run: () => _todayToggleArchived() },
      { icon: SVGICONS.create(12, 12), title: _todayNewBoardOpen ? 'Cancel new board' : 'New board', active: _todayNewBoardOpen,
        run: () => _todayToggleNewBoard() },
    ],
  },
  notes: {
    title: 'Notes',
    desc: 'Browse the note pages of all active boards and open one directly',
    load: () => _todayFetchJson('/api/today/widgets/notes'),
    render: _todayRenderNotes,
    actions: () => [
      { icon: SVGICONS.search(12, 12), title: _todayNotesSearch ? 'Hide the filter' : 'Filter pages', active: _todayNotesSearch,
        run: () => _todayToggleNotesSearch() },
      { icon: SVGICONS.expandAll(12, 12),   title: 'Open next level', run: () => _todayNotesOpenAll(true) },
      { icon: SVGICONS.collapseAll(12, 12), title: 'Collapse all', run: () => _todayNotesOpenAll(false) },
    ],
  },
};

/** Tiles that can be shown: all registered ones except those deactivated in Settings → Today. */
function _todayKnownTiles(cfg = _todayCfg) {
  const off = cfg?.disabled || [];
  return Object.keys(TODAY_TILES).filter(id => !off.includes(id));
}

/**
 * Stored layouts with tile `id` added where it is missing (end of the last column, fit content) —
 * a widget activated again in the settings shows up even if it was removed from a layout. Pure.
 */
function _todayLayoutsWith(layouts, id) {
  const out = {};
  for (const [bp, l] of Object.entries(layouts || {})) {
    if (!l || l.tiles.some(t => t.id === id)) { out[bp] = l; continue; }
    const col = l.columns.length - 1;
    const order = l.tiles.filter(t => t.col === col).reduce((m, t) => Math.max(m, (t.order ?? 0) + 1), 0);
    out[bp] = { ...l, tiles: [...l.tiles, { id, col, order, size: 'container' }] };
  }
  return out;
}

// ---- Init ----

async function initToday() {
  document.title = 'jc://today/';
  document.body.classList.add('route-today');   /* lighter page background in dark mode (today.css) */
  document.querySelector('.board-area').style.display = 'none';
  document.getElementById('saveIndicator').style.display = 'none';
  document.getElementById('dashboardFetchedAt').style.display = '';
  document.querySelector('.header-menu').style.marginLeft = 'auto';
  ['menuWebhook', 'menuDashboardSettings'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  document.getElementById('today').style.display = 'flex';
  document.getElementById('boardSwitchWrap').style.display = '';
  document.getElementById('dashboardRefreshBtn').style.display = '';
  document.getElementById('dashboardRefreshBtn').title = 'Refresh';

  // The detail panel lives in #dashboard, which is only shown while a view is open here
  document.body.appendChild(document.getElementById('dashboardDetail'));

  const calBtn = document.getElementById('dashboardCalBtn');
  calBtn.style.display = '';
  calBtn.onclick = () => (_cvIsOpen() ? closeCalView() : _todayOpenCal());
  const mailBtn = document.getElementById('dashboardMailBtn');
  mailBtn.style.display = '';
  mailBtn.onclick = () => (_mvIsOpen() ? closeMailView() : _todayOpenMail());
  document.getElementById('dashboardRefreshBtn').addEventListener('click', _todayRefreshAll);
  // Calendar / mail view: the refresh icon sits in the view header (the app header button is hidden then)
  for (const id of ['calViewRefresh', 'mailViewRefresh']) document.getElementById(id).addEventListener('click', _todayRefreshAll);
  // Edit button: last action of the Today bar (_todayRenderBar); the menu item covers phones and a hidden bar
  const menuEdit = document.getElementById('menuTodayEdit');
  menuEdit.style.display = '';
  menuEdit.addEventListener('click', () => {
    document.getElementById('headerDropdown').classList.remove('open');
    document.getElementById('headerMenuBtn').classList.remove('open');
    _todayToggleEdit();
  });

  _todayWireDelegation();

  const [cfg] = await Promise.all([
    fetch('/api/today/config').then(r => r.ok ? r.json() : null).catch(() => null),
    _initOverlayHost(),
  ]);
  _todayCfg = cfg || { showBar: true, refreshMinutes: 1, widgets: {}, layouts: {} };
  _todaySchedule();
  window.addEventListener('pagehide', () => clearInterval(_todayTimer), { once: true });
  // A hidden tab skips its refreshes; catch up as soon as it is visible again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _todayStale && !_todayEdit) loadToday({ quiet: true });
  });

  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (!_todayEdit) _todayRelayout(); else _todayEditResize(); }, 120);
  });
  // The grid's height changes with the Today bar / edit bar (wrapping, weather loaded later)
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => _todayMeasure()).observe(document.getElementById('todayGrid'));
  // Content height changes decide whether a column overflows (_todayFitColumns)
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(_todayScheduleFit);
    mo.observe(document.getElementById('todayGrid'), { childList: true, subtree: true });
    mo.observe(document.getElementById('today'), { attributes: true, attributeFilter: ['class'] });
  }
  document.getElementById('todayGrid').addEventListener('toggle', _todayScheduleFit, true);   // <details>

  _todayRenderBar();
  _todayRelayout();
  // /today?edit=1 (Settings → Today → "Edit layout"): start in edit mode
  const url = new URL(window.location.href);
  if (url.searchParams.get('edit') === '1') {
    url.searchParams.delete('edit');
    history.replaceState(history.state, '', url);
    _todayStartEdit();
  }
  // /today?inbox[&board=<b>] (old /inbox URL, quick-add bookmark): open the add-to-inbox modal
  if (url.searchParams.has('inbox')) {
    const preselect = url.searchParams.get('board');
    url.searchParams.delete('inbox');
    url.searchParams.delete('board');
    history.replaceState(history.state, '', url);
    openInboxModal(preselect, null, () => _todayRefresh('cards'));
  }
  await loadToday();
  _cvInitFromUrl();
  _mvInitFromUrl();
}

async function _todayOpenCal(mode) {
  await _initOverlayHost();
  openCalView(mode);
}

async function _todayOpenMail(accountId) {
  await _initOverlayHost();
  openMailView(accountId);
}

async function _todayNewEvent() {
  await _initOverlayHost();
  const acc = (_calAccountsMeta || []).find(a => (a.type || 'caldav') !== 'ical-url');
  if (!acc) { showMessage('No writable (CalDAV) calendar is configured.'); return; }
  openCalEventModal(acc.accountId, null, acc);
}

async function _todayCompose(prefill = null) {
  await _todayOpenMail();
  // The mail view loads its accounts asynchronously
  for (let i = 0; i < 40 && !(_mvAccounts || []).length; i++) await new Promise(r => setTimeout(r, 100));
  if ((_mvAccounts || []).length) _mvOpenCompose('new', prefill);
}

/** Refresh interval in minutes from the Today config (default 1, 0 = off). */
function _todayRefreshMinutes(cfg) {
  const m = cfg?.refreshMinutes;
  return Number.isInteger(m) && m >= 0 && m <= 60 ? m : 1;
}

function _todaySchedule() {
  clearInterval(_todayTimer);
  _todayTimer = null;
  const min = _todayRefreshMinutes(_todayCfg);
  if (!min) return;
  _todayTimer = setInterval(() => {
    if (document.hidden) { _todayStale = true; return; }
    if (!_todayEdit) loadToday({ quiet: true });
  }, min * 60_000);
}

// ---- Layout application ----

function _todayViewportWidth() {
  if (_todayEdit?.preview) return _TODAY_PREVIEW_W[_todayEdit.bp];
  return document.getElementById('today').clientWidth || window.innerWidth;
}

/** Re-resolve the layout for the current viewport and apply it if it changed. */
function _todayRelayout() {
  const width  = _todayViewportWidth();
  const bp     = _todayBpFor(window.innerWidth);
  const layout = _todayResolveLayout(_todayCfg?.layouts, bp, _todayKnownTiles(), width);
  const changed = bp !== _todayBp || JSON.stringify(layout) !== JSON.stringify(_todayLayout);
  _todayBp = bp;
  _todayLayout = layout;
  if (changed) {
    const before = new Set([...document.querySelectorAll('#todayGrid .today-tile')].map(el => el.dataset.tile));
    _todayApplyLayout(layout);
    // Tiles that just became visible need data
    for (const t of layout.tiles) if (!before.has(t.id) && _todayTileEls.get(t.id)?.dataset.loaded !== '1') _todayLoadTile(t.id);
  }
  _todayMeasure();
}

function _todayTileEl(id) {
  let el = _todayTileEls.get(id);
  if (el) return el;
  const def = TODAY_TILES[id];
  el = document.createElement('section');
  el.className = 'today-tile';
  el.dataset.tile = id;
  el.innerHTML = `<div class="today-tile-header">
      <span class="today-tile-title">${escHtml(def.title)}</span><span class="today-tile-count"></span>
      <span class="today-tile-actions"></span>
      <span class="today-tile-edit">
        <span class="today-tile-handle" title="Drag to move">${SVGICONS.dragHandle(12, 12)}</span>
        <select class="today-tile-size" title="Height relative to the column">${TODAY_SIZES.map(s => `<option value="${s}">${_TODAY_SIZE_LABEL[s] || s}</option>`).join('')}</select>
        <button class="today-tile-hide" title="Hide tile">${SVGICONS.close(10, 10)}</button>
      </span>
    </div>
    <div class="today-tile-body"><p class="dashboard-loading">Loading…</p></div>`;
  // Double-click on the header (not on its buttons / edit controls) collapses / expands the tile
  const header = el.querySelector('.today-tile-header');
  header.title = 'Double-click to hide / show the content';
  header.addEventListener('dblclick', e => {
    if (_todayEdit || e.target.closest('button, select, a, input, .today-tile-handle')) return;
    _todaySetCollapsed(id, !el.classList.contains('today-tile--collapsed'));
  });
  el.classList.toggle('today-tile--collapsed', _todayCollapsed().has(id));
  _todayTileEls.set(id, el);
  return el;
}

/** Tiles collapsed to their header (double-click); per browser. */
function _todayCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('today-collapsed') || '[]')); } catch { return new Set(); }
}

function _todaySetCollapsed(id, collapsed) {
  const set = _todayCollapsed();
  if (collapsed) set.add(id); else set.delete(id);
  try { localStorage.setItem('today-collapsed', JSON.stringify([...set])); } catch { /* ignore */ }
  _todayTileEls.get(id)?.classList.toggle('today-tile--collapsed', collapsed);
  _todayScheduleFit();
  window.getSelection?.()?.removeAllRanges();   // a double-click selects the title text
}

function _todaySetTileActions(id) {
  const el  = _todayTileEls.get(id);
  const box = el?.querySelector('.today-tile-actions');
  if (!box) return;
  box.innerHTML = '';
  for (const a of TODAY_TILES[id].actions?.() || []) {
    const b = document.createElement('button');
    b.className = `today-tile-btn${a.label ? ' today-tile-btn--text' : ''}${a.active ? ' today-tile-btn--on' : ''}`;
    b.title = a.title;
    b.setAttribute('aria-label', a.title);
    if ('active' in a) b.setAttribute('aria-pressed', String(!!a.active));
    if (a.disabled) b.disabled = true;
    b.innerHTML = a.icon || escHtml(a.label);
    b.addEventListener('click', e => { e.stopPropagation(); a.run(); });
    box.appendChild(b);
  }
}

function _todayApplyLayout(layout) {
  const grid = document.getElementById('todayGrid');
  grid.style.gridTemplateColumns = layout.columns.map(c => `minmax(0, ${c.width}fr)`).join(' ');
  grid.dataset.cols = String(layout.columns.length);
  const cols = layout.columns.map((_, i) => {
    const col = document.createElement('div');
    col.className = 'today-col';
    col.dataset.col = String(i);
    return col;
  });
  for (const t of layout.tiles) {
    const el = _todayTileEl(t.id);
    for (const cls of Object.values(_TODAY_SIZE_CLS)) el.classList.remove(`today-tile--${cls}`);
    el.classList.add(`today-tile--${_TODAY_SIZE_CLS[t.size]}`);
    el.dataset.size = t.size;
    el.querySelector('.today-tile-size').value = t.size;
    cols[t.col].appendChild(el);
  }
  grid.replaceChildren(...cols);
}

/** Column height for the fractional tile sizes. */
function _todayMeasure() {
  const root = document.getElementById('today');
  const grid = document.getElementById('todayGrid');
  const bp = _todayEdit?.bp || _todayBpFor(window.innerWidth);   // edit preview: the previewed size
  const single = ((_todayEdit?.draft || _todayLayout)?.columns.length || 1) === 1 && bp === 'sm';
  root.classList.toggle('today--scroll', single);
  const header = document.querySelector('header')?.getBoundingClientRect().bottom || 0;
  const h = single
    ? Math.max(320, window.innerHeight - header - 32)
    : grid.clientHeight;
  root.style.setProperty('--today-col-h', `${Math.max(200, h)}px`);
  _todayFitColumns();
}

const _TODAY_FRAC = { f1: 1, f23: 2 / 3, f12: 1 / 2, f13: 1 / 3 };

/**
 * Height a column's tiles need: fixed sizes as set (n × column height minus their share of the
 * gaps), collapsed tiles their header, "fit content" / "available" tiles header + full content.
 * Pure apart from reading the given measurements.
 */
function _todayColumnNeed(tiles, colH, gap) {
  let total = 0;
  for (const t of tiles) {
    const f = _TODAY_FRAC[_TODAY_SIZE_CLS[t.size]];
    if (t.collapsed)  total += t.headerH;
    else if (f)       total += colH * f - gap * (1 - f);
    else              total += t.headerH + t.contentH;
  }
  return total + gap * Math.max(0, tiles.length - 1);
}

/**
 * A column whose tiles need more than its height scrolls anyway: there its "available" tile shows
 * all content (`today-col--over`), and on multi-column layouts the headers become a sticky stack
 * (`today-col--stack`, see today.css). Off while editing — the editor measures the tile boxes.
 */
function _todayFitColumns() {
  const root = document.getElementById('today');
  if (!root) return;
  const colH    = parseFloat(root.style.getPropertyValue('--today-col-h')) || 0;
  const gap     = parseFloat(getComputedStyle(root).getPropertyValue('--today-gap')) || 0;
  const single  = root.classList.contains('today--scroll');
  let headerMax = 0;
  for (const col of document.querySelectorAll('#todayGrid .today-col')) {
    const els = [...col.querySelectorAll(':scope > .today-tile')];
    const tiles = els.map(el => {
      const headerH = el.querySelector('.today-tile-header')?.offsetHeight || 0;
      headerMax = Math.max(headerMax, headerH);
      return {
        size: el.dataset.size, headerH,
        collapsed: el.classList.contains('today-tile--collapsed'),
        contentH: el.querySelector('.today-tile-body')?.scrollHeight || 0,
      };
    });
    const over = !_todayEdit && els.length > 0 && colH > 0 && _todayColumnNeed(tiles, colH, gap) > colH + 1;
    col.classList.toggle('today-col--over', over);
    col.classList.toggle('today-col--stack', over && !single);
    col.style.setProperty('--today-stack-n', String(els.length));
    els.forEach((el, i) => el.style.setProperty('--today-stack-i', String(i)));
  }
  // Stacked headers share one fixed height (headers never wrap, so stacked and free ones match)
  if (headerMax) root.style.setProperty('--today-hdr-h', `${headerMax}px`);
}

/** Re-fit after content changes (tile renders, opened <details>, edit mode on / off); once per frame. */
let _todayFitRaf = 0;
function _todayScheduleFit() {
  if (_todayFitRaf) return;
  _todayFitRaf = requestAnimationFrame(() => { _todayFitRaf = 0; _todayFitColumns(); });
}

// ---- Loading ----

async function loadToday({ quiet = false } = {}) {
  _todayFetchMemo = new Map();
  if (!quiet) _todayWeatherCache = null;   // manual refresh / settings change: fresh weather
  _todayStale = false;
  const fetchedAt = document.getElementById('dashboardFetchedAt');
  clearTimeout(_fetchedAtTimer);
  fetchedAt.classList.add('show');
  fetchedAt.textContent = 'Loading…';
  _todayRenderBar();
  const ids = (_todayEdit?.draft || _todayLayout)?.tiles.map(t => t.id) || [];
  const results = await Promise.all(ids.map(id => _todayLoadTile(id, { keepState: quiet })));
  fetchedAt.textContent = (results.includes(false) ? 'Partial load — ' : 'Refreshed at ') +
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  _fetchedAtTimer = setTimeout(() => fetchedAt.classList.remove('show'), 10000);
}

/**
 * UI state of a tile body that a re-render would reset: scroll position, open <details>
 * (by data-key / class + index) and expanded (i) infos. `_todayRestoreState` reapplies it.
 */
function _todayDetailsKeys(body) {
  const seen = new Map();
  return [...body.querySelectorAll('details')].map(d => {
    const base = d.dataset.key || d.className;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return [`${base}#${n}`, d];
  });
}

function _todaySaveState(body) {
  return {
    scroll: body.scrollTop,
    details: new Map(_todayDetailsKeys(body).map(([k, d]) => [k, d.open])),
    infos: [...body.querySelectorAll('[data-info]:not([hidden])')].map(i => i.dataset.info),
    // An input being typed in (Notes filter) keeps focus and caret
    focus: body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'
      ? { cls: document.activeElement.className, caret: document.activeElement.selectionStart } : null,
  };
}

function _todayRestoreState(body, st) {
  for (const [k, d] of _todayDetailsKeys(body)) if (st.details.has(k)) d.open = st.details.get(k);
  for (const key of st.infos) {
    const info = [...body.querySelectorAll('[data-info]')].find(i => i.dataset.info === key);
    const btn  = [...body.querySelectorAll('[data-info-btn]')].find(b => b.dataset.infoBtn === key);
    if (!info || !btn) continue;
    info.hidden = false;
    btn.classList.add('today-info-btn--open');
    btn.setAttribute('aria-expanded', 'true');
  }
  body.scrollTop = st.scroll;
  const input = st.focus && [...body.querySelectorAll('input')].find(i => i.className === st.focus.cls);
  if (input) { input.focus(); if (st.focus.caret != null) input.setSelectionRange(st.focus.caret, st.focus.caret); }
}

async function _todayLoadTile(id, { keepState = false } = {}) {
  const def = TODAY_TILES[id];
  const el  = _todayTileEl(id);
  const body = el.querySelector('.today-tile-body');
  _todaySetTileActions(id);
  try {
    const data = await def.load();
    const st = keepState && el.dataset.loaded === '1' ? _todaySaveState(body) : null;
    def.render(body, data, el);
    body.querySelectorAll('[data-hscroll]').forEach(_todayHScroll);
    if (st) _todayRestoreState(body, st);
    el.dataset.loaded = '1';
    return true;
  } catch (err) {
    // A failed background refresh keeps what is shown
    if (keepState && el.dataset.loaded === '1') return false;
    el.querySelector('.today-tile-count').textContent = '';
    body.innerHTML = err.status === 400
      ? `<p class="dashboard-empty">${escHtml(err.message)}. <a href="#" class="today-setup-link">Set up</a></p>`
      : `<p class="dashboard-empty">Failed to load${err.message ? `: ${escHtml(err.message)}` : ''}.</p>`;
    return false;
  }
}

/**
 * Horizontal overflow without a scrollbar: wrap `scroller` and show ‹ / › buttons only while
 * there is content to that side.
 */
function _todayHScroll(scroller) {
  if (scroller.parentElement?.classList.contains('today-hscroll')) return;
  const wrap = document.createElement('div');
  wrap.className = 'today-hscroll';
  const btn = (dir, label) => {
    const b = document.createElement('button');
    b.className = `today-hscroll-btn today-hscroll-btn--${dir}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.textContent = dir === 'left' ? '\u2039' : '\u203a';
    b.addEventListener('click', e => {
      e.stopPropagation();
      scroller.scrollBy({ left: (dir === 'left' ? -1 : 1) * Math.max(80, scroller.clientWidth * 0.8), behavior: 'smooth' });
    });
    return b;
  };
  const left = btn('left', 'Scroll left'), right = btn('right', 'Scroll right');
  scroller.replaceWith(wrap);
  wrap.append(left, scroller, right);
  const update = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    left.hidden  = scroller.scrollLeft <= 1;
    right.hidden = scroller.scrollLeft >= max - 1;
  };
  scroller.addEventListener('scroll', update, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(scroller);
  update();
}

function _todaySetCount(el, n) {
  el.querySelector('.today-tile-count').textContent = n ? String(n) : '';
}

// ---- Today bar ----

function _todayMarkEditBtn(on) {
  const b = document.getElementById('todayEditBtn');
  if (!b) return;
  b.classList.toggle('today-bar-btn--on', on);
  b.setAttribute('aria-pressed', String(on));
}

function _todayRefreshAll() {
  loadToday();
  if (_cvIsOpen()) _cvLoad();
  if (_mvIsOpen()) _mvReload();
}

/** Refresh lives in the Today bar (phones: in its first line, see today.css) and in the calendar / mail
 *  view header — the app header button only while the bar is hidden and no view is open. */
function _todaySyncRefreshBtn() {
  const inView = _cvIsOpen() || _mvIsOpen();
  const btn = document.getElementById('dashboardRefreshBtn');
  btn.classList.toggle('in-today-bar', _todayCfg?.showBar !== false && !inView);
  btn.classList.toggle('in-view-bar', inView);
}

function _todayToggleEdit() {
  return _todayEdit ? _todayEndEdit(false) : _todayStartEdit();
}

async function _todayRenderBar() {
  const bar = document.getElementById('todayBar');
  const show = _todayCfg?.showBar !== false;
  bar.style.display = show ? '' : 'none';
  _todaySyncRefreshBtn();
  if (!show) return;
  const now = new Date();
  const dateStr = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  bar.innerHTML = `<div class="today-bar-date"><strong>${escHtml(dateStr)}</strong><span class="today-bar-week">CW ${_todayIsoWeek(now)}</span></div>
    <div class="today-bar-weather" id="todayBarWeather"></div>
    <button class="btn today-bar-refresh-sm" data-bar="refresh" title="Refresh" aria-label="Refresh">${SVGICONS.sync(14, 14)}</button>
    <div class="today-bar-actions">
      <button class="btn" data-bar="inbox" title="Add a card to an inbox">${SVGICONS.create(12, 12)}<span>Card</span></button>
      <button class="btn" data-bar="event" title="New calendar event">${SVGICONS.date(12, 12)}<span>Event</span></button>
      <button class="btn" data-bar="mail" title="Write a mail">${SVGICONS.email(12, 12)}<span>Mail</span></button>
      <button class="btn today-bar-refresh" data-bar="refresh" title="Refresh" aria-label="Refresh">${SVGICONS.sync(12, 12)}</button>
      <button class="btn today-bar-edit${_todayEdit ? ' today-bar-btn--on' : ''}" id="todayEditBtn" data-bar="edit" title="Edit layout" aria-label="Edit layout" aria-pressed="${!!_todayEdit}">${SVGICONS.edit(12, 12)}</button>
    </div>`;
  bar.querySelector('[data-bar="inbox"]').addEventListener('click', () => openInboxModal(null, null, () => loadToday()));
  bar.querySelector('[data-bar="event"]').addEventListener('click', _todayNewEvent);
  bar.querySelector('[data-bar="mail"]').addEventListener('click', () => _todayCompose());
  bar.querySelectorAll('[data-bar="refresh"]').forEach(b => b.addEventListener('click', _todayRefreshAll));   // actions (≥ 768 px) / first line (phones)
  bar.querySelector('[data-bar="edit"]').addEventListener('click', _todayToggleEdit);
  const w = _todayCfg?.widgets?.weather;
  if (!w || w.lat == null) return;
  try {
    const data = await _todayWeather();
    const el = document.getElementById('todayBarWeather');
    if (!el) return;
    const kind = _todayWeatherKind(data.current.code, data.current.isDay);
    const rain = _todayNextRain(data.hours);
    const t = v => v == null ? '–' : `${Math.round(v)}°`;
    // Icon + temperature only; the rest is in the tooltip and the weather tile
    el.innerHTML = `<span class="today-wx-icon">${SVGICONS[kind.icon](20, 20)}</span><strong>${t(data.current.temp)}</strong>`;
    el.title = [data.label, kind.label, `${t(data.today?.min)} / ${t(data.today?.max)}`,
      rain ? `rain ${rain.precip} % from ${rain.time.slice(11, 16)}` : ''].filter(Boolean).join(' · ');
  } catch { /* weather is optional in the bar */ }
}

// ---- Agenda ----

async function _todayLoadAgenda() {
  await _initOverlayHost();
  const today = _todayToday();
  const to    = _todayAddDays(today, _todayAgendaRange(_todayCfg));   // exclusive
  const accounts = _calAccountsConfig || [];
  const [cards, ...cal] = await Promise.all([
    _todayFetchJson(_todayCardsUrl()),
    ...accounts.map(acc => _todayFetchJson(`/api/dashboard/calendar/${encodeURIComponent(acc.id)}?from=${today}&to=${to}`)
      .then(d => ({ acc, events: d.events || [], error: d.error || null }))
      .catch(err => ({ acc, events: [], error: err.message }))),
  ]);
  const events = [];
  for (const { acc, events: evs } of cal) {
    for (const ev of evs) {
      const tagged = { ...ev, _label: acc.label, _accountId: acc.id, _webUrl: acc.webInterfaceUrl || '', _color: acc.color || null, _accountType: acc.type || 'caldav' };
      _calEventMap.set(`${acc.id}\0${ev.uid}`, tagged);
      events.push(tagged);
    }
  }
  return { cards, events, errors: cal.filter(c => c.error).map(c => `${c.acc.label || c.acc.id}: ${c.error}`), accounts: accounts.length };
}

/** Some calendars deliver text with HTML entities ("Klettern &amp; Bouldern") — decode before escaping. */
function _todayDecodeEntities(str) {
  if (!str || !/&(#\d+|#x[\da-f]+|[a-z]+);/i.test(str)) return str || '';
  const t = document.createElement('textarea');
  t.innerHTML = str;   // a textarea never runs or renders markup — only entities are resolved
  return t.value;
}

/** Online-meeting providers recognised in an event's location / description (host + path). */
const _TODAY_MEETING_PROVIDERS = [
  { name: 'Teams',       re: /^https:\/\/(teams\.microsoft\.com|teams\.live\.com)\/(l\/meetup-join|meet)\//i },
  { name: 'Webex',       re: /^https:\/\/([\w-]+\.)*webex\.com\//i },
  { name: 'Google Meet', re: /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i },
  { name: 'Zoom',        re: /^https:\/\/([\w-]+\.)*zoom(gov)?\.(us|com)\/(j|w|my|s)\//i },
];

/** First Teams / Webex / Google Meet / Zoom link in the location, else in the description → { name, url } | null. */
function _todayMeetingLink(ev) {
  for (const text of [ev.location, ev.description]) {
    const urls = _todayDecodeEntities(text || '').match(/https:\/\/[^\s<>"'`\])}|]+/gi) || [];
    for (const raw of urls) {
      const url = raw.replace(/[.,;:!?]+$/, '');
      const p = _TODAY_MEETING_PROVIDERS.find(p => p.re.test(url));
      if (p) return { name: p.name, url };
    }
  }
  return null;
}

function _todayMeetingHtml(meet) {
  return meet ? `<a class="today-ev-meet" href="${escHtml(meet.url)}" target="_blank" rel="noopener noreferrer" title="Join the ${escHtml(meet.name)} meeting in a new tab">${SVGICONS.openLink(11, 11)} ${escHtml(meet.name)}</a>` : '';
}

function _todayEventHtml(item, day) {
  const ev = item.ev;
  const meet = _todayMeetingLink(ev);
  const color = ev._color ? ` style="--card-color:${escHtml(ev._color)}"` : '';
  const refs  = ev.cardRefs?.length ? `<span class="today-ev-link" title="Linked to a card">${SVGICONS.card(12, 8)}</span>` : '';
  const attrs = `data-account-id="${escHtml(ev._accountId)}" data-uid="${escHtml(ev.uid)}" data-web-url="${escHtml(ev._webUrl || '')}"`;
  if (item.kind === 'event' && (ev.allDay || item.continues)) {
    return `<div class="today-chip today-ev" ${attrs}${color} title="${escHtml(`${_todayDecodeEntities(ev.title)}\n${_calEventWhen(ev)}`)}">${item.continues ? '<span class="today-muted">cont.</span> ' : ''}${escHtml(_todayDecodeEntities(ev.title))}${refs}${_todayMeetingHtml(meet)}</div>`;
  }
  const end = ev.end && ev.end !== ev.start ? `–${_todayFmtTime(ev.end)}` : '';
  const endsLater = ev.end && _todayLocalDay(new Date(new Date(ev.end) - 1)) > day ? ' →' : '';
  return `<div class="today-ev today-ev-row${item.past ? ' today-ev--past' : ''}" ${attrs}${color}>
    <span class="today-ev-time">${escHtml(_todayFmtTime(ev.start))}${escHtml(end)}${endsLater}</span>
    <span class="today-ev-title">${(() => {
      const title = _todayDecodeEntities(ev.title);
      let loc = _todayDecodeEntities(ev.location).trim();
      if (meet && loc === meet.url) loc = '';   // the link replaces a bare meeting URL
      return `<span class="today-ev-line" title="${escHtml(title)}">${escHtml(title)}</span>`
        + (loc ? `<span class="today-ev-line today-ev-loc" title="${escHtml(loc)}">${escHtml(loc)}</span>` : '')
        + (meet ? `<span class="today-ev-line">${_todayMeetingHtml(meet)}</span>` : '');
    })()}</span>${refs}
  </div>`;
}

function _todayDayHtml(model, { isToday }) {
  const parts = [];
  // All-day row: events only; cards (starting / due) are listed below in the card style
  const chips  = model.allDay.filter(it => it.kind === 'event').map(it => _todayEventHtml(it, model.day));
  const starts = model.allDay.filter(it => it.kind === 'card');
  if (chips.length) parts.push(`<div class="today-allday">${chips.join('')}</div>`);
  const rows = model.timed.map(it => _todayEventHtml(it, model.day));
  if (isToday && model.nowIndex >= 0) {
    rows.splice(model.nowIndex, 0, `<div class="today-now" data-now="1"><span>${escHtml(_todayFmtTime(new Date().toISOString()))}</span></div>`);
  }
  if (rows.length) parts.push(`<div class="today-timeline">${rows.join('')}</div>`);
  const cardList = (label, items) => `<div class="today-subhead">${label}</div><div class="today-card-list">${items.map(_todayKanbanCardHtml).join('')}</div>`;
  if (starts.length)     parts.push(cardList(isToday ? 'Starts today' : 'Starts', starts));
  if (model.due.length)  parts.push(cardList(isToday ? 'Due today' : 'Due', model.due));
  return parts.join('');
}

function _todayDayCount(m) { return m.allDay.length + m.timed.length + m.due.length; }

function _todayRenderAgenda(body, data, el) {
  const range = _todayAgendaRange(_todayCfg);
  const days  = _todayAgendaDays(data.events, data.cards, _todayToday(), range, new Date());
  const [t0, ...rest] = days;
  const n0 = _todayDayCount(t0);
  _todaySetCount(el, range === 7 ? days.reduce((s, d) => s + _todayDayCount(d), 0) : n0);
  const errors = data.errors.map(e => `<div class="dashboard-source-error">\u26a0 ${escHtml(e)}</div>`).join('');
  const todayHtml = n0 ? _todayDayHtml(t0, { isToday: true })
    : `<p class="dashboard-empty">${data.accounts ? 'Nothing scheduled today.' : 'Nothing due today. No calendar accounts configured.'}</p>`;

  if (range === 7) {
    // Upcoming week: one compact section per day
    const label = (m, i) => i === 0 ? 'Tomorrow'
      : _todayDayStart(m.day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
    const weekHtml = rest.map((m, i) => {
      const n = _todayDayCount(m);
      return `<section class="today-day${n ? '' : ' today-day--empty'}">
        <div class="today-day-head"><span>${escHtml(label(m, i))}</span>${n ? `<span class="today-muted">${n}</span>` : '<span class="today-muted">nothing scheduled</span>'}</div>
        ${n ? _todayDayHtml(m, { isToday: false }) : ''}
      </section>`;
    }).join('');
    body.innerHTML = errors + `<div class="today-day-head today-day-head--first"><span>Today</span></div>` + todayHtml + weekHtml;
    return;
  }

  const t1 = rest[0];
  const n1 = _todayDayCount(t1);
  let open = false;
  try { open = localStorage.getItem('today-tomorrow-open') === '1'; } catch { /* ignore */ }
  const tomorrowHtml = `<details class="today-tomorrow"${open ? ' open' : ''}>
      <summary>Tomorrow <span class="today-muted">${n1 ? `${t1.allDay.length + t1.timed.length} events \u00b7 ${t1.due.length} due` : 'nothing scheduled'}</span></summary>
      ${n1 ? _todayDayHtml(t1, { isToday: false }) : ''}
    </details>`;
  body.innerHTML = errors + todayHtml + tomorrowHtml;
  body.querySelector('.today-tomorrow').addEventListener('toggle', e => {
    try { localStorage.setItem('today-tomorrow-open', e.target.open ? '1' : '0'); } catch { /* ignore */ }
  });
}

/** Agenda range toggle: applied at once, saved in the Today config (same on all devices). */
async function _todaySetAgendaRange(days) {
  const widgets = { ...(_todayCfg.widgets || {}), agenda: { days } };
  _todayCfg = { ..._todayCfg, widgets };
  _todayFetchMemo.delete(_todayCardsUrl());
  _todayLoadTile('agenda');
  try {
    const res = await fetch('/api/today/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ widgets }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    _todayCfg = data.config;
  } catch (err) {
    showMessage(`Could not save the agenda range: ${err.message}`);
  }
}

// ---- Needs attention ----

async function _todayLoadAttention() {
  const [cards, mail] = await Promise.all([
    _todayFetchJson(_todayCardsUrl()),
    _todayFetchJson('/api/dashboard/mail').catch(() => []),
  ]);
  return { cards, mail };
}

function _todayRenderAttention(body, data, el) {
  const { cards, mail } = data;
  _mailAccountsMeta = Array.isArray(mail) ? mail : [];
  const unreadMail = [];
  for (const acc of _mailAccountsMeta) {
    for (const msg of acc.messages || []) {
      if (msg.unread) unreadMail.push({ acc, msg });
      // Linked cards for the mail context menu ("Open card")
      if (msg.cardRefs?.length) _mailCardRefs.set(`${acc.accountId}\0${msg.id}`, msg.cardRefs);
    }
  }
  unreadMail.sort((a, b) => String(b.msg.date || '').localeCompare(String(a.msg.date || '')));
  const accCount = new Set(unreadMail.map(m => m.acc.accountId)).size;

  const rows = [];
  const row = (key, cls, icon, count, label, listHtml, more = '') => {
    if (!count) return;
    let open = false;
    try { open = JSON.parse(localStorage.getItem('today-att-open') || '{}')[key] === true; } catch { /* ignore */ }
    rows.push(`<details class="today-att ${cls}" data-key="${key}"${open ? ' open' : ''}>
      <summary><span class="today-att-icon">${icon}</span><span class="today-att-count">${count}</span><span class="today-att-label">${label}</span>${more}</summary>
      <div class="today-att-list">${listHtml}</div>
    </details>`);
  };
  const moreNote = (shown, total) => total > shown ? `<p class="today-muted today-more">+ ${total - shown} more</p>` : '';
  // Each mail / card row sits in a wrapper: on small screens it slides inside it to reveal swipe actions
  const sw = html => `<div class="today-swipe">${html}</div>`;
  const cardsHtml = list => list.slice(0, 15).map(it => sw(_todayKanbanCardHtml(it))).join('');
  row('mail', 'today-att--mail', SVGICONS.email(12, 12), unreadMail.length,
    `unread ${unreadMail.length === 1 ? 'mail' : 'mails'}${accCount > 1 ? ` <span class="today-muted">(${accCount} accounts)</span>` : ''}`,
    unreadMail.slice(0, 8).map(({ acc, msg }) => sw(`<div class="today-mail-row dashboard-mail-item" data-account-id="${escHtml(acc.accountId)}" data-msg-id="${escHtml(msg.id)}" data-unread="1" data-web-url="${escHtml(acc.webInterfaceUrl || '')}"${acc.color ? ` style="--card-color:${escHtml(acc.color)}"` : ''}>
        <span class="today-row-main"><span class="today-row-title card-text"><strong>${escHtml(msg.subject || '(no subject)')}</strong></span>
        <span class="today-row-meta"><span>${escHtml(_mailDisplayName(msg.from))}</span><span class="today-row-date">${escHtml(msg.date ? _fmtRecentDate(msg.date) : '')}</span></span></span>
      </div>`)).join('') + moreNote(Math.min(8, unreadMail.length), unreadMail.length)
      + '<button class="today-link-btn" data-act="mailview">Open mail view →</button>');
  row('overdue', 'today-att--danger', '⚠', cards.counts.overdue, cards.counts.overdue === 1 ? 'overdue card' : 'overdue cards',
    cardsHtml(cards.overdue) + moreNote(Math.min(15, cards.overdue.length), cards.counts.overdue));
  row('due', 'today-att--warn', '●', cards.counts.dueToday, 'due today',
    cardsHtml(cards.dueToday) + moreNote(Math.min(15, cards.dueToday.length), cards.counts.dueToday));
  // Due soon: the next _TODAY_SOON_DAYS days after today
  const soonEnd = _todayAddDays(_todayToday(), _TODAY_SOON_DAYS);
  const dueSoon = (cards.dueWeek || []).filter(it => it.card.endDate <= soonEnd);
  row('soon', 'today-att--soon', '\u25d4', dueSoon.length, `due in the next ${_TODAY_SOON_DAYS === 1 ? 'day' : `${_TODAY_SOON_DAYS} days`}`,
    cardsHtml(dueSoon) + moreNote(Math.min(15, dueSoon.length), dueSoon.length));
  row('new', 'today-att--new', '✱', cards.counts.unread, cards.counts.unread === 1 ? 'new card' : 'new cards',
    cardsHtml(cards.unread) + moreNote(Math.min(15, cards.unread.length), cards.counts.unread));
  const mailErrors = _mailAccountsMeta.filter(a => a.error).map(a => `<div class="dashboard-source-error">⚠ ${escHtml(a.label || a.accountId)}: ${escHtml(a.error)}</div>`).join('');

  _todaySetCount(el, unreadMail.length + cards.counts.overdue + cards.counts.dueToday + dueSoon.length + cards.counts.unread);
  body.innerHTML = mailErrors + (rows.length ? rows.join('') : `<p class="today-all-clear">${ICONS.done} All clear</p>`);
  body.querySelectorAll('details.today-att').forEach(d => d.addEventListener('toggle', () => {
    try {
      const st = JSON.parse(localStorage.getItem('today-att-open') || '{}');
      st[d.dataset.key] = d.open;
      localStorage.setItem('today-att-open', JSON.stringify(st));
    } catch { /* ignore */ }
  }));
  body.querySelector('[data-act="mailview"]')?.addEventListener('click', () => _todayOpenMail());
  _todaySwipeOpen = null;
  if (!body._todaySwipeWired) { body._todaySwipeWired = true; _todayWireSwipe(body); }
}

// ---- Swipe actions on small screens (Needs attention) ----
// Like the mail view's message list (mailview.js — same CSS, _mvSwipeSnap, _MV_SWIPE_BTN):
// mails: right → Mark as read, left → Move (folder) + Delete; cards: right → Edit, left → Move (column) + Delete.

const _TODAY_SWIPE_MQ = '(max-width: 767px), (max-height: 500px)';
let _todaySwipeOpen = null;   // { row, offset } of the row that is swiped open

function _todaySwipeLayers(row) {
  const wrap = row.parentElement;
  let start = wrap.querySelector(':scope > .mv-swipe-actions--start');
  let end   = wrap.querySelector(':scope > .mv-swipe-actions--end');
  if (!end) {
    const mail = row.classList.contains('today-mail-row');
    const btn = (act, icon, label, cls) =>
      `<button type="button" class="mv-swipe-btn mv-swipe-btn--${cls}" data-today-swipe="${act}" title="${label}" aria-label="${label}">${icon}</button>`;
    wrap.insertAdjacentHTML('afterbegin',
      `<div class="mv-swipe-actions mv-swipe-actions--start">${mail
        ? btn('read', SVGICONS.markRead(20, 20), 'Mark as read', 'read')
        : btn('edit', SVGICONS.edit(20, 20), 'Edit', 'read')}</div>`
      + `<div class="mv-swipe-actions mv-swipe-actions--end">${btn('move', SVGICONS.moveTo(20, 20), mail ? 'Move to folder' : 'Move to column', 'move')}`
      + `${btn('delete', SVGICONS.delete(20, 20), 'Delete', 'delete')}</div>`);
    start = wrap.querySelector(':scope > .mv-swipe-actions--start');
    end   = wrap.querySelector(':scope > .mv-swipe-actions--end');
  }
  return { start, end, startW: _MV_SWIPE_BTN, endW: end.children.length * _MV_SWIPE_BTN };
}

function _todaySwipeSet(row, offset, animate) {
  const { start, end } = _todaySwipeLayers(row);
  for (const el of [row, start, end]) el.classList.toggle('mv-swipe-anim', !!animate);
  row.style.transform = offset ? `translateX(${offset}px)` : '';
  start.style.width = `${Math.max(0, offset)}px`;
  end.style.width   = `${Math.max(0, -offset)}px`;
}

function _todaySwipeClose(animate = true) {
  if (!_todaySwipeOpen) return;
  const { row } = _todaySwipeOpen;
  _todaySwipeOpen = null;
  if (!row.isConnected) return;
  _todaySwipeSet(row, 0, animate);
  setTimeout(() => {
    if (_todaySwipeOpen?.row !== row) row.parentElement?.querySelectorAll(':scope > .mv-swipe-actions').forEach(el => el.remove());
  }, animate ? 220 : 0);
}

async function _todaySwipeAction(act, row) {
  _todaySwipeClose(false);
  if (row.classList.contains('today-mail-row')) {
    const { accountId, msgId } = row.dataset;
    if (act === 'read') _mailToggleRead(accountId, msgId, true);
    else if (act === 'delete') _mailDelete(accountId, msgId);
    else if (act === 'move') {
      const folder = await _todayPickMailFolder(accountId);
      if (folder) _mailMove(accountId, msgId, folder);
    }
    return;
  }
  const entry = _todayCardMap.get(row.dataset.cardKey);
  if (!entry) return;
  const { board, card } = entry;
  if (act === 'edit') { _todayEditCard(board, card.id); return; }
  try {
    if (act === 'delete') {
      if (!await showConfirm(`Delete card "${card.text}"?`, { okLabel: 'Delete', danger: true })) return;
      await _dashDeleteCard(board, card.id);
      _todayFlash('Card deleted');
    } else if (act === 'move') {
      const data = await fetch(`/api/${encodeURIComponent(board)}/board`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
      const from = data.columns.find(c => c.cards.some(x => x.id === card.id));
      if (!from) throw new Error('card not found');
      const to = await _todayPick('Move to column', data.columns.filter(c => c !== from)
        .map(c => ({ value: c.id, label: c.title, icon: `<span class="today-pick-dot" style="--card-color:${escHtml(c.color || 'var(--text-muted)')}"></span>` })));
      if (!to) return;
      await _dashMoveCard(board, card.id, from.id, to);
      _todayFlash(`Moved to ${escHtml(data.columns.find(c => c.id === to)?.title || '')}`);
    }
  } catch (err) {
    showMessage(`Could not ${act === 'delete' ? 'delete' : 'move'} the card: ${err.message}`);
  }
  _todayRefresh('cards');
}

/** Folder of the account to move a mail to: recent folders first, then all (indented by depth). */
async function _todayPickMailFolder(accountId) {
  let folders;
  try {
    const res = await fetch(`/api/dashboard/mail/${encodeURIComponent(accountId)}/folders`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    folders = ((await res.json()).folders || []).filter(f => !f.noselect);
  } catch (err) {
    showMessage(`Could not load the mail folders: ${err.message}`);
    return null;
  }
  const current = _mailAccountsMeta.find(a => a.accountId === accountId)?.folder || 'INBOX';
  folders = folders.filter(f => f.path !== current).sort((a, b) => a.path.localeCompare(b.path));
  const icon = SVGICONS.folder(12, 12);
  const item = f => ({ value: f.path, label: f.name || f.path, icon,
    depth: f.delimiter ? f.path.split(f.delimiter).length - 1 : 0 });
  const recents = _getRecentFolders(accountId).map(p => folders.find(f => f.path === p)).filter(Boolean);
  return _todayPick('Move to folder', [
    ...recents.map(f => ({ ...item(f), depth: 0 })),
    ...(recents.length ? [{ separator: true }] : []),
    ...folders.map(item),
  ], { filter: folders.length > 8 });
}

/** Small modal list (mail view picker look); resolves with the chosen value or null. */
function _todayPick(title, items, { filter = false } = {}) {
  document.querySelector('.today-picker')?._todayDone?.(null);
  const box = document.createElement('div');
  box.className = 'mv-picker today-picker';
  box.innerHTML = `<div class="mv-picker-box" role="dialog" aria-modal="true">
      <div class="mv-picker-title">${escHtml(title)}</div>
      ${filter ? '<input type="search" class="modal-input mv-picker-filter" placeholder="Filter…" autocomplete="off" spellcheck="false">' : ''}
      <div class="mv-picker-list">${items.map(it => it.separator ? '<div class="ctx-separator"></div>'
        : `<button class="mv-picker-item" data-pick="${escHtml(it.value)}" style="--mv-depth:${it.depth || 0}">${it.icon || ''}<span>${escHtml(it.label)}</span></button>`).join('')
        || '<p class="today-muted">Nothing to choose from.</p>'}</div>
      <div class="mv-picker-foot"><button class="btn" data-pick-cancel="1">Cancel</button></div>
    </div>`;
  document.body.appendChild(box);
  return new Promise(resolve => {
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    const done = v => { box.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    box._todayDone = done;
    document.addEventListener('keydown', onKey, true);
    box.addEventListener('click', e => {
      if (e.target === box || e.target.closest('[data-pick-cancel]')) { done(null); return; }
      const it = e.target.closest('[data-pick]');
      if (it) done(it.dataset.pick);
    });
    box.querySelector('.mv-picker-filter')?.addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      box.querySelectorAll('.mv-picker-item').forEach(el => { el.hidden = !!q && !el.textContent.toLowerCase().includes(q); });
      box.querySelectorAll('.ctx-separator').forEach(el => { el.hidden = !!q; });
    });
  });
}

/** Touch swipe on the rows of the Needs attention tile (small screens only, not while editing the layout). */
function _todayWireSwipe(body) {
  let g = null;   // gesture: { row, x0, y0, base, mode: 'pending' | 'swipe', startW, endW, offset, closedOther }
  let suppressClick = 0;
  body.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || _todayEdit || !matchMedia(_TODAY_SWIPE_MQ).matches) return;
    if (e.target.closest('.mv-swipe-actions, .today-check, .card-link-badge')) return;
    const row = e.target.closest('.today-swipe > :is(.today-mail-row, .today-kcard)');
    if (!row) return;
    const closedOther = !!_todaySwipeOpen && _todaySwipeOpen.row !== row;
    if (closedOther) _todaySwipeClose();
    g = { row, x0: e.clientX, y0: e.clientY, base: _todaySwipeOpen?.row === row ? _todaySwipeOpen.offset : 0, mode: 'pending', offset: 0, closedOther };
  });
  body.addEventListener('pointermove', e => {
    if (!g || e.pointerType !== 'touch') return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.mode === 'pending') {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }   // vertical: let the page scroll
      if (Math.abs(dx) < 10) return;
      g.mode = 'swipe';
      Object.assign(g, _todaySwipeLayers(g.row));
    }
    const raw = g.base + dx;
    const max = raw > 0 ? g.startW : g.endW;
    const over = Math.abs(raw) - max;
    g.offset = over > 0 ? Math.sign(raw) * (max + over / 4) : raw;   // rubber band beyond the actions
    _todaySwipeSet(g.row, g.offset, false);
  });
  const end = e => {
    if (!g || e.pointerType !== 'touch') return;
    const done = g;
    g = null;
    if (done.mode !== 'swipe') {
      if (_todaySwipeOpen?.row === done.row) { suppressClick = Date.now(); _todaySwipeClose(); }
      else if (done.closedOther) suppressClick = Date.now();
      return;
    }
    suppressClick = Date.now();
    const target = e.type === 'pointercancel' ? 0 : _mvSwipeSnap(done.offset, done.startW, done.endW);
    _todaySwipeOpen = { row: done.row, offset: target };
    if (target) _todaySwipeSet(done.row, target, true);
    else _todaySwipeClose();
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
  // Capture: a swipe or the closing tap must not also open the card / mail
  body.addEventListener('click', e => {
    const btn = e.target.closest('[data-today-swipe]');
    if (btn) {
      e.stopPropagation();
      _todaySwipeAction(btn.dataset.todaySwipe, btn.closest('.today-swipe').querySelector(':scope > :is(.today-mail-row, .today-kcard)'));
      return;
    }
    if (Date.now() - suppressClick < 400) { e.stopPropagation(); e.preventDefault(); return; }
    if (_todaySwipeOpen) { e.stopPropagation(); _todaySwipeClose(); }
  }, true);
  window.addEventListener('scroll', () => { if (_todaySwipeOpen && !g) _todaySwipeClose(); }, { passive: true, capture: true });
}

// ---- Weather ----

function _todayRenderWeather(body, data, el) {
  _todaySetCount(el, 0);
  const kind = _todayWeatherKind(data.current.code, data.current.isDay);
  const t = v => v == null ? '–' : `${Math.round(v)}°`;
  const hm = s => (s || '').slice(11, 16);
  const tomorrow = data.tomorrow ? _todayWeatherKind(data.tomorrow.code) : null;
  body.innerHTML = `<div class="today-wx">
      <span class="today-wx-big">${SVGICONS[kind.icon](40, 40)}</span>
      <div class="today-wx-now"><strong>${t(data.current.temp)}</strong><span>${escHtml(kind.label)}</span>
        <span class="today-muted">${escHtml(data.label || '')}</span></div>
      <div class="today-wx-day">
        <span>${t(data.today?.min)} / ${t(data.today?.max)}</span>
        ${data.today?.precipMax != null ? `<span class="today-muted">rain ${data.today.precipMax} %</span>` : ''}
        ${data.today?.sunrise ? `<span class="today-muted">☀ ${escHtml(hm(data.today.sunrise))}–${escHtml(hm(data.today.sunset))}</span>` : ''}
      </div>
    </div>
    <div class="today-wx-hours" data-hscroll>${(data.hours || []).map(h => {
      const k = _todayWeatherKind(h.code);
      return `<div class="today-wx-hour" title="${escHtml(k.label)}"><span class="today-muted">${escHtml(hm(h.time))}</span>${SVGICONS[k.icon](16, 16)}<span>${t(h.temp)}</span><span class="today-wx-precip" style="--p:${h.precip ?? 0}%">${h.precip ?? 0}%</span></div>`;
    }).join('')}</div>
    ${tomorrow ? `<div class="today-wx-tomorrow today-muted">Tomorrow: ${SVGICONS[tomorrow.icon](14, 14)} ${escHtml(tomorrow.label)} · ${t(data.tomorrow.min)} / ${t(data.tomorrow.max)}${data.tomorrow.precipMax != null ? ` · rain ${data.tomorrow.precipMax} %` : ''}</div>` : ''}`;
}

// ---- CV-App ----

// Status label colours of the CV-App (frontend/src/css/app.css .status-*)
const _TODAY_CV_STATUS = {
  'Research':       { bg: '#E0F2F1', color: '#00695C' },
  'Vorbereitung':   { bg: '#E3F2FD', color: '#1565C0' },
  'Versendet':      { bg: '#FFF8E1', color: '#E65100' },
  'Kandidatenpool': { bg: '#E8EAF6', color: '#283593' },
  'Gespräch':       { bg: '#F3E5F5', color: '#6A1B9A' },
  'Angebot':        { bg: '#E8F5E9', color: '#2E7D32' },
  'Absage':         { bg: '#FFEBEE', color: '#C62828' },
  'Keine Antwort':  { bg: '#F5F5F5', color: '#757575' },
  'Zurückgezogen':  { bg: '#ECEFF1', color: '#546E7A' },
  'Abgebrochen':    { bg: '#EFEBE9', color: '#5D4037' },
};

/** [{ status, count }] of a list of applications, in the CV-App's status order (unknown ones last). Pure. */
function _todayCvStatusCounts(apps) {
  const order = Object.keys(_TODAY_CV_STATUS);
  const rank  = s => { const i = order.indexOf(s); return i < 0 ? order.length : i; };
  const counts = new Map();
  for (const a of apps || []) counts.set(a.status, (counts.get(a.status) || 0) + 1);
  return [...counts].sort(([a], [b]) => rank(a) - rank(b) || String(a).localeCompare(String(b)))
    .map(([status, count]) => ({ status, count }));
}

function _todayCvBadge(status, count) {
  const c = _TODAY_CV_STATUS[status] || { bg: 'var(--surface2)', color: 'var(--text)' };
  return `<span class="today-cv-badge" style="background:${c.bg};color:${c.color}">${escHtml(status)}${count != null ? ` <b>${count}</b>` : ''}</span>`;
}

/** Status counter on top of the Applications tile — a toggle that filters the list by that status. */
function _todayCvFilterChip(status, count, filter) {
  const c  = _TODAY_CV_STATUS[status] || { bg: 'var(--surface2)', color: 'var(--text)' };
  const on = filter === status;
  const cls = `today-cv-badge today-cv-filter${on ? ' today-cv-filter--on' : filter ? ' today-cv-filter--off' : ''}`;
  return `<button class="${cls}" data-cv-status="${escHtml(status)}" style="background:${c.bg};color:${c.color}" aria-pressed="${on}"
    title="${on ? 'Show all' : `Show only ${escHtml(status)}`}">${escHtml(status)} <b>${count}</b></button>`;
}

/** Status filter of the Applications tile ('' = all); per browser. */
function _todayCvFilter() {
  try { return localStorage.getItem('today-cvapp-status') || ''; } catch { return ''; }
}

function _todaySetCvFilter(status) {
  try { localStorage.setItem('today-cvapp-status', status); } catch { /* ignore */ }
  _todayLoadTile('cvapp');   // served from the per-load fetch memo
}

/** List mode of the Applications tile: 'active' (default) or 'recent'; per browser. */
function _todayCvMode() {
  try { return localStorage.getItem('today-cvapp-list') === 'recent' ? 'recent' : 'active'; } catch { return 'active'; }
}

function _todaySetCvMode(mode) {
  try { localStorage.setItem('today-cvapp-list', mode); } catch { /* ignore */ }
  _todayLoadTile('cvapp');   // served from the per-load fetch memo
}

/** Days since a date (local calendar days). */
function _todayDaysSince(date) {
  const d = new Date(date), t = new Date();
  return Math.round((Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
}

/** Send date of a "Versendet" application, coloured by age like in the CV-App (14 / 28 / 42 days). */
function _todayCvSentHtml(a) {
  if (a.status !== 'Versendet' || !a.appliedAt) return '';
  const days = _todayDaysSince(a.appliedAt);
  const cls  = days >= 42 ? ' today-cv-sent--alarm' : days >= 28 ? ' today-cv-sent--late' : days >= 14 ? ' today-cv-sent--warn' : '';
  const date = new Date(a.appliedAt).toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
  const ago  = days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return `<span class="today-cv-sent${cls}" title="Sent ${ago}">sent ${escHtml(date)}</span>`;
}

function _todayRenderCvApp(body, data, el) {
  _todaySetTileActions('cvapp');
  const mode = _todayCvMode();
  const all  = (mode === 'recent' ? data.recent : data.active) || [];
  // Header count = size of the current selection (Active: all active, even beyond the list cap)
  _todaySetCount(el, mode === 'recent' ? all.length : data.total);
  // Counters = statuses of the current selection (Active: server counts, the list may be capped)
  const statuses = mode === 'recent' ? _todayCvStatusCounts(all) : data.statuses;
  // A stored filter whose status is not in the selection shows everything
  const filter = statuses.some(s => s.status === _todayCvFilter()) ? _todayCvFilter() : '';
  const list = all.filter(a => !filter || a.status === filter);
  const chips = statuses.map(s => _todayCvFilterChip(s.status, s.count, filter)).join('');
  const fit = f => f == null ? '' : `<span class="today-fit" title="Fit ${f}/4">${'●'.repeat(Math.round(f))}${'○'.repeat(4 - Math.round(f))}</span>`;
  const items = list.map((a, i) => {
    const hasInfo = a.statusNote || a.progress;
    const title = escHtml(a.title || '(untitled)');
    return `<div class="today-app-row">
      <span class="today-row-main">
        ${a.url ? `<a class="today-app-line today-app-title today-app-link" href="${escHtml(a.url)}" target="_blank" rel="noopener noreferrer" title="${title}">${title}</a>` : `<span class="today-app-line today-app-title" title="${title}">${title}</span>`}
        ${a.company ? `<span class="today-app-line today-app-company" title="${escHtml(a.company)}">${escHtml(a.company)}</span>` : ''}
        <span class="today-row-meta today-app-meta">${_todayCvBadge(a.status)}${_todayCvSentHtml(a)}${fit(a.fitScore)}</span>
        ${hasInfo ? `<span class="today-app-info" data-info="${escHtml(String(a.id ?? i))}" hidden>
          ${a.statusNote ? `<span class="today-app-note">${escHtml(a.statusNote)}</span>` : ''}
          ${a.progress ? `<span class="today-app-progress">${renderMarkdown(a.progress)}</span>` : ''}
        </span>` : ''}
      </span>
      ${hasInfo ? `<button class="today-info-btn" data-info-btn="${escHtml(String(a.id ?? i))}" title="${escHtml(a.statusNote || 'Show the application status')}" aria-label="Show the application status" aria-expanded="false">i</button>` : ''}
    </div>`;
  }).join('');
  const empty = `<p class="dashboard-empty">${filter ? `No ${mode === 'recent' ? 'recently updated' : 'active'} applications with status ${escHtml(filter)}.`
    : mode === 'recent' ? 'No applications yet.' : 'No active applications.'}</p>`;
  body.innerHTML = (chips ? `<div class="today-statuses">${chips}</div>` : '')
    + `<div class="today-subhead">${mode === 'recent' ? 'Recently updated' : 'Active'}${filter ? ` · ${escHtml(filter)}` : ''}</div>${items || empty}`;
  body.querySelectorAll('[data-cv-status]').forEach(chip => chip.addEventListener('click', e => {
    e.stopPropagation();
    _todaySetCvFilter(chip.dataset.cvStatus === filter ? '' : chip.dataset.cvStatus);
  }));
  body.querySelectorAll('[data-info-btn]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const info = [...body.querySelectorAll('[data-info]')].find(x => x.dataset.info === btn.dataset.infoBtn);
    info.hidden = !info.hidden;
    btn.classList.toggle('today-info-btn--open', !info.hidden);
    btn.setAttribute('aria-expanded', String(!info.hidden));
  }));
}

// ---- Progress ----

let _todayAchOffset  = 0;      // days back from today (0 = today)
let _todayAchHasPast = false;  // the API reports activity before the shown day

function _todaySetAchOffset(offset) {
  _todayAchOffset = Math.min(0, offset);
  _todayLoadTile('progress');
}

/** Label of the shown day: Today / Yesterday / weekday + date. */
function _todayAchLabel(offset) {
  if (offset === 0)  return 'Today';
  if (offset === -1) return 'Yesterday';
  const d = new Date(`${_todayAddDays(_todayToday(), offset)}T12:00:00`);
  return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: '2-digit',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

function _todayRenderProgress(body, data, el) {
  const { done = 0, moved = 0, created = 0, inboxCreated = 0,
          createdCards = [], inboxCreatedCards = [], movedCards = [], doneCards = [] } = data || {};
  _todayAchHasPast = !!data?.hasPast;
  _todaySetTileActions('progress');
  // The shown day goes into the header next to the title (where other tiles show their count)
  const dayEl = el.querySelector('.today-tile-count');
  dayEl.textContent = _todayAchLabel(_todayAchOffset);
  dayEl.title = _todayAddDays(_todayToday(), _todayAchOffset);
  // Tooltip: the cards behind a number
  const tip = cards => (cards.length ? ` title="${escHtml(cardsTooltip(cards))}"` : '');
  const stat = (v, label, color, cards) => `<div class="today-stat" style="--stat-color:${color}"${tip(cards)}><span class="today-stat-value">${v}</span><span class="today-stat-label">${label}</span></div>`;
  body.innerHTML = `<div class="today-stats">
    ${stat(inboxCreated, 'to inbox', '#f97316', inboxCreatedCards)}
    ${stat(created - inboxCreated, 'created', '#f97316', createdCards)}
    ${stat(moved, 'moved', '#eab308', movedCards)}
    ${stat(done, 'done', '#10b981', doneCards)}
  </div>`;
}

// ---- Boards ----

let _todayNewBoardOpen  = false;
let _todayNewBoardDraft = '';   // typed name, kept across tile refreshes

/** Archived boards listed with the active ones (folder action of the Boards tile); per browser. */
function _todayShowArchived() {
  try { return localStorage.getItem('today-boards-archived') === '1'; } catch { return false; }
}

function _todayToggleArchived() {
  try { localStorage.setItem('today-boards-archived', _todayShowArchived() ? '0' : '1'); } catch { /* ignore */ }
  _todayLoadTile('boards', { keepState: true });
}

function _todayToggleNewBoard() {
  _todayNewBoardOpen = !_todayNewBoardOpen;
  _todayNewBoardDraft = '';
  const el = _todayTileEls.get('boards');
  if (!el) return;
  _todaySetTileActions('boards');
  _todayRenderNewBoard(el.querySelector('.today-tile-body'), true);
}

/** Inline "new board" form on top of the Boards tile (shown via the + action). */
function _todayRenderNewBoard(body, focus = false) {
  body.querySelector('.today-newboard')?.remove();
  if (!_todayNewBoardOpen) return;
  const form = document.createElement('form');
  form.className = 'today-newboard';
  form.innerHTML = `<div class="today-newboard-row">
      <input class="today-newboard-input" type="text" placeholder="my-board" maxlength="64" spellcheck="false" autocomplete="off" aria-label="New board name">
      <button class="btn btn-accent" type="submit">Create</button>
    </div>
    <p class="today-newboard-error" hidden></p>`;
  const input = form.querySelector('input');
  const errEl = form.querySelector('.today-newboard-error');
  input.value = _todayNewBoardDraft;
  input.addEventListener('input', () => { _todayNewBoardDraft = input.value; });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    errEl.hidden = true;
    const err = await createBoardAndOpen(input.value);
    if (err) { errEl.textContent = err; errEl.hidden = false; input.focus(); }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); _todayToggleNewBoard(); } });
  body.prepend(form);
  if (focus) input.focus();
}

function _todayRenderBoards(body, [boards, recent], el) {
  const active   = (boards || []).filter(b => !b.archived);
  const archived = (boards || []).filter(b => b.archived);
  _todaySetCount(el, active.length);
  const chip = b => {
    const badges = boardBadgesHtml(b.columnBadges, { numbersOnly: true });
    return `<a class="today-board${b.archived ? ' today-board--archived' : ''}"${b.archived ? ' data-archived="1"' : ''} href="${BASE_PATH}/board/${encodeURIComponent(b.name)}">
      <span class="today-board-name board-card-name" title="${escHtml(b.description || b.name)}">${escHtml(b.name)}</span>
      ${badges ? `<span class="today-board-counts">${badges}</span>` : ''}</a>`;
  };
  // Archived boards (folder action) follow the active ones in the same grid, dimmed
  const shown = _todayShowArchived() ? [...active, ...archived] : active;
  const chips = shown.map(chip).join('');
  body.innerHTML = `<div class="today-boards">${chips || '<p class="dashboard-empty">No boards yet.</p>'}</div>
    ${recent?.length ? `<details class="today-recent"><summary>Last edited</summary>${recent.map(_recentItemHtml).join('')}</details>` : ''}`;
  _todayRenderNewBoard(body);

  // Equal-width board cards: as many per row as fit with name and all counts on one line (≥ 2).
  // Widest card measured off-screen (archived ones too, so toggling them keeps the card width).
  const measure = document.createElement('div');
  measure.className = 'today-boards today-boards--measure';
  measure.innerHTML = [...active, ...archived].map(chip).join('');
  body.appendChild(measure);
  body._todayBoardNeed = Math.max(0, ...[...measure.children].map(c => Math.ceil(c.getBoundingClientRect().width)));
  body._todayBoardCount = shown.length;
  measure.remove();
  _todayFitBoards(body);
  if (!body._todayBoardRO && typeof ResizeObserver === 'function') {
    body._todayBoardRO = new ResizeObserver(() => _todayFitBoards(body));
    body._todayBoardRO.observe(body);
  }
}

/** Board cards per row: as many as fit at `need` px each, at least 2, at most the number of boards. Pure. */
function _todayBoardCols(width, need, gap, count) {
  const fit = need > 0 ? Math.floor((width + gap) / (need + gap)) : 2;
  return Math.max(2, Math.min(fit, Math.max(2, count)));
}

function _todayFitBoards(body) {
  const grid = body.querySelector('.today-boards');
  if (!grid || !body._todayBoardNeed) return;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 8;
  const n = _todayBoardCols(grid.clientWidth, body._todayBoardNeed, gap, body._todayBoardCount);
  body.style.setProperty('--today-board-cols', String(n));
  // Two per row is the minimum: when even that is too narrow, tighten paddings so the counts still fit
  const cardW = (grid.clientWidth - gap * (n - 1)) / n;
  body.classList.toggle('today-boards-compact', cardW < body._todayBoardNeed);
}

// ---- Quick access ----
// Entries live in the Today config (`widgets.quickaccess`); fetched icons are stored on the server
// (routes/today.js, content-addressed → cached by the browser for good).

const _TODAY_QA_SIZES = ['s', 'm', 'l'];

/** Entries always shown and the ones behind "Show more"; `visible` 0 (or unset) = all. Pure. */
function _todayQaSplit(items, visible) {
  const list = Array.isArray(items) ? items : [];
  const n = Number(visible) > 0 ? Number(visible) : list.length;
  return { shown: list.slice(0, n), more: list.slice(n) };
}

function _todayQaHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || ''); }
}

/** Icon markup of an entry: stored image, emoji, or the first letter of the title. Pure. */
function _todayQaIconHtml(item) {
  const icon = item?.icon;
  if (icon?.type === 'image' && icon.file) return `<img class="today-qa-img${icon.invertDark ? ' today-qa-img--invert' : ''}" src="${BASE_PATH}/api/today/quickaccess/icon/${encodeURIComponent(icon.file)}" alt="" loading="lazy" draggable="false">`;
  if (icon?.type === 'emoji' && icon.value) return `<span class="today-qa-emoji">${escHtml(icon.value)}</span>`;
  return _todayQaLetterHtml(item);
}

function _todayQaLetterHtml(item) {
  const t = (item?.title || _todayQaHost(item?.url)).trim();
  return `<span class="today-qa-letter">${escHtml((Array.from(t)[0] || '?').toUpperCase())}</span>`;
}

/**
 * Icon in its wrapper: app icons stand alone (`--img`), emojis and the letter fallback sit in a
 * framed area (`--box`). Pure.
 */
function _todayQaIconBoxHtml(item) {
  const img = item?.icon?.type === 'image' && item.icon.file;
  return `<span class="today-qa-icon today-qa-icon--${img ? 'img' : 'box'}">${_todayQaIconHtml(item)}</span>`;
}

function _todayQaItemHtml(item) {
  const title = item.title || _todayQaHost(item.url);
  return `<a class="today-qa-item" href="${escHtml(safeLink(item.url) || '#')}" target="_blank" rel="noopener noreferrer" title="${escHtml(`${title} — ${item.url}`)}" data-qa="${escHtml(item.id)}">
      ${_todayQaIconBoxHtml(item)}
      <span class="today-qa-title">${escHtml(title)}</span></a>`;
}

/** Stored icon missing / broken → first letter (no inline onerror: CSP script-src-attr 'none'). */
function _todayQaImgFallback(root, items) {
  for (const img of root.querySelectorAll('img')) {
    img.addEventListener('error', () => {
      const item = items.find(i => i.id === img.closest('[data-qa]')?.dataset.qa);
      img.parentElement?.classList.replace('today-qa-icon--img', 'today-qa-icon--box');
      img.outerHTML = _todayQaLetterHtml(item);
    }, { once: true });
  }
}

/** "Show more" expanded; per browser. */
function _todayQaMore() {
  try { return localStorage.getItem('today-qa-more') === '1'; } catch { return false; }
}

function _todayRenderQuickAccess(body, data, el) {
  const { items, size, visible, showTitles } = _todayQaCfg({ widgets: { quickaccess: data } });
  _todaySetCount(el, items.length);
  if (!items.length) {
    body.innerHTML = `<div class="today-qa-empty"><p class="dashboard-empty">No links yet.</p>
      <button class="btn" type="button" data-qa-setup>Add links</button></div>`;
    body.querySelector('[data-qa-setup]').addEventListener('click', () => _todayOpenWidgetSettings('quickaccess'));
    return;
  }
  const { shown, more } = _todayQaSplit(items, visible);
  const open = _todayQaMore();
  body.innerHTML = `<div class="today-qa today-qa--${size}${showTitles ? '' : ' today-qa--notitles'}">${shown.map(_todayQaItemHtml).join('')}${
      more.length ? `<div class="today-qa-more"${open ? '' : ' hidden'}>${more.map(_todayQaItemHtml).join('')}</div>` : ''}</div>
    ${more.length ? `<button class="today-qa-toggle" type="button" aria-expanded="${open}">${open ? 'Show less' : `Show more … (${more.length})`}</button>` : ''}`;
  _todayQaImgFallback(body, items);
  body.querySelector('.today-qa-toggle')?.addEventListener('click', () => {
    try { localStorage.setItem('today-qa-more', open ? '0' : '1'); } catch { /* ignore */ }
    _todayRenderQuickAccess(body, data, el);
    _todayScheduleFit();
  });
}

/** Settings → Today with the widget's row expanded (from a tile action). */
function _todayOpenWidgetSettings(id) {
  _todayExpandWidget = id;
  if (typeof window.openSettingsDialog === 'function') window.openSettingsDialog('todaySection');
}

// ---- Notes ----

let _todayNotesQuery  = '';
let _todayNotesData   = null;
let _todayNotesSearch = false;   // filter field shown

function _todayNotesRerender(focus) {
  const el = _todayTileEls.get('notes');
  if (!el || !_todayNotesData) return;
  _todaySetTileActions('notes');
  _todayRenderNotes(el.querySelector('.today-tile-body'), _todayNotesData, el);
  if (focus) el.querySelector('.today-notes-filter')?.focus();
}

/** Show / hide the filter field; hiding clears the filter. */
function _todayToggleNotesSearch() {
  _todayNotesSearch = !_todayNotesSearch;
  if (!_todayNotesSearch) _todayNotesQuery = '';
  _todayNotesRerender(_todayNotesSearch);
}

/** Open or collapse every board and folder of the Notes tile (remembered unless a filter is active). */
/**
 * Open: one level per click — the closed boards / folders that are visible (all parents open) at the
 * shallowest depth; 1st click the boards, 2nd their folders, … Collapse: everything (so it starts over).
 */
function _todayNotesOpenAll(open) {
  const body = _todayTileEls.get('notes')?.querySelector('.today-tile-body');
  if (!body) return;
  const details = [...body.querySelectorAll('.today-ntree details')];
  if (open) {
    const depth = d => { let n = 0; for (let p = d.parentElement.closest('details'); p; p = p.parentElement.closest('details')) n++; return n; };
    const next = details.filter(d => !d.open && !d.parentElement.closest('details:not([open])'));
    const min = Math.min(...next.map(depth));
    for (const d of next) if (depth(d) === min) d.open = true;
  } else {
    for (const d of details) d.open = false;
  }
  if (!_todayNotesQuery.trim()) {
    try { localStorage.setItem('today-notes-open', JSON.stringify(details.filter(d => d.open).map(d => d.dataset.key).slice(-300))); } catch { /* ignore */ }
  }
}

function _todayNorm(s) {
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Note tree filtered by title: every word of `q` must occur (case / accent-insensitive). A folder
 * whose title matches keeps all its children; otherwise only matching descendants. Pure.
 */
function _todayFilterNoteTree(items, q) {
  const words = _todayNorm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const hit = t => { const n = _todayNorm(t); return words.every(w => n.includes(w)); };
  const walk = list => list.flatMap(it => {
    if (hit(it.title)) return [it];
    if (it.type !== 'folder') return [];
    const children = walk(it.children || []);
    return children.length ? [{ ...it, children }] : [];
  });
  return walk(items);
}

/** Open boards / folders of the Notes tile (`nb:<board>`, `nf:<board>/<id>`); per browser. */
function _todayNotesOpen() {
  try { return new Set(JSON.parse(localStorage.getItem('today-notes-open') || '[]')); } catch { return new Set(); }
}

function _todaySetNotesOpen(key, open) {
  const set = _todayNotesOpen();
  if (open) set.add(key); else set.delete(key);
  try { localStorage.setItem('today-notes-open', JSON.stringify([...set].slice(-300))); } catch { /* ignore */ }
}

function _todayRenderNotes(body, data, el) {
  _todayNotesData = data;
  _todaySetCount(el, data.total);
  const q    = _todayNotesQuery.trim();
  const open = _todayNotesOpen();
  const isOpen = key => (q || open.has(key) ? ' open' : '');
  const node = (board, it) => {
    const title = escHtml(it.title || '(untitled)');
    if (it.type === 'folder') {
      const key = `nf:${board}/${it.id}`;
      return `<details class="today-nfolder" data-key="${escHtml(key)}"${isOpen(key)}>
        <summary title="${title}">${SVGICONS.folder(12, 12)}<span class="today-nlabel">${title}</span></summary>
        <div class="today-nchildren">${(it.children || []).map(c => node(board, c)).join('') || '<span class="today-nempty">empty</span>'}</div>
      </details>`;
    }
    return `<a class="today-npage" data-board="${escHtml(board)}" data-page-id="${escHtml(it.id)}" href="${BASE_PATH}/board/${encodeURIComponent(board)}#note:${encodeURIComponent(it.id)}" title="${title} — ${escHtml(board)}">${SVGICONS.notePages(10, 10)}<span class="today-nlabel">${title}</span></a>`;
  };
  const boards = (data.boards || []).map(b => ({ ...b, items: _todayFilterNoteTree(b.items, q) })).filter(b => b.items.length);
  const tree = boards.map(b => {
    const key = `nb:${b.board}`;
    return `<details class="today-nboard" data-key="${escHtml(key)}"${isOpen(key)}>
      <summary><span class="today-nlabel">${escHtml(b.board)}</span>${b.webdav ? `<span class="today-ncloud" title="Notes synced with WebDAV" aria-label="WebDAV">${SVGICONS.wxCloud(14, 14)}</span>` : ''}<span class="today-ncount">${b.pages}</span></summary>
      <div class="today-nchildren">${b.items.map(it => node(b.board, it)).join('')}</div>
    </details>`;
  }).join('');
  const empty = q ? 'No matching pages.' : 'No note pages on the active boards.';
  body.innerHTML = `${data.total && _todayNotesSearch ? `<input class="today-notes-filter" type="search" placeholder="Filter pages…" aria-label="Filter note pages" value="${escHtml(_todayNotesQuery)}">` : ''}
    <div class="today-ntree">${tree || `<p class="dashboard-empty">${empty}</p>`}</div>`;

  if (!body.dataset.notesWired) {
    body.dataset.notesWired = '1';
    // Remember folders opened / closed by hand (not the ones a filter opens)
    body.addEventListener('toggle', e => {
      const d = e.target;
      if (d.tagName === 'DETAILS' && d.dataset.key?.startsWith('n') && !_todayNotesQuery.trim()) _todaySetNotesOpen(d.dataset.key, d.open);
    }, true);
    let t = null;
    body.addEventListener('input', e => {
      if (!e.target.classList.contains('today-notes-filter')) return;
      clearTimeout(t);
      t = setTimeout(() => {
        const input = body.querySelector('.today-notes-filter');
        const caret = input?.selectionStart ?? null;
        _todayNotesQuery = input?.value || '';
        _todayRenderNotes(body, _todayNotesData, el);
        const again = body.querySelector('.today-notes-filter');
        if (again) { again.focus(); if (caret != null) again.setSelectionRange(caret, caret); }
      }, 150);
    });
    body.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !e.target.classList.contains('today-notes-filter')) return;
      e.preventDefault();
      if (e.target.value) { e.target.value = ''; e.target.dispatchEvent(new Event('input', { bubbles: true })); }
      else _todayToggleNotesSearch();   // Escape on an empty field hides it
    });
  }
}

// ---- Event delegation (cards, events, mails in all tiles) ----

function _todayWireDelegation() {
  const grid = document.getElementById('todayGrid');

  const cardAt = target => {
    const el = target.closest('[data-card-key]');
    return el ? { el, entry: _todayCardMap.get(el.dataset.cardKey) } : null;
  };

  grid.addEventListener('click', e => {
    if (_todayEdit) return;
    if (e.target.closest('.today-setup-link')) { e.preventDefault(); openSettingsDialog('todaySection'); return; }
    // Note page: plain click edits in place; modifier / middle click keeps the board link
    const npage = e.target.closest('.today-npage[data-page-id]');
    if (npage) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      _todayEditNote(npage.dataset.board, npage.dataset.pageId);
      return;
    }
    const check = e.target.closest('[data-act="done"]');
    if (check) { e.stopPropagation(); const c = cardAt(check); if (c?.entry) _todayMarkDone(c.el, c.entry); return; }
    const c = cardAt(e.target);
    if (c?.entry && e.target.closest('.card-link-badge')) { _dashMarkRead(c.entry.board, c.entry.card); c.el.classList.remove('card--unread'); return; }
    if (c?.entry) { _openCardDetail(c.entry.board, c.entry.card); c.el.classList.remove('today-card-row--unread', 'card--unread'); return; }
    if (e.target.closest('.today-ev-meet')) return;   // meeting link opens itself in a new tab
    const ev = e.target.closest('.today-ev[data-uid]');
    if (ev) { _openEventDetail(ev.dataset.accountId, ev.dataset.uid, ev.dataset.webUrl || ''); return; }
    const mail = e.target.closest('.today-mail-row[data-msg-id]');
    if (mail) _openMailDetail(mail.dataset.accountId, mail.dataset.msgId, mail.dataset.webUrl || '');
  });

  grid.addEventListener('contextmenu', e => {
    if (_todayEdit) return;
    const c = cardAt(e.target);
    const ev = !c && e.target.closest('.today-ev[data-uid]');
    const mail = !c && !ev && e.target.closest('.today-mail-row[data-msg-id]');
    if (!c?.entry && !ev && !mail) return;
    e.preventDefault();
    e.stopPropagation();
    if (c?.entry) showDashboardContextMenu(e.clientX, e.clientY, c.entry.board, c.entry.card);
    else if (ev) _showCalEventContextMenu(e, ev.dataset.accountId, ev.dataset.uid, ev.dataset.webUrl || '');
    else _showMailContextMenu(e.clientX, e.clientY, mail.dataset.accountId, mail.dataset.msgId, mail.dataset.unread === '1', mail.dataset.webUrl || '');
  });

  // Tile edit controls (size / hide); drag is pointer-based
  grid.addEventListener('change', e => {
    const sel = e.target.closest('.today-tile-size');
    if (!sel || !_todayEdit) return;
    _todayEditUpdate(sel.closest('.today-tile').dataset.tile, { size: sel.value });
  });
  grid.addEventListener('click', e => {
    const hide = e.target.closest('.today-tile-hide');
    if (!hide || !_todayEdit) return;
    const id = hide.closest('.today-tile').dataset.tile;
    _todayEdit.draft.tiles = _todayEdit.draft.tiles.filter(t => t.id !== id);
    _todayEditCommit();
  });
  grid.addEventListener('pointerdown', _todayDragStart);
}

async function _todayMarkDone(rowEl, { board, card }) {
  const doneCls = rowEl.classList.contains('card') ? 'card--done' : 'today-card-row--done';
  rowEl.classList.add(doneCls);
  try {
    await _dashPatchCard(board, card.id, c => { c.done = true; c.doneAt = new Date().toISOString(); c.unread = false; });
    _todayFlash(`${ICONS.done} done`);
  } catch {
    rowEl.classList.remove(doneCls);
    showMessage('Could not mark the card as done.');
    return;
  }
  setTimeout(() => _todayRefresh('cards'), 350);
}

/**
 * Reload the tiles that show cards or mail after an action elsewhere (card / mail context menu,
 * detail panel — dashboard.js / menus.js call this after changes).
 * Only the changed data is fetched again; the calendar stays cached for this load cycle.
 */
function _todayRefresh(kind) {
  const urls  = kind === 'mail'     ? [/^\/api\/dashboard\/mail$/]
              : kind === 'calendar' ? [/^\/api\/dashboard\/calendar/]
              : [/^\/api\/today\/widgets\/cards/, /^\/api\/achievements\//];
  const tiles = kind === 'mail' ? ['attention'] : kind === 'calendar' ? ['agenda'] : ['agenda', 'attention', 'progress'];
  for (const url of [..._todayFetchMemo.keys()]) if (urls.some(re => re.test(url))) _todayFetchMemo.delete(url);
  for (const id of tiles) if ((_todayEdit?.draft || _todayLayout)?.tiles.some(t => t.id === id)) _todayLoadTile(id);
}

// ---- In-place editing (card / note dialogs without loading the board page) ----
// The board context of state.js / cards.js (setBoardContext) and one lazily created
// notes module are pointed at the edited item's board; the board is never rendered.

/** Promise chain: one context switch at a time (fast double clicks). */
let _todayEditQueue = Promise.resolve();
function _todayEditSerial(fn) {
  const run = _todayEditQueue.then(fn, fn);
  _todayEditQueue = run.catch(() => {});
  return run;
}

/** Wait for pending card / note saves, then switch the board context (loads the board JSON). */
async function _todaySwitchBoard(board) {
  await flushBoardSave();
  await window._notesModule?.flushNotesSave();
  if (BOARD_NAME === board && state.columns.length) {
    // Same board: refresh to pick up changes made elsewhere since the last edit
    await load();
    return;
  }
  setBoardContext(board);
  await load();
}

function _todayBoardUrl(board, hash) {
  return appUrl(`/board/${encodeURIComponent(board)}#${hash}`);
}

/** Open the card edit dialog on Today. */
function _todayEditCard(board, cardId) {
  return _todayEditSerial(async () => {
    try { await _todaySwitchBoard(board); }
    catch (e) { showMessage(e.message || 'Failed to load the board.'); return; }
    const col  = state.columns.find(c => c.cards.some(k => k.id === cardId));
    const card = col?.cards.find(k => k.id === cardId);
    if (!card) { showMessage('This card no longer exists.'); _todayRefresh('cards'); return; }
    openEditModal(col.id, card);
    const goBtn = document.getElementById('modalGoBoardBtn');
    goBtn.href = _todayBoardUrl(board, `card:${cardId}`);
    goBtn.style.display = '';
    goBtn.onclick = async e => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;   // new tab: leave the dialog open
      e.preventDefault();
      const href = goBtn.href;
      await tryCloseModal();
      if (document.getElementById('modal').style.display !== 'none') return;   // close cancelled
      await flushBoardSave();
      window.location.href = href;
    };
    // Linked note pages of the card: load that board's notes in the background
    _todayNotesFor(board).then(() => {
      if (modalMode === 'edit' && editCardId === cardId) renderCardLinkedPages(cardId);
    }).catch(() => {});
  });
}

/** Called by closeModal() after an in-place card edit: save, then refresh the card tiles. */
async function _todayAfterCardEdit() {
  await flushBoardSave();
  _todayRefresh('cards');
}

/** Notes module pointed at `board`, its notes loaded (created on first use). */
async function _todayNotesFor(board) {
  const nm = window._notesModule;
  if (nm && nm.getBoardName() === board && nm.getNotesState().items.length) return nm;
  let webdavEnabled = false;
  try {
    const r = await fetch(`/api/${encodeURIComponent(board)}/webdav-config`);
    if (r.ok) webdavEnabled = !!(await r.json()).enabled;
  } catch { /* notes still load from CouchDB */ }
  if (!nm) {
    window._notesModule = _createNotesModule({
      apiBase:   `/api/${encodeURIComponent(board)}`,
      boardName: board,
      webdavEnabled,
      headless:  true,
      onClose:   () => _todayAfterNoteEdit(),
      goToBoard: pageId => { window.location.href = _todayBoardUrl(window._notesModule.getBoardName(), `note:${pageId}`); },
      // Linked card in the note dialog: in place as well (with Go to board)
      hooks:     { openEditModal: (colId, card) => _todayEditCard(window._notesModule.getBoardName(), card.id) },
    });
  } else {
    await nm.flushNotesSave();
    nm.setBoard({ apiBase: `/api/${encodeURIComponent(board)}`, boardName: board, webdavEnabled });
  }
  await window._notesModule.loadNotes();
  return window._notesModule;
}

/** Open the note page dialog on Today. */
function _todayEditNote(board, pageId) {
  return _todayEditSerial(async () => {
    let nm;
    try {
      // Board state too: linked-card titles, "Create card" and auto-save settings come from it
      await _todaySwitchBoard(board);
      nm = await _todayNotesFor(board);
    } catch (e) { showMessage(e.message || 'Failed to load the notes.'); return; }
    if (!nm.findNotePage(pageId, nm.getNotesState().items)) { showMessage('This note page no longer exists.'); _todayReloadNotes(); return; }
    await nm.openNoteModal(pageId);
  });
}

let _todayNoteCloseT = null;
function _todayAfterNoteEdit() {
  // The save button awaits the save before closing; debounced saves (tree ops) get a moment
  clearTimeout(_todayNoteCloseT);
  _todayNoteCloseT = setTimeout(async () => {
    await window._notesModule?.flushNotesSave();
    await flushBoardSave();
    _todayReloadNotes();
    _todayRefresh('cards');
  }, 100);
}

function _todayReloadNotes() {
  for (const url of [..._todayFetchMemo.keys()]) if (/^\/api\/today\/widgets\/notes/.test(url)) _todayFetchMemo.delete(url);
  if ((_todayEdit?.draft || _todayLayout)?.tiles.some(t => t.id === 'notes')) _todayLoadTile('notes');
}

/** Remove a mail from the "unread mails" list right away (read, moved or deleted); count follows. */
function _todayDropMail(accountId, msgId) {
  const row = document.querySelector(`.today-mail-row[data-account-id="${CSS.escape(accountId)}"][data-msg-id="${CSS.escape(msgId)}"]`);
  if (!row) return;
  const att = row.closest('details.today-att');
  (row.closest('.today-swipe') || row).remove();
  const count = att?.querySelector('.today-att-count');
  if (count) {
    const n = Math.max(0, (parseInt(count.textContent, 10) || 1) - 1);
    count.textContent = String(n);
    if (!n) att.remove();
  }
}

// ---- Layout editing ----

/** Edit state of one breakpoint, started from the layout currently resolved for it. */
function _todayEditState(bp, layout) {
  return { bp, draft: JSON.parse(JSON.stringify({ columns: layout.columns, tiles: layout.tiles })),
           derived: layout.derived, from: layout.from, dirty: false };
}

/**
 * Edit mode spans screen sizes: each breakpoint has its own draft (`_todayEdit.drafts`). When the
 * window crosses a breakpoint, the current draft is parked and the new size's layout is edited;
 * Save writes every changed size.
 */
function _todayStartEdit() {
  _todayEdit = { ..._todayEditState(_todayBp, _todayLayout), drafts: {} };
  document.getElementById('today').classList.add('today--editing');
  _todayMarkEditBtn(true);
  _todayRenderEditBar();
  _todayApplyLayout(_todayEdit.draft);
  _todayMeasure();
}

/** Window resized while editing: switch to the layout of the new screen size. */
function _todayEditResize() {
  if (!_todayEdit) return;
  const bp = _todayBpFor(window.innerWidth);
  // On an extra-large screen a smaller size picked in the edit badge stays selected
  if (bp === _todayEdit.bp || (bp === 'xl' && _todayEdit.preview)) { _todayMeasure(); return; }
  _todayEditSwitch(bp);
}

// Width a smaller screen size is previewed at on an extra-large screen (edit badge drop-down)
const _TODAY_PREVIEW_W = { lg: 1400, md: 980, sm: 390 };

/**
 * Edit the layout of breakpoint `bp`. On an extra-large screen a smaller `bp` is previewed: the
 * grid is narrowed to that size's width (`_TODAY_PREVIEW_W`) and the layout resolved for it.
 */
function _todayEditSwitch(bp) {
  const { drafts, ...cur } = _todayEdit;
  drafts[cur.bp] = cur;
  const preview = _todayBpFor(window.innerWidth) === 'xl' && bp !== 'xl';
  _todaySyncPreview(preview ? _TODAY_PREVIEW_W[bp] : 0);
  const layout = _todayResolveLayout(_todayCfg?.layouts, bp, _todayKnownTiles(), _todayViewportWidth());
  _todayBp = bp;
  _todayLayout = layout;
  _todayEdit = { ...(drafts[bp] || _todayEditState(bp, layout)), drafts, preview };
  delete drafts[bp];
  const shown = new Set([...document.querySelectorAll('#todayGrid .today-tile')].map(el => el.dataset.tile));
  _todayApplyLayout(_todayEdit.draft);
  for (const t of _todayEdit.draft.tiles) if (!shown.has(t.id) && _todayTileEls.get(t.id)?.dataset.loaded !== '1') _todayLoadTile(t.id);
  _todayRenderEditBar();
  _todayMeasure();
}

function _todaySyncPreview(width) {
  const root = document.getElementById('today');
  root.classList.toggle('today--preview', !!width);
  if (width) root.style.setProperty('--today-preview-w', `${width}px`);
  else root.style.removeProperty('--today-preview-w');
}

/** Layouts to store: the saved ones plus every changed draft (and the current one when `withCurrent`). */
function _todayEditLayouts(withCurrent) {
  const out = { ...(_todayCfg.layouts || {}) };
  const plain = d => ({ columns: d.columns, tiles: d.tiles.map(({ id, col, order, size }) => ({ id, col, order, size })) });
  for (const st of Object.values(_todayEdit.drafts)) if (st.dirty) out[st.bp] = plain(st.draft);
  if (withCurrent) out[_todayEdit.bp] = plain(_todayEdit.draft);
  return out;
}

function _todayEndEdit(saved) {
  _todayEdit = null;
  _todaySyncPreview(0);
  document.getElementById('today').classList.remove('today--editing');
  _todayMarkEditBtn(false);
  document.getElementById('todayEditBar').style.display = 'none';
  _todayLayout = null;   // force re-applying the stored (saved: new) layout over the draft
  _todayRelayout();
}

function _todayEditCommit(keepId) {
  const d = _todayEdit.draft;
  // Renumber orders per column
  d.tiles.sort((a, b) => a.col - b.col || a.order - b.order);
  const next = d.columns.map(() => 0);
  for (const t of d.tiles) t.order = next[t.col]++;
  _todayOneAvailable(d.tiles, keepId);
  _todayEdit.dirty = true;
  const shown = new Set([...document.querySelectorAll('#todayGrid .today-tile')].map(el => el.dataset.tile));
  _todayApplyLayout(d);
  for (const t of d.tiles) if (!shown.has(t.id) && _todayTileEls.get(t.id)?.dataset.loaded !== '1') _todayLoadTile(t.id);
  _todayRenderEditBar();
  _todayMeasure();
}

function _todayEditUpdate(id, patch) {
  const t = _todayEdit.draft.tiles.find(x => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  _todayEditCommit(patch.size === 'available' ? id : undefined);
}

function _todayRenderEditBar() {
  const bar = document.getElementById('todayEditBar');
  const { bp, draft, derived, dirty, from } = _todayEdit;
  const bpDef = TODAY_BPS.find(b => b.key === bp);
  const hasOwn = !!_todayCfg?.layouts?.[bp];
  const hidden = _todayEditHidden();
  const otherDirty = Object.values(_todayEdit.drafts).filter(st => st.dirty).map(st => st.bp);
  bar.style.display = '';
  const status = derived && !dirty ? `derived${from ? ` from ${escHtml(from)}` : ''}` : 'custom';
  // Extra-large screens can preview and edit every size; smaller ones edit their own (resize to switch)
  const badge = _todayBpFor(window.innerWidth) === 'xl'
    ? `<select class="today-edit-badge today-edit-bp" title="Screen size to edit — smaller sizes are previewed at their width">${TODAY_BPS.map(b =>
        `<option value="${b.key}"${b.key === bp ? ' selected' : ''}>${escHtml(b.label)}${_todayEdit.drafts[b.key]?.dirty ? ' · changed' : ''}</option>`).join('')}</select>
       <span class="today-edit-status">${status}</span>`
    : `<span class="today-edit-badge" title="The layout applies to this screen size — resize the window to edit another one">${escHtml(bpDef.label)} · ${status}</span>`;
  bar.innerHTML = `${badge}
    ${otherDirty.length ? `<span class="today-edit-pending" title="Changed layouts of other screen sizes, saved together with this one">also changed: ${otherDirty.map(escHtml).join(', ')}</span>` : ''}
    <span class="today-edit-cols">${draft.columns.map((c, i) => `<span class="today-edit-col">Col ${i + 1}
      <select data-col-width="${i}" title="Relative column width">${[1, 2, 3].map(w => `<option value="${w}"${c.width === w ? ' selected' : ''}>${w}×</option>`).join('')}</select>
      ${draft.columns.length > 1 ? `<button class="today-edit-x" data-col-remove="${i}" title="Remove column (its tiles move to the neighbour)">${SVGICONS.close(8, 8)}</button>` : ''}</span>`).join('')}
      ${draft.columns.length < 4 ? '<button class="btn" data-edit="add-col">+ Column</button>' : ''}</span>
    <button class="btn" data-edit="add-tile"${hidden.length ? '' : ' disabled'} title="${hidden.length
      ? 'Add an active widget that is not on this layout (removed before) — also at the end of each column'
      : 'All active widgets are on this layout (inactive ones: Settings → Dashboard → Widgets)'}">+ Widget${hidden.length ? ` (${hidden.length})` : ''}</button>
    <span style="flex:1"></span>
    ${hasOwn ? '<button class="btn" data-edit="reset" title="Remove the custom layout of this screen size and derive it from a larger one">Reset to derived</button>' : ''}
    <button class="btn" data-edit="cancel">Cancel</button>
    <button class="btn btn-accent" data-edit="save"${dirty || derived || otherDirty.length ? '' : ' disabled'}>Save</button>`;

  bar.querySelectorAll('[data-col-width]').forEach(sel => sel.addEventListener('change', () => {
    draft.columns[+sel.dataset.colWidth].width = +sel.value;
    _todayEditCommit();
  }));
  bar.querySelectorAll('[data-col-remove]').forEach(btn => btn.addEventListener('click', () => {
    const i = +btn.dataset.colRemove;
    const target = i > 0 ? i - 1 : 0;
    const base = draft.tiles.filter(t => t.col === target && t.col !== i).length;
    let k = 0;
    for (const t of draft.tiles) {
      if (t.col === i) { t.col = target; t.order = base + 100 + k++; }
      else if (t.col > i) t.col--;
    }
    draft.columns.splice(i, 1);
    _todayEditCommit();
  }));
  bar.querySelector('[data-edit="add-col"]')?.addEventListener('click', () => {
    draft.columns.push({ width: 1 });
    _todayEditCommit();
  });
  bar.querySelector('[data-edit="add-tile"]').addEventListener('click', e => _todayEditAddMenu(e, draft.columns.length - 1));
  bar.querySelector('.today-edit-bp')?.addEventListener('change', e => _todayEditSwitch(e.target.value));
  bar.querySelector('[data-edit="cancel"]').addEventListener('click', () => _todayEndEdit(false));
  bar.querySelector('[data-edit="reset"]')?.addEventListener('click', async () => {
    const layouts = _todayEditLayouts(false);   // other sizes' changes are kept
    delete layouts[bp];
    if (await _todaySaveLayouts(layouts)) _todayEndEdit(true);
  });
  bar.querySelector('[data-edit="save"]').addEventListener('click', async () => {
    // The current size is saved when changed or still derived (as before); other sizes when changed
    if (await _todaySaveLayouts(_todayEditLayouts(dirty || derived))) _todayEndEdit(true);
  });
  _todayEditAddSlots();
}

/** Active widgets (not deactivated in the settings) missing from the layout being edited. */
function _todayEditHidden() {
  return _todayKnownTiles().filter(id => !_todayEdit.draft.tiles.some(t => t.id === id));
}

/** Menu of the missing widgets; the chosen one goes to the end of column `col`. */
function _todayEditAddMenu(e, col) {
  e.stopPropagation();
  openContextMenu(e, _todayEditHidden().map(id => ({
    label: TODAY_TILES[id].title,
    action: () => {
      _todayEdit.draft.tiles.push({ id, col, order: 999, size: 'container' });
      _todayEditCommit();
    },
  })));
}

/** Edit mode: "+ Add widget" at the end of every column while widgets are missing from the layout. */
function _todayEditAddSlots() {
  document.querySelectorAll('#todayGrid .today-col-add').forEach(b => b.remove());
  if (!_todayEdit) return;
  const n = _todayEditHidden().length;
  if (!n) return;
  for (const col of document.querySelectorAll('#todayGrid .today-col')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'today-col-add';
    b.title = `Add one of ${n} widget${n > 1 ? 's' : ''} not on this layout to this column`;
    b.innerHTML = `${SVGICONS.create(12, 12)}<span>Add widget</span>`;
    b.addEventListener('click', e => _todayEditAddMenu(e, +col.dataset.col));
    col.appendChild(b);
  }
}

async function _todaySaveLayouts(layouts) {
  try {
    const res = await fetch('/api/today/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layouts }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    _todayCfg = data.config;
    _todayFlash(`${ICONS.done} saved`);
    return true;
  } catch (err) {
    showMessage(`Could not save the layout: ${err.message}`);
    return false;
  }
}

// Pointer drag of a tile by its handle: drop position = column under the pointer + tile midpoints
let _todayDrag = null;

function _todayDragStart(e) {
  const handle = e.target.closest('.today-tile-handle');
  if (!handle || !_todayEdit || e.button > 0) return;
  e.preventDefault();
  const tile = handle.closest('.today-tile');
  tile.classList.add('today-tile--dragging');
  const ind = document.createElement('div');
  ind.className = 'today-drop-indicator';
  _todayDrag = { id: tile.dataset.tile, tile, ind, target: null };
  document.addEventListener('pointermove', _todayDragMove);
  document.addEventListener('pointerup', _todayDragEnd, { once: true });
  document.addEventListener('pointercancel', _todayDragEnd, { once: true });
}

function _todayDragMove(e) {
  if (!_todayDrag) return;
  const cols = [...document.querySelectorAll('#todayGrid .today-col')];
  let col = document.elementFromPoint(e.clientX, e.clientY)?.closest('.today-col');
  if (!col) {
    // Between columns / below the tiles: nearest column horizontally
    col = cols.reduce((best, c) => {
      const r = c.getBoundingClientRect();
      const d = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0;
      return !best || d < best.d ? { c, d } : best;
    }, null)?.c;
  }
  if (!col) return;
  const tiles = [...col.querySelectorAll('.today-tile')].filter(t => t !== _todayDrag.tile);
  let index = tiles.length;
  for (let i = 0; i < tiles.length; i++) {
    const r = tiles[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { index = i; break; }
  }
  _todayDrag.target = { col: +col.dataset.col, index };
  const addBtn = col.querySelector('.today-col-add');   // end of the column = above "+ Add widget"
  if (index < tiles.length) tiles[index].before(_todayDrag.ind);
  else if (addBtn) addBtn.before(_todayDrag.ind);
  else col.appendChild(_todayDrag.ind);
}

function _todayDragEnd() {
  document.removeEventListener('pointermove', _todayDragMove);
  if (!_todayDrag) return;
  const { id, tile, ind, target } = _todayDrag;
  _todayDrag = null;
  tile.classList.remove('today-tile--dragging');
  ind.remove();
  if (!target || !_todayEdit) return;
  const d = _todayEdit.draft;
  const moving = d.tiles.find(t => t.id === id);
  if (!moving) return;
  const others = d.tiles.filter(t => t.col === target.col && t.id !== id).sort((a, b) => a.order - b.order);
  others.splice(target.index, 0, moving);
  moving.col = target.col;
  others.forEach((t, i) => { t.order = i; });
  _todayEditCommit(id);   // a dragged "available" tile keeps its size, another one in the column falls back
}

// ---- Settings (Settings → Today) ----

async function loadTodaySettings() {
  const sec = document.getElementById('todaySection');
  if (!sec) return;
  let cfg;
  try { cfg = await fetch('/api/today/config').then(r => r.json()); } catch { return; }
  const w  = cfg.widgets?.weather || {};
  const cv = cfg.widgets?.cvapp   || {};
  document.getElementById('todayShowBar').checked = cfg.showBar !== false;
  document.querySelector('.today-wrow[data-widget="bar"]')?.classList.toggle('today-wrow--off', cfg.showBar === false);
  document.getElementById('todayRefresh').value = String(_todayRefreshMinutes(cfg));
  document.getElementById('todayAgendaDays').value = String(_todayAgendaRange(cfg));
  _todayRenderWidgetRows(cfg);
  document.getElementById('todayWeatherLabel').textContent = w.lat != null ? `${w.label || ''} (${(+w.lat).toFixed(2)}, ${(+w.lon).toFixed(2)})` : 'not set';
  document.getElementById('todayCvApiUrl').value    = cv.apiUrl || '';
  document.getElementById('todayCvPublicUrl').value = cv.publicUrl || '';
  const keyEl = document.getElementById('todayCvApiKey');
  keyEl.value = '';
  keyEl.placeholder = cv.hasApiKey ? '•••••• (stored — leave empty to keep)' : 'API key';
  sec.dataset.cfg = JSON.stringify(cfg);
  const qa = _todayQaCfg(cfg);
  document.getElementById('todayQaVisible').value = String(qa.visible);
  document.getElementById('todayQaSize').value    = qa.size;
  document.getElementById('todayQaTitles').checked = qa.showTitles;
  _todayQaRenderList(cfg);
}

/**
 * A widget counts as shown when it is not deactivated and at least one stored layout places it
 * (a widget added later, e.g. Notes, is missing from layouts saved before). Pure.
 */
function _todayWidgetShown(cfg, id) {
  if ((cfg?.disabled || []).includes(id)) return false;
  const layouts = Object.values(cfg?.layouts || {}).filter(Boolean);
  return !layouts.length || layouts.some(l => (l.tiles || []).some(t => t.id === id));
}

/** Settings → Today → Widgets: one row per registered tile (toggle + collapsed settings block). */
function _todayRenderWidgetRows(cfg) {
  const list = document.getElementById('todayWidgetList');
  if (!list) return;
  if (!list.dataset.built) {
    list.dataset.built = '1';
    for (const [id, def] of Object.entries(TODAY_TILES)) {
      const row = document.createElement('div');
      row.className = 'today-wrow';
      row.dataset.widget = id;
      row.innerHTML = `<div class="today-wrow-head">
          ${def.settings
            ? `<button class="today-wrow-expand" aria-expanded="false" title="Settings"><span class="today-wrow-caret" aria-hidden="true">▸</span><span class="today-wrow-title">${escHtml(def.title)}</span></button>`
            : `<span class="today-wrow-expand today-wrow-expand--none"><span class="today-wrow-title">${escHtml(def.title)}</span></span>`}
          <label class="settings-toggle" title="Show this widget on the Today page">
            <input type="checkbox" data-widget-toggle="${id}" aria-label="${escHtml(def.title)} widget">
            <span class="settings-toggle-track"></span>
          </label>
        </div>
        ${def.desc ? `<p class="settings-item-desc today-wrow-desc">${escHtml(def.desc)}</p>` : ''}
        <div class="today-wrow-body" hidden></div>`;
      const block = def.settings && document.querySelector(`#todayWidgetSettings [data-wset="${id}"]`);
      if (block) row.querySelector('.today-wrow-body').appendChild(block);
      row.querySelector('button.today-wrow-expand')?.addEventListener('click', e => {
        const btn = e.currentTarget;
        const body = row.querySelector('.today-wrow-body');
        body.hidden = !body.hidden;
        btn.setAttribute('aria-expanded', String(!body.hidden));
        row.classList.toggle('today-wrow--open', !body.hidden);
      });
      list.appendChild(row);
    }
  }
  for (const input of list.querySelectorAll('[data-widget-toggle]')) {
    const on = _todayWidgetShown(cfg, input.dataset.widgetToggle);
    input.checked = on;
    input.closest('.today-wrow').classList.toggle('today-wrow--off', !on);
  }
  if (_todayExpandWidget) {
    const row = list.querySelector(`.today-wrow[data-widget="${_todayExpandWidget}"]`);
    _todayExpandWidget = null;
    if (row && !row.classList.contains('today-wrow--open')) row.querySelector('button.today-wrow-expand')?.click();
    requestAnimationFrame(() => row?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
}

function _todaySettingsCfg() {
  try { return JSON.parse(document.getElementById('todaySection').dataset.cfg || '{}'); } catch { return {}; }
}

async function _todaySaveSettings(body, okMsg = 'saved') {
  const res = await fetch('/api/today/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  document.getElementById('todaySection').dataset.cfg = JSON.stringify(data.config);
  if (APP_PATH === '/today') { _todayCfg = data.config; _todaySchedule(); _todayRelayout(); loadToday(); }
  _todayFlash(`${ICONS.done} ${okMsg}`);
  return data.config;
}

function initTodaySettings() {
  const sec = document.getElementById('todaySection');
  if (!sec || sec.dataset.wired) return;
  sec.dataset.wired = '1';
  const result = document.getElementById('todaySettingsResult');
  const report = (msg, ok) => { result.textContent = msg; result.style.display = ''; result.className = `settings-webdav-result settings-webdav-result--${ok ? 'ok' : 'err'}`; };

  document.getElementById('todayShowBar').addEventListener('change', async e => {
    e.target.closest('.today-wrow')?.classList.toggle('today-wrow--off', !e.target.checked);
    try { await _todaySaveSettings({ showBar: e.target.checked }); } catch (err) { report(err.message, false); }
  });
  document.getElementById('todayRefresh').addEventListener('change', async e => {
    try { await _todaySaveSettings({ refreshMinutes: Number(e.target.value) }); } catch (err) { report(err.message, false); }
  });
  document.getElementById('todayAgendaDays').addEventListener('change', async e => {
    const cfg = _todaySettingsCfg();
    try { await _todaySaveSettings({ widgets: { ...(cfg.widgets || {}), agenda: { days: Number(e.target.value) } } }); } catch (err) { report(err.message, false); }
  });
  document.getElementById('todayWidgetList').addEventListener('change', async e => {
    const input = e.target.closest('[data-widget-toggle]');
    if (!input) return;
    const id  = input.dataset.widgetToggle;
    const cfg = _todaySettingsCfg();
    const off = (cfg.disabled || []).filter(x => x !== id);
    if (!input.checked) off.push(id);
    const body = { disabled: off };
    if (input.checked) body.layouts = _todayLayoutsWith(cfg.layouts, id);
    try {
      const saved = await _todaySaveSettings(body, `${TODAY_TILES[id].title} ${input.checked ? 'shown' : 'hidden'}`);
      _todayRenderWidgetRows(saved);
    } catch (err) { input.checked = !input.checked; report(err.message, false); }
  });

  const results = document.getElementById('todayWeatherResults');
  const search = async () => {
    const q = document.getElementById('todayWeatherQuery').value.trim();
    if (q.length < 2) return;
    results.innerHTML = '<p class="settings-item-desc">Searching…</p>';
    try {
      const r = await fetch(`/api/today/geocode?q=${encodeURIComponent(q)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      results.innerHTML = data.results.length
        ? data.results.map((p, i) => `<button class="btn today-geo-result" data-i="${i}">${escHtml(p.name)}${p.admin1 ? `, ${escHtml(p.admin1)}` : ''}${p.country ? ` (${escHtml(p.country)})` : ''}</button>`).join('')
        : '<p class="settings-item-desc">No places found.</p>';
      results.querySelectorAll('.today-geo-result').forEach(btn => btn.addEventListener('click', async () => {
        const p = data.results[+btn.dataset.i];
        const cfg = _todaySettingsCfg();
        try {
          await _todaySaveSettings({ widgets: { ...(cfg.widgets || {}), weather: { lat: p.lat, lon: p.lon, label: p.name } } });
          results.innerHTML = '';
          loadTodaySettings();
        } catch (err) { report(err.message, false); }
      }));
    } catch (err) { results.innerHTML = `<p class="settings-item-desc">${escHtml(err.message)}</p>`; }
  };
  document.getElementById('todayWeatherSearchBtn').addEventListener('click', search);
  document.getElementById('todayWeatherQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });

  document.getElementById('todayCvSaveBtn').addEventListener('click', async () => {
    const cfg = _todaySettingsCfg();
    const cvapp = {
      apiUrl:    document.getElementById('todayCvApiUrl').value.trim(),
      publicUrl: document.getElementById('todayCvPublicUrl').value.trim(),
    };
    const key = document.getElementById('todayCvApiKey').value.trim();
    if (key) cvapp.apiKey = key;
    try {
      await _todaySaveSettings({ widgets: { ...(cfg.widgets || {}), cvapp } });
      report('Saved.', true);
      loadTodaySettings();
    } catch (err) { report(err.message, false); }
  });

  _todayQaWire(report);

  document.getElementById('todayEditLayoutBtn').addEventListener('click', () => {
    if (APP_PATH !== '/today') { window.location.href = appUrl('/today?edit=1'); return; }
    document.getElementById('settingsBackdrop')?.style.setProperty('display', 'none');
    if (!_todayEdit) _todayStartEdit();
  });

  document.getElementById('todayResetLayoutsBtn').addEventListener('click', async () => {
    if (!(await showConfirm('Reset the dashboard layouts of all screen sizes to the default?', { okLabel: 'Reset' }))) return;
    try {
      const res = await fetch('/api/today/config/reset-layouts', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (APP_PATH === '/today') { _todayCfg = data.config; _todayRelayout(); loadToday(); }
      report('Layouts reset.', true);
    } catch (err) { report(err.message, false); }
  });
}

// ---- Settings → Today → Quick access ----

let _todayQaEdit    = null;   // open form: { idx (-1 = new), icon, iconFor (URL the fetched icon belongs to) }
let _todayQaDragIdx = null;

/** Stored Quick access settings with defaults (8 always shown, medium icons, titles shown). Pure. */
function _todayQaCfg(cfg) {
  const qa = cfg?.widgets?.quickaccess || {};
  return {
    visible: Number.isInteger(qa.visible) ? qa.visible : 8,
    size:    _TODAY_QA_SIZES.includes(qa.size) ? qa.size : 'm',
    showTitles: qa.showTitles !== false,
    items:   Array.isArray(qa.items) ? qa.items : [],
  };
}

async function _todayQaSave(patch, msg) {
  const cfg = _todaySettingsCfg();
  const quickaccess = { ..._todayQaCfg(cfg), ...patch };
  const saved = await _todaySaveSettings({ widgets: { ...(cfg.widgets || {}), quickaccess } }, msg);
  _todayQaRenderList(saved);
  return saved;
}

function _todayQaRenderList(cfg) {
  const list = document.getElementById('todayQaList');
  if (!list) return;
  const { items } = _todayQaCfg(cfg);
  list.innerHTML = items.length
    ? items.map((it, i) => `
      <div class="calendar-account-row cs-source-row today-qa-row" draggable="true" data-qa-idx="${i}" data-qa="${escHtml(it.id)}">
        <span class="cs-drag-handle" title="Drag to reorder">${_svgDragHandle()}</span>
        <span class="today-qa-preview today-qa-preview--sm">${_todayQaIconBoxHtml(it)}</span>
        <div class="calendar-account-info">
          <strong>${escHtml(it.title || _todayQaHost(it.url))}</strong>
          <span class="settings-item-desc">${escHtml(it.url)}</span>
        </div>
        <div class="calendar-account-actions">
          <button class="btn btn--icon" type="button" data-qa-edit="${i}" title="Edit">${SVGICONS.edit(14, 14)}</button>
          <button class="btn btn--icon" type="button" data-qa-del="${i}" title="Delete">${_svgDelete()}</button>
        </div>
      </div>`).join('')
    : '<p class="settings-item-desc" style="margin:4px 0 8px">No links yet.</p>';
  _todayQaImgFallback(list, items);
}

/** Move entry `from` before / onto position `to`. Pure. */
function _todayQaMove(items, from, to) {
  const out = items.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

function _todayQaMsg(text, ok = false) {
  const el = document.getElementById('todayQaMsg');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('today-qa-msg--err', !!text && !ok);
}

function _todayQaIconType() {
  return document.querySelector('input[name="todayQaIconType"]:checked')?.value === 'emoji' ? 'emoji' : 'image';
}

/** Form preview: emoji / fetched image / first letter, and the matching controls. */
function _todayQaSyncForm() {
  const type  = _todayQaIconType();
  const form  = document.getElementById('todayQaForm');
  form.querySelector('.today-qa-form-image').hidden = type !== 'image';
  form.querySelector('.today-qa-form-emoji').hidden = type !== 'emoji';
  const emoji = document.getElementById('todayQaEmoji').value.trim();
  const item  = {
    url: document.getElementById('todayQaUrl').value.trim(),
    title: document.getElementById('todayQaTitle').value.trim(),
    icon: type === 'emoji' ? (emoji ? { type: 'emoji', value: emoji } : null) : _todayQaImageIcon(),
  };
  const prev = document.getElementById('todayQaPreview');
  prev.className = `today-qa-preview today-qa--${document.getElementById('todayQaSize').value || 'm'}`;
  prev.innerHTML = _todayQaIconBoxHtml(item);
  _todayQaImgFallback(prev, [item]);
}

/** Image icon of the open form (fetched / uploaded file + the invert checkbox), or null. */
function _todayQaImageIcon() {
  const file = _todayQaEdit?.icon?.file;
  if (!file) return null;
  return document.getElementById('todayQaInvert').checked ? { type: 'image', file, invertDark: true } : { type: 'image', file };
}

function _todayQaOpenForm(idx) {
  const items = _todayQaCfg(_todaySettingsCfg()).items;
  const it = idx >= 0 ? items[idx] : null;
  _todayQaEdit = { idx, icon: it?.icon?.type === 'image' ? it.icon : null, iconFor: it?.url || '' };
  document.getElementById('todayQaUrl').value   = it?.url || '';
  document.getElementById('todayQaTitle').value = it?.title || '';
  document.getElementById('todayQaEmoji').value = it?.icon?.type === 'emoji' ? it.icon.value : '';
  document.getElementById('todayQaInvert').checked = !!it?.icon?.invertDark;
  for (const r of document.querySelectorAll('input[name="todayQaIconType"]')) r.checked = r.value === (it?.icon?.type === 'emoji' ? 'emoji' : 'image');
  document.getElementById('todayQaSaveBtn').textContent = it ? 'Save link' : 'Add link';
  _todayQaMsg('');
  const form = document.getElementById('todayQaForm');
  form.hidden = false;
  document.getElementById('todayQaAddBtn').hidden = true;
  _todayQaSyncForm();
  document.getElementById('todayQaUrl').focus();
}

function _todayQaCloseForm() {
  _todayQaEdit = null;
  _todayQaToggleEmoji(false);
  document.getElementById('todayQaForm').hidden = true;
  document.getElementById('todayQaAddBtn').hidden = false;
}

/** POST the URL / file to the icon endpoint; stores `{ type: 'image', file }` in the form state. */
async function _todayQaLoadIcon(request, iconFor) {
  const res  = await fetch(request.url, request.init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (_todayQaEdit) _todayQaEdit = { ..._todayQaEdit, icon: { type: 'image', file: data.file }, iconFor };
  _todayQaSyncForm();
  return data.file;
}

function _todayQaFetchIcon(url) {
  return _todayQaLoadIcon({ url: '/api/today/quickaccess/icon',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) } }, url);
}

function _todayQaToggleEmoji(show) {
  const pop = document.getElementById('todayQaEmojiPop');
  const btn = document.getElementById('todayQaEmojiBtn');
  if (!pop || typeof _mvRenderEmojiPop !== 'function') return;
  show ??= pop.hidden;
  if (show) _mvRenderEmojiPop(pop);
  pop.hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
}

function _todayQaWire(report) {
  const sizeEl = document.getElementById('todayQaSize');
  document.getElementById('todayQaVisible').addEventListener('change', async e => {
    const n = Math.max(0, Math.min(50, Math.round(Number(e.target.value) || 0)));
    e.target.value = String(n);
    try { await _todayQaSave({ visible: n }); } catch (err) { report(err.message, false); }
  });
  sizeEl.addEventListener('change', async () => {
    if (_todayQaEdit) _todayQaSyncForm();
    try { await _todayQaSave({ size: sizeEl.value }); } catch (err) { report(err.message, false); }
  });
  document.getElementById('todayQaTitles').addEventListener('change', async e => {
    try { await _todayQaSave({ showTitles: e.target.checked }); } catch (err) { report(err.message, false); }
  });

  // Entry list: edit / delete / drag to reorder
  const list = document.getElementById('todayQaList');
  list.addEventListener('click', async e => {
    const edit = e.target.closest('[data-qa-edit]');
    if (edit) { _todayQaOpenForm(Number(edit.dataset.qaEdit)); return; }
    const del = e.target.closest('[data-qa-del]');
    if (!del) return;
    const items = _todayQaCfg(_todaySettingsCfg()).items;
    const it = items[Number(del.dataset.qaDel)];
    if (!it || !(await showConfirm(`Remove "${it.title || _todayQaHost(it.url)}" from Quick access?`, { okLabel: 'Remove' }))) return;
    if (_todayQaEdit && _todayQaEdit.idx === Number(del.dataset.qaDel)) _todayQaCloseForm();
    try { await _todayQaSave({ items: items.filter(x => x !== it) }, 'Link removed'); } catch (err) { report(err.message, false); }
  });
  list.addEventListener('dragstart', e => {
    const row = e.target.closest('.today-qa-row');
    if (!row) return;
    _todayQaDragIdx = Number(row.dataset.qaIdx);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => row.classList.add('cs-row-dragging'), 0);
  });
  list.addEventListener('dragend', () => {
    _todayQaDragIdx = null;
    list.querySelectorAll('.today-qa-row').forEach(r => r.classList.remove('cs-row-dragging', 'cs-row-drag-over'));
  });
  list.addEventListener('dragover', e => {
    const row = e.target.closest('.today-qa-row');
    if (!row || _todayQaDragIdx === null || Number(row.dataset.qaIdx) === _todayQaDragIdx) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.querySelectorAll('.today-qa-row').forEach(r => r.classList.toggle('cs-row-drag-over', r === row));
  });
  list.addEventListener('drop', async e => {
    const row = e.target.closest('.today-qa-row');
    if (!row || _todayQaDragIdx === null) return;
    e.preventDefault();
    const to = Number(row.dataset.qaIdx);
    if (to === _todayQaDragIdx) return;
    const items = _todayQaMove(_todayQaCfg(_todaySettingsCfg()).items, _todayQaDragIdx, to);
    _todayQaDragIdx = null;
    if (_todayQaEdit) _todayQaCloseForm();   // indices changed
    try { await _todayQaSave({ items }, 'Order saved'); } catch (err) { report(err.message, false); }
  });

  // Add / edit form
  const form = document.getElementById('todayQaForm');
  document.getElementById('todayQaAddBtn').addEventListener('click', () => _todayQaOpenForm(-1));
  document.getElementById('todayQaCancelBtn').addEventListener('click', _todayQaCloseForm);
  form.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();   // keep the settings dialog open
    if (!document.getElementById('todayQaEmojiPop').hidden) _todayQaToggleEmoji(false); else _todayQaCloseForm();
  });
  form.addEventListener('input', e => { if (e.target.id !== 'todayQaUrl') _todayQaSyncForm(); });
  form.addEventListener('change', e => { if (e.target.name === 'todayQaIconType') _todayQaSyncForm(); });
  document.getElementById('todayQaUrl').addEventListener('change', e => {
    const url = e.target.value.trim();
    const title = document.getElementById('todayQaTitle');
    if (!title.value.trim() && safeLink(url)) title.placeholder = _todayQaHost(url);
  });

  const fetchBtn = document.getElementById('todayQaFetchBtn');
  fetchBtn.addEventListener('click', async () => {
    const url = document.getElementById('todayQaUrl').value.trim();
    if (!safeLink(url)) { _todayQaMsg('Enter an http(s) URL first.'); return; }
    fetchBtn.disabled = true;
    _todayQaMsg('Looking for the best icon…', true);
    try { await _todayQaFetchIcon(url); _todayQaMsg(''); }
    catch (err) { _todayQaMsg(`${err.message} — upload an image or choose an emoji.`); }
    finally { fetchBtn.disabled = false; }
  });
  const fileEl = document.getElementById('todayQaFile');
  document.getElementById('todayQaUploadBtn').addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', async () => {
    const file = fileEl.files?.[0];
    fileEl.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      // iconFor null: an uploaded image stays when the URL changes
      await _todayQaLoadIcon({ url: '/api/today/quickaccess/icon/upload', init: { method: 'POST', body: fd } }, null);
      _todayQaMsg('');
    } catch (err) { _todayQaMsg(err.message); }
  });

  // Emoji picker (the mail compose picker's categories and recent list)
  const pop = document.getElementById('todayQaEmojiPop');
  document.getElementById('todayQaEmojiBtn').addEventListener('click', () => _todayQaToggleEmoji());
  pop.addEventListener('click', e => {
    const tab = e.target.closest('[data-mv-emoji-tab]');
    if (tab) { _mvEmojiTab = tab.dataset.mvEmojiTab; _mvRenderEmojiPop(pop); return; }
    const em = e.target.closest('[data-mv-emoji]');
    if (!em) return;
    document.getElementById('todayQaEmoji').value = em.dataset.mvEmoji;
    _mvEmojiRemember(em.dataset.mvEmoji);
    _todayQaToggleEmoji(false);
    _todayQaSyncForm();
  });
  document.addEventListener('click', e => {
    if (!pop.hidden && !e.target.closest('#todayQaForm .mv-emoji-wrap')) _todayQaToggleEmoji(false);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_todayQaEdit) return;
    const url   = document.getElementById('todayQaUrl').value.trim();
    const title = document.getElementById('todayQaTitle').value.trim();
    if (!safeLink(url)) { _todayQaMsg('Enter an http(s) URL.'); return; }
    let icon;
    if (_todayQaIconType() === 'emoji') {
      const value = document.getElementById('todayQaEmoji').value.trim();
      if (!value) { _todayQaMsg('Choose an emoji.'); return; }
      icon = { type: 'emoji', value };
    } else {
      // No icon yet, or one fetched for a different URL → fetch it now
      if (!_todayQaEdit.icon || (_todayQaEdit.iconFor !== null && _todayQaEdit.iconFor !== url)) {
        _todayQaMsg('Looking for the best icon…', true);
        try { await _todayQaFetchIcon(url); }
        catch (err) { _todayQaMsg(`${err.message} — upload an image or choose an emoji.`); return; }
      }
      icon = _todayQaImageIcon();
    }
    const items = _todayQaCfg(_todaySettingsCfg()).items.slice();
    const { idx } = _todayQaEdit;
    const entry = { id: idx >= 0 && items[idx] ? items[idx].id : `qa-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, url, icon };
    if (title) entry.title = title;
    if (idx >= 0 && items[idx]) items[idx] = entry; else items.push(entry);
    try {
      await _todayQaSave({ items }, idx >= 0 ? 'Link saved' : 'Link added');
      _todayQaCloseForm();
    } catch (err) { _todayQaMsg(err.message); }
  });
}
