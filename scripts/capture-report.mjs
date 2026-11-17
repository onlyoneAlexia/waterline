// Capture the images used by the project report into submission/report/.
//
//   node --env-file-if-exists=.env scripts/capture-report.mjs
//
// Part 1 renders Lux3D models (Library, test results and earlier iterations) with <model-viewer>.
// Part 2 drives the real app in Microsoft Edge on the local GPU: homepage, Kerrville (live Google
// 3D Tiles, JRC data, walking route), Paiporta, Studio and a phone layout. No new Lux3D generation.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';

const ROOT = path.resolve('.');
const OUT = path.join(ROOT, 'submission', 'report');
await fs.mkdir(OUT, { recursive: true });
const GPU = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: GPU });

// ---------- part 1: model renders ----------
const RENDERS = [
  ['asset-picnic-table', 'public/models/generated/7450850.glb', '35deg 70deg auto'],
  ['asset-door-v1', 'submission/report/front-door-v1-photo.glb', '20deg 82deg auto'],
  ['asset-door-v1-back', 'submission/report/front-door-v1-photo.glb', '200deg 82deg auto'],
  ['asset-door-v2', 'public/models/library/front-door.glb', '20deg 82deg auto'],
  ['asset-small-car', 'public/models/library/small-car.glb', '330deg 74deg auto'],
  ['asset-pickup', 'public/models/generated/8080327.glb', '35deg 74deg auto'],
  ['asset-camera', 'public/models/generated/8080345.glb', '30deg 75deg auto'],
  ['asset-suv', 'public/models/library/family-suv.glb', '35deg 76deg auto'],
];
const viewer = (src, orbit) => `<!doctype html><meta charset=utf-8>
<script type=module src="https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
<style>html,body{margin:0;background:transparent}model-viewer{width:640px;height:480px;--poster-color:transparent}model-viewer::part(default-progress-bar){display:none}</style>
<model-viewer src="${src}" camera-orbit="${orbit}" field-of-view="26deg" exposure="1.1" shadow-intensity="1.1" environment-image="neutral" interaction-prompt="none"></model-viewer>`;
const files = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/view') { res.setHeader('content-type', 'text/html'); return res.end(viewer(url.searchParams.get('src'), url.searchParams.get('orbit'))); }
  const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT) || !file.endsWith('.glb')) { res.statusCode = 404; return res.end(); }
  try { res.setHeader('content-type', 'model/gltf-binary'); res.end(await fs.readFile(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => files.listen(0, '127.0.0.1', resolve));
for (const [name, src, orbit] of RENDERS) {
  try { await fs.access(src); } catch { console.log(`skip ${name}: ${src} missing`); continue; }
  const tab = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await tab.goto(`http://127.0.0.1:${files.address().port}/view?src=/${encodeURIComponent(src).replaceAll('%2F', '/')}&orbit=${encodeURIComponent(orbit)}`);
  await tab.waitForFunction(() => document.querySelector('model-viewer')?.loaded, null, { timeout: 120000 });
  await tab.waitForTimeout(800);
  await tab.locator('model-viewer').screenshot({ path: path.join(OUT, `${name}.png`), omitBackground: true });
  await tab.close();
  console.log('render', name);
}
files.close();

// ---------- part 2: the real app ----------
const app = createAppServer();
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.address().port}`;
// JPEG keeps the report PDF small; model renders (transparent) stay PNG.
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 88 });
const settle = async (page, ms = 3000) => {
  await page.evaluate(async () => {
    const s = window.waterline?.state; if (!s?.viewer) return;
    const tiles = [...Array(s.viewer.scene.primitives.length)].map((_, i) => s.viewer.scene.primitives.get(i)).find((p) => p instanceof Cesium.Cesium3DTileset);
    const t0 = Date.now(); while (tiles && !tiles.tilesLoaded && Date.now() - t0 < 25000) await new Promise((r) => setTimeout(r, 300));
  }).catch(() => {});
  await page.waitForTimeout(ms);
};
const go = (page, space) => page.locator(`.rail [data-go="${space}"]`).click();

try {
  // Homepage
  let page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`${origin}/`);
  await page.waitForTimeout(6500);
  await shot(page, 'app-home');
  await page.locator('#home').evaluate((el) => { el.scrollTop = el.querySelector('.home-steps').offsetTop - 10; });
  await page.waitForTimeout(700);
  await shot(page, 'app-home-steps');
  await page.close();

  // Kerrville demo, real street
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${origin}/?mode=street&debug`);
  await page.waitForFunction(() => /Demo ready|could not/.test(document.querySelector('#demo-status')?.textContent ?? ''), null, { timeout: 120000 });
  await settle(page, 4000);
  await shot(page, 'app-kerrville');
  await go(page, 'things'); await page.waitForTimeout(800); await shot(page, 'app-things');
  await go(page, 'water'); await page.waitForTimeout(800); await shot(page, 'app-water');
  await go(page, 'risk');
  // The river-flood lookup is a live request: wait for its results before the screenshot.
  await page.waitForFunction(() => !!document.querySelector('#risk:not([hidden]) li'), null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(800); await shot(page, 'app-risk');

  // A typed object (the real "a red pickup truck" Lux3D result) parked beside the SUV
  await go(page, 'things');
  await page.locator('#tab-text').click();
  await page.locator('[data-example="a red pickup truck"]').click();
  await page.evaluate(async () => {
    const w = window.waterline, s = w.state, pin = s.pin, R = 6378137, h = 45 * Math.PI / 180;
    const right = -8.5, e = right * Math.cos(h), n = -right * Math.sin(h);
    const lon = pin.lon + e / (R * Math.cos(pin.lat)), lat = pin.lat + n / R;
    const ground = await w.groundHeightAt(lon * 180 / Math.PI, lat * 180 / Math.PI).catch(() => pin.height);
    const t = await w.loadTemplate({ name: 'a red pickup truck', url: '/models/generated/8080327.glb' });
    w.placeObject(t, { longitude: lon, latitude: lat, height: Math.abs(ground - pin.height) < 1.5 ? ground : pin.height }, { heading: 135 });
    const c = Cesium.Cartesian3.fromRadians(pin.lon + (e / 2) / (R * Math.cos(pin.lat)), pin.lat + (n / 2) / R, pin.height + 1);
    s.viewer.camera.lookAt(c, new Cesium.HeadingPitchRange(h, -0.24, 27));
    s.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  });
  await settle(page, 3000);
  await shot(page, 'app-describe');

  // Higher ground: live terrain search + walking route
  await go(page, 'safety');
  await page.locator('#safe-go').click();
  await page.waitForFunction(() => !document.querySelector('#safe-go').disabled, null, { timeout: 90000 });
  await settle(page, 4000);
  await shot(page, 'app-escape');

  // Paiporta
  await go(page, 'spot');
  await page.locator('#scenes button').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#scene-story')?.textContent.startsWith('Carrer'), null, { timeout: 120000 });
  await settle(page, 9000);
  await shot(page, 'app-paiporta');
  await page.close();

  // Studio: every Library object side by side at 0.9 m
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`${origin}/?mode=studio&debug`);
  // Wait for the Studio's own SUV, so clearing the street really clears it.
  await page.waitForFunction(() => window.waterline?.state?.pin && waterline.state.objects.length === 1, null, { timeout: 60000 });
  await page.evaluate(async () => {
    const w = window.waterline, s = w.state, pin = s.pin, R = 6378137;
    s.objects.slice().forEach(w.removeObject);
    const row = [['family-suv', 0], ['small-car', 3.4], ['scooter', 6.2], ['adult-person', 8.0], ['wheelie-bin', 9.6], ['front-door', 11.4]];
    for (const [id, x] of row) {
      const t = await w.loadTemplate(s.library.find((e) => e.id === id));
      w.placeObject(t, { longitude: pin.lon + (x - 6) / (R * Math.cos(pin.lat)), latitude: pin.lat + 3 / R, height: pin.height }, { heading: 0 });
    }
    w.setDepth(0.9);
    const c = Cesium.Cartesian3.fromRadians(pin.lon, pin.lat + 3 / R, pin.height + 0.9);
    s.viewer.camera.lookAt(c, new Cesium.HeadingPitchRange(0, -0.2, 15));
    s.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  });
  await page.waitForTimeout(4000);
  await shot(page, 'app-studio-lineup');
  await page.close();

  // Phone
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/?mode=studio&debug`);
  await page.waitForFunction(() => window.waterline?.state?.pin && waterline.state.objects.length, null, { timeout: 60000 });
  await page.evaluate(() => window.waterline.setDepth(1.0));
  await page.locator('.rail [data-go="water"]').click();
  await page.waitForTimeout(2500);
  await shot(page, 'app-phone');
  await page.close();
} finally {
  await browser.close();
  app.close();
}
console.log('Report images written to', path.relative(ROOT, OUT));
