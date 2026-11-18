// Live check of "your own street": search a place, use the browser's location, then make one model from
// text and one from a photo with Lux3D and place both on the real map. This makes TWO paid Lux3D generations.
// Run: node --env-file=.env scripts/verify-own-street.mjs [--no-generate | --reuse <taskId>,<taskId>]
//   --reuse places two models generated earlier (public/models/generated/<taskId>.glb) instead of paying again.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';

if (!process.env.CESIUM_ION_TOKEN) throw new Error('A Cesium ion token is needed for the live-map check.');
const secrets = [process.env.CESIUM_ION_TOKEN, process.env.LUX3D_API_KEY].filter(Boolean);
const safe = (text) => secrets.reduce((s, k) => s.split(k).join('[REDACTED]'), String(text)).replace(/access_token=[^&\s"]+/g, 'access_token=[REDACTED]');
const reuseAt = process.argv.indexOf('--reuse');
const reuse = reuseAt > 0 ? process.argv[reuseAt + 1].split(',') : null;
const generate = !process.argv.includes('--no-generate') && !reuse;
const QUERY = process.env.PLACE_QUERY || 'Meyerland Plaza, Houston';
const out = path.resolve('submission/evidence');
await fs.mkdir(out, { recursive: true });

const server = createAppServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a.map(safe));
const report = { checkedAt: new Date().toISOString(), query: QUERY, steps: [], errors: [], placeTimings: [] };
const step = (name, detail) => { report.steps.push({ name, ...detail }); log('✔', name, JSON.stringify(detail)); };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, geolocation: { latitude: 51.50068, longitude: -0.12455, accuracy: 25 }, permissions: ['geolocation'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(safe(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push('console: ' + safe(m.text()).slice(0, 300));
    if (m.text().startsWith('[place]')) report.placeTimings.push(m.text());
  });
  await page.goto(`${origin}/?mode=street&debug&nodemo`);
  await page.waitForFunction(() => window.waterline?.state.viewer && window.waterline.state.library.length > 0, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);

  const pinState = () => page.evaluate(() => {
    const p = waterline.state.pin;
    return p && { lat: +(p.lat * 180 / Math.PI).toFixed(5), lon: +(p.lon * 180 / Math.PI).toFixed(5), height: +p.height.toFixed(2), status: document.querySelector('#pin-status').textContent };
  });
  const waitForSpot = (pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector('#pin-status').textContent), pattern, { timeout: 150_000 })
    .catch(async (e) => { throw new Error(`${e.message} · place status: ${await page.locator('#place-status').textContent()}`); });

  // 1. Search your own street.
  await page.locator('#place-input').fill(QUERY);
  await page.locator('#place-go').click();
  const searchStart = Date.now();
  await page.waitForFunction(() => !document.querySelector('#place-results').hidden || /^(Flying|Finding|Search is|Nothing)/.test(document.querySelector('#place-status').textContent), null, { timeout: 30_000 });
  if (/^(Search is|Nothing)/.test(await page.locator('#place-status').textContent())) throw new Error('Search failed: ' + await page.locator('#place-status').textContent());
  const listed = await page.locator('#place-results .place-result').allTextContents();
  const credit = await page.locator('#place-results .place-credit').textContent().catch(() => null);
  if (listed.length) await page.locator('#place-results .place-result').first().click();
  await waitForSpot('^Your spot:');
  const secondsToSpot = Math.round((Date.now() - searchStart) / 1000);
  const houston = await pinState();
  if (Math.abs(houston.lat - 29.68) > 0.1 || Math.abs(houston.lon + 95.46) > 0.1) throw new Error('Search put the spot in the wrong place: ' + JSON.stringify(houston));
  await page.locator('.rail [data-go="risk"]').click();
  await page.waitForSelector('#risk li, #risk .warning, #risk button', { timeout: 90_000 });
  const risk = await page.locator('#risk').textContent();
  const mapCredits = await page.evaluate(() => document.querySelector('.cesium-credit-lightbox, .cesium-widget-credits')?.textContent ?? '');
  step('Search your street', { query: QUERY, secondsToSpot, results: listed, credit, spot: houston, risk: risk?.trim().slice(0, 120), googleCreditOnMap: /google/i.test(mapCredits) });
  await page.locator('.rail [data-go="spot"]').click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(out, '08-search-your-street.png') });

  // 2. Text → 3D and photo → 3D, placed on the map next to your spot.
  if (generate || reuse) {
    await page.locator('.rail [data-go="things"]').click();
    const before = await page.evaluate(() => waterline.state.objects.length);
    if (generate) {
      await page.locator('#tab-text').click();
      await page.locator('[data-example="a red pickup truck"]').click();
      await page.locator('#text-go').click();
      await page.locator('#tab-photo').click();
      await page.locator('#photo-input').setInputFiles(path.resolve('public/models/sources/small-car.jpg'));
      await page.locator('#photo-name').fill('My car');
      await page.locator('#photo-go').click();
      step('Started two Lux3D generations', { text: 'a red pickup truck', photo: 'small-car.jpg' });
    }
    const offsets = [[6, 4], [-6, -4]];
    for (let placed = 0; placed < 2; placed++) {
      const t0 = Date.now();
      if (reuse) {
        await page.evaluate(async ([taskId, name, source, realHeight]) => {
          waterline.setPending(await waterline.loadTemplate({ name, url: `/models/generated/${taskId}.glb`, source, realHeight, taskId }));
        }, [reuse[placed], placed ? 'My car' : 'a red pickup truck', placed ? 'lux3d-image-to-3d' : 'lux3d-text-to-3d', placed ? 1.5 : 1.8]);
      }
      await page.waitForFunction(() => {
        if (waterline.state.pending) return true;
        const failed = waterline.state.jobs.find((j) => j.state === 'failed');
        if (failed) throw new Error(`${failed.name}: ${failed.error}`);
        return false;
      }, null, { timeout: 16 * 60_000, polling: 2000 });
      const name = await page.evaluate(() => waterline.state.pending.name);
      // Click the street a few metres from your spot, exactly as a person would.
      const [east, north] = offsets[placed];
      const xy = await page.evaluate(([east, north]) => {
        const { pin, viewer } = waterline.state;
        const R = 6378137;
        const lat = pin.lat + north / R, lon = pin.lon + east / (R * Math.cos(pin.lat));
        const p = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, Cesium.Cartesian3.fromRadians(lon, lat, pin.height + 0.2));
        const rect = viewer.scene.canvas.getBoundingClientRect();
        return p && { x: rect.left + p.x, y: rect.top + p.y };
      }, [east, north]);
      if (!xy) throw new Error('Spot is off screen');
      await page.mouse.click(xy.x, xy.y);
      await page.waitForFunction((n) => waterline.state.objects.length >= n, before + placed + 1, { timeout: 30_000 });
      const obj = await page.evaluate(() => {
        const o = waterline.state.objects.at(-1), pin = waterline.state.pin;
        return { name: o.name, source: o.source, realHeight: +o.realHeight.toFixed(2), groundAboveSpot: +(o.ground - pin.height).toFixed(2),
          metresFromSpot: +Math.hypot((o.lon - pin.lon) * 6378137 * Math.cos(pin.lat), (o.lat - pin.lat) * 6378137).toFixed(1) };
      });
      step(`Placed Lux3D model ${placed + 1}`, { ...obj, readyAfterSeconds: Math.round((Date.now() - t0) / 1000), pendingName: name });
    }
    await page.evaluate(() => waterline.setDepth(1.0));
    await page.waitForTimeout(2500);
    const impact = (await page.locator('#impact-list li').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    step('Raised water to 1.0 m', { impact });
    if (impact.some((t) => /Dry$/.test(t))) report.errors.push('An object stayed dry under 1 m of water: it was placed above the street.');
    await page.screenshot({ path: path.join(out, '09-your-things-on-your-street.png') });
    await page.evaluate(() => waterline.setDepth(0));
  }

  // 3. Use my location (the browser reports Westminster, London, in this test).
  await page.locator('.rail [data-go="spot"]').click();
  await page.locator('#locate-me').click();
  const locateStart = Date.now();
  await waitForSpot('^Your spot: Your location');
  const london = await pinState();
  const secondsToLocation = Math.round((Date.now() - locateStart) / 1000);
  if (Math.abs(london.lat - 51.5007) > 0.002 || Math.abs(london.lon + 0.12455) > 0.003) throw new Error('Location put the spot in the wrong place: ' + JSON.stringify(london));
  await page.locator('.rail [data-go="risk"]').click();
  await page.waitForSelector('#risk li, #risk .warning', { timeout: 60_000 }).catch(() => {});
  step('Use my location', { secondsToSpot: secondsToLocation, spot: london, risk: (await page.locator('#risk').textContent())?.trim().slice(0, 120), nearbyObjectsShown: await page.locator('#impact-list li').count() });
  await page.locator('.rail [data-go="spot"]').click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(out, '10-use-my-location.png') });

  // 4. A place that doesn't exist.
  await page.locator('#place-input').fill('qzxvbnmplkj nowhere 99999');
  await page.locator('#place-go').click();
  await page.waitForFunction(() => /Nothing found|unavailable|Which one/.test(document.querySelector('#place-status').textContent), null, { timeout: 20_000 });
  step('Nonsense search', { status: await page.locator('#place-status').textContent() });

  report.ok = report.errors.length === 0;
} catch (error) {
  report.ok = false;
  report.failure = safe(error.stack || error.message);
  log('✘', report.failure);
  process.exitCode = 1;
} finally {
  await fs.writeFile('submission/own-street-verification.json', safe(JSON.stringify(report, null, 2)));
  log('timings:', JSON.stringify(report.placeTimings));
  log('errors:', JSON.stringify(report.errors));
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
