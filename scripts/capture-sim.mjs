// Capture the simulator images for the project report into submission/report/ (sim-*.jpg, asset-*.png).
//
//   node --env-file-if-exists=.env scripts/capture-sim.mjs [--skip-renders] [--only=name,name]
//
// Drives the real app in Microsoft Edge on the local GPU with live map, weather and OpenStreetMap
// services (cached data and fixtures are used when a service is down). No new Lux3D generation.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';

const ROOT = path.resolve('.');
const OUT = path.join(ROOT, 'submission', 'report');
const only = (process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')) ?? null;
const want = (name) => !only || only.includes(name);
await fs.mkdir(OUT, { recursive: true });
const GPU = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: GPU });

// ---------- Lux3D extras, rendered from the files themselves ----------
if (!process.argv.includes('--skip-renders')) {
  const RENDERS = [
    ['asset-suv-flooded', 'public/models/extras/family-suv-flooded.glb', '35deg 76deg auto'],
    ['asset-suv-parts', 'public/models/extras/family-suv-parts.glb', '35deg 70deg auto'],
    ['asset-walker', 'public/models/extras/adult-person-walk.glb', '25deg 80deg auto'],
    ['asset-person', 'public/models/library/adult-person.glb', '25deg 80deg auto'],
  ].filter(([name]) => want(name));
  const viewerHtml = (src, orbit) => `<!doctype html><meta charset=utf-8>
<script type=module src="https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
<style>html,body{margin:0;background:transparent}model-viewer{width:640px;height:480px;--poster-color:transparent}model-viewer::part(default-progress-bar){display:none}</style>
<model-viewer src="${src}" camera-orbit="${orbit}" field-of-view="26deg" exposure="1.1" shadow-intensity="1.1" environment-image="neutral" interaction-prompt="none" autoplay animation-name="animation_1"></model-viewer>`;
  const files = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/view') { res.setHeader('content-type', 'text/html'); return res.end(viewerHtml(url.searchParams.get('src'), url.searchParams.get('orbit'))); }
    const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
    if (!file.startsWith(ROOT) || !file.endsWith('.glb')) { res.statusCode = 404; return res.end(); }
    try { res.setHeader('content-type', 'model/gltf-binary'); res.end(await fs.readFile(file)); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => files.listen(0, '127.0.0.1', resolve));
  for (const [name, src, orbit] of RENDERS) {
    try { await fs.access(src); } catch { console.log(`skip ${name}: ${src} missing`); continue; }
    const tab = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await tab.goto(`http://127.0.0.1:${files.address().port}/view?src=/${src}&orbit=${encodeURIComponent(orbit)}`);
    await tab.waitForFunction(() => document.querySelector('model-viewer')?.loaded, null, { timeout: 120000 });
    await tab.waitForTimeout(1500);
    await tab.locator('model-viewer').screenshot({ path: path.join(OUT, `${name}.png`), omitBackground: true });
    await tab.close();
    console.log('render', name);
  }
  files.close();
}

// ---------- the running app ----------
const app = createAppServer();
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.address().port}`;
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 88 }).then(() => console.log('shot', name));
async function settle(page, ms = 3000) {
  await page.evaluate(async () => {
    const s = window.waterline?.state; if (!s?.viewer) return;
    const tiles = [...Array(s.viewer.scene.primitives.length)].map((_, i) => s.viewer.scene.primitives.get(i)).find((p) => p instanceof Cesium.Cesium3DTileset);
    const t0 = Date.now(); while (tiles && !tiles.tilesLoaded && Date.now() - t0 < 25000) await new Promise((r) => setTimeout(r, 300));
  }).catch(() => {});
  await page.waitForTimeout(ms);
}
const aerial = (page, metres, pitch = -62, back = 0.00012) => page.evaluate(([m, p, b]) => {
  const { viewer, pin } = window.waterline.state;
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromRadians(pin.lon, pin.lat - b, pin.height + m), orientation: { heading: 0, pitch: Cesium.Math.toRadians(p), roll: 0 }, duration: 0 });
}, [metres, pitch, back]);
const peak = (page) => page.evaluate(() => { const s = window.waterline.storm; const d = s.scenario.depth; s.seek(d.indexOf(Math.max(...d))); });
const peakStats = (page) => page.evaluate(() => {
  const s = window.waterline.state.areaStats;
  const scenario = window.waterline.storm.scenario;
  if (!s) return null;
  return {
    scenario: scenario?.title, source: scenario?.source, depthAtSpot: +window.waterline.state.depth.toFixed(2),
    rainMm: scenario ? +scenario.rain.reduce((a, b) => a + b, 0).toFixed(0) : null,
    areaKm2: +(s.areaM2 / 1e6).toFixed(2), maxDepth: +s.maxDepth.toFixed(1),
    buildings: s.buildings ?? null, roadsCutKm: s.roads ? +s.roads.cutKm.toFixed(1) : null, roadsCut: s.roads?.names ?? [],
    services: s.facilities ? { hit: s.facilities.length, total: s.facilitiesTotal, top: s.facilities.slice(0, 4).map((f) => ({ kind: f.kind, name: f.name, depth: +f.depth.toFixed(1) })) } : null,
    osm: window.waterline.area?.info?.osm ?? null,
  };
});
const stats = {};
const errors = [];

async function openApp(viewport = { width: 1600, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/?app&debug&nodemo`);
  await page.waitForFunction(() => window.waterline?.storm, null, { timeout: 90_000 });
  return page;
}

