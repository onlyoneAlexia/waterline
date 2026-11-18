// Opens the example Aholo World room in "Inside your home", raises the water and takes screenshots.
// No paid generation. Run: node scripts/verify-room.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';

const out = path.resolve('submission/evidence');
await fs.mkdir(out, { recursive: true });
const server = createAppServer({});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const errors = [], external = [];
let ok = false;
try {
  const mobile = process.argv.includes('--mobile');
  const page = await browser.newPage(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1600, height: 950 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  page.on('request', (r) => { if (!r.url().startsWith(origin) && !/^(data|blob):/.test(r.url())) external.push(new URL(r.url()).origin); });
  await page.goto(`${origin}/?mode=studio&debug`);
  await page.waitForFunction(() => window.waterline?.state.objects.length >= 1, null, { timeout: 60_000 });
  await page.locator('.rail [data-go="inside"]').click();
  await page.locator('#room-example').click();
  const t0 = Date.now();
  await page.waitForFunction(() => window.waterline.state.room || /could not/.test(document.querySelector('#room-loading').textContent), null, { timeout: 120_000 });
  const loading = await page.locator('#room-loading').textContent();
  if (loading) throw new Error(loading);
  const info = await page.evaluate(() => waterline.state.room.info());
  console.log('room open in', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(info));
  for (const [depth, name] of [[0, '11-room-dry'], [0.6, '12-room-flooded'], [1.2, '13-room-deep']]) {
    await page.evaluate((d) => waterline.setDepth(d), depth);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(out, `${name}${mobile ? '-phone' : ''}.png`) });
    console.log(depth, 'm street →', await page.locator('#room-readout').textContent());
  }
  await page.locator('#room-close').click();
  await page.waitForTimeout(500);
  if (!(await page.locator('#room-view').isHidden())) throw new Error('Room view did not close');
  ok = errors.length === 0 && external.length === 0;
} catch (error) {
  console.log('FAILED', error.message);
} finally {
  console.log('errors:', JSON.stringify(errors), 'external:', JSON.stringify([...new Set(external)]));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  process.exitCode = ok ? 0 : 1;
}
