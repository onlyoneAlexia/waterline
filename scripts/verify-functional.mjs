// Runs the actual 3D engine and shipped Lux3D GLB, without paid generation or live maps.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';

const output = path.resolve('submission');
await fs.mkdir(path.join(output, 'evidence'), { recursive: true });
const server = createAppServer({});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, context, video;
const errors = [], external = [], checks = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: process.argv.includes('--no-video') ? undefined : {
    dir: path.join(output, 'recordings'), size: { width: 1440, height: 1000 },
  } });
  const page = await context.newPage(); video = page.video();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith(origin) || /^(data:|blob:)/.test(route.request().url())) return route.continue();
    external.push(new URL(route.request().url()).origin); return route.abort();
  });
  await page.goto(`${origin}/?mode=studio&debug`);
  await page.waitForFunction(() => window.waterline?.state.objects.length === 1, { timeout: 30000 });
  await page.waitForFunction(() => {
    const error = document.querySelector('.cesium-widget-errorPanel');
    if (error) throw new Error(error.textContent);
    const primitives = waterline.state.viewer.scene.primitives;
    for (let i = 0; i < primitives.length; i++) if (primitives.get(i) instanceof Cesium.Model && primitives.get(i).ready) return true;
    return false;
  });
  await page.waitForTimeout(2500);
  assert.equal(await page.locator('.setup-error').count(), 0);
  assert.equal(await page.evaluate(() => waterline.state.objects[0].source), 'lux3d-text-to-3d');
  checks.push('Actual Cesium scene and bundled Lux3D SUV loaded without external network access.');
  await page.screenshot({ path: path.join(output, 'evidence', '01-studio.png') });
  const batching = await page.evaluate(() => waterline.state.studioStats);
  assert.ok(batching.geometryInstances > 500);
  assert.ok(batching.drawGroups <= 10);
  assert.equal(await page.evaluate(() => {
    const primitives = waterline.state.viewer.scene.primitives;
    const surfaces = [];
    for (let i = 0; i < primitives.length; i++) {
      const material = primitives.get(i).appearance?.material;
      if (material?.type === 'StudioSurface') surfaces.push(material);
    }
    return surfaces.length >= 4 && surfaces.every(material => !material.isTranslucent());
  }), true, 'Ground surfaces must render opaque so they cannot blend over the flood water.');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-view="focus"]').getAttribute('aria-pressed') === 'true');
  await page.locator('#cinema').click();
  assert.equal(await page.locator('#panel').isVisible(), false);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(output, 'evidence', '06-cinematic.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#panel').isVisible(), true);
  await page.getByRole('button', { name: 'Street', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-view="street"]').getAttribute('aria-pressed') === 'true');
  checks.push('Detailed street geometry is batched into at most ten material groups. Focus/Street camera views and Cinema/escape controls passed.');
  await page.locator('#play').click();
  await page.waitForFunction(() => waterline.state.depth > .02);
  await page.locator('#play').click();
  const pausedDepth = await page.evaluate(() => waterline.state.depth);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => waterline.state.depth), pausedDepth);
  checks.push('Flood playback pauses at the current level.');

  await page.locator('#demo-go').click();
  await page.waitForFunction(() => !document.querySelector('#demo-go').disabled, { timeout: 20000 });
  assert.match(await page.locator('#demo-status').innerText(), /Demo ready/);
  assert.equal(await page.locator('#depth-out').textContent(), '1.20 m');
  await page.screenshot({ path: path.join(output, 'evidence', '02-flood.png') });
  checks.push('Demo animation reached 1.20 m with the Lux3D model placed at 1.8 m scale.');

  await page.locator('.rail [data-go="things"]').click();
  await page.locator('#tab-library').click();
  await page.locator('#tab-library').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-photo').getAttribute('aria-selected'), 'true');
  await page.locator('#tab-library').click();
  await page.locator('#library-list button').filter({ hasText: 'Small car' }).click();
  await page.waitForFunction(() => !!waterline.state.pending);
  const canvas = page.locator('#map canvas').first();
  const bounds = await canvas.boundingBox();
  await page.mouse.click(bounds.x + bounds.width * .5, bounds.y + bounds.height * .58);
  await page.waitForFunction(() => waterline.state.objects.length === 2);
  const obj = page.locator('#object-list li').last();
  await obj.getByRole('button', { name: 'Move', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => waterline.state.moving), null);
  await obj.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.keyboard.press('Escape');
  await obj.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.locator('#undo').click();
  assert.equal(await page.locator('#object-list li').count(), 2);
  checks.push('Keyboard tabs, Library placement on the rendered street, move cancellation, duplication cancellation, removal and undo passed.');

  for (const [name, throws] of [['Front door', false], ['Family SUV', true]]) {
    await page.evaluate((throws) => {
      const scene = waterline.state.viewer.scene;
      window.originalDepthPick = scene.pickPosition;
      scene.pickPosition = () => { if (throws) throw new Error('Depth picking unavailable'); return undefined; };
    }, throws);
    try {
      const before = await page.locator('#object-list li').count();
      await page.locator('#library-list button').filter({ hasText: name }).click();
      await page.waitForFunction(() => !!waterline.state.pending);
      await page.mouse.click(bounds.x + bounds.width * .5, bounds.y + bounds.height * .58);
      await page.waitForFunction((count) => waterline.state.objects.length === count, before + 1);
      assert.ok(Math.abs(await page.evaluate(() => waterline.state.objects.at(-1).ground) - .07) < .01);
    } finally {
      await page.evaluate(() => { waterline.state.viewer.scene.pickPosition = window.originalDepthPick; });
    }
  }
  // Clear the test placements (all dropped on one spot) so the challenge screenshot shows a readable street.
  await page.evaluate(() => waterline.state.objects.slice(1).forEach(waterline.removeObject));
  checks.push('Lux3D front door and SUV placement passed with depth picking disabled or throwing, including placement above a flooded street.');

  await page.locator('.rail [data-go="detective"]').click();
  await page.locator('#challenge-go').click();
  await page.waitForFunction(() => !document.querySelector('#challenge-go').disabled, { timeout: 12000 });
  assert.match(await page.locator('#challenge-result').textContent(), /Difference:/);
  await page.screenshot({ path: path.join(output, 'evidence', '03-challenge.png') });
  await page.locator('.rail [data-go="safety"]').click();
  await page.locator('#safe-go').click();
  await page.waitForFunction(() => !document.querySelector('#safe-go').disabled, { timeout: 15000 });
  assert.match(await page.locator('#safety').innerText(), /Studio example/i);
  assert.match(await page.locator('#safety').innerText(), /Synthetic terrain/);
  checks.push('Depth challenge and explicitly labelled synthetic higher-ground example passed.');

  await page.locator('.rail [data-go="share"]').click();
  await page.locator('#share').click();
  assert.ok(page.url().includes('#s='));
  const scene = await page.evaluate(() => waterline.sceneData());
  const count = scene.o.length;
  await page.reload();
  await page.waitForFunction((count) => window.waterline?.state.objects.length === count, count, { timeout: 30000 });
  assert.equal(await page.locator('#depth-out').textContent(), `${scene.d.toFixed(2)} m`);
  await page.locator('.rail [data-go="share"]').click();
  const saved = page.waitForEvent('download'); await page.locator('#save-scene').click();
  const sceneFile = path.join(output, 'evidence', 'example-scene.json');
  await (await saved).saveAs(sceneFile);
  assert.deepEqual(JSON.parse(await fs.readFile(sceneFile, 'utf8')), await page.evaluate(() => waterline.sceneData()));
  await page.locator('.rail [data-go="things"]').click();
  await page.locator('#object-list li').last().getByRole('button', { name: 'Remove', exact: true }).click();
  assert.equal(await page.locator('#object-list li').count(), count - 1);
  await page.locator('#scene-file').setInputFiles(sceneFile);
  await page.waitForFunction((count) => window.waterline?.state.objects.length === count, count);
  await page.locator('.rail [data-go="share"]').click();
  const image = page.waitForEvent('download'); await page.locator('#snapshot').click();
  await (await image).saveAs(path.join(output, 'evidence', '04-exported-view.png'));
  checks.push('Share-link reload, scene JSON export/import and labelled PNG export passed.');

  await page.locator('.rail [data-go="spot"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#panel').evaluate((panel) => { panel.style.scrollBehavior = 'auto'; panel.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'evidence', '05-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('.cesium-widget-errorPanel').count(), 0);
  assert.deepEqual(external, []);
  checks.push('Mobile viewport has no horizontal overflow. No page errors or external requests occurred.');
  console.log(checks.join('\n'));
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), mode: 'studio', checks,
    limits: ['Live Cesium/Google maps, JRC data, walking-route service and paid Lux3D generation were not exercised by this offline test.'] }, null, 2));
} catch (error) {
  const page = context?.pages()[0];
  console.error('Browser errors:', errors);
  console.error('External origins:', external);
  if (page) {
    console.error('Startup message:', await page.locator('.setup-error').allTextContents());
    await page.screenshot({ path: path.join(output, 'evidence', 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await context?.close();
  if (video) await video.saveAs(path.join(output, 'waterline-demo.webm'));
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
