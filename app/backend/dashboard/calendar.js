'use strict';
const ICAL = require('ical.js');
const { randomUUID } = require('crypto');

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

/** Format UTC offset in minutes as ±HHmm (e.g. +0200, -0530). */
function _offsetStr(minutes) {
  const sign = minutes >= 0 ? '+' : '-';
  const abs  = Math.abs(minutes);
  return `${sign}${_pad(Math.floor(abs / 60))}${_pad(abs % 60)}`;
}

/** Escape special characters in ICS TEXT values per RFC 5545. */
function _icsEscape(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold long ICS lines at 75 octets per RFC 5545.
 * Continuation lines begin with a single SPACE character.
 */
function _icsFold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const chunks = [];
  let offset   = 0;
  let maxBytes = 75;
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytes, bytes.length);
    // Don't split in the middle of a multi-byte UTF-8 sequence
    while (end < bytes.length && (bytes[end] & 0xC0) === 0x80) end--;
    chunks.push(bytes.slice(offset, end).toString('utf8'));
    offset   = end;
    maxBytes = 74; // continuation lines: 1 byte for leading space, 74 bytes content
  }
  return chunks.join('\r\n ');
}

// ---- VTIMEZONE generation ----

/**
 * Build a VTIMEZONE ICS block for a given IANA timezone, using Intl.DateTimeFormat
 * to derive the UTC offsets and DST transition times for the current year.
 * Returns an empty string for UTC (no VTIMEZONE needed per RFC 5545).
 */
function _buildVTimezone(tzid) {
  if (!tzid || tzid === 'UTC') return '';

  const year = new Date().getUTCFullYear();

  // Get UTC offset in minutes for a given UTC timestamp in the target timezone
  function getOffset(utcMs) {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(new Date(utcMs)).map(p => [p.type, p.value])
    );
    const h = parts.hour === '24' ? 0 : +parts.hour;
    const localMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, +parts.minute, +parts.second);
    return Math.round((localMs - utcMs) / 60000);
  }

  // Format a UTC timestamp as iCal local datetime in the given timezone (YYYYMMDDTHHMMSS)
  function fmtLocal(utcMs) {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(new Date(utcMs)).map(p => [p.type, p.value])
    );
    const h = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}${parts.month}${parts.day}T${h}${parts.minute}${parts.second}`;
  }

  // Find transitions by sampling every 2 weeks throughout the year
  const transitions = [];
  let prevOffset = getOffset(Date.UTC(year, 0, 1));
  for (let week = 1; week <= 26; week++) {
    const ts = Date.UTC(year, 0, 1) + week * 14 * 86_400_000;
    const offset = getOffset(ts);
    if (offset !== prevOffset) {
      // Binary-search for the hour of transition
      let lo = ts - 14 * 86_400_000, hi = ts;
      const offLo = getOffset(lo);
      while (hi - lo > 3_600_000) {
        const mid = Math.floor((lo + hi) / 2);
        if (getOffset(mid) === offLo) lo = mid;
        else hi = mid;
      }
      transitions.push({ ts: hi, fromOffset: prevOffset, toOffset: offset });
      prevOffset = offset;
    }
  }

  const stdOffset = getOffset(Date.UTC(year, 0, 15)); // January ≈ standard for most zones

  // No DST — emit a single STANDARD component
  if (transitions.length === 0) {
    return [
      'BEGIN:VTIMEZONE',
      `TZID:${tzid}`,
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${_offsetStr(stdOffset)}`,
      `TZOFFSETTO:${_offsetStr(stdOffset)}`,
      'END:STANDARD',
      'END:VTIMEZONE',
    ].join('\r\n');
  }

  // DST zone — find the spring-forward (DST start) and fall-back (standard start) transitions
  const dstTrans = transitions.find(t => t.toOffset > t.fromOffset); // clocks spring forward
  const stdTrans = transitions.find(t => t.toOffset < t.fromOffset); // clocks fall back

  const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];

  if (dstTrans) {
    lines.push(
      'BEGIN:DAYLIGHT',
      `DTSTART:${fmtLocal(dstTrans.ts)}`,
      `TZOFFSETFROM:${_offsetStr(dstTrans.fromOffset)}`,
      `TZOFFSETTO:${_offsetStr(dstTrans.toOffset)}`,
      'END:DAYLIGHT',
    );
  }

  if (stdTrans) {
    lines.push(
      'BEGIN:STANDARD',
      `DTSTART:${fmtLocal(stdTrans.ts)}`,
      `TZOFFSETFROM:${_offsetStr(stdTrans.fromOffset)}`,
      `TZOFFSETTO:${_offsetStr(stdTrans.toOffset)}`,
      'END:STANDARD',
    );
  }

  lines.push('END:VTIMEZONE');
  return lines.join('\r\n');
}

