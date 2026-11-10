// ---- Calendar view (week / work week / month) — opened from Today ----
// Depends on dashboard.js globals: _calAccountsMeta, _defaultTimezone, openCalEventModal,
// _openEventDetail, _showCalEventContextMenu, _refreshCalendarAccount.

const _CV_HOUR_PX    = 48;          // default height of one hour in the time grid (Ctrl+0)
const _CV_ZOOM_KEY   = 'cal-view-hour-px';
const _CV_MIN_HOURS  = 6;           // max zoom: at least this many hours visible
const _CV_SNAP_MIN   = 15;          // drag / resize / create snapping
const _CV_MONTH_MAX  = 4;           // entry rows per month cell until the real row height is measured
const _CV_MODE_KEY   = 'cal-view-mode';
const _CV_MODES      = ['week', 'workweek', 'month'];
const _CV_HIDDEN_KEY = 'cal-view-hidden';   // accountIds switched off in the legend
const _CV_DAY_MS     = 86_400_000;

let _cvMode       = 'week';
let _cvAnchor     = new Date();     // any date inside the visible range
let _cvEvents     = new Map();      // per-render key → normalised occurrence (one entry per occurrence)
let _cvErrors     = [];             // [{ label, error }]
let _cvLoadSeq    = 0;              // discards responses of superseded loads
let _cvPushed     = false;          // true when open() pushed a history entry
let _cvNowTimer   = null;
let _cvDrag       = null;           // active pointer interaction
let _cvScrolled   = false;          // initial scroll to 07:00 done for this opening
let _cvZoomRaw    = _cvLoadZoom();   // requested hour height (fractional, Ctrl +/-, Ctrl+wheel)
let _cvHourPx     = Math.floor(_cvZoomRaw);   // rendered hour height — whole pixels keep grid lines crisp
let _cvHidden     = _cvLoadHidden(); // Set of hidden accountIds
let _cvAccountList = [];            // accounts of the last load (legend)
let _cvMonthLanes = _CV_MONTH_MAX;  // entry rows that fit into a month week row (measured)
let _cvZoomPending = null;          // { factor, clientY } batched per animation frame
let _cvFocusDay   = null;           // YYYY-MM-DD centred horizontally in week views (phones, after a month double tap)
let _cvTap        = null;           // pending month tap on phones: { ymd, timer }
let _cvDayListDay = null;           // day shown in the phone day overview (Date) or null

// Phones: same condition as the phone layout in calview.css
const _CV_PHONE_MQ   = '(max-width: 639px), (max-height: 500px)';
// Narrow phones (portrait): month dots of a day sit side by side — same condition as the compact month in calview.css
const _CV_NARROW_MQ  = '(max-width: 639px)';
const _CV_DBL_TAP_MS = 300;         // second tap on the same day within this time = double tap

// ---- Pure date helpers (unit-tested) ----

function _cvPad(n) { return String(n).padStart(2, '0'); }

/** Local calendar date as YYYY-MM-DD. */
function _cvYmd(d) { return `${d.getFullYear()}-${_cvPad(d.getMonth() + 1)}-${_cvPad(d.getDate())}`; }

/** Parse YYYY-MM-DD as local midnight. */
function _cvParseYmd(s) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Add calendar days (DST-safe: keeps the wall-clock time). */
function _cvAddDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

/** Whole calendar days from a to b (local dates, DST-safe). */
function _cvDayDiff(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / _CV_DAY_MS);
}

function _cvStartOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/** Monday of the week containing d (local midnight). */
function _cvMonday(d) { const s = _cvStartOfDay(d); return _cvAddDays(s, -((s.getDay() + 6) % 7)); }

/**
 * Visible range for a mode around an anchor date.
 * Returns { start, end (exclusive), days } — all local midnights; weeks start on Monday.
 */
function _cvRange(mode, anchor) {
  if (mode === 'month') {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last  = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const start = _cvMonday(first);
    const end   = _cvAddDays(_cvMonday(last), 7);
    return { start, end, days: _cvDayDiff(start, end) };
  }
  const start = _cvMonday(anchor);
  const days  = mode === 'workweek' ? 5 : 7;
  return { start, end: _cvAddDays(start, days), days };
}

/** Anchor moved one page forward (dir = 1) or back (dir = -1). */
function _cvStep(mode, anchor, dir) {
  if (mode === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  return _cvAddDays(anchor, 7 * dir);
}

/** ISO-8601 week number. */
function _cvIsoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y1) / _CV_DAY_MS + 1) / 7);
}

/** Snap minutes to the grid and clamp to [min, max]. */
function _cvSnap(minutes, min = 0, max = 24 * 60) {
  const s = Math.round(minutes / _CV_SNAP_MIN) * _CV_SNAP_MIN;
  return Math.max(min, Math.min(max, s));
}

/**
 * Side-by-side layout for overlapping timed segments of one day.
 * items: [{ startMin, endMin }] — mutated in place with { col, cols }.
 */
function _cvLayoutDay(items) {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  let cluster = [], colsEnd = [], clusterEnd = -1;
  const flush = () => { for (const it of cluster) it.cols = colsEnd.length; cluster = []; colsEnd = []; };
  for (const it of sorted) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    let col = colsEnd.findIndex(end => end <= it.startMin);
    if (col < 0) { col = colsEnd.length; colsEnd.push(it.endMin); } else colsEnd[col] = it.endMin;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return items;
}

/**
 * Assign lanes to all-day bars so overlapping bars stack.
 * bars: [{ from, to }] — day indices, `to` exclusive; mutated with { lane }. Returns lane count.
 */
function _cvLaneBars(bars) {
  const lanesEnd = [];
  for (const b of [...bars].sort((a, b) => a.from - b.from || b.to - a.to)) {
    let lane = lanesEnd.findIndex(end => end <= b.from);
    if (lane < 0) { lane = lanesEnd.length; lanesEnd.push(b.to); } else lanesEnd[lane] = b.to;
    b.lane = lane;
  }
  return lanesEnd.length;
}

/**
 * Month week row: hide lanes that don't fit. A day whose items need more than `max` lanes shows
 * max-1 lanes plus "+N more". Bars crossing such a day are split into visible segments.
 * items: [{ from, to, lane }] (after _cvLaneBars). Returns { segs: [{ item, from, to }], more: [n per day], limit: [lanes per day] }.
 */
function _cvClipLanes(items, days, max) {
  const used = Array(days).fill(0);
  for (const it of items) for (let i = it.from; i < it.to; i++) used[i] = Math.max(used[i], it.lane + 1);
  const limit = used.map(n => n > max ? max - 1 : max);
  const more  = Array(days).fill(0);
  const segs  = [];
  for (const it of items) {
    let runStart = null;
    for (let i = it.from; i <= it.to; i++) {
      const visible = i < it.to && it.lane < limit[i];
      if (i < it.to && !visible) more[i]++;
      if (visible && runStart == null) runStart = i;
      if (!visible && runStart != null) { segs.push({ item: it, from: runStart, to: i }); runStart = null; }
    }
  }
  return { segs, more, limit };
}

