// Record the demo video from the real app (Edge on the local GPU), with on-screen captions.
//
//   node --env-file-if-exists=.env scripts/record-demo.mjs
//
// One continuous session is recorded; only the "keep" ranges are stitched into
// submission/waterline-demo.webm, so map loading and Lux3D's ~2-minute build are cut, and a
// caption says so. It makes ONE live Lux3D text-to-3D generation (one credit).
// Needs Playwright's ffmpeg (npx playwright install ffmpeg) in .playwright/ (PLAYWRIGHT_BROWSERS_PATH).

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';
import { stitch } from './stitch-video.mjs';

const ROOT = path.resolve('.');
const OUT_DIR = path.join(ROOT, 'submission');
const RAW_DIR = path.join(OUT_DIR, 'recordings');
const SIZE = { width: 1600, height: 900 };

const app = createAppServer();
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: RAW_DIR, size: SIZE } });
const page = await context.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const keep = [];
let open = null;
const start = () => { open = now(); };
const stop = () => { if (open != null) keep.push([open, now()]); open = null; };
const hold = (ms) => page.waitForTimeout(ms);
page.on('pageerror', (e) => console.log('pageerror', e.message));

// On-screen caption and a visible cursor (headless recordings have none).
async function overlay() {
  await page.addStyleTag({ content: `
    #rec-caption { position: fixed; z-index: 99; left: 50%; top: 22px; transform: translateX(-50%); max-width: 1100px; padding: 14px 28px;
      border-radius: 999px; background: rgba(8,17,31,.9); color: #e8f1f8; border: 1px solid rgba(255,196,77,.35); font: 500 24px/1.35 Poppins, sans-serif; text-align: center;
      box-shadow: 0 12px 30px rgba(0,0,0,.25); transition: opacity .3s; pointer-events: none; }
    #rec-caption small { display: block; font-size: 16px; color: #ffc44d; }
    #rec-cursor { position: fixed; z-index: 100; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
      background: rgba(255,255,255,.85); border: 3px solid #ffc44d; pointer-events: none; transition: transform .12s; }
    #rec-cursor.down { transform: scale(.7); }
    #rec-card { position: fixed; inset: 0; z-index: 98; display: grid; place-items: center; text-align: center; background: radial-gradient(60% 50% at 70% 35%, rgba(47,143,224,.3), transparent 70%), #08111f;
      color: #e8f1f8; font: 700 72px/1.1 Poppins, sans-serif; letter-spacing: -.02em; }
    #rec-card p { margin: 18px 0 0; font: 500 26px/1.5 Poppins, sans-serif; color: #b9c8d8; } #rec-card b { color: #ffc44d; }` });
  await page.evaluate(() => {
    if (document.querySelector('#rec-cursor')) return;
    const c = document.createElement('div'); c.id = 'rec-cursor'; document.body.append(c);
    addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => c.classList.add('down'), true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  });
}
const caption = (text, sub = '') => page.evaluate(([t, s]) => {
  let el = document.querySelector('#rec-caption');
  if (!el) { el = document.createElement('div'); el.id = 'rec-caption'; document.body.append(el); }
  el.style.opacity = t ? '1' : '0';
  el.innerHTML = t ? `${t}${s ? `<small>${s}</small>` : ''}` : '';
}, [text, sub]);
let cursor = { x: 800, y: 450 };
async function moveTo(x, y) { await page.mouse.move(x, y, { steps: 18 }); cursor = { x, y }; }
async function click(locator) {
  await locator.scrollIntoViewIfNeeded(); // the panel scrolls: never click off-screen
  const box = await locator.boundingBox();
  if (!box) throw new Error('Nothing to click');
  await moveTo(box.x + box.width / 2, box.y + box.height / 2);
  await hold(150);
  await page.mouse.down(); await hold(80); await page.mouse.up();
}
const waitDemo = () => page.waitForFunction(() => /Demo ready|could not/.test(document.querySelector('#demo-status')?.textContent ?? ''), null, { timeout: 120000 });
const settleTiles = () => page.evaluate(async () => {
  const s = window.waterline?.state; if (!s?.viewer) return;
  const tiles = [...Array(s.viewer.scene.primitives.length)].map((_, i) => s.viewer.scene.primitives.get(i)).find((p) => p instanceof Cesium.Cesium3DTileset);
  const t = Date.now(); while (tiles && !tiles.tilesLoaded && Date.now() - t < 20000) await new Promise((r) => setTimeout(r, 250));
}).catch(() => {});

