import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createWeatherService, parseHourlyWeather, parseRiver, parseSea, validateEventRange,
} from '../lib/weather.mjs';
import { createAppServer } from '../server.mjs';

const LAT = 39.427992;
const LON = -0.418102;
const T0 = Date.UTC(2026, 10, 19, 12);

let tmp;
before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'waterline-weather-')); });
after(() => rm(tmp, { recursive: true, force: true }));

let dirCount = 0;
async function dirs() {
  const base = path.join(tmp, `case-${++dirCount}`);
  const cacheDir = path.join(base, 'cache');
  const fixturesDir = path.join(base, 'fixtures');
  await mkdir(fixturesDir, { recursive: true });
  return { cacheDir, fixturesDir };
}

const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

const hours = (n, start = '2026-11-18') => Array.from({ length: n }, (_, i) => `${start}T${String(i % 24).padStart(2, '0')}:00`);

const forecastBody = () => ({
  latitude: 39.4, longitude: -0.45, timezone: 'Europe/Madrid', elevation: 29,
  hourly: {
    time: hours(4),
    precipitation: [0, 1.2, 'junk', 3],
    wind_speed_10m: [10, 11, 12, 13],
    wind_gusts_10m: [20, 21, 22, 23],
    weather_code: [3, 61, 63, 65],
  },
});
const riverBody = () => ({ latitude: 39.425, longitude: -0.425, daily: { time: ['2026-11-18', '2026-11-19'], river_discharge: [5.2, 460], river_discharge_max: [9, 650] } });
const seaBody = () => ({ latitude: 39.45, longitude: -0.45, hourly: { time: hours(2), sea_level_height_msl: [-0.4, -0.5] } });
const inlandSeaBody = () => ({ hourly: { time: hours(2), sea_level_height_msl: [null, null] } });

