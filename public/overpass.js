// OpenStreetMap through Overpass: the query, the parser and a direct browser request.
// Shared by the server (lib/osm.mjs) and the browser. Public Overpass servers are busy and some
// refuse or stall requests from shared cloud addresses, so when our server can't get an answer
// the page asks Overpass itself (it allows cross-origin requests), from the visitor's address.
// No imports, so this file runs unchanged in Node and in the browser.

function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6_371_000;
}

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
export const MAX_BUILDINGS = 8000;
export const MAX_ROADS = 3000;
export const MAX_FACILITIES = 500;
const MAX_POINTS_PER_ROAD = 500;
const MAX_NAME = 120;

export const ROAD_KINDS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service'];
const AMENITY_KINDS = ['hospital', 'clinic', 'school', 'kindergarten', 'fire_station', 'police', 'pharmacy'];

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

// ---------- direct requests (the browser fallback) ----------

/** Ask the Overpass servers in turn, straight from the browser. Same body shape as GET /api/osm. */
export async function fetchOsmDirect(lat, lon, radius, {
  fetchImpl = fetch, endpoints = OVERPASS_ENDPOINTS, endpointTimeoutMs = 45_000, totalBudgetMs = 120_000,
} = {}) {
  const body = new URLSearchParams({ data: buildQuery(lat, lon, radius) }).toString();
  const deadline = Date.now() + totalBudgetMs;
  const failures = [];
  for (const endpoint of endpoints) {
    const remaining = deadline - Date.now();
    if (remaining < 2_000) break;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(Math.min(endpointTimeoutMs, remaining)),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (!json || typeof json !== 'object' || !Array.isArray(json.elements)) throw new Error('not Overpass JSON');
      if (json.remark) throw new Error(`remark: ${String(json.remark).slice(0, 120)}`);
      return {
        ...parseOverpass(json, { lat, lon }),
        radius,
        fetchedAt: new Date().toISOString(),
        status: 'live',
        attribution: ATTRIBUTION,
        direct: true,
      };
    } catch (error) {
      failures.push(`${new URL(endpoint).host}: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
    }
  }
  throw new Error(`All Overpass servers failed (${failures.join('; ') || 'no time left'})`);
}

/**
 * Our server first (it caches, and answers the demo places at once from saved snapshots). If it
 * fails, or hasn't answered within `headStartMs`, the browser asks Overpass too, and the first good
 * answer wins. Rejects only when both fail, with the server's error.
 */
export function raceWithDirect(server, direct, { headStartMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let directStarted = false;
    let running = 1;
    let serverError = null;
    let directError = null;
    const win = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const lose = () => {
      running -= 1;
      if (settled || running > 0 || !directStarted) return;
      settled = true;
      reject(serverError ?? directError);
    };
    const startDirect = () => {
      if (settled || directStarted) return;
      directStarted = true;
      running += 1;
      Promise.resolve().then(direct).then(win, (error) => { directError = error; lose(); });
    };
    const timer = setTimeout(startDirect, headStartMs);
    Promise.resolve().then(server).then(win, (error) => {
      serverError = error;
      startDirect();
      lose();
    });
  });
}
