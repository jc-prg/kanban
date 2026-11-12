'use strict';
// "Today" provider: weather from Open-Meteo (no API key). Cached per location for 15 min.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL  = 'https://geocoding-api.open-meteo.com/v1/search';
const CACHE_MS     = 15 * 60 * 1000;
const HOURS_AHEAD  = 12;

const _cache = new Map();   // "lat,lon" → { at, data }

function _clearCache() { _cache.clear(); }

async function _getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Weather service: HTTP ${res.status}`);
  return res.json();
}

/** Normalise an Open-Meteo forecast response (times are local to the location). */
function normaliseForecast(raw, label) {
  const cur    = raw.current || {};
  const daily  = raw.daily   || {};
  const hourly = raw.hourly  || {};
  const day = i => daily.time?.[i] == null ? null : {
    date:      daily.time[i],
    min:       daily.temperature_2m_min?.[i] ?? null,
    max:       daily.temperature_2m_max?.[i] ?? null,
    code:      daily.weather_code?.[i] ?? null,
    precipMax: daily.precipitation_probability_max?.[i] ?? null,
    sunrise:   daily.sunrise?.[i] ?? null,
    sunset:    daily.sunset?.[i] ?? null,
  };
  // Hourly strip: from the current hour on
  const nowHour = (cur.time || '').slice(0, 13);
  const hours = [];
  for (let i = 0; i < (hourly.time || []).length && hours.length < HOURS_AHEAD; i++) {
    if (hourly.time[i].slice(0, 13) < nowHour) continue;
    hours.push({
      time:   hourly.time[i],
      temp:   hourly.temperature_2m?.[i] ?? null,
      precip: hourly.precipitation_probability?.[i] ?? null,
      code:   hourly.weather_code?.[i] ?? null,
    });
  }
  return {
    label: label || '',
    current: { time: cur.time || null, temp: cur.temperature_2m ?? null, code: cur.weather_code ?? null, isDay: cur.is_day !== 0 },
    today:    day(0),
    tomorrow: day(1),
    days:     (daily.time || []).map((_, i) => day(i)),   // today + the next 6 (7-day view)
    hours,
  };
}

async function fetchWeather(settings = {}) {
  const lat = Number(settings.lat), lon = Number(settings.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const err = new Error('No weather location configured'); err.statusCode = 400; throw err;
  }
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.data, label: settings.label || '' };

  const qs = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: 'auto', forecast_days: '7',
    current: 'temperature_2m,weather_code,is_day',
    hourly:  'temperature_2m,precipitation_probability,weather_code',
    daily:   'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset',
  });
  const data = normaliseForecast(await _getJson(`${FORECAST_URL}?${qs}`), settings.label);
  _cache.set(key, { at: Date.now(), data });
  return data;
}

async function geocode(q) {
  const qs = new URLSearchParams({ name: q, count: '6', language: 'de', format: 'json' });
  const raw = await _getJson(`${GEOCODE_URL}?${qs}`);
  return (raw.results || []).map(r => ({
    name: r.name, admin1: r.admin1 || '', country: r.country || '',
    lat: r.latitude, lon: r.longitude,
  }));
}

module.exports = { fetchWeather, geocode, normaliseForecast, _clearCache };
