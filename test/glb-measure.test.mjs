import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureGlb, measureGltfJson } from '../public/glb-measure.js';

const close = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${actual} vs ${expected}`));

function makeGlb(json) {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(20 + jsonBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  new Uint8Array(buffer, 20).set(jsonBytes);
  return buffer;
}

const mesh = { meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };

test('applies child translation then parent scale', () => {
  const gltf = {
    ...mesh,
    accessors: [{ min: [-1, 0, -1], max: [1, 2, 1] }],
    nodes: [{ children: [1], scale: [2, 2, 2] }, { mesh: 0, translation: [0, 1, 0] }],
    scenes: [{ nodes: [0] }],
  };
  const { min, max, size } = measureGlb(makeGlb(gltf));
  close(min, [-2, 2, -2]);
  close(max, [2, 6, 2]);
  close(size, [4, 4, 4]);
});

test('applies rotations (Z-up model rotated to Y-up)', () => {
  const s = Math.SQRT1_2; // -90 degrees about X maps +Z to +Y
  const gltf = {
    ...mesh,
    accessors: [{ min: [0, 0, 0], max: [1, 1, 3] }],
    nodes: [{ mesh: 0, rotation: [-s, 0, 0, s] }],
  };
  const { size, min } = measureGltfJson(gltf);
  close(size, [1, 3, 1]);
  assert.ok(Math.abs(min[1]) < 1e-9);
});

test('rejects files that are not GLB', () => {
  assert.throws(() => measureGlb(new ArrayBuffer(32)), /not a GLB/);
});
