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
// The URLs and parsers live in public/openmeteo.js so the browser can use the same code
// when this server is out of Open-Meteo requests.
import {
  FORECAST_URL, FLOOD_URL, MARINE_URL, ARCHIVE_URL, HOURLY_VARS, ATTRIBUTION,
  openMeteoError, parseHourlyWeather, parseRiver, parseSea,
} from '../public/openmeteo.js';

export { FORECAST_URL, FLOOD_URL, MARINE_URL, ARCHIVE_URL, ATTRIBUTION, parseHourlyWeather, parseRiver, parseSea };

export const TTL = { forecast: 30 * MINUTE, river: 3 * HOUR, sea: 3 * HOUR, event: Infinity };
export const MAX_EVENT_DAYS = 10;
export const ARCHIVE_LAG_DAYS = 6;

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