// ---- ICS generation ----

/**
 * Build a minimal VCALENDAR/VEVENT ICS string suitable for a CalDAV PUT.
 * For timed events with a named timezone a VTIMEZONE block is embedded.
 * Returns { ics: string, uid: string }.
 */
function buildIcs(event, uid) {
  const { title, allDay, start, end, location, description, timezone, rrule } = event;

  const startMs = new Date(start).getTime();
  const endMs   = new Date(end).getTime();
  if (isNaN(startMs) || isNaN(endMs)) throw new Error('invalid start or end date');
  if (endMs < startMs) throw new Error('end must be >= start');

  const evUid   = uid || event.uid || randomUUID();
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  // Strip TZ suffix → "20260706T100000" (preserves what the user entered as local time)
  function toLocalDt(iso) {
    return iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z$/, '').substring(0, 15);
  }

  // Date-only → "20260706"
  function toDateOnly(iso) {
    return iso.substring(0, 10).replace(/-/g, '');
  }

  const useTzid = !allDay && timezone && timezone !== 'UTC';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kanban//kanban//EN',
  ];

  if (useTzid) {
    const vtz = _buildVTimezone(timezone);
    if (vtz) lines.push(vtz);
  }

  lines.push('BEGIN:VEVENT');
  lines.push(_icsFold(`UID:${evUid}`));
  lines.push(`DTSTAMP:${dtstamp}`);

  if (allDay) {
    const startDate = toDateOnly(start);
    const endDate   = end
      ? toDateOnly(end)
      : toDateOnly(new Date(new Date(start.substring(0, 10)).getTime() + 86_400_000).toISOString());
    lines.push(`DTSTART;VALUE=DATE:${startDate}`);
    lines.push(`DTEND;VALUE=DATE:${endDate}`);
  } else if (useTzid) {
    lines.push(_icsFold(`DTSTART;TZID=${timezone}:${toLocalDt(start)}`));
    lines.push(_icsFold(`DTEND;TZID=${timezone}:${toLocalDt(end)}`));
  } else {
    // UTC
    const startUtc = new Date(start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const endUtc   = new Date(end).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    lines.push(`DTSTART:${startUtc}`);
    lines.push(`DTEND:${endUtc}`);
  }

  lines.push(_icsFold(`SUMMARY:${_icsEscape(title)}`));
  if (rrule)       lines.push(_icsFold(`RRULE:${rrule}`));
  if (location)    lines.push(_icsFold(`LOCATION:${_icsEscape(location)}`));
  if (description) lines.push(_icsFold(`DESCRIPTION:${_icsEscape(description)}`));

  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return { ics: lines.join('\r\n'), uid: evUid };
}

// ---- Parse ----

/**
 * Parse an ICS string and return an array of event objects.
 * When windowStart/windowEnd (Date objects) are provided, recurring events
 * (RRULE) are expanded into individual occurrences that overlap the window
 * instead of returning only the master event.
 * Exported for unit tests.
 */
