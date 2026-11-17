// Read-only live-map check. Does not create or regenerate Lux3D assets.
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';
if (!process.env.CESIUM_ION_TOKEN) throw new Error('A Cesium ion token is needed for live-map verification.');
const token = process.env.CESIUM_ION_TOKEN;
const safe = text => String(text).split(token).join('[REDACTED]').replace(/access_token=[^&\s]+/g, 'access_token=[REDACTED]');
const server = createAppServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], denied = [], failed = [];
  page.on('requestfailed', request => failed.push({ path: new URL(request.url()).origin + new URL(request.url()).pathname, error: request.failure()?.errorText }));
  page.on('pageerror', error => errors.push(safe(error.message)));
  page.on('response', response => {
    if ([401, 403].includes(response.status())) denied.push({ status: response.status(), path: new URL(response.url()).origin + new URL(response.url()).pathname });
  });
  await page.route('**/api/generate', route => route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=street&debug&nodemo`);
  await page.waitForFunction(() => !!window.waterline, null, { timeout: 40000 });
  await page.locator('#demo-go').click();
  await page.waitForFunction(() => !document.querySelector('#demo-go').disabled, null, { timeout: 40000 });
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => {
    const primitives = waterline.state.viewer.scene.primitives;
    for (let i = 0; i < primitives.length; i++) if (primitives.get(i) instanceof Cesium.Cesium3DTileset && primitives.get(i).tilesLoaded) return true;
    return false;
  }, null, { timeout: 25000 }).catch(() => {});
  const result = await page.evaluate(() => ({ mode: waterline.state.mode, world: waterline.state.worldKind,
    objects: waterline.state.objects.length, demo: document.querySelector('#demo-status').textContent,
    rendererError: document.querySelector('.cesium-widget-errorPanel')?.textContent ?? null,
    tiles: [...Array(waterline.state.viewer.scene.primitives.length)].map((_, i) => waterline.state.viewer.scene.primitives.get(i)).filter(p => p instanceof Cesium.Cesium3DTileset).map(p => ({ loaded: p.tilesLoaded })),
  }));
  await fs.mkdir('submission/evidence', { recursive: true });
  await page.screenshot({ path: 'submission/evidence/07-real-map.png' });
  const evidence = { checkedAt: new Date().toISOString(), ...result, errors, denied, failed, paidGeneration: 'Not requested' };
  await fs.writeFile('submission/live-map-verification.json', JSON.stringify(evidence, null, 2));
  console.log(safe(JSON.stringify(evidence)));
  if (result.world !== 'photorealistic' || !result.tiles.some(tile => tile.loaded) || result.rendererError || errors.length) process.exitCode = 1;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