/** Wall-clock time of instant d in an IANA timezone as "YYYY-MM-DDTHH:MM:00". */
function _cvWallTime(d, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map(p => [p.type, p.value]));
  const h = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${h}:${parts.minute}:00`;
}

/** Start/end of an API event as Dates (all-day: local midnights, end exclusive). */
function _cvEventDates(ev) {
  if (ev.allDay) {
    const s = _cvParseYmd(ev.start);
    const e = ev.end ? _cvParseYmd(ev.end) : _cvAddDays(s, 1);
    return { s, e: e > s ? e : _cvAddDays(s, 1) };
  }
  const s = new Date(ev.start);
  const e = ev.end ? new Date(ev.end) : new Date(s.getTime() + 3_600_000);
  return { s, e: e > s ? e : new Date(s.getTime() + _CV_SNAP_MIN * 60_000) };
}

/**
 * PUT body for moving/resizing an occurrence to [newStart, newEnd).
 * scope: null (single event) | 'occurrence' | 'series'. tz: target IANA zone for timed events.
 * For a series, the wall-clock shift of the dragged occurrence is applied to the series start.
 */
function _cvBuildMoveBody(ev, newStart, newEnd, scope, tz) {
  const body = { title: ev.title || '(no title)', allDay: !!ev.allDay };
  if (ev.location)    body.location    = ev.location;
  if (ev.description) body.description = ev.description;
  if (ev.cardRefs?.length) body.cardRefs = ev.cardRefs;   // hidden card links survive the rebuild

  let s = newStart, e = newEnd;
  if (scope === 'series') {
    const orig     = _cvEventDates(ev).s;
    const dayDelta = _cvDayDiff(orig, newStart);
    const minDelta = (newStart.getHours() * 60 + newStart.getMinutes()) - (orig.getHours() * 60 + orig.getMinutes());
    const base     = _cvEventDates({ ...ev, start: ev.seriesStart || ev.start, end: null }).s;
    s = _cvAddDays(base, dayDelta);
    if (!ev.allDay) s = new Date(s.getTime() + minDelta * 60_000);
    e = ev.allDay ? _cvAddDays(s, _cvDayDiff(newStart, newEnd)) : new Date(s.getTime() + (newEnd - newStart));
    body.editScope = 'series';
  } else if (scope === 'occurrence') {
    body.editScope      = 'occurrence';
    body.occurrenceDate = ev.start;
  }

  if (ev.allDay) {
    body.start = _cvYmd(s);
    body.end   = _cvYmd(e);
  } else if (scope === 'series' || !tz || tz === 'UTC') {
    // Series patches convert UTC → master TZ server-side; UTC events are stored as UTC
    body.start = s.toISOString();
    body.end   = e.toISOString();
    if (tz && tz !== 'UTC') body.timezone = tz;
  } else {
    body.start    = _cvWallTime(s, tz);
    body.end      = _cvWallTime(e, tz);
    body.timezone = tz;
  }
  if (ev.etag) body.etag = ev.etag;
  if (ev.href) body.href = ev.href;
  return body;
}

/** Events touching `day` (local midnight): all-day / multi-day first, then by start and title. */
function _cvEventsOnDay(events, day) {
  const end = _cvAddDays(day, 1);
  return events.filter(ev => ev._s < end && ev._e > day).sort((a, b) =>
    (_cvIsBar(b) - _cvIsBar(a)) || (a._s - b._s) || (a.title || '').localeCompare(b.title || ''));
}

/** Time column of the day overview: "All day", "09:00 – 10:00", "… – 10:00" / "09:00 – …" when continuing. */
function _cvDayListTime(ev, day) {
  if (_cvIsBar(ev)) return 'All day';
  const end = _cvAddDays(day, 1);
  const from = ev._s < day ? '\u2026' : _cvTimeLabel(ev._s);
  const to   = ev._e > end ? '\u2026' : _cvTimeLabel(ev._e);
  return `${from} \u2013 ${to}`;
}

function _cvIsPhone() {
  return !!window.matchMedia?.(_CV_PHONE_MQ).matches;
}

function _cvIsNarrow() {
  return !!window.matchMedia?.(_CV_NARROW_MQ).matches;
}

// ---- Open / close / URL state ----

/**
 * Phones: calendar and mail view start below the app header (CSS var --app-header-h).
 * Uses the header's bottom edge, so a scrolled page leaves no gap. Shared with mailview.js.
 */
function _overlaySyncHeaderOffset() {
  const header = document.querySelector('header');
  if (!header) return;
  const bottom = Math.max(0, Math.round(header.getBoundingClientRect().bottom));
  document.documentElement.style.setProperty('--app-header-h', `${bottom}px`);
}

function _cvIsOpen() {
  const el = document.getElementById('calView');
  return !!el && el.style.display !== 'none';
}

function _cvSetUrl(push) {
  const url = new URL(window.location.href);
  url.searchParams.delete('mail');
  url.searchParams.delete('folder');
  url.searchParams.set('cal', _cvMode);
  url.searchParams.set('date', _cvYmd(_cvAnchor));
  if (push) history.pushState({ calView: true }, '', url);
  else history.replaceState(history.state, '', url);
}

function openCalView(mode) {
  _cvMode   = _CV_MODES.includes(mode) ? mode : (_cvStoredMode() || 'week');
  _cvAnchor = new Date();
  try { localStorage.setItem(_CV_MODE_KEY, _cvMode); } catch { /* ignore */ }
  // Exclusive with the mail view (mailview.js): take over its history entry instead of stacking another
  let push = true;
  if (typeof _mvIsOpen === 'function' && _mvIsOpen()) {
    _cvPushed = _mvPushed;
    _mvPushed = false;
    _mvHide();
    push = false;
  } else {
    _cvPushed = true;
  }
  _cvSetUrl(push);
  _cvShow();
}

function _cvStoredMode() {
  try { const m = localStorage.getItem(_CV_MODE_KEY); return _CV_MODES.includes(m) ? m : null; } catch { return null; }
}

function _cvShow() {
  _overlaySyncHeaderOffset();
  const el = document.getElementById('calView');
  el.style.display = '';
  _syncOverlayHost();
  document.body.classList.add('calview-open');
  document.getElementById('dashboardCalBtn')?.classList.add('open');
  _cvScrolled = false;
  clearInterval(_cvNowTimer);
  _cvNowTimer = setInterval(_cvUpdateNowLine, 60_000);
  _cvRender();
  _cvLoad();
}

function _cvHide() {
  const el = document.getElementById('calView');
  if (!el) return;
  el.style.display = 'none';
  _syncOverlayHost();
  document.body.classList.remove('calview-open');
  document.getElementById('dashboardCalBtn')?.classList.remove('open');
  clearInterval(_cvNowTimer);
  _cvDrag = null;
  _cvCloseDayList();
}

function closeCalView() {
  if (!_cvIsOpen()) return;
  _cvHide();
  if (_cvPushed) { _cvPushed = false; history.back(); return; }
  const url = new URL(window.location.href);
  url.searchParams.delete('cal');
  url.searchParams.delete('date');
  history.replaceState(history.state, '', url);
}

/** Open the view if the URL asks for it (called once the dashboard is initialised). */
function _cvInitFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const mode   = params.get('cal');
  if (!_CV_MODES.includes(mode)) { if (_cvIsOpen()) _cvHide(); return; }
  _cvMode = mode;
  const date = params.get('date');
  _cvAnchor = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? _cvParseYmd(date) : new Date();
  if (_cvIsOpen()) { _cvRender(); _cvLoad(); } else _cvShow();
}

/** `focusDay` (YYYY-MM-DD): week views scroll horizontally so this day is centred (phones). */
function _cvNavigate(anchor, mode, focusDay = null) {
  _cvFocusDay = focusDay;
  if (mode) {
    _cvMode = mode;
    try { localStorage.setItem(_CV_MODE_KEY, mode); } catch { /* ignore */ }
  }
  _cvAnchor = anchor;
  _cvSetUrl(false);
  _cvRender();
  _cvLoad();
}

// ---- Data ----

async function _cvAccounts() {
  if (_calAccountsMeta.length) return _calAccountsMeta;
  try {
    const cfg = await fetch('/api/dashboard/config').then(r => r.ok ? r.json() : {});
    return (cfg.calendarAccounts || []).map(a => ({
      accountId: a.id, label: a.label, type: a.type || 'caldav', color: a.color || null, webInterfaceUrl: a.webInterfaceUrl || null,
    }));
  } catch { return []; }
}

async function _cvLoad() {
  const seq   = ++_cvLoadSeq;
  const range = _cvRange(_cvMode, _cvAnchor);
  // Pad by a day on both sides: the server filters by UTC dates, the view by local dates
  const from  = _cvYmd(_cvAddDays(range.start, -1));
  const to    = _cvYmd(_cvAddDays(range.end, 1));
  const accounts = await _cvAccounts();
  _cvAccountList = accounts;
  document.getElementById('calViewBody').classList.add('calview-loading');

  const results = await Promise.all(accounts.map(acc =>
    fetch(`/api/dashboard/calendar/${encodeURIComponent(acc.accountId)}?from=${from}&to=${to}`)
      .then(r => r.json().then(d => r.ok ? d : { events: [], error: d.error || `HTTP ${r.status}` }))
      .catch(err => ({ events: [], error: err.message }))
  ));
  if (seq !== _cvLoadSeq) return;

  _cvEvents = new Map();
  _cvErrors = [];
  accounts.forEach((acc, i) => {
    const data = results[i];
    if (data.error) _cvErrors.push({ accountId: acc.accountId, label: acc.label || acc.accountId, error: data.error });
    for (const ev of (data.events || [])) {
      if (!ev.start) continue;
      const { s, e } = _cvEventDates(ev);
      if (s >= range.end || e <= range.start) continue;
      const key = `cv${_cvEvents.size}`;   // plain token: NUL separators don't survive HTML attributes
      _cvEvents.set(key, {
        ...ev, _key: key, _s: s, _e: e,
        _accountId: acc.accountId, _label: acc.label, _color: acc.color || '',
        _webUrl: acc.webInterfaceUrl || '', _accountType: data.type || acc.type || 'caldav',
      });
    }
  });
  document.getElementById('calViewBody').classList.remove('calview-loading');
  _cvRender();
}

// ---- Calendar visibility (legend) ----

function _cvLoadHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(_CV_HIDDEN_KEY)) || []); } catch { return new Set(); }
}

function _cvToggleAccount(accountId) {
  if (_cvHidden.has(accountId)) _cvHidden.delete(accountId); else _cvHidden.add(accountId);
  try { localStorage.setItem(_CV_HIDDEN_KEY, JSON.stringify([..._cvHidden])); } catch { /* ignore */ }
  _cvRender();
}

/** Events of the calendars currently switched on. */
function _cvVisibleEvents() {
  return [..._cvEvents.values()].filter(ev => !_cvHidden.has(ev._accountId));
}

function _cvAccColorCss(acc) { return acc.color ? `--card-color:${escHtml(acc.color)};` : ''; }

/** Legend at the bottom (large screens; phones use the toolbar menu); only with 2+ calendars. */
function _cvRenderLegend() {
  const legend = document.getElementById('calViewLegend');
  const multi  = _cvAccountList.length > 1;
  // CSS shows the legend on large screens only
  document.getElementById('calView').classList.toggle('calview--multi', multi);
  if (!multi) { legend.innerHTML = ''; return; }
  legend.innerHTML = _cvAccountList.map(acc => {
    const off = _cvHidden.has(acc.accountId);
    return `<button class="cv-legend-item${off ? ' cv-legend-off' : ''}" data-cv-acc="${escHtml(acc.accountId)}"
      style="${_cvAccColorCss(acc)}" aria-pressed="${!off}" title="${off ? 'Show' : 'Hide'} ${escHtml(acc.label || acc.accountId)}">
      <span class="cv-legend-swatch"></span>${escHtml(acc.label || acc.accountId)}</button>`;
  }).join('') + `<button class="cv-legend-settings" data-cv-settings="1" title="Calendar settings">${SVGICONS.settings(14, 14)}</button>`;
}

/** Phone toolbar menu: view modes, new event and (with 2+ calendars) calendar toggles. */
function _cvOpenMenu(pos) {
  const modeLabels = { week: 'Week', workweek: 'Work week', month: 'Month' };
  const items = _CV_MODES.map(mode => ({
    labelHtml: `<span class="ctx-icon">${mode === _cvMode ? '\u2713' : ''}</span>${modeLabels[mode]}`,
    action: () => _cvNavigate(_cvAnchor, mode),
  }));
  items.push({ separator: true });
  items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.create()}</span>New event`, action: () => _cvCreate(null) });
  items.push({ labelHtml: `<span class="ctx-icon">${SVGICONS.settings()}</span>Calendar settings`, action: () => openSettingsDialog('calendar-accounts') });
  if (_cvAccountList.length > 1) {
    items.push({ separator: true });
    for (const acc of _cvAccountList) {
      const on = !_cvHidden.has(acc.accountId);
      items.push({
        labelHtml: `<span class="ctx-icon cv-legend-check" style="${_cvAccColorCss(acc)}">${on ? SVGICONS.checkedBox() : SVGICONS.checkbox()}</span>${escHtml(acc.label || acc.accountId)}`,
        // Re-open so several calendars can be toggled in a row
        action: () => { _cvToggleAccount(acc.accountId); _cvOpenMenu(pos); },
      });
    }
  }
  openContextMenu(pos, items);
}