function parseEvents(icsString, { windowStart, windowEnd } = {}) {
  const jcal    = ICAL.parse(icsString);
  const vcal    = new ICAL.Component(jcal);
  const vevents = vcal.getAllSubcomponents('vevent');

  // Separate master events from exception overrides (those with RECURRENCE-ID)
  const masters    = [];
  const exceptions = new Map(); // uid → [ICAL.Event, ...]

  for (const ve of vevents) {
    const ev = new ICAL.Event(ve);
    if (ve.getFirstProperty('recurrence-id')) {
      if (!exceptions.has(ev.uid)) exceptions.set(ev.uid, []);
      exceptions.get(ev.uid).push(ev);
    } else {
      masters.push({ ev, ve });
    }
  }

  const result  = [];
  const expand  = !!(windowStart && windowEnd);
  const wStart  = expand ? ICAL.Time.fromJSDate(windowStart, true) : null;
  const wEnd    = expand ? ICAL.Time.fromJSDate(windowEnd,   true) : null;
  const masterUids = new Set(masters.map(m => m.ev.uid));

  for (const { ev, ve } of masters) {
    const dtStartProp = ve.getFirstProperty('dtstart');
    const timezone    = (dtStartProp && dtStartProp.getParameter('tzid')) || null;
    const hasRrule    = !!ve.getFirstProperty('rrule');
    const rruleStr    = hasRrule
      ? (() => { try { return ve.getFirstProperty('rrule').getFirstValue().toString(); } catch { return null; } })()
      : null;

    if (hasRrule && expand && ev.startDate) {
      // Register exceptions so the iterator skips deleted / uses modified occurrences
      for (const exc of (exceptions.get(ev.uid) || [])) {
        try { ev.relateException(exc); } catch { /* ignore mismatched exceptions */ }
      }

      try {
        // Iterate from the original DTSTART — passing a custom start time to
        // iterator() replaces the RRULE base date and shifts the day-of-week
        // pattern, producing wrong occurrence dates.
        // We skip occurrences whose end falls before the window instead.
        const iter  = ev.iterator();
        let   next;
        let   count = 0;
        while ((next = iter.next()) && count++ < 5000) {
          if (next.compare(wEnd) >= 0) break;
          const details = ev.getOccurrenceDetails(next);
          const occEnd  = details.endDate || details.startDate;
          if (occEnd.compare(wStart) <= 0) continue; // ends before window — skip
          const occItem = details.item; // ICAL.Event (override or master)
          const occVe   = occItem.component;
          result.push({
            uid:         ev.uid              || '',
            title:       occItem.summary     || '(no title)',
            start:       _icalTimeToString(details.startDate),
            end:         _icalTimeToString(details.endDate),
            allDay:      details.startDate ? details.startDate.isDate : false,
            location:    occVe.getFirstPropertyValue('location')    || '',
            description: occVe.getFirstPropertyValue('description') || '',
            status:      occVe.getFirstPropertyValue('status')      || '',
            organizer:   occVe.getFirstPropertyValue('organizer')   || '',
            timezone,
            hasRrule,
            rruleStr,
            seriesStart: _icalTimeToString(ev.startDate),
          });
        }
      } catch {
        // Fall back to the master event on any expansion error
        result.push({
          uid:         ev.uid         || '',
          title:       ev.summary     || '(no title)',
          start:       _icalTimeToString(ev.startDate),
          end:         _icalTimeToString(ev.endDate),
          allDay:      ev.startDate ? ev.startDate.isDate : false,
          location:    ve.getFirstPropertyValue('location')    || '',
          description: ve.getFirstPropertyValue('description') || '',
          status:      ve.getFirstPropertyValue('status')      || '',
          organizer:   ve.getFirstPropertyValue('organizer')   || '',
          timezone,
          hasRrule,
          rruleStr,
          seriesStart: _icalTimeToString(ev.startDate),
        });
      }
    } else {
      result.push({
        uid:         ev.uid         || '',
        title:       ev.summary     || '(no title)',
        start:       _icalTimeToString(ev.startDate),
        end:         _icalTimeToString(ev.endDate),
        allDay:      ev.startDate ? ev.startDate.isDate : false,
        location:    ve.getFirstPropertyValue('location')    || '',
        description: ve.getFirstPropertyValue('description') || '',
        status:      ve.getFirstPropertyValue('status')      || '',
        organizer:   ve.getFirstPropertyValue('organizer')   || '',
        timezone,
        hasRrule,
        rruleStr,
      });
    }
  }

  // Orphaned exception overrides (RECURRENCE-ID present, no matching master VEVENT):
  // treat each as a standalone single event
  for (const [uid, excs] of exceptions) {
    if (masterUids.has(uid)) continue;
    for (const exc of excs) {
      const excVe       = exc.component;
      const dtStartProp = excVe.getFirstProperty('dtstart');
      const timezone    = (dtStartProp && dtStartProp.getParameter('tzid')) || null;
      result.push({
        uid:         exc.uid         || '',
        title:       exc.summary     || '(no title)',
        start:       _icalTimeToString(exc.startDate),
        end:         _icalTimeToString(exc.endDate),
        allDay:      exc.startDate ? exc.startDate.isDate : false,
        location:    excVe.getFirstPropertyValue('location')    || '',
        description: excVe.getFirstPropertyValue('description') || '',
        status:      excVe.getFirstPropertyValue('status')      || '',
        organizer:   excVe.getFirstPropertyValue('organizer')   || '',
        timezone,
        hasRrule: false,
      });
    }
  }

  return result;
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
 * Extract VCALENDAR ICS items embedded in a CalDAV REPORT XML response,
 * pairing each with its ETag and href from the surrounding XML.
 * Returns [{ ics, etag, href }].
 */
function _extractIcsItems(xml) {
  const items = [];
  // Match both namespace-prefixed (D:response) and un-prefixed (response) tags
  const responseRe = /<(?:[^:/>]+:)?response[^>]*>([\s\S]*?)<\/(?:[^:/>]+:)?response>/gi;
  let m;
  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[1];
    const hrefM = block.match(/<(?:[^:/>]+:)?href[^>]*>([^<]+)<\/(?:[^:/>]+:)?href>/i);
    const etagM = block.match(/<(?:[^:/>]+:)?getetag[^>]*>([^<]*)<\/(?:[^:/>]+:)?getetag>/i);
    const icsM  = block.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/);
    if (!icsM) continue;
    items.push({
      ics:  icsM[0].replace(/&#13;/g, '\r'),
      etag: etagM ? etagM[1].trim().replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null,
      href: hrefM ? hrefM[1].trim() : null,
    });
  }
  return items;
}

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
 * Falls back to _calendarUrlFallback() if discovery fails.
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

    // Compute the time window for recurring-event expansion when lookaheadDays is known
    const parseOpts = (() => {
      if (lookaheadDays == null) return {};
      const now         = new Date();
      const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const windowEnd   = new Date(windowStart.getTime() + lookaheadDays * 86_400_000);
      return { windowStart, windowEnd };
    })();

    if (type === 'ical-url') {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 401) throw new Error('Authentication failed (HTTP 401)');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      allEvents = parseEvents(await res.text(), parseOpts);
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

      for (const { ics, etag, href } of _extractIcsItems(await res.text())) {
        try {
          const parsed = parseEvents(ics, parseOpts);
          for (const ev of parsed) {
            ev.etag = etag;
            ev.href = href;
            allEvents.push(ev);
          }
        } catch { /* skip malformed */ }
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
async function fetchCalendarAccount(account, { lookaheadDays } = {}) {
  try {
    const days = lookaheadDays ?? account.lookaheadDays ?? 7;
    const { events } = await fetchRawEvents(account, FETCH_TIMEOUT_MS, { lookaheadDays: days });
    return { events: filterEvents(events, days), error: null };
  } catch (err) {
    return { events: [], error: err.message };
  }
}

/**
 * Resolve the CalDAV resource URL for a given event UID.
 * Uses the conventional {collectionUrl}/{uid}.ics naming pattern.
 * Exported so routes can reuse it without duplicating discovery logic.
 */
async function resolveEventUrl(account, uid, headers, signal) {
  const hdrs = headers || {};
  const sig  = signal  || new AbortController().signal;
  const { url: calUrl } = await _resolveCalendarUrl(account, hdrs, sig);
  const base = (calUrl || _calendarUrlFallback(account)).replace(/\/$/, '');
  return `${base}/${encodeURIComponent(uid)}.ics`;
}

/**
 * Resolve a CalDAV href (absolute path or full URL) to a full URL using the
 * account's configured URL as the base. Returns null if resolution fails.
 * Exported so routes can use it instead of reconstructing URLs from UIDs.
 */
function hrefToUrl(account, href) {
  if (!href) return null;
  try {
    if (/^https?:\/\//i.test(href)) return href;
    const origin = new URL(account.url).origin;
    return new URL(href, origin).href;
  } catch { return null; }
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
      body:    _REPORT_BODY_ALL,
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

// ---- Recurring event modification helpers ----

/**
 * Convert a UTC ISO timestamp to a localtime string in a named IANA timezone.
 * Returns "YYYYMMDDTHHMMSS" suitable for ICS DTSTART/DTEND/RECURRENCE-ID/EXDATE.
 */
function _fmtLocalInTz(utcIsoStr, tzid) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzid,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcIsoStr)).map(p => [p.type, p.value]));
  const h = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}${parts.month}${parts.day}T${h}${parts.minute}${parts.second}`;
}

/**
 * Fetch the raw ICS text for an event from CalDAV.
 * Returns { ics: string, url: string }.
 */
async function fetchRawIcs(account, uid, href, timeoutMs = 10_000) {
  const headers = {};
  if (account.user && account.password) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${account.user}:${account.password}`).toString('base64');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const eventUrl = href
      ? (hrefToUrl(account, href) || await resolveEventUrl(account, uid, headers, controller.signal))
      : await resolveEventUrl(account, uid, headers, controller.signal);
    if (!eventUrl) throw new Error('Could not resolve event URL');
    const res = await fetch(eventUrl, { headers, signal: controller.signal });
    if (res.status === 404) throw new Error('Event not found on CalDAV server');
    if (!res.ok) throw new Error(`CalDAV error (HTTP ${res.status})`);
    return { ics: await res.text(), url: eventUrl };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Connection timed out (${timeoutMs / 1000} s)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Patch the master VEVENT of an ICS string: update SUMMARY, LOCATION, DESCRIPTION,
 * DTSTAMP, and optionally DTSTART/DTEND. RRULE and exception VEVENTs are preserved.
 * Returns modified ICS string (CRLF line endings).
 */
