import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOsmService, parseOverpass, buildQuery, clampRadius, OVERPASS_ENDPOINTS, MAX_BUILDINGS } from '../lib/osm.mjs';
import { createAppServer } from '../server.mjs';

const LAT = 39.427992;
const LON = -0.418102;
const T0 = Date.UTC(2026, 10, 19, 12);

let tmp;
before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'waterline-osm-')); });
after(() => rm(tmp, { recursive: true, force: true }));

let dirCount = 0;
async function dirs() {
  const base = path.join(tmp, `case-${++dirCount}`);
  const fixturesDir = path.join(base, 'fixtures');
  await mkdir(fixturesDir, { recursive: true });
  return { cacheDir: path.join(base, 'cache'), fixturesDir };
}

const overpassBody = () => ({
  version: 0.6,
  elements: [
    { type: 'way', id: 1, center: { lat: 39.4280001234, lon: -0.4181009876 }, tags: { building: 'yes', 'building:levels': '4' } },
    { type: 'way', id: 1, center: { lat: 39.4280001234, lon: -0.4181009876 }, tags: { building: 'yes', 'building:levels': '4' } }, // duplicate
    { type: 'relation', id: 2, center: { lat: 39.429, lon: -0.419 }, tags: { building: 'apartments', 'building:levels': 'many' } },
    { type: 'way', id: 3, center: { lat: 39.427, lon: -0.417 }, tags: { building: 'school', amenity: 'school', name: 'CEIP Lluís Vives' } },
    { type: 'way', id: 4, geometry: [{ lat: 39.4271234567, lon: -0.4181234567 }, { lat: 39.428, lon: -0.419 }, null], tags: { highway: 'residential', name: 'Carrer Major' } },
    { type: 'way', id: 5, geometry: [{ lat: 39.4271, lon: -0.4181 }, { lat: 39.428, lon: -0.419 }], tags: { highway: 'footway' } },
    { type: 'way', id: 6, geometry: [{ lat: 39.4271, lon: -0.4181 }], tags: { highway: 'service' } }, // single point: dropped
    { type: 'node', id: 7, lat: 39.4279, lon: -0.414, tags: { amenity: 'pharmacy', name: 'Farmacia' } },
    { type: 'node', id: 8, lat: 39.426, lon: -0.416, tags: { emergency: 'assembly_point' } },
    { type: 'way', id: 9, center: { lat: 39.425, lon: -0.42 }, tags: { power: 'substation' } },
    { type: 'way', id: 10, center: { lat: 39.424, lon: -0.421 }, tags: { amenity: 'nursing_home', name: 'Residència' } },
    { type: 'node', id: 11, lat: 39.424, lon: -0.422, tags: { amenity: 'social_facility', social_facility: 'nursing_home' } },
    { type: 'node', id: 12, lat: 39.424, lon: -0.423, tags: { amenity: 'shelter' } },
    { type: 'node', id: 13, lat: 'x', lon: 500, tags: { amenity: 'hospital' } }, // bad coordinates
    null, 'junk', { type: 'way', id: 14 },
  ],
});

const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

function fakeOverpass(responders) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['User-Agent'], 'Waterline/0.2 (flood-awareness demo)');
    assert.match(init.body, /^data=/);
    const respond = responders[calls.length - 1] ?? responders.at(-1);
    return respond(String(url));
  };
  return { impl, calls };
}

test('clampRadius defaults to 900 and clamps to 200..1500', () => {
  assert.equal(clampRadius(undefined), 900);
  assert.equal(clampRadius(''), 900);
  assert.equal(clampRadius('50'), 200);
  assert.equal(clampRadius(5000), 1500);
  assert.equal(clampRadius('750.4'), 750);
  assert.equal(clampRadius('abc'), 900);
});

test('buildQuery is one combined query with centres for buildings and geometry for roads', () => {
  const query = buildQuery(LAT, LON, 900);
  assert.match(query, /^\[out:json\]\[timeout:25\];/);
  assert.match(query, /way\["building"\]\(around:900,39\.427992,-0\.418102\)/);
  assert.match(query, /out tags center qt;/);
  assert.match(query, /out tags geom qt;/);
  assert.match(query, /living_street\|service/);
  assert.match(query, /nwr\["power"="substation"\]/);
  assert.match(query, /nwr\["emergency"="assembly_point"\]/);
});