function _cvEditable(ev) { return (ev._accountType || 'caldav') !== 'ical-url'; }

/** Timed events lasting 24 h or longer are shown in the all-day row. */
function _cvIsBar(ev) { return ev.allDay || (ev._e - ev._s) >= _CV_DAY_MS; }

// ---- Render ----

function _cvRender() {
  const range = _cvRange(_cvMode, _cvAnchor);
  _cvRenderHeader(range);
  const body = document.getElementById('calViewBody');
  const errHtml = _cvErrors.filter(e => !_cvHidden.has(e.accountId)).map(e => `<div class="dashboard-source-error">⚠ ${escHtml(e.label)}: ${escHtml(e.error)}</div>`).join('');
  const prevScroll = body.querySelector('.cv-scroll')?.scrollTop;
  body.innerHTML = errHtml + (_cvMode === 'month' ? _cvMonthHtml(range) : _cvWeekHtml(range));
  const scroll = body.querySelector('.cv-scroll');
  if (scroll) {
    if (!_cvScrolled || prevScroll == null) { scroll.scrollTop = 7 * _cvHourPx - 10; _cvScrolled = true; }   // -10: room so the 07:00 label is not clipped
    else scroll.scrollTop = prevScroll;
  }
  if (_cvFocusDay && _cvMode !== 'month') _cvCenterDay(_cvFocusDay);
  _cvUpdateNowLine();
  _cvRenderLegend();
  if (_cvDayListDay) _cvRenderDayList();
  // Month: re-render once if more / fewer entry rows fit than assumed (row height is only known after layout)
  if (_cvMode === 'month') {
    const fit = _cvFitMonthLanes();
    if (fit && fit !== _cvMonthLanes) { _cvMonthLanes = fit; _cvRender(); return; }
  }
  // Window may have shrunk / grown since the zoom was stored — keep it within the visible bounds
  if (scroll && Math.floor(_cvClampZoom(_cvZoomRaw, scroll)) !== _cvHourPx) _cvApplyZoom(_cvZoomRaw, null);
}

