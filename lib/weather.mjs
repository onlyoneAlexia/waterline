// Rain, wind, river discharge and sea level around a point, from Open-Meteo
// (free, no key): forecast, GloFAS flood API, marine API and the ERA5 archive.
//
// Each upstream source is cached on its own (.waterline/cache/) with its own
// time-to-live, so one slow or failing source never blocks the others.
// If the main source (forecast or archive) fails with nothing cached, the
// nearest committed fixture (data/fixtures/) within 1.5 km is served instead.

import {
  createDiskCache, createFixtureStore, loadSource, fetchJson, cacheKey, round3, upstreamError,
  MINUTE, HOUR, DAY,
} from './disk-cache.mjs';

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const FLOOD_URL = 'https://flood-api.open-meteo.com/v1/flood';
export const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

export const TTL = { forecast: 30 * MINUTE, river: 3 * HOUR, sea: 3 * HOUR, event: Infinity };
export const MAX_EVENT_DAYS = 10;
export const ARCHIVE_LAG_DAYS = 6;

const HOURLY_VARS = ['precipitation', 'wind_speed_10m', 'wind_gusts_10m', 'weather_code'];
const MAX_HOURS = 24 * 16; // Cap on any hourly series we pass on.
const MAX_DAYS = 120;

export const ATTRIBUTION = {
  forecast: 'Weather forecast: Open-Meteo.com (CC BY 4.0)',
  archive: 'Historical weather: Open-Meteo.com Historical Weather API, ERA5 reanalysis from the Copernicus Climate Change Service (CC BY 4.0)',
  river: 'River discharge: GloFAS, Copernicus Emergency Management Service, via Open-Meteo Flood API (CC BY 4.0)',
  sea: 'Sea level: Open-Meteo Marine API (CC BY 4.0)',
};

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const allNull = (values) => values.every((value) => value === null);

function series(block, name, length) {
  const values = Array.isArray(block?.[name]) ? block[name] : [];
  return Array.from({ length }, (_, i) => num(values[i]));
}

function timeAxis(block, cap) {
  const times = Array.isArray(block?.time) ? block.time : null;
  if (!times || !times.length || !times.every((t) => typeof t === 'string' && t.length <= 25)) return null;
  return times.slice(0, cap);
}

function openMeteoError(name, response) {
  if (response.ok) return upstreamError(`${name} returned malformed JSON`);
  const reason = typeof response.json?.reason === 'string' ? `: ${response.json.reason.slice(0, 200)}` : '';
  return upstreamError(`${name} answered HTTP ${response.status}${reason}`);
}

/** Forecast or archive response -> { timezone, elevation, hourly }. Throws if unusable. */
export function parseHourlyWeather(json) {
  const time = timeAxis(json?.hourly, MAX_HOURS);
  if (!time) throw upstreamError('Weather response had no hourly time axis');
  const hourly = { time };
  for (const name of HOURLY_VARS) hourly[name] = series(json.hourly, name, time.length);
  if (allNull(hourly.precipitation)) throw upstreamError('Weather response had no precipitation values');
  return {
    timezone: typeof json.timezone === 'string' ? json.timezone.slice(0, 60) : 'UTC',
    elevation: num(json.elevation),
    hourly,
  };
}

/** Flood API response -> { lat, lon, daily } or null when there is no river here (all nulls). */
export function parseRiver(json) {
  const time = timeAxis(json?.daily, MAX_DAYS);
  if (!time) return null;
  const daily = { time, river_discharge: series(json.daily, 'river_discharge', time.length) };
  if (allNull(daily.river_discharge)) return null;
  if (Array.isArray(json.daily.river_discharge_max)) {
    const max = series(json.daily, 'river_discharge_max', time.length);
    if (!allNull(max)) daily.river_discharge_max = max;
  }
  return { lat: num(json.latitude), lon: num(json.longitude), daily };
}