try {
  const statsLine = () => page.evaluate(() => {
    const s = window.waterline.state.areaStats;
    if (!s?.buildings) return '';
    return `${s.buildings.wet.toLocaleString()} of ${s.buildings.total.toLocaleString()} buildings in water · ${s.roads.cutKm.toFixed(0)} km of road cut · ${s.facilities.length} services hit`;
  });
  const aerial = (metres, pitch = -60, seconds = 2.5) => page.evaluate(([m, p, d]) => new Promise((resolve) => {
    const { viewer, pin } = window.waterline.state;
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromRadians(pin.lon, pin.lat - 0.00012, pin.height + m), orientation: { heading: 0, pitch: Cesium.Math.toRadians(p), roll: 0 }, duration: d, complete: resolve, cancel: resolve });
  }), [metres, pitch, seconds]);

  // 1. Homepage. ?debug skips it and ?nodemo stops the demo starting behind it, so open it here.
  await page.goto(`${origin}/?debug&nodemo`);
  await page.evaluate(() => document.documentElement.classList.add('home-open'));
  await page.evaluate(() => document.fonts.ready);
  await overlay();
  await page.waitForFunction(() => !!window.waterline?.state?.viewer, null, { timeout: 60000 });
  await hold(1500);
  await page.evaluate(() => document.querySelectorAll('.hero-water, .ring, .ring-ripple, .hero-tag').forEach((el) => { el.style.animation = 'none'; void el.offsetHeight; el.style.animation = ''; }));
  start();
  await caption('Flood maps show a blue patch. People underestimate it.', 'Waterline shows what the storm does to your street, before it comes.');
  await hold(5500);
  await caption('Live weather + real terrain + OpenStreetMap + Aholo Lux3D', 'A flood-impact simulator in a photorealistic 3D city');
  await page.locator('#home').evaluate((el) => el.scrollTo({ top: el.querySelector('.home-steps').offsetTop - 20, behavior: 'smooth' }));
  await hold(4500);
  await page.locator('#home').evaluate((el) => el.scrollTo({ top: 0, behavior: 'smooth' }));
  await hold(1200);
  await caption('');
  await click(page.locator('#home-demo'));
  await hold(1000);
  stop();

  // 2. Paiporta replay (loading cut): the recorded storm drives the water over the real terrain.
  await page.waitForFunction(() => window.waterline.storm?.scenario?.id === 'event', null, { timeout: 150000 }).catch(() => {});
  await page.evaluate(() => window.waterline.storm.pause());
  await settleTiles();
  await page.evaluate(() => { window.waterline.storm.seek(0); });
  await hold(800);
  start();
  await caption('Paiporta, Spain · 29 October 2024', 'Replaying the real storm: recorded hourly rainfall drives the water across 3.2 km² of terrain');
  await click(page.locator('#play'));
  await hold(5000);
  await caption('The Family SUV and the person are Aholo Lux3D models, at their real height', 'The impact report tracks them: wheels in water → up to the windows → completely under');
  await hold(5500);
  stop();

  // 3. From above: depth colours and the impact report at the peak.
  await page.evaluate(() => window.waterline.storm.pause());
  await page.evaluate(() => { const s = window.waterline.storm; const d = s.scenario.depth; s.seek(d.indexOf(Math.max(...d))); });
  start();
  await caption('From above, the depth colours show where it goes', 'Every OpenStreetMap building, road and school is checked against the water');
  await aerial(1100, -62, 3);
  await settleTiles();
  await hold(2500);
  await caption('At the peak', await statsLine());
  await hold(5000);
  stop();

  // 4. Drag through the storm.
  start();
  await caption('Drag the timeline through the storm, hour by hour', 'Rain bars in blue, the water at your spot in yellow');
  const tl = await page.locator('#timeline').boundingBox();
  await moveTo(tl.x + tl.width * 0.3, tl.y + tl.height * 0.6);
  await page.mouse.down();
  for (let k = 0.3; k <= 0.62; k += 0.01) { await page.mouse.move(tl.x + tl.width * k, tl.y + tl.height * 0.6); await hold(120); }
  for (let k = 0.62; k <= 0.98; k += 0.012) { await page.mouse.move(tl.x + tl.width * k, tl.y + tl.height * 0.6); await hold(90); }
  await page.mouse.up();
  await hold(1500);
  stop();

  // 5. What the water leaves behind (Lux3D material transfer).
  start();
  await click(page.locator('[data-view="focus"]'));
  await caption('As the water drops: Lux3D material transfer shows the mud it leaves on your car', 'A mud-stained reference image (Lux3D multimodal-to-image) re-textures the same 3D model');
  await hold(6500);
  stop();

  // 6. Make your own with Lux3D, live (generation wait cut).
  start();
  await caption('Make it yours: describe your own car', 'Aholo Lux3D text-to-3D, live in the app');
  await click(page.locator('.rail [data-go="things"]'));
  await hold(1500);
  await click(page.locator('#tab-text'));
  await hold(900);
  await click(page.locator('[data-example="a red pickup truck"]'));
  await hold(900);
  await click(page.locator('#text-go'));
  await page.waitForFunction(() => /queue|building/i.test(document.querySelector('#jobs')?.textContent ?? ''), null, { timeout: 60000 }).catch(() => {});
  await hold(3500);
  stop();
  const genStart = Date.now();
  await page.waitForFunction(() => !!window.waterline.state.pending || /Failed/.test(document.querySelector('#jobs')?.textContent ?? ''), null, { timeout: 8 * 60000 }).catch(() => {});
  const genSeconds = Math.round((Date.now() - genStart) / 1000) + 4;
  const placed = await page.evaluate(() => !!window.waterline.state.pending);
  await click(page.locator('[data-view="street"]'));
  await settleTiles();
  start();
  await caption(`${Math.floor(genSeconds / 60)} min ${genSeconds % 60} s later (skipped): Lux3D’s pickup is ready`, '“Auto size” reads “pickup” and stands it 1.8 m tall. Click the street to place it.');
  await hold(3000);
  if (placed) {
    const map = await page.locator('#map .cesium-widget canvas').first().boundingBox();
    const before = await page.evaluate(() => window.waterline.state.objects.length);
    await moveTo(map.x + map.width * 0.42, map.y + map.height * 0.62);
    await hold(300);
    await page.mouse.down(); await hold(80); await page.mouse.up();
    await page.waitForFunction((n) => window.waterline.state.objects.length > n, before, { timeout: 15000 }).catch(() => {});
    await hold(1500);
  }
  await caption('Play the storm again: the report now tracks your pickup too');
  await page.evaluate(() => { window.waterline.storm.seek(window.waterline.storm.scenario.startAt ?? 0); });
  await click(page.locator('#play'));
  await hold(7000);
  stop();

  // 7. Where do I go? Leave early: the route at the first 40 cm (search cut).
  await page.evaluate(() => window.waterline.storm.pause());
  await page.evaluate(() => { const s = window.waterline.storm; const i = s.scenario.depth.findIndex((d) => d >= 0.4); s.seek(Math.max(0, i)); });
  start();
  await caption('Where do I go?');
  await click(page.locator('.rail [data-go="safety"]'));
  await hold(1200);
  await click(page.locator('#safe-go'));
  await hold(1200);
  stop();
  await page.waitForFunction(() => /min on foot|No higher/.test(document.querySelector('#safety')?.textContent ?? ''), null, { timeout: 90000 }).catch(() => {});
  await settleTiles();
  start();
  await caption('The nearest ground 1 m above the flood, and a real walking route to it', 'Terrain search + OpenStreetMap route, with the water depth along the way');
  await hold(5500);
  await caption('A Lux3D person walks it: rigged and animated by Lux3D', 'Lux3D rigging + animation retargeting (shown sped up)');
  await page.evaluate(() => window.waterline.followWalker(true));
  await hold(7500);
  await page.evaluate(() => window.waterline.followWalker(false));
  stop();

  // 8. Inside your home (Aholo World), loading cut.
  start();
  await caption('Then the same water comes inside', 'Aholo World turns one photo of a room into a 3D room');
  await click(page.locator('.rail [data-go="inside"]'));
  await hold(1200);
  await click(page.locator('#room-example'));
  stop();
  await page.waitForFunction(() => document.querySelector('#room-loading')?.hidden !== false, null, { timeout: 90000 }).catch(() => {});
  await page.evaluate(() => window.waterline.setDepth(0.8));
  await hold(2500);
  start();
  await caption('0.8 m in the street → water over the sockets inside', 'Scaled to your ceiling height; the panel says when to go upstairs');
  await hold(6000);
  await click(page.locator('#room-close'));
  await hold(800);
  stop();

  // 9. Anywhere: search a street, then a cloudburst what-if (loading cut).
  start();
  await caption('Anywhere in the world: search your street, then pick a storm', 'Live forecast · storm replay · heavy rain · river flood (JRC) · storm surge');
  await click(page.locator('.rail [data-go="spot"]'));
  await hold(1200);
  await click(page.locator('#place-input'));
  await page.keyboard.type('Meyerland, Houston', { delay: 60 });
  await hold(1200);
  stop();
  await page.evaluate(() => window.waterline.goToPlace('Meyerland, Houston, Texas', Cesium.Cartographic.fromDegrees(-95.4592, 29.6866)));
  await page.evaluate(() => window.waterline.storm.areaReady);
  await click(page.locator('.rail [data-go="water"]'));
  await page.evaluate(() => { document.querySelector('[data-scenario="rain"]').click(); window.waterline.storm.pause(); });
  await page.selectOption('#p-rain', '400').catch(() => {});
  await page.evaluate(() => { window.waterline.storm.pause(); window.waterline.storm.seek(0); });
  await aerial(1100, -60, 0);
  await settleTiles();
  start();
  await caption('Meyerland, Houston, on Brays Bayou · what if 400 mm of rain falls in 6 hours?', 'Hurricane Harvey (2017) dropped more than 1,000 mm on parts of Texas. Today’s live forecast is on the card.');
  await click(page.locator('#play'));
  await hold(9500);
  const houston = await statsLine();
  if (houston) { await caption('Meyerland, Houston', houston); await hold(3500); }
  stop();

  // 10. End card
  start();
  await page.evaluate(() => {
    document.querySelector('#rec-cursor')?.remove();
    const card = document.createElement('div'); card.id = 'rec-card';
    card.innerHTML = '<div>Waterline<p>See what the storm does to your street — before it comes.<br>Aholo Lux3D · Aholo World · Open-Meteo · OpenStreetMap · JRC<br><b>#Manycorehackathon</b></p></div>';
    document.body.append(card);
  });
  await caption('');
  await hold(5000);
  stop();
} finally {
  await context.close();
  await browser.close();
  app.close();
}

// ---------- stitch the kept ranges ----------
const raw = await page.video().path();
console.log('raw video', path.relative(ROOT, raw), 'keep', keep.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}`).join(', '));
// Save the ranges next to the raw file, so a stitch can be redone without re-recording.
await fs.writeFile(`${raw}.keep.json`, JSON.stringify(keep));
const output = path.join(OUT_DIR, 'waterline-demo.webm');
const seconds = await stitch(raw, keep, output);
console.log(`Wrote ${path.relative(ROOT, output)} · ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')} from ${keep.length} kept ranges`);
