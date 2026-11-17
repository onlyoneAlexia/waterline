import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScene } from '../public/scene.js';
import { studioHeight, STUDIO } from '../public/studio.js';

const scene = () => ({ v: 1, m: 'studio', p: [0, 0, 0], d: 1.2, c: [0, 0, 100, 0, -30], o: [
  { u: '/models/library/family-suv.glb', n: 'SUV', x: 0, y: 0, g: 0, h: 1.8, r: 0 },
] });
test('saved scenes preserve real dimensions and mode', () => {
  assert.equal(validateScene(JSON.parse(JSON.stringify(scene()))).o[0].h, 1.8);
});
test('untrusted scenes reject external assets, traversal, excessive objects and invalid coordinates', () => {
  for (const url of ['https://example.com/car.glb', '/models/library/../../secret.glb', '/models/library/%2e%2e.glb']) {
    const data = scene(); data.o[0].u = url;
    assert.throws(() => validateScene(data));
  }
  for (const change of [d => { d.o = Array(41).fill(d.o[0]); }, d => { d.p[1] = 91; }, d => { d.o[0].h = Infinity; }, d => { d.d = -1; }]) {
    const data = scene(); change(data); assert.throws(() => validateScene(data));
  }
  assert.throws(() => validateScene(null));
});
test('studio terrain matches its rendered flat street and rising east hillside', () => {
  const lon = STUDIO.lon * Math.PI / 180, lat = STUDIO.lat * Math.PI / 180;
  assert.equal(studioHeight(lon, lat), 0);
  const east100 = lon + 100 / (6_378_137 * Math.cos(lat));
  assert.ok(Math.abs(studioHeight(east100, lat) - 4.96) < 1e-6);
});
