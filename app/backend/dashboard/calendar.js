'use strict';
const ICAL = require('ical.js');

const FETCH_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS  =  8_000;

// ---- Helpers ----

function _pad(n) { return String(n).padStart(2, '0'); }

/** Format a Date as CalDAV UTC datetime string (YYYYMMDDTHHmmssZ). */
function _fmtCalDavDate(d) {
  return `${d.getUTCFullYear()}${_pad(d.getUTCMonth() + 1)}${_pad(d.getUTCDate())}T000000Z`;
}

function _icalTimeToString(t) {
  if (!t) return null;
  if (t.isDate) {
    return `${t.year}-${_pad(t.month)}-${_pad(t.day)}`;
  }
  return t.toJSDate().toISOString();
}

// ---- Parse ----

/**
 * Parse an ICS string and return an array of event objects.
 * Exported for unit tests.
 */
function parseEvents(icsString) {
  const jcal   = ICAL.parse(icsString);
  const vcal   = new ICAL.Component(jcal);
  const vevents = vcal.getAllSubcomponents('vevent');
  return vevents.map(ve => {
    const ev = new ICAL.Event(ve);
    return {
      uid:         ev.uid         || '',
      title:       ev.summary     || '(no title)',
      start:       _icalTimeToString(ev.startDate),
      end:         _icalTimeToString(ev.endDate),
      allDay:      ev.startDate ? ev.startDate.isDate : false,
      location:    ve.getFirstPropertyValue('location')    || '',
      description: ve.getFirstPropertyValue('description') || '',
      status:      ve.getFirstPropertyValue('status')      || '',
      organizer:   ve.getFirstPropertyValue('organizer')   || '',
    };
  });
}

/**
 * Filter events to those overlapping [today, today + lookaheadDays).
 * referenceDate defaults to now; pass a Date for deterministic tests.
 * Exported for unit tests.
 */
function filterEvents(events, lookaheadDays, referenceDate) {
  const ref = referenceDate ?? new Date();
  const today     = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  const windowEnd = new Date(today.getTime() + lookaheadDays * 86_400_000);

  return events.filter(ev => {
    if (!ev.start) return false;
    const start = new Date(ev.start);
    const end   = ev.end ? new Date(ev.end) : start;
    // Include events that overlap with [today, windowEnd)
    // For all-day events ical.js sets DTEND to the exclusive next day, so end > today is correct.
    return start < windowEnd && end > today;
  });
}

// ---- Fetch ----

/**
 * Extract all VCALENDAR ICS blocks embedded in a CalDAV XML response.
 * Handles both raw text and &#13;-encoded carriage returns.
 */
function _extractIcsBlocks(xml) {
  const blocks = [];
  const re = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[0].replace(/&#13;/g, '\r'));
  }
  return blocks;
}

/**
 * Fetch all events from a calendar account, without any date filtering.
 * Returns { events: Event[], error: string|null }.
 */
// ---- CalDAV discovery helpers ----

/** Extract the text inside the first occurrence of <*:tagName>...<href>...</href>...</*:tagName> */
function _extractNestedHref(xml, tagName) {
  const m = xml.match(new RegExp(
    `<[^:/>\\s]+:${tagName}[^>]*>[\\s\\S]*?<[^:/>\\s]+:href[^>]*>([^<]+)<\\/[^:/>\\s]+:href>`,
    'i'
  ));
  return m ? m[1].trim() : null;
}