async function replay(page, index) {
  await page.evaluate((i) => { window.__scene = window.waterline.openScene(window.waterline.SCENES[i]); }, index);
  await page.waitForFunction(() => window.waterline.storm.scenario, null, { timeout: 150_000 });
}

try {
  if (want('sim-home')) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(`${origin}/`);
    await page.waitForTimeout(6500);
    await shot(page, 'sim-home');
    await page.close();
  }

  // Paiporta: the recorded storm, the area at its peak, what the water leaves, and the way out.
  {
    const page = await openApp();
    await replay(page, 1);
    await page.waitForTimeout(5200);
    await settle(page, 600);
    if (want('sim-paiporta-street')) await shot(page, 'sim-paiporta-street');
    await page.evaluate(() => window.__scene);
    await peak(page);
    await aerial(page, 1100);
    await settle(page, 4000);
    stats.paiporta = await peakStats(page);
    if (want('sim-paiporta-overview')) await shot(page, 'sim-paiporta-overview');
    await page.evaluate(() => { const s = window.waterline.storm; s.seek(s.scenario.hours.length - 1); document.querySelector('[data-view="focus"]').click(); });
    await settle(page, 4000);
    if (want('sim-aftermath')) await shot(page, 'sim-aftermath');
    // Leave early: the route at the first 40 cm of the rising water.
    await page.evaluate(() => { const s = window.waterline.storm; const i = s.scenario.depth.findIndex((d) => d >= 0.4); s.seek(Math.max(0, i)); });
    await page.evaluate(() => window.waterline.findHigherGround());
    await page.waitForFunction(() => /min on foot|No higher/.test(document.querySelector('#safety')?.textContent ?? ''), null, { timeout: 90_000 }).catch(() => {});
    await page.locator('.rail [data-go="safety"]').click();
    await settle(page, 3500);
    if (want('sim-escape')) await shot(page, 'sim-escape');
    stats.escape = await page.evaluate(() => document.querySelector('#safety .safety-title')?.textContent ?? null);
    await page.evaluate(() => window.waterline.followWalker(true));
    await page.waitForTimeout(5500);
    if (want('sim-walker')) await shot(page, 'sim-walker');
    await page.evaluate(() => window.waterline.followWalker(false));
    await page.locator('.rail [data-go="things"]').click();
    await page.waitForTimeout(800);
    if (want('sim-lux3d')) await shot(page, 'sim-lux3d');
    // Inside: the Aholo World example room with the street's water coming in.
    if (want('sim-room')) {
      await page.locator('.rail [data-go="inside"]').click();
      await page.locator('#room-example').click();
      await page.waitForFunction(() => document.querySelector('#room-loading')?.hidden !== false, null, { timeout: 90_000 }).catch(() => {});
      await page.evaluate(() => { window.waterline.storm.pause(); window.waterline.setDepth(0.8); });
      await page.waitForTimeout(3000);
      await shot(page, 'sim-room');
    }
    await page.close();
  }

  // Kerrville: the river corridor at the peak of the July 2025 storm.
  if (want('sim-kerrville')) {
    const page = await openApp();
    await replay(page, 0);
    await page.evaluate(() => window.__scene);
    await peak(page);
    await aerial(page, 900, -58);
    await settle(page, 4500);
    stats.kerrville = await peakStats(page);
    await shot(page, 'sim-kerrville');
    await page.close();
  }

  // Lagos: a cloudburst what-if on Victoria Island, from a street search (the app's own flow).
  if (want('sim-lagos')) {
    const page = await openApp();
    await page.evaluate(() => window.waterline.goToPlace('Victoria Island, Lagos, Nigeria', Cesium.Cartographic.fromDegrees(3.4219, 6.4281)));
    await page.waitForFunction(() => window.waterline.state.pin, null, { timeout: 90_000 });
    await page.evaluate(() => window.waterline.storm.areaReady);
    await page.locator('.rail [data-go="water"]').click();
    await page.evaluate(() => { document.querySelector('[data-scenario="rain"]').click(); });
    await page.waitForTimeout(500);
    await page.selectOption('#p-rain', '250').catch(() => {});
    await page.waitForTimeout(13_000);
    await aerial(page, 1000, -60);
    await settle(page, 4000);
    stats.lagos = await peakStats(page);
    await shot(page, 'sim-lagos');
    await page.close();
  }

  if (want('sim-phone')) {
    const page = await openApp({ width: 390, height: 844 });
    await replay(page, 1);
    await page.evaluate(() => window.__scene);
    await peak(page);
    await settle(page, 2500);
    await shot(page, 'sim-phone');
    await page.close();
  }
} finally {
  await browser.close();
  app.close();
}
// Numbers quoted by the report, measured from the app as it ran (merged with earlier runs).
const statsFile = path.join(OUT, 'sim-stats.json');
const previous = JSON.parse(await fs.readFile(statsFile, 'utf8').catch(() => '{}'));
await fs.writeFile(statsFile, JSON.stringify({ ...previous, ...Object.fromEntries(Object.entries(stats).filter(([, v]) => v)), capturedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ errors: errors.slice(0, 10) }));