function patchMasterIcs(masterIcs, event) {
  const jcal   = ICAL.parse(masterIcs);
  const vcal   = new ICAL.Component(jcal);
  const master = vcal.getAllSubcomponents('vevent').find(ve => !ve.getFirstProperty('recurrence-id'));
  if (!master) throw new Error('Master VEVENT not found in ICS');

  const { title, location, description, allDay, start, end, timezone } = event;

  master.updatePropertyWithValue('summary', title || '');
  master.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));

  // LOCATION
  const locProp = master.getFirstProperty('location');
  if (location) {
    if (locProp) locProp.setValue(location);
    else master.addPropertyWithValue('location', location);
  } else if (locProp) {
    master.removeProperty('location');
  }

  // DESCRIPTION
  const descProp = master.getFirstProperty('description');
  if (description) {
    if (descProp) descProp.setValue(description);
    else master.addPropertyWithValue('description', description);
  } else if (descProp) {
    master.removeProperty('description');
  }

  // RRULE (only updated when caller explicitly provides the field)
  if ('rrule' in event) {
    const existingRrule = master.getFirstProperty('rrule');
    if (event.rrule) {
      const rruleVal = ICAL.Recur.fromString(event.rrule);
      if (existingRrule) existingRrule.setValue(rruleVal);
      else master.addPropertyWithValue('rrule', rruleVal);
    } else if (existingRrule) {
      master.removeProperty('rrule');
    }
  }

  // DTSTART / DTEND (optional — only when caller provides both)
  if (start && end) {
    const dtStartProp  = master.getFirstProperty('dtstart');
    const dtEndProp    = master.getFirstProperty('dtend');
    const masterAllDay = dtStartProp?.getFirstValue()?.isDate ?? false;
    const masterTzid   = dtStartProp?.getParameter('tzid') || null;

    if (masterAllDay || allDay) {
      const sDate = ICAL.Time.fromDateString(start.substring(0, 10));
      const eDate = ICAL.Time.fromDateString((end || start).substring(0, 10));
      if (dtStartProp) dtStartProp.setValue(sDate); else master.addPropertyWithValue('dtstart', sDate);
      if (dtEndProp)   dtEndProp.setValue(eDate);   else master.addPropertyWithValue('dtend',   eDate);
    } else {
      // Keep the master's timezone; fall back to the event timezone, then UTC
      const tzid = masterTzid || timezone || null;
      if (tzid && tzid !== 'UTC') {
        // Express new times as local-time in the master timezone
        const sLocal = _fmtLocalInTz(start, tzid);
        const eLocal = _fmtLocalInTz(end,   tzid);
        // ICAL.Time.fromString on "YYYYMMDDTHHMMSS" → floating time (no Z)
        const sTime  = ICAL.Time.fromString(sLocal);
        const eTime  = ICAL.Time.fromString(eLocal);
        if (dtStartProp) { dtStartProp.setValue(sTime); dtStartProp.setParameter('tzid', tzid); }
        else { master.addPropertyWithValue('dtstart', sTime); master.getFirstProperty('dtstart').setParameter('tzid', tzid); }
        if (dtEndProp)   { dtEndProp.setValue(eTime);   dtEndProp.setParameter('tzid', tzid); }
        else { master.addPropertyWithValue('dtend', eTime);   master.getFirstProperty('dtend').setParameter('tzid', tzid); }
      } else {
        const sTime = ICAL.Time.fromJSDate(new Date(start), true);
        const eTime = ICAL.Time.fromJSDate(new Date(end),   true);
        if (dtStartProp) dtStartProp.setValue(sTime); else master.addPropertyWithValue('dtstart', sTime);
        if (dtEndProp)   dtEndProp.setValue(eTime);   else master.addPropertyWithValue('dtend',   eTime);
      }
    }
  }

  return ICAL.stringify(vcal.jCal).replace(/\r?\n/g, '\r\n');
}

