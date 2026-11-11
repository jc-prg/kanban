'use strict';
// "Today" provider: active applications from the CV-App (FastAPI, x-api-key auth). Cached 5 min.

const CACHE_MS = 5 * 60 * 1000;
// Active = Research … Angebot (the CV-App's "Aktiv" filter); status order as in its applications list
const ACTIVE_STATUSES = ['Research', 'Vorbereitung', 'Versendet', 'Gespräch', 'Angebot'];
const STATUS_ORDER    = ['Research', 'Vorbereitung', 'Versendet', 'Kandidatenpool', 'Gespräch', 'Angebot',
                         'Absage', 'Keine Antwort', 'Zurückgezogen', 'Abgebrochen'];
const LIST_LIMIT      = 50;
const RECENT_LIMIT    = 15;
const PROGRESS_MAX    = 1500;

let _cache = null;   // { key, at, data }

function _clearCache() { _cache = null; }

/** Public base URL of the CV-App (deep links), without query / hash. */
function _publicBase(publicUrl) { return (publicUrl || '').replace(/[#?].*$/, ''); }

/** One application as the browser sees it; `url` = deep link into the CV-App (needs publicUrl). */
function applicationItem(a, base) {
  return {
    id: a.id, title: a.title || '', company: a.company || '', location: a.location || '',
    status: a.status || 'Vorbereitung', statusNote: a.status_note || '',
    progress: String(a.progress || '').slice(0, PROGRESS_MAX),
    fitScore: typeof a.fit_score === 'number' ? a.fit_score : null,
    appliedAt: a.applied_at || null,
    updatedAt: a.updated_at || null,
    url: base ? `${base}#/applications?id=${encodeURIComponent(a.id)}` : '',
  };
}

/**
 * Reduce the CV-App application list to the Today widget payload:
 * counts per active status, `active` (most advanced status first, then last updated) and
 * `recent` (all except "Abgebrochen", last updated first).
 */
function summariseApplications(apps, publicUrl) {
  const all  = Array.isArray(apps) ? apps : [];
  const base = _publicBase(publicUrl);
  const rank = s => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? STATUS_ORDER.length : i; };
  const byUpdated = (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  const out = a => applicationItem(a, base);

  const active = all.filter(a => ACTIVE_STATUSES.includes(a.status || 'Vorbereitung'));
  const counts = new Map();
  for (const a of active) counts.set(a.status || 'Vorbereitung', (counts.get(a.status || 'Vorbereitung') || 0) + 1);
  return {
    total: active.length,
    statuses: [...counts.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([status, count]) => ({ status, count })),
    active: [...active].sort((a, b) => rank(b.status || 'Vorbereitung') - rank(a.status || 'Vorbereitung') || byUpdated(a, b))
      .slice(0, LIST_LIMIT).map(out),
    recent: all.filter(a => a.status !== 'Abgebrochen').sort(byUpdated).slice(0, RECENT_LIMIT).map(out),
    appUrl: base,
  };
}

/** Raw application list of the CV-App (cached 5 min; also used by the Today search). */
async function fetchApplicationList(settings = {}) {
  const apiUrl = String(settings.apiUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(apiUrl)) {
    const err = new Error('CV-App is not configured'); err.statusCode = 400; throw err;
  }
  const key = `${apiUrl}\0${settings.apiKey || ''}`;
  if (_cache && _cache.key === key && Date.now() - _cache.at < CACHE_MS) return _cache.data;

  const headers = { Accept: 'application/json' };
  if (settings.apiKey) headers['x-api-key'] = settings.apiKey;
  const res = await fetch(`${apiUrl}/api/applications`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CV-App: HTTP ${res.status}`);
  const body = await res.json();
  const data = Array.isArray(body) ? body : [];
  _cache = { key, at: Date.now(), data };
  return data;
}

async function fetchApplications(settings = {}) {
  return summariseApplications(await fetchApplicationList(settings), settings.publicUrl);
}

module.exports = { fetchApplications, fetchApplicationList, applicationItem, summariseApplications, publicBase: _publicBase, STATUS_ORDER, _clearCache };