test('parseOverpass maps buildings, roads and facilities and ignores junk', () => {
  const { buildings, roads, facilities } = parseOverpass(overpassBody(), { lat: LAT, lon: LON });
  assert.equal(buildings.length, 3, 'duplicate way counted once');
  assert.deepEqual(buildings[0], [-0.418101, 39.428, 4, null]);
  assert.ok(buildings.some((b) => b[2] === null), 'non-numeric levels -> null');
  assert.deepEqual(roads, [{ name: 'Carrer Major', kind: 'residential', coords: [[-0.418123, 39.427123], [-0.419, 39.428]] }]);
  const kinds = facilities.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['care_home', 'care_home', 'pharmacy', 'school', 'shelter', 'shelter', 'substation']);
  assert.deepEqual(facilities.find((f) => f.kind === 'pharmacy'), { kind: 'pharmacy', name: 'Farmacia', lon: -0.414, lat: 39.4279 });
  assert.equal(facilities.find((f) => f.kind === 'substation').name, null);
  for (const junk of [null, 'x', {}, { elements: 'nope' }]) {
    assert.deepEqual(parseOverpass(junk), { buildings: [], roads: [], facilities: [] });
  }
});

test('parseOverpass caps buildings, keeping the nearest', () => {
  const elements = Array.from({ length: MAX_BUILDINGS + 50 }, (_, i) => ({ type: 'way', id: i, center: { lat: LAT + i * 1e-5, lon: LON }, tags: { building: 'yes' } }));
  const { buildings } = parseOverpass({ elements }, { lat: LAT, lon: LON });
  assert.equal(buildings.length, MAX_BUILDINGS);
  assert.equal(buildings[0][1], LAT);
});

test('fails over across Overpass servers on 429, 504, a timeout remark and non-JSON', async () => {
  const { impl, calls } = fakeOverpass([
    () => json('Too many requests', 429),
    () => json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' }),
    () => json(overpassBody()),
  ]);
  const service = createOsmService({ fetchImpl: impl, ...(await dirs()), now: () => T0 });
  const body = await service.around(LAT, LON, '900');
  assert.deepEqual(calls.map((c) => c.url), OVERPASS_ENDPOINTS);
  assert.equal(body.status, 'live');
  assert.equal(body.radius, 900);
  assert.equal(body.attribution, '© OpenStreetMap contributors (ODbL)');
  assert.equal(body.fetchedAt, new Date(T0).toISOString());
  assert.equal(body.buildings.length, 3);
  assert.match(decodeURIComponent(calls[0].init.body.replace(/\+/g, ' ')), /around:900,39\.427992,-0\.418102/);

  const flaky = fakeOverpass([() => json('<html>504 Gateway Timeout</html>', 504), () => json('<?xml version="1.0"?><osm/>'), () => json(overpassBody())]);
  const other = createOsmService({ fetchImpl: flaky.impl, ...(await dirs()), now: () => T0 });
  assert.equal((await other.around(LAT, LON)).status, 'live');
  assert.equal(flaky.calls.length, 3);
});

test('a server that hangs is abandoned after the per-endpoint timeout', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  let n = 0;
  const impl = (url, init) => (++n === 1 ? hang(url, init) : Promise.resolve(json(overpassBody())));
  const service = createOsmService({ fetchImpl: impl, ...(await dirs()), now: () => T0, endpointTimeoutMs: 50 });
  assert.equal((await service.around(LAT, LON)).status, 'live');
  assert.equal(n, 2);
});

