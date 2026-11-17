import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '@cesium/engine';
import { pickGround } from '../public/ground-pick.js';
import { pickStudioGround, STUDIO } from '../public/studio.js';

const origin = C.Cartesian3.fromDegrees(STUDIO.lon, STUDIO.lat, 1000);
const ray = new C.Ray(origin, C.Cartesian3.normalize(C.Cartesian3.negate(origin, new C.Cartesian3()), new C.Cartesian3()));
const viewer = (pickPosition, terrain, show = true) => ({
  camera: { getPickRay: () => ray },
  scene: { pickPosition, pickPositionSupported: true, globe: { show, pick: () => terrain } },
});

test('uses terrain when rendered depth is unavailable or throws', async () => {
  const ground = C.Cartesian3.fromDegrees(STUDIO.lon, STUDIO.lat, 123);
  for (const pick of [() => undefined, () => { throw new Error('unsupported'); }]) {
    const result = await pickGround(C, viewer(pick, ground), {});
    assert.ok(Math.abs(result.height - 123) < 1e-5);
  }
});

test('3D-tile fallback samples an actual height instead of assuming sea level', async () => {
  const real = viewer(() => undefined, undefined, false);
  const result = await pickGround(C, real, {}, { sampleGround: async () => 87 });
  assert.equal(result.height, 87);
  assert.equal(await pickGround(C, real, {}, { sampleGround: async () => undefined }), null);
  assert.equal(await pickGround(C, real, {}, { sampleGround: async () => { throw new Error('no tile'); } }), null);
});

test('Studio ray intersection places on the street or hill without a depth buffer', async () => {
  const frame = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(STUDIO.lon, STUDIO.lat));
  for (const east of [0, 80]) {
    const start = C.Matrix4.multiplyByPoint(frame, new C.Cartesian3(east, 0, 50), new C.Cartesian3());
    const down = C.Matrix4.multiplyByPointAsVector(frame, new C.Cartesian3(0, 0, -1), new C.Cartesian3());
    const testRay = new C.Ray(start, down);
    const mock = viewer(() => undefined); mock.camera.getPickRay = () => testRay;
    const result = await pickGround(C, mock, {}, { studioPick: ray => pickStudioGround(C, ray) });
    assert.ok(result);
    assert.ok(Math.abs(result.height - (Math.max(0, east - 38) * .08 + .07)) < .01);
    assert.equal(pickStudioGround(C, new C.Ray(start, C.Cartesian3.negate(down, new C.Cartesian3()))), null);
  }
});
