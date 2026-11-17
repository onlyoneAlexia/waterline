import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function functionSource(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}

function harness(heights = [10, 10]) {
  const messages = [];
  const button = { disabled: false };
  const state = { pin: { lon: 0, lat: 0 }, depth: 1, safetySearch: 0, safety: null };
  let samples = 0;
  const context = vm.createContext({
    state, MAX_DEPTH_M: 3, SAFETY_MARGIN_M: 1, WALK_SPEED_MPS: 1,
    $: (selector) => selector === '#safe-go' ? button : {
      setAttribute() {},
      style: { setProperty() {} },
      replaceChildren: (...parts) => messages.push(parts),
    },
    document: { querySelectorAll: () => [] },
    clearSafety: () => { state.safetySearch++; state.safety = null; },
    sampleHeights: async (points) => {
      if (samples++ === 0) points[0].height = 10;
      else points.forEach((point, i) => { point.height = heights[i]; });
      return points;
    },
    searchHigherGround: async () => ({ longitude: 1, latitude: 1, height: 15 }),
    fetchRoute: async () => ({ coordinates: [[0, 0], [1, 1]], distance: 100, duration: 100 }),
    everyNth: (points) => points,
    Cesium: {
      Cartographic: { fromRadians: () => ({}), fromDegrees: () => ({}) },
      EllipsoidGeodesic: class { surfaceDistance = 100; },
    },
    drawSafety() {}, adviceList() {}, updateWater() {}, renderFacts() {}, renderImpact() {},
    el: (tag, style, text) => text, deg: (value) => value,
  });
  vm.runInContext(`async ${functionSource('findHigherGround', 'adviceList')}
    ${functionSource('setDepth', 'stopPlaying')}`, context);
  return { context, state, messages, button };
}

test('depth change cancels an in-progress higher-ground search', async () => {
  const { context, state, messages, button } = harness();
  let finishSearch;
  const searching = new Promise((resolve) => { finishSearch = resolve; });
  context.searchHigherGround = () => searching;
  const result = context.findHigherGround();
  await Promise.resolve();
  const previousId = state.safetySearch;
  context.setDepth(2);
  assert.ok(state.safetySearch > previousId);
  finishSearch({ longitude: 1, latitude: 1, height: 15 });
  await result;
  assert.equal(messages.length, 0, 'cancelled search must not display a result');
  assert.equal(button.disabled, false);
});

for (const heights of [[undefined, undefined], [10, undefined]]) {
  test(`missing route heights report unknown depth: ${JSON.stringify(heights)}`, async () => {
    const { context, messages } = harness(heights);
    await context.findHigherGround();
    const text = messages.flat().join(' ');
    assert.match(text, /flood depth is unknown/);
    assert.doesNotMatch(text, /the route stays dry/);
  });
}

test('complete dry terrain samples retain the dry-route result', async () => {
  const { context, messages } = harness([12, 12]);
  await context.findHigherGround();
  assert.match(messages.flat().join(' '), /the route stays dry/);
});
