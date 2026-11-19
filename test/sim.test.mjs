import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gridPoints, cellAt, floodOnset, lowestCells, depthsAt, volumeAt, levelForVolume, floodStats,
  patchHeights, fitPlane, detrend, openWaterMask, rainStorage, responseShape, designStorm, normalise, sampleSeries, bandOf, surgeShape, riverShape,
} from '../public/sim.js';

// A 5×5 valley: a channel down the middle column (height 0), banks rising to 4 m,
// and a closed pit at the top-left corner (height -1) walled off by a 3 m ridge.
const n = 5;
const heights = Float64Array.from([
  2, 1, 0, 1, 2,
  3, 1, 0, 1, 3,
  3, 2, 0, 2, 3,
  3, 3, 0, 3, 3,
  -1, 3, 0, 3, 4,
]);

test('grid points round-trip to their own cells', () => {
  const grid = gridPoints(-0.4181, 39.428, 1000, 10);
  assert.equal(grid.points.length, 100);
  for (const k of [0, 9, 45, 99]) assert.equal(cellAt(grid, grid.points[k].lon, grid.points[k].lat), k);
  assert.equal(cellAt(grid, -0.3, 39.428), -1);
});

test('water spreads from the channel only as far as the level allows', () => {
  const onset = floodOnset(heights, n, [2, 7, 12, 17, 22]);
  const d = depthsAt(heights, onset, 1.5);
  assert.ok(d[12] > 1.4, 'channel is deep');
  assert.ok(d[11] === 0, 'a 2 m bank stays dry at 1.5 m');
  assert.ok(d[1] > 0.4, 'a 1 m bank floods');
  // The pit is lower than the water but cut off by a 3 m ridge, so it stays dry until the water tops it.
  assert.equal(d[20], 0);
  assert.equal(onset[20], 3);
  assert.ok(depthsAt(heights, onset, 3.2)[20] > 4);
});

test('volume and level invert each other', () => {
  const onset = floodOnset(heights, n, lowestCells(heights, 0, 1).concat([2]));
  const level = 1.25;
  const volume = volumeAt(heights, onset, level, 100);
  assert.ok(Math.abs(levelForVolume(heights, onset, volume, 100) - level) < 1e-6);
  assert.equal(levelForVolume(heights, onset, 0, 100), Math.min(...[...onset].filter(Number.isFinite)));
});

test('flood stats bin the wet area by depth band', () => {
  const onset = floodOnset(heights, n, [2, 7, 12, 17, 22]);
  const stats = floodStats(heights, onset, 1.5, 100);
  assert.ok(stats.areaM2 > 0);
  assert.equal(stats.bands.reduce((a, b) => a + b, 0), stats.areaM2);
  assert.equal(stats.maxDepth, 1.5);
  assert.equal(bandOf(0.01), -1);
  assert.equal(bandOf(2.5), 4);
});

test('a sloping valley floor is detrended so one level floods it evenly', () => {
  // 10×10 cells of 20 m on a 1% slope to the east, with a 3 m hill in one corner.
  const m = 10;
  const slope = Float64Array.from({ length: m * m }, (_, k) => 50 + 0.01 * ((k % m) * 20) + ((k % m) > 7 && k > 80 ? 3 : 0));
  const plane = fitPlane(slope, m, 20);
  assert.ok(Math.abs(plane.a - 0.01) < 0.002, `east slope ${plane.a}`);
  assert.ok(Math.abs(plane.b) < 0.002, `north slope ${plane.b}`);
  const flat = detrend(slope, m, 20, plane);
  const floor = [...flat].filter((z, k) => !((k % m) > 7 && k > 80));
  assert.ok(Math.max(...floor) - Math.min(...floor) < 0.3, 'the valley floor is level after detrending');
  const steep = fitPlane(Float64Array.from({ length: m * m }, (_, k) => 0.2 * ((k % m) * 20)), m, 20);
  assert.equal(steep.a, 0.02, 'slope is capped');
});

test('a lagoon plateau is recognised as open water, a river channel is not', () => {
  const lagoon = Float64Array.from({ length: 100 }, (_, k) => ((k % 10) < 3 ? 20.1 + (k % 2) * 0.1 : 22 + (k % 10) * 0.3));
  const mask = openWaterMask(lagoon);
  assert.ok(mask);
  assert.equal(mask.reduce((a, b) => a + b, 0), 30);
  assert.equal(openWaterMask(Float64Array.from({ length: 100 }, (_, k) => (k === 5 ? 0 : 10 + k * 0.1))), null);
});

test('missing heights are patched from neighbours', () => {
  // 2×2: cell 1 (top right) touches cell 0 (1 m) and cell 3 (3 m).
  const patched = patchHeights(Float64Array.from([1, NaN, 5, 3]), 2);
  assert.ok(patched.every(Number.isFinite));
  assert.equal(patched[1], 2);
});

test('rain storage only counts rain the drains cannot take', () => {
  const light = rainStorage([3, 3, 3], { areaM2: 1e6 });
  assert.deepEqual(light, [0, 0, 0]);
  const heavy = rainStorage([60, 0], { areaM2: 1e6, outflowPerH: 0.5 });
  assert.ok(heavy[0] > 30_000 && heavy[1] < heavy[0]);
});

test('scenario shapes stay in 0..1 and peak once', () => {
  for (const shape of [responseShape([0, 10, 40, 5, 0, 0, 0, 0]), surgeShape(), riverShape(), normalise([5, 9, 7])]) {
    assert.ok(shape.every((v) => v >= 0 && v <= 1));
    assert.ok(Math.abs(Math.max(...shape) - 1) < 1e-9);
  }
  const storm = designStorm(120, 6);
  assert.ok(Math.abs(storm.reduce((a, b) => a + b, 0) - 120) < 1e-9);
  assert.equal(sampleSeries([0, 10], 0.5), 5);
});