/** Marine API response -> { lat, lon, hourly } or null when the point is inland (all nulls). */
export function parseSea(json) {
  const time = timeAxis(json?.hourly, MAX_HOURS);
  if (!time) return null;
  const hourly = { time, sea_level_height_msl: series(json.hourly, 'sea_level_height_msl', time.length) };
  if (allNull(hourly.sea_level_height_msl)) return null;
  return { lat: num(json.latitude), lon: num(json.longitude), hourly };
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDay(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  return isoDay(ms) === text ? ms : null; // Rejects 2024-02-30 and friends.
}

/** Returns an error message, or null when start..end is a valid past-event range. */
export function validateEventRange(start, end, now = Date.now()) {
  const startMs = parseDay(start);
  const endMs = parseDay(end);
  if (startMs === null || endMs === null) return 'start and end must be dates like 2024-10-29';
  if (startMs < Date.UTC(1950, 0, 1)) return 'start must be 1950-01-01 or later';
  if (endMs < startMs) return 'end must be on or after start';
  if ((endMs - startMs) / DAY > MAX_EVENT_DAYS) return `Pick a range of at most ${MAX_EVENT_DAYS} days`;
  const latest = isoDay(now - ARCHIVE_LAG_DAYS * DAY);
  if (end > latest) return `The archive runs about ${ARCHIVE_LAG_DAYS} days behind; end must be ${latest} or earlier`;
  return null;
}

export function createWeatherService({
  fetchImpl = fetch,
  cacheDir,
  fixturesDir,
  now = Date.now,
  timeoutMs = 20_000,
  cache = createDiskCache({ dir: cacheDir, now }),
  fixtures = createFixtureStore({ dir: fixturesDir }),
} = {}) {
  const inflight = new Map();

  async function getJson(name, url) {
    const response = await fetchJson(fetchImpl, url, { timeoutMs });
    return { name, ...response };
  }

  // Optional sources (river, sea): HTTP 400 from Open-Meteo is a definite "no data for this
  // point or range", so it becomes null (and is cached). Other failures throw.
  async function optional(name, url, parse) {
    const response = await getJson(name, url);
    if (response.status === 400 && response.json?.error === true) return null;
    if (!response.ok || !response.json || typeof response.json !== 'object') throw openMeteoError(name, response);
    return parse(response.json);
  }

  async function required(name, url) {
    const response = await getJson(name, url);
    if (!response.ok || !response.json || typeof response.json !== 'object') throw openMeteoError(name, response);
    return parseHourlyWeather(response.json);
  }

  function compose({ lat, lon, main, river, sea, attribution }) {
    const parts = { main, river, sea };
    const statuses = Object.values(parts).map((part) => part.status);
    const status = statuses.includes('stale') ? 'stale' : statuses.includes('live') ? 'live' : 'cached';
    const sources = Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part.status === 'failed' ? 'unavailable' : part.status]));
    return {
      place: { lat, lon, timezone: main.data.timezone, elevation: main.data.elevation },
      hourly: main.data.hourly,
      river: river.data ?? null,
      sea: sea.data ?? null,
      fetchedAt: new Date(main.fetchedAt).toISOString(),
      status,
      sources,
      attribution,
    };
  }

  async function fromFixtureOr502(kind, lat, lon, accept, why) {
    const body = await fixtures.find(kind, lat, lon, accept);
    if (body) return { ...body, place: { ...body.place }, status: 'fixture' };
    throw upstreamError(`Weather data is unavailable right now (${why}). Please try again in a minute.`);
  }

  function logFailures(label, parts) {
    for (const [name, part] of Object.entries(parts)) {
      if (part.error) console.warn(`[weather] ${label} ${name}: ${part.status === 'stale' ? 'serving stale cache' : 'unavailable'} (${part.error.message})`);
    }
  }

  /** Live forecast: 1 past day + 3 forecast days of hourly rain and wind, river discharge, sea level. */
  async function forecast(lat, lon) {
    const at = `latitude=${lat}&longitude=${lon}`;
    const k = [round3(lat), round3(lon)];
    const [main, river, sea] = await Promise.all([
      loadSource({
        cache, inflight, key: cacheKey('forecast', ...k), ttlMs: TTL.forecast,
        load: () => required('forecast', `${FORECAST_URL}?${at}&hourly=${HOURLY_VARS.join(',')}&past_days=1&forecast_days=3&timezone=auto`),
      }),
      loadSource({
        cache, inflight, key: cacheKey('river', ...k), ttlMs: TTL.river,
        load: () => optional('river', `${FLOOD_URL}?${at}&daily=river_discharge,river_discharge_max&past_days=30&forecast_days=30`, parseRiver),
      }),
      loadSource({
        cache, inflight, key: cacheKey('sea', ...k), ttlMs: TTL.sea,
        load: () => optional('sea', `${MARINE_URL}?${at}&hourly=sea_level_height_msl&forecast_days=3&timezone=auto`, parseSea),
      }),
    ]);
    logFailures('forecast', { main, river, sea });
    if (main.status === 'failed') return fromFixtureOr502('weather', lat, lon, undefined, main.error.message);
    return compose({ lat, lon, main, river, sea, attribution: [ATTRIBUTION.forecast, ATTRIBUTION.river, ATTRIBUTION.sea].join('. ') });
  }

  /** A past flood event: hourly rain and wind from the ERA5 archive, daily river discharge. */
  async function event(lat, lon, start, end) {
    const problem = validateEventRange(start, end, now());
    if (problem) throw upstreamError(problem, 400);
    const at = `latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}`;
    const k = [round3(lat), round3(lon), start, end];
    const [main, river] = await Promise.all([
      loadSource({
        cache, inflight, key: cacheKey('archive', ...k), ttlMs: TTL.event,
        load: () => required('archive', `${ARCHIVE_URL}?${at}&hourly=${HOURLY_VARS.join(',')}&timezone=auto`),
      }),
      loadSource({
        cache, inflight, key: cacheKey('river-event', ...k), ttlMs: TTL.event,
        load: () => optional('river', `${FLOOD_URL}?${at}&daily=river_discharge,river_discharge_max`, parseRiver),
      }),
    ]);
    const sea = { status: 'cached', data: null }; // No sea-level history: the marine API only covers recent years.
    logFailures('event', { main, river });
    if (main.status === 'failed') {
      return fromFixtureOr502('event', lat, lon, (meta) => meta.start === start && meta.end === end, main.error.message);
    }
    const body = compose({ lat, lon, main, river, sea, attribution: [ATTRIBUTION.archive, ATTRIBUTION.river].join('. ') });
    delete body.sources.sea;
    return { ...body, event: { start, end } };
  }

  return { forecast, event };
}