/** Fake fetch routing by host; `routes` values are functions returning a Response or throwing. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const target = new URL(String(url));
    calls.push(target);
    assert.equal(init.headers['User-Agent'], 'Waterline/0.2 (flood-awareness demo)');
    const handler = routes[target.host];
    if (!handler) throw new TypeError(`fetch failed (no route for ${target.host})`);
    return handler(target);
  };
  return { impl, calls };
}

const healthy = () => ({
  'api.open-meteo.com': () => json(forecastBody()),
  'flood-api.open-meteo.com': () => json(riverBody()),
  'marine-api.open-meteo.com': () => json(seaBody()),
  'archive-api.open-meteo.com': () => json({ ...forecastBody(), hourly: { ...forecastBody().hourly, time: hours(4, '2024-10-29') } }),
});

test('parseHourlyWeather aligns series to the time axis and nulls junk', () => {
  const parsed = parseHourlyWeather(forecastBody());
  assert.equal(parsed.timezone, 'Europe/Madrid');
  assert.equal(parsed.elevation, 29);
  assert.deepEqual(parsed.hourly.precipitation, [0, 1.2, null, 3]);
  const short = parseHourlyWeather({ hourly: { time: hours(3), precipitation: [1] } });
  assert.deepEqual(short.hourly.precipitation, [1, null, null]);
  assert.deepEqual(short.hourly.wind_gusts_10m, [null, null, null]);
  for (const junk of [null, 'html', {}, { hourly: {} }, { hourly: { time: 'x' } }, { hourly: { time: [1, 2] } }, { hourly: { time: hours(2), precipitation: [null, null] } }]) {
    assert.throws(() => parseHourlyWeather(junk), /hourly|precipitation/);
  }
});

test('parseRiver and parseSea return null when there is no river or sea here', () => {
  assert.deepEqual(parseRiver(riverBody()).daily.river_discharge, [5.2, 460]);
  assert.deepEqual(parseRiver(riverBody()).daily.river_discharge_max, [9, 650]);
  const noMax = parseRiver({ daily: { time: ['2026-11-18'], river_discharge: [3] } });
  assert.equal(noMax.daily.river_discharge_max, undefined);
  assert.equal(parseRiver({ daily: { time: ['2026-11-18'], river_discharge: [null] } }), null);
  assert.equal(parseRiver({ error: true }), null);
  assert.deepEqual(parseSea(seaBody()).hourly.sea_level_height_msl, [-0.4, -0.5]);
  assert.equal(parseSea(inlandSeaBody()), null);
  assert.equal(parseSea('garbage'), null);
});

test('validateEventRange rejects impossible, reversed, long, ancient and too-recent ranges', () => {
  const now = Date.UTC(2026, 10, 19);
  assert.equal(validateEventRange('2024-10-27', '2024-10-31', now), null);
  assert.equal(validateEventRange('2026-11-03', '2026-11-13', now), null); // exactly 10 days, today-6
  assert.match(validateEventRange('2024-02-30', '2024-03-02', now), /dates like/);
  assert.match(validateEventRange('2024/10/27', '2024-10-31', now), /dates like/);
  assert.match(validateEventRange('2024-10-31', '2024-10-27', now), /on or after/);
  assert.match(validateEventRange('2024-10-01', '2024-10-31', now), /at most 10 days/);
  assert.match(validateEventRange('1949-12-30', '1950-01-02', now), /1950/);
  assert.match(validateEventRange('2026-11-10', '2026-11-14', now), /behind/);
});

test('forecast composes live forecast, river and sea in the documented shape', async () => {
  const { impl, calls } = fakeFetch(healthy());
  const service = createWeatherService({ fetchImpl: impl, ...(await dirs()), now: () => T0 });
  const body = await service.forecast(LAT, LON);
  assert.deepEqual(Object.keys(body).sort(), ['attribution', 'fetchedAt', 'hourly', 'place', 'river', 'sea', 'sources', 'status']);
  assert.deepEqual(body.place, { lat: LAT, lon: LON, timezone: 'Europe/Madrid', elevation: 29 });
  assert.deepEqual(Object.keys(body.hourly), ['time', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m', 'weather_code']);
  assert.deepEqual(body.river.daily.river_discharge, [5.2, 460]);
  assert.deepEqual(body.sea.hourly.sea_level_height_msl, [-0.4, -0.5]);
  assert.equal(body.status, 'live');
  assert.equal(body.fetchedAt, new Date(T0).toISOString());
  assert.match(body.attribution, /Open-Meteo/);
  const forecastUrl = calls.find((u) => u.host === 'api.open-meteo.com');
  assert.equal(forecastUrl.searchParams.get('hourly'), 'precipitation,wind_speed_10m,wind_gusts_10m,weather_code');
  assert.equal(forecastUrl.searchParams.get('past_days'), '1');
  assert.equal(forecastUrl.searchParams.get('timezone'), 'auto');
  assert.equal(calls.find((u) => u.host === 'flood-api.open-meteo.com').searchParams.get('daily'), 'river_discharge,river_discharge_max');
});

test('one failing source does not fail the others', async () => {
  const { impl } = fakeFetch({
    ...healthy(),
    'flood-api.open-meteo.com': () => json('<html>Bad gateway</html>', 502),
    'marine-api.open-meteo.com': () => { throw new TypeError('fetch failed'); },
  });
  const service = createWeatherService({ fetchImpl: impl, ...(await dirs()), now: () => T0 });
  const body = await service.forecast(LAT, LON);
  assert.equal(body.status, 'live');
  assert.equal(body.river, null);
  assert.equal(body.sea, null);
  assert.deepEqual(body.sources, { main: 'live', river: 'unavailable', sea: 'unavailable' });
  assert.equal(body.hourly.time.length, 4);
});

test('inland points get sea: null, and that answer is cached', async () => {
  const { impl, calls } = fakeFetch({ ...healthy(), 'marine-api.open-meteo.com': () => json(inlandSeaBody()) });
  const service = createWeatherService({ fetchImpl: impl, ...(await dirs()), now: () => T0 });
  assert.equal((await service.forecast(LAT, LON)).sea, null);
  const again = await service.forecast(LAT, LON);
  assert.equal(again.sea, null);
  assert.equal(again.status, 'cached');
  assert.equal(calls.length, 3, 'second call is served from the disk cache');
});

test('malformed upstream JSON never crashes: stale cache is served with its original fetchedAt', async () => {
  const where = await dirs();
  let clock = T0;
  let broken = false;
  const routes = healthy();
  const { impl } = fakeFetch(Object.fromEntries(Object.entries(routes).map(([host, ok]) => [host, () => (broken ? json('{"hourly": [tru') : ok())])));
  const service = createWeatherService({ fetchImpl: impl, ...where, now: () => clock });
  await service.forecast(LAT, LON);
  broken = true;
  clock = T0 + 31 * 60_000; // forecast TTL (30 min) has passed
  const body = await service.forecast(LAT, LON);
  assert.equal(body.status, 'stale');
  assert.equal(body.fetchedAt, new Date(T0).toISOString());
  assert.equal(body.sources.main, 'stale');
  assert.deepEqual(body.river.daily.river_discharge, [5.2, 460], 'river (3 h TTL) still fresh in cache');
  assert.equal(body.sources.river, 'cached');
});

test('a corrupt cache file is treated as a miss', async () => {
  const where = await dirs();
  const { impl } = fakeFetch(healthy());
  const service = createWeatherService({ fetchImpl: impl, ...where, now: () => T0 });
  await service.forecast(LAT, LON);
  for (const name of await readdir(where.cacheDir)) await writeFile(path.join(where.cacheDir, name), '{not json');
  assert.equal((await service.forecast(LAT, LON)).status, 'live');
});

async function writeFixture(fixturesDir, name, fixture, body) {
  await writeFile(path.join(fixturesDir, name), JSON.stringify({ fixture: { createdAt: '2026-11-19T00:00:00Z', place: 'test', ...fixture }, body }));
}

test('falls back to a fixture within 1.5 km when live fails and nothing is cached, else 502', async () => {
  const where = await dirs();
  await writeFixture(where.fixturesDir, 'test-weather.json', { kind: 'weather', lat: LAT, lon: LON }, {
    place: { lat: LAT, lon: LON, timezone: 'Europe/Madrid', elevation: 29 },
    hourly: parseHourlyWeather(forecastBody()).hourly, river: null, sea: null,
    fetchedAt: '2026-11-19T00:00:00.000Z', status: 'live', attribution: 'x',
  });
  const { impl } = fakeFetch({}); // every request fails
  const service = createWeatherService({ fetchImpl: impl, ...where, now: () => T0 });
  const near = await service.forecast(LAT + 0.009, LON); // about 1 km north
  assert.equal(near.status, 'fixture');
  assert.equal(near.fetchedAt, '2026-11-19T00:00:00.000Z');
  await assert.rejects(service.forecast(LAT + 0.02, LON), (error) => error.status === 502 && /unavailable/.test(error.message));
});

test('event uses the archive, matches fixtures on dates too, and rejects bad ranges with 400', async () => {
  const where = await dirs();
  const { impl, calls } = fakeFetch(healthy());
  const service = createWeatherService({ fetchImpl: impl, ...where, now: () => T0 });
  const body = await service.event(LAT, LON, '2024-10-29', '2024-10-30');
  assert.equal(body.status, 'live');
  assert.equal(body.sea, null);
  assert.deepEqual(body.event, { start: '2024-10-29', end: '2024-10-30' });
  const archive = calls.find((u) => u.host === 'archive-api.open-meteo.com');
  assert.equal(archive.searchParams.get('start_date'), '2024-10-29');
  assert.equal(archive.searchParams.get('end_date'), '2024-10-30');
  assert.equal(calls.find((u) => u.host === 'flood-api.open-meteo.com').searchParams.get('start_date'), '2024-10-29');
  assert.equal((await service.event(LAT, LON, '2024-10-29', '2024-10-30')).status, 'cached');

  await assert.rejects(service.event(LAT, LON, '2024-10-01', '2024-10-30'), (error) => error.status === 400);

  const offline = await dirs();
  await writeFixture(offline.fixturesDir, 'test-event.json', { kind: 'event', lat: LAT, lon: LON, start: '2024-10-27', end: '2024-10-31' }, { ...body, event: { start: '2024-10-27', end: '2024-10-31' } });
  const down = createWeatherService({ fetchImpl: fakeFetch({}).impl, ...offline, now: () => T0 });
  assert.equal((await down.event(LAT, LON, '2024-10-27', '2024-10-31')).status, 'fixture');
  await assert.rejects(down.event(LAT, LON, '2024-10-26', '2024-10-31'), (error) => error.status === 502);
});

test('old events whose river data is refused still return rain (river: null)', async () => {
  const { impl } = fakeFetch({ ...healthy(), 'flood-api.open-meteo.com': () => json({ error: true, reason: 'Parameter start_date is out of allowed range' }, 400) });
  const service = createWeatherService({ fetchImpl: impl, ...(await dirs()), now: () => T0 });
  const body = await service.event(LAT, LON, '1960-01-01', '1960-01-03');
  assert.equal(body.river, null);
  assert.equal(body.sources.river, 'live');
});

test('concurrent identical requests share one upstream call per source', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const routes = healthy();
  const { impl, calls } = fakeFetch(Object.fromEntries(Object.entries(routes).map(([host, ok]) => [host, async () => { await gate; return ok(); }])));
  const service = createWeatherService({ fetchImpl: impl, ...(await dirs()), now: () => T0 });
  const both = Promise.all([service.forecast(LAT, LON), service.forecast(LAT, LON)]);
  setTimeout(release, 20);
  const [a, b] = await both;
  assert.equal(a.status, 'live');
  assert.equal(b.status, 'live');
  assert.equal(calls.length, 3);
});

test('weather routes validate input and answer 502 with an error when nothing is available', async () => {
  const where = await dirs();
  const server = createAppServer({}, {
    floodDepth: { depthsAt: async () => ({}) },
    dataFetchImpl: fakeFetch({}).impl,
    ...where,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const query of ['', '?lat=1', '?lat=abc&lon=1', '?lat=91&lon=0', '?lat=%20&lon=1']) {
      const response = await fetch(`${base}/api/weather${query}`);
      assert.equal(response.status, 400, query);
      assert.match((await response.json()).error, /lat and lon/);
    }
    for (const query of ['?lat=1&lon=1', '?lat=1&lon=1&start=2024-10-27', '?lat=1&lon=1&start=2024-10-27&end=2024-12-27', '?lat=1&lon=1&start=2024-02-30&end=2024-03-01']) {
      const response = await fetch(`${base}/api/weather/event${query}`);
      assert.equal(response.status, 400, query);
      assert.ok((await response.json()).error);
    }
    const down = await fetch(`${base}/api/weather?lat=10&lon=10`);
    assert.equal(down.status, 502);
    assert.match((await down.json()).error, /try again/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