function _toAbsolute(href, baseUrl) {
  if (/^https?:\/\//.test(href)) return href;
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.host}${href}`;
}

/**
 * Discover the calendar home set URL for a CalDAV account.
 * Returns the absolute home-set URL, or null on failure.
 */
async function _discoverHomeSet(account, headers, signal) {
  // Step 1: current-user-principal from the base DAV URL
  const r1 = await fetch(account.url, {
    method:  'PROPFIND',
    headers: { ...headers, 'Depth': '0', 'Content-Type': 'application/xml' },
    body:    '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
    signal,
  });
  if (!r1.ok && r1.status !== 207) return null;
  const principalHref = _extractNestedHref(await r1.text(), 'current-user-principal');
  if (!principalHref) return null;

  // Step 2: calendar-home-set from the principal URL
  const principalUrl = _toAbsolute(principalHref, account.url);
  const r2 = await fetch(principalUrl, {
    method:  'PROPFIND',
    headers: { ...headers, 'Depth': '0', 'Content-Type': 'application/xml' },
    body:    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>',
    signal,
  });
  if (!r2.ok && r2.status !== 207) return null;
  const homeHref = _extractNestedHref(await r2.text(), 'calendar-home-set');
  return homeHref ? _toAbsolute(homeHref, account.url) : null;
}

/**
 * List calendar collections in a CalDAV home set.
 * Returns [{ name, url }] for each calendar found.
 */
async function _listCalendars(homeUrl, headers, signal) {
  const r = await fetch(homeUrl, {
    method:  'PROPFIND',
    headers: { ...headers, 'Depth': '1', 'Content-Type': 'application/xml' },
    body:    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:displayname/><D:resourcetype/></D:prop></D:propfind>',
    signal,
  });
  if (!r.ok && r.status !== 207) return [];
  const xml = await r.text();

  // Split into per-resource response blocks and filter to calendar collections
  const blocks = [...xml.matchAll(/<[^:/>]+:response[^>]*>([\s\S]*?)<\/[^:/>]+:response>/gi)].map(m => m[1]);
  const calendars = [];
  for (const block of blocks) {
    if (!/:calendar\b|"calendar"/i.test(block)) continue;
    const hrefM = block.match(/<[^:/>]+:href[^>]*>([^<]+)<\/[^:/>]+:href>/i);
    const nameM = block.match(/<[^:/>]+:displayname[^>]*>([^<]*)<\/[^:/>]+:displayname>/i);
    if (hrefM) {
      calendars.push({
        name: (nameM?.[1] ?? '').trim(),
        url:  _toAbsolute(hrefM[1].trim(), homeUrl),
      });
    }
  }
  return calendars;
}

/**
 * Resolve the exact calendar collection URL by display name or slug.
 * Falls back to _calendarUrl() if discovery fails.
 * Returns { url, discovered: boolean, allCalendars?: [{name,url}] }.
 */
async function _resolveCalendarUrl(account, headers, signal) {
  if (account.type === 'ical-url' || !account.calendarName) {
    return { url: account.url, discovered: false };
  }

  const cacheKey = account.id || `${account.url}\x00${account.calendarName}`;
  const cached = _urlCache.get(cacheKey);
  if (cached) return cached;

  try {
    const homeUrl = await _discoverHomeSet(account, headers, signal);
    if (!homeUrl) return { url: _calendarUrlFallback(account), discovered: false };

    const calendars = await _listCalendars(homeUrl, headers, signal);
    const name = account.calendarName;

    // Match by display name first, then by URL slug
    let match = calendars.find(c => c.name === name);
    if (!match) {
      match = calendars.find(c => {
        const slug = decodeURIComponent(c.url.replace(/\/$/, '').split('/').pop());
        return slug === name;
      });
    }

    if (match) {
      const result = { url: match.url, discovered: true, allCalendars: calendars };
      _urlCache.set(cacheKey, { url: match.url, discovered: true });
      return result;
    }
    return { url: null, discovered: true, allCalendars: calendars };
  } catch {
    return { url: _calendarUrlFallback(account), discovered: false };
  }
}

/** Simple URL construction fallback (no discovery). */
function _calendarUrlFallback(account) {
  if (account.type === 'ical-url' || !account.calendarName) return account.url;
  const base = account.url.replace(/\/$/, '');
  if (account.user) {
    return `${base}/calendars/${encodeURIComponent(account.user)}/${encodeURIComponent(account.calendarName)}/`;
  }
  return `${base}/${encodeURIComponent(account.calendarName)}/`;
}

/** REPORT body with no date filter — used for single-event lookups. */
const _REPORT_BODY_ALL = `<?xml version="1.0" encoding="utf-8"?>\
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">\
<D:prop><D:getetag/><C:calendar-data/></D:prop>\
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/>\
</C:comp-filter></C:filter></C:calendar-query>`;

/** REPORT body restricted to [today, today + lookaheadDays). */
function _buildReportBody(lookaheadDays) {
  const now     = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start   = _fmtCalDavDate(new Date(todayMs));
  const end     = _fmtCalDavDate(new Date(todayMs + lookaheadDays * 86_400_000));
  return `<?xml version="1.0" encoding="utf-8"?>\
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">\
<D:prop><D:getetag/><C:calendar-data/></D:prop>\
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">\
<C:time-range start="${start}" end="${end}"/>\
</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
}

// ---- URL cache ----

/**
 * Cache of resolved CalDAV collection URLs, keyed by account id (or url+calendarName).
 * Avoids repeating the 3-step discovery (principal → home-set → collection list) on
 * every fetch. Cleared when dashboard config is saved.
 */
const _urlCache = new Map();

/** Clear cached calendar URL(s). Pass accountId to clear one entry, or omit to clear all. */
function clearCalendarUrlCache(accountId) {
  if (accountId !== undefined) _urlCache.delete(accountId);
  else _urlCache.clear();
}

async function fetchRawEvents(account, timeoutMs = FETCH_TIMEOUT_MS, { lookaheadDays } = {}) {
  const { type, url, user, password } = account;
  const headers = {};
  if (user && password) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let allEvents = [];

    if (type === 'ical-url') {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 401) throw new Error('Authentication failed (HTTP 401)');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      allEvents = parseEvents(await res.text());
    } else {
      // Resolve the correct calendar collection URL via CalDAV discovery (cached after first call)
      const { url: calUrl } = await _resolveCalendarUrl(account, headers, controller.signal);
      const targetUrl = calUrl || _calendarUrlFallback(account);

      const reportBody = lookaheadDays != null
        ? _buildReportBody(lookaheadDays)
        : _REPORT_BODY_ALL;

      const res = await fetch(targetUrl, {
        method:  'REPORT',
        headers: { ...headers, 'Content-Type': 'application/xml', 'Depth': '1' },
        body:    reportBody,
        signal:  controller.signal,
      });

      if (res.status === 401) throw new Error('Authentication failed (HTTP 401)');
      if (!res.ok) throw new Error(`CalDAV error (HTTP ${res.status})`);

      for (const block of _extractIcsBlocks(await res.text())) {
        try { allEvents.push(...parseEvents(block)); } catch { /* skip malformed */ }
      }
    }

    return { events: allEvents, error: null };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Connection timed out (${timeoutMs / 1000} s)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch events for an account, filtered to the lookahead window.
 * Returns { events: Event[], error: string|null } — never throws.
 */
async function fetchCalendarAccount(account) {
  try {
    const days = account.lookaheadDays ?? 7;
    const { events } = await fetchRawEvents(account, FETCH_TIMEOUT_MS, { lookaheadDays: days });
    return { events: filterEvents(events, days), error: null };
  } catch (err) {
    return { events: [], error: err.message };
  }
}

/**
 * Test connectivity to a calendar account.
 * For CalDAV, performs full discovery to verify the specific calendar exists
 * and returns a detailed result including available calendar names on failure.
 * Returns { ok: boolean, error?: string, detail?: string }.
 */
async function testCalendarAccount(account) {
  const { type, url, user, password } = account;
  const headers = {};
  if (user && password) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

  try {
    // iCal URL: single GET
    if (type === 'ical-url') {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (res.status === 401) return { ok: false, error: 'Authentication failed (HTTP 401)' };
      if (!res.ok) return { ok: false, error: `Server returned HTTP ${res.status}` };
      return { ok: true, detail: 'iCal URL is accessible.' };
    }

    // CalDAV: discover home set → list calendars → REPORT on target
    const homeUrl = await _discoverHomeSet(account, headers, controller.signal);

    if (!homeUrl) {
      // Home-set discovery failed — fall back to basic PROPFIND check
      const r = await fetch(url, {
        method:  'PROPFIND',
        headers: { ...headers, 'Depth': '0', 'Content-Type': 'application/xml' },
        body:    '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
        signal:  controller.signal,
      });
      if (r.status === 401) return { ok: false, error: 'Authentication failed (HTTP 401) — check username and password.' };
      if (!r.ok && r.status !== 207) return { ok: false, error: `DAV endpoint not reachable (HTTP ${r.status}).` };
      return { ok: true, detail: 'DAV endpoint reachable (calendar discovery not supported by this server).' };
    }

    // No calendar name configured — just confirm the home set is accessible
    if (!account.calendarName) {
      return { ok: true, detail: `DAV endpoint reachable. Calendar home: ${homeUrl}. Enter a Calendar name to verify a specific calendar.` };
    }

    // List available calendars and find the configured one
    const calendars = await _listCalendars(homeUrl, headers, controller.signal);
    const name      = account.calendarName;
    let match       = calendars.find(c => c.name === name);
    if (!match) {
      match = calendars.find(c => {
        const slug = decodeURIComponent(c.url.replace(/\/$/, '').split('/').pop());
        return slug === name;
      });
    }

    if (!match) {
      const available = calendars.map(c => c.name || c.url.replace(/\/$/, '').split('/').pop()).join(', ');
      return {
        ok:    false,
        error: `Calendar "${name}" not found.${available ? ` Available: ${available}.` : ''}`,
      };
    }

    // REPORT on the discovered calendar URL
    const res = await fetch(match.url, {
      method:  'REPORT',
      headers: { ...headers, 'Content-Type': 'application/xml', 'Depth': '1' },
      body:    _REPORT_BODY,
      signal:  controller.signal,
    });
    if (res.status === 401) return { ok: false, error: 'Authentication failed on calendar collection.' };
    if (!res.ok && res.status !== 207) return { ok: false, error: `Calendar returned HTTP ${res.status}.` };

    const eventCount = ((await res.text()).match(/BEGIN:VCALENDAR/g) || []).length;
    return {
      ok:     true,
      detail: `Calendar "${match.name || name}" found at ${match.url} — ${eventCount} event block${eventCount !== 1 ? 's' : ''} returned.`,
    };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: `Connection timed out (${TEST_TIMEOUT_MS / 1000} s)` };
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { parseEvents, filterEvents, fetchRawEvents, fetchCalendarAccount, testCalendarAccount, clearCalendarUrlCache };
