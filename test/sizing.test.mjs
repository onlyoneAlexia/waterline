import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Pull the sizing helpers straight out of the app so the test checks the shipped code.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const sizing = source.slice(source.indexOf('const HEIGHT_HINTS'), source.indexOf('// Chance of a flood'));
const context = vm.createContext({});
vm.runInContext(`${sizing}; this.heightFromWords = heightFromWords; this.looksMetric = looksMetric;`, context);
const { heightFromWords, looksMetric } = context;

test('typed descriptions map to typical real heights', () => {
  assert.equal(heightFromWords('a red pickup truck'), 1.8);
  assert.equal(heightFromWords('a big lorry'), 3);
  assert.equal(heightFromWords('My scooter'), 1.2);
  assert.equal(heightFromWords('a folding wheelchair'), 0.95);
  assert.equal(heightFromWords('our front door'), 2.1);
  assert.equal(heightFromWords('asdfghjkl'), null);
  assert.equal(heightFromWords('cardboard box'), null, 'a word that only contains "car" is not a car');
});

test("Lux3D's own size is trusted only when it looks like real metres", () => {
  // Real results from 2026-11-16: "a red pickup truck" came back in a normalised ~12-unit box,
  // "asdfghjkl" came back as a camera in plausible metres.
  assert.equal(looksMetric({ size: [5.91, 4.84, 11.97] }), false);
  assert.equal(looksMetric({ size: [0.21, 0.17, 0.19] }), true);
  assert.equal(looksMetric({ size: [0.59, 1.8, 0.34] }), true, 'an adult person in metres');
  assert.equal(looksMetric({ size: [10, 7, 5] }), false, 'the classic 10-unit box');
});
