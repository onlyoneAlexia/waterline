import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGlb, buildGlb, repack } from '../scripts/optimise-library.mjs';
import { measureGlb } from '../public/glb-measure.js';

const arrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

test('GLB repack round-trips a shipped Library model unchanged in shape', async () => {
  const bytes = await readFile(new URL('../public/models/library/wheelie-bin.glb', import.meta.url));
  const { json, bin } = parseGlb(bytes);
  const rebuilt = buildGlb(json, repack(json, bin, new Map()));
  const again = parseGlb(rebuilt);
  assert.equal(again.bin.length % 4, 0);
  assert.equal(again.json.buffers[0].byteLength <= again.bin.length, true);
  assert.deepEqual(measureGlb(arrayBuffer(rebuilt)), measureGlb(arrayBuffer(bytes)));
});

test('repack swaps a bufferView and keeps every view 4-byte aligned', () => {
  const json = { asset: { version: '2.0' }, buffers: [{ byteLength: 12 }], bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 5 }, { buffer: 0, byteOffset: 8, byteLength: 4 }] };
  const bin = Buffer.from([1, 2, 3, 4, 5, 0, 0, 0, 9, 9, 9, 9]);
  const out = repack(json, bin, new Map([[0, Buffer.from([7, 7])]]));
  assert.deepEqual(json.bufferViews.map((v) => [v.byteOffset, v.byteLength]), [[0, 2], [4, 4]]);
  assert.deepEqual([...out], [7, 7, 0, 0, 9, 9, 9, 9]);
  assert.equal(json.buffers[0].byteLength, 8);
});

test('every shipped Library model is optimised and its hash matches library.json', async () => {
  const { createHash } = await import('node:crypto');
  const library = JSON.parse(await readFile(new URL('../public/models/library.json', import.meta.url), 'utf8'));
  for (const entry of library) {
    const bytes = await readFile(new URL(`../public${entry.url}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.generation?.shipped?.sha256, entry.id);
    assert.ok(entry.source.startsWith('lux3d-'), `${entry.id} should be a Lux3D model`);
    assert.ok(bytes.length < 12e6, `${entry.id} is ${bytes.length} bytes`);
  }
});