/**
 * Build an ICS string with an exception VEVENT override for a single occurrence.
 * Replaces any existing exception for that date. The master VEVENT and RRULE are
 * preserved via ical.js; the new override block is injected as raw ICS.
 * occurrenceStart: ISO string (UTC) of the occurrence's original DTSTART.
 * event: { title, allDay, start, end, location, description, timezone }.
 */
function buildOccurrenceOverrideIcs(masterIcs, occurrenceStart, event) {
  const jcal    = ICAL.parse(masterIcs);
  const vcal    = new ICAL.Component(jcal);
  const vevents = vcal.getAllSubcomponents('vevent');
  const master  = vevents.find(ve => !ve.getFirstProperty('recurrence-id'));
  if (!master) throw new Error('Master VEVENT not found in ICS');

  const evUid       = master.getFirstPropertyValue('uid');
  const dtStartProp = master.getFirstProperty('dtstart');
  const masterAllDay = dtStartProp?.getFirstValue()?.isDate ?? false;
  const masterTzid   = dtStartProp?.getParameter('tzid') || null;

  // Remove any existing exception for this occurrence date
  const occDateStr = new Date(occurrenceStart).toISOString().substring(0, 10);
  for (const ve of [...vevents]) {
    const rid = ve.getFirstProperty('recurrence-id');
    if (!rid) continue;
    try {
      if (rid.getFirstValue().toJSDate().toISOString().substring(0, 10) === occDateStr) {
        vcal.removeSubcomponent(ve);
      }
    } catch { /* skip unparseable RECURRENCE-ID */ }
  }

  // Build RECURRENCE-ID line matching the master's DTSTART format
  let ridLine;
  if (masterAllDay) {
    ridLine = `RECURRENCE-ID;VALUE=DATE:${occurrenceStart.substring(0, 10).replace(/-/g, '')}`;
  } else if (masterTzid) {
    ridLine = _icsFold(`RECURRENCE-ID;TZID=${masterTzid}:${_fmtLocalInTz(occurrenceStart, masterTzid)}`);
  } else {
    const utc = new Date(occurrenceStart).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    ridLine = `RECURRENCE-ID:${utc}`;
  }

  // Build the override VEVENT lines (reuses the same helpers as buildIcs)
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const { title, allDay, start, end, location, description, timezone } = event;

  function toLocalDt(iso) { return iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z$/, '').substring(0, 15); }
  function toDateOnly(iso) { return iso.substring(0, 10).replace(/-/g, ''); }
  const useTzid = !allDay && timezone && timezone !== 'UTC';

  const lines = [
    'BEGIN:VEVENT',
    _icsFold(`UID:${evUid}`),
    `DTSTAMP:${dtstamp}`,
    ridLine,
  ];

  if (allDay) {
    const endDate = end
      ? toDateOnly(end)
      : toDateOnly(new Date(new Date(start.substring(0, 10)).getTime() + 86_400_000).toISOString());
    lines.push(`DTSTART;VALUE=DATE:${toDateOnly(start)}`);
    lines.push(`DTEND;VALUE=DATE:${endDate}`);
  } else if (useTzid) {
    lines.push(_icsFold(`DTSTART;TZID=${timezone}:${toLocalDt(start)}`));
    lines.push(_icsFold(`DTEND;TZID=${timezone}:${toLocalDt(end)}`));
  } else {
    lines.push(`DTSTART:${new Date(start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`);
    lines.push(`DTEND:${new Date(end).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`);
  }

  lines.push(_icsFold(`SUMMARY:${_icsEscape(title)}`));
  if (location)    lines.push(_icsFold(`LOCATION:${_icsEscape(location)}`));
  if (description) lines.push(_icsFold(`DESCRIPTION:${_icsEscape(description)}`));
  lines.push('END:VEVENT');

  const overrideBlock = lines.join('\r\n');

  // Re-serialize the vcal (old exception removed) then inject override before END:VCALENDAR
  const baseIcs = ICAL.stringify(vcal.jCal).replace(/\r?\n/g, '\r\n');
  const endVcalIdx = baseIcs.lastIndexOf('END:VCALENDAR');
  if (endVcalIdx < 0) throw new Error('Invalid ICS: END:VCALENDAR not found');
  const prefix = baseIcs.substring(0, endVcalIdx).replace(/[\r\n]+$/, '');
  return `${prefix}\r\n${overrideBlock}\r\nEND:VCALENDAR`;
}

