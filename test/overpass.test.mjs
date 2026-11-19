import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOsmDirect, raceWithDirect, OVERPASS_ENDPOINTS } from '../public/overpass.js';

const LAT = 52.5555;
const LON = 5.9115;
const overpass = {
  elements: [
    { type: 'way', id: 1, center: { lat: 52.5556, lon: 5.9116 }, tags: { building: 'house', 'building:levels': '2' } },
    { type: 'way', id: 2, geometry: [{ lat: 52.555, lon: 5.911 }, { lat: 52.556, lon: 5.912 }], tags: { highway: 'residential', name: 'Oudestraat' } },
    { type: 'node', id: 3, lat: 52.5557, lon: 5.9117, tags: { amenity: 'school', name: 'De Wereld' } },
  ],
};
const wait = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const fail = (ms, message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

test('direct OSM skips a failing Overpass server and returns the server body shape', async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(url);
    assert.equal(init.method, 'POST');
    assert.match(init.body, /^data=/);
    if (url === OVERPASS_ENDPOINTS[0]) return new Response('busy', { status: 502 });
    return new Response(JSON.stringify(overpass), { status: 200 });
  };
  const body = await fetchOsmDirect(LAT, LON, 900, { fetchImpl });
  assert.deepEqual(asked, OVERPASS_ENDPOINTS.slice(0, 2));
  assert.equal(body.status, 'live');
  assert.equal(body.radius, 900);
  assert.equal(body.buildings.length, 1);
  assert.equal(body.roads[0].name, 'Oudestraat');
  assert.equal(body.facilities[0].kind, 'school');
  assert.match(body.attribution, /OpenStreetMap/);
});

test('direct OSM rejects Overpass "remarks" (server-side timeouts) and reports every failure', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }), { status: 200 });
  await assert.rejects(fetchOsmDirect(LAT, LON, 900, { fetchImpl }), /All Overpass servers failed.*remark: runtime error/);
});

test('race: a quick server answer wins and the browser never asks Overpass', async () => {
  let direct = 0;
  const out = await raceWithDirect(() => wait(5, 'server'), async () => { direct += 1; return 'direct'; }, { headStartMs: 50 });
  assert.equal(out, 'server');
  await wait(80);
  assert.equal(direct, 0);
});

test('race: a server failure starts the browser request at once', async () => {
  const started = Date.now();
  const out = await raceWithDirect(() => fail(5, 'Map data unavailable'), () => wait(5, 'direct'), { headStartMs: 10_000 });
  assert.equal(out, 'direct');
  assert.ok(Date.now() - started < 1_000);
});

test('race: a slow server gets company after the head start, and the first answer wins', async () => {
  const out = await raceWithDirect(() => wait(300, 'server'), () => wait(10, 'direct'), { headStartMs: 20 });
  assert.equal(out, 'direct');
});

test('race: if the browser request fails, a slow server can still win', async () => {
  const out = await raceWithDirect(() => wait(100, 'server'), () => fail(5, 'Overpass down'), { headStartMs: 10 });
  assert.equal(out, 'server');
});

test('race: when both fail, the server error is reported', async () => {
  await assert.rejects(
    raceWithDirect(() => fail(5, 'Map data (OpenStreetMap) is unavailable right now'), () => fail(5, 'All Overpass servers failed'), { headStartMs: 10_000 }),
    /Map data \(OpenStreetMap\) is unavailable/,
  );
});
