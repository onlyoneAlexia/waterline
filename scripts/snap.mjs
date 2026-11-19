// Quick visual check: open the running app in Edge at 1600×900, replay a scene, and save screenshots.
//
//   node scripts/snap.mjs [origin] [outDir] [sceneIndex]
//
// Needs the server running (npm start). Uses live map services; makes no Lux3D generations.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://localhost:3000';
const out = path.resolve(process.argv[3] ?? 'test/snap');
const sceneIndex = Number(process.argv[4] ?? 1);
await fs.mkdir(out, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${origin}/?app&debug&nodemo`);
await page.waitForFunction(() => window.waterline?.storm, null, { timeout: 60_000 });
await page.evaluate((i) => { window.__scene = window.waterline.openScene(window.waterline.SCENES[i]); }, sceneIndex);
await page.waitForFunction(() => window.waterline.storm.scenario, null, { timeout: 120_000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(out, '1-replay-street.png') });
await page.evaluate(() => window.__scene);
// Peak of the storm, seen from above (depth colours).
await page.evaluate(() => {
  const { storm } = window.waterline;
  const depth = storm.scenario.depth;
  storm.seek(depth.indexOf(Math.max(...depth)));
  document.querySelector('[data-view="overview"]').click();
});
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const { viewer, pin } = window.waterline.state;
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromRadians(pin.lon, pin.lat - 0.00012, pin.height + 1100), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-62), roll: 0 }, duration: 0 });
});
await page.waitForTimeout(7000);
await page.screenshot({ path: path.join(out, '2-peak-overview.png') });
console.log(JSON.stringify({ errors: errors.slice(0, 8), stats: await page.evaluate(() => { const s = window.waterline.state.areaStats; return s && { ha: Math.round(s.areaM2 / 1e4), max: s.maxDepth.toFixed(1), b: s.buildings, cut: s.roads?.cutKm.toFixed(1) }; }) }));
await browser.close();
