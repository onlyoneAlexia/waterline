// Open-Meteo parsing, shared by the server (lib/weather.mjs) and the browser.
//
// The browser uses it as a fallback: free Open-Meteo limits requests per IP address, and a
// shared cloud host can run out of the daily allowance. Then the page asks Open-Meteo itself
// (it allows cross-origin requests), from the visitor's own address.
// No imports, so this file runs unchanged in Node and in the browser.

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const FLOOD_URL = 'https://flood-api.open-meteo.com/v1/flood';
export const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

export const HOURLY_VARS = ['precipitation', 'wind_speed_10m', 'wind_gusts_10m', 'weather_code'];
const MAX_HOURS = 24 * 16; // Cap on any hourly series we pass on.
const MAX_DAYS = 120;

export const ATTRIBUTION = {
  forecast: 'Weather forecast: Open-Meteo.com (CC BY 4.0)',
  archive: 'Historical weather: Open-Meteo.com Historical Weather API, ERA5 reanalysis from the Copernicus Climate Change Service (CC BY 4.0)',
  river: 'River discharge: GloFAS, Copernicus Emergency Management Service, via Open-Meteo Flood API (CC BY 4.0)',
  sea: 'Sea level: Open-Meteo Marine API (CC BY 4.0)',
};

/** Same shape as lib/disk-cache.mjs upstreamError: an Error with an HTTP status for the server. */
export function upstreamError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

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

export function openMeteoError(name, response) {
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

// ---------- direct requests (the browser fallback) ----------

async function getJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  let json = null;
  try { json = await response.json(); } catch { /* not JSON */ }
  return { ok: response.ok, status: response.status, json };
}

async function required(fetchImpl, name, url, timeoutMs) {
  const response = await getJson(fetchImpl, url, timeoutMs);
  if (!response.ok || !response.json || typeof response.json !== 'object') throw openMeteoError(name, response);
  return parseHourlyWeather(response.json);
}

// River and sea are extras: any failure (including "no data here") just leaves them out.
async function optional(fetchImpl, url, parse, timeoutMs) {
  try {
    const response = await getJson(fetchImpl, url, timeoutMs);
    return response.ok && response.json && typeof response.json === 'object' ? parse(response.json) : null;
  } catch {
    return null;
  }
}

function body({ lat, lon, main, river, sea, attribution, sources }) {
  return {
    place: { lat, lon, timezone: main.timezone, elevation: main.elevation },
    hourly: main.hourly,
    river,
    sea,
    fetchedAt: new Date().toISOString(),
    status: 'live',
    sources,
    attribution,
    direct: true,
  };
}

/** Live forecast straight from Open-Meteo, in the same shape as GET /api/weather. */
export async function fetchForecastDirect(lat, lon, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const at = `latitude=${lat}&longitude=${lon}`;
  const [main, river, sea] = await Promise.all([
    required(fetchImpl, 'forecast', `${FORECAST_URL}?${at}&hourly=${HOURLY_VARS.join(',')}&past_days=1&forecast_days=3&timezone=auto`, timeoutMs),
    optional(fetchImpl, `${FLOOD_URL}?${at}&daily=river_discharge,river_discharge_max&past_days=30&forecast_days=30`, parseRiver, timeoutMs),
    optional(fetchImpl, `${MARINE_URL}?${at}&hourly=sea_level_height_msl&forecast_days=3&timezone=auto`, parseSea, timeoutMs),
  ]);
  return body({
    lat, lon, main, river, sea,
    sources: { main: 'live', river: river ? 'live' : 'unavailable', sea: sea ? 'live' : 'unavailable' },
    attribution: [ATTRIBUTION.forecast, ATTRIBUTION.river, ATTRIBUTION.sea].join('. '),
  });
}

/** A past event straight from the ERA5 archive, in the same shape as GET /api/weather/event. */
export async function fetchEventDirect(lat, lon, start, end, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const at = `latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}`;
  const [main, river] = await Promise.all([
    required(fetchImpl, 'archive', `${ARCHIVE_URL}?${at}&hourly=${HOURLY_VARS.join(',')}&timezone=auto`, timeoutMs),
    optional(fetchImpl, `${FLOOD_URL}?${at}&daily=river_discharge,river_discharge_max`, parseRiver, timeoutMs),
  ]);
  return {
    ...body({
      lat, lon, main, river, sea: null,
      sources: { main: 'live', river: river ? 'live' : 'unavailable' },
      attribution: [ATTRIBUTION.archive, ATTRIBUTION.river].join('. '),
    }),
    event: { start, end },
  };
}

/**
 * Ask our server first (it caches, and has saved copies for the demo places). If it fails, or
 * only has a saved copy, try Open-Meteo directly. When both fail, keep whatever the server gave.
 * `server()` resolves to { ok, data }; `direct()` resolves to a weather body or throws.
 */
export async function withDirectFallback(server, direct) {
  let fromServer = null;
  let serverError = null;
  try {
    const { ok, data } = await server();
    if (ok) fromServer = data;
    else serverError = new Error(data?.error || 'Weather server unavailable');
  } catch (error) {
    serverError = error;
  }
  if (fromServer && fromServer.status !== 'fixture') return fromServer;
  try {
    return await direct();
  } catch (directError) {
    if (fromServer) return fromServer;
    throw serverError ?? directError;
  }
}
