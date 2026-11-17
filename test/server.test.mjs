import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.mjs';

let server;
let base;
let routeRequests = 0;

const fakeFloodDepth = {
  depthsAt: async (lon, lat) => ({ covered: true, tile: 'TEST', depths: { 100: { here: 1.4, nearby: 2 } }, lon, lat }),
};

const fakeFetch = async (url, init) => {
  routeRequests += 1;
  assert.match(String(url), /^https:\/\/routing\.openstreetmap\.de\/routed-foot\/route\/v1\/foot\//);
  assert.match(init.headers['User-Agent'], /^Waterline/);
  return new Response(JSON.stringify({
    code: 'Ok',
    routes: [{ distance: 420, duration: 330, geometry: { coordinates: [[-99.1, 30.0], [-99.099, 30.003]] } }],
  }), { status: 200 });
};

before(async () => {
  server = createAppServer({ CESIUM_ION_TOKEN: 'test-token' }, { floodDepth: fakeFloodDepth, fetchImpl: fakeFetch });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('config reports the Cesium token and that generation is off without a Lux3D key', async () => {
  const body = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(body, { cesiumToken: 'test-token', generationEnabled: false });
});

test('serves the app page and the library', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Waterline<\/title>/);
  const library = await fetch(`${base}/models/library.json`);
  assert.equal(library.status, 200);
  assert.ok(Array.isArray(await library.json()));
});

test('blocks path traversal and unknown files', async () => {
  for (const path of ['/../package.json', '/%2e%2e/server.mjs', '/nope.js']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, path);
    await res.text();
  }
});

test('serves the local 3D runtime without exposing other dependencies', async () => {
  const runtime = await fetch(`${base}/vendor/cesium/Cesium.js`);
  assert.equal(runtime.status, 200);
  assert.match(runtime.headers.get('content-type'), /javascript/);
  await runtime.arrayBuffer();
  for (const pathname of ['/vendor/cesium/%2e%2e%5c%2e%2e%5cpackage.json', '/node_modules/cesium/package.json']) {
    const response = await fetch(`${base}${pathname}`); assert.equal(response.status, 404); await response.text();
  }
});

test('generation endpoints refuse politely when not configured', async () => {
  const gen = await fetch(`${base}/api/generate`, { method: 'POST', body: '{"prompt":"a car"}' });
  assert.equal(gen.status, 503);
  await gen.text();
  const task = await fetch(`${base}/api/task?id=abc`);
  assert.equal(task.status, 400);
  await task.text();
});

test('flood-depth validates input and returns the model result', async () => {
  const bad = await fetch(`${base}/api/flood-depth?lat=abc&lon=1`);
  assert.equal(bad.status, 400);
  await bad.text();
  const body = await (await fetch(`${base}/api/flood-depth?lat=30.0445&lon=-99.1365`)).json();
  assert.equal(body.depths[100].here, 1.4);
});

test('flood-depth rejects absent or blank coordinates but accepts zero', async () => {
  for (const query of ['', '?lat=1', '?lon=1', '?lat=&lon=1', '?lat=1&lon=', '?lat=%20&lon=1']) {
    const response = await fetch(`${base}/api/flood-depth${query}`);
    assert.equal(response.status, 400, query);
    await response.text();
  }
  const response = await fetch(`${base}/api/flood-depth?lat=0&lon=0`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.lon, 0);
  assert.equal(body.lat, 0);
});

test('route proxies a walking route, caches it, and refuses far-apart points', async () => {
  const first = await (await fetch(`${base}/api/route?from=-99.1,30.0&to=-99.099,30.003`)).json();
  assert.equal(first.distance, 420);
  assert.equal(first.coordinates.length, 2);
  await (await fetch(`${base}/api/route?from=-99.1,30.0&to=-99.099,30.003`)).json();
  assert.equal(routeRequests, 1, 'second identical request should come from the cache');

  const far = await fetch(`${base}/api/route?from=-99.1,30.0&to=-98.0,30.0`);
  assert.equal(far.status, 400);
  await far.text();
  const junk = await fetch(`${base}/api/route?from=x&to=y`);
  assert.equal(junk.status, 400);
  await junk.text();
});
