// Buildings, roads and critical facilities around a point, from OpenStreetMap
// via the Overpass API (one combined query, tried on several public servers).
//
// Public Overpass servers are often overloaded, so results are cached on disk
// for 14 days, a stale copy is served if every server fails, and the nearest
// committed fixture (data/fixtures/) is the last resort. The demo places themselves always
// answer from their fixture (see around()).

import {
  createDiskCache, createFixtureStore, loadSource, fetchJson, cacheKey, round3, upstreamError, metresBetween, DAY,
} from './disk-cache.mjs';
// The query and parser live in public/overpass.js so the browser can use the same code when
// this server can't reach Overpass.
import { OVERPASS_ENDPOINTS, ATTRIBUTION, buildQuery, parseOverpass } from '../public/overpass.js';

export {
  OVERPASS_ENDPOINTS, ATTRIBUTION, MAX_BUILDINGS, MAX_ROADS, MAX_FACILITIES, ROAD_KINDS, buildQuery, parseOverpass,
} from '../public/overpass.js';

export const TTL_MS = 14 * DAY;
export const DEFAULT_RADIUS = 900;
export const MIN_RADIUS = 200;
export const MAX_RADIUS = 1500;
export const FALLBACK_RADIUS = 400; // tried when a full-radius query fails and there is no saved copy
export const DEMO_SPOT_METRES = 100; // this close to a committed snapshot, the snapshot answers

export function clampRadius(value) {
  const radius = value === undefined || value === null || value === '' ? DEFAULT_RADIUS : Number(value);
  if (!Number.isFinite(radius)) return DEFAULT_RADIUS;
  return Math.round(Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius)));
}

export function createOsmService({
  fetchImpl = fetch,
  cacheDir,
  fixturesDir,
  now = Date.now,
  endpoints = OVERPASS_ENDPOINTS,
  endpointTimeoutMs = Number(process.env.OVERPASS_TIMEOUT_MS) || 35_000,
  totalBudgetMs = 80_000,
  cache = createDiskCache({ dir: cacheDir, now }),
  fixtures = createFixtureStore({ dir: fixturesDir }),
} = {}) {
  const inflight = new Map();

  async function queryOverpass(lat, lon, radius) {
    const body = new URLSearchParams({ data: buildQuery(lat, lon, radius) }).toString();
    const deadline = Date.now() + totalBudgetMs;
    const failures = [];
    for (const endpoint of endpoints) {
      const remaining = deadline - Date.now();
      if (remaining < 2_000) break;
      const host = new URL(endpoint).host;
      try {
        const response = await fetchJson(fetchImpl, endpoint, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeoutMs: Math.min(endpointTimeoutMs, remaining),
        });
        const json = response.json;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!json || typeof json !== 'object' || !Array.isArray(json.elements)) throw new Error('not Overpass JSON');
        // Overpass reports server-side timeouts and memory limits as HTTP 200 with a remark.
        if (json.remark) throw new Error(`remark: ${String(json.remark).slice(0, 120)}`);
        return parseOverpass(json, { lat, lon });
      } catch (error) {
        const reason = error.name === 'TimeoutError' ? 'timed out' : error.message;
        failures.push(`${host}: ${reason}`);
        console.warn(`[osm] ${host} failed (${reason}); trying the next server`);
      }
    }
    throw upstreamError(`All Overpass servers failed (${failures.join('; ') || 'no time left'})`);
  }

  /** Buildings, roads and facilities within `radius` metres of lat/lon. */
  async function around(lat, lon, radiusInput) {
    const radius = clampRadius(radiusInput);
    const source = {
      cache, inflight, key: cacheKey('osm', round3(lat), round3(lon), radius), ttlMs: TTL_MS,
      load: () => queryOverpass(lat, lon, radius),
    };
    // The demo places answer from their committed snapshot: instantly, even on a cold server (free
    // hosts wipe the cache on every restart), and with the same buildings as the report. A live
    // Overpass answer can differ from mirror to mirror.
    const saved = await fixtures.find('osm', lat, lon, (meta) => metresBetween({ lat, lon }, meta) <= DEMO_SPOT_METRES && (meta.radius ?? 0) >= radius);
    if (saved) return { ...saved, status: 'fixture' };
    const result = await loadSource(source);
    if (result.status === 'failed') {
      const body = await fixtures.find('osm', lat, lon);
      if (body) return { ...body, status: 'fixture' };
      // Dense cities can be too much for a busy Overpass server: try the streets nearest the spot.
      if (radius > FALLBACK_RADIUS) {
        try {
          const nearer = await around(lat, lon, FALLBACK_RADIUS);
          return { ...nearer, partial: true, requestedRadius: radius };
        } catch { /* fall through to the error below */ }
      }
      throw upstreamError('Map data (OpenStreetMap) is unavailable right now. Please try again in a minute.');
    }
    if (result.status === 'stale') console.warn(`[osm] serving stale cache (${result.error.message})`);
    return {
      ...result.data,
      radius,
      fetchedAt: new Date(result.fetchedAt).toISOString(),
      status: result.status,
      attribution: ATTRIBUTION,
    };
  }

  return { around };
}