/** Scroll the (horizontally scrollable, phones) week grid so the day's column is centred if possible. */
function _cvCenterDay(ymd) {
  const week = document.querySelector('#calViewBody .cv-week');
  const col  = week?.querySelector(`.cv-daycol[data-date="${ymd}"]`);
  if (!col || week.scrollWidth <= week.clientWidth) return;
  const w = week.getBoundingClientRect(), c = col.getBoundingClientRect();
  week.scrollLeft += (c.left + c.width / 2) - (w.left + w.width / 2);
}

// ---- Phones: month taps → day overview (single) / week (double) ----

function _cvMonthTap(day, cell) {
  const ymd = _cvYmd(day);
  if (_cvTap && _cvTap.ymd === ymd) {
    clearTimeout(_cvTap.timer);
    _cvTap = null;
    _cvNavigate(day, 'week', ymd);
    return;
  }
  if (_cvTap) clearTimeout(_cvTap.timer);
  document.querySelectorAll('#calViewBody .cv-tap').forEach(n => n.classList.remove('cv-tap'));
  cell?.classList.add('cv-tap');   // immediate feedback while waiting for a possible second tap
  _cvTap = { ymd, timer: setTimeout(() => {
    _cvTap = null;
    cell?.classList.remove('cv-tap');
    _cvOpenDayList(day);
  }, _CV_DBL_TAP_MS) };
}

function _cvOpenDayList(day) {
  _cvDayListDay = day;
  document.getElementById('calViewDayList').hidden = false;
  _cvRenderDayList();
}

function _cvCloseDayList() {
  _cvDayListDay = null;
  const el = document.getElementById('calViewDayList');
  if (el) el.hidden = true;
}

function _cvRenderDayList() {
  const day = _cvDayListDay;
  if (!day) return;
  document.getElementById('calViewDayListTitle').textContent =
    day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const evs = _cvEventsOnDay(_cvVisibleEvents(), day);
  const multi = _cvAccountList.length > 1;
  document.getElementById('calViewDayListItems').innerHTML = evs.length
    ? evs.map(ev => {
        const range = _cvIsBar(ev) && _cvDayDiff(_cvStartOfDay(ev._s), _cvStartOfDay(new Date(ev._e - 1))) > 0
          ? `${fmtDate(_cvYmd(ev._s))} \u2192 ${fmtDate(_cvYmd(ev.allDay ? _cvAddDays(ev._e, -1) : ev._e))}` : '';
        const sub = [range, ev.location, multi ? ev._label : ''].filter(Boolean).join(' \u00b7 ');
        return `<button class="cv-daylist-item" data-cv-key="${escHtml(ev._key)}" style="${_cvColorCss(ev)}">
          <span class="cv-daylist-time">${escHtml(_cvDayListTime(ev, day))}</span>
          <span class="cv-daylist-main"><span class="cv-daylist-title">${escHtml(ev.title || '(no title)')}</span>
          ${sub ? `<span class="cv-daylist-sub">${escHtml(sub)}</span>` : ''}</span></button>`;
      }).join('')
    : '<p class="dashboard-empty">No events on this day.</p>';
  document.querySelector('#calViewDayList [data-cv-daylist-new]').hidden = !_cvDefaultAccount();
}

/** Number of entry rows that fit into a month week row (day-number row excluded); null before layout. */
function _cvFitMonthLanes() {
  const week = document.querySelector('#calViewBody .cv-month-week');
  if (!week || !week.clientHeight) return null;
  const headRow = parseFloat(getComputedStyle(week).gridTemplateRows);   // first track = day numbers
  const lane    = parseFloat(getComputedStyle(week).getPropertyValue('--cv-lane'));
  if (!(lane > 0)) return null;
  return Math.max(1, Math.floor((week.clientHeight - headRow) / lane));
}

// ---- Zoom (hour height) ----

function _cvLoadZoom() {
  try {
    const px = parseFloat(localStorage.getItem(_CV_ZOOM_KEY));
    return px > 0 ? px : _CV_HOUR_PX;
  } catch { return _CV_HOUR_PX; }
}

// Zoomed out: the whole day (00:00–24:00) fills the grid; zoomed in: _CV_MIN_HOURS hours fill it
function _cvClampZoom(px, scroll) {
  const h = scroll.clientHeight;
  if (!h) return px;
  return Math.min(h / _CV_MIN_HOURS, Math.max(h / 24, px));
}

// Re-renders with a new hour height, keeping the time under clientY (or the grid centre) in place
function _cvApplyZoom(px, clientY) {
  const scroll = document.querySelector('#calViewBody .cv-scroll');
  if (!scroll) return;
  const rect = scroll.getBoundingClientRect();
  const offset = clientY == null ? scroll.clientHeight / 2 : Math.min(Math.max(clientY - rect.top, 0), scroll.clientHeight);
  const minute = (scroll.scrollTop + offset) / _cvHourPx * 60;
  _cvZoomRaw = _cvClampZoom(px, scroll);
  _cvHourPx  = Math.max(1, Math.floor(_cvZoomRaw));
  try { localStorage.setItem(_CV_ZOOM_KEY, String(_cvZoomRaw)); } catch { /* ignore */ }
  _cvRender();
  const next = document.querySelector('#calViewBody .cv-scroll');
  if (next) next.scrollTop = minute / 60 * _cvHourPx - offset;
}

// Batches rapid wheel / trackpad-pinch events into one re-render per frame
function _cvZoomBy(factor, clientY) {
  if (_cvMode === 'month' || _cvDrag) return;
  if (_cvZoomPending) { _cvZoomPending.factor *= factor; _cvZoomPending.clientY = clientY; return; }
  _cvZoomPending = { factor, clientY };
  requestAnimationFrame(() => {
    const { factor: f, clientY: y } = _cvZoomPending;
    _cvZoomPending = null;
    _cvApplyZoom(_cvZoomRaw * f, y);
  });
}

