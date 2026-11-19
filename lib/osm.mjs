// Buildings, roads and critical facilities around a point, from OpenStreetMap
// via the Overpass API (one combined query, tried on several public servers).
//
// Public Overpass servers are often overloaded, so results are cached on disk
// for 14 days, a stale copy is served if every server fails, and the nearest
// committed fixture (data/fixtures/) is the last resort.

import {
  createDiskCache, createFixtureStore, loadSource, fetchJson, cacheKey, round3, upstreamError, metresBetween, DAY,
} from './disk-cache.mjs';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
export const TTL_MS = 14 * DAY;
export const DEFAULT_RADIUS = 900;
export const MIN_RADIUS = 200;
export const MAX_RADIUS = 1500;
export const MAX_BUILDINGS = 8000;
export const MAX_ROADS = 3000;
export const MAX_FACILITIES = 500;
const MAX_POINTS_PER_ROAD = 500;
const MAX_NAME = 120;

export const ROAD_KINDS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service'];
const AMENITY_KINDS = ['hospital', 'clinic', 'school', 'kindergarten', 'fire_station', 'police', 'pharmacy'];

export function clampRadius(value) {
  const radius = value === undefined || value === null || value === '' ? DEFAULT_RADIUS : Number(value);
  if (!Number.isFinite(radius)) return DEFAULT_RADIUS;
  return Math.round(Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius)));
}

/** One combined Overpass QL query: building centroids, road lines, facility points. */
export function buildQuery(lat, lon, radius, serverTimeoutS = 25) {
  const around = `(around:${radius},${lat},${lon})`;
  return [
    `[out:json][timeout:${serverTimeoutS}];`,
    `(way["building"]${around};relation["building"]${around};);out tags center qt;`,
    `way["highway"~"^(${ROAD_KINDS.join('|')})$"]${around};out tags geom qt;`,
    '(',
    `nwr["amenity"~"^(${[...AMENITY_KINDS, 'shelter', 'nursing_home'].join('|')})$"]${around};`,
    `nwr["emergency"="assembly_point"]${around};`,
    `nwr["power"="substation"]${around};`,
    `nwr["social_facility"="nursing_home"]${around};`,
    ');out tags center qt;',
  ].join('');
}

const r6 = (value) => Math.round(value * 1e6) / 1e6;
const coord = (value, limit) => (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null);
const text = (value) => (typeof value === 'string' ? value.slice(0, MAX_NAME) : null);

function pointOf(element) {
  const source = element.center ?? element;
  const lat = coord(source?.lat, 90);
  const lon = coord(source?.lon, 180);
  return lat === null || lon === null ? null : { lat, lon };
}

function facilityKind(tags) {
  if (AMENITY_KINDS.includes(tags.amenity)) return tags.amenity;
  if (tags.amenity === 'nursing_home' || tags.social_facility === 'nursing_home') return 'care_home';
  if (tags.amenity === 'shelter' || tags.emergency === 'assembly_point') return 'shelter';
  if (tags.power === 'substation') return 'substation';
  return null;
}

function parseLevels(tags) {
  const raw = tags['building:levels'];
  const levels = Number.parseFloat(typeof raw === 'string' ? raw : '');
  return Number.isFinite(levels) && levels >= 0 && levels <= 200 ? levels : null;
}

/**
 * Overpass JSON -> { buildings, roads, facilities }. Tolerates junk elements.
 * Buildings and roads nearest the centre are kept first when the caps apply.
 */
export function parseOverpass(json, centre) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const seen = new Set();
  const buildings = [];
  const roads = [];
  const facilities = [];
  const distance = (p) => (centre ? metresBetween(centre, p) : 0);

  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const tags = element.tags && typeof element.tags === 'object' ? element.tags : {};
    const id = `${element.type}/${element.id}`;

    if (tags.building && tags.building !== 'no' && (element.type === 'way' || element.type === 'relation') && !seen.has(`b${id}`)) {
      const p = pointOf(element);
      if (p) {
        seen.add(`b${id}`);
        buildings.push({ d: distance(p), row: [r6(p.lon), r6(p.lat), parseLevels(tags), null] });
      }
    }

    if (element.type === 'way' && ROAD_KINDS.includes(tags.highway) && Array.isArray(element.geometry) && !seen.has(`r${id}`)) {
      const coords = [];
      for (const point of element.geometry) {
        const lat = coord(point?.lat, 90);
        const lon = coord(point?.lon, 180);
        if (lat !== null && lon !== null) coords.push([r6(lon), r6(lat)]);
        if (coords.length >= MAX_POINTS_PER_ROAD) break;
      }
      if (coords.length >= 2) {
        seen.add(`r${id}`);
        const mid = coords[Math.floor(coords.length / 2)];
        roads.push({ d: distance({ lon: mid[0], lat: mid[1] }), road: { name: text(tags.name), kind: tags.highway, coords } });
      }
    }

    const kind = facilityKind(tags);
    if (kind && !seen.has(`f${id}`)) {
      const p = pointOf(element);
      if (p) {
        seen.add(`f${id}`);
        facilities.push({ d: distance(p), facility: { kind, name: text(tags.name), lon: r6(p.lon), lat: r6(p.lat) } });
      }
    }
  }

  const nearest = (a, b) => a.d - b.d;
  return {
    buildings: buildings.sort(nearest).slice(0, MAX_BUILDINGS).map((b) => b.row),
    roads: roads.sort(nearest).slice(0, MAX_ROADS).map((r) => r.road),
    facilities: facilities.sort(nearest).slice(0, MAX_FACILITIES).map((f) => f.facility),
  };
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
    const result = await loadSource({
      cache, inflight, key: cacheKey('osm', round3(lat), round3(lon), radius), ttlMs: TTL_MS,
      load: () => queryOverpass(lat, lon, radius),
    });
    if (result.status === 'failed') {
      const body = await fixtures.find('osm', lat, lon);
      if (body) return { ...body, status: 'fixture' };
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
