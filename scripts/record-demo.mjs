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
      border-radius: 999px; background: rgba(61,35,24,.92); color: #fbe3bd; font: 500 24px/1.35 Poppins, sans-serif; text-align: center;
      box-shadow: 0 12px 30px rgba(0,0,0,.25); transition: opacity .3s; pointer-events: none; }
    #rec-caption small { display: block; font-size: 16px; color: #f2cd92; }
    #rec-cursor { position: fixed; z-index: 100; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
      background: rgba(255,255,255,.85); border: 3px solid #3d2318; pointer-events: none; transition: transform .12s; }
    #rec-cursor.down { transform: scale(.7); }
    #rec-card { position: fixed; inset: 0; z-index: 98; display: grid; place-items: center; text-align: center; background: linear-gradient(180deg,#7fcdf2,#bfe7fa);
      color: #3d2318; font: 700 64px/1.1 'Cinzel Decorative', serif; text-transform: uppercase; }
    #rec-card p { margin: 18px 0 0; font: 500 26px/1.5 Poppins, sans-serif; text-transform: none; }` });
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
  // 1. Homepage. ?debug skips it and ?nodemo stops the demo starting behind it, so open it here.
  await page.goto(`${origin}/?debug&nodemo`);
  await page.evaluate(() => document.documentElement.classList.add('home-open'));
  await page.evaluate(() => document.fonts.ready);
  await overlay();
  await page.waitForFunction(() => !!window.waterline?.state?.viewer, null, { timeout: 60000 });
  await hold(1500);
  // Replay the hero's rising water, waterline ring and label from the start of the take.
  await page.evaluate(() => document.querySelectorAll('.hero-water, .ring, .ring-ripple, .hero-tag').forEach((el) => { el.style.animation = 'none'; void el.offsetHeight; el.style.animation = ''; }));
  start();
  await caption('Flood maps show a blue patch.', 'Waterline shows the water at your car’s windows, on your street.');
  await hold(6000);
  await caption('Built on Aholo Lux3D', 'Your photo or a few words → a true-scale 3D model → a real 3D city → rising water');
  await page.locator('#home').evaluate((el) => el.scrollTo({ top: el.querySelector('.home-steps').offsetTop - 20, behavior: 'smooth' }));
  await hold(4500);
  await page.locator('#home').evaluate((el) => el.scrollTo({ top: 0, behavior: 'smooth' }));
  await hold(1500);
  await caption('');
  await click(page.locator('#home-demo'));
  await hold(1200);
  stop();

  // 2. Kerrville demo (loading cut)
  await waitDemo().catch(() => {});
  await settleTiles();
  await page.evaluate(() => window.waterline.setDepth(0));
  await hold(800);
  start();
  await caption('Kerrville, Texas · 4 July 2025', 'The Guadalupe River rose about 8 m in 45 minutes. This is Louise Hays Park, on the river.');
  await click(page.locator('#play'));
  await hold(4500);
  await caption('Every object here is an Aholo Lux3D model, at its real height', 'An SUV (1.8 m) and an adult (1.75 m), standing on the real ground of the 3D city');
  await hold(5000);
  await caption('The panel reads out what the water is doing', 'SUV: up to the windows · adult: chest-deep');
  await hold(4000);
  stop();

  // 3. Make your own with Lux3D, live (generation wait cut)
  start();
  await caption('Your things: six Lux3D models are ready to use…');
  await click(page.locator('.rail [data-go="things"]'));
  await hold(3500);
  await caption('…or describe your own', 'Aholo Lux3D text-to-3D, live in the app');
  await click(page.locator('#tab-text'));
  await hold(1200);
  await click(page.locator('[data-example="a red pickup truck"]'));
  await hold(1200);
  await click(page.locator('#text-go'));
  await page.waitForFunction(() => /queue|building/i.test(document.querySelector('#jobs')?.textContent ?? ''), null, { timeout: 60000 }).catch(() => {});
  await hold(5000);
  stop();
  const genStart = Date.now();
  await page.waitForFunction(() => !!window.waterline.state.pending || /Failed/.test(document.querySelector('#jobs')?.textContent ?? ''), null, { timeout: 8 * 60000 });
  const genSeconds = Math.round((Date.now() - genStart) / 1000) + 5;
  const placed = await page.evaluate(() => !!window.waterline.state.pending);
  start();
  await caption(`${Math.floor(genSeconds / 60)} min ${genSeconds % 60} s later (skipped): Lux3D’s model is ready`, 'Click the street to place it. “Auto size” reads “pickup” and makes it 1.8 m tall.');
  await hold(3500);
  if (placed) {
    const map = await page.locator('#map canvas').first().boundingBox();
    const before = await page.evaluate(() => window.waterline.state.objects.length);
    await moveTo(map.x + map.width * 0.33, map.y + map.height * 0.58);
    await hold(300);
    await page.mouse.down(); await hold(80); await page.mouse.up();
    await page.waitForFunction((n) => window.waterline.state.objects.length > n, before, { timeout: 15000 }).catch(() => {});
    await hold(4500);
  }
  stop();

  // 4. Raise the water
  start();
  await caption('Drag the water: every object reports what happens to it');
  await click(page.locator('.rail [data-go="water"]'));
  const slider = await page.locator('#depth').boundingBox();
  const at = (m) => slider.x + 14 + (slider.width - 28) * (m / 3);
  await moveTo(at(1.2), slider.y + slider.height / 2);
  await page.mouse.down();
  for (let m = 1.2; m <= 2.05; m += 0.05) { await page.mouse.move(at(m), slider.y + slider.height / 2); await hold(140); }
  await page.mouse.up();
  await hold(3500);
  await caption('Even 60 cm of moving water can sweep a car away', 'The markers on the slider show the top of each of your things');
  await click(page.locator('.presets button[data-depth="0.6"]'));
  await hold(4500);
  stop();

  // 5. Real risk
  start();
  await caption('Real risk: modelled river-flood depths for this exact spot', 'JRC / Copernicus global river flood maps');
  await click(page.locator('.rail [data-go="risk"]'));
  await hold(5000);
  await page.evaluate(() => window.waterline.setDepth(1.2));
  stop();

  // 6. Higher ground (search cut)
  start();
  await caption('Then: where do I go?');
  await click(page.locator('.rail [data-go="safety"]'));
  await hold(1500);
  await click(page.locator('#safe-go'));
  await hold(1500);
  stop();
  await page.waitForFunction(() => !document.querySelector('#safe-go').disabled, null, { timeout: 90000 }).catch(() => {});
  await settleTiles();
  start();
  await caption('The nearest higher ground, and a real walking route to it', 'Terrain search + OpenStreetMap route, with the water depth along the way');
  await hold(7000);
  stop();

  // 7. Paiporta (loading cut)
  start();
  await caption('Valencia, Spain · 29 October 2024');
  await click(page.locator('.rail [data-go="spot"]'));
  await hold(1200);
  await click(page.locator('#scenes button').nth(1));
  await hold(1000);
  stop();
  await page.waitForFunction(() => document.querySelector('#scene-story')?.textContent.startsWith('Carrer'), null, { timeout: 120000 }).catch(() => {});
  await settleTiles();
  await hold(4000);
  start();
  await caption('Paiporta, near Valencia · 1.5 m in the street', 'People were trapped going to get their cars out of garages. Go early.');
  await hold(6000);
  stop();

  // 8. End card
  start();
  await page.evaluate(() => {
    document.querySelector('#rec-cursor')?.remove(); // no cursor on the end card
    const card = document.createElement('div'); card.id = 'rec-card';
    card.innerHTML = '<div>Waterline<p>See the water before it comes.<br>Aholo Lux3D · real 3D maps · real flood data<br><b>#Manycorehackathon</b></p></div>';
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