function _cvRenderHeader(range) {
  const last = _cvAddDays(range.end, -1);
  let title;
  if (_cvMode === 'month') {
    title = _cvAnchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  } else {
    const sameMonth = range.start.getMonth() === last.getMonth();
    const from = range.start.toLocaleDateString([], sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
    const to   = last.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    title = `CW ${_cvIsoWeek(range.start)} · ${from} – ${to}`;
  }
  document.getElementById('calViewTitle').textContent = title;
  for (const btn of document.querySelectorAll('#calView [data-cv-mode]')) {
    btn.classList.toggle('active', btn.dataset.cvMode === _cvMode);
  }
}

function _cvEvAttrs(ev) { return `data-cv-key="${escHtml(ev._key)}"`; }

function _cvColorCss(ev) { return ev._color ? `--card-color:${escHtml(ev._color)};` : ''; }

function _cvWeekendCls(d) { return d.getDay() === 0 || d.getDay() === 6 ? ' cv-weekend' : ''; }

function _cvTimeLabel(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function _cvTooltip(ev) {
  const when = ev.allDay
    ? (_cvDayDiff(ev._s, ev._e) > 1 ? `${fmtDate(_cvYmd(ev._s))} → ${fmtDate(_cvYmd(_cvAddDays(ev._e, -1)))}` : '')
    : `${_cvTimeLabel(ev._s)} – ${_cvTimeLabel(ev._e)}`;
  return [ev.title, when, ev.location].filter(Boolean).join('\n');
}

function _cvWeekHtml(range) {
  const days  = Array.from({ length: range.days }, (_, i) => _cvAddDays(range.start, i));
  const today = _cvYmd(new Date());
  const evs   = _cvVisibleEvents();

  const head = days.map(d => {
    const ymd = _cvYmd(d);
    return `<div class="cv-dayhead${ymd === today ? ' cv-today' : ''}${_cvWeekendCls(d)}" data-date="${ymd}">
      <span class="cv-dayhead-wd">${escHtml(d.toLocaleDateString([], { weekday: 'short' }))}</span>
      <span class="cv-dayhead-num">${d.getDate()}</span></div>`;
  }).join('');

  // All-day / multi-day bars
  const bars = evs.filter(_cvIsBar).map(ev => {
    const from = Math.max(0, _cvDayDiff(range.start, ev._s));
    const endDay = ev.allDay ? ev._e : _cvAddDays(_cvStartOfDay(new Date(ev._e - 1)), 1);
    const to   = Math.min(range.days, _cvDayDiff(range.start, endDay));
    return { ev, from, to: Math.max(to, from + 1) };
  });
  const lanes = _cvLaneBars(bars);
  const barsHtml = bars.map(({ ev, from, to, lane }) => {
    const cls = `cv-ev cv-bar${_cvEditable(ev) ? '' : ' cv-readonly'}${ev._s < range.start ? ' cv-cont-left' : ''}${ev._e > range.end ? ' cv-cont-right' : ''}`;
    return `<div class="${cls}" ${_cvEvAttrs(ev)} title="${escHtml(_cvTooltip(ev))}"
      style="grid-column:${from + 1}/${to + 1};grid-row:${lane + 1};${_cvColorCss(ev)}">${escHtml(ev.title)}</div>`;
  }).join('');
  const allDayCells = days.map((d, i) => `<div class="cv-allday-cell${_cvWeekendCls(d)}" data-date="${_cvYmd(d)}" style="grid-column:${i + 1};grid-row:1/${Math.max(lanes, 1) + 1}"></div>`).join('');

  // Timed segments per day
  const cols = days.map(d => {
    const ymd     = _cvYmd(d);
    const dayEnd  = _cvAddDays(d, 1);
    const segs = evs.filter(ev => !_cvIsBar(ev) && ev._s < dayEnd && ev._e > d).map(ev => {
      const s = ev._s < d ? d : ev._s;
      const e = ev._e > dayEnd ? dayEnd : ev._e;
      const startMin = (s - d) / 60_000;
      const endMin   = Math.max(startMin + _CV_SNAP_MIN, (e - d) / 60_000);
      return { ev, startMin, endMin, contTop: ev._s < d, contBottom: ev._e > dayEnd };
    });
    _cvLayoutDay(segs);
    const segHtml = segs.map(sg => {
      const { ev } = sg;
      const top    = sg.startMin / 60 * _cvHourPx;
      const height = (sg.endMin - sg.startMin) / 60 * _cvHourPx;
      const short  = sg.endMin - sg.startMin <= 30;
      const editable = _cvEditable(ev);
      const cls = `cv-ev cv-timed${editable ? '' : ' cv-readonly'}${short ? ' cv-short' : ''}${new Date() > ev._e ? ' cv-past' : ''}`;
      return `<div class="${cls}" ${_cvEvAttrs(ev)} title="${escHtml(_cvTooltip(ev))}"
        style="top:${top}px;height:${height}px;left:calc(${sg.col} * 100% / ${sg.cols});width:calc(100% / ${sg.cols});${_cvColorCss(ev)}">
        <span class="cv-ev-time">${escHtml(sg.contTop ? '↑ ' + _cvTimeLabel(ev._s) : _cvTimeLabel(ev._s))}</span>
        <span class="cv-ev-title">${escHtml(ev.title)}</span>
        ${_cvEvLocHtml(ev)}
        ${editable && !sg.contBottom ? '<span class="cv-resize" data-cv-resize="1"></span>' : ''}
      </div>`;
    }).join('');
    return `<div class="cv-daycol${ymd === today ? ' cv-today' : ''}${_cvWeekendCls(d)}" data-date="${ymd}">${segHtml}</div>`;
  }).join('');

  const hours = Array.from({ length: 24 }, (_, h) => `<div class="cv-hour"><span>${h ? `${_cvPad(h)}:00` : ''}</span></div>`).join('');

  return `<div class="cv-week" style="--cv-days:${range.days};--cv-hour:${_cvHourPx}px">
    <div class="cv-weekhead"><div class="cv-gutter"></div><div class="cv-dayheads">${head}</div></div>
    <div class="cv-allday"><div class="cv-gutter cv-allday-label">all-day</div>
      <div class="cv-allday-grid" style="grid-template-rows:repeat(${Math.max(lanes, 1)}, 22px)">${allDayCells}${barsHtml}</div></div>
    <div class="cv-scroll"><div class="cv-grid">
      <div class="cv-hours">${hours}</div>
      <div class="cv-daycols">${cols}</div>
    </div></div>
  </div>`;
}

/** One month entry (bar segment or dot); `place` = grid placement, empty inside a .cv-month-dots row. */
function _cvMonthEvHtml(item, from, to, place = '') {
  const { ev } = item;
  const cls = `cv-ev cv-month-ev${item.bar ? ' cv-month-bar' : ''}${_cvEditable(ev) ? '' : ' cv-readonly'}`
    + `${item.bar && item.contLeft && from === 0 ? ' cv-cont-left' : ''}${item.bar && item.contRight && to === 7 ? ' cv-cont-right' : ''}`;
  const time = item.bar ? '' : `<span class="cv-ev-time">${escHtml(_cvTimeLabel(ev._s < item.day ? item.day : ev._s))}</span>`;
  return `<div class="${cls}" ${_cvEvAttrs(ev)} title="${escHtml(_cvTooltip(ev))}"
    style="${place}${_cvColorCss(ev)}">${time}<span class="cv-ev-title">${escHtml(ev.title)}</span></div>`;
}

function _cvMonthHtml(range) {
  const today   = _cvYmd(new Date());
  const month   = _cvAnchor.getMonth();
  // Bars first, then by start — _cvLaneBars' sort is stable, so this order breaks its ties
  const evs     = _cvVisibleEvents().sort((a, b) =>
    (_cvIsBar(b) - _cvIsBar(a)) || (a._s - b._s) || (a.title || '').localeCompare(b.title || ''));
  const narrow  = _cvIsNarrow();
  const wdHead  = Array.from({ length: 7 }, (_, i) =>
    `<div class="cv-month-wd">${escHtml(_cvAddDays(range.start, i).toLocaleDateString([], { weekday: 'short' }))}</div>`).join('');

  const weeks = Array.from({ length: range.days / 7 }, (_, w) => {
    const weekStart = _cvAddDays(range.start, w * 7);
    const weekEnd   = _cvAddDays(weekStart, 7);
    const days      = Array.from({ length: 7 }, (_, i) => _cvAddDays(weekStart, i));

    // Multi-day / all-day events → one item spanning their days; others → one item per covered day
    const items = [];
    for (const ev of evs) {
      if (ev._s >= weekEnd || ev._e <= weekStart) continue;
      if (_cvIsBar(ev)) {
        const endDay = ev.allDay ? ev._e : _cvAddDays(_cvStartOfDay(new Date(ev._e - 1)), 1);
        const from = Math.max(0, _cvDayDiff(weekStart, ev._s));
        const to   = Math.min(7, _cvDayDiff(weekStart, endDay));
        items.push({ ev, bar: true, from, to: Math.max(to, from + 1), contLeft: _cvStartOfDay(ev._s) < weekStart, contRight: endDay > weekEnd });
      } else {
        days.forEach((d, i) => { if (ev._s < _cvAddDays(d, 1) && ev._e > d) items.push({ ev, bar: false, from: i, to: i + 1, day: d }); });
      }
    }
    // Narrow phones: only bars take lanes (one lane kept free); each day's dots share one wrapping row below them
    const laned = narrow ? items.filter(it => it.bar) : items;
    const dots  = narrow ? items.filter(it => !it.bar) : [];
    _cvLaneBars(laned);
    const { segs, more, limit } = _cvClipLanes(laned, 7, narrow ? Math.max(1, _cvMonthLanes - 1) : _cvMonthLanes);

    const cells = days.map((d, i) => {
      const ymd = _cvYmd(d);
      const cls = `cv-month-cell${d.getMonth() !== month ? ' cv-other-month' : ''}${ymd === today ? ' cv-today' : ''}${_cvWeekendCls(d)}`;
      return `<div class="${cls}" data-date="${ymd}" style="grid-column:${i + 1}">
        <button class="cv-month-num" data-cv-goto="${ymd}" title="Show week">${d.getDate()}</button>${i === 0
          ? `<button class="cv-month-cw" data-cv-goto="${ymd}" title="Show week">CW ${_cvIsoWeek(d)}</button>` : ''}</div>`;
    }).join('');

    const evHtml = segs.map(({ item, from, to }) =>
      _cvMonthEvHtml(item, from, to, `grid-column:${from + 1}/${to + 1};grid-row:${item.lane + 2};`)).join('');

    const moreBtn  = (n, i, style = '') =>
      `<button class="cv-month-more" data-cv-goto="${_cvYmd(days[i])}"${style}>+${n} more</button>`;
    const moreHtml = narrow
      ? days.map((d, i) => {
          const dayDots = dots.filter(it => it.from === i).map(item => _cvMonthEvHtml(item, i, i + 1)).join('');
          if (!dayDots && !more[i]) return '';
          const row = segs.reduce((r, sg) => sg.from <= i && i < sg.to ? Math.max(r, sg.item.lane + 1) : r, 0);
          return `<div class="cv-month-dots" style="grid-column:${i + 1};grid-row:${row + 2}/-1">${dayDots}${more[i] ? moreBtn(more[i], i) : ''}</div>`;
        }).join('')
      : more.map((n, i) => n ? moreBtn(n, i, ` style="grid-column:${i + 1};grid-row:${limit[i] + 2}"`) : '').join('');

    return `<div class="cv-month-week">${cells}${evHtml}${moreHtml}</div>`;
  }).join('');

  return `<div class="cv-month${narrow ? ' cv-month--narrow' : ''}" style="--cv-weeks:${range.days / 7};--cv-lanes:${_cvMonthLanes}">
    <div class="cv-month-head">${wdHead}</div>
    <div class="cv-month-grid">${weeks}</div>
  </div>`;
}

function _cvUpdateNowLine() {
  const body = document.getElementById('calViewBody');
  if (!body) return;
  body.querySelector('.cv-now')?.remove();
  const col = body.querySelector(`.cv-daycol[data-date="${_cvYmd(new Date())}"]`);
  if (!col) return;
  const now  = new Date();
  const line = document.createElement('div');
  line.className = 'cv-now';
  line.style.top = `${(now.getHours() * 60 + now.getMinutes()) / 60 * _cvHourPx}px`;
  col.appendChild(line);
}

// ---- Create / save ----

function _cvDefaultAccount() {
  return _calAccountsMeta.find(a => (a.type || 'caldav') !== 'ical-url') || null;
}

function _cvCreate(prefill) {
  const acc = _cvDefaultAccount();
  if (!acc) { showMessage('No writable (CalDAV) calendar account configured.'); return; }
  openCalEventModal(acc.accountId, null, acc, undefined, prefill);
}

async function _cvSaveMove(ev, newStart, newEnd) {
  if (+newStart === +ev._s && +newEnd === +ev._e) { _cvRender(); return; }

  let scope = null;
  if (ev.hasRrule) {
    const choice = await showConfirm(`“${ev.title}” is a recurring event. Move only this occurrence or the entire series?`,
      { okLabel: 'This occurrence', altLabel: 'Entire series', cancelLabel: 'Cancel' });
    if (choice === false) { _cvRender(); return; }
    scope = choice === true ? 'occurrence' : 'series';
  }

  // Optimistic: show the new position right away
  const prev = { s: ev._s, e: ev._e };
  ev._s = newStart; ev._e = newEnd;
  _cvRender();

  const accountId = ev._accountId;
  const tz = ev.timezone || _defaultTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let fresh = null;
  try {
    fresh = await fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(ev.uid)}`)
      .then(r => r.ok ? r.json() : null);
  } catch { /* fall back to cached etag/href */ }
  const body = _cvBuildMoveBody({ ...ev, etag: fresh?.etag ?? ev.etag, href: fresh?.href ?? ev.href,
    cardRefs: fresh ? fresh.cardRefs : ev.cardRefs }, newStart, newEnd, scope, tz);

  try {
    const res  = await fetch(`/api/dashboard/calendar/${encodeURIComponent(accountId)}/event/${encodeURIComponent(ev.uid)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Save failed (${res.status})`);
    }
  } catch (err) {
    ev._s = prev.s; ev._e = prev.e;
    _cvRender();
    await showMessage(err.message);
  }
  _cvLoad();
  _refreshCalendarAccount(accountId);
}

// ---- Pointer interactions ----

/** Time-grid position under the pointer → { col, date (local midnight), minutes } or null. */
function _cvGridPoint(clientX, clientY) {
  const cols = [...document.querySelectorAll('#calViewBody .cv-daycol')];
  for (const col of cols) {
    const r = col.getBoundingClientRect();
    if (clientX >= r.left && clientX < r.right) {
      return { col, date: _cvParseYmd(col.dataset.date), minutes: (clientY - r.top) / _cvHourPx * 60 };
    }
  }
  // Pointer left the grid horizontally → clamp to the first/last column
  if (!cols.length) return null;
  const first = cols[0].getBoundingClientRect();
  const col   = clientX < first.left ? cols[0] : cols[cols.length - 1];
  const r     = col.getBoundingClientRect();
  return { col, date: _cvParseYmd(col.dataset.date), minutes: (clientY - r.top) / _cvHourPx * 60 };
}

/** Date cell ([data-date] in the all-day row or month grid) under the pointer. */
function _cvDateAt(clientX, clientY) {
  const el = document.elementsFromPoint(clientX, clientY)
    .find(n => n.matches?.('.cv-allday-cell, .cv-month-cell, .cv-dayhead'));
  return el ? _cvParseYmd(el.dataset.date) : null;
}

/** Second line of a timed event: the online-meeting link (today.js helpers), else the location. */
function _cvEvLocHtml(ev) {
  const meet = _todayMeetingLink(ev);
  if (meet) return `<span class="cv-ev-loc">${_todayMeetingHtml(meet)}</span>`;
  const loc = _todayDecodeEntities(ev.location).trim();
  return loc ? `<span class="cv-ev-loc" title="${escHtml(loc)}">${escHtml(loc)}</span>` : '';
}

function _cvPointerDown(e) {
  if (e.button !== 0 || _cvDrag) return;
  if (e.target.closest('.today-ev-meet')) return;   // meeting link opens itself in a new tab
  // Phones, month: taps open the day overview instead of single entries (see _cvMonthTap)
  if (_cvMode === 'month' && _cvIsPhone() && e.target.closest('.cv-month-grid')) return;
  const evEl = e.target.closest('.cv-ev');
  if (evEl) {
    const ev = _cvEvents.get(evEl.dataset.cvKey);
    if (!ev) return;
    const resize = !!e.target.closest('[data-cv-resize]');
    const kind   = resize ? 'resize' : (evEl.classList.contains('cv-timed') ? 'move-timed' : 'move-day');
    _cvDrag = { kind, ev, el: evEl, x0: e.clientX, y0: e.clientY, moved: false, pointerId: e.pointerId, pointerType: e.pointerType };
    if (kind === 'move-timed' || kind === 'resize') {
      const p = _cvGridPoint(e.clientX, e.clientY);
      // Minutes between the event start and the grab point — kept constant while moving
      _cvDrag.grabMin = p ? (p.date - ev._s) / 60_000 + p.minutes : 0;
    } else {
      _cvDrag.grabDate = _cvDateAt(e.clientX, e.clientY) || _cvStartOfDay(ev._s);
    }
    return;
  }
  const col = e.target.closest('.cv-daycol');
  if (col) {
    const p = _cvGridPoint(e.clientX, e.clientY);
    _cvDrag = { kind: 'create', col, date: p.date, startMin: _cvSnap(Math.floor(p.minutes / _CV_SNAP_MIN) * _CV_SNAP_MIN),
      x0: e.clientX, y0: e.clientY, moved: false, pointerId: e.pointerId, pointerType: e.pointerType };
  }
}

function _cvPointerMove(e) {
  const d = _cvDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  if (!d.moved) {
    if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 5) return;
    // Touch: dragging on empty grid scrolls instead of creating
    if (d.kind === 'create' && d.pointerType === 'touch') { _cvDrag = null; return; }
    if (d.kind !== 'create' && !_cvEditable(d.ev)) { _cvDrag = null; return; }
    d.moved = true;
    document.getElementById('calView').classList.add('cv-dragging');
    if (d.el) d.el.classList.add('cv-ev--dragging');
  }
  e.preventDefault();
  const ev = d.ev;

  if (d.kind === 'move-timed') {
    const p = _cvGridPoint(e.clientX, e.clientY);
    if (!p) return;
    const dur      = ev._e - ev._s;
    const startMin = _cvSnap(p.minutes - d.grabMin, 0, 24 * 60 - _CV_SNAP_MIN);
    d.newStart = new Date(p.date.getFullYear(), p.date.getMonth(), p.date.getDate(), 0, startMin);
    d.newEnd   = new Date(d.newStart.getTime() + dur);
    if (d.el.parentElement !== p.col) p.col.appendChild(d.el);
    d.el.style.top   = `${startMin / 60 * _cvHourPx}px`;
    d.el.style.left  = '0';
    d.el.style.width = '100%';
    d.el.querySelector('.cv-ev-time').textContent = `${_cvTimeLabel(d.newStart)} – ${_cvTimeLabel(d.newEnd)}`;
  } else if (d.kind === 'resize') {
    const col   = d.el.parentElement;
    const r     = col.getBoundingClientRect();
    const day   = _cvParseYmd(col.dataset.date);
    const segStartMin = parseFloat(d.el.style.top) / _cvHourPx * 60;
    const endMin = _cvSnap((e.clientY - r.top) / _cvHourPx * 60, segStartMin + _CV_SNAP_MIN, 24 * 60);
    d.newStart = ev._s;
    d.newEnd   = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, endMin);
    d.el.style.height = `${(endMin - segStartMin) / 60 * _cvHourPx}px`;
    d.el.querySelector('.cv-ev-time').textContent = `${_cvTimeLabel(ev._s)} – ${_cvTimeLabel(d.newEnd)}`;
  } else if (d.kind === 'move-day') {
    const target = _cvDateAt(e.clientX, e.clientY);
    document.querySelectorAll('#calViewBody .cv-drop-target').forEach(n => n.classList.remove('cv-drop-target'));
    if (!target) { d.newStart = null; return; }
    const delta = _cvDayDiff(d.grabDate, target);
    d.newStart = _cvAddDays(ev._s, delta);
    d.newEnd   = _cvAddDays(ev._e, delta);
    for (let i = 0; i < Math.max(1, _cvDayDiff(_cvStartOfDay(d.newStart), _cvStartOfDay(new Date(d.newEnd - 1))) + 1); i++) {
      document.querySelector(`#calViewBody [data-date="${_cvYmd(_cvAddDays(d.newStart, i))}"]:is(.cv-allday-cell, .cv-month-cell)`)?.classList.add('cv-drop-target');
    }
  } else if (d.kind === 'create') {
    const p = _cvGridPoint(e.clientX, e.clientY);
    const curMin = _cvSnap(p && +p.date === +d.date ? p.minutes : (p && p.date > d.date ? 24 * 60 : 0));
    const a = Math.min(d.startMin, curMin), b = Math.max(d.startMin + _CV_SNAP_MIN, curMin);
    d.selStart = a; d.selEnd = Math.max(b, a + _CV_SNAP_MIN);
    if (!d.ghost) { d.ghost = document.createElement('div'); d.ghost.className = 'cv-selection'; d.col.appendChild(d.ghost); }
    d.ghost.style.top    = `${d.selStart / 60 * _cvHourPx}px`;
    d.ghost.style.height = `${(d.selEnd - d.selStart) / 60 * _cvHourPx}px`;
    d.ghost.textContent  = `${_cvPad(Math.floor(d.selStart / 60))}:${_cvPad(d.selStart % 60)} – ${_cvPad(Math.floor(d.selEnd / 60) % 24)}:${_cvPad(d.selEnd % 60)}`;
  }
}

function _cvPointerUp(e) {
  const d = _cvDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  _cvDrag = null;
  document.getElementById('calView').classList.remove('cv-dragging');
  document.querySelectorAll('#calViewBody .cv-drop-target').forEach(n => n.classList.remove('cv-drop-target'));

  if (e.type === 'pointercancel') { if (d.moved) _cvRender(); return; }

  if (!d.moved) {
    if (d.kind === 'create') {
      const start = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), 0, d.startMin);
      _cvCreate({ start, end: new Date(start.getTime() + 3_600_000), allDay: false });
    } else if (d.kind !== 'resize') {
      _openEventDetail(d.ev._accountId, d.ev.uid, d.ev._webUrl, d.ev);
    }
    return;
  }

  if (d.kind === 'create') {
    d.ghost?.remove();
    const start = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), 0, d.selStart);
    const end   = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), 0, d.selEnd);
    _cvCreate({ start, end, allDay: false });
    return;
  }
  if (!d.newStart) { _cvRender(); return; }
  _cvSaveMove(d.ev, d.newStart, d.newEnd);
}