test('caches for 14 days, then serves stale when every server fails', async () => {
  const where = await dirs();
  let clock = T0;
  let down = false;
  let calls = 0;
  const impl = async () => { calls += 1; if (down) throw new TypeError('fetch failed'); return json(overpassBody()); };
  const service = createOsmService({ fetchImpl: impl, ...where, now: () => clock });
  await service.around(LAT, LON, 900);
  clock = T0 + 13 * 86_400_000;
  assert.equal((await service.around(LAT, LON, 900)).status, 'cached');
  assert.equal(calls, 1);
  down = true;
  clock = T0 + 15 * 86_400_000;
  const stale = await service.around(LAT, LON, 900);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.fetchedAt, new Date(T0).toISOString());
  assert.equal(stale.buildings.length, 3);
});

test('falls back to a nearby fixture (keeping its radius), otherwise throws 502', async () => {
  const where = await dirs();
  const parsed = parseOverpass(overpassBody());
  await writeFile(path.join(where.fixturesDir, 'test-osm.json'), JSON.stringify({
    fixture: { kind: 'osm', place: 'test', lat: LAT, lon: LON, radius: 900, createdAt: '2026-11-19T00:00:00Z' },
    body: { ...parsed, radius: 900, fetchedAt: '2026-11-19T00:00:00.000Z', status: 'live', attribution: '© OpenStreetMap contributors (ODbL)' },
  }));
  await writeFile(path.join(where.fixturesDir, 'broken.json'), '{oops');
  const service = createOsmService({ fetchImpl: async () => json('busy', 429), ...where, now: () => T0 });
  const body = await service.around(LAT, LON - 0.01, 400); // about 860 m west
  assert.equal(body.status, 'fixture');
  assert.equal(body.radius, 900);
  await assert.rejects(service.around(LAT + 0.05, LON), (error) => error.status === 502 && /OpenStreetMap/.test(error.message));
});

test('the committed demo fixtures are served when everything upstream is down', async () => {
  const { createWeatherService } = await import('../lib/weather.mjs');
  const PLACES = {
    kerrville: { lat: 30.043724, lon: -99.142402, start: '2025-07-02', end: '2025-07-06' },
    paiporta: { lat: 39.427992, lon: -0.418102, start: '2024-10-27', end: '2024-10-31' },
  };
  const offline = async () => { throw new TypeError('fetch failed'); };
  const { cacheDir } = await dirs(); // empty cache; default (committed) fixtures directory
  const weather = createWeatherService({ fetchImpl: offline, cacheDir, now: () => T0 });
  const osm = createOsmService({ fetchImpl: offline, cacheDir, now: () => T0 });
  for (const [name, { lat, lon, start, end }] of Object.entries(PLACES)) {
    const forecast = await weather.forecast(lat, lon);
    assert.equal(forecast.status, 'fixture', name);
    assert.ok(forecast.hourly.time.length > 0 && forecast.hourly.precipitation.length === forecast.hourly.time.length, name);
    const event = await weather.event(lat, lon, start, end);
    assert.equal(event.status, 'fixture', name);
    assert.ok(event.hourly.time[0].startsWith(start), name);
    const map = await osm.around(lat, lon, 900);
    assert.equal(map.status, 'fixture', name);
    assert.ok(map.buildings.length > 100 && map.roads.length > 100, name);
    assert.equal(map.attribution, '© OpenStreetMap contributors (ODbL)');
  }
});

test('osm route validates input and returns the service result', async () => {
  const where = await dirs();
  const server = createAppServer({}, {
    floodDepth: { depthsAt: async () => ({}) },
    dataFetchImpl: async () => json(overpassBody()),
    ...where,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const query of ['', '?lat=1', '?lat=x&lon=1', '?lat=1&lon=181', '?lat=1&lon=1&radius=wide']) {
      const response = await fetch(`${base}/api/osm${query}`);
      assert.equal(response.status, 400, query);
      assert.ok((await response.json()).error);
    }
    const body = await (await fetch(`${base}/api/osm?lat=${LAT}&lon=${LON}&radius=99999`)).json();
    assert.equal(body.radius, 1500);
    assert.equal(body.status, 'live');
    assert.deepEqual(Object.keys(body).sort(), ['attribution', 'buildings', 'facilities', 'fetchedAt', 'radius', 'roads', 'status']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