/**
 * Build an ICS string with an EXDATE added to the master VEVENT to skip one occurrence.
 * Also removes any existing exception override for that occurrence date.
 * occurrenceStart: ISO string (UTC) of the occurrence's original DTSTART.
 */
function buildDeleteOccurrenceIcs(masterIcs, occurrenceStart) {
  const jcal    = ICAL.parse(masterIcs);
  const vcal    = new ICAL.Component(jcal);
  const vevents = vcal.getAllSubcomponents('vevent');
  const master  = vevents.find(ve => !ve.getFirstProperty('recurrence-id'));
  if (!master) throw new Error('Master VEVENT not found in ICS');

  const dtStartProp  = master.getFirstProperty('dtstart');
  const masterAllDay = dtStartProp?.getFirstValue()?.isDate ?? false;
  const masterTzid   = dtStartProp?.getParameter('tzid') || null;

  // Remove any existing exception override for this date
  const occDateStr = new Date(occurrenceStart).toISOString().substring(0, 10);
  for (const ve of [...vevents]) {
    const rid = ve.getFirstProperty('recurrence-id');
    if (!rid) continue;
    try {
      if (rid.getFirstValue().toJSDate().toISOString().substring(0, 10) === occDateStr) {
        vcal.removeSubcomponent(ve);
      }
    } catch { /* skip */ }
  }

  // Build EXDATE line
  let exdateLine;
  if (masterAllDay) {
    exdateLine = `EXDATE;VALUE=DATE:${occurrenceStart.substring(0, 10).replace(/-/g, '')}`;
  } else if (masterTzid) {
    exdateLine = _icsFold(`EXDATE;TZID=${masterTzid}:${_fmtLocalInTz(occurrenceStart, masterTzid)}`);
  } else {
    const utc = new Date(occurrenceStart).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    exdateLine = `EXDATE:${utc}`;
  }

  master.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));

  // Re-serialize, then inject EXDATE before the first END:VEVENT (= master VEVENT's end)
  const baseIcs = ICAL.stringify(vcal.jCal).replace(/\r?\n/g, '\r\n');
  const endVeventPos = baseIcs.indexOf('\r\nEND:VEVENT');
  if (endVeventPos < 0) throw new Error('VEVENT not found in serialized ICS');
  return (
    baseIcs.substring(0, endVeventPos) +
    '\r\n' + exdateLine +
    baseIcs.substring(endVeventPos)
  );
}

module.exports = {
  parseEvents,
  filterEvents,
  fetchRawEvents,
  fetchCalendarAccount,
  testCalendarAccount,
  clearCalendarUrlCache,
  buildIcs,
  fetchRawIcs,
  patchMasterIcs,
  buildOccurrenceOverrideIcs,
  buildDeleteOccurrenceIcs,
  resolveEventUrl,
  hrefToUrl,
  _buildVTimezone, // exported for unit tests
};