// ---- Wiring ----

document.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('header');
  if (header && typeof ResizeObserver === 'function') new ResizeObserver(_overlaySyncHeaderOffset).observe(header);
  window.addEventListener('resize', _overlaySyncHeaderOffset);

  const view = document.getElementById('calView');
  if (!view) return;
  const body = document.getElementById('calViewBody');

  document.getElementById('calViewClose').addEventListener('click', closeCalView);
  document.getElementById('calViewPrev').addEventListener('click', () => _cvNavigate(_cvStep(_cvMode, _cvAnchor, -1)));
  document.getElementById('calViewNext').addEventListener('click', () => _cvNavigate(_cvStep(_cvMode, _cvAnchor, 1)));
  document.getElementById('calViewToday').addEventListener('click', () => _cvNavigate(new Date()));
  document.getElementById('calViewNew').addEventListener('click', () => _cvCreate(null));
  document.getElementById('calViewLegend').addEventListener('click', e => {
    if (e.target.closest('[data-cv-settings]')) { openSettingsDialog('calendar-accounts'); return; }
    const item = e.target.closest('[data-cv-acc]');
    if (item) _cvToggleAccount(item.dataset.cvAcc);
  });
  document.getElementById('calViewMenuBtn').addEventListener('click', e => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    _cvOpenMenu({ clientX: r.left, clientY: r.bottom + 4, stopPropagation() {}, preventDefault() {} });
  });
  for (const btn of view.querySelectorAll('[data-cv-mode]')) {
    btn.addEventListener('click', () => _cvNavigate(_cvAnchor, btn.dataset.cvMode));
  }

  body.addEventListener('pointerdown', _cvPointerDown);
  window.addEventListener('pointermove', _cvPointerMove, { passive: false });
  window.addEventListener('pointerup', _cvPointerUp);
  window.addEventListener('pointercancel', _cvPointerUp);

  body.addEventListener('click', e => {
    if (_cvMode === 'month' && _cvIsPhone() && e.target.closest('.cv-month-grid')) {
      const day = _cvDateAt(e.clientX, e.clientY);
      if (day) {
        e.preventDefault();
        _cvMonthTap(day, body.querySelector(`.cv-month-cell[data-date="${_cvYmd(day)}"]`));
      }
      return;
    }
    const go = e.target.closest('[data-cv-goto]');
    if (go) _cvNavigate(_cvParseYmd(go.dataset.cvGoto), 'week');
  });

  // Day overview (phones)
  const dayList = document.getElementById('calViewDayList');
  dayList.addEventListener('click', e => {
    if (e.target === dayList || e.target.closest('[data-cv-daylist-close]')) { _cvCloseDayList(); return; }
    const day = _cvDayListDay;
    if (e.target.closest('[data-cv-daylist-week]')) { _cvCloseDayList(); _cvNavigate(day, 'week', _cvYmd(day)); return; }
    if (e.target.closest('[data-cv-daylist-new]')) {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
      _cvCreate({ start, end: new Date(start.getTime() + 3_600_000), allDay: false });
      return;
    }
    const item = e.target.closest('[data-cv-key]');
    const ev = item && _cvEvents.get(item.dataset.cvKey);
    if (ev) _openEventDetail(ev._accountId, ev.uid, ev._webUrl, ev);   // opens above the overview
  });

  // Month / all-day row: double-click on a free spot creates an all-day event
  body.addEventListener('dblclick', e => {
    if (_cvMode === 'month' && _cvIsPhone()) return;   // double tap → week (see _cvMonthTap)
    if (e.target.closest('.cv-ev, [data-cv-goto]')) return;
    const cell = e.target.closest('.cv-month-cell, .cv-allday-cell');
    if (!cell) return;
    const day = _cvParseYmd(cell.dataset.date);
    _cvCreate({ start: day, end: day, allDay: true });
  });

  // Ctrl + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms around the pointer
  body.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey) || !e.target.closest('.cv-week')) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    _cvZoomBy(Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.002), e.clientY);
  }, { passive: false });

  body.addEventListener('contextmenu', e => {
    const evEl = e.target.closest('.cv-ev');
    if (!evEl) return;
    const ev = _cvEvents.get(evEl.dataset.cvKey);
    if (!ev) return;
    e.preventDefault();
    e.stopPropagation();
    _showCalEventContextMenu(e, ev._accountId, ev.uid, ev._webUrl, ev);
  });

  // Capture phase: runs before modal handlers, so a modal that closes itself on Escape
  // is still visible here and the view (or the day overview) stays open
  window.addEventListener('keydown', e => {
    if (!_cvIsOpen()) return;
    // Leave keys to dialogs / menus stacked above the view
    if (document.querySelector('dialog[open]')) return;
    if ([...document.querySelectorAll('.modal-backdrop')].some(m => getComputedStyle(m).display !== 'none')) return;
    if ([...document.querySelectorAll('.context-menu')].some(m => getComputedStyle(m).display !== 'none')) return;
    if (_cvDayListDay) {
      if (e.key === 'Escape') { e.preventDefault(); _cvCloseDayList(); }
      return;
    }
    if (e.target.closest?.('input, textarea, select')) return;
    // Ctrl/Cmd + / - / 0 zoom the time grid instead of the page (week views only)
    if ((e.ctrlKey || e.metaKey) && _cvMode !== 'month' && ['+', '=', '-', '0'].includes(e.key)) {
      e.preventDefault();
      if (e.key === '0') _cvApplyZoom(_CV_HOUR_PX, null);
      else _cvZoomBy(e.key === '-' ? 1 / 1.25 : 1.25, null);
      return;
    }
    if (e.key === 'Escape')     { e.preventDefault(); closeCalView(); }
    else if (e.key === 'ArrowLeft')  _cvNavigate(_cvStep(_cvMode, _cvAnchor, -1));
    else if (e.key === 'ArrowRight') _cvNavigate(_cvStep(_cvMode, _cvAnchor, 1));
    else if (e.key === 't')          _cvNavigate(new Date());
  }, true);

  // Window resize changes the month row height → recompute how many entries fit
  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    if (!_cvIsOpen() || _cvMode !== 'month' || _cvDrag) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const narrowChanged = !!document.querySelector('#calViewBody .cv-month--narrow') !== _cvIsNarrow();
      if (narrowChanged || _cvFitMonthLanes() !== _cvMonthLanes) _cvRender();
    });
  });

  window.addEventListener('popstate', () => {
    if (!_isOverlayHostPage()) return;
    const mode = new URLSearchParams(window.location.search).get('cal');
    if (!mode) { _cvPushed = false; _cvHide(); return; }
    _cvInitFromUrl();
  });
});
